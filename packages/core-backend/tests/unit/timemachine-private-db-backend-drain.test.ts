import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PRIVATE_DB_BACKEND_CENSUS_SQL } from '../../scripts/private-db-backend-drain.ts'

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const script = readFileSync(join(backendRoot, 'scripts/verify-recovery-manual-checkpoint.mts'), 'utf8')
const workflow = readFileSync(join(backendRoot, '../../.github/workflows/plugin-tests.yml'), 'utf8')
const unitConfig = readFileSync(join(backendRoot, 'vitest.config.ts'), 'utf8')

describe('manual checkpoint private-database backend drain', () => {
  it('guards the checkpoint call site and the values-free census columns', () => {
    expect(script).toContain('assertPrivateDatabaseBackendsExited(admin, database)')
    expect(script).not.toContain(
      "assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n, 0)",
    )
    expect(script).not.toContain('usename')
    expect(script).not.toContain('backend_start')
    expect(PRIVATE_DB_BACKEND_CENSUS_SQL).toBe(
      'SELECT pid, application_name, backend_type, state, backend_start FROM pg_stat_activity WHERE datname = $1 ORDER BY pid',
    )
    expect(PRIVATE_DB_BACKEND_CENSUS_SQL).not.toMatch(/\b(query|usename)\b/)
    expect(workflow).toContain('name: Run private-db backend drain proof')
    expect(workflow).toContain('tests/integration/timemachine-private-db-backend-drain.db.test.ts')
    expect(unitConfig).toContain("'tests/integration/timemachine-private-db-backend-drain.db.test.ts'")
  })
})
