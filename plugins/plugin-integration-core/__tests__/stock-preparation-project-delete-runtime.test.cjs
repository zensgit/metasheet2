'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { planRuntime, deleteRuntime, runtimeFenceKeys } = require('../lib/stock-preparation-project-delete-runtime.cjs')
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

test('confirmation pins exactly the selected KV rows, including old trial envelopes', async () => {
  for (const confirming of [false, true]) {
    await planRuntime({ query: async (sql) => {
      if (sql.startsWith('SELECT EXISTS')) return [{ present: false }]
      assert.equal(sql.includes('FOR UPDATE OF kv NOWAIT'), confirming)
      return []
    } }, scope, sheets, confirming)
  }
})

test('runtime keys use producer encodings and isolate shared policy and token writers', () => {
  const { createHash } = require('node:crypto')
  const { projectDeleteDedicatedSheetId } = require('../lib/stock-preparation-project-delete-sheets.cjs')
  const { __internals: policy } = require('../lib/stock-preparation-conflict-policies.cjs')
  const { __internals: jobs } = require('../lib/stock-preparation-dry-run-jobs.cjs')
  const { deriveStockPreparationProjectSheetObjectId } = require('../lib/stock-preparation-own-base.cjs')
  const { PLM_STOCK_PREPARATION_ACTION_ID: actionId } = require('../lib/stock-preparation-table-actions.cjs')
  const exclusive = projectDeleteDedicatedSheetId(scope)
  const target = { sheetId: exclusive, objectId: deriveStockPreparationProjectSheetObjectId(scope.tenantId, scope.projectNo), keyField: 'idempotencyKey' }
  const boundTarget = { sheetId: exclusive, objectId: 'another-config', keyField: 'old-field' }
  const params = createHash('sha256').update(JSON.stringify({ projectNo: scope.projectNo })).digest('hex')
  const common = ['trial-target:' + jobs.dryRunJobTargetKey({ ...scope, actionId }), 'runtime-project:' + JSON.stringify([scope.tenantId, scope.projectNo])]
  const shared = 'trial-token:' + sheetWriteScopeKey('shared') + ':' + params
  assert.deepEqual(runtimeFenceKeys({ ...scope, boundTarget }, ['shared', exclusive]), [
    ...common, shared, 'trial-token:' + sheetWriteScopeKey(exclusive) + ':' + params, 'trial-token-sheet:' + sheetWriteScopeKey(exclusive),
    ...[target, boundTarget].flatMap(target => [
      'policy:' + policy.conflictPolicyStoreKey({ actionId, target }), 'policy-fp:' + policy.targetScopeFingerprint({ actionId, target }),
    ]),
  ])
  assert.deepEqual(runtimeFenceKeys({ ...scope, boundTarget: { ...boundTarget, sheetId: 'shared' } }, ['shared']), [...common, shared])
})

test('table-scope reviews use only the exact dedicated target keys and reject a contradictory envelope', async () => {
  const { __internals: policy } = require('../lib/stock-preparation-conflict-policies.cjs')
  const { PLM_STOCK_PREPARATION_ACTION_ID: actionId } = require('../lib/stock-preparation-table-actions.cjs')
  const { deriveStockPreparationProjectSheetObjectId } = require('../lib/stock-preparation-own-base.cjs')
  const objectId = deriveStockPreparationProjectSheetObjectId(scope.tenantId, scope.projectNo)
  const active = { sheetId: 'own', objectId, keyField: 'idempotencyKey' }
  const alias = { sheetId: 'own', objectId: 'former-binding', keyField: 'alternateKey' }
  const key = target => policy.conflictPolicyStoreKey({ actionId, target })
  const stamp = target => policy.targetScopeFingerprint({ actionId, target })
  async function plan(boundTarget, targets, selected, dedicated = sheets) {
    return planRuntime({ query: async (sql, params) => {
      if (sql.startsWith('SELECT EXISTS')) return [{ present: false }]
      assert.equal(params[16], policy.STORAGE_PREFIX)
      assert.deepEqual(params[17], targets.map(key))
      assert.deepEqual(params[18], targets.map(stamp))
      return selected
    } }, { ...scope, boundTarget }, dedicated)
  }
  const owned = { kind: 'policy', key: key(active), policy_payload_matches: true, fingerprint: '1' }
  const before = await plan(alias, [active, alias], [owned])
  const changed = await plan(alias, [active, alias], [{ ...owned, fingerprint: '2' }])
  assert.notEqual(before.fingerprint, changed.fingerprint)
  assert.deepEqual(before.keys, [key(active)])
  assert.deepEqual((await plan({ ...alias, sheetId: 'shared' }, [active], [owned])).counts, { runtimeRecords: 1 })
  assert.deepEqual((await plan(alias, [], [], { dedicatedSheetId: null, ownedTargetSheetIds: ['shared'] })).keys, [])
  for (const row of [{ ...owned, policy_payload_matches: false }, { ...owned, key: key({ ...active, sheetId: 'neighbor' }) }]) {
    await assert.rejects(plan(alias, [active, alias], [row]), { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS' })
  }
})
