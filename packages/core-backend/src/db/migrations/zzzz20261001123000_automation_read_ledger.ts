import { sql, type Kysely } from 'kysely'

/**
 * Host-private, bounded Automation read authorization and request history.
 * Schema defaults are not authority: the host must prove the current owner,
 * tenant, rule/source revisions and budget in the same transaction as writes.
 * No rule FK: deleting/recreating a rule must retain old grant/request history.
 * No outbox FK: outbox retention must not delete the private execution ledger.
 * source_reference has no default/backfill or Connection FK: it must be minted
 * from the locked original Connection incarnation, and deletion retains history
 * without allowing the current system binding to invent its former source.
 * Normal migration-provider replay is tracked by its migration journal; do not
 * use IF NOT EXISTS to silently accept a preexisting, incompatible ledger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE integration_automation_read_grants (
      id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT CHECK (workspace_id IS NULL),
      owner_id TEXT NOT NULL,
      selector JSONB NOT NULL CHECK (jsonb_typeof(selector) = 'object'),
      source_reference JSONB NOT NULL,
      authority_key TEXT NOT NULL CHECK (authority_key ~ '^[a-f0-9]{64}$'),
      projects TEXT[] NOT NULL,
      triggers TEXT[] NOT NULL,
      budget JSONB NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
      expires_at TIMESTAMPTZ NOT NULL,
      max_executions INTEGER NOT NULL CHECK (max_executions > 0),
      used_executions INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT automation_read_grant_scope UNIQUE (id, tenant_id, owner_id),
      CONSTRAINT automation_read_grant_source_reference CHECK (
        jsonb_typeof(source_reference) = 'object'
        AND source_reference ?& ARRAY['connectionId', 'connectionIncarnation']
        AND source_reference - ARRAY['connectionId', 'connectionIncarnation'] = '{}'::jsonb
        AND jsonb_typeof(source_reference->'connectionId') = 'string'
        -- JavaScript canonicalReadId counts UTF-16 units, not PG code points.
        AND (length(source_reference->>'connectionId')
          + length(regexp_replace(source_reference->>'connectionId', U&'[^\\+010000-\\+10FFFF]', '', 'g'))) BETWEEN 1 AND 255
        -- Match ECMAScript trim's complete whitespace set, not btrim's default
        -- ASCII-space-only behavior. Embedded ASCII controls are rejected too.
        AND btrim(source_reference->>'connectionId',
          U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680'
          || U&'\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A'
          || U&'\\2028\\2029\\202F\\205F\\3000\\FEFF') = source_reference->>'connectionId'
        AND source_reference->>'connectionId' !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']')
        AND jsonb_typeof(source_reference->'connectionIncarnation') = 'string'
        AND source_reference->>'connectionIncarnation' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      ),
      CONSTRAINT automation_read_grant_projects CHECK (
        cardinality(projects) > 0 AND array_ndims(projects) = 1
        AND array_position(projects, NULL) IS NULL
      ),
      CONSTRAINT automation_read_grant_triggers CHECK (
        cardinality(triggers) > 0 AND array_ndims(triggers) = 1
        AND array_position(triggers, NULL) IS NULL
        AND triggers <@ ARRAY['manual', 'schedule', 'record']::TEXT[]
      ),
      CONSTRAINT automation_read_grant_usage CHECK (
        used_executions BETWEEN 0 AND max_executions
      )
    );

    CREATE TABLE integration_automation_read_requests (
      id UUID PRIMARY KEY,
      grant_id UUID NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT CHECK (workspace_id IS NULL),
      invocation_id TEXT NOT NULL,
      project_no TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'schedule', 'record')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown')
      ),
      fence UUID,
      lease_expires_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      result JSONB,
      outbox_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT automation_read_request_grant_scope FOREIGN KEY (grant_id, tenant_id, owner_id)
        REFERENCES integration_automation_read_grants (id, tenant_id, owner_id) ON DELETE RESTRICT,
      CONSTRAINT automation_read_request_invocation UNIQUE (grant_id, invocation_id),
      CONSTRAINT automation_read_request_result CHECK (
        result IS NULL OR (status = 'succeeded' AND jsonb_typeof(result) = 'object')
      ),
      CONSTRAINT automation_read_request_running CHECK (
        status <> 'running' OR (fence IS NOT NULL AND started_at IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      CONSTRAINT automation_read_request_finished CHECK (
        (status IN ('queued', 'running') AND finished_at IS NULL)
        OR (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL)
      )
    );
    CREATE INDEX idx_automation_read_request_grant_status
      ON integration_automation_read_requests (grant_id, status);
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Match host writer order, and hold both locks through the row checks/drop so
  // concurrent inserts cannot turn an empty-ledger rollback into history loss.
  await sql`
    LOCK TABLE integration_automation_read_grants IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE integration_automation_read_requests IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM integration_automation_read_grants)
        OR EXISTS (SELECT 1 FROM integration_automation_read_requests) THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'AUTOMATION_READ_LEDGER_ROLLBACK_REQUIRES_EMPTY_HISTORY';
      END IF;
    END $$;
    DROP TABLE integration_automation_read_requests;
    DROP TABLE integration_automation_read_grants;
  `.execute(db)
}
