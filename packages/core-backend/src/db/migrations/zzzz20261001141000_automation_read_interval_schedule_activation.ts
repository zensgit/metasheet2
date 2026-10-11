import { sql, type Kysely } from 'kysely'

/** The historical cron_config name is retained, but its contents are now a
 * discriminated exact union. Existing cron consents keep their identity and
 * NULL phase; only a new explicit interval consent can bind a rule's DB phase.
 */
const cronShape = `pg_catalog.jsonb_typeof(cron_config)='object'
  AND (cron_config ? 'expression') <> (cron_config ? 'cron')
  AND (cron_config-ARRAY['expression','cron','timezone'])='{}'::JSONB
  AND pg_catalog.jsonb_typeof(COALESCE(cron_config->'expression',cron_config->'cron'))='string'
  AND length(COALESCE(cron_config->>'expression',cron_config->>'cron')) BETWEEN 1 AND 255
  AND (NOT (cron_config ? 'timezone') OR pg_catalog.jsonb_typeof(cron_config->'timezone')='string')`

const scheduleShape = `((trigger_type='schedule.cron' AND interval_anchor_ms IS NULL AND (${cronShape}))
  OR (trigger_type='schedule.interval' AND interval_anchor_ms BETWEEN 1 AND 8640000000000000
    AND pg_catalog.jsonb_typeof(cron_config)='object'
    AND cron_config ? 'intervalMs'
    AND (cron_config-ARRAY['intervalMs'])='{}'::JSONB
    AND CASE WHEN pg_catalog.jsonb_typeof(cron_config->'intervalMs')='number' THEN
      (cron_config->>'intervalMs')::NUMERIC BETWEEN 1000 AND 2147483647
      AND (cron_config->>'intervalMs')::NUMERIC=pg_catalog.trunc((cron_config->>'intervalMs')::NUMERIC)
      ELSE FALSE END)) IS TRUE`

function admission(interval: boolean): string {
  const phase = interval ? `
      IF (${scheduleShape.replaceAll('cron_config', 'NEW.cron_config').replaceAll('trigger_type', 'NEW.trigger_type').replaceAll('interval_anchor_ms', 'NEW.interval_anchor_ms')}) IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
      END IF;
      IF NEW.trigger_type='schedule.interval' THEN
        IF pg_catalog.isfinite((rule_row->>'created_at')::TIMESTAMPTZ) IS NOT TRUE THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
        END IF;
        -- PostgreSQL bigint casts round; the fixed scheduler phase requires floor.
        anchor_ms := pg_catalog.floor(extract(epoch FROM (rule_row->>'created_at')::TIMESTAMPTZ)*1000);
        IF (anchor_ms BETWEEN 1 AND 8640000000000000) IS NOT TRUE
          OR anchor_ms IS DISTINCT FROM NEW.interval_anchor_ms::NUMERIC THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
        END IF;
      END IF;` : ''
  return `CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
    DECLARE grant_row JSONB; rule_row JSONB; other_binding BOOLEAN;${interval ? ' anchor_ms NUMERIC;' : ''}
    BEGIN
      EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g) FROM %I.integration_automation_read_grants g WHERE g.id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
        INTO grant_row USING NEW.grant_id;
      EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(r) FROM %I.automation_rules r WHERE r.id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
        INTO rule_row USING NEW.rule_id;
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_record_activations WHERE grant_id=$1)',TG_TABLE_SCHEMA)
        INTO other_binding USING NEW.grant_id;
      IF grant_row IS NULL OR rule_row IS NULL OR other_binding
        OR grant_row->>'purpose' IS DISTINCT FROM 'automatic' OR grant_row->>'status' IS DISTINCT FROM 'active'
        OR (grant_row->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp()
        OR grant_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
        OR grant_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id OR grant_row->>'owner_id' IS DISTINCT FROM NEW.owner_id
        OR grant_row->'selector'->>'ruleId' IS DISTINCT FROM NEW.rule_id
        OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(NEW.project_no)
        OR grant_row->'triggers' IS DISTINCT FROM '["schedule"]'::JSONB
        OR rule_row->>'created_by' IS DISTINCT FROM NEW.owner_id OR rule_row->'enabled' IS DISTINCT FROM 'true'::JSONB
        OR rule_row->>'integration_authority_revision' IS DISTINCT FROM NEW.rule_revision::TEXT
        OR rule_row->>'action_type' IS DISTINCT FROM 'integration_read_preview'
        OR rule_row->>'trigger_type' IS DISTINCT FROM ${interval ? 'NEW.trigger_type' : "'schedule.cron'"}
        OR rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB
        OR rule_row->'trigger_config' IS DISTINCT FROM NEW.cron_config THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
      END IF;${phase}
      -- Host validation retains the existing cron grammar/timezone checks.
      -- Mint cutover only after the actual locked facts; never accept caller time.
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
      -- Drain old admission before changing its table/function, without taking
      -- activation first and waiting for a grant held by an admitted writer.
      EXECUTE pg_catalog.format('LOCK TABLE %I.automation_rules IN SHARE MODE',grant_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('ALTER TABLE %I.integration_automation_read_schedule_activations '
        || 'ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT ''schedule.cron'', '
        || 'ADD COLUMN IF NOT EXISTS interval_anchor_ms BIGINT',grant_schema);
      SELECT a.atttypid='pg_catalog.text'::pg_catalog.regtype AND a.attnotnull
        AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='''schedule.cron''::text'
        INTO column_valid FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_schedule_activations',grant_schema))
          AND a.attname='trigger_type' AND NOT a.attisdropped;
      IF column_valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_INTERVAL_SCHEDULE_SCHEMA_INVALID';
      END IF;
      SELECT a.atttypid='pg_catalog.int8'::pg_catalog.regtype AND NOT a.attnotnull AND d.oid IS NULL
        INTO column_valid FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_schedule_activations',grant_schema))
          AND a.attname='interval_anchor_ms' AND NOT a.attisdropped;
      IF column_valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_INTERVAL_SCHEDULE_SCHEMA_INVALID';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations
          DROP CONSTRAINT automation_read_schedule_config_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations
          ADD CONSTRAINT automation_read_schedule_config_shape CHECK (${scheduleShape});
        ${admission(true)}
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
      -- Existing whole-row immutable and deferred grant-association triggers
      -- continue to cover both variants; neither history nor purpose is rewritten.
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
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_schedule_activations '
        || 'WHERE trigger_type IS DISTINCT FROM ''schedule.cron'' OR interval_anchor_ms IS NOT NULL)',grant_schema)
        INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_INTERVAL_SCHEDULE_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        ${admission(false)}
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations
          DROP CONSTRAINT automation_read_schedule_config_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations
          ADD CONSTRAINT automation_read_schedule_config_shape CHECK (${cronShape});
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations
          DROP COLUMN interval_anchor_ms, DROP COLUMN trigger_type;
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
    END $migration$;`).execute(db)
}
