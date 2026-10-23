'use strict'

// Batch-refresh step 4, PR-1 — the PURE pieces of the continuation pairing module (design §6.2, §6.4,
// §9.2, §10.1): relative paths, `pairSubtrees`, the seven items (A06), the three fingerprints, the
// demand-facts projection, the content-trigger list with its cold-start rule, `buildContinuationProjection`
// (cardinality), the post-condition, the input contract, `sheetMachineDigest`, `holdFingerprint`.
//
// VALUES-FREE: synthetic ids only.

const assert = require('node:assert/strict')
const path = require('node:path')

const pairing = require(path.join(__dirname, '..', 'lib', 'stock-preparation-continuation-pairing.cjs'))
const {
  CONTINUATION_ERROR_CODES,
  NON_TRIGGER_PACK_FIELD_IDS,
  assertContinuationPostCondition,
  buildContinuationProjection,
  compareSevenItems,
  contentTriggerChanges,
  contentTriggerFieldIds,
  evidenceFingerprintOf,
  holdFingerprint,
  machineBandFieldIds,
  normalizeContinuationInput,
  pairSubtrees,
  pairingFingerprintOf,
  pathTokensOf,
  projectDemandFacts,
  relativePath,
  sheetMachineDigest,
  __internals: { isColdStartExempt, expectedKeyForTokens },
} = pairing
const {
  EXISTING_ROW_RECORD_REF,
  __internals: { fieldMapForTemplate },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const F = require('./support/stock-preparation-continuation-fixtures.cjs')

const PROJECT = 'PRJ-SCC-1'
const TEMPLATE_FIELDS = fieldMapForTemplate(normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE))

const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

function sheetRow(tokens, fields = {}, ref) {
  const row = {
    projectNo: PROJECT,
    idempotencyKey: expectedKeyForTokens(PROJECT, tokens),
    componentSourceId: tokens[tokens.length - 1],
    parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null,
    path: JSON.stringify(tokens),
    depth: tokens.length - 1,
    componentCode: `${tokens[tokens.length - 1]}-CODE`,
    componentName: `${tokens[tokens.length - 1]}-NAME`,
    material: 'M-STEEL',
    sourceVersion: 'V1',
    active: true,
    ...fields,
  }
  if (ref) row[EXISTING_ROW_RECORD_REF] = Object.freeze({ id: ref, version: 1 })
  return row
}

// Old: S-001 root (order qty 10) > PART-A (edge 2) > PART-C (edge 4); new: P-001 > S-001 (edge 2) > ...
function story({ newRootTotal = 10, innerEdge = 4 } = {}) {
  const oldRows = [
    sheetRow(['S-001'], { rawQuantity: 10, totalQuantity: 10 }, 'rec_1'),
    sheetRow(['S-001', 'PART-A'], { rawQuantity: 2, totalQuantity: 20 }, 'rec_2'),
    sheetRow(['S-001', 'PART-A', 'PART-C'], { rawQuantity: 4, totalQuantity: 80 }, 'rec_3'),
  ]
  const newRows = [
    sheetRow(['P-001', 'S-001'], { rawQuantity: 2, totalQuantity: newRootTotal }),
    sheetRow(['P-001', 'S-001', 'PART-A'], { rawQuantity: 2, totalQuantity: newRootTotal * 2 }),
    sheetRow(['P-001', 'S-001', 'PART-A', 'PART-C'], { rawQuantity: innerEdge, totalQuantity: newRootTotal * 2 * innerEdge }),
  ]
  return { oldRows, newRows }
}

function pairStory(options) {
  const { oldRows, newRows } = story(options)
  return pairSubtrees({ projectNo: PROJECT, oldRootTokens: ['S-001'], newRootTokens: ['P-001', 'S-001'], oldRows, newRows })
}

// ── paths ─────────────────────────────────────────────────────────────────────────────────────────

test('relativePath / pathTokensOf: suffix after the root, [] for the root, null outside; unreadable paths are null (never a throw)', () => {
  assert.deepEqual(relativePath(['P-001', 'S-001', 'PART-A'], ['P-001', 'S-001']), ['PART-A'])
  assert.deepEqual(relativePath(['P-001', 'S-001'], ['P-001', 'S-001']), [])
  assert.equal(relativePath(['P-002', 'S-001'], ['P-001', 'S-001']), null)
  assert.deepEqual(pathTokensOf({ path: '["A","B"]' }), ['A', 'B'])
  assert.deepEqual(pathTokensOf({ path: ['A'] }), ['A'])
  for (const bad of ['not json', '[]', '[1]', '{"a":1}', undefined, null]) assert.equal(pathTokensOf({ path: bad }), null)
})

test('a descendant\'s recomputed key uses its own parent (second-to-last token), not the continuation\'s new parent', () => {
  const key = JSON.parse(expectedKeyForTokens(PROJECT, ['P-001', 'S-001', 'PART-A']))
  assert.equal(key.parentSourceId, 'S-001')
  assert.equal(JSON.parse(expectedKeyForTokens(PROJECT, ['P-001', 'S-001'])).parentSourceId, 'P-001')
  assert.equal(JSON.parse(expectedKeyForTokens(PROJECT, ['S-001'])).parentSourceId, null)
})

// ── pairing ───────────────────────────────────────────────────────────────────────────────────────

test('pairSubtrees: unique pairs by relative path + component, root first, bound to record ids and both keys', () => {
  const result = pairStory()
  assert.equal(result.ok, true)
  assert.deepEqual(result.pairs.map((pair) => pair.relativePath), [[], ['PART-A'], ['PART-A', 'PART-C']])
  assert.deepEqual(result.pairs.map((pair) => pair.oldRecordId), ['rec_1', 'rec_2', 'rec_3'])
  assert.ok(result.pairs.every((pair) => pair.oldKey !== pair.newKey))
})

test('pairSubtrees: a path on one side only, a component mismatch, a forged key, a wrong parent => structure, never repaired', () => {
  const { oldRows, newRows } = story()
  const run = (oldList, newList) => pairSubtrees({ projectNo: PROJECT, oldRootTokens: ['S-001'], newRootTokens: ['P-001', 'S-001'], oldRows: oldList, newRows: newList })
  assert.deepEqual(run(oldRows, newRows.concat([sheetRow(['P-001', 'S-001', 'PART-D'])])).problems.map((p) => p.reason), ['path_only_new'])
  assert.deepEqual(run(oldRows, newRows.slice(0, 2)).problems.map((p) => p.reason), ['path_only_old'])
  const swapped = newRows.map((row, index) => (index === 1 ? { ...row, componentSourceId: 'PART-Z' } : row))
  assert.deepEqual(run(oldRows, swapped).problems.map((p) => p.reason), ['component_mismatch'])
  const forged = newRows.map((row, index) => (index === 2 ? { ...row, idempotencyKey: row.idempotencyKey.replace('"S-001"', '"S-009"') } : row))
  assert.deepEqual(run(oldRows, forged).problems.map((p) => p.reason), ['key_mismatch'])
  const reparented = newRows.map((row, index) => (index === 1 ? { ...row, parentSourceId: 'P-001' } : row))
  assert.deepEqual(run(oldRows, reparented).problems.map((p) => p.reason), ['parent_mismatch'])
  assert.deepEqual(run(oldRows, newRows.concat([{ ...newRows[0], path: 'garbled' }])).problems.map((p) => p.reason), ['path_unreadable'])
})

test('pairSubtrees: a repeated component is paired per occurrence; two rows at ONE relative path are a multiset that never pairs with "the first" (A08)', () => {
  const { oldRows, newRows } = story()
  const twice = pairSubtrees({
    projectNo: PROJECT,
    oldRootTokens: ['S-001'],
    newRootTokens: ['P-001', 'S-001'],
    oldRows: oldRows.concat([sheetRow(['S-001', 'PART-C'], { rawQuantity: 1, totalQuantity: 10 }, 'rec_4')]),
    newRows: newRows.concat([sheetRow(['P-001', 'S-001', 'PART-C'], { rawQuantity: 1, totalQuantity: 10 })]),
  })
  assert.equal(twice.ok, true)
  assert.equal(twice.pairs.filter((pair) => pair.componentSourceId === 'PART-C').length, 2)
  const multiset = pairSubtrees({
    projectNo: PROJECT,
    oldRootTokens: ['S-001'],
    newRootTokens: ['P-001', 'S-001'],
    oldRows,
    newRows: newRows.concat([sheetRow(['P-001', 'S-001', 'PART-A'], { rawQuantity: 9, totalQuantity: 90 })]),
  })
  assert.equal(multiset.ok, false)
  assert.ok(multiset.problems.some((problem) => problem.reason === 'path_repeated_new'))
})

// ── seven items (A06) ─────────────────────────────────────────────────────────────────────────────

test('A06: old root raw = total = 10 (order qty); new root raw = 2 (edge), total = 5 x 2 = 10 => match; the edge is reported apart', () => {
  const comparison = compareSevenItems({ pairs: pairStory().pairs, templateFields: TEMPLATE_FIELDS })
  assert.equal(comparison.outcome, 'match')
  assert.equal(comparison.parentEdgeUsage, 2)
  const root = comparison.items.find((item) => item.root)
  assert.equal(root.fields.rawQuantity.status, 'excluded_root_order_quantity')
  assert.equal(root.fields.rawQuantity.old, 10)
  assert.equal(root.fields.rawQuantity.new, 2)
  assert.equal(root.fields.totalQuantity.status, 'equal')
})

test('A06: P-001 demand 6 => new root total 12 vs 10 => content_change on totalQuantity ONLY; an inner edge change is found', () => {
  const twelve = compareSevenItems({ pairs: pairStory({ newRootTotal: 12 }).pairs, templateFields: TEMPLATE_FIELDS })
  assert.equal(twelve.outcome, 'content_change')
  assert.deepEqual(twelve.differingFields, ['totalQuantity'])
  assert.equal(twelve.items.find((item) => item.root).fields.rawQuantity.status, 'excluded_root_order_quantity')
  const inner = compareSevenItems({ pairs: pairStory({ innerEdge: 5 }).pairs, templateFields: TEMPLATE_FIELDS })
  assert.equal(inner.outcome, 'content_change')
  assert.ok(inner.differingFields.includes('rawQuantity'))
  assert.notEqual(twelve.comparisonFingerprint, compareSevenItems({ pairs: pairStory().pairs, templateFields: TEMPLATE_FIELDS }).comparisonFingerprint)
})

test('seven items: a DECLARED spec slot blank on either side is incomplete, never "both empty => equal"; an undeclared one is not_compared (A11)', () => {
  const pairs = pairStory().pairs
  const declared = compareSevenItems({ pairs, templateFields: TEMPLATE_FIELDS, specSlotDeclared: true })
  assert.equal(declared.outcome, 'incomplete')
  assert.ok(declared.incompleteFields.includes('componentSpec'))
  const undeclared = compareSevenItems({ pairs, templateFields: TEMPLATE_FIELDS, specSlotDeclared: false })
  assert.equal(undeclared.outcome, 'match')
  assert.equal(undeclared.items[0].fields.componentSpec.status, 'not_compared_spec_undeclared')
  const blankName = compareSevenItems({ pairs: pairs.map((pair, index) => (index === 1 ? { ...pair, newRow: { ...pair.newRow, componentName: '' } } : pair)), templateFields: TEMPLATE_FIELDS })
  assert.equal(blankName.outcome, 'incomplete')
})

test('seven items: 图号 change with the same part id is CONTENT (Q6 content path); human columns and RUN fields never move the comparison', () => {
  const pairs = pairStory().pairs
  const base = compareSevenItems({ pairs, templateFields: TEMPLATE_FIELDS })
  const recoded = compareSevenItems({ pairs: pairs.map((pair, index) => (index === 2 ? { ...pair, newRow: { ...pair.newRow, componentCode: 'NEW-CODE' } } : pair)), templateFields: TEMPLATE_FIELDS })
  assert.equal(recoded.outcome, 'content_change')
  assert.deepEqual(recoded.differingFields, ['componentCode'])
  const noisy = compareSevenItems({
    pairs: pairs.map((pair) => ({ ...pair, oldRow: { ...pair.oldRow, notes: 'x', stockPreparationStatus: 'done', lastPlmRefreshRunId: 'run_x', lastPlmRefreshAt: '2026-01-01T00:00:00.000Z' } })),
    templateFields: TEMPLATE_FIELDS,
  })
  assert.equal(noisy.comparisonFingerprint, base.comparisonFingerprint)
  assert.equal(noisy.outcome, 'match')
  // A number read back as a string is the same value.
  const stringly = compareSevenItems({ pairs: pairs.map((pair) => ({ ...pair, oldRow: { ...pair.oldRow, totalQuantity: String(pair.oldRow.totalQuantity) } })), templateFields: TEMPLATE_FIELDS })
  assert.equal(stringly.comparisonFingerprint, base.comparisonFingerprint)
})

// ── fingerprints and demand facts ─────────────────────────────────────────────────────────────────

test('fingerprints: deterministic; the pairing fingerprint binds record ids; the evidence fingerprint ignores unrelated observations and moves on relevant ones', async () => {
  const pairs = pairStory().pairs
  const a = pairingFingerprintOf({ projectNo: PROJECT, oldRootKey: pairs[0].oldKey, newRootKey: pairs[0].newKey, pairs })
  assert.equal(a, pairingFingerprintOf({ projectNo: PROJECT, oldRootKey: pairs[0].oldKey, newRootKey: pairs[0].newKey, pairs: pairs.map((pair) => ({ ...pair })) }))
  assert.notEqual(a, pairingFingerprintOf({ projectNo: PROJECT, oldRootKey: pairs[0].oldKey, newRootKey: pairs[0].newKey, pairs: pairs.map((pair, index) => (index === 1 ? { ...pair, oldRecordId: 'rec_x' } : pair)) }))

  const base = await F.expand(F.secondPullSource())
  const unrelated = await F.expand(F.secondPullSource({ extraOrders: [{ part: 'GHOST-9', qty: 1 }] }), { allowStatuses: ['failed'] })
  const relevantChange = await F.expand(F.secondPullSource({ sLine: false }))
  const comparison = compareSevenItems({ pairs, templateFields: TEMPLATE_FIELDS })
  const factsFor = (evidence) => projectDemandFacts(evidence, { oldRootComponentSourceId: 'S-001', newParentComponentSourceId: 'P-001', memberComponentSourceIds: ['S-001', 'PART-A', 'PART-C'] })
  const fingerprint = (evidence) => evidenceFingerprintOf({ projectNo: PROJECT, pairs, comparison, demandFacts: factsFor(evidence) })
  assert.equal(fingerprint(base.demandEvidence), fingerprint(unrelated.demandEvidence), 'an unrelated incomplete line does not re-ask')
  assert.notEqual(fingerprint(base.demandEvidence), fingerprint(relevantChange.demandEvidence))
  assert.notEqual(base.demandEvidence.fingerprint, unrelated.demandEvidence.fingerprint, 'the whole-project fingerprint DID move: it is not what a continuation binds')
})

test('demand facts: classifications from the real recorder (base_dropped / base_head_absent / kept / incomplete)', async () => {
  const opts = { oldRootComponentSourceId: 'S-001', newParentComponentSourceId: 'P-001' }
  assert.equal(projectDemandFacts((await F.expand(F.secondPullSource())).demandEvidence, opts).classification, 'base_dropped')
  const absent = projectDemandFacts((await F.expand(F.secondPullSource({ sLine: false }))).demandEvidence, opts)
  assert.equal(absent.classification, 'base_head_absent')
  assert.equal(absent.oldRoot.orderHeadPresence, 'absent')
  const kept = projectDemandFacts((await F.expand(F.secondPullSource(), { rootSelection: { enabled: false } })).demandEvidence, opts)
  assert.equal(kept.classification, 'kept')
  assert.deepEqual(kept.subTokens, ['parent_before_child', 'root_selection_disabled'])
  assert.equal(kept.newParent.orderQuantity, 5)
  for (const evidence of [null, undefined, { completeness: { status: 'capture_error', reasons: ['recorder_fault'] } }, { completeness: { status: 'incomplete', reasons: ['read_failed'] }, observations: [] }]) {
    const facts = projectDemandFacts(evidence, opts)
    assert.equal(facts.classification, 'incomplete')
    assert.equal(facts.oldRoot.orderHeadPresence, 'unknown', 'an unreadable read never says "absent"')
  }
  assert.equal(projectDemandFacts(null, opts).history, 'history_unknown')
})

test('demand facts: a 总图 of the SAME component not chosen is not a base drop; a sheet-metal root is kept', async () => {
  const parts = [F.part('M-001', 'J500-00', 'MainDrawing', { SysVer: 'V1' }), F.part('SM-001', 'J500-A', 'SheetMetal')]
  const expansion = await F.expand(F.project({ orders: [{ part: 'M-001', qty: 1 }, { part: 'M-001', qty: 2 }, { part: 'SM-001', qty: 4 }], parts }))
  const same = projectDemandFacts(expansion.demandEvidence, { oldRootComponentSourceId: 'M-001', newParentComponentSourceId: null })
  assert.equal(same.classification, 'kept', 'the chosen line keeps the component; the other line of the same 总图 is never a dropped head')
  const sheetMetal = projectDemandFacts(expansion.demandEvidence, { oldRootComponentSourceId: 'SM-001', newParentComponentSourceId: null })
  assert.deepEqual(sheetMetal.subTokens, ['sheet_metal_dual'])
})

// ── content triggers (§10.1, plan §3.4 实施细则 1) ────────────────────────────────────────────────

test('trigger list: exactly the seven-item content fields on the frozen template; pack ext_ plm columns join, sort numbers / unclassified / human do not', () => {
  assert.deepEqual(contentTriggerFieldIds({}), ['componentCode', 'componentName', 'componentSpec', 'material', 'sourceVersion', 'rawQuantity', 'totalQuantity'])
  const installed = [
    { id: 'ext_nameAndSpec', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
    { id: 'ext_componentSortNo', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
    { id: 'ext_parentSortNo', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
    { id: 'ext_unclassified', property: { stockPreparation: { ownership: 'plm_system' } } },
    { id: 'ext_humanNote', property: { stockPreparation: { ownership: 'human_preserved' } } },
  ]
  const ids = contentTriggerFieldIds({ installedFieldProperties: installed })
  assert.ok(ids.includes('ext_nameAndSpec'))
  for (const excluded of NON_TRIGGER_PACK_FIELD_IDS.concat(['ext_unclassified', 'ext_humanNote', 'active', 'depth', 'path', 'parentComponentCode', 'lastPlmRefreshAt'])) {
    assert.equal(ids.includes(excluded), false, excluded)
  }
})

test('trigger changes, positive examples: material M1->M2, version A->B, child edge 2->3, root total 10->12, 图号 D-1->D-2, material blank->M1, ext_nameAndSpec X->Y', () => {
  const installed = [{ id: 'ext_nameAndSpec', property: { stockPreparation: { ownership: 'plm_system', extension: true } } }]
  const triggerFieldIds = contentTriggerFieldIds({ installedFieldProperties: installed })
  const check = (field, before, after) => contentTriggerChanges({ [field]: after }, { [field]: before }, { triggerFieldIds, templateFields: TEMPLATE_FIELDS })
  assert.deepEqual(check('material', 'M1', 'M2'), ['material'])
  assert.deepEqual(check('sourceVersion', 'A', 'B'), ['sourceVersion'])
  assert.deepEqual(check('rawQuantity', 2, 3), ['rawQuantity'])
  assert.deepEqual(check('totalQuantity', 10, 12), ['totalQuantity'])
  assert.deepEqual(check('componentCode', 'D-1', 'D-2'), ['componentCode'])
  assert.deepEqual(check('material', '', 'M1'), ['material'], 'core field: blank -> value IS a trigger')
  assert.deepEqual(check('ext_nameAndSpec', 'X', 'Y'), ['ext_nameAndSpec'])
  assert.deepEqual(check('componentSpec', 'S1', 'S2'), ['componentSpec'])
})

test('trigger changes, negative examples: lastPlm* change, active flip, sort number 3->4, parentComponentCode blank->PART-A, a human column, an unclassified pack column, first fills of denormalized / ext_ columns', () => {
  const installed = [
    { id: 'ext_nameAndSpec', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
    { id: 'ext_componentSortNo', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
    { id: 'ext_unclassified', property: { stockPreparation: { ownership: 'plm_system' } } },
  ]
  const triggerFieldIds = contentTriggerFieldIds({ installedFieldProperties: installed })
  const check = (field, before, after) => contentTriggerChanges({ [field]: after }, { [field]: before }, { triggerFieldIds, templateFields: TEMPLATE_FIELDS })
  assert.deepEqual(check('lastPlmRefreshRunId', 'run_a', 'run_b'), [])
  assert.deepEqual(check('lastPlmRefreshAt', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'), [])
  assert.deepEqual(check('active', false, true), [])
  assert.deepEqual(check('ext_componentSortNo', 3, 4), [])
  assert.deepEqual(check('parentComponentCode', '', 'PART-A'), [])
  assert.deepEqual(check('notes', 'a', 'b'), [])
  assert.deepEqual(check('ext_unclassified', 'a', 'b'), [])
  // Cold start: a first fill of a denormalized / ext_ column is not a change...
  assert.deepEqual(check('componentSpec', '', 'S1'), [], 'componentSpec follows the DENORMALIZED cold-start rule (first fill)')
  assert.deepEqual(check('ext_nameAndSpec', null, 'X'), [])
  // ...but emptying one is.
  assert.deepEqual(check('ext_nameAndSpec', 'X', ''), ['ext_nameAndSpec'])
  assert.equal(isColdStartExempt('componentSpec'), true)
  assert.equal(isColdStartExempt('material'), false)
  // A field the intake does not provide is not a change (X6).
  assert.deepEqual(contentTriggerChanges({}, { material: 'M1' }, { triggerFieldIds, templateFields: TEMPLATE_FIELDS }), [])
})

// ── projection, post-condition, input ─────────────────────────────────────────────────────────────

function header(id, count, status = 'active') {
  return { id, status, memberCount: count }
}

function member(continuationId, position, oldKey, newKey, oldRecordId) {
  return { continuationId, position, relativePathTokens: position === 0 ? [] : [`X${position}`], componentSourceId: `C${position}`, oldKey, newKey, oldRecordId }
}

test('projection: one pass, two sets of equal cardinality, grouped by continuation', () => {
  const projection = buildContinuationProjection([header('c1', 2)], [member('c1', 0, 'o0', 'n0', 'r0'), member('c1', 1, 'o1', 'n1', 'r1')])
  assert.equal(projection.suppressAddKeys.size, 2)
  assert.equal(projection.protectInactiveKeys.size, 2)
  assert.equal(projection.byOldRecordId.size, 2)
  assert.deepEqual(projection.suppressAddKeys.get('n1'), { continuationId: 'c1', position: 1 })
  assert.deepEqual(projection.protectInactiveKeys.get('o1'), { continuationId: 'c1', position: 1 })
  assert.ok(Object.isFrozen(projection))
})

test('projection: a duplicated key / record id, an unknown or ended continuation, a count or position gap => PROJECTION_INCONSISTENT', () => {
  const refuse = (headers, members) => assert.throws(() => buildContinuationProjection(headers, members), (error) => error.code === CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT)
  refuse([header('c1', 2)], [member('c1', 0, 'o0', 'n0', 'r0'), member('c1', 1, 'o1', 'n0', 'r1')])
  refuse([header('c1', 2)], [member('c1', 0, 'o0', 'n0', 'r0'), member('c1', 1, 'o0', 'n1', 'r1')])
  refuse([header('c1', 2)], [member('c1', 0, 'o0', 'n0', 'r0'), member('c1', 1, 'o1', 'n1', 'r0')])
  refuse([header('c1', 1)], [member('c2', 0, 'o0', 'n0', 'r0')])
  refuse([header('c1', 1, 'ended')], [member('c1', 0, 'o0', 'n0', 'r0')])
  refuse([header('c1', 3)], [member('c1', 0, 'o0', 'n0', 'r0'), member('c1', 1, 'o1', 'n1', 'r1')])
  refuse([header('c1', 2)], [member('c1', 0, 'o0', 'n0', 'r0'), member('c1', 2, 'o1', 'n1', 'r1')])
  refuse([header('c1', 1)], [{ ...member('c1', 0, 'o0', 'n0', 'r0'), oldRecordId: '' }])
})

test('post-condition: any write decision on a continued key, an ADD of a candidate position, an INACTIVE of a candidate old row => refused', () => {
  const projection = buildContinuationProjection([header('c1', 1)], [member('c1', 0, 'old', 'new', 'r0')])
  const ok = [{ decision: 'skip', idempotencyKey: 'old' }, { decision: 'skip', idempotencyKey: 'new' }, { decision: 'add', idempotencyKey: 'other' }]
  assertContinuationPostCondition(ok, { projection })
  for (const decisions of [
    [{ decision: 'inactive', idempotencyKey: 'old' }],
    [{ decision: 'add', idempotencyKey: 'new' }],
    [{ decision: 'update', idempotencyKey: 'old' }],
    [{ decision: 'update', idempotencyKey: 'new' }],
  ]) {
    assert.throws(() => assertContinuationPostCondition(decisions, { projection }), (error) => error.code === CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
  }
  assert.throws(() => assertContinuationPostCondition([{ decision: 'add', idempotencyKey: 'cand_new' }], { projection, candidateSuppressAddKeys: new Map([['cand_new', 'h']]) }), (error) => error.code === CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
  assert.throws(() => assertContinuationPostCondition([{ decision: 'inactive', idempotencyKey: 'cand_old' }], { projection, candidateProtectKeys: new Map([['cand_old', 'h']]) }), (error) => error.code === CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
})

test('input contract: closed key set; storeState must be the literal ok (503 otherwise); step-5 change plans refused', () => {
  const valid = F.continuationInput()
  assert.equal(normalizeContinuationInput(valid).storeState, 'ok')
  assert.throws(() => normalizeContinuationInput({ ...valid, storeState: 'unreadable' }), (error) => error.status === 503 && error.code === CONTINUATION_ERROR_CODES.STORE_FAILED)
  assert.throws(() => normalizeContinuationInput({ ...valid, contentTriggerFieldIds: [] }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => normalizeContinuationInput({ ...valid, pilot: 'yes' }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => normalizeContinuationInput({ ...valid, sourceIdentity: { externalSystemId: 'x' } }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => normalizeContinuationInput({ ...valid, specSlotDeclared: undefined }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => normalizeContinuationInput({ ...valid, changePlan: {} }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => normalizeContinuationInput({ ...valid, continuations: [{ id: 'c1', status: 'ended' }] }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
})

// ── sheet machine digest (§9.2) and hold fingerprint ──────────────────────────────────────────────

test('sheetMachineDigest: ids + machine band; order-blind; a human fill or a RUN stamp does not move it, a machine write does; a row without its record ref refuses', () => {
  const band = machineBandFieldIds({})
  for (const field of ['componentCode', 'totalQuantity', 'active', 'depth', 'path', 'idempotencyKey', 'parentComponentCode']) assert.ok(band.includes(field), field)
  for (const field of ['notes', 'lastPlmRefreshAt', 'lastPlmRefreshRunId']) assert.equal(band.includes(field), false, field)
  const { oldRows } = story()
  const digest = sheetMachineDigest(oldRows, { machineFieldIds: band })
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(sheetMachineDigest(oldRows.slice().reverse(), { machineFieldIds: band }), digest)
  const human = oldRows.map((row) => ({ ...row, notes: 'filled', lastPlmRefreshAt: '2026-10-23T00:00:00.000Z' }))
  assert.equal(sheetMachineDigest(human, { machineFieldIds: band }), digest)
  const machine = oldRows.map((row, index) => (index === 1 ? { ...row, totalQuantity: 21 } : row))
  assert.notEqual(sheetMachineDigest(machine, { machineFieldIds: band }), digest)
  const reassigned = oldRows.map((row, index) => (index === 1 ? Object.assign({ ...row }, { [EXISTING_ROW_RECORD_REF]: { id: 'rec_9', version: 1 } }) : row))
  assert.notEqual(sheetMachineDigest(reassigned, { machineFieldIds: band }), digest)
  const bare = { ...oldRows[0] }
  delete bare[EXISTING_ROW_RECORD_REF]
  assert.throws(() => sheetMachineDigest([bare], { machineFieldIds: band }), (error) => error.code === CONTINUATION_ERROR_CODES.SHEET_DIGEST_RECORD_REF_MISSING)
})

test('holdFingerprint: same content => same fingerprint; any body or confirmability change moves it', () => {
  const hold = { kind: 'continuation_candidate', confirmable: true, subject: { componentSourceIdDigest: 'd' }, detail: { a: 1 }, evidenceFingerprint: 'e' }
  assert.equal(holdFingerprint(hold), holdFingerprint(JSON.parse(JSON.stringify(hold))))
  assert.notEqual(holdFingerprint(hold), holdFingerprint({ ...hold, detail: { a: 2 } }))
  assert.notEqual(holdFingerprint(hold), holdFingerprint({ ...hold, confirmable: false }))
  assert.notEqual(holdFingerprint(hold), holdFingerprint({ ...hold, evidenceFingerprint: 'f' }))
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-continuation-pairing.test.cjs', tests)
