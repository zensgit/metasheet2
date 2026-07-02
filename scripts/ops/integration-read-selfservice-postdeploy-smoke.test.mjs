import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSmokeConfig,
  leakScan,
  recordsOnlyTargets,
  formatSummaryBlock,
} from './integration-read-selfservice-postdeploy-smoke.mjs'

test('buildSmokeConfig list_page: S1 shape, salted targets, no keyField', () => {
  const config = buildSmokeConfig({
    systemId: 'sys_1',
    systemKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'list_page',
    readPath: '/K3API/Material/GetList',
    keyField: 'FNumber',
    containerPaths: 'Data.Data, Data.DATA',
    salt: 't123',
  })
  assert.equal(config.mode, 'list_page')
  assert.equal(config.keyField, undefined, 'list_page must not carry keyField')
  assert.deepEqual(config.containerPaths, ['Data.Data', 'Data.DATA'])
  assert.deepEqual(config.operations, ['read'])
  assert.deepEqual(config.fieldMap, [
    { source: 'FNumber', target: 'smoke_a_t123' },
    { source: 'FName', target: 'smoke_b_t123' },
  ])
})

test('buildSmokeConfig single_record carries keyField', () => {
  const config = buildSmokeConfig({
    systemId: 'sys_1',
    systemKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'single_record',
    readPath: '/K3API/Material/GetDetail',
    keyField: 'FNumber',
    containerPaths: 'Data',
    salt: 't123',
  })
  assert.equal(config.keyField, 'FNumber')
  assert.deepEqual(config.containerPaths, ['Data'])
})

test('leakScan flags embedded sentinels and ignores empty ones', () => {
  assert.equal(leakScan({ a: 'clean evidence' }, ['M-001', '', undefined]), true)
  assert.equal(leakScan({ a: 'contains M-001 value' }, ['M-001']), false)
  assert.equal(leakScan({ nested: { deep: ['smoke_a_t1'] } }, ['smoke_a_t1']), false)
})

test('recordsOnlyTargets accepts salted targets only', () => {
  assert.equal(recordsOnlyTargets([{ smoke_a_t1: 'x', smoke_b_t1: null }], 't1'), true)
  assert.equal(recordsOnlyTargets([{ smoke_a_t1: 'x', FUnclassified: 'leak' }], 't1'), false)
  assert.equal(recordsOnlyTargets([], 't1'), true)
})

test('formatSummaryBlock is a flat values-free key=value block', () => {
  const block = formatSummaryBlock({ pass: true, probeRecordCount: 3 })
  assert.equal(block.split('\n')[0], 'EXTERNAL_API_READ_SELF_SERVICE_POSTDEPLOY_SMOKE')
  assert.ok(block.includes('pass=true'))
  assert.ok(block.includes('probeRecordCount=3'))
})
