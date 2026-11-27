'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { planRuntime, deleteRuntime } = require('../lib/stock-preparation-project-delete-runtime.cjs')
const { sheetWriteScopeKey } = require('../lib/stock-preparation-project-write-lock.cjs')

const scope = { tenantId: 'tenant-synthetic', projectNo: 'DEMO' }
const sheets = { dedicatedSheetId: 'own', ownedTargetSheetIds: ['shared', 'own'] }

function reader(rows, legacy = []) {
  return {
    async query(sql, params) {
      if (sql.startsWith('SELECT EXISTS')) return [{ present: legacy.length > 0 }]
      if (sql.includes('WITH candidates AS')) return legacy
      assert.deepEqual(params[7], ['own'])
      assert.deepEqual(params[8], ['shared'])
      assert.deepEqual(params[11], [sheetWriteScopeKey('own')])
      assert.deepEqual(params[12], [sheetWriteScopeKey('shared')])
      return rows
    },
  }
}

test('only proven keys are deleted, and edits with identical counts invalidate the inventory', async () => {
  const result = { key: 'trial-result', kind: 'trial', status: 'succeeded', fingerprint: 'a', version: '1', ambiguous: false }
  const before = await planRuntime(reader([result]), scope, sheets)
  const after = await planRuntime(reader([{ ...result, version: '2' }]), scope, sheets)
  assert.deepEqual(before.counts, { runtimeRecords: 1 })
  assert.notEqual(before.fingerprint, after.fingerprint)
  assert.deepEqual(before.keys, ['trial-result'])
  await deleteRuntime({ query: async (sql, params) => {
    assert.match(sql, /WHERE plugin = \$1 AND key = ANY/)
    assert.deepEqual(params, ['plugin-integration-core', ['trial-result']])
    return [{}]
  } }, scope, before)
  await assert.rejects(deleteRuntime({ query: async () => [] }, scope, before), { code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE' })
})

test('ambiguous legacy keys, contradictory jobs, unknown and resumable states all refuse deletion', async () => {
  const fails = (tx, suffix) => assert.rejects(planRuntime(tx, scope, sheets), {
    status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_' + suffix,
  })
  await fails(reader([], [{ key: 'retired', mine: null }]), 'AMBIGUOUS')
  await fails(reader([{ kind: 'background', status: 'completed', ambiguous: true }]), 'AMBIGUOUS')
  for (const [kind, status] of [['trial', 'running'], ['checkpoint', 'failed'], ['checkpoint', 'new_state'], ['background', 'paused']]) {
    await fails(reader([{ kind, status }]), 'BUSY')
  }
})
