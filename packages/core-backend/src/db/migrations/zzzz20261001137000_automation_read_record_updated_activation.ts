import { sql, type Kysely } from 'kysely'

/** A fresh explicit consent may bind either exact record type. Existing immutable
 * rule revisions, grants and activation history are never upgraded or rewritten.
 * The later schedule-family constraints/functions from 136 remain untouched. */
function admission(allowUpdated: boolean): string {
  const unsupported = allowUpdated
    ? "(rule_row->>'trigger_type' IS DISTINCT FROM 'record.created' AND rule_row->>'trigger_type' IS DISTINCT FROM 'record.updated')"
    : "rule_row->>'trigger_type' IS DISTINCT FROM 'record.created'"
  return `CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_record_activation_admit() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
    DECLARE grant_row JSONB; rule_row JSONB;
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
        OR ${unsupported}
        OR rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB
        OR (rule_row->'trigger_config' IS DISTINCT FROM 'null'::JSONB AND rule_row->'trigger_config' IS DISTINCT FROM '{}'::JSONB) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
      END IF;
      NEW.activated_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END $function$;`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE grant_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT grant_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.replace($ddl$${admission(true)}$ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
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
      -- No immutable event-type column exists: never infer retained consent from
      -- a mutable/deleted rule. Conservatively refuse all retained record history.
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_record_activations)
        OR EXISTS(SELECT 1 FROM %I.integration_automation_read_grants WHERE purpose=''automatic'' AND triggers=ARRAY[''record'']::TEXT[])',grant_schema,grant_schema)
        INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.replace($ddl$${admission(false)}$ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
    END $migration$;`).execute(db)
}
