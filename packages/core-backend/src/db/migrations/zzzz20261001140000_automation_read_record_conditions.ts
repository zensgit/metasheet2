import { sql, type Kysely } from 'kysely'

/** Explicit saved-condition consent only. The default describes historical NULL-only admission;
 * it is not inferred from a rule's current contents. Full AST/ACL/precision validation remains the
 * host compiler's job. This DB guard proves the closed descriptor and current schema nonce only.
 * pg_timezone_names and host Intl may differ by tzdata version: both gates must accept the name,
 * never replace an unrecognized zone with UTC. No old row or historical migration is rewritten.
 */
const confirmationShape = `(condition_confirmation='{"mode":"unconditional"}'::JSONB OR (
  pg_catalog.jsonb_typeof(condition_confirmation)='object'
  AND condition_confirmation->>'mode'='saved_conditions'
  AND pg_catalog.jsonb_typeof(condition_confirmation->'schemaRevision')='string'
  AND condition_confirmation->>'schemaRevision' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND pg_catalog.jsonb_typeof(condition_confirmation->'businessTimeZone')='string'
  AND length(condition_confirmation->>'businessTimeZone') BETWEEN 1 AND 128
  AND condition_confirmation=pg_catalog.jsonb_build_object('mode','saved_conditions',
    'schemaRevision',condition_confirmation->>'schemaRevision',
    'businessTimeZone',condition_confirmation->>'businessTimeZone')
)) IS TRUE`

function admission(conditions: boolean): string {
  const preparation = conditions ? `
      IF (${confirmationShape.replaceAll('condition_confirmation', 'NEW.condition_confirmation')}) IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
      END IF;
      IF rule_row->'conditions'='null'::JSONB THEN
        IF NEW.condition_confirmation IS DISTINCT FROM '{"mode":"unconditional"}'::JSONB THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
        END IF;
      ELSE
        IF NEW.condition_confirmation->>'mode' IS DISTINCT FROM 'saved_conditions'
          OR pg_catalog.jsonb_typeof(rule_row->'conditions') IS DISTINCT FROM 'object'
          OR octet_length((rule_row->'conditions')::TEXT)>65536
          OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names
            WHERE name=NEW.condition_confirmation->>'businessTimeZone'
              AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%') THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
        END IF;
        -- Host preparation already uses metadata -> rule -> grant order. A direct SQL insert
        -- must not wait in the reverse order: retain the same source fence with NOWAIT.
        EXECUTE pg_catalog.format('LOCK TABLE %1$I.meta_sheets, %1$I.meta_fields, '
          || '%1$I.plugin_multitable_object_registry IN SHARE MODE NOWAIT',TG_TABLE_SCHEMA);
        SELECT count(c.oid)=4 AND bool_and(c.relkind='r' AND NOT c.relrowsecurity)
          INTO consistent FROM unnest(ARRAY['meta_sheets','meta_fields',
            'plugin_multitable_object_registry','automation_read_material_epochs']) expected(name)
          LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(
            pg_catalog.format('%I.%I',TG_TABLE_SCHEMA,expected.name));
        IF consistent IS DISTINCT FROM TRUE THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
        END IF;
        EXECUTE pg_catalog.format('SELECT deleted_at IS NULL FROM %I.meta_sheets WHERE id=$1',TG_TABLE_SCHEMA)
          INTO sheet_live USING NEW.sheet_id;
        EXECUTE pg_catalog.format('SELECT revision FROM %I.automation_read_material_epochs '
          || 'WHERE kind=''sheet'' AND scope=pg_catalog.jsonb_build_object(''id'',$1::text) FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
          INTO schema_revision USING NEW.sheet_id;
        IF sheet_live IS DISTINCT FROM TRUE OR schema_revision::TEXT IS DISTINCT FROM
          NEW.condition_confirmation->>'schemaRevision' THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
        END IF;
      END IF;
      -- Added condition preparation must not extend an already expired grant's admission.
      IF (grant_row->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
      END IF;` : ''
  return `CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_record_activation_admit() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
    DECLARE grant_row JSONB; rule_row JSONB;${conditions ? ' consistent BOOLEAN; sheet_live BOOLEAN; schema_revision UUID;' : ''}
    BEGIN
      EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g) FROM %I.integration_automation_read_grants g WHERE g.id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
        INTO grant_row USING NEW.grant_id;
      EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(r) FROM %I.automation_rules r WHERE r.id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
        INTO rule_row USING NEW.rule_id;
      IF grant_row IS NULL OR rule_row IS NULL OR grant_row->>'purpose' IS DISTINCT FROM 'automatic'
        OR grant_row->>'status' IS DISTINCT FROM 'active'
        OR (grant_row->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp()
        OR grant_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
        OR grant_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id OR grant_row->>'owner_id' IS DISTINCT FROM NEW.owner_id
        OR grant_row->'selector'->>'ruleId' IS DISTINCT FROM NEW.rule_id
        OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(NEW.project_no)
        OR grant_row->'triggers' IS DISTINCT FROM '["record"]'::JSONB
        OR rule_row->>'created_by' IS DISTINCT FROM NEW.owner_id
        OR rule_row->'enabled' IS DISTINCT FROM 'true'::JSONB
        OR rule_row->>'sheet_id' IS DISTINCT FROM NEW.sheet_id
        OR rule_row->>'integration_authority_revision' IS DISTINCT FROM NEW.rule_revision::TEXT
        OR rule_row->>'action_type' IS DISTINCT FROM 'integration_read_preview'
        OR (rule_row->>'trigger_type' IS DISTINCT FROM 'record.created' AND rule_row->>'trigger_type' IS DISTINCT FROM 'record.updated')
        ${conditions ? '' : "OR rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB"}
        OR (rule_row->'trigger_config' IS DISTINCT FROM 'null'::JSONB AND rule_row->'trigger_config' IS DISTINCT FROM '{}'::JSONB) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
      END IF;${preparation}
      -- Always mint cutover after the actual locked facts, never accept/backfill caller timestamps.
      NEW.activated_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END $function$;`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE grant_schema TEXT; column_valid BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT grant_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('ALTER TABLE %I.integration_automation_read_record_activations '
        || 'ADD COLUMN IF NOT EXISTS condition_confirmation JSONB NOT NULL DEFAULT ''{"mode":"unconditional"}''::JSONB',grant_schema);
      SELECT a.atttypid='pg_catalog.jsonb'::pg_catalog.regtype AND a.attnotnull
        AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='''{"mode": "unconditional"}''::jsonb'
        INTO column_valid FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_record_activations',grant_schema))
          AND a.attname='condition_confirmation' AND NOT a.attisdropped;
      IF column_valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_RECORD_CONDITIONS_SCHEMA_INVALID';
      END IF;
      EXECUTE pg_catalog.format('ALTER TABLE %I.integration_automation_read_record_activations '
        || 'DROP CONSTRAINT IF EXISTS automation_read_record_condition_confirmation',grant_schema);
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_record_activations
          ADD CONSTRAINT automation_read_record_condition_confirmation CHECK (${confirmationShape});
        ${admission(true)}
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
      -- The existing BEFORE UPDATE OR DELETE and BEFORE TRUNCATE immutable guards reject every
      -- activation mutation, including this new column; no weaker per-column replacement is added.
    END $migration$;`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE grant_schema TEXT; has_history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT grant_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.automation_rules IN SHARE MODE',grant_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_record_activations IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_record_activations)
        OR EXISTS(SELECT 1 FROM %I.integration_automation_read_grants WHERE purpose=''automatic'' AND triggers=ARRAY[''record'']::TEXT[])',grant_schema,grant_schema)
        INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_RECORD_CONDITIONS_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        ${admission(false)}
        ALTER TABLE __SCHEMA__.integration_automation_read_record_activations
          DROP CONSTRAINT IF EXISTS automation_read_record_condition_confirmation;
        ALTER TABLE __SCHEMA__.integration_automation_read_record_activations
          DROP COLUMN IF EXISTS condition_confirmation;
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
    END $migration$;`).execute(db)
}
