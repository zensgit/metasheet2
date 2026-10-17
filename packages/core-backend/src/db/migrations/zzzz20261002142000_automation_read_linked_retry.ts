import { sql, type Kysely } from 'kysely'

/** Explicit one-new-budget manual attempts. No history is reset/backfilled.
 * Structural SQL guards do not replace the actual host source/ACL authority. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE ledger_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT ledger_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT integration_automation_read_grants_purpose_check;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT integration_automation_read_grants_purpose_check CHECK (purpose IN ('standalone','automatic','retry'));
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT automation_read_retry_grant_shape CHECK ((purpose<>'retry' OR (
          workspace_id IS NULL AND triggers=ARRAY['manual']::TEXT[] AND max_executions=1
          AND cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1
        )) IS TRUE);
        CREATE TABLE __SCHEMA__.integration_automation_read_retries (
          request_id UUID PRIMARY KEY REFERENCES __SCHEMA__.integration_automation_read_requests(id) ON DELETE RESTRICT,
          grant_id UUID NOT NULL UNIQUE,
          parent_request_id UUID NOT NULL UNIQUE REFERENCES __SCHEMA__.integration_automation_read_requests(id) ON DELETE RESTRICT,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          retry_key UUID NOT NULL,
          acknowledge_new_read BOOLEAN NOT NULL CHECK (acknowledge_new_read IS TRUE),
          created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
          CHECK (request_id<>parent_request_id),
          CONSTRAINT automation_read_retry_owner_key UNIQUE (tenant_id,owner_id,retry_key),
          CONSTRAINT automation_read_retry_grant_scope FOREIGN KEY (grant_id,tenant_id,owner_id)
            REFERENCES __SCHEMA__.integration_automation_read_grants(id,tenant_id,owner_id) ON DELETE RESTRICT
        );
        CREATE FUNCTION __SCHEMA__.automation_read_retry_link_admit() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE parent_row JSONB; parent_grant JSONB; child_row JSONB; child_grant JSONB; new_child BOOLEAN; new_grant BOOLEAN;
        BEGIN
          -- Match metadata -> parent grant -> parent request -> new child order.
          -- Hints are not proofs; NOWAIT prevents inverse direct-writer waits.
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(p) FROM %I.integration_automation_read_requests p WHERE id=$1',TG_TABLE_SCHEMA)
            INTO parent_row USING NEW.parent_request_id;
          IF parent_row IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_DENIED'; END IF;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g) FROM %I.integration_automation_read_grants g WHERE id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
            INTO parent_grant USING (parent_row->>'grant_id')::UUID;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(p) FROM %I.integration_automation_read_requests p WHERE id=$1 FOR UPDATE NOWAIT',TG_TABLE_SCHEMA)
            INTO parent_row USING NEW.parent_request_id;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g),g.xmin::TEXT=(pg_catalog.pg_current_xact_id()::TEXT::NUMERIC %% 4294967296)::TEXT
            FROM %I.integration_automation_read_grants g WHERE id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
            INTO child_grant,new_grant USING NEW.grant_id;
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(q),q.xmin::TEXT=(pg_catalog.pg_current_xact_id()::TEXT::NUMERIC %% 4294967296)::TEXT
            FROM %I.integration_automation_read_requests q WHERE id=$1 FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
            INTO child_row,new_child USING NEW.request_id;
          IF parent_grant IS NULL OR parent_row IS NULL OR child_grant IS NULL OR child_row IS NULL
            OR new_child IS DISTINCT FROM TRUE OR new_grant IS DISTINCT FROM TRUE
            OR NEW.acknowledge_new_read IS DISTINCT FROM TRUE
            OR parent_row->>'grant_id' IS DISTINCT FROM parent_grant->>'id'
            OR parent_grant->>'purpose' NOT IN ('standalone','retry')
            OR parent_row->>'status' NOT IN ('blocked','failed','cancelled','outcome_unknown')
            OR parent_row->>'trigger_type' IS DISTINCT FROM 'manual'
            OR parent_row->>'owner_id' IS DISTINCT FROM NEW.owner_id OR parent_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
            OR parent_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
            OR parent_grant->>'owner_id' IS DISTINCT FROM NEW.owner_id OR parent_grant->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
            OR parent_grant->'workspace_id' IS DISTINCT FROM 'null'::JSONB
            OR NOT (parent_grant->'projects' ? (parent_row->>'project_no'))
            OR NOT (parent_grant->'triggers' ? 'manual')
            OR child_grant->>'purpose' IS DISTINCT FROM 'retry' OR child_grant->>'status' IS DISTINCT FROM 'active'
            OR child_grant->'workspace_id' IS DISTINCT FROM 'null'::JSONB
            OR child_grant->>'owner_id' IS DISTINCT FROM NEW.owner_id OR child_grant->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
            OR child_grant->>'max_executions' IS DISTINCT FROM '1' OR child_grant->>'used_executions' IS DISTINCT FROM '0'
            OR (child_grant->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp()
            OR child_grant->'triggers' IS DISTINCT FROM pg_catalog.jsonb_build_array('manual')
            OR child_grant->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(parent_row->>'project_no')
            OR child_grant->'selector' IS DISTINCT FROM parent_grant->'selector'
            OR child_grant->'source_reference' IS DISTINCT FROM parent_grant->'source_reference'
            OR child_grant->>'authority_key' IS DISTINCT FROM parent_grant->>'authority_key'
            OR child_row->>'grant_id' IS DISTINCT FROM NEW.grant_id::TEXT
            OR child_row->>'owner_id' IS DISTINCT FROM NEW.owner_id OR child_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
            OR child_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
            OR child_row->>'status' IS DISTINCT FROM 'queued' OR child_row->>'trigger_type' IS DISTINCT FROM 'manual'
            OR child_row->>'project_no' IS DISTINCT FROM parent_row->>'project_no' THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_DENIED';
          END IF;
          NEW.created_at := pg_catalog.clock_timestamp();
          RETURN NEW;
        END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_retry_immutable() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_RETRY_LINK_IMMUTABLE'; END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_retry_grant_identity() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE parent_linked BOOLEAN;
        BEGIN
          IF (pg_catalog.to_jsonb(NEW)-ARRAY['status','used_executions','updated_at'])
            IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['status','used_executions','updated_at']) THEN RETURN NEW; END IF;
          EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_retries l
            JOIN %I.integration_automation_read_requests p ON p.id=l.parent_request_id WHERE p.grant_id=$1)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
            INTO parent_linked USING OLD.id;
          IF OLD.purpose='retry' OR parent_linked THEN
            RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_RETRY_GRANT_IDENTITY_IMMUTABLE';
          END IF;
          RETURN NEW;
        END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_retry_request_identity() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE linked BOOLEAN;
        BEGIN
          IF ROW(NEW.id,NEW.grant_id,NEW.owner_id,NEW.tenant_id,NEW.workspace_id,NEW.project_no,NEW.invocation_id,NEW.trigger_type,NEW.created_at)
            IS NOT DISTINCT FROM ROW(OLD.id,OLD.grant_id,OLD.owner_id,OLD.tenant_id,OLD.workspace_id,OLD.project_no,OLD.invocation_id,OLD.trigger_type,OLD.created_at)
            THEN RETURN NEW; END IF;
          EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_retries WHERE request_id=$1 OR parent_request_id=$1)',TG_TABLE_SCHEMA)
            INTO linked USING OLD.id;
          IF linked THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_RETRY_REQUEST_IDENTITY_IMMUTABLE'; END IF;
          RETURN NEW;
        END $function$;
        CREATE FUNCTION __SCHEMA__.automation_read_retry_grant_link_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE grant_row JSONB; link_row JSONB; child_row JSONB; parent_row JSONB;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g),pg_catalog.to_jsonb(l),pg_catalog.to_jsonb(c),pg_catalog.to_jsonb(p)
            FROM %I.integration_automation_read_grants g LEFT JOIN %I.integration_automation_read_retries l ON l.grant_id=g.id
            LEFT JOIN %I.integration_automation_read_requests c ON c.id=l.request_id
            LEFT JOIN %I.integration_automation_read_requests p ON p.id=l.parent_request_id WHERE g.id=$1',
            TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO grant_row,link_row,child_row,parent_row USING NEW.id;
          IF grant_row IS NULL THEN RETURN NEW; END IF;
          IF grant_row->>'purpose'='retry' AND (link_row IS NULL OR child_row IS NULL OR parent_row IS NULL
            OR link_row->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id' OR link_row->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR link_row->'acknowledge_new_read' IS DISTINCT FROM 'true'::JSONB
            OR child_row->>'grant_id' IS DISTINCT FROM grant_row->>'id'
            OR child_row->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id' OR child_row->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR child_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB OR parent_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
            OR parent_row->>'owner_id' IS DISTINCT FROM grant_row->>'owner_id' OR parent_row->>'tenant_id' IS DISTINCT FROM grant_row->>'tenant_id'
            OR child_row->>'trigger_type' IS DISTINCT FROM 'manual' OR parent_row->>'trigger_type' IS DISTINCT FROM 'manual'
            OR child_row->>'project_no' IS DISTINCT FROM parent_row->>'project_no'
            OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(child_row->>'project_no')) THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_REQUIRED';
          END IF;
          RETURN NEW;
        END $function$;
        CREATE TRIGGER automation_read_retry_link_admit BEFORE INSERT ON __SCHEMA__.integration_automation_read_retries
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_retry_link_admit();
        CREATE TRIGGER automation_read_retry_link_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.integration_automation_read_retries
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_retry_immutable();
        CREATE TRIGGER automation_read_retry_link_no_truncate BEFORE TRUNCATE ON __SCHEMA__.integration_automation_read_retries
          FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.automation_read_retry_immutable();
        CREATE TRIGGER automation_read_retry_grant_identity BEFORE UPDATE ON __SCHEMA__.integration_automation_read_grants
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_retry_grant_identity();
        CREATE TRIGGER automation_read_retry_request_identity BEFORE UPDATE ON __SCHEMA__.integration_automation_read_requests
          FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_retry_request_identity();
        CREATE CONSTRAINT TRIGGER automation_read_retry_grant_link_required AFTER INSERT OR UPDATE ON __SCHEMA__.integration_automation_read_grants
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.purpose='retry')
          EXECUTE FUNCTION __SCHEMA__.automation_read_retry_grant_link_required();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema));
    END $migration$;
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE ledger_schema TEXT; history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT ledger_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_requests IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_retries IN ACCESS EXCLUSIVE MODE',ledger_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_retries) OR EXISTS(SELECT 1 FROM %I.integration_automation_read_grants WHERE purpose=''retry'')',ledger_schema,ledger_schema) INTO history;
      IF history THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_RETRY_HAS_HISTORY'; END IF;
      EXECUTE pg_catalog.replace($ddl$
        DROP TRIGGER automation_read_retry_grant_identity ON __SCHEMA__.integration_automation_read_grants;
        DROP TRIGGER automation_read_retry_request_identity ON __SCHEMA__.integration_automation_read_requests;
        DROP TRIGGER automation_read_retry_grant_link_required ON __SCHEMA__.integration_automation_read_grants;
        DROP TABLE __SCHEMA__.integration_automation_read_retries;
        DROP FUNCTION __SCHEMA__.automation_read_retry_link_admit();
        DROP FUNCTION __SCHEMA__.automation_read_retry_immutable();
        DROP FUNCTION __SCHEMA__.automation_read_retry_grant_identity();
        DROP FUNCTION __SCHEMA__.automation_read_retry_request_identity();
        DROP FUNCTION __SCHEMA__.automation_read_retry_grant_link_required();
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT automation_read_retry_grant_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT integration_automation_read_grants_purpose_check;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT integration_automation_read_grants_purpose_check CHECK (purpose IN ('standalone','automatic'));
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema));
    END $migration$;
  `).execute(db)
}
