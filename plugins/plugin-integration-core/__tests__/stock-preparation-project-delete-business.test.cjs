'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { planBusiness, deleteBusiness } = require('../lib/stock-preparation-project-delete-business.cjs')
const { sheetWriteScopeKey } = require('../lib/stock-preparation-project-write-lock.cjs')

const scope = { tenantId: 'business-fixture', projectNo: 'synthetic' }
const sheets = { ownedTargetSheetIds: ['shared-fixture'], dedicatedSheetId: null, tables: [], identityPresent: true }
const category = (overrides) => ({ category: 'handoffs', n: 1, digest: 'synthetic-hash', ...overrides })

// The real DB host runs the SQL and its FK/ownership cases. Here exercise the
// independent JS refusal boundaries and verify no business payload crosses them.
function snapshot({ rows = [category()], invalid = false, lock = {} } = {}) {
  const answers = [rows, [{ invalid }], [{ digest: 'synthetic-lock-hash', ...lock }]]
  return {
    async query() {
      assert.ok(answers.length)
      return answers.shift()
    },
  }
}

test('refuses each ownership and activity conflict before any mutation', async () => {
  for (const [reason, input] of [
    ['AMBIGUOUS', { rows: [category({ ambiguous: true })] }],
    ['BUSY', { rows: [category({ busy: true })] }],
    ['AMBIGUOUS', { invalid: true }],
    ['AMBIGUOUS', { lock: { ambiguous: true } }],
    ['BUSY', { lock: { busy: true } }],
  ]) {
    const code = 'STOCK_PREPARATION_PROJECT_DELETE_' + reason
    await assert.rejects(planBusiness(snapshot(input), scope, sheets), { status: 409, code, message: code })
  }
  await assert.rejects(planBusiness(snapshot(), scope, { ...sheets, identityPresent: false }), {
    code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS',
  })
})

test('binds business contents, write generation and only affected targets to the plan', async () => {
  const initial = await planBusiness(snapshot(), scope, sheets)
  assert.deepEqual(initial.counts, { handoffs: 1 })
  assert.deepEqual(initial.fenceKeys, [])
  const changed = await planBusiness(snapshot({ rows: [category({ digest: 'edited' })] }), scope, sheets)
  const newLock = await planBusiness(snapshot({ lock: { digest: 'another-generation' } }), scope, sheets)
  assert.deepEqual(initial.counts, changed.counts)
  assert.notEqual(initial.fingerprint, changed.fingerprint)
  assert.notEqual(initial.fingerprint, newLock.fingerprint)
  const targets = await planBusiness(snapshot(), scope, {
    ...sheets, ownedTargetSheetIds: ['dedicated', 'affected', 'unrelated'], dedicatedSheetId: 'dedicated',
    tables: [{ sheetId: 'dedicated' }, { sheetId: 'affected' }, { sheetId: 'overview' }],
  })
  assert.deepEqual(targets.fenceKeys, ['affected', 'dedicated'].map(sheetWriteScopeKey).sort())
})

test('refuses divergence between planned and physically deleted counts', async () => {
  const plan = await planBusiness(snapshot(), scope, sheets)
  const counts = {
    sheetRepairClaims: 0, sheetRepairRuns: 0, refreshIntents: 0, pullBatchExecutions: 0, pullBatches: 0,
    pullBatchSheets: 0, reviewedCells: 0, changePlans: 0, refreshHolds: 0, refreshStates: 0, refreshExecutions: 0,
    continuationMembers: 0, continuations: 0, componentRulings: 0, handoffs: 1, packInstalls: 0, reconcileLeases: 0,
  }
  const tx = {
    async query(sql, params) {
      assert.match(sql, /DELETE FROM integration_stock_prep_handoff WHERE tenant_id = \$1 AND project_no = \$2/)
      assert.deepEqual(params, [scope.tenantId, scope.projectNo])
      return [{ n: 0 }]
    },
  }
  await assert.rejects(deleteBusiness(tx, scope, { ...plan, counts }), { code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE' })
})
