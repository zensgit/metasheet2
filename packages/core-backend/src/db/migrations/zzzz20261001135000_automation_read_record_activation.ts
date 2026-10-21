import { sql, type Kysely } from 'kysely'

/** Explicit new record-only grant/activation pairs. Existing grants retain
 * standalone purpose; no historical request or automatic binding is backfilled.
 * These identities are not a replacement for the live execution authority. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE grant_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT grant_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      -- This nonunique accelerator does not change the ordinary outbox's legal
      -- duplicate-identity semantics. Minimal ledger-only schemas need not have
      -- the outbox yet; production's earlier outbox migration already creates it.
      IF pg_catalog.to_regclass(pg_catalog.format('%I.meta_automation_outbox',grant_schema)) IS NOT NULL THEN
        EXECUTE pg_catalog.format('CREATE INDEX idx_automation_read_record_event_cutover ON %I.meta_automation_outbox(event_type,event_id,created_at)',grant_schema);
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_grants
          ADD COLUMN purpose TEXT NOT NULL DEFAULT 'standalone'
          CHECK (purpose IN ('standalone','automatic'));
        ALTER TABLE __SCHEMA__.integration_automation_read_grants
          ADD CONSTRAINT automation_read_automatic_grant_shape CHECK (
            purpose <> 'automatic' OR (workspace_id IS NULL AND triggers=ARRAY['record']::TEXT[]
              AND cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1)
          );
        CREATE TABLE __SCHEMA__.integration_automation_read_record_activations (
          id UUID PRIMARY KEY,
          activation_key UUID NOT NULL,
          grant_id UUID NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          rule_revision UUID NOT NULL,
          sheet_id TEXT NOT NULL,
          project_no TEXT NOT NULL,
          activated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
          CONSTRAINT automation_read_record_activation_owner_key UNIQUE (tenant_id,owner_id,activation_key),
          CONSTRAINT automation_read_record_activation_grant_scope FOREIGN KEY (grant_id,tenant_id,owner_id)
            REFERENCES __SCHEMA__.integration_automation_read_grants(id,tenant_id,owner_id) ON DELETE RESTRICT
        );
        CREATE INDEX idx_automation_read_record_activation_sheet
          ON __SCHEMA__.integration_automation_read_record_activations(sheet_id,id);

        CREATE FUNCTION __SCHEMA__.automation_read_record_grant_identity() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        BEGIN
          IF NEW.purpose IS DISTINCT FROM OLD.purpose
            OR (OLD.purpose='automatic' AND
              (pg_catalog.to_jsonb(NEW)-ARRAY['status','used_executions','updated_at']) IS DISTINCT FROM
              (pg_catalog.to_jsonb(OLD)-ARRAY['status','used_executions','updated_at'])) THEN
            RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_RECORD_GRANT_IDENTITY_IMMUTABLE';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_record_activation_admit() RETURNS TRIGGER
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
            OR rule_row->>'trigger_type' IS DISTINCT FROM 'record.created'
            OR rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB
            OR (rule_row->'trigger_config' IS DISTINCT FROM 'null'::JSONB AND rule_row->'trigger_config' IS DISTINCT FROM '{}'::JSONB) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_DENIED';
          END IF;
          -- Cutover is minted only after the actual locked facts, never supplied
          -- by an HTTP client or backdated from an event's timestamp.
          NEW.activated_at := pg_catalog.clock_timestamp();
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_record_activation_immutable() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        BEGIN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_IMMUTABLE';
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_record_grant_activation_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE grant_row JSONB; activation JSONB;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g),pg_catalog.to_jsonb(a)
            FROM %I.integration_automation_read_grants g LEFT JOIN %I.integration_automation_read_record_activations a ON a.grant_id=g.id
            WHERE g.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO grant_row,activation USING NEW.id;
          IF grant_row IS NULL THEN RETURN NEW; END IF;
          IF grant_row->>'purpose'='automatic' AND (activation IS NULL
            OR activation->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR activation->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id'
            OR activation->>'rule_id' IS DISTINCT FROM grant_row->'selector'->>'ruleId'
            OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(activation->>'project_no')
            OR grant_row->'triggers' IS DISTINCT FROM '["record"]'::JSONB) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_REQUIRED';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE TRIGGER automation_read_record_grant_identity BEFORE UPDATE ON __SCHEMA__.integration_automation_read_grants
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_record_grant_identity();
        CREATE TRIGGER automation_read_record_activation_admit BEFORE INSERT ON __SCHEMA__.integration_automation_read_record_activations
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_record_activation_admit();
        CREATE TRIGGER automation_read_record_activation_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.integration_automation_read_record_activations
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_record_activation_immutable();
        CREATE TRIGGER automation_read_record_activation_no_truncate BEFORE TRUNCATE ON __SCHEMA__.integration_automation_read_record_activations
          FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.automation_read_record_activation_immutable();
        CREATE CONSTRAINT TRIGGER automation_read_record_grant_activation_required
          AFTER INSERT OR UPDATE ON __SCHEMA__.integration_automation_read_grants DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.purpose='automatic')
          EXECUTE FUNCTION __SCHEMA__.automation_read_record_grant_activation_required();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
    END $migration$;
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE grant_schema TEXT; has_history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT grant_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_record_activations IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_record_activations)
        OR EXISTS(SELECT 1 FROM %I.integration_automation_read_grants WHERE purpose=''automatic'')',grant_schema,grant_schema) INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        DROP INDEX IF EXISTS __SCHEMA__.idx_automation_read_record_event_cutover;
        DROP TRIGGER automation_read_record_grant_activation_required ON __SCHEMA__.integration_automation_read_grants;
        DROP TRIGGER automation_read_record_grant_identity ON __SCHEMA__.integration_automation_read_grants;
        DROP TABLE __SCHEMA__.integration_automation_read_record_activations;
        DROP FUNCTION __SCHEMA__.automation_read_record_grant_activation_required();
        DROP FUNCTION __SCHEMA__.automation_read_record_activation_immutable();
        DROP FUNCTION __SCHEMA__.automation_read_record_activation_admit();
        DROP FUNCTION __SCHEMA__.automation_read_record_grant_identity();
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT automation_read_automatic_grant_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP COLUMN purpose;
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
    END $migration$;
  `).execute(db)
}
