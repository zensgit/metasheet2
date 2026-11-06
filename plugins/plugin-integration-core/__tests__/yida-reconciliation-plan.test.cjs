'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

// R-71 ⑦.5 cut-over reconciliation, pure layer (RC2-RC5). Synthetic values only; no IO.
const lib = (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)
const planPromise = lib('yida-reconciliation-plan.mjs')
const plannerPromise = lib('yida-static-plan.mjs')
const compilerPromise = lib('yida-draft-plan.mjs')
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const V2 = read(path.join(__dirname, '..', '..', '..', 'docs', 'development', 'takeover-beiliao-20260821', 'yida-legacy-templates', 'material.json'))
const V3 = read(path.join(__dirname, '..', 'fixtures', 'yida-rule-templates', 'material-v3.json'))
const TARGET = Object.freeze({ appType: 'synthetic_slot_app', formUuid: 'synthetic_slot_form' })
const SEVEN = ['project', 'drawingNo', 'partName', 'specification', 'materialGrade', 'versionNo', 'parentDrawingNo']
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

async function sealedKeyDefinition() {
  const { createYidaTransformExample } = await plannerPromise
  const { compileYidaSendDraft } = await compilerPromise
  const allocation = { ...V2.allocation, projects: ['DEMO-P1', 'DEMO-P2'] }
  return compileYidaSendDraft({ config: { ...V2.rules, target: TARGET }, rowsText: createYidaTransformExample().text, allocation }).keyDefinition
}

// Every combination of the two empty-allowed keys: non-empty / '' / null / absent.
function rowsFor() {
  const variants = [['S-1'], [''], [null], []]
  const rows = []
  let index = 0
  for (const spec of variants) {
    for (const parent of variants) {
      const row = { projectNo: 'DEMO-P1', componentCode: `DRW-${index}`, componentName: 'Synthetic part',
        material: 'Q235', sourceVersion: 'A', totalQuantity: 2, idempotencyKey: `line-${index}` }
      if (spec.length) row.componentSpec = spec[0]
      if (parent.length) row.parentComponentCode = parent[0]
      rows.push(row)
      index += 1
    }
  }
  return rows
}

test('RC1: the shared business-key helper is exactly the planner string for v2 and v3', async () => {
  const { buildYidaStaticPlan, yidaProtocolBusinessKey } = await plannerPromise
  // The literal v2 golden (sorted by target name, empty-allowed keys folded to '').
  const golden = JSON.stringify(['yida-protocol-v2', 'synthetic_slot_app', 'synthetic_slot_form', [
    ['drawingNo', 'string', 'DRW-15'], ['materialGrade', 'string', 'Q235'], ['parentDrawingNo', 'string', ''],
    ['partName', 'string', 'Synthetic part'], ['project', 'string', 'DEMO-P1'], ['specification', 'string', ''],
    ['versionNo', 'string', 'A']]])
  for (const rules of [V2.rules, V3.rules]) {
    const plan = buildYidaStaticPlan({ config: { ...rules, target: TARGET }, rows: rowsFor() })
    assert.equal(plan.rows[15].localBusinessKey, golden)
  }
  // Unsorted input pairs are sorted by the helper itself.
  assert.equal(yidaProtocolBusinessKey(TARGET, [['b', 'string', '2'], ['a', 'string', '1']]),
    JSON.stringify(['yida-protocol-v2', TARGET.appType, TARGET.formUuid, [['a', 'string', '1'], ['b', 'string', '2']]]))
})

test('RC2: a remote record derived from a planned row has the send path digest (v2 and v3, all empty-key combinations)', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const { yidaObservedBusinessKey } = await planPromise
  const keyDefinition = await sealedKeyDefinition()
  assert.deepEqual(keyDefinition.fields.map(field => field.target).sort(), [...SEVEN].sort())
  let compared = 0
  for (const rules of [V2.rules, V3.rules]) {
    const plan = buildYidaStaticPlan({ config: { ...rules, target: TARGET }, rows: rowsFor() })
    assert.equal(plan.rows.length, 16)
    for (const planned of plan.rows) {
      assert.equal(planned.status, 'planned_create')
      const observed = yidaObservedBusinessKey({ locator: TARGET, keyDefinition, formData: { ...planned.payload } })
      assert.equal(observed.comparable, true)
      assert.equal(observed.businessKeyDigest, sha256(planned.localBusinessKey))
      // The remote form may report an empty optional key as '' or null instead of omitting it.
      for (const blank of ['', null]) {
        const formData = { ...planned.payload }
        for (const key of ['specification', 'parentDrawingNo']) if (!Object.hasOwn(formData, key)) formData[key] = blank
        assert.equal(yidaObservedBusinessKey({ locator: TARGET, keyDefinition, formData }).businessKeyDigest, sha256(planned.localBusinessKey))
      }
      compared += 1
    }
  }
  assert.equal(compared, 32)
  // A different value is a different digest (no normalization: case, width, surrounding text).
  const plan = buildYidaStaticPlan({ config: { ...V2.rules, target: TARGET }, rows: rowsFor() })
  const base = plan.rows[0]
  for (const drawingNo of ['drw-0', 'DRW-0 ', 'ＤＲＷ-0']) {
    const observed = yidaObservedBusinessKey({ locator: TARGET, keyDefinition, formData: { ...base.payload, drawingNo } })
    assert.notEqual(observed.businessKeyDigest, sha256(base.localBusinessKey))
  }
})

test('RC3: records no local row could ever have planned are key_unmatchable', async () => {
  const { yidaObservedBusinessKey } = await planPromise
  const keyDefinition = await sealedKeyDefinition()
  const full = { project: 'DEMO-P1', drawingNo: 'DRW-1', partName: 'Synthetic part', specification: 'S-1',
    materialGrade: 'Q235', versionNo: 'A', parentDrawingNo: 'DRW-0' }
  const unmatchable = (patch, drop = []) => {
    const formData = { ...full, ...patch }
    for (const key of drop) delete formData[key]
    return yidaObservedBusinessKey({ locator: TARGET, keyDefinition, formData }).comparable === false
  }
  assert.equal(unmatchable({}), false)
  assert.equal(unmatchable({ specification: '   ' }), true, 'whitespace-only empty-allowed key')
  assert.equal(unmatchable({ parentDrawingNo: '\t' }), true)
  for (const value of [null, '', ' ', 7, true]) assert.equal(unmatchable({ drawingNo: value }), true, `required key ${JSON.stringify(value)}`)
  assert.equal(unmatchable({}, ['versionNo']), true, 'required key absent')
  assert.equal(unmatchable({ specification: 12 }), true, 'declared string, remote number')
})

test('RC3: the local project filter is exact equality (no trim, no case folding)', async () => {
  const { yidaReconcileProjectMatches, buildYidaReconcileSearchCondition } = await planPromise
  const match = (project) => yidaReconcileProjectMatches({ formData: { project }, projectKeyTarget: 'project', projectNo: 'DEMO-P1' })
  assert.equal(match('DEMO-P1'), true)
  for (const project of ['demo-p1', 'DEMO-P1 ', 'DEMO-P10', undefined, null]) assert.equal(match(project), false)
  assert.equal(yidaReconcileProjectMatches({ formData: {}, projectKeyTarget: 'project', projectNo: 'DEMO-P1' }), false)
  assert.equal(buildYidaReconcileSearchCondition({ projectKeyTarget: 'project', projectNo: 'DEMO-P1' }),
    '[{"key":"project","value":"DEMO-P1","type":"TEXT","operator":"eq","componentName":"TextField"}]')
})

test('RC3: the run layout must be exactly the sealed seven keys with a required string project key', async () => {
  const { assertYidaReconcileLayout } = await planPromise
  const keyDefinition = await sealedKeyDefinition()
  assert.equal(assertYidaReconcileLayout({ keyDefinition, expectedKeyTargets: SEVEN, projectKeyTarget: 'project' }).length, 7)
  const conflict = (patch) => assert.throws(() => assertYidaReconcileLayout({ keyDefinition, expectedKeyTargets: SEVEN,
    projectKeyTarget: 'project', ...patch }), { code: 'YIDA_RECONCILE_PLAN_CONFLICT' })
  conflict({ expectedKeyTargets: SEVEN.slice(1) })
  conflict({ expectedKeyTargets: [...SEVEN.slice(1), 'other'] })
  conflict({ expectedKeyTargets: [...SEVEN, 'project'] })
  conflict({ projectKeyTarget: 'specification' })
  conflict({ projectKeyTarget: 'totalQty' })
})

test('RC4: the holder of the fence tuple decides the outcome, never a ledger update', async () => {
  const { classifyYidaReconcileRecord } = await planPromise
  const classify = (holder, mode = 'register') => classifyYidaReconcileRecord({ mode, holder, observedInstanceId: 'FINST-1' })
  assert.equal(classify(null), 'registered')
  assert.equal(classify(null, 'count'), 'would_register')
  assert.equal(classify({ status: 'reconciled_existing', observed_instance_id: 'FINST-1' }), 'already_reconciled')
  assert.equal(classify({ status: 'reconciled_existing', observed_instance_id: 'FINST-1' }, 'count'), 'already_reconciled')
  assert.equal(classify({ status: 'reconciled_existing', observed_instance_id: 'FINST-2' }), 'duplicate_remote')
  assert.equal(classify({ status: 'acknowledged', ack_instance_id: 'FINST-1' }), 'own_acknowledged')
  assert.equal(classify({ status: 'acknowledged', ack_instance_id: 'FINST-2' }), 'duplicate_with_own')
  assert.equal(classify({ status: 'prepared' }), 'own_in_flight')
  assert.equal(classify({ status: 'dispatching' }), 'own_in_flight')
  assert.equal(classify({ status: 'outcome_unknown' }), 'observed_for_unknown')
  assert.equal(classify({ status: 'not_sent' }), 'own_not_sent')
  assert.throws(() => classify({ status: 'other' }), { code: 'YIDA_RECONCILE_PLAN_UNAVAILABLE' })
  assert.throws(() => classifyYidaReconcileRecord({ mode: 'update', holder: null, observedInstanceId: 'FINST-1' }), { code: 'YIDA_RECONCILE_PLAN_INPUT' })
})

test('RC5: completion, total-count change and the run page budget', async () => {
  const { yidaReconcileCompletion, YIDA_RECONCILE_LIMITS } = await planPromise
  const step = (patch) => yidaReconcileCompletion({ pageNumber: 1, pageSize: 50, recordCount: 50, totalCount: 120, totalCountFirst: 120, ...patch })
  assert.deepEqual(step({}), { done: false, errorCode: null })
  assert.deepEqual(step({ recordCount: 49 }), { done: true, errorCode: null }, 'short page')
  assert.deepEqual(step({ pageNumber: 3, recordCount: 50, totalCount: 150, totalCountFirst: 150 }), { done: true, errorCode: null }, 'last page by count')
  assert.deepEqual(step({ recordCount: 10, totalCount: 121 }), { done: true, errorCode: 'TOTAL_CHANGED' })
  assert.deepEqual(step({ recordCount: 0, totalCount: 0, totalCountFirst: 0 }), { done: true, errorCode: null }, 'empty project')
  assert.deepEqual(step({ pageNumber: YIDA_RECONCILE_LIMITS.maxRunPages, totalCount: 60000, totalCountFirst: 60000 }), { done: true, errorCode: 'BUDGET' })
})
