#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const migrationPath = path.join(rootDir, 'packages/core-backend/src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships.ts')
const servicePath = path.join(rootDir, 'packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts')
const routePath = path.join(rootDir, 'packages/core-backend/src/routes/attendance-admin.ts')
const configPath = path.join(rootDir, 'packages/core-backend/vitest.config.ts')
const workflowPath = path.join(rootDir, '.github/workflows/plugin-tests.yml')
const openapiPath = path.join(rootDir, 'packages/openapi/src/paths/attendance.yml')
const dbTestPath = path.join(
  rootDir,
  'packages/core-backend/tests/integration/attendance-calculation-group-membership-w1.db.test.ts',
)

function read(filePath) {
  assert.ok(fs.existsSync(filePath), `missing contract file: ${filePath}`)
  return fs.readFileSync(filePath, 'utf8')
}

test('W1 migration creates an inclusive database overlap invariant without legacy dual writes', () => {
  const source = read(migrationPath)
  assert.match(source, /CREATE TABLE IF NOT EXISTS attendance_calculation_group_memberships/)
  assert.match(source, /EXCLUDE USING gist/)
  assert.match(source, /daterange\([\s\S]*'\[\]'/)
  assert.match(source, /attendance_calc_group_membership_group_org_fk/)
  assert.match(source, /attendance_calc_group_membership_user_org_required/)
  assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+attendance_group_members\b/i)
  assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+attendance_schedule_group_members\b/i)
  assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+user_orgs\b/i)
})

test('W1 service has only timeline/operation writes and no calculation-chain or org-membership cutover', () => {
  const source = read(servicePath)
  assert.match(source, /attendance-calc-operation/)
  assert.match(source, /attendance-calc-timeline/)
  assert.match(source, /effective_to = \(\$3::date - 1\)/)
  assert.match(source, /attendance_calculation_group_membership_operations/)
  assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+user_orgs\b/i)
  assert.doesNotMatch(source, /attendance_group_members\b/)
  assert.doesNotMatch(source, /attendance_schedule_group_members\b/)
  assert.doesNotMatch(source, /attendance_records\b/)
  const timelineLock = source.indexOf('const timelineResult = await runQuery(')
  const lifecycleLock = source.indexOf('const activeUser = await runQuery(')
  assert.ok(timelineLock >= 0, 'missing membership timeline lock')
  assert.ok(lifecycleLock > timelineLock, 'lifecycle rows must be locked after membership timeline rows')
})

test('both admin endpoints authorize org membership before timeline service access', () => {
  const source = read(routePath)
  for (const [startNeedle, serviceNeedle] of [
    ["r.get('/api/attendance-admin/calculation-group-memberships'", 'listAttendanceCalculationGroupMemberships(orgId, targetUserId)'],
    ["r.post('/api/attendance-admin/calculation-group-memberships/transition'", 'transitionAttendanceCalculationGroupMembership({'],
  ]) {
    const start = source.indexOf(startNeedle)
    const service = source.indexOf(serviceNeedle, start)
    const authorization = source.indexOf('canReadAttendanceDirectoryReadiness(req, actorId, orgId)', start)
    assert.ok(start >= 0, `missing route: ${startNeedle}`)
    assert.ok(authorization > start, `missing authorization in ${startNeedle}`)
    assert.ok(service > authorization, `timeline service precedes authorization in ${startNeedle}`)
  }
})

test('real-DB W1 suite has both skip-green exclusion and explicit CI execution points', () => {
  const fileName = 'attendance-calculation-group-membership-w1.db.test.ts'
  assert.match(read(configPath), new RegExp(fileName.replaceAll('.', '\\.')))
  assert.match(read(workflowPath), new RegExp(fileName.replaceAll('.', '\\.')))
  const source = read(dbTestPath)
  assert.match(source, /membershipMigrationDown\(db\)/)
  assert.match(source, /membershipMigrationUp\(db\)/)
  assert.match(source, /pg_stat_activity/)
  assert.match(source, /toUpperCase\(\)/)
  assert.match(source, /listAttendanceCalculationGroupMemberships\(orgA, uuidUserId\)/)
  assert.match(source, /uses one lock order for a direct semantic update racing a service transition/)
})

test('OpenAPI exposes list and transition only, with no delete or replace-all path', () => {
  const source = read(openapiPath)
  const listPath = source.indexOf('/api/attendance-admin/calculation-group-memberships:')
  const transitionPath = source.indexOf('/api/attendance-admin/calculation-group-memberships/transition:')
  const nextAttendancePath = source.indexOf('/api/attendance/groups:', transitionPath)
  assert.ok(listPath >= 0 && transitionPath > listPath && nextAttendancePath > transitionPath)
  const surface = source.slice(listPath, nextAttendancePath)
  assert.match(surface, /\n    get:/)
  assert.match(surface, /\n    post:/)
  assert.doesNotMatch(surface, /\n    (?:put|patch|delete):/)
  assert.match(surface, /required: \[orgId, userId, targetGroupId, effectiveOn, reason\]/)
})
