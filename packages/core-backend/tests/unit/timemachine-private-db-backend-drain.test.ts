import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../scripts/verify-recovery-manual-checkpoint.mts', import.meta.url),
  'utf8',
)

describe('manual checkpoint private-database backend drain', () => {
  it('waits for asynchronous backend exit and still fails a real leak with identity columns', () => {
    expect(source).toContain('const PRIVATE_DB_BACKEND_DRAIN_MS = 10_000')
    expect(source).toContain('await assertPrivateDatabaseBackendsExited(admin, database)')
    expect(source).toContain(
      'SELECT pid, usename, application_name, backend_type, state, query, backend_start',
    )
    expect(source).toContain('private database backends remain after')
    expect(source).not.toContain(
      "assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n, 0)",
    )
  })
})
