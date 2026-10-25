'use strict'

// Batch-refresh step 4, PR-1 — the conflict planner's optional `continuation` input (design §6.1-6.8),
// acceptance cases A01-A03, A06-A09, A13, C07 and C09 at the UNIT layer (pure planner; no store, no
// lane, no route, no real DB — those are PR-2/PR-3/PR-4).
//
// Every expansion is a real `expandPlmProjectBom` walk with the #6502 recorder on (fixtures in
// support/stock-preparation-continuation-fixtures.cjs). VALUES-FREE: synthetic ids only.

const assert = require('node:assert/strict')
const path = require('node:path')

const F = require('./support/stock-preparation-continuation-fixtures.cjs')
const {
  DECISIONS,
  EXISTING_ROW_RECORD_REF,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const {
  CONTINUATION_ERROR_CODES,
  HOLD_KINDS,
  SHAPE_TOKENS,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-continuation-pairing.cjs'))

const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

function kinds(planned) {
  return (planned.holds || []).map((hold) => hold.kind).sort()
}

function holdOf(planned, kind) {
  const found = (planned.holds || []).filter((hold) => hold.kind === kind)
  assert.equal(found.length, 1, `exactly one ${kind} hold (got ${kinds(planned).join(',')})`)
  return found[0]
}

function components(decisions) {
  return decisions.map((decision) => F.componentOf(decision.idempotencyKey)).sort()
}

function assertNoWriteOn(planned, componentIds) {
  for (const decision of planned.decisions) {
    if (![DECISIONS.ADD, DECISIONS.UPDATE, DECISIONS.INACTIVE].includes(decision.decision)) continue
    assert.ok(!componentIds.includes(F.componentOf(decision.idempotencyKey)) || decision.conflictSummary.type === 'add_missing',
      `no write decision may touch ${F.componentOf(decision.idempotencyKey)}`)
  }
}

// The A01 preview, and the continuation a confirm of its candidate persists.
async function confirmedStory(options = {}) {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource(options))
  const a01 = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(a01, 'continuation_candidate')
  const { header, members } = F.continuationFromHold(hold)
  return { sheet, expansion, a01, hold, header, members }
}

function governedPlan(expansion, sheet, header, members, extra = {}) {
  return F.plan(expansion, sheet, {
    continuation: F.continuationInput({
      demandEvidence: expansion.demandEvidence,
      continuations: header ? [header] : [],
      members: members || [],
      ...extra,
    }),
  })
}

// ── C09 / invariant (i): absent input is byte-identical ───────────────────────────────────────────

test('C09: no continuation input => the plan is byte-identical, `continuation: undefined` included, and carries no step-4 key', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  const bare = F.plan(expansion, sheet)
  const explicitUndefined = F.plan(expansion, sheet, { continuation: undefined })
  assert.equal(JSON.stringify(explicitUndefined), JSON.stringify(bare))
  for (const key of ['suspended', 'holds', 'continuation']) assert.equal(Object.prototype.hasOwnProperty.call(bare, key), false, key)
  assert.equal(Object.prototype.hasOwnProperty.call(bare.summary, 'continuation'), false)
  // The old flow on this sheet: P-001 + N-001 + the four-row S-001 copy ADDed, the old S-001 rows swept.
  assert.equal(bare.counts.add, 6)
  assert.equal(bare.counts.inactive, 4)
  assert.equal(bare.valid, true)
})

test('C09: the record reference on existing rows moves nothing in an ungoverned plan', async () => {
  const sheet = await F.firstPullSheet()
  const stripped = sheet.map((row) => ({ ...row }))
  for (const row of stripped) delete row[EXISTING_ROW_RECORD_REF]
  const expansion = await F.expand(F.secondPullSource())
  assert.equal(JSON.stringify(F.plan(expansion, sheet)), JSON.stringify(F.plan(expansion, stripped)))
})

test('C09: a pilot-off governed project gets no detection: the same overlap is planned the old way (minus nothing)', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  const planned = governedPlan(expansion, sheet, null, null, { pilot: false })
  assert.equal(planned.suspended, false)
  assert.deepEqual(planned.holds, [])
  assert.equal(planned.counts.add, 6)
  assert.equal(planned.counts.inactive, 4)
})

// ── invariants (ii) and (iv) ──────────────────────────────────────────────────────────────────────

test('invariant (ii): a store state other than ok, or a null input, refuses to plan', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  for (const continuation of [null, { ...F.continuationInput(), storeState: 'failed' }, { ...F.continuationInput(), storeState: undefined }]) {
    assert.throws(() => F.plan(expansion, sheet, { continuation }), (error) => {
      assert.ok([CONTINUATION_ERROR_CODES.STORE_FAILED, CONTINUATION_ERROR_CODES.INPUT_INVALID].includes(error.code))
      return true
    })
  }
  assert.throws(() => F.plan(expansion, sheet, { continuation: { ...F.continuationInput(), storeState: 'failed' } }), (error) => error.code === CONTINUATION_ERROR_CODES.STORE_FAILED && error.status === 503)
  assert.throws(() => F.plan(expansion, sheet, { continuation: { ...F.continuationInput(), projection: {} } }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => F.plan(expansion, sheet, { continuation: { ...F.continuationInput(), changePlan: { id: 'x' } } }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID)
})

test('invariant (iv): a suspended plan is never valid, and holds are not manual_confirm decisions', async () => {
  const { a01 } = await confirmedStory()
  assert.equal(a01.suspended, true)
  assert.equal(a01.valid, false)
  assert.equal(a01.counts.manual_confirm, 0, 'a suspension is a whole-plan verdict, not an acknowledgeable hold')
})

// ── A01 / A02 / A03 ───────────────────────────────────────────────────────────────────────────────

test('A01: second pull with S-001 nested in P-001, seven items consistent, not yet confirmed => suspended, one confirmable candidate, old rows protected, no copy', async () => {
  const { a01, hold } = await confirmedStory()
  assert.equal(a01.suspended, true, 'the WHOLE pull is suspended')
  assert.equal(a01.valid, false)
  assert.equal(a01.continuation.suspended, true)
  assert.deepEqual(kinds(a01), ['continuation_candidate'])
  assert.equal(hold.confirmable, true)
  assert.equal(hold.detail.comparison.outcome, 'match')
  assert.equal(hold.detail.demand.classification, 'base_dropped')
  assert.equal(hold.detail.history, 'history_unknown')
  assert.match(hold.evidenceFingerprint, /^[0-9a-f]{64}$/)
  assert.match(hold.comparisonFingerprint, /^[0-9a-f]{64}$/)
  assert.match(hold.pairingFingerprint, /^[0-9a-f]{64}$/)
  // No INACTIVE of the old S-001 subtree and no ADD of its copy: both are SKIP suspended_continuation_candidate.
  assert.equal(a01.counts.inactive, 0)
  assert.deepEqual(components(F.byDecision(a01, DECISIONS.ADD)), ['N-001', 'P-001'])
  assert.equal(F.byType(a01, 'suspended_continuation_candidate').length, 8)
  // The pairs bind record ids and old keys.
  assert.equal(hold.detail.pairs.length, 4)
  assert.ok(hold.detail.pairs.every((pair) => /^rec_s_\d+$/.test(pair.oldRecordId)))
})

test('A02: after the confirm, the re-preview SKIPs 4 continued + 4 protected, ADDs exactly the 2 real new rows, sweeps nothing', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const a02 = governedPlan(expansion, sheet, header, members)
  assert.equal(a02.suspended, false)
  assert.equal(a02.valid, true)
  assert.deepEqual(a02.continuation.verdicts, { [header.id]: 'valid' })
  assert.equal(F.byType(a02, 'continued_by_relationship').length, 4)
  assert.equal(F.byType(a02, 'protected_by_relationship').length, 4)
  assert.deepEqual(components(F.byDecision(a02, DECISIONS.ADD)), ['N-001', 'P-001'])
  assert.equal(a02.counts.inactive, 0)
  assert.equal(a02.counts.update, 0)
  assert.equal(a02.continuation.protectedOldRows, 4)
  assert.equal(a02.continuation.suppressedNewRows, 4)
  // The old S-001 rows receive no patch at all (no UPDATE/INACTIVE carries their keys).
  const oldKeys = new Set(members.map((member) => member.oldKey))
  assert.ok(a02.decisions.every((decision) => !oldKeys.has(decision.idempotencyKey) || decision.decision === DECISIONS.SKIP))
})

test('A03: a third identical pull reuses the relationship: valid, no hold, no ADD / INACTIVE, no new confirmation', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const a02 = governedPlan(expansion, sheet, header, members)
  const afterApply = F.applyToSheet(a02, sheet, { idPrefix: 'rec_p' })
  const a03 = governedPlan(expansion, afterApply, header, members)
  assert.equal(a03.suspended, false)
  assert.deepEqual(a03.holds, [])
  assert.equal(a03.counts.add, 0)
  assert.equal(a03.counts.inactive, 0)
  assert.equal(a03.counts.update, 0)
  assert.deepEqual(a03.continuation.verdicts, { [header.id]: 'valid' })
})

test('A02 post-condition: protection is not optional — the evidence summary carries the values-free stanza and never the holds', async () => {
  const { a01 } = await confirmedStory()
  const evidence = summarizeConflictPlanForEvidence(a01)
  assert.ok(evidence.continuation)
  assert.equal(evidence.continuation.suspended, true)
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'holds'), false)
  const text = JSON.stringify(evidence)
  for (const value of ['S-001', 'P-001', 'PART-A', 'D100-01', 'rec_s_']) assert.equal(text.includes(value), false, `evidence leaks ${value}`)
  const summaryText = JSON.stringify(a01.summary)
  for (const value of ['S-001', 'P-001', 'PART-A', 'D100-01', 'rec_s_']) assert.equal(summaryText.includes(value), false, `summary leaks ${value}`)
})

// ── A06 ───────────────────────────────────────────────────────────────────────────────────────────

test('A06: old root order qty 10 vs new edge 2 is not a difference; P-001 demand 6 makes the S-001 root total 12 => content_changed, and the S-001 root is never written', async () => {
  const { sheet, expansion, header, members, hold } = await confirmedStory()
  const root = hold.detail.comparison.items.find((item) => item.root)
  assert.equal(root.fields.rawQuantity.status, 'excluded_root_order_quantity')
  assert.equal(root.fields.totalQuantity.status, 'equal')
  assert.equal(hold.detail.comparison.parentEdgeUsage, 2)
  const a02 = governedPlan(expansion, sheet, header, members)
  const afterApply = F.applyToSheet(a02, sheet, { idPrefix: 'rec_p' })
  const changed = await F.expand(F.secondPullSource({ pQty: 6 }))
  const a06 = governedPlan(changed, afterApply, header, members)
  assert.deepEqual(a06.continuation.verdicts, { [header.id]: 'content_changed' })
  const relationshipHold = holdOf(a06, 'relationship_content_change')
  assert.equal(relationshipHold.confirmable, false)
  const newRoot = relationshipHold.detail.comparison.items.find((item) => item.root)
  assert.equal(newRoot.fields.totalQuantity.status, 'differs')
  assert.equal(newRoot.fields.totalQuantity.old, 10)
  assert.equal(newRoot.fields.totalQuantity.new, 12)
  assert.equal(a06.suspended, true)
  // S-001's old root: no write decision of any kind, so its rawQuantity (10) can never become 2.
  const oldRootKey = members.find((member) => member.position === 0).oldKey
  assert.ok(a06.decisions.filter((decision) => decision.idempotencyKey === oldRootKey).every((decision) => decision.decision === DECISIONS.SKIP))
})

test('A06: an inner edge change inside the continued subtree is still found (content_changed)', async () => {
  const { sheet, header, members } = await confirmedStory()
  const changed = await F.expand(F.secondPullSource({ boms: { 'PART-A': [{ part: 'PART-C', usage: 5 }] } }))
  const planned = governedPlan(changed, sheet, header, members)
  assert.deepEqual(planned.continuation.verdicts, { [header.id]: 'content_changed' })
  const item = holdOf(planned, 'relationship_content_change').detail.comparison.items.find((entry) => entry.componentSourceId === 'PART-C')
  assert.equal(item.fields.rawQuantity.status, 'differs')
})

// ── A07 ───────────────────────────────────────────────────────────────────────────────────────────

test('A07: S-001\'s own order is gone and P-001 needs the same part and quantity => still only a CANDIDATE (head shown absent, history unknown), nothing auto-confirms', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource({ sLine: false }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'continuation_candidate')
  assert.equal(planned.suspended, true, 'nothing confirms on its own: the pull waits for a person')
  assert.equal(hold.detail.demand.classification, 'base_head_absent')
  assert.equal(hold.detail.demand.oldRoot.orderHeadPresence, 'absent')
  assert.equal(hold.detail.history, 'history_unknown')
  assert.equal(hold.detail.demand.history, 'history_unknown')
})

test('A07: S-001\'s own order still present and KEPT as a root => old_root_still_ordered, no confirm control', async () => {
  const sheet = await F.firstPullSheet()
  // Root selection disabled: every order line is a root, so S-001 is kept AND nested in P-001.
  const expansion = await F.expand(F.secondPullSource(), { rootSelection: { enabled: false } })
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'candidate_shape_unresolved')
  assert.equal(hold.confirmable, false)
  assert.equal(hold.shapeToken, 'old_root_still_ordered')
  assert.equal(hold.notConfirmableReason, 'customer_rule_pending')
  assert.ok(hold.detail.shapeSubTokens.includes('root_selection_disabled'))
})

// ── A08 ───────────────────────────────────────────────────────────────────────────────────────────

test('A08: two independent new demands compete for one old S-001 => candidate_ambiguous (never the first one)', async () => {
  const sheet = await F.firstPullSheet()
  const parts = F.PARTS.concat([F.part('P-002', 'D100-02', 'Assembly2')])
  const expansion = await F.expand(F.secondPullSource({
    sLine: false,
    parts,
    extraOrders: [{ part: 'P-002', qty: 5 }],
    boms: { 'P-002': [{ part: 'S-001', usage: 2 }] },
  }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'candidate_ambiguous')
  assert.equal(hold.confirmable, false)
  assert.equal(hold.detail.newPositionKeys.length, 2)
  assert.equal(planned.counts.inactive, 0, 'the old S-001 rows stay protected')
  assert.equal(F.byType(planned, 'suspended_continuation_candidate').filter((decision) => decision.decision === DECISIONS.SKIP).length, 12)
})

test('A08: two old S-001 roots for one new position => candidate_ambiguous', async () => {
  const sheet = await F.firstPullSheet()
  const root = sheet.find((row) => row.componentSourceId === 'S-001')
  const twin = F.withRecordRef({ ...root, idempotencyKey: `${root.idempotencyKey}::duplicate:sortLine:sha16:0000000000000001` }, 'rec_twin', 1)
  const expansion = await F.expand(F.secondPullSource({ sLine: false }))
  const planned = F.plan(expansion, sheet.concat([twin]), { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'candidate_ambiguous')
  assert.equal(hold.detail.oldRootKeys.length, 2)
})

test('A08: a component repeated at two positions inside the subtree is two pairs (occurrence-exact, never deduped)', async () => {
  const boms = {
    'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }],
    'PART-A': [{ part: 'PART-C', usage: 4 }],
    'PART-B': [{ part: 'PART-C', usage: 1 }],
  }
  const first = await F.expand(F.project({ orders: [{ part: 'S-001', qty: 10 }], parts: F.PARTS.slice(), boms }))
  const sheet = F.applyToSheet(F.plan(first, []), [], { idPrefix: 'rec_s' })
  const second = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 10 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'S-001', usage: 2 }], ...boms },
  }))
  const planned = F.plan(second, sheet, { continuation: F.continuationInput({ demandEvidence: second.demandEvidence }) })
  const hold = holdOf(planned, 'continuation_candidate')
  assert.equal(hold.detail.pairs.filter((pair) => pair.componentSourceId === 'PART-C').length, 2)
  // One of the two PART-C edges changes => found, not hidden behind the other occurrence.
  const changed = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 10 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'S-001', usage: 2 }], ...boms, 'PART-B': [{ part: 'PART-C', usage: 7 }] },
  }))
  const changedPlan = F.plan(changed, sheet, { continuation: F.continuationInput({ demandEvidence: changed.demandEvidence }) })
  holdOf(changedPlan, 'candidate_content_differs')
})

test('A08: two edges to one component under one parent (a multiset at one relative path) are never paired with "the first"', async () => {
  const sheet = await F.firstPullSheet()
  // PART-B twice under S-001 with different usages => two rows at one relative path in the new subtree.
  const expansion = await F.expand(F.secondPullSource({ boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }, { part: 'PART-B', usage: 9 }] } }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'candidate_structure_differs')
  assert.ok(hold.detail.pairingProblems.includes('path_repeated_new'))
})

// ── A09 ───────────────────────────────────────────────────────────────────────────────────────────

test('A09: the new position already holds an INACTIVE row (root or child) => candidate_target_occupied, no revive confirmable', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  for (const occupiedComponent of ['S-001', 'PART-C']) {
    const target = expansion.rows.find((row) => row.componentSourceId === occupiedComponent && row.path.startsWith('["P-001"'))
    const tombstone = F.withRecordRef({ ...target, active: false }, `rec_tomb_${occupiedComponent}`, 3)
    const planned = F.plan(expansion, sheet.concat([tombstone]), { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
    const hold = holdOf(planned, 'candidate_target_occupied')
    assert.equal(hold.confirmable, false)
    assert.equal(hold.notConfirmableReason, 'specialist_repair')
    assert.equal(planned.counts.inactive, 0)
    assert.equal(planned.suspended, true)
  }
})

test('A09: the new position already holds an ACTIVE copy while the old root would be swept => candidate_target_occupied (never "sweep the independent copy")', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  const copy = expansion.rows.filter((row) => row.path.startsWith('["P-001","S-001"')).map((row, index) => F.withRecordRef({ ...row }, `rec_copy_${index}`, 1))
  const planned = F.plan(expansion, sheet.concat(copy), { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  holdOf(planned, 'candidate_target_occupied')
  assert.equal(planned.counts.inactive, 0, 'the old S-001 rows are not swept')
})

test('A09: the history already holds two copies of an old row => candidate_old_duplicate', async () => {
  const sheet = await F.firstPullSheet()
  const child = sheet.find((row) => row.componentSourceId === 'PART-A')
  const expansion = await F.expand(F.secondPullSource())
  const planned = F.plan(expansion, sheet.concat([F.withRecordRef({ ...child }, 'rec_dup', 1)]), { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  holdOf(planned, 'candidate_old_duplicate')
})

test('A09: verification step 3 — a row lands at the continued position => new_position_occupied suspends, and the copy is NOT updated / revived', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const newRootKey = members.find((member) => member.position === 0).newKey
  const target = expansion.rows.find((row) => row.idempotencyKey === newRootKey)
  const copy = F.withRecordRef({ ...target, totalQuantity: 99, active: false }, 'rec_landed', 1)
  const planned = governedPlan(expansion, sheet.concat([copy]), header, members)
  assert.deepEqual(planned.continuation.verdicts, { [header.id]: 'new_position_occupied' })
  assert.equal(planned.suspended, true)
  const decisions = planned.decisions.filter((decision) => decision.idempotencyKey === newRootKey)
  assert.deepEqual(decisions.map((decision) => decision.decision), [DECISIONS.SKIP])
  holdOf(planned, 'relationship_reconfirm')
})

// ── A10 (verdict tokens, unit layer of PR-1's verification) ───────────────────────────────────────

test('verification: source binding switched / P-001 removed / old record inactive or replaced => named verdicts, protection kept, suspended', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const switched = governedPlan(expansion, sheet, header, members, { sourceIdentity: { ...F.SOURCE_IDENTITY, readPlanDigest: 'c'.repeat(64) } })
  assert.deepEqual(switched.continuation.verdicts, { [header.id]: 'source_scope_changed' })
  assert.equal(holdOf(switched, 'relationship_reconfirm').confirmable, true, 'a source switch with everything else intact is re-confirmable (D-19)')

  const removed = await F.expand(F.project({ orders: [{ part: 'N-001', qty: 1 }], parts: F.PARTS.slice(), boms: F.S_BOMS }))
  const removedPlan = governedPlan(removed, sheet, header, members)
  assert.deepEqual(removedPlan.continuation.verdicts, { [header.id]: 'new_position_removed' })
  assert.equal(removedPlan.counts.inactive, 0, 'the protected old rows are NOT swept when the new structure disappears')

  const inactive = sheet.map((row) => (row.componentSourceId === 'PART-B' ? F.withRecordRef({ ...row, active: false }, row[EXISTING_ROW_RECORD_REF].id, 2) : row))
  assert.deepEqual(governedPlan(expansion, inactive, header, members).continuation.verdicts, { [header.id]: 'old_record_inactive' })
  const replaced = sheet.map((row) => (row.componentSourceId === 'PART-B' ? F.withRecordRef({ ...row }, 'rec_other', 1) : row))
  assert.deepEqual(governedPlan(expansion, replaced, header, members).continuation.verdicts, { [header.id]: 'old_record_replaced' })
  const missing = sheet.filter((row) => row.componentSourceId !== 'PART-B')
  const missingPlan = governedPlan(expansion, missing, header, members)
  assert.deepEqual(missingPlan.continuation.verdicts, { [header.id]: 'old_record_missing' })
  assert.equal(missingPlan.suspended, true)
})

test('verification: S-001 re-ordered alone and kept (root selection off) => demand_changed, no confirm control', async () => {
  const { sheet, header, members } = await confirmedStory()
  const kept = await F.expand(F.secondPullSource(), { rootSelection: { enabled: false } })
  const planned = governedPlan(kept, sheet, header, members)
  assert.deepEqual(planned.continuation.verdicts, { [header.id]: 'demand_changed' })
  const hold = holdOf(planned, 'relationship_reconfirm')
  assert.equal(hold.confirmable, false)
  assert.equal(hold.notConfirmableReason, 'customer_rule_pending')
  assert.equal(planned.counts.inactive, 0)
})

test('protection on every branch: a protected old row that is back in the expansion with new content gets NO patch (SKIP protected, never UPDATE)', async () => {
  const { sheet, header, members } = await confirmedStory()
  // Root selection off and S-001 re-ordered with 12: the old S-001 root key is in the expansion and differs.
  const kept = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 12 }, { part: 'N-001', qty: 1 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'S-001', usage: 2 }], ...F.S_BOMS },
  }), { rootSelection: { enabled: false } })
  const planned = governedPlan(kept, sheet, header, members, { pilot: false })
  const oldKeys = new Set(members.map((member) => member.oldKey))
  const onOld = planned.decisions.filter((decision) => oldKeys.has(decision.idempotencyKey))
  assert.ok(onOld.length >= 4)
  assert.ok(onOld.every((decision) => decision.decision === DECISIONS.SKIP && decision.conflictSummary.type === 'protected_by_relationship'))
  assert.equal(planned.suspended, true)
})

test('verification: a stored pairing fingerprint / member list that no longer matches the current pairing => structure_changed', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const tampered = governedPlan(expansion, sheet, { ...header, pairingFingerprint: 'f'.repeat(64) }, members)
  assert.deepEqual(tampered.continuation.verdicts, { [header.id]: 'structure_changed' })
  const reordered = members.map((member) => (member.position === 1 ? { ...member, relativePathTokens: ['PART-Z'] } : member))
  assert.deepEqual(governedPlan(expansion, sheet, header, reordered).continuation.verdicts, { [header.id]: 'structure_changed' })
})

test('verification: a needs_reconfirmation continuation that verifies valid stays suspended until re-confirmed', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const planned = governedPlan(expansion, sheet, { ...header, status: 'needs_reconfirmation', statusReason: 'source_scope_changed' }, members)
  assert.equal(planned.suspended, true)
  const hold = holdOf(planned, 'relationship_reconfirm')
  assert.equal(hold.confirmable, true)
  assert.deepEqual(planned.continuation.verdicts, { [header.id]: 'valid' })
})

test('verification: the incomplete relevant read => evidence_incomplete; an unrelated incomplete line does not re-ask', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const noEvidence = governedPlan(expansion, sheet, header, members, { demandEvidence: null })
  assert.deepEqual(noEvidence.continuation.verdicts, { [header.id]: 'evidence_incomplete' })
  // An unrelated order line whose part is missing: attributable to another component.
  const unrelated = await F.expand(F.secondPullSource({ extraOrders: [{ part: 'GHOST-9', qty: 1 }] }), { allowStatuses: ['failed'] })
  assert.equal(unrelated.demandEvidence.completeness.status, 'incomplete')
  const unrelatedPlan = governedPlan(unrelated, sheet, header, members, { pilot: false })
  assert.deepEqual(unrelatedPlan.continuation.verdicts, { [header.id]: 'valid' })
  assert.equal(unrelatedPlan.suspended, false)
})

// ── A13 ───────────────────────────────────────────────────────────────────────────────────────────

test('A13: no-dash hierarchy (dash rule off) => S-001 kept => old_root_still_ordered + no_dash_hierarchy, no confirm control', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource(), { rootSelection: { dropDashDescendants: false } })
  const hold = holdOf(F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) }), 'candidate_shape_unresolved')
  assert.equal(hold.confirmable, false)
  assert.ok(hold.detail.shapeSubTokens.includes('no_dash_hierarchy'))
  assert.ok(hold.detail.shapeSubTokens.includes('parent_before_child'), 'P-001\'s line precedes S-001\'s, both kept')
})

test('A13: sheet metal ordered alone AND inside the 总图 => old_root_still_ordered + sheet_metal_dual', async () => {
  const parts = [
    F.part('M-001', 'J500-00', 'MainDrawing'),
    F.part('SM-001', 'J500-A', 'SheetMetal'),
    F.part('PART-A', 'C200-1', 'Bracket'),
  ]
  const boms = { 'SM-001': [{ part: 'PART-A', usage: 2 }] }
  const first = await F.expand(F.project({ orders: [{ part: 'SM-001', qty: 4 }], parts, boms }))
  const sheet = F.applyToSheet(F.plan(first, []), [], { idPrefix: 'rec_sm' })
  const second = await F.expand(F.project({
    orders: [{ part: 'M-001', qty: 2 }, { part: 'SM-001', qty: 4 }],
    parts,
    boms: { 'M-001': [{ part: 'SM-001', usage: 2 }], ...boms },
  }))
  const hold = holdOf(F.plan(second, sheet, { continuation: F.continuationInput({ demandEvidence: second.demandEvidence }) }), 'candidate_shape_unresolved')
  assert.equal(hold.shapeToken, 'old_root_still_ordered')
  assert.ok(hold.detail.shapeSubTokens.includes('sheet_metal_dual'))
  assert.equal(hold.confirmable, false)
})

test('A13: first pull with S-001 AND P-001 (S-001 dropped as a dash descendant, no old rows) => dropped_order_head_unresolved, no confirm control', async () => {
  const expansion = await F.expand(F.secondPullSource())
  const planned = F.plan(expansion, [], { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'dropped_order_head_unresolved')
  assert.equal(hold.confirmable, false)
  assert.equal(hold.notConfirmableReason, 'customer_rule_pending')
  assert.equal(planned.suspended, true)
  // Non-pilot: untouched (C09).
  const nonPilot = F.plan(expansion, [], { continuation: F.continuationInput({ pilot: false, demandEvidence: expansion.demandEvidence }) })
  assert.equal(nonPilot.suspended, false)
})

test('A13: a head dropped as "a child elsewhere" but expanded NOWHERE => dropped_order_head_unresolved even with old rows (the old flow would sweep them)', async () => {
  const sheet = await F.firstPullSheet()
  // P-001's BOM does not contain S-001 any more, yet S-001's line is dropped as its dash descendant.
  const expansion = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 10 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'N-001', usage: 1 }], ...F.S_BOMS },
  }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  holdOf(planned, 'dropped_order_head_unresolved')
  assert.equal(planned.suspended, true)
})

test('A13: on a pilot project the read that cannot rule out a dropped head (recorder absent) suspends', async () => {
  const expansion = await F.expand(F.secondPullSource())
  const planned = F.plan(expansion, [], { continuation: F.continuationInput({ demandEvidence: null }) })
  const hold = holdOf(planned, 'candidate_incomplete_evidence')
  assert.equal(hold.detail.unusableReason, 'demand_evidence_absent')
})

test('A13: every shape hold is non-confirmable and every shape token is in the closed vocabulary', async () => {
  const sheet = await F.firstPullSheet()
  const shapes = [
    await F.expand(F.secondPullSource(), { rootSelection: { enabled: false } }),
    await F.expand(F.secondPullSource(), { rootSelection: { dropDashDescendants: false } }),
  ]
  for (const expansion of shapes) {
    const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
    for (const hold of planned.holds) {
      assert.ok(HOLD_KINDS.includes(hold.kind))
      if (hold.shapeToken) assert.ok(SHAPE_TOKENS.includes(hold.shapeToken))
      assert.equal(hold.confirmable, false, `${hold.kind} must not offer a confirm control`)
    }
  }
})

// ── C07 ───────────────────────────────────────────────────────────────────────────────────────────

test('C07: structure + content together on a candidate => candidate_structure_differs, never the content path', async () => {
  const sheet = await F.firstPullSheet()
  const parts = F.PARTS.concat([F.part('PART-D', 'C200-4', 'Washer')])
  const expansion = await F.expand(F.secondPullSource({
    parts: parts.map((entry) => (entry.OBJ_ID === 'PART-A' ? { ...entry, Material: 'M-ALU' } : entry)),
    boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }, { part: 'PART-D', usage: 1 }] },
  }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  holdOf(planned, 'candidate_structure_differs')
  assert.equal((planned.holds || []).some((hold) => hold.kind === 'candidate_content_differs'), false)
})

test('C07: structure + content together on a continuation => structure_changed, not content_changed', async () => {
  const { sheet, header, members } = await confirmedStory()
  const parts = F.PARTS.concat([F.part('PART-D', 'C200-4', 'Washer')])
  const changed = await F.expand(F.secondPullSource({
    pQty: 6,
    parts,
    boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }, { part: 'PART-D', usage: 1 }] },
  }))
  const planned = governedPlan(changed, sheet, header, members)
  assert.deepEqual(planned.continuation.verdicts, { [header.id]: 'structure_changed' })
  assert.equal(holdOf(planned, 'relationship_reconfirm').confirmable, false)
})

test('C07: a lineage mismatch on a governed project is a structure_change hold only (no content_change for that row)', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const a02 = governedPlan(expansion, sheet, header, members)
  const afterApply = F.applyToSheet(a02, sheet, { idPrefix: 'rec_p' })
  const tampered = afterApply.map((row) => (row.componentSourceId === 'N-001'
    ? F.withRecordRef({ ...row, parentSourceId: 'X-OTHER', totalQuantity: 99 }, row[EXISTING_ROW_RECORD_REF].id, 2)
    : row))
  const planned = governedPlan(expansion, tampered, header, members)
  holdOf(planned, 'structure_change')
  assert.equal((planned.holds || []).some((hold) => hold.kind === 'content_change'), false)
})

// ── §6.7 content change on pilot rows (C01 unit half) ─────────────────────────────────────────────

test('content change (pilot): a trigger field change on an ordinary row suspends with per-field before/after and human-column presence', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const a02 = governedPlan(expansion, sheet, header, members)
  const afterApply = F.applyToSheet(a02, sheet, { idPrefix: 'rec_p', human: { 'N-001': { notes: 'synthetic' } } })
  const changed = await F.expand(F.secondPullSource({ parts: F.PARTS.map((entry) => (entry.OBJ_ID === 'N-001' ? { ...entry, SysVer: 'V2' } : entry)) }))
  const planned = governedPlan(changed, afterApply, header, members)
  const hold = holdOf(planned, 'content_change')
  assert.deepEqual(Object.keys(hold.detail.fields), ['sourceVersion'])
  assert.deepEqual(hold.detail.fields.sourceVersion, { before: 'V1', after: 'V2' })
  assert.equal(hold.detail.humanColumnsPresent.notes, true)
  assert.equal(planned.suspended, true)
  // Non-pilot governed: the same change is a plain identity hold converted to content_change (D-4).
  const nonPilot = governedPlan(changed, afterApply, header, members, { pilot: false })
  holdOf(nonPilot, 'content_change')
})

// ── projection integrity ──────────────────────────────────────────────────────────────────────────

test('projection: a member list that disagrees with its header refuses the plan (fail closed, never half-protects)', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  assert.throws(() => governedPlan(expansion, sheet, header, members.slice(1)), (error) => error.code === CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT)
  const duplicated = members.concat([{ ...members[1], position: members.length }])
  assert.throws(() => governedPlan(expansion, sheet, { ...header, memberCount: duplicated.length }, duplicated), (error) => error.code === CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT)
})

test('carry pool: a continuation-protected old row is never a carry predecessor (third consumer)', async () => {
  // The protected old PART-A carries a person's note, so it WOULD be a carry predecessor if it were swept.
  const first = await F.expand(F.firstPullSource())
  const sheet = F.applyToSheet(F.plan(first, []), [], { idPrefix: 'rec_s', human: { 'S-001': { notes: 'synthetic note' }, 'PART-A': { notes: 'synthetic note A' } } })
  const second = await F.expand(F.secondPullSource())
  const a01 = F.plan(second, sheet, { continuation: F.continuationInput({ demandEvidence: second.demandEvidence }) })
  const { header, members } = F.continuationFromHold(holdOf(a01, 'continuation_candidate'))
  // N-001 now contains PART-A: a genuinely new PART-A position whose component matches a PROTECTED old row.
  const expansion = await F.expand(F.secondPullSource({ boms: { 'N-001': [{ part: 'PART-A', usage: 1 }] } }))
  const carry = (continuation) => planStockPreparationConflicts({
    expandedRows: expansion.rows,
    existingRows: sheet,
    rowErrors: expansion.rowErrors,
    runId: F.RUN_ID,
    plannedAt: F.PLANNED_AT,
    carryPolicy: { carryKey: 'component_source_id' },
    ...(continuation ? { continuation } : {}),
  })
  // Control: without the continuation the swept old PART-A IS a predecessor of the new PART-A.
  const ungoverned = carry(null)
  assert.ok(ungoverned.summary.carry.counts.carryViaConfirm + ungoverned.summary.carry.counts.manualConfirm > 0)
  const governed = carry(F.continuationInput({ pilot: false, demandEvidence: expansion.demandEvidence, continuations: [header], members }))
  assert.equal(governed.summary.carry.counts.carryViaConfirm, 0)
  assert.equal(governed.summary.carry.counts.manualConfirm, 0)
  assert.ok(governed.summary.carry.counts.noCarry > 0)
})

test('post-condition is wired: the planner runs it on every governed plan, over the emitted decisions', async () => {
  const pairingModule = require(path.join(__dirname, '..', 'lib', 'stock-preparation-continuation-pairing.cjs'))
  const original = pairingModule.assertContinuationPostCondition
  const calls = []
  pairingModule.assertContinuationPostCondition = (decisions, sets) => {
    calls.push({ decisions: decisions.length, hasProjection: Boolean(sets && sets.projection) })
    return original(decisions, sets)
  }
  try {
    const { sheet, expansion, header, members } = await confirmedStory()
    calls.length = 0
    const planned = governedPlan(expansion, sheet, header, members)
    assert.deepEqual(calls, [{ decisions: planned.decisions.length, hasProjection: true }])
    calls.length = 0
    F.plan(expansion, sheet)
    assert.deepEqual(calls, [], 'never on an ungoverned plan')
  } finally {
    pairingModule.assertContinuationPostCondition = original
  }
})

test('content change: on a governed NON-pilot project a non-identity trigger change stays a plain UPDATE (detection is pilot-only, D11)', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const a02 = governedPlan(expansion, sheet, header, members)
  const afterApply = F.applyToSheet(a02, sheet, { idPrefix: 'rec_p' })
  // N-001's order quantity 1 -> 3: rawQuantity and totalQuantity change, nothing else.
  const changed = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 10 }, { part: 'N-001', qty: 3 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'S-001', usage: 2 }], ...F.S_BOMS },
  }))
  const nonPilot = governedPlan(changed, afterApply, header, members, { pilot: false })
  assert.deepEqual(nonPilot.holds, [])
  assert.equal(nonPilot.suspended, false)
  assert.deepEqual(components(F.byDecision(nonPilot, DECISIONS.UPDATE)), ['N-001'])
  const pilot = governedPlan(changed, afterApply, header, members)
  assert.deepEqual(Object.keys(holdOf(pilot, 'content_change').detail.fields).sort(), ['rawQuantity', 'totalQuantity'])
})

// ── PR-3a (batch-refresh step 4): persisted holds survive pilot exit (AMB-1 / TD-10), the displayed plan
//    never contradicts a hold (O-5 / TD-15 / TD-29), and the O-3 / O-4 / O-6 / O-7 planner fixes ──────────

const pairingCore = require(path.join(__dirname, '..', 'lib', 'stock-preparation-continuation-pairing.cjs'))
const { stableFingerprint } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs')).__internals

// A pure-core hold as the refresh store would hand it back through a consult and the lane would field-pick it
// (PERSISTED_HOLD_KEYS): jsonb round-trip for subject / detail, nulls for absent optionals.
function persistedFrom(hold, { runbookOnly = false, continuationRoots = null, confirmable, notConfirmableReason } = {}) {
  const isConfirmable = confirmable === undefined ? hold.confirmable === true : confirmable
  return {
    kind: hold.kind,
    fingerprint: hold.fingerprint,
    confirmable: isConfirmable,
    notConfirmableReason: isConfirmable ? null : (notConfirmableReason || hold.notConfirmableReason),
    shapeToken: hold.shapeToken || null,
    continuationId: hold.continuationId || null,
    subject: JSON.parse(JSON.stringify(hold.subject)),
    detail: JSON.parse(JSON.stringify(hold.detail)),
    evidenceFingerprint: hold.evidenceFingerprint || null,
    comparisonFingerprint: hold.comparisonFingerprint || null,
    pairingFingerprint: hold.pairingFingerprint || null,
    runbookOnly,
    continuationRoots,
  }
}

function writesOn(planned, predicate) {
  return planned.decisions.filter((decision) => [DECISIONS.ADD, DECISIONS.UPDATE, DECISIONS.INACTIVE].includes(decision.decision) && predicate(decision))
}

function underPath(prefix) {
  return (decision) => {
    const key = JSON.parse(decision.idempotencyKey.split('::duplicate:')[0])
    return Array.isArray(key.path) && key.path.length >= prefix.length && key.path.slice(0, prefix.length).join('/') === prefix.join('/')
  }
}

test('PC-RE-0 persistedHolds is a REQUIRED planner key (absent / not an array => 500), each entry closed to the 13-key PHK set and validated like a stored hold', async () => {
  assert.equal(pairingCore.CONTINUATION_INPUT_KEYS.length, 10)
  assert.ok(pairingCore.CONTINUATION_INPUT_KEYS.includes('persistedHolds'))
  assert.deepEqual(pairingCore.PERSISTED_HOLD_KEYS.slice().sort(), ['comparisonFingerprint', 'confirmable', 'continuationId', 'continuationRoots', 'detail', 'evidenceFingerprint', 'fingerprint', 'kind', 'notConfirmableReason', 'pairingFingerprint', 'runbookOnly', 'shapeToken', 'subject'])
  const valid = F.continuationInput()
  const { persistedHolds: omitted, ...withoutKey } = valid
  assert.deepEqual(omitted, [])
  const refusesWith = (input, field) => assert.throws(() => pairingCore.normalizeContinuationInput(input), (error) => error.status === 500
    && error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID && (field === undefined || error.details.field === field), `refused ${field}`)
  refusesWith(withoutKey, 'continuation.persistedHolds')
  refusesWith({ ...valid, persistedHolds: null }, 'continuation.persistedHolds')
  refusesWith({ ...valid, persistedHolds: {} }, 'continuation.persistedHolds')
  // The planner itself refuses (a lane that forgot the key never silently plans without the protection).
  const { sheet, expansion, a01 } = await confirmedStory()
  assert.throws(() => F.plan(expansion, sheet, { continuation: withoutKey }), (error) => error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID && error.details.field === 'continuation.persistedHolds')
  const entry = persistedFrom(holdOf(a01, 'continuation_candidate'))
  assert.equal(pairingCore.normalizeContinuationInput({ ...valid, persistedHolds: [entry] }).persistedHolds.length, 1)
  const at = 'continuation.persistedHolds[0]'
  refusesWith({ ...valid, persistedHolds: ['x'] }, at)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, id: 'hold_1' }] }, `${at}.id`)
  const { runbookOnly: dropped, ...missingKey } = entry
  assert.equal(dropped, false)
  refusesWith({ ...valid, persistedHolds: [missingKey] }, `${at}.runbookOnly`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, kind: 'not_a_kind' }] }, `${at}.kind`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, fingerprint: ' ' }] }, `${at}.fingerprint`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, confirmable: 'yes' }] }, `${at}.confirmable`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, notConfirmableReason: 'phase_2' }] }, `${at}.notConfirmableReason`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, confirmable: false, notConfirmableReason: 'nope' }] }, `${at}.notConfirmableReason`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, shapeToken: 'no_shape' }] }, `${at}.shapeToken`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, continuationId: 7 }] }, `${at}.continuationId`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, subject: null }] }, `${at}.subject`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, detail: [] }] }, `${at}.detail`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, runbookOnly: 1 }] }, `${at}.runbookOnly`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, continuationRoots: { oldRootKey: 'a' } }] }, `${at}.continuationRoots`)
  refusesWith({ ...valid, persistedHolds: [{ ...entry, continuationRoots: { oldRootKey: 'a', newRootKey: 'b', extra: 1 } }] }, `${at}.continuationRoots`)
  refusesWith({ ...valid, persistedHolds: [entry, { ...entry }] }, 'continuation.persistedHolds[1].fingerprint')
})

test('PC-RE-1 pilot exit: a persisted continuation_candidate is re-emitted with its STORED fingerprint, the plan stays suspended, and the copy is neither ADDed nor the old rows swept (P3-H8; the control without it would write both)', async () => {
  const { sheet, expansion, a01 } = await confirmedStory()
  const candidate = holdOf(a01, 'continuation_candidate')
  const entry = persistedFrom(candidate)
  const exited = F.plan(expansion, sheet, { continuation: F.continuationInput({ pilot: false, demandEvidence: expansion.demandEvidence, persistedHolds: [entry] }) })
  const reemitted = holdOf(exited, 'continuation_candidate')
  assert.equal(reemitted.fingerprint, candidate.fingerprint)
  assert.equal(exited.suspended, true)
  assert.equal(exited.valid, false)
  assert.deepEqual(exited.continuation.holds, { count: 1, confirmable: 1, kinds: { continuation_candidate: 1 } })
  assert.deepEqual(writesOn(exited, underPath(['P-001', 'S-001'])), [], 'no ADD of the P-001 > S-001 copy')
  assert.deepEqual(writesOn(exited, underPath(['S-001'])), [], 'no INACTIVE of the old S-001 rows')
  // The control: the same non-pilot computation WITHOUT the persisted hold would ADD the copy and sweep the old rows.
  const control = F.plan(expansion, sheet, { continuation: F.continuationInput({ pilot: false, demandEvidence: expansion.demandEvidence }) })
  assert.equal(control.suspended, false)
  assert.ok(writesOn(control, underPath(['P-001', 'S-001'])).length >= 4)
  assert.ok(writesOn(control, underPath(['S-001'])).length >= 4)
  // Pilot still ON: detection re-creates the same hold; the persisted copy is NOT re-emitted twice (one hold).
  const stillPilot = F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence, persistedHolds: [entry] }) })
  assert.equal(stillPilot.holds.filter((hold) => hold.fingerprint === candidate.fingerprint).length, 1)
})

test('PC-RE-2 an escalated (runbook-only) relationship hold whose body no longer hashes to its fingerprint is re-emitted with the STORED fingerprint — pilot or not — and never through makeHold (R-6)', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const switched = governedPlan(expansion, sheet, header, members, { sourceIdentity: { ...F.SOURCE_IDENTITY, readPlanDigest: 'c'.repeat(64) } })
  const reconfirm = holdOf(switched, 'relationship_reconfirm')
  assert.equal(reconfirm.confirmable, true)
  // The store's escalate UPDATE (endContinuation escalate_special_repair): confirmable false, specialist_repair,
  // runbook_only true, fingerprint NOT recomputed. The continuation is ENDED, so it is not in the planner slice.
  const escalated = persistedFrom(reconfirm, {
    runbookOnly: true, confirmable: false, notConfirmableReason: 'specialist_repair',
    continuationRoots: { oldRootKey: header.oldRootKey, newRootKey: header.newRootKey },
  })
  const body = pairingCore.__internals.reemittedHold(escalated)
  assert.notEqual(pairingCore.holdFingerprint(body), escalated.fingerprint, 'the escalated body no longer hashes to its stored fingerprint')
  for (const pilot of [false, true]) {
    const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ pilot, demandEvidence: expansion.demandEvidence, persistedHolds: [escalated] }) })
    const runbook = planned.holds.filter((hold) => hold.kind === 'relationship_reconfirm')
    assert.equal(runbook.length, 1, `pilot=${pilot}`)
    assert.equal(runbook[0].fingerprint, escalated.fingerprint, 'the stored fingerprint, verbatim')
    assert.equal(runbook[0].confirmable, false)
    assert.equal(runbook[0].notConfirmableReason, 'specialist_repair')
    assert.equal(planned.suspended, true)
    // PC-RE-5: the ended relationship's subtrees stay protected through its roots: no copy, no sweep.
    assert.deepEqual(writesOn(planned, underPath(['P-001', 'S-001'])), [], `pilot=${pilot}: no ADD of the copy`)
    assert.deepEqual(writesOn(planned, underPath(['S-001'])), [], `pilot=${pilot}: no INACTIVE of the old rows`)
  }
})

test('PC-RE-3/4/6 the displayed plan after pilot exit never contradicts a re-emitted hold: a dropped head\'s copy is not ADDed, an occupied candidate position is not revived, and a non-detection hold kind is NOT re-emitted', async () => {
  // RE-4 dropped head (first pull with S-001 AND P-001): pilot holds it; after exit the persisted hold keeps the copy out.
  const firstPull = await F.expand(F.secondPullSource())
  const pilotPlan = F.plan(firstPull, [], { continuation: F.continuationInput({ demandEvidence: firstPull.demandEvidence }) })
  const dropped = holdOf(pilotPlan, 'dropped_order_head_unresolved')
  assert.deepEqual(writesOn(pilotPlan, underPath(['P-001', 'S-001'])), [], 'pilot: the dropped head\'s copy is not ADDed in the displayed plan (O-7 display)')
  const exitedHead = F.plan(firstPull, [], { continuation: F.continuationInput({ pilot: false, demandEvidence: firstPull.demandEvidence, persistedHolds: [persistedFrom(dropped)] }) })
  assert.equal(holdOf(exitedHead, 'dropped_order_head_unresolved').fingerprint, dropped.fingerprint)
  assert.equal(exitedHead.suspended, true)
  assert.deepEqual(writesOn(exitedHead, underPath(['P-001', 'S-001'])), [])
  // RE-6 an occupied candidate position (an inactive tombstone at P-001 > S-001): never revived, pilot or exited.
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  const target = expansion.rows.find((row) => row.componentSourceId === 'S-001' && row.path.startsWith('["P-001"'))
  const tombstone = F.withRecordRef({ ...target, active: false }, 'rec_tomb_s', 3)
  const occupiedPilot = F.plan(expansion, sheet.concat([tombstone]), { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const occupiedHold = holdOf(occupiedPilot, 'candidate_target_occupied')
  const exitedOccupied = F.plan(expansion, sheet.concat([tombstone]), { continuation: F.continuationInput({ pilot: false, demandEvidence: expansion.demandEvidence, persistedHolds: [persistedFrom(occupiedHold)] }) })
  for (const planned of [occupiedPilot, exitedOccupied]) {
    assert.equal(planned.suspended, true)
    assert.deepEqual(writesOn(planned, underPath(['P-001', 'S-001'])), [], 'no ADD and no revive under the occupied position')
    assert.deepEqual(writesOn(planned, underPath(['S-001'])), [], 'no INACTIVE of the old rows')
  }
  // A persisted hold of a kind only VERIFICATION produces (relationship_reconfirm, not runbook-only) is NOT
  // re-emitted after exit: verification re-derives it from the continuation, which is still in the slice.
  const { header, members } = await confirmedStory()
  const verification = holdOf(governedPlan(expansion, sheet, header, members, { sourceIdentity: { ...F.SOURCE_IDENTITY, readPlanDigest: 'd'.repeat(64) } }), 'relationship_reconfirm')
  const notReemitted = F.plan(expansion, sheet, { continuation: F.continuationInput({ pilot: false, demandEvidence: expansion.demandEvidence, persistedHolds: [persistedFrom(verification)] }) })
  assert.equal(notReemitted.holds.some((hold) => hold.fingerprint === verification.fingerprint), false)
  // A pilot content change persisted before exit IS re-emitted (its kind/reason is pilot-detection only).
  assert.equal(pairingCore.__internals.shouldReemitPersistedHold({ kind: 'content_change', detail: { reason: 'plm_system_refresh' }, runbookOnly: false }, false), true)
  assert.equal(pairingCore.__internals.shouldReemitPersistedHold({ kind: 'content_change', detail: { reason: 'component_identity_conflict' }, runbookOnly: false }, false), false)
  assert.equal(pairingCore.__internals.shouldReemitPersistedHold({ kind: 'continuation_candidate', detail: {}, runbookOnly: false }, true), false, 'pilot on: detection owns it')
})

test('PC-P1 (O-3, TD-13) on a pilot project a trigger-field change is held even with conflictStrategy.refreshPlmSystemFields off (the strategy no longer gates detection)', async () => {
  const { sheet, expansion, header, members } = await confirmedStory()
  const afterApply = F.applyToSheet(governedPlan(expansion, sheet, header, members), sheet, { idPrefix: 'rec_p' })
  // A NON-identity trigger change (N-001's order quantity 1 -> 3): only the plm_system_refresh path detects it
  // (an identity field would be held through component_identity_conflict whatever the strategy).
  const changed = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 10 }, { part: 'N-001', qty: 3 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'S-001', usage: 2 }], ...F.S_BOMS },
  }))
  const strategyOff = F.plan(changed, afterApply, {
    conflictStrategy: { refreshPlmSystemFields: false },
    continuation: F.continuationInput({ demandEvidence: changed.demandEvidence, continuations: [header], members }),
  })
  const hold = holdOf(strategyOff, 'content_change')
  assert.equal(hold.detail.reason, 'plm_system_refresh')
  assert.deepEqual(Object.keys(hold.detail.fields).sort(), ['rawQuantity', 'totalQuantity'])
  assert.equal(strategyOff.suspended, true)
  assert.equal(F.byDecision(strategyOff, DECISIONS.UPDATE).length, 0, 'the strategy still decides the decision; detection is independent of it')
})

test('PC-P2 (O-4, TD-14) a keep_multiple_rows duplicate group resolved AT a continued new position is never ADDed (the ::duplicate: suffix is stripped before every lookup and in the post-condition)', async () => {
  const { sheet, header, members } = await confirmedStory()
  const doubled = await F.expand(F.secondPullSource({ boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }, { part: 'PART-B', usage: 9 }] } }))
  const partB = members.find((member) => member.componentSourceId === 'PART-B')
  const review = { selectedPolicies: [{ fingerprint: stableFingerprint(partB.newKey), policy: 'keep_multiple_rows', scope: 'run_only' }] }
  const planned = F.plan(doubled, sheet, {
    duplicatePolicyReview: review,
    continuation: F.continuationInput({ demandEvidence: doubled.demandEvidence, continuations: [header], members }),
  })
  const resolved = planned.decisions.filter((decision) => decision.idempotencyKey.startsWith(`${partB.newKey}::duplicate:`))
  assert.equal(resolved.length, 2, 'the group WAS resolved into two suffixed keys (the fixture exercises the strip)')
  assert.ok(resolved.every((decision) => decision.decision === DECISIONS.SKIP && decision.conflictSummary.type === 'continued_by_relationship'))
  // The post-condition compares base keys: a resolved ADD at a continued position is a violation by itself.
  const projection = pairingCore.buildContinuationProjection([header], members)
  assert.throws(() => pairingCore.assertContinuationPostCondition([{ decision: DECISIONS.ADD, idempotencyKey: resolved[0].idempotencyKey }], { projection }),
    (error) => error.code === CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
})

test('PC-P3 (O-5, TD-15) the displayed plan: an occupant at a candidate position is SKIPped (no revive UPDATE), and a dropped head\'s old rows are not swept', async () => {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource())
  for (const occupiedComponent of ['S-001', 'PART-C']) {
    const target = expansion.rows.find((row) => row.componentSourceId === occupiedComponent && row.path.startsWith('["P-001"'))
    const tombstone = F.withRecordRef({ ...target, active: false }, `rec_tomb_${occupiedComponent}`, 3)
    const planned = F.plan(expansion, sheet.concat([tombstone]), { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
    assert.equal(planned.counts.update, 0, `${occupiedComponent}: the tombstone is not revived inside a suspended plan`)
    const atTombstone = planned.decisions.filter((decision) => decision.idempotencyKey === target.idempotencyKey)
    assert.deepEqual(atTombstone.map((decision) => `${decision.decision}:${decision.conflictSummary.type}`), ['skip:suspended_continuation_candidate'])
  }
  // A head dropped as "a child elsewhere" and expanded NOWHERE, with old rows: the old rows are protected.
  const nowhere = await F.expand(F.project({
    orders: [{ part: 'P-001', qty: 5 }, { part: 'S-001', qty: 10 }],
    parts: F.PARTS.slice(),
    boms: { 'P-001': [{ part: 'N-001', usage: 1 }], ...F.S_BOMS },
  }))
  const droppedPlan = F.plan(nowhere, sheet, { continuation: F.continuationInput({ demandEvidence: nowhere.demandEvidence }) })
  holdOf(droppedPlan, 'dropped_order_head_unresolved')
  assert.equal(droppedPlan.counts.inactive, 0, 'the dropped head\'s old rows are not swept in the displayed plan')
  // An EXTRA row under a continued old subtree (not a member: landed after the confirm) while the relationship
  // fails verification: protected with the subtree (TD-15(ii)), never swept inside the suspended plan.
  const story = await confirmedStory()
  const oldRoot = story.sheet.find((row) => row.componentSourceId === 'S-001')
  const extra = F.withRecordRef({
    ...oldRoot,
    componentSourceId: 'PART-X',
    parentSourceId: 'S-001',
    path: JSON.stringify(['S-001', 'PART-X']),
    idempotencyKey: JSON.stringify({ projectNo: F.PROJECT_NO, componentSourceId: 'PART-X', parentSourceId: 'S-001', path: ['S-001', 'PART-X'] }),
  }, 'rec_extra_x', 1)
  const failing = governedPlan(story.expansion, story.sheet.concat([extra]), story.header, story.members, { pilot: false, sourceIdentity: { ...F.SOURCE_IDENTITY, readPlanDigest: 'e'.repeat(64) } })
  assert.deepEqual(failing.continuation.verdicts, { [story.header.id]: 'source_scope_changed' })
  const atExtra = failing.decisions.filter((decision) => decision.idempotencyKey === extra.idempotencyKey)
  assert.deepEqual(atExtra.map((decision) => `${decision.decision}:${decision.conflictSummary.type}`), ['skip:suspended_continuation_candidate'])
  assert.equal(failing.counts.inactive, 0)
  // The extra row ALONE already breaks the pairing (the old closure gained a row): structure_changed, and the
  // same protection holds without any other change.
  const extraOnly = governedPlan(story.expansion, story.sheet.concat([extra]), story.header, story.members, { pilot: false })
  assert.deepEqual(extraOnly.continuation.verdicts, { [story.header.id]: 'structure_changed' })
  assert.equal(extraOnly.decisions.filter((decision) => decision.idempotencyKey === extra.idempotencyKey)[0].decision, DECISIONS.SKIP)
  assert.equal(extraOnly.counts.inactive, 0)
  // The post-condition forbids an UPDATE at an occupied candidate key, and compares base keys.
  const projection = pairingCore.buildContinuationProjection([], [])
  assert.throws(() => pairingCore.assertContinuationPostCondition([{ decision: DECISIONS.UPDATE, idempotencyKey: 'k_occ' }], { projection, candidateOccupiedKeys: new Map([['k_occ', 'h']]) }),
    (error) => error.code === CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
  assert.throws(() => pairingCore.assertContinuationPostCondition([{ decision: DECISIONS.ADD, idempotencyKey: 'k_new::duplicate:pathParent:abc' }], { projection, candidateSuppressAddKeys: new Map([['k_new', 'h']]) }),
    (error) => error.code === CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
})

test('PC-P4 (O-6) a component held both as an active root still ordered AND as an active nested copy raises candidate_shape_unresolved / old_root_still_ordered instead of being filtered out', async () => {
  const sheet = await F.firstPullSheet()
  const kept = await F.expand(F.secondPullSource(), { rootSelection: { enabled: false } })
  const copy = kept.rows.filter((row) => row.path.startsWith('["P-001","S-001"')).map((row, index) => F.withRecordRef({ ...row }, `rec_twocopy_${index}`, 1))
  assert.equal(copy.length, 4)
  const planned = F.plan(kept, sheet.concat(copy), { continuation: F.continuationInput({ demandEvidence: kept.demandEvidence }) })
  const hold = holdOf(planned, 'candidate_shape_unresolved')
  assert.equal(hold.shapeToken, 'old_root_still_ordered')
  assert.equal(hold.confirmable, false)
  assert.equal(planned.suspended, true)
  assert.deepEqual(writesOn(planned, underPath(['P-001', 'S-001'])), [], 'the nested copy is not patched inside the suspended plan')
})

test('PC-P5 (O-7) inactive remnants + a head dropped by a base rule and expanded under P-001: held (only ACTIVE root rows count), suspended, and the copy is not ADDed', async () => {
  const remnants = (await F.firstPullSheet()).map((row) => F.withRecordRef({ ...row, active: false }, `${row[EXISTING_ROW_RECORD_REF].id}_r`, 2))
  const expansion = await F.expand(F.secondPullSource())
  const planned = F.plan(expansion, remnants, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence }) })
  const hold = holdOf(planned, 'dropped_order_head_unresolved')
  assert.equal(hold.detail.componentSourceId, 'S-001')
  assert.equal(planned.suspended, true)
  assert.deepEqual(writesOn(planned, underPath(['P-001', 'S-001'])), [], 'no ADD of the copy')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-continuation-planner.test.cjs', tests)
