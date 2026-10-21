import { sql, type Kysely } from 'kysely'

/** One explicitly confirmed reread of an immutable automatic date occurrence.
 * Parent grant liveness/usage is deliberately not renewed or inherited. Current
 * source/rule/schema/ACL authority remains the host's transaction-local gate. */
const manualShape = `(purpose<>'retry' OR (
  workspace_id IS NULL AND triggers=ARRAY['manual']::TEXT[] AND max_executions=1
  AND cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1
)) IS TRUE`

const dateShape = `(purpose<>'retry' OR (
  workspace_id IS NULL AND (triggers=ARRAY['manual']::TEXT[] OR triggers=ARRAY['schedule']::TEXT[]) AND max_executions=1
  AND cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1
)) IS TRUE`

const locks = `
  EXECUTE pg_catalog.format('LOCK TABLE %I.automation_rules IN SHARE MODE',ledger_schema);
  EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE',ledger_schema);
  EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE',ledger_schema);
  EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_requests IN ACCESS EXCLUSIVE MODE',ledger_schema);
  EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_date_occurrences IN ACCESS EXCLUSIVE MODE',ledger_schema);
  EXECUTE pg_catalog.format('LOCK TABLE %I.integration_automation_read_retries IN ACCESS EXCLUSIVE MODE',ledger_schema);`

/** Shared by admission and deferred worker checks. Ancestor identities/receipts
 * are already immutable; this function only observes them and never takes an
 * ancestor grant/request UPDATE lock while a worker owns its child grant. */
const dateOrigin = `CREATE FUNCTION __SCHEMA__.automation_read_date_retry_origin_valid(
  child_request UUID,child_grant UUID,parent_request UUID,date_parent_request UUID,scope_tenant TEXT,scope_owner TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
  SELECT EXISTS (
    SELECT 1 FROM __SCHEMA__.integration_automation_read_requests c
    JOIN __SCHEMA__.integration_automation_read_grants g ON g.id=c.grant_id
    JOIN __SCHEMA__.integration_automation_read_requests p ON p.id=parent_request
    JOIN __SCHEMA__.integration_automation_read_grants pg ON pg.id=p.grant_id
    JOIN __SCHEMA__.integration_automation_read_date_occurrences o ON o.request_id=p.id
    JOIN __SCHEMA__.integration_automation_read_schedule_activations a ON a.id=o.activation_id
    WHERE date_parent_request=parent_request AND c.id=child_request AND g.id=child_grant
      AND c.tenant_id=scope_tenant AND c.owner_id=scope_owner AND c.workspace_id IS NULL
      AND g.tenant_id=scope_tenant AND g.owner_id=scope_owner AND g.workspace_id IS NULL
      AND p.tenant_id=scope_tenant AND p.owner_id=scope_owner AND p.workspace_id IS NULL
      AND pg.tenant_id=scope_tenant AND pg.owner_id=scope_owner AND pg.workspace_id IS NULL
      AND o.tenant_id=scope_tenant AND o.owner_id=scope_owner AND o.grant_id=pg.id
      AND a.tenant_id=scope_tenant AND a.owner_id=scope_owner AND a.grant_id=pg.id
      AND g.purpose='retry' AND g.triggers=ARRAY['schedule']::TEXT[] AND g.max_executions=1
      AND pg.purpose='automatic' AND pg.triggers=ARRAY['schedule']::TEXT[]
      AND p.status IN ('blocked','failed','cancelled','outcome_unknown')
      AND c.trigger_type='schedule' AND p.trigger_type='schedule' AND c.project_no=p.project_no
      AND g.projects=ARRAY[p.project_no]::TEXT[] AND pg.projects=ARRAY[p.project_no]::TEXT[]
      AND g.selector=pg.selector AND g.source_reference=pg.source_reference AND g.authority_key=pg.authority_key
      AND a.trigger_type='schedule.date_field' AND a.date_field_confirmation IS NOT NULL
      AND a.rule_id=pg.selector->>'ruleId' AND a.project_no=p.project_no
      AND o.invocation_id=p.invocation_id
  )
$function$;`

/** The false form restores the original 142000 function body. */
function admission(dates: boolean): string {
  const trigger = dates ? "(CASE WHEN NEW.date_parent_request_id IS NULL THEN 'manual' ELSE 'schedule' END)" : "'manual'"
  const purpose = dates
    ? "(NEW.date_parent_request_id IS NULL AND parent_grant->>'purpose' NOT IN ('standalone','retry'))"
    : "parent_grant->>'purpose' NOT IN ('standalone','retry')"
  return `CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_retry_link_admit() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
  DECLARE parent_row JSONB; parent_grant JSONB; child_row JSONB; child_grant JSONB; new_child BOOLEAN; new_grant BOOLEAN;
  BEGIN
    -- Only fresh owner admission locks ancestors, in the original order.
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
      OR ${purpose}
      OR parent_row->>'status' NOT IN ('blocked','failed','cancelled','outcome_unknown')
      OR parent_row->>'trigger_type' IS DISTINCT FROM ${trigger}
      OR parent_row->>'owner_id' IS DISTINCT FROM NEW.owner_id OR parent_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
      OR parent_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
      OR parent_grant->>'owner_id' IS DISTINCT FROM NEW.owner_id OR parent_grant->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
      OR parent_grant->'workspace_id' IS DISTINCT FROM 'null'::JSONB
      OR NOT (parent_grant->'projects' ? (parent_row->>'project_no'))
      OR NOT (parent_grant->'triggers' ? ${trigger})
      OR child_grant->>'purpose' IS DISTINCT FROM 'retry' OR child_grant->>'status' IS DISTINCT FROM 'active'
      OR child_grant->'workspace_id' IS DISTINCT FROM 'null'::JSONB
      OR child_grant->>'owner_id' IS DISTINCT FROM NEW.owner_id OR child_grant->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
      OR child_grant->>'max_executions' IS DISTINCT FROM '1' OR child_grant->>'used_executions' IS DISTINCT FROM '0'
      OR (child_grant->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp()
      OR child_grant->'triggers' IS DISTINCT FROM pg_catalog.jsonb_build_array(${trigger})
      OR child_grant->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(parent_row->>'project_no')
      OR child_grant->'selector' IS DISTINCT FROM parent_grant->'selector'
      OR child_grant->'source_reference' IS DISTINCT FROM parent_grant->'source_reference'
      OR child_grant->>'authority_key' IS DISTINCT FROM parent_grant->>'authority_key'
      OR child_row->>'grant_id' IS DISTINCT FROM NEW.grant_id::TEXT
      OR child_row->>'owner_id' IS DISTINCT FROM NEW.owner_id OR child_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
      OR child_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB
      OR child_row->>'status' IS DISTINCT FROM 'queued' OR child_row->>'trigger_type' IS DISTINCT FROM ${trigger}
      OR child_row->>'project_no' IS DISTINCT FROM parent_row->>'project_no' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_DENIED';
    END IF;
    ${dates ? `IF NEW.date_parent_request_id IS NOT NULL AND __SCHEMA__.automation_read_date_retry_origin_valid(
      NEW.request_id,NEW.grant_id,NEW.parent_request_id,NEW.date_parent_request_id,NEW.tenant_id,NEW.owner_id) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_DENIED';
    END IF;` : ''}
    NEW.created_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END $function$;`
}

/** Existing trigger remains deferred and attached to child grant transitions. */
function required(dates: boolean): string {
  const trigger = dates ? "(CASE WHEN link_row->>'date_parent_request_id' IS NULL THEN 'manual' ELSE 'schedule' END)" : "'manual'"
  return `CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_retry_grant_link_required() RETURNS TRIGGER
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
      OR child_row->>'trigger_type' IS DISTINCT FROM ${trigger} OR parent_row->>'trigger_type' IS DISTINCT FROM ${trigger}
      ${dates ? `OR grant_row->'triggers' IS DISTINCT FROM pg_catalog.jsonb_build_array(${trigger})` : ''}
      OR child_row->>'project_no' IS DISTINCT FROM parent_row->>'project_no'
      OR grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(child_row->>'project_no')) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_REQUIRED';
    END IF;
    ${dates ? `IF grant_row->>'purpose'='retry' AND link_row->>'date_parent_request_id' IS NOT NULL
      AND __SCHEMA__.automation_read_date_retry_origin_valid((link_row->>'request_id')::UUID,(grant_row->>'id')::UUID,
        (link_row->>'parent_request_id')::UUID,(link_row->>'date_parent_request_id')::UUID,
        grant_row->>'tenant_id',grant_row->>'owner_id') IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_REQUIRED';
    END IF;` : ''}
    RETURN NEW;
  END $function$;`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE ledger_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT ledger_schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      ${locks}
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.integration_automation_read_date_occurrences
          ADD CONSTRAINT automation_read_date_retry_receipt_scope UNIQUE(request_id,tenant_id,owner_id);
        ALTER TABLE __SCHEMA__.integration_automation_read_retries ADD COLUMN date_parent_request_id UUID;
        ALTER TABLE __SCHEMA__.integration_automation_read_retries ADD CONSTRAINT automation_read_date_retry_parent
          CHECK (date_parent_request_id IS NULL OR date_parent_request_id=parent_request_id);
        ALTER TABLE __SCHEMA__.integration_automation_read_retries ADD CONSTRAINT automation_read_date_retry_receipt
          FOREIGN KEY(date_parent_request_id,tenant_id,owner_id)
          REFERENCES __SCHEMA__.integration_automation_read_date_occurrences(request_id,tenant_id,owner_id) ON DELETE RESTRICT;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT automation_read_retry_grant_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT automation_read_retry_grant_shape CHECK (${dateShape});
        ${dateOrigin}
        ${admission(true)}
        ${required(true)}
        -- A separate request cannot borrow the one linked attempt under a date
        -- retry grant. This also rejects a request-side orphan at COMMIT.
        CREATE FUNCTION __SCHEMA__.automation_read_date_retry_request_required() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
        DECLARE grant_row JSONB;link_row JSONB;
        BEGIN
          EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(g),pg_catalog.to_jsonb(l)
            FROM %I.integration_automation_read_requests r JOIN %I.integration_automation_read_grants g ON g.id=r.grant_id
            LEFT JOIN %I.integration_automation_read_retries l ON l.request_id=r.id AND l.grant_id=g.id WHERE r.id=$1',
            TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO grant_row,link_row USING NEW.id;
          IF grant_row->>'purpose'='retry' AND grant_row->'triggers'='["schedule"]'::JSONB AND (
            link_row IS NULL OR link_row->>'date_parent_request_id' IS NULL
            OR __SCHEMA__.automation_read_date_retry_origin_valid(NEW.id,(grant_row->>'id')::UUID,
              (link_row->>'parent_request_id')::UUID,(link_row->>'date_parent_request_id')::UUID,
              grant_row->>'tenant_id',grant_row->>'owner_id') IS NOT TRUE) THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_READ_RETRY_LINK_REQUIRED';
          END IF;
          RETURN NEW;
        END $function$;
        CREATE CONSTRAINT TRIGGER automation_read_date_retry_request_required
          AFTER INSERT OR UPDATE ON __SCHEMA__.integration_automation_read_requests
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.automation_read_date_retry_request_required();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema));
    END $migration$;`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE ledger_schema TEXT;history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT ledger_schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass;
      ${locks}
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.integration_automation_read_retries WHERE date_parent_request_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM %I.integration_automation_read_grants WHERE purpose=''retry'' AND triggers IS DISTINCT FROM ARRAY[''manual'']::TEXT[])',
        ledger_schema,ledger_schema) INTO history;
      IF history THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_READ_DATE_RETRY_HAS_HISTORY';END IF;
      EXECUTE pg_catalog.replace($ddl$
        ${admission(false)}
        ${required(false)}
        DROP TRIGGER automation_read_date_retry_request_required ON __SCHEMA__.integration_automation_read_requests;
        DROP FUNCTION __SCHEMA__.automation_read_date_retry_request_required();
        DROP FUNCTION __SCHEMA__.automation_read_date_retry_origin_valid(UUID,UUID,UUID,UUID,TEXT,TEXT);
        ALTER TABLE __SCHEMA__.integration_automation_read_grants DROP CONSTRAINT automation_read_retry_grant_shape;
        ALTER TABLE __SCHEMA__.integration_automation_read_grants ADD CONSTRAINT automation_read_retry_grant_shape CHECK (${manualShape});
        ALTER TABLE __SCHEMA__.integration_automation_read_retries DROP CONSTRAINT automation_read_date_retry_receipt;
        ALTER TABLE __SCHEMA__.integration_automation_read_retries DROP CONSTRAINT automation_read_date_retry_parent;
        ALTER TABLE __SCHEMA__.integration_automation_read_retries DROP COLUMN date_parent_request_id;
        ALTER TABLE __SCHEMA__.integration_automation_read_date_occurrences DROP CONSTRAINT automation_read_date_retry_receipt_scope;
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema));
    END $migration$;`).execute(db)
}
