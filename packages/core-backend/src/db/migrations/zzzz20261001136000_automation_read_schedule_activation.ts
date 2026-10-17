import { sql, type Kysely } from 'kysely'

/** Separate explicit cron family. No old record identity or standalone grant is
 * upgraded; request invocation uniqueness is the durable occurrence identity. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE grant_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT grant_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT automation_read_automatic_grant_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT automation_read_automatic_grant_shape CHECK (
          purpose <> 'automatic' OR (workspace_id IS NULL
            AND (triggers=ARRAY['record']::TEXT[] OR triggers=ARRAY['schedule']::TEXT[])
            AND cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1)
        );
        CREATE TABLE __SCHEMA__.integration_automation_read_schedule_activations (
          id UUID PRIMARY KEY,
          activation_key UUID NOT NULL,
          grant_id UUID NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          rule_revision UUID NOT NULL,
          project_no TEXT NOT NULL,
          cron_config JSONB NOT NULL,
          activated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
          CONSTRAINT automation_read_schedule_activation_owner_key UNIQUE (tenant_id,owner_id,activation_key),
          CONSTRAINT automation_read_schedule_activation_grant_scope FOREIGN KEY (grant_id,tenant_id,owner_id)
            REFERENCES __SCHEMA__.integration_automation_read_grants(id,tenant_id,owner_id) ON DELETE RESTRICT,
          CONSTRAINT automation_read_schedule_config_shape CHECK (
            pg_catalog.jsonb_typeof(cron_config)='object'
            AND (cron_config ? 'expression') <> (cron_config ? 'cron')
            AND (cron_config-ARRAY['expression','cron','timezone'])='{}'::JSONB
            AND pg_catalog.jsonb_typeof(COALESCE(cron_config->'expression',cron_config->'cron'))='string'
            AND length(COALESCE(cron_config->>'expression',cron_config->>'cron')) BETWEEN 1 AND 255
            AND (NOT (cron_config ? 'timezone') OR pg_catalog.jsonb_typeof(cron_config->'timezone')='string')
          )
        );
        CREATE INDEX idx_automation_read_schedule_activation_rule
          ON __SCHEMA__.integration_automation_read_schedule_activations(rule_id,id);

        CREATE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE grant_row JSONB; rule_row JSONB; other_binding BOOLEAN;
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
            OR rule_row->>'trigger_type' IS DISTINCT FROM 'schedule.cron'
            OR rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB
            OR rule_row->'trigger_config' IS DISTINCT FROM NEW.cron_config THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
          END IF;
          -- Cron grammar/timezone and occurrence minutes are checked by the host
          -- using the existing scheduler. This guard binds the exact actual JSON.
          NEW.activated_at := pg_catalog.clock_timestamp();
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_schedule_activation_immutable() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        BEGIN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_IMMUTABLE';
        END $function$;

        CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_record_grant_activation_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE grant_row JSONB; activation JSONB;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g),pg_catalog.to_jsonb(a)
            FROM %I.integration_automation_read_grants g LEFT JOIN %I.integration_automation_read_record_activations a ON a.grant_id=g.id
            WHERE g.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO grant_row,activation USING NEW.id;
          IF grant_row IS NULL THEN RETURN NEW; END IF;
          IF grant_row->>'purpose'='automatic' AND grant_row->'triggers'='["record"]'::JSONB AND (activation IS NULL
            OR activation->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR activation->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id'
            OR activation->>'rule_id' IS DISTINCT FROM grant_row->'selector'->>'ruleId'
            OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(activation->>'project_no')) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_RECORD_ACTIVATION_REQUIRED';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_schedule_grant_activation_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE grant_row JSONB; activation JSONB; other_binding BOOLEAN;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g),pg_catalog.to_jsonb(a)
            FROM %I.integration_automation_read_grants g LEFT JOIN %I.integration_automation_read_schedule_activations a ON a.grant_id=g.id
            WHERE g.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO grant_row,activation USING NEW.id;
          IF grant_row IS NULL THEN RETURN NEW; END IF;
          EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_record_activations WHERE grant_id=$1)',TG_TABLE_SCHEMA)
            INTO other_binding USING NEW.id;
          IF grant_row->>'purpose'='automatic' AND grant_row->'triggers'='["schedule"]'::JSONB AND (activation IS NULL OR other_binding
            OR activation->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR activation->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id'
            OR activation->>'rule_id' IS DISTINCT FROM grant_row->'selector'->>'ruleId'
            OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(activation->>'project_no')) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_REQUIRED';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE TRIGGER automation_read_schedule_activation_admit BEFORE INSERT ON __SCHEMA__.integration_automation_read_schedule_activations
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit();
        CREATE TRIGGER automation_read_schedule_activation_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.integration_automation_read_schedule_activations
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_schedule_activation_immutable();
        CREATE TRIGGER automation_read_schedule_activation_no_truncate BEFORE TRUNCATE ON __SCHEMA__.integration_automation_read_schedule_activations
          FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.automation_read_schedule_activation_immutable();
        CREATE CONSTRAINT TRIGGER automation_read_schedule_grant_activation_required
          AFTER INSERT OR UPDATE ON __SCHEMA__.integration_automation_read_grants DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.purpose='automatic')
          EXECUTE FUNCTION __SCHEMA__.automation_read_schedule_grant_activation_required();
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
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE',grant_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_schedule_activations)
        OR EXISTS(SELECT 1 FROM %I.integration_automation_read_grants WHERE purpose=''automatic'' AND triggers=ARRAY[''schedule'']::TEXT[])',grant_schema,grant_schema)
        INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        DROP TRIGGER automation_read_schedule_grant_activation_required ON __SCHEMA__.integration_automation_read_grants;
        DROP TABLE __SCHEMA__.integration_automation_read_schedule_activations;
        DROP FUNCTION __SCHEMA__.automation_read_schedule_grant_activation_required();
        DROP FUNCTION __SCHEMA__.automation_read_schedule_activation_immutable();
        DROP FUNCTION __SCHEMA__.automation_read_schedule_activation_admit();
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT automation_read_automatic_grant_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT automation_read_automatic_grant_shape CHECK (
          purpose <> 'automatic' OR (workspace_id IS NULL AND triggers=ARRAY['record']::TEXT[]
            AND cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1)
        );
        CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_record_grant_activation_required() RETURNS TRIGGER
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
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema));
    END $migration$;
  `).execute(db)
}
