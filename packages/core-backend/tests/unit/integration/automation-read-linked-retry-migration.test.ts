/** SQL emission only; actual constraint/commit behavior belongs to the real-PG suite. */
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { describe, expect, it } from 'vitest'
import { up, down } from '../../../src/db/migrations/zzzz20261002142000_automation_read_linked_retry'

async function capture(migrate: typeof up) {
  const statements: string[] = []
  const client: PostgresPoolClient = {
    query: (async (statement: string) => {
      statements.push(statement)
      return { rows: [], command: 'SELECT' as const, rowCount: 0 }
    }) as unknown as PostgresPoolClient['query'], release() {},
  }
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: {
    async connect() { return client }, async end() {},
  } }) })
  try { await migrate(db); expect(statements).toHaveLength(1); return statements[0] }
  finally { await db.destroy() }
}

describe('linked retry migration — emitted SQL only', () => {
  it('adds a closed manual single-project single-execution purpose without upgrading history', async () => {
    const ddl = await capture(up)
    expect(ddl).toContain("purpose IN ('standalone','automatic','retry')")
    expect(ddl).toContain("triggers=ARRAY['manual']::TEXT[] AND max_executions=1")
    expect(ddl).toContain('cardinality(projects)=1 AND array_ndims(projects)=1 AND array_lower(projects,1)=1')
    expect(ddl).toContain(')) IS TRUE)')
    expect(ddl).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+__SCHEMA__\.integration_automation_read_/u)
  })
  it('limits each parent to one child and each owner/key to one frozen consent', async () => {
    const ddl = await capture(up)
    expect(ddl).toContain('request_id UUID PRIMARY KEY REFERENCES')
    expect(ddl).toContain('grant_id UUID NOT NULL UNIQUE')
    expect(ddl).toContain('parent_request_id UUID NOT NULL UNIQUE REFERENCES')
    expect(ddl).toContain('UNIQUE (tenant_id,owner_id,retry_key)')
    expect(ddl).toContain('CHECK (acknowledge_new_read IS TRUE)')
    expect(ddl).toContain('CHECK (request_id<>parent_request_id)')
    expect(ddl.match(/ON DELETE RESTRICT/gu)).toHaveLength(3)
  })
  it('requires actual same-transaction child writes and exact frozen parent scope', async () => {
    const ddl = await capture(up)
    for (const guard of ['new_child IS DISTINCT FROM TRUE', 'new_grant IS DISTINCT FROM TRUE',
      "parent_row->>'status' NOT IN ('blocked','failed','cancelled','outcome_unknown')",
      "parent_row->>'trigger_type' IS DISTINCT FROM 'manual'",
      "child_grant->'source_reference' IS DISTINCT FROM parent_grant->'source_reference'",
      "child_grant->>'authority_key' IS DISTINCT FROM parent_grant->>'authority_key'",
      "child_row->>'project_no' IS DISTINCT FROM parent_row->>'project_no'",
      "child_row->>'status' IS DISTINCT FROM 'queued'"]) expect(ddl).toContain(guard)
    expect(ddl).not.toContain("parent_grant->>'status' IS DISTINCT FROM 'active'")
  })
  it('orders parent grant before locked parent request and uses NOWAIT', async () => {
    const ddl = await capture(up)
    const grant = ddl.indexOf('integration_automation_read_grants g WHERE id=$1 FOR UPDATE NOWAIT')
    const request = ddl.indexOf('integration_automation_read_requests p WHERE id=$1 FOR UPDATE NOWAIT')
    expect(grant).toBeGreaterThan(0)
    expect(request).toBeGreaterThan(grant)
    expect(ddl).toContain('FOR SHARE NOWAIT')
  })
  it('rejects orphan retry grants at commit and freezes links and both request identities', async () => {
    const ddl = await capture(up)
    expect(ddl).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(ddl).toContain("WHEN (NEW.purpose='retry')")
    expect(ddl).toContain('AUTOMATION_READ_RETRY_LINK_REQUIRED')
    expect(ddl).toContain('BEFORE UPDATE OR DELETE ON __SCHEMA__.integration_automation_read_retries')
    expect(ddl).toContain('BEFORE TRUNCATE ON __SCHEMA__.integration_automation_read_retries')
    expect(ddl).toContain('WHERE request_id=$1 OR parent_request_id=$1')
    expect(ddl).toContain("pg_catalog.to_jsonb(NEW)-ARRAY['status','used_executions','updated_at']")
  })
  it.each([up, down])('qualifies every table/function in the resolved ledger schema', async migrate => {
    const ddl = await capture(migrate)
    expect(ddl).toContain("c.oid='integration_automation_read_grants'::pg_catalog.regclass")
    expect(ddl).toContain("$ddl$,'__SCHEMA__',pg_catalog.quote_ident(ledger_schema))")
    if (migrate === up) expect(ddl).toContain('LANGUAGE plpgsql SET search_path=pg_catalog')
  })
  it('refuses rollback with retained history before restoring the old purpose check', async () => {
    const ddl = await capture(down)
    expect(ddl.indexOf('IF history THEN')).toBeLessThan(ddl.indexOf('DROP TABLE'))
    expect(ddl).toContain('AUTOMATION_READ_RETRY_HAS_HISTORY')
    expect(ddl).toContain("WHERE purpose=''retry''")
    expect(ddl).toContain("CHECK (purpose IN ('standalone','automatic'))")
    expect(ddl).not.toContain('DELETE FROM')
    expect(ddl).not.toContain('TRUNCATE ')
  })
})
