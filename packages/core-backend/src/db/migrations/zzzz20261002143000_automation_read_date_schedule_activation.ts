import { sql, type Kysely } from 'kysely'

// Keep the historical cron_config column and every old consent unchanged. The
// new nullable confirmation discriminates ONLY a newly admitted date family.
const cronShape = `pg_catalog.jsonb_typeof(cron_config)='object'
  AND (cron_config ? 'expression') <> (cron_config ? 'cron')
  AND (cron_config-ARRAY['expression','cron','timezone'])='{}'::JSONB
  AND pg_catalog.jsonb_typeof(COALESCE(cron_config->'expression',cron_config->'cron'))='string'
  AND length(COALESCE(cron_config->>'expression',cron_config->>'cron')) BETWEEN 1 AND 255
  AND (NOT (cron_config ? 'timezone') OR pg_catalog.jsonb_typeof(cron_config->'timezone')='string')`
const intervalShape = `interval_anchor_ms BETWEEN 1 AND 8640000000000000
  AND pg_catalog.jsonb_typeof(cron_config)='object' AND cron_config ? 'intervalMs'
  AND (cron_config-ARRAY['intervalMs'])='{}'::JSONB
  AND CASE WHEN pg_catalog.jsonb_typeof(cron_config->'intervalMs')='number' THEN
    (cron_config->>'intervalMs')::NUMERIC BETWEEN 1000 AND 2147483647
    AND (cron_config->>'intervalMs')::NUMERIC=pg_catalog.trunc((cron_config->>'intervalMs')::NUMERIC)
    ELSE FALSE END`
const oldShape = `((trigger_type='schedule.cron' AND interval_anchor_ms IS NULL AND (${cronShape}))
  OR (trigger_type='schedule.interval' AND (${intervalShape}))) IS TRUE`
const dateConfirmation = `pg_catalog.jsonb_typeof(date_field_confirmation)='object'
  AND date_field_confirmation ?& ARRAY['fieldId','fieldType','schemaRevision']
  AND (date_field_confirmation-ARRAY['fieldId','fieldType','schemaRevision'])='{}'::JSONB
  AND pg_catalog.jsonb_typeof(date_field_confirmation->'fieldId')='string'
  AND length(date_field_confirmation->>'fieldId') BETWEEN 1 AND 255
  AND pg_catalog.btrim(date_field_confirmation->>'fieldId')=date_field_confirmation->>'fieldId'
  AND (date_field_confirmation->>'fieldId') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')
  AND date_field_confirmation->>'fieldType' IN ('date','dateTime')
  AND pg_catalog.jsonb_typeof(date_field_confirmation->'fieldType')='string'
  AND pg_catalog.jsonb_typeof(date_field_confirmation->'schemaRevision')='string'
  AND date_field_confirmation->>'schemaRevision' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'`
const dateConfig = `pg_catalog.jsonb_typeof(cron_config)='object'
  AND cron_config ?& ARRAY['dateFieldId','offsetDays','direction']
  AND (cron_config-ARRAY['dateFieldId','offsetDays','direction','timeOfDay','timezone','effectiveAt','scanIntervalMs'])='{}'::JSONB
  AND pg_catalog.jsonb_typeof(cron_config->'dateFieldId')='string'
  AND cron_config->>'dateFieldId'=date_field_confirmation->>'fieldId'
  AND pg_catalog.jsonb_typeof(cron_config->'direction')='string' AND cron_config->>'direction' IN ('before','after')
  AND CASE WHEN pg_catalog.jsonb_typeof(cron_config->'offsetDays')='number' THEN
    (cron_config->>'offsetDays')::NUMERIC BETWEEN 0 AND 36500
    AND (cron_config->>'offsetDays')::NUMERIC=pg_catalog.trunc((cron_config->>'offsetDays')::NUMERIC) ELSE FALSE END
  AND (NOT (cron_config ? 'scanIntervalMs') OR CASE WHEN pg_catalog.jsonb_typeof(cron_config->'scanIntervalMs')='number' THEN
    (cron_config->>'scanIntervalMs')::NUMERIC BETWEEN 1 AND 9007199254740991
    AND (cron_config->>'scanIntervalMs')::NUMERIC=pg_catalog.trunc((cron_config->>'scanIntervalMs')::NUMERIC) ELSE FALSE END)
  AND (NOT (cron_config ? 'timeOfDay') OR (pg_catalog.jsonb_typeof(cron_config->'timeOfDay')='string'
    AND cron_config->>'timeOfDay' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
  AND (NOT (cron_config ? 'timezone') OR (pg_catalog.jsonb_typeof(cron_config->'timezone')='string'
    AND length(cron_config->>'timezone') BETWEEN 1 AND 128 AND cron_config->>'timezone' ~ '^[A-Za-z][A-Za-z0-9_+./-]*$'))
  AND (NOT (cron_config ? 'effectiveAt') OR (pg_catalog.jsonb_typeof(cron_config->'effectiveAt')='string'
    AND cron_config->>'effectiveAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'))`
const shape = `((date_field_confirmation IS NULL AND (${oldShape}))
  OR (trigger_type='schedule.date_field' AND interval_anchor_ms IS NULL AND (${dateConfirmation}) AND (${dateConfig}))) IS TRUE`

function admission(date: boolean): string {
  const currentShape = date ? shape : oldShape
  const check = currentShape.replaceAll('date_field_confirmation', 'NEW.date_field_confirmation')
    .replaceAll('cron_config', 'NEW.cron_config').replaceAll('trigger_type', 'NEW.trigger_type')
    .replaceAll('interval_anchor_ms', 'NEW.interval_anchor_ms')
  return `CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
    DECLARE grant_row JSONB; rule_row JSONB; other_binding BOOLEAN; anchor_ms NUMERIC;
      ${date ? 'field_row JSONB; sheet_row JSONB; current_revision UUID;' : ''}
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
        OR rule_row->>'trigger_type' IS DISTINCT FROM NEW.trigger_type
        OR rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB
        OR rule_row->'trigger_config' IS DISTINCT FROM NEW.cron_config
        OR (${check}) IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
      END IF;
      IF NEW.trigger_type='schedule.interval' THEN
        IF pg_catalog.isfinite((rule_row->>'created_at')::TIMESTAMPTZ) IS NOT TRUE THEN
          RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
        END IF;
        anchor_ms:=pg_catalog.floor(extract(epoch FROM (rule_row->>'created_at')::TIMESTAMPTZ)*1000);
        IF (anchor_ms BETWEEN 1 AND 8640000000000000) IS NOT TRUE OR anchor_ms IS DISTINCT FROM NEW.interval_anchor_ms::NUMERIC THEN
          RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED';
        END IF;
      END IF;
      ${date ? `IF NEW.trigger_type='schedule.date_field' THEN
        EXECUTE pg_catalog.format('LOCK TABLE %1$I.meta_sheets,%1$I.meta_fields,%1$I.plugin_multitable_object_registry IN SHARE MODE NOWAIT',TG_TABLE_SCHEMA);
        EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(s) FROM %I.meta_sheets s WHERE s.id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
          INTO sheet_row USING rule_row->>'sheet_id';
        EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(f) FROM %I.meta_fields f WHERE f.id=$1 AND f.sheet_id=$2 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
          INTO field_row USING NEW.date_field_confirmation->>'fieldId',rule_row->>'sheet_id';
        EXECUTE pg_catalog.format('SELECT revision FROM %I.automation_read_material_epochs WHERE kind=''sheet'' AND scope=pg_catalog.jsonb_build_object(''id'',$1::text) FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
          INTO current_revision USING rule_row->>'sheet_id';
        IF sheet_row IS NULL OR sheet_row->'deleted_at' IS DISTINCT FROM 'null'::JSONB OR field_row IS NULL
          OR field_row->>'type' IS DISTINCT FROM NEW.date_field_confirmation->>'fieldType'
          OR current_revision IS DISTINCT FROM (NEW.date_field_confirmation->>'schemaRevision')::UUID THEN
          RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_DATE_FIELD_CONFIRMATION_INVALID';
        END IF;
      END IF;` : ''}
      NEW.activated_at:=pg_catalog.clock_timestamp();
      RETURN NEW;
    END $function$;`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE ledger_schema TEXT; consistent BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT ledger_schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      SELECT count(c.oid)=8 AND count(DISTINCT c.relnamespace)=1 AND bool_and(c.relkind='r' AND NOT c.relrowsecurity)
        INTO consistent FROM unnest(ARRAY['integration_automation_read_grants','integration_automation_read_requests',
          'integration_automation_read_schedule_activations','automation_rules','meta_sheets','meta_fields',
          'plugin_multitable_object_registry','automation_read_material_epochs']) AS expected(name)
        LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(expected.name);
      IF consistent IS DISTINCT FROM TRUE THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_DATE_SCHEDULE_SCHEMA_INVALID'; END IF;
      -- Drain ordinary admission in writer order. No old row is rewritten.
      EXECUTE pg_catalog.format('LOCK TABLE %I.automation_rules IN SHARE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_requests IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations ADD COLUMN date_field_confirmation JSONB;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations DROP CONSTRAINT automation_read_schedule_config_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations ADD CONSTRAINT automation_read_schedule_config_shape CHECK (${shape});
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations ADD CONSTRAINT automation_read_date_activation_scope UNIQUE(id,grant_id,tenant_id,owner_id);
        ALTER TABLE __SCHEMA__.integration_automation_read_requests ADD CONSTRAINT automation_read_date_request_scope UNIQUE(id,grant_id,tenant_id,owner_id);
        ${admission(true)}
        CREATE TABLE __SCHEMA__.integration_automation_read_date_occurrences(
          request_id UUID PRIMARY KEY, activation_id UUID NOT NULL, grant_id UUID NOT NULL,
          tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,record_id TEXT NOT NULL,
          occurrence_at TIMESTAMPTZ NOT NULL,occurrence_at_utc TEXT NOT NULL,invocation_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
          CONSTRAINT automation_read_date_occurrence_unique UNIQUE(activation_id,record_id,occurrence_at),
          CONSTRAINT automation_read_date_occurrence_activation FOREIGN KEY(activation_id,grant_id,tenant_id,owner_id)
            REFERENCES __SCHEMA__.integration_automation_read_schedule_activations(id,grant_id,tenant_id,owner_id) ON DELETE RESTRICT,
          CONSTRAINT automation_read_date_occurrence_request FOREIGN KEY(request_id,grant_id,tenant_id,owner_id)
            REFERENCES __SCHEMA__.integration_automation_read_requests(id,grant_id,tenant_id,owner_id) ON DELETE RESTRICT,
          CONSTRAINT automation_read_date_occurrence_grant FOREIGN KEY(grant_id,tenant_id,owner_id)
            REFERENCES __SCHEMA__.integration_automation_read_grants(id,tenant_id,owner_id) ON DELETE RESTRICT,
          CONSTRAINT automation_read_date_occurrence_record CHECK(length(record_id) BETWEEN 1 AND 255
            AND pg_catalog.btrim(record_id)=record_id AND record_id !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')),
          CONSTRAINT automation_read_date_occurrence_time CHECK(pg_catalog.isfinite(occurrence_at)
            AND occurrence_at>pg_catalog.to_timestamp(0) AND occurrence_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'
            AND pg_catalog.date_trunc('milliseconds',occurrence_at)=occurrence_at
            AND occurrence_at_utc=pg_catalog.to_char(occurrence_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          CONSTRAINT automation_read_date_occurrence_hash CHECK(invocation_id ~ '^date-schedule-read:[a-f0-9]{64}$')
        );
        CREATE FUNCTION __SCHEMA__.automation_read_date_occurrence_admit() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          DECLARE grant_row JSONB;activation JSONB;request_row JSONB;new_request BOOLEAN;expected_hash TEXT;
          BEGIN
            EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g) FROM %I.integration_automation_read_grants g WHERE id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
              INTO grant_row USING NEW.grant_id;
            EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(a) FROM %I.integration_automation_read_schedule_activations a WHERE id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
              INTO activation USING NEW.activation_id;
            EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(r),r.xmin::text=(pg_catalog.pg_current_xact_id()::text::numeric %% 4294967296)::text
              FROM %I.integration_automation_read_requests r WHERE id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
              INTO request_row,new_request USING NEW.request_id;
            -- Exact JS JSON.stringify([activationId,recordId,UTCdueISO]) bytes;
            -- separately serializing each string avoids JSONB's comma spaces.
            expected_hash:='date-schedule-read:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              '['||pg_catalog.to_json(NEW.activation_id::TEXT)::TEXT||','||pg_catalog.to_json(NEW.record_id)::TEXT||','
              ||pg_catalog.to_json(NEW.occurrence_at_utc)::TEXT||']','UTF8')),'hex');
            IF grant_row IS NULL OR activation IS NULL OR request_row IS NULL OR new_request IS DISTINCT FROM TRUE
              OR grant_row->>'purpose' IS DISTINCT FROM 'automatic' OR grant_row->>'status' IS DISTINCT FROM 'active'
              OR grant_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
              OR grant_row->'triggers' IS DISTINCT FROM '["schedule"]'::JSONB
              OR (grant_row->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp()
              OR activation->>'trigger_type' IS DISTINCT FROM 'schedule.date_field'
              OR activation->>'grant_id' IS DISTINCT FROM NEW.grant_id::TEXT
              OR activation->>'tenant_id' IS DISTINCT FROM NEW.tenant_id OR activation->>'owner_id' IS DISTINCT FROM NEW.owner_id
              OR grant_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id OR grant_row->>'owner_id' IS DISTINCT FROM NEW.owner_id
              OR grant_row->'selector'->>'ruleId' IS DISTINCT FROM activation->>'rule_id'
              OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(activation->>'project_no')
              OR request_row->>'grant_id' IS DISTINCT FROM NEW.grant_id::TEXT
              OR request_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id OR request_row->>'owner_id' IS DISTINCT FROM NEW.owner_id
              OR request_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB OR request_row->>'status' IS DISTINCT FROM 'queued'
              OR request_row->>'trigger_type' IS DISTINCT FROM 'schedule' OR request_row->>'project_no' IS DISTINCT FROM activation->>'project_no'
              OR request_row->>'invocation_id' IS DISTINCT FROM NEW.invocation_id OR NEW.invocation_id IS DISTINCT FROM expected_hash
              OR (NEW.occurrence_at>(activation->>'activated_at')::TIMESTAMPTZ AND NEW.occurrence_at<=pg_catalog.clock_timestamp()) IS NOT TRUE THEN
              RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_DATE_OCCURRENCE_DENIED';
            END IF;
            NEW.created_at:=pg_catalog.clock_timestamp();RETURN NEW;
          END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_date_occurrence_immutable() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_DATE_OCCURRENCE_IMMUTABLE'; END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_date_request_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          DECLARE activation JSONB;request_row JSONB;receipt JSONB;
          BEGIN
            EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(r),pg_catalog.to_jsonb(a),pg_catalog.to_jsonb(o)
              FROM %I.integration_automation_read_requests r JOIN %I.integration_automation_read_schedule_activations a ON a.grant_id=r.grant_id
              LEFT JOIN %I.integration_automation_read_date_occurrences o ON o.request_id=r.id
              WHERE r.id=$1 AND a.trigger_type=''schedule.date_field''',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
              INTO request_row,activation,receipt USING NEW.id;
            IF activation IS NOT NULL AND (receipt IS NULL
              OR receipt->>'activation_id' IS DISTINCT FROM activation->>'id'
              OR receipt->>'grant_id' IS DISTINCT FROM request_row->>'grant_id'
              OR receipt->>'tenant_id' IS DISTINCT FROM request_row->>'tenant_id' OR receipt->>'owner_id' IS DISTINCT FROM request_row->>'owner_id'
              OR receipt->>'invocation_id' IS DISTINCT FROM request_row->>'invocation_id'
              OR request_row->>'trigger_type' IS DISTINCT FROM 'schedule' OR request_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
              OR request_row->>'project_no' IS DISTINCT FROM activation->>'project_no') THEN
              RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_DATE_OCCURRENCE_REQUIRED';
            END IF;RETURN NEW;
          END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_date_request_identity() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          DECLARE date_grant BOOLEAN;
          BEGIN
            IF ROW(NEW.id,NEW.grant_id,NEW.owner_id,NEW.tenant_id,NEW.workspace_id,NEW.project_no,NEW.invocation_id,NEW.trigger_type,NEW.created_at)
              IS NOT DISTINCT FROM ROW(OLD.id,OLD.grant_id,OLD.owner_id,OLD.tenant_id,OLD.workspace_id,OLD.project_no,OLD.invocation_id,OLD.trigger_type,OLD.created_at) THEN RETURN NEW;END IF;
            EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_schedule_activations WHERE grant_id IN ($1,$2) AND trigger_type=''schedule.date_field'')',TG_TABLE_SCHEMA)
              INTO date_grant USING OLD.grant_id,NEW.grant_id;
            IF date_grant THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_DATE_REQUEST_IDENTITY_IMMUTABLE';END IF;RETURN NEW;
          END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_date_grant_identity() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          DECLARE date_grant BOOLEAN;
          BEGIN
            IF (pg_catalog.to_jsonb(NEW)-ARRAY['status','used_executions','updated_at'])
              IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['status','used_executions','updated_at']) THEN RETURN NEW;END IF;
            EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_schedule_activations WHERE grant_id=$1 AND trigger_type=''schedule.date_field'')',TG_TABLE_SCHEMA)
              INTO date_grant USING OLD.id;
            IF date_grant THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_DATE_GRANT_IDENTITY_IMMUTABLE';END IF;RETURN NEW;
          END $function$;
        CREATE TRIGGER automation_read_date_occurrence_admit BEFORE INSERT ON __SCHEMA__.integration_automation_read_date_occurrences
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_date_occurrence_admit();
        CREATE TRIGGER automation_read_date_occurrence_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.integration_automation_read_date_occurrences
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_date_occurrence_immutable();
        CREATE TRIGGER automation_read_date_occurrence_no_truncate BEFORE TRUNCATE ON __SCHEMA__.integration_automation_read_date_occurrences
          FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.automation_read_date_occurrence_immutable();
        CREATE TRIGGER automation_read_date_request_identity BEFORE UPDATE ON __SCHEMA__.integration_automation_read_requests
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_date_request_identity();
        CREATE TRIGGER automation_read_date_grant_identity BEFORE UPDATE ON __SCHEMA__.integration_automation_read_grants
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_date_grant_identity();
        CREATE CONSTRAINT TRIGGER automation_read_date_request_required AFTER INSERT OR UPDATE ON __SCHEMA__.integration_automation_read_requests
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_date_request_required();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema));
    END $migration$;`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE ledger_schema TEXT;history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT ledger_schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.automation_rules IN SHARE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_requests IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_date_occurrences IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_schedule_activations WHERE trigger_type=''schedule.date_field'' OR date_field_confirmation IS NOT NULL)
        OR EXISTS(SELECT 1 FROM %I.integration_automation_read_date_occurrences)',ledger_schema,ledger_schema) INTO history;
      IF history THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_DATE_SCHEDULE_HAS_HISTORY';END IF;
      EXECUTE pg_catalog.replace($ddl$
        DROP TRIGGER automation_read_date_request_required ON __SCHEMA__.integration_automation_read_requests;
        DROP TRIGGER automation_read_date_request_identity ON __SCHEMA__.integration_automation_read_requests;
        DROP TRIGGER automation_read_date_grant_identity ON __SCHEMA__.integration_automation_read_grants;
        DROP TABLE __SCHEMA__.integration_automation_read_date_occurrences;
        DROP FUNCTION __SCHEMA__.automation_read_date_occurrence_admit();
        DROP FUNCTION __SCHEMA__.automation_read_date_occurrence_immutable();
        DROP FUNCTION __SCHEMA__.automation_read_date_request_required();
        DROP FUNCTION __SCHEMA__.automation_read_date_request_identity();
        DROP FUNCTION __SCHEMA__.automation_read_date_grant_identity();
        ALTER TABLE __SCHEMA__.integration_automation_read_requests DROP CONSTRAINT automation_read_date_request_scope;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations DROP CONSTRAINT automation_read_date_activation_scope;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations DROP CONSTRAINT automation_read_schedule_config_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations ADD CONSTRAINT automation_read_schedule_config_shape CHECK (${oldShape});
        ${admission(false)}
        ALTER TABLE __SCHEMA__.integration_automation_read_schedule_activations DROP COLUMN date_field_confirmation;
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema));
    END $migration$;`).execute(db)
}
