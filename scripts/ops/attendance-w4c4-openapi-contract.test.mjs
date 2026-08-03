import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()
const openapi = JSON.parse(fs.readFileSync(path.join(root, 'packages/openapi/dist/openapi.json'), 'utf8'))
const sdk = fs.readFileSync(path.join(root, 'packages/openapi/dist-sdk/index.d.ts'), 'utf8')

const detailPaths = [
  '/api/attendance-admin/records/{recordId}/calculation-detail',
  '/api/attendance/records/{recordId}/calculation-detail',
]

test('W4C-4 OpenAPI carries only the three new calculation-detail/diff paths', () => {
  for (const route of detailPaths) {
    const operation = openapi.paths?.[route]?.get
    assert.ok(operation, route)
    assert.ok(operation.responses?.['200'])
    assert.ok(operation.responses?.['404'])
    assert.ok(operation.responses?.['409'])
  }
  assert.ok(openapi.paths?.['/api/attendance-admin/calculation-shadow-backlog']?.get)
  assert.equal(openapi.paths?.['/api/attendance-admin/decision-trace'], undefined)
  assert.equal(openapi.paths?.['/api/attendance/decision-trace'], undefined)
})

test('W4C-4 calculation detail and diff schemas are closed and values-safe', () => {
  const detail = openapi.components?.schemas?.AttendanceW4CalculationDetail
  assert.equal(detail?.additionalProperties, false)
  assert.deepEqual(detail?.required, ['recordId', 'calculation', 'segments', 'current'])
  const diff = openapi.components?.schemas?.AttendanceW4ShadowDiff
  assert.equal(diff?.additionalProperties, false)
  assert.equal(diff?.properties?.segmentCount?.maximum, 3)
  assert.equal(diff?.properties?.changedFields?.uniqueItems, true)
  const wire = JSON.stringify({ detail, diff, backlog: openapi.components?.schemas?.AttendanceW4ShadowBacklogItem })
  for (const prohibited of ['userId', 'punchId', 'requestId', 'shiftId', 'groupId']) {
    assert.equal(wire.includes(prohibited), false, prohibited)
  }
})

test('generated SDK contains every W4C-4 path and schema', () => {
  for (const route of [...detailPaths, '/api/attendance-admin/calculation-shadow-backlog']) {
    assert.ok(sdk.includes(route), route)
  }
  for (const schema of ['AttendanceW4CalculationDetail', 'AttendanceW4ShadowDiff', 'AttendanceW4ShadowBacklogItem']) {
    assert.ok(sdk.includes(schema), schema)
  }
})
