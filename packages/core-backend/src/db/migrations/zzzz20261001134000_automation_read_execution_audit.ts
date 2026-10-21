import { sql, type Kysely } from 'kysely'

/** Values-free public audit, with an immutable private request association.
 * No public FK: ordinary log retention may remove a shell, never its private
 * history. State changes update existing shells only and never resurrect them.
 * No backfill: old requests did not create these real execution shells. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE audit_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT audit_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='multitable_automation_executions'::pg_catalog.regclass;
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.multitable_automation_executions ADD COLUMN integration_read JSONB;
        ALTER TABLE __SCHEMA__.multitable_automation_executions
          ADD CONSTRAINT automation_read_execution_projection_shape CHECK (
            integration_read IS NULL OR COALESCE(
              pg_catalog.jsonb_typeof(integration_read)='object'
              AND integration_read ?& ARRAY['requestId','status']
              AND integration_read - ARRAY['requestId','status']='{}'::JSONB
              AND pg_catalog.jsonb_typeof(integration_read->'requestId')='string'
              AND integration_read->>'requestId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
              AND pg_catalog.jsonb_typeof(integration_read->'status')='string'
              AND integration_read->>'status' IN ('queued','running','succeeded','blocked','failed','cancelled','outcome_unknown'), FALSE)
          );
        CREATE TABLE __SCHEMA__.integration_automation_read_executions (
          request_id UUID PRIMARY KEY REFERENCES __SCHEMA__.integration_automation_read_requests(id) ON DELETE RESTRICT,
          execution_id TEXT NOT NULL UNIQUE CHECK (execution_id ~ '^axe_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
          rule_id TEXT NOT NULL,
          rule_revision UUID NOT NULL,
          step_index INTEGER NOT NULL CHECK (step_index=0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
        );

        CREATE FUNCTION __SCHEMA__.automation_read_execution_projection(request_id UUID, read_status TEXT)
          RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $function$
        DECLARE legacy TEXT; reason TEXT; step JSONB; steps JSONB := '[]'::JSONB;
        BEGIN
          IF read_status NOT IN ('queued','running','succeeded','blocked','failed','cancelled','outcome_unknown') OR read_status IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_PROJECTION_INVALID';
          END IF;
          legacy := CASE WHEN read_status IN ('queued','running') THEN 'running'
            WHEN read_status='succeeded' THEN 'success'
            WHEN read_status IN ('blocked','cancelled') THEN 'skipped' ELSE 'failed' END;
          reason := CASE WHEN read_status='outcome_unknown' THEN 'AUTOMATION_READ_OUTCOME_UNKNOWN'
            WHEN read_status='failed' THEN 'AUTOMATION_READ_FAILED' ELSE NULL END;
          IF legacy <> 'running' THEN
            step := pg_catalog.jsonb_build_object('actionType','integration_read_preview','status',legacy,
              'output',pg_catalog.jsonb_build_object('requestId',request_id::TEXT,'status',read_status));
            IF reason IS NOT NULL THEN step := step || pg_catalog.jsonb_build_object('error',reason); END IF;
            steps := pg_catalog.jsonb_build_array(step);
          END IF;
          RETURN pg_catalog.jsonb_build_object('integration_read',
            pg_catalog.jsonb_build_object('requestId',request_id::TEXT,'status',read_status),
            'status',legacy,'steps',steps,'error',reason);
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_execution_link_admit() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE request JSONB; grant_row JSONB; rule_row JSONB; public_row JSONB; projection JSONB; new_request BOOLEAN; new_shell BOOLEAN;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(q),pg_catalog.to_jsonb(g),pg_catalog.to_jsonb(r),
            q.xmin::TEXT=(pg_catalog.pg_current_xact_id()::TEXT::NUMERIC %% 4294967296)::TEXT
            FROM %I.integration_automation_read_requests q JOIN %I.integration_automation_read_grants g ON g.id=q.grant_id
            JOIN %I.automation_rules r ON r.id=$2 WHERE q.id=$1 FOR SHARE OF q,g,r NOWAIT',
            TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
            INTO request,grant_row,rule_row,new_request USING NEW.request_id,NEW.rule_id;
          IF request IS NULL OR new_request IS DISTINCT FROM TRUE OR request->>'status'<>'queued'
            OR request->>'trigger_type' NOT IN ('manual','schedule','record')
            OR request->'workspace_id'<>'null'::JSONB OR grant_row->'workspace_id'<>'null'::JSONB
            OR request->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id'
            OR request->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR grant_row->>'status'<>'active' OR (grant_row->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp()
            OR grant_row->'selector'->>'ruleId' IS DISTINCT FROM NEW.rule_id
            OR NOT (grant_row->'projects' ? (request->>'project_no'))
            OR NOT (grant_row->'triggers' ? (request->>'trigger_type'))
            OR rule_row->>'created_by' IS DISTINCT FROM request->>'owner_id'
            OR rule_row->'enabled' IS DISTINCT FROM 'true'::JSONB
            OR rule_row->>'action_type'<>'integration_read_preview'
            OR rule_row->>'integration_authority_revision' IS DISTINCT FROM NEW.rule_revision::TEXT THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_AUDIT_DENIED';
          END IF;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(e),
            e.xmin::TEXT=(pg_catalog.pg_current_xact_id()::TEXT::NUMERIC %% 4294967296)::TEXT
            FROM %I.multitable_automation_executions e WHERE e.id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
            INTO public_row,new_shell USING NEW.execution_id;
          projection := __SCHEMA__.automation_read_execution_projection(NEW.request_id,'queued');
          IF public_row IS NULL OR new_shell IS DISTINCT FROM TRUE OR public_row->>'rule_id' IS DISTINCT FROM NEW.rule_id
            OR public_row->>'sheet_id' IS DISTINCT FROM rule_row->>'sheet_id'
            OR public_row->>'triggered_by' IS DISTINCT FROM 'integration-read-owner'
            OR (public_row->>'triggered_at')::TIMESTAMPTZ IS DISTINCT FROM pg_catalog.date_trunc('milliseconds',(request->>'created_at')::TIMESTAMPTZ)
            OR public_row->'integration_read' IS DISTINCT FROM projection->'integration_read'
            OR public_row->'status' IS DISTINCT FROM projection->'status'
            OR public_row->'steps' IS DISTINCT FROM projection->'steps'
            OR public_row->'error' IS DISTINCT FROM projection->'error'
            OR public_row->'duration' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'finished_at' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'trigger_event' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'rule_snapshot' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'rule_action_fingerprint' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'initiated_by' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'rerun_of_execution_id' IS DISTINCT FROM 'null'::JSONB
            OR (public_row ? 'first_retry_attempted_at' AND public_row->'first_retry_attempted_at' IS DISTINCT FROM 'null'::JSONB)
            OR public_row->'schema_version' IS DISTINCT FROM '1'::JSONB THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_SHELL_INVALID';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_execution_link_immutable() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        BEGIN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_EXECUTION_LINK_IMMUTABLE';
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_execution_request_identity() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE linked BOOLEAN;
        BEGIN
          -- Limited identity hardening, not authorization. Lifecycle state,
          -- lease/fence/result and the later outbox attachment remain writable.
          IF ROW(NEW.grant_id,NEW.owner_id,NEW.tenant_id,NEW.workspace_id,NEW.project_no,
            NEW.invocation_id,NEW.trigger_type,NEW.created_at) IS NOT DISTINCT FROM
            ROW(OLD.grant_id,OLD.owner_id,OLD.tenant_id,OLD.workspace_id,OLD.project_no,
            OLD.invocation_id,OLD.trigger_type,OLD.created_at) THEN RETURN NEW; END IF;
          EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %I.integration_automation_read_executions WHERE request_id=$1)',TG_TABLE_SCHEMA)
            INTO linked USING OLD.id;
          IF linked THEN
            RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_EXECUTION_REQUEST_IDENTITY_IMMUTABLE';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_execution_public_guard() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE link_row JSONB; request JSONB; old_projection JSONB; projection JSONB;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(l),pg_catalog.to_jsonb(q)
            FROM %I.integration_automation_read_executions l JOIN %I.integration_automation_read_requests q ON q.id=l.request_id
            WHERE l.execution_id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
            INTO link_row,request USING NEW.id;
          IF TG_OP='INSERT' THEN
            IF link_row IS NOT NULL THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_HISTORY_NOT_REVIVABLE';
            END IF;
            RETURN NEW;
          END IF;
          IF link_row IS NULL THEN
            IF OLD.integration_read IS NOT NULL OR NEW.integration_read IS NOT NULL THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_LINK_MISSING';
            END IF;
            RETURN NEW;
          END IF;
          old_projection := __SCHEMA__.automation_read_execution_projection((link_row->>'request_id')::UUID,OLD.integration_read->>'status');
          projection := __SCHEMA__.automation_read_execution_projection((link_row->>'request_id')::UUID,request->>'status');
          IF OLD.rule_id IS DISTINCT FROM link_row->>'rule_id' OR OLD.triggered_by<>'integration-read-owner'
            OR OLD.integration_read IS DISTINCT FROM old_projection->'integration_read'
            OR pg_catalog.to_jsonb(OLD.status) IS DISTINCT FROM old_projection->'status'
            OR OLD.steps IS DISTINCT FROM old_projection->'steps'
            OR pg_catalog.to_jsonb(OLD.error) IS DISTINCT FROM NULLIF(old_projection->'error','null'::JSONB)
            OR OLD.trigger_event IS NOT NULL OR OLD.rule_snapshot IS NOT NULL OR OLD.rule_action_fingerprint IS NOT NULL
            OR OLD.initiated_by IS NOT NULL OR OLD.rerun_of_execution_id IS NOT NULL OR OLD.duration IS NOT NULL
            OR (pg_catalog.to_jsonb(NEW)-ARRAY['status','steps','error','finished_at','integration_read'])
              IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['status','steps','error','finished_at','integration_read'])
            OR NEW.integration_read IS DISTINCT FROM projection->'integration_read'
            OR pg_catalog.to_jsonb(NEW.status) IS DISTINCT FROM projection->'status'
            OR NEW.steps IS DISTINCT FROM projection->'steps'
            OR pg_catalog.to_jsonb(NEW.error) IS DISTINCT FROM NULLIF(projection->'error','null'::JSONB)
            OR NEW.finished_at IS DISTINCT FROM (request->>'finished_at')::TIMESTAMPTZ THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_PROJECTION_INVALID';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_execution_public_link_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE public_row JSONB; link_row JSONB; request JSONB; projection JSONB;
        BEGIN
          -- Read the final row, not this deferred event's possibly stale NEW.
          -- Retention may have removed it in this transaction; no public FK or
          -- resurrection is needed to keep the private history intact.
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(e) FROM %I.multitable_automation_executions e WHERE e.id=$1',TG_TABLE_SCHEMA)
            INTO public_row USING NEW.id;
          IF public_row IS NULL OR public_row->'integration_read'='null'::JSONB THEN RETURN NEW; END IF;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(l),pg_catalog.to_jsonb(q)
            FROM %I.integration_automation_read_executions l JOIN %I.integration_automation_read_requests q ON q.id=l.request_id
            WHERE l.execution_id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
            INTO link_row,request USING NEW.id;
          IF link_row IS NULL OR request IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_LINK_MISSING';
          END IF;
          projection := __SCHEMA__.automation_read_execution_projection((link_row->>'request_id')::UUID,request->>'status');
          IF public_row->>'rule_id' IS DISTINCT FROM link_row->>'rule_id'
            OR public_row->>'triggered_by' IS DISTINCT FROM 'integration-read-owner'
            OR public_row->'integration_read' IS DISTINCT FROM projection->'integration_read'
            OR public_row->'status' IS DISTINCT FROM projection->'status'
            OR public_row->'steps' IS DISTINCT FROM projection->'steps'
            OR public_row->'error' IS DISTINCT FROM projection->'error'
            OR (public_row->>'finished_at')::TIMESTAMPTZ IS DISTINCT FROM (request->>'finished_at')::TIMESTAMPTZ
            OR public_row->'duration' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'trigger_event' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'rule_snapshot' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'rule_action_fingerprint' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'initiated_by' IS DISTINCT FROM 'null'::JSONB
            OR public_row->'rerun_of_execution_id' IS DISTINCT FROM 'null'::JSONB THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_PROJECTION_INVALID';
          END IF;
          RETURN NEW;
        END $function$;

        CREATE FUNCTION __SCHEMA__.automation_read_execution_project() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE request_id UUID; request JSONB; link_row JSONB; public_row JSONB; previous JSONB; projection JSONB; old_status TEXT; old_finished TIMESTAMPTZ;
        BEGIN
          IF TG_TABLE_NAME='integration_automation_read_executions' THEN
            request_id := NEW.request_id; old_status := 'queued'; old_finished := NULL;
          ELSE request_id := NEW.id; old_status := OLD.status; old_finished := OLD.finished_at; END IF;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(q),pg_catalog.to_jsonb(l)
            FROM %I.integration_automation_read_requests q JOIN %I.integration_automation_read_executions l ON l.request_id=q.id
            WHERE q.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO request,link_row USING request_id;
          IF link_row IS NULL THEN RETURN NEW; END IF;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(e) FROM %I.multitable_automation_executions e WHERE e.id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
            INTO public_row USING link_row->>'execution_id';
          IF public_row IS NULL THEN
            IF TG_TABLE_NAME='integration_automation_read_executions' THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_SHELL_MISSING';
            END IF;
            RETURN NEW; -- retention removed this public row; do not INSERT a replacement
          END IF;
          previous := __SCHEMA__.automation_read_execution_projection(request_id,old_status);
          IF public_row->'integration_read' IS DISTINCT FROM previous->'integration_read'
            OR public_row->'status' IS DISTINCT FROM previous->'status'
            OR public_row->'steps' IS DISTINCT FROM previous->'steps'
            OR public_row->'error' IS DISTINCT FROM previous->'error'
            OR (public_row->>'finished_at')::TIMESTAMPTZ IS DISTINCT FROM old_finished THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AUTOMATION_READ_EXECUTION_PROJECTION_INVALID';
          END IF;
          projection := __SCHEMA__.automation_read_execution_projection(request_id,request->>'status');
          EXECUTE pg_catalog.format('UPDATE %I.multitable_automation_executions
            SET integration_read=$2,status=$3,steps=$4,error=$5,finished_at=$6 WHERE id=$1',TG_TABLE_SCHEMA)
            USING link_row->>'execution_id',projection->'integration_read',projection->>'status',projection->'steps',projection->>'error',(request->>'finished_at')::TIMESTAMPTZ;
          RETURN NEW;
        END $function$;

        CREATE TRIGGER automation_read_execution_link_admit BEFORE INSERT ON __SCHEMA__.integration_automation_read_executions
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_execution_link_admit();
        CREATE TRIGGER automation_read_execution_link_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.integration_automation_read_executions
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_execution_link_immutable();
        CREATE TRIGGER automation_read_execution_link_no_truncate BEFORE TRUNCATE ON __SCHEMA__.integration_automation_read_executions
          FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.automation_read_execution_link_immutable();
        CREATE TRIGGER automation_read_execution_link_project AFTER INSERT ON __SCHEMA__.integration_automation_read_executions
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_execution_project();
        CREATE TRIGGER automation_read_execution_request_project AFTER UPDATE OF status,started_at,finished_at ON __SCHEMA__.integration_automation_read_requests
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_execution_project();
        CREATE TRIGGER automation_read_execution_request_identity BEFORE UPDATE ON __SCHEMA__.integration_automation_read_requests
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_execution_request_identity();
        CREATE TRIGGER automation_read_execution_public_guard BEFORE INSERT OR UPDATE ON __SCHEMA__.multitable_automation_executions
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_execution_public_guard();
        CREATE CONSTRAINT TRIGGER automation_read_execution_public_link_required
          AFTER INSERT OR UPDATE ON __SCHEMA__.multitable_automation_executions
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.integration_read IS NOT NULL)
          EXECUTE FUNCTION __SCHEMA__.automation_read_execution_public_link_required();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(audit_schema));
    END $migration$;
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE audit_schema TEXT; has_history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT audit_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='multitable_automation_executions'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_requests IN ACCESS EXCLUSIVE MODE',audit_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_executions IN ACCESS EXCLUSIVE MODE',audit_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.multitable_automation_executions IN ACCESS EXCLUSIVE MODE',audit_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_executions)
        OR EXISTS(SELECT 1 FROM %I.multitable_automation_executions WHERE integration_read IS NOT NULL)',audit_schema,audit_schema) INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_READ_EXECUTION_AUDIT_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        DROP TRIGGER automation_read_execution_request_project ON __SCHEMA__.integration_automation_read_requests;
        DROP TRIGGER automation_read_execution_request_identity ON __SCHEMA__.integration_automation_read_requests;
        DROP TRIGGER automation_read_execution_public_guard ON __SCHEMA__.multitable_automation_executions;
        DROP TRIGGER automation_read_execution_public_link_required ON __SCHEMA__.multitable_automation_executions;
        DROP TABLE __SCHEMA__.integration_automation_read_executions;
        DROP FUNCTION __SCHEMA__.automation_read_execution_project();
        DROP FUNCTION __SCHEMA__.automation_read_execution_public_guard();
        DROP FUNCTION __SCHEMA__.automation_read_execution_public_link_required();
        DROP FUNCTION __SCHEMA__.automation_read_execution_link_immutable();
        DROP FUNCTION __SCHEMA__.automation_read_execution_request_identity();
        DROP FUNCTION __SCHEMA__.automation_read_execution_link_admit();
        DROP FUNCTION __SCHEMA__.automation_read_execution_projection(UUID,TEXT);
        ALTER TABLE __SCHEMA__.multitable_automation_executions DROP COLUMN integration_read;
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(audit_schema));
    END $migration$;
  `).execute(db)
}
