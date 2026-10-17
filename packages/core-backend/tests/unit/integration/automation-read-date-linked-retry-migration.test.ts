/** Emitted SQL contracts only. The owned disposable PG suite proves execution. */
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { describe, expect, it } from 'vitest'
import { up, down } from '../../../src/db/migrations/zzzz20261002144000_automation_read_date_linked_retry'
import { up as manualUp } from '../../../src/db/migrations/zzzz20261002142000_automation_read_linked_retry'

async function capture(migrate: typeof up): Promise<string> {
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

function body(statement: string, name: string): string {
  const normalized = statement.replace(`CREATE FUNCTION __SCHEMA__.${name}()`,
    `CREATE OR REPLACE FUNCTION __SCHEMA__.${name}()`)
  const start = normalized.indexOf(`CREATE OR REPLACE FUNCTION __SCHEMA__.${name}()`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = normalized.indexOf('END $function$;', start)
  expect(end).toBeGreaterThan(start)
  return normalized.slice(start, end + 'END $function$;'.length)
    .replace(/--[^\n]*\n/gu, '').replace(/\s+/gu, ' ').trim()
}

describe('date linked retry migration — emitted SQL only', () => {
  it.each(['automation_read_retry_link_admit', 'automation_read_retry_grant_link_required'])(
    'restores the exact original manual %s body on rollback', async name => {
      expect(body(await capture(down), name)).toBe(body(await capture(manualUp), name))
    },
  )

  it('adds a scoped reference to the original receipt without rewriting history', async () => {
    const ddl = await capture(up)
    expect(ddl).toContain('UNIQUE(request_id,tenant_id,owner_id)')
    expect(ddl).toContain('CHECK (date_parent_request_id IS NULL OR date_parent_request_id=parent_request_id)')
    expect(ddl).toContain('FOREIGN KEY(date_parent_request_id,tenant_id,owner_id)')
    expect(ddl).toContain('REFERENCES __SCHEMA__.integration_automation_read_date_occurrences(request_id,tenant_id,owner_id) ON DELETE RESTRICT')
    expect(ddl).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+__SCHEMA__\.integration_automation_read_/u)
    expect(ddl).not.toMatch(/DROP (?:TABLE|TRIGGER)/u)
  })

  it('observes immutable ancestors without locks or old grant liveness in worker checks', async () => {
    const ddl = await capture(up)
    const start = ddl.indexOf('CREATE FUNCTION __SCHEMA__.automation_read_date_retry_origin_valid(')
    const origin = ddl.slice(start, ddl.indexOf('$function$;', start))
    expect(origin).toContain("pg.purpose='automatic' AND pg.triggers=ARRAY['schedule']::TEXT[]")
    expect(origin).toContain("a.trigger_type='schedule.date_field'")
    expect(origin).not.toMatch(/FOR (?:UPDATE|SHARE)|pg\.(?:status|expires_at|used_executions)/u)
    expect(body(ddl, 'automation_read_retry_grant_link_required')).not.toMatch(/FOR (?:UPDATE|SHARE)/u)
    expect(body(ddl, 'automation_read_date_retry_request_required')).not.toMatch(/FOR (?:UPDATE|SHARE)/u)
    expect(ddl).toContain('AFTER INSERT OR UPDATE ON __SCHEMA__.integration_automation_read_requests')
  })

  it('rejects date history before rollback while retaining manual history and the original shape', async () => {
    const ddl = await capture(down)
    expect(ddl).toContain('WHERE date_parent_request_id IS NOT NULL')
    expect(ddl).toContain("purpose=''retry'' AND triggers IS DISTINCT FROM ARRAY[''manual'']::TEXT[]")
    expect(ddl.indexOf('IF history THEN')).toBeLessThan(ddl.indexOf('CREATE OR REPLACE FUNCTION'))
    expect(ddl).toContain('AUTOMATION_READ_DATE_RETRY_HAS_HISTORY')
    expect(ddl).toContain("triggers=ARRAY['manual']::TEXT[] AND max_executions=1")
    expect(ddl).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE /u)
  })
})
