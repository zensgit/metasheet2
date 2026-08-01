import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const servicePath = 'packages/core-backend/src/services/AttendanceLegacyMembershipOverlapAudit.ts'
const cliPath = 'scripts/ops/attendance-legacy-membership-overlap-audit.ts'
const realDbPath = 'tests/integration/attendance-legacy-membership-overlap-audit.db.test.ts'
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs')

test('legacy membership audit stays SELECT-only and wired into required CI', async () => {
  const [service, cli, workflow, vitest] = await Promise.all([
    readFile(servicePath, 'utf8'),
    readFile(cliPath, 'utf8'),
    readFile('.github/workflows/plugin-tests.yml', 'utf8'),
    readFile('packages/core-backend/vitest.config.ts', 'utf8'),
  ])

  assert.match(service, /WHERE m\.org_id = \$1/)
  assert.match(service, /LEFT JOIN attendance_groups g/)
  assert.match(service, /information_schema\.columns/)
  assert.doesNotMatch(service, /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i)
  assert.match(cli, /auditAttendanceLegacyMembershipOverlaps/)
  assert.match(cli, /manifest\.zeroConflicts \? 0 : 4/)
  assert.match(workflow, new RegExp(realDbPath.replaceAll('.', '\\.')))
  assert.match(workflow, /attendance-legacy-membership-overlap-audit\.test\.ts/)
  assert.match(vitest, new RegExp(realDbPath.replaceAll('.', '\\.')))
})

test('legacy membership audit CLI fails closed when org is absent', () => {
  const result = spawnSync(process.execPath, [tsxCli, cliPath], {
    encoding: 'utf8',
    timeout: 30_000,
  })

  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /ORG_ID_REQUIRED/)
})
