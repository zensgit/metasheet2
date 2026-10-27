'use strict'

// Batch-refresh step 5, PR-8 — THE CHANGE PLAN IN THE PLANNER (pure; design §10.3 (2), §6.4; plan §3.4 实施细则;
// refutation M2 / M3 / M4 / note 1 / note 5). Real expansions over the canonical synthetic S/P fixtures, the REAL
// planner, the REAL pairing core.
//
//   CP-P01 the record set from the holds (content_change and relationship pairs), the S-ROOT RULE (raw := the derived
//          root total, never the parent edge), refusals (unbound record, a record described twice differently).
//   CP-P02 the plan fingerprint: write fields only, raw values, no version / continuation id / review-only field; moves
//          on any before / after / key / source digest; stable through a JSON round trip (JSONB) of the holds.
//   CP-P03 the POST-CHANGE pair equals what the verification computes after the after-values are written (a
//          relationship) — and the candidate's equals the relationship's after the combined confirm (note 5).
//   CP-P04 two passes: a matching plan => no content hold, the plan's UPDATEs (identity, quantity, continued old rows),
//          `matches`; an extra / missing / different change, a moved source, an unstamped relationship => `stale` with
//          the first pass's holds; the pilot-exit leg (M4: detection kept on for the plan's records).
//   CP-P05 the post-condition: the ONE exemption (an authorized change-plan UPDATE on a continued OLD key, patch within
//          the plan's fields + RUN); ADD / INACTIVE / new-key UPDATE / an extra field / another plan id / a
//          non-authorized key all throw.
//   CP-P06 A12 / E-4: a person's cell (and the record versions) moved after the confirm => still `matches`; a machine
//          cell moved on the sheet => `stale`.
//   CP-P07 `changePlan: null` is exactly today's governed plan (deep-equal); not governed stays byte-identical.
//   CP-P08 the change-plan UPDATE patches ONLY the plan's fields + RUN (never `active`: an inactive row's identity change
//          is not revived by it — note 1).
//   CP-NORM the review digest of the plan's after values equals the digest of what the REAL writer stores (numeric
//          strings, booleans, unicode, null), read back through the project-scoped reader.
//   CP-P09 review fix N3 (C06): a cell the latest review left on a row, moved on the sheet together with the source
//          (sheet = source, V8PG-15), is held `reviewed_content_moved` (before = the reviewed value, after = the source),
//          pilot or not; the plan confirmed from it matches and authorizes one UPDATE; no false positive, no duplicate.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const F = require('./support/stock-preparation-continuation-fixtures.cjs')
const LIB = path.join(__dirname, '..', 'lib')
const plannerModule = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { normalizeStockPreparationTemplate, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const { DECISIONS, EXISTING_ROW_RECORD_REF, CHANGE_PLAN_UPDATE_TYPE, RUN_FIELD_IDS } = plannerModule
const TEMPLATE_FIELDS = plannerModule.__internals.fieldMapForTemplate(normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SRC_1 = 'src_cpp_1'
const SRC_2 = 'src_cpp_2'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function changePlanUpdates(planned) {
  return planned.decisions.filter((decision) => decision.conflictSummary && decision.conflictSummary.type === CHANGE_PLAN_UPDATE_TYPE)
}

function contentHolds(planned) {
  return (planned.holds || []).filter(pairing.isContentClassHold)
}

// The plan input a confirm of `holds` would hand the planner (the lane's `changePlanInputFor`).
function planInputFor(holds, { projectNo = F.PROJECT_NO, sourceContentDigest = SRC_1, currentSourceContentDigest = sourceContentDigest, id = 'chp_cpp_1' } = {}) {
  const records = pairing.changePlanRecordsFromHolds(holds.filter(pairing.isContentClassHold))
  return {
    id,
    planFingerprint: pairing.changePlanFingerprintOf({ projectNo, records, sourceContentDigest }),
    currentSourceContentDigest,
    recordIds: records.map((record) => record.recordId),
  }
}

async function contentRead({ material = 'M-ALU', partCUsage = 5 } = {}) {
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: material } : part))
  return F.expand(F.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: partCUsage }] } }))
}

function plan(expansion, sheet, continuation) {
  return F.plan(expansion, sheet, { continuation: F.continuationInput({ demandEvidence: expansion.demandEvidence, ...continuation }) })
}

// A CONFIRMED relationship (the canonical candidate) and a read in which PART-B's material changed inside the subtree.
async function relationshipStory({ material = 'M-ALU', edge = 2 } = {}) {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource({ edge }))
  const a01 = plan(expansion, sheet, {})
  const candidate = a01.holds.find((hold) => hold.kind === 'continuation_candidate' || hold.kind === 'candidate_content_differs')
  const { header, members } = F.continuationFromHold(candidate)
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-B' ? { ...part, Material: material } : part))
  const changed = await F.expand(F.secondPullSource({ edge, parts }))
  return { sheet, expansion, candidate, header, members, changed }
}

// ── CP-P01 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P01 the record set: content_change rows, relationship pairs, the S-root rule (raw := the derived root total, never the edge), refusals', async () => {
  const sheet = await F.firstPullSheet()
  const planned = plan(await contentRead(), sheet, {})
  const content = contentHolds(planned)
  assert.deepEqual(content.map((hold) => hold.kind).sort(), ['content_change', 'content_change'])
  const records = pairing.changePlanRecordsFromHolds(content)
  assert.equal(records.length, 2)
  const byField = Object.fromEntries(records.map((record) => [Object.keys(record.fields).sort().join('+'), record]))
  assert.deepEqual(byField.material.fields.material, { before: 'M-STEEL', after: 'M-ALU' })
  assert.deepEqual(byField['rawQuantity+totalQuantity'].fields.rawQuantity, { before: 4, after: 5 })
  for (const record of records) {
    assert.equal(record.inContinuation, null)
    assert.ok(/^rec_s_/.test(record.recordId))
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'humanColumnsPresent'), false, 'the record set carries no human observation')
  }
  // The S-root rule on the candidate content hold (edge 3: the new root total 5 x 3 = 15; the old order quantity 10).
  const story = await relationshipStory({ edge: 3 })
  assert.equal(story.candidate.kind, 'candidate_content_differs')
  const candidateRecords = pairing.changePlanRecordsFromHolds([story.candidate])
  const root = candidateRecords.find((record) => record.root)
  assert.deepEqual(root.fields.totalQuantity, { before: 10, after: 15 })
  assert.deepEqual(root.fields.rawQuantity, { before: 10, after: 15 }, 'raw := the derived root total (never the parent edge 3)')
  assert.ok(candidateRecords.every((record) => record.inContinuation === null))
  // Refusals.
  const unbound = clone(content[0])
  unbound.detail.recordId = null
  assert.throws(() => pairing.changePlanRecordsFromHolds([unbound]), (error) => error.details.reason === 'record_unbound')
  const twice = clone(content[0])
  twice.fingerprint = 'x'.repeat(64)
  twice.detail.fields = { material: { before: 'M-STEEL', after: 'M-OTHER' } }
  assert.throws(() => pairing.changePlanRecordsFromHolds([content[0], twice]), (error) => error.details.reason === 'record_conflict')
  assert.throws(() => pairing.changePlanRecordsFromHolds([{ kind: 'structure_change', detail: {} }]), (error) => error.details.reason === 'not_content_class')
})

// ── CP-P02 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P02 the plan fingerprint: write fields only, no version / continuation id / review-only field; moves on before / after / key / source; JSON-round-trip stable (unicode, numeric strings, null, 0, false)', () => {
  const record = (fields, extra = {}) => ({ recordId: 'rec_1', key: 'k_1', root: false, inContinuation: null, fields, ...extra })
  const base = [record({ material: { before: 'M-1', after: 'M-2' } })]
  const fp = (records, digest = SRC_1) => pairing.changePlanFingerprintOf({ projectNo: 'P', records, sourceContentDigest: digest })
  const reference = fp(base)
  assert.equal(fp([record({ material: { before: 'M-1', after: 'M-2' } }, { inContinuation: 'cont_x', version: 9 })]), reference, 'continuation id / version do not move it')
  assert.equal(fp([record({ material: { before: 'M-1', after: 'M-2' }, notes: { before: 'a', after: 'a', reviewOnly: true, baseline: 'z' } })]), reference, 'a review-only field is not in the fingerprint')
  assert.notEqual(fp([record({ material: { before: 'M-0', after: 'M-2' } })]), reference)
  assert.notEqual(fp([record({ material: { before: 'M-1', after: 'M-3' } })]), reference)
  assert.notEqual(fp([{ ...base[0], key: 'k_2' }]), reference)
  assert.notEqual(fp(base, SRC_2), reference, 'another source revision')
  assert.notEqual(pairing.changePlanFingerprintOf({ projectNo: 'Q', records: base, sourceContentDigest: SRC_1 }), reference)
  // JSONB round trip of the cells the store reads back.
  const awkward = [record({ componentName: { before: '支架', after: '支架（新）' }, rawQuantity: { before: '2', after: 3 }, componentSpec: { before: null, after: '' }, totalQuantity: { before: 0, after: 0.5 }, active: { before: false, after: true } })]
  assert.equal(fp(JSON.parse(JSON.stringify(awkward))), fp(awkward))
  // Key order inside the cells does not matter (canonical JSON).
  assert.equal(fp([record({ material: { after: 'M-2', before: 'M-1' } })]), reference)
})

// ── CP-P03 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P03 the post-change pair equals the verification AFTER the write; the candidate\'s equals the relationship\'s after the combined confirm (note 5)', async () => {
  const story = await relationshipStory()
  const pass = plan(story.changed, story.sheet, { continuations: [story.header], members: story.members })
  const hold = pass.holds.find((entry) => entry.kind === 'relationship_content_change')
  assert.ok(hold, `holds: ${pass.holds.map((entry) => entry.kind)}`)
  const post = hold.detail.postChange
  // Write the after values onto the old rows (what the controlled update does), re-stamp, verify again.
  const records = pairing.changePlanRecordsFromHolds([hold])
  const written = story.sheet.map((row) => {
    const ref = pairing.recordRefOf(row)
    const entry = records.find((candidate) => candidate.recordId === ref.id)
    if (!entry) return row
    const after = Object.fromEntries(Object.entries(entry.fields).map(([field, cell]) => [field, cell.after]))
    return F.withRecordRef({ ...row, ...after }, ref.id, ref.version + 1)
  })
  const stamped = { ...story.header, comparisonFingerprint: post.comparisonFingerprint, evidenceFingerprint: post.evidenceFingerprint, revision: 2 }
  const afterWrite = plan(story.changed, written, { continuations: [stamped], members: story.members })
  assert.equal(afterWrite.continuation.verdicts[stamped.id], 'valid', 'the post-change stamp verifies valid once the values are written')
  assert.equal((afterWrite.holds || []).length, 0)
  // Without the stamp (the CURRENT fingerprints, M-CP10's shape) the written state would verify evidence_changed.
  const unstamped = plan(story.changed, written, { continuations: [story.header], members: story.members })
  assert.notEqual(unstamped.continuation.verdicts[story.header.id], 'valid')
  // Note 5: a candidate content hold's post-change pair == the relationship's post-change pair after the combined
  // confirm (the next computation's relationship_content_change for the same change).
  const edge3 = await relationshipStory({ edge: 3 })
  assert.equal(edge3.candidate.kind, 'candidate_content_differs')
  const combined = { ...F.continuationFromHold(edge3.candidate).header, comparisonFingerprint: edge3.candidate.detail.postChange.comparisonFingerprint, evidenceFingerprint: edge3.candidate.detail.postChange.evidenceFingerprint }
  const next = plan(edge3.expansion, edge3.sheet, { continuations: [combined], members: F.continuationFromHold(edge3.candidate).members })
  const relationshipHold = next.holds.find((entry) => entry.kind === 'relationship_content_change')
  assert.ok(relationshipHold, `holds: ${next.holds.map((entry) => entry.kind)}`)
  assert.deepEqual(relationshipHold.detail.postChange, edge3.candidate.detail.postChange)
})

// ── CP-P04 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P04 two passes: a matching plan authorizes exactly its changes (identity, quantity, continued old rows); any drift is stale with the first pass\'s holds; pilot exit keeps detection for the plan\'s records (M4)', async () => {
  // Non-continued: material (identity) + PART-C usage (quantity).
  const sheet = await F.firstPullSheet()
  const read = await contentRead()
  const pass1 = plan(read, sheet, {})
  const changePlan = planInputFor(pass1.holds)
  const pass2 = plan(read, sheet, { changePlan })
  assert.equal(pass2.continuation.changePlan.verdict, 'matches')
  assert.equal(pass2.continuation.changePlan.id, 'chp_cpp_1')
  assert.equal(pass2.continuation.changePlan.recordCount, 2)
  assert.equal(pass2.continuation.changePlan.authorizedUpdates, 2)
  assert.equal(contentHolds(pass2).length, 0)
  assert.equal(pass2.suspended, false)
  assert.equal(pass2.counts[DECISIONS.MANUAL_CONFIRM], 0, 'the identity conflict became the plan\'s UPDATE')
  const updates = changePlanUpdates(pass2)
  assert.equal(updates.length, 2)
  for (const update of updates) {
    assert.equal(update.decision, DECISIONS.UPDATE)
    assert.equal(update.conflictSummary.changePlanId, 'chp_cpp_1')
  }
  assert.equal(JSON.stringify(pass2.summary.continuation.changePlan), JSON.stringify(pass2.continuation.changePlan), 'the values-free stanza rides the summary too')
  // Drifts => stale, the first pass's holds stand, no change-plan UPDATE.
  for (const [label, read2, input] of [
    ['a further change', await contentRead({ partCUsage: 6 }), changePlan],
    ['a change reverted', await contentRead({ material: 'M-STEEL' }), changePlan],
    ['another source revision', read, { ...changePlan, currentSourceContentDigest: SRC_2 }],
  ]) {
    const result = plan(read2, sheet, { changePlan: input })
    assert.equal(result.continuation.changePlan.verdict, 'stale', label)
    assert.equal(changePlanUpdates(result).length, 0, label)
    assert.equal(result.suspended, contentHolds(result).length > 0, label)
  }
  // The pilot exit (M4): pilot false, the plan's records keep content detection => pass 1 finds the plan => matches.
  const exited = plan(read, sheet, { pilot: false, changePlan })
  assert.equal(exited.continuation.changePlan.verdict, 'matches')
  assert.equal(changePlanUpdates(exited).length, 2)
  // ... and without the plan the non-pilot plan would NOT detect the quantity change (O-11, the stated asymmetry).
  const exitedNoPlan = plan(read, sheet, { pilot: false })
  assert.equal(exitedNoPlan.holds.filter((hold) => hold.kind === 'content_change' && hold.detail.reason === 'plm_system_refresh').length, 0)
  // Continued: a relationship content change matched => UPDATEs on the OLD rows, zero ADD / INACTIVE on the subtree.
  const story = await relationshipStory()
  const r1 = plan(story.changed, story.sheet, { continuations: [story.header], members: story.members })
  const hold = r1.holds.find((entry) => entry.kind === 'relationship_content_change')
  const stamped = { ...story.header, comparisonFingerprint: hold.detail.postChange.comparisonFingerprint, evidenceFingerprint: hold.detail.postChange.evidenceFingerprint, revision: 2 }
  const relationshipPlan = planInputFor(r1.holds)
  const r2 = plan(story.changed, story.sheet, { continuations: [stamped], members: story.members, changePlan: relationshipPlan })
  assert.equal(r2.continuation.changePlan.verdict, 'matches')
  const oldKeys = new Set(story.members.map((member) => member.oldKey))
  const continuedUpdates = changePlanUpdates(r2)
  assert.ok(continuedUpdates.length >= 1 && continuedUpdates.every((update) => oldKeys.has(update.idempotencyKey)), 'on the OLD keys')
  for (const update of continuedUpdates) {
    for (const field of Object.keys(update.patch)) assert.ok(field === 'material' || RUN_FIELD_IDS.includes(field), `patch field ${field}`)
  }
  const newKeys = new Set(story.members.map((member) => member.newKey))
  assert.equal(r2.decisions.filter((decision) => [DECISIONS.ADD, DECISIONS.INACTIVE].includes(decision.decision) && (oldKeys.has(decision.idempotencyKey) || newKeys.has(decision.idempotencyKey))).length, 0)
  // An UNSTAMPED relationship (the confirm's re-stamp missing — M-CP11's shape) => stale.
  const unstamped = plan(story.changed, story.sheet, { continuations: [story.header], members: story.members, changePlan: relationshipPlan })
  assert.equal(unstamped.continuation.changePlan.verdict, 'stale')
  assert.equal(unstamped.continuation.changePlan.reason, 'relationship_not_stamped')
  // A plan that names the right records but a different change set (any confirmed plan authorizes NOTHING else — M-CP12).
  const wrong = plan(read, sheet, { changePlan: { ...changePlan, planFingerprint: 'f'.repeat(64) } })
  assert.equal(wrong.continuation.changePlan.verdict, 'stale')
  assert.equal(changePlanUpdates(wrong).length, 0)
})

// ── CP-P05 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P05 the post-condition: the ONE exemption (an authorized UPDATE on a continued OLD key within the plan\'s fields + RUN); everything else around it throws', async () => {
  const story = await relationshipStory()
  const r1 = plan(story.changed, story.sheet, { continuations: [story.header], members: story.members })
  const hold = r1.holds.find((entry) => entry.kind === 'relationship_content_change')
  const verdict = pairing.changePlanAuthorizationOf({ input: pairing.normalizeContinuationInput(F.continuationInput({ continuations: [{ ...story.header, comparisonFingerprint: hold.detail.postChange.comparisonFingerprint, evidenceFingerprint: hold.detail.postChange.evidenceFingerprint }], members: story.members, changePlan: planInputFor(r1.holds) })), holds: r1.holds })
  assert.equal(verdict.verdict, 'matches')
  const authorization = verdict.authorization
  const projection = pairing.buildContinuationProjection([story.header], story.members)
  const [oldKey, entry] = Array.from(authorization.continuedOldKeys.entries())[0]
  const good = plannerModule.__internals.makeChangePlanUpdateDecision(oldKey, entry, 'run', '2026-10-27T00:00:00.000Z', [], authorization.changePlanId)
  pairing.assertContinuationPostCondition([good], { projection, authorization })
  const violated = (decisions, options = { projection, authorization }) => assert.throws(() => pairing.assertContinuationPostCondition(decisions, options), (error) => error.code === pairing.CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED)
  violated([good], { projection, authorization: null })
  violated([{ ...good, decision: DECISIONS.INACTIVE }])
  violated([{ ...good, decision: DECISIONS.ADD, record: good.patch }])
  violated([{ ...good, patch: { ...good.patch, path: '["X"]' } }])
  violated([{ ...good, patch: { ...good.patch, active: true } }])
  violated([{ ...good, conflictSummary: { ...good.conflictSummary, changePlanId: 'chp_other' } }])
  const newKey = story.members.find((member) => member.oldKey === oldKey).newKey
  violated([{ ...good, idempotencyKey: newKey }])
  // A plain UPDATE on the continued old key (not the change-plan type) still throws (no exemption without the plan).
  violated([{ ...good, conflictSummary: { type: 'plm_system_refresh', changedFieldCount: 1 } }])
  // A change-plan UPDATE on a non-authorized (non-continued) key throws too.
  violated([{ ...good, idempotencyKey: 'k_not_authorized' }])
})

// ── CP-P06 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P06 (A12 / E-4) a person\'s edit after the confirm keeps the plan valid; a machine cell moved on the sheet makes it stale', async () => {
  const sheet = await F.firstPullSheet()
  const read = await contentRead()
  const changePlan = planInputFor(plan(read, sheet, {}).holds)
  const human = sheet.map((row) => {
    const ref = pairing.recordRefOf(row)
    return F.withRecordRef({ ...row, notes: 'synthetic person note' }, ref.id, ref.version + 3)
  })
  const afterHuman = plan(read, human, { changePlan })
  assert.equal(afterHuman.continuation.changePlan.verdict, 'matches', 'record versions and human cells are outside the plan')
  assert.equal(changePlanUpdates(afterHuman).every((update) => !Object.prototype.hasOwnProperty.call(update.patch, 'notes')), true)
  const machine = sheet.map((row) => (row.componentSourceId === 'PART-B' ? F.withRecordRef({ ...row, componentName: 'Plate (host write)' }, pairing.recordRefOf(row).id, 2) : row))
  const afterMachine = plan(read, machine, { changePlan })
  assert.equal(afterMachine.continuation.changePlan.verdict, 'stale', 'a host-side machine write is a change the plan did not confirm')
})

// ── CP-P07 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P07 `changePlan: null` is exactly today\'s governed plan; an input key outside the closed set refuses', async () => {
  const sheet = await F.firstPullSheet()
  const read = await contentRead()
  const withoutKey = F.plan(read, sheet, { continuation: F.continuationInput({ demandEvidence: read.demandEvidence }) })
  const withNull = F.plan(read, sheet, { continuation: { ...F.continuationInput({ demandEvidence: read.demandEvidence }), changePlan: null } })
  assert.deepEqual(clone(withNull), clone(withoutKey))
  assert.equal(Object.prototype.hasOwnProperty.call(withNull.continuation, 'changePlan'), false)
  assert.throws(() => F.plan(read, sheet, { continuation: F.continuationInput({ demandEvidence: read.demandEvidence, changePlan: { id: 'x', planFingerprint: 'y', currentSourceContentDigest: 'z', recordIds: [], extra: true } }) }), (error) => error.code === pairing.CONTINUATION_ERROR_CODES.INPUT_INVALID)
  assert.throws(() => F.plan(read, sheet, { continuation: F.continuationInput({ demandEvidence: read.demandEvidence, changePlan: { id: 'x', planFingerprint: 'y', currentSourceContentDigest: 'z' } }) }), (error) => error.code === pairing.CONTINUATION_ERROR_CODES.INPUT_INVALID)
  // Not governed: no continuation input at all => no step-4 / step-5 key.
  const notGoverned = F.plan(read, sheet)
  assert.equal(Object.prototype.hasOwnProperty.call(notGoverned, 'continuation'), false)
  assert.equal(changePlanUpdates(notGoverned).length, 0)
})

// ── CP-P08 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-P08 (note 1) the controlled UPDATE patches only the plan\'s fields + RUN: an inactive row\'s identity change is NOT revived by it', async () => {
  const sheet = await F.firstPullSheet()
  // PART-A inactive on the sheet, back in the read with a material change (identity): pilot => a content hold.
  const inactive = sheet.map((row) => (row.componentSourceId === 'PART-A' ? F.withRecordRef({ ...row, active: false }, pairing.recordRefOf(row).id, 2) : row))
  const read = await contentRead({ partCUsage: 4 })
  const pass1 = plan(read, inactive, {})
  const holds = contentHolds(pass1)
  assert.equal(holds.length, 1)
  assert.equal(holds[0].detail.reason, 'component_identity_conflict')
  const pass2 = plan(read, inactive, { changePlan: planInputFor(pass1.holds) })
  const update = changePlanUpdates(pass2)[0]
  assert.deepEqual(Object.keys(update.patch).filter((field) => !RUN_FIELD_IDS.includes(field)), ['material'])
  assert.equal(Object.prototype.hasOwnProperty.call(update.patch, 'active'), false, 'never revived by the plan')
  assert.equal(JSON.parse(update.patch.lastPlmConflictSummary).type, CHANGE_PLAN_UPDATE_TYPE)
})

// ── CP-NORM ──────────────────────────────────────────────────────────────────────────────────────

test('CP-NORM the review digest of the after values equals the digest of what the REAL writer stored, read back by the project-scoped reader', async () => {
  const records = [
    { recordId: 'rec_n1', key: 'k_n1', root: false, inContinuation: null, fields: { rawQuantity: { before: 2, after: '3' }, componentName: { before: 'A', after: '支架（新）' }, componentSpec: { before: 'X', after: null }, totalQuantity: { before: 1, after: 2.5 } } },
    { recordId: 'rec_n2', key: 'k_n2', root: false, inContinuation: null, fields: { material: { before: 'M', after: '' }, sourceVersion: { before: 'V1', after: 2 } } },
  ]
  const stored = records.map((record) => ({ ...record, fields: Object.fromEntries(Object.entries(record.fields).map(([field, cell]) => [field, { ...cell, afterCanonical: pairing.canonicalChangeValue(cell.after, TEMPLATE_FIELDS.get(field)) }])) }))
  const planned = pairing.plannedContentDigestOf(stored)
  // The real writer coercion: the same patch shape the planner emits, through the template normalisation.
  const rows = records.map((record) => ({ id: record.recordId, sheetId: 'sheet_norm', version: 1, data: { idempotencyKey: record.key, projectNo: 'P-NORM' } }))
  const api = {
    async queryRecords(input) { return rows.filter((row) => Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value)).map(clone) },
    async createRecord() { throw new Error('no create') },
    async patchRecord(input) { const row = rows.find((entry) => entry.id === input.recordId); row.data = { ...row.data, ...input.changes }; row.version += 1; return clone(row) },
  }
  const decisions = records.map((record) => ({ decision: DECISIONS.UPDATE, idempotencyKey: record.key, patch: Object.fromEntries(Object.entries(record.fields).map(([field, cell]) => [field, cell.after])) }))
  const result = await writer.applyStockPreparationPlan({ permission: 'write', plan: { decisions }, target: { sheetId: 'sheet_norm' }, recordsApi: api })
  assert.equal(result.status, 'succeeded')
  const read = await tableActions.__internals.readExistingStockPreparationRows(api, { sheetId: 'sheet_norm', fieldIdMap: {} }, 'P-NORM')
  const byId = new Map(read.map((row) => [row[EXISTING_ROW_RECORD_REF].id, row]))
  assert.equal(pairing.currentContentDigestOf({ records: stored, rowsByRecordId: byId, templateFields: TEMPLATE_FIELDS }), planned, 'a correctly written sheet reviews (never a wedge)')
  // A machine value moved afterwards: the digest moves (the review is STALE until the sheet holds the plan again).
  rows[0].data.rawQuantity = 4
  const moved = new Map((await tableActions.__internals.readExistingStockPreparationRows(api, { sheetId: 'sheet_norm', fieldIdMap: {} }, 'P-NORM')).map((row) => [row[EXISTING_ROW_RECORD_REF].id, row]))
  assert.notEqual(pairing.currentContentDigestOf({ records: stored, rowsByRecordId: moved, templateFields: TEMPLATE_FIELDS }), planned)
  // A record gone digests as missing, never as unchanged.
  const gone = new Map(byId)
  gone.delete('rec_n2')
  assert.notEqual(pairing.currentContentDigestOf({ records: stored, rowsByRecordId: gone, templateFields: TEMPLATE_FIELDS }), planned)
})

// ── CP-P09 (review fix N3) ───────────────────────────────────────────────────────────────────────

// The expected content of PART-A's material as the latest review left it (the store's `expectedContentOf` shape).
function expectedMaterial(row, after) {
  return [{ recordId: pairing.recordRefOf(row).id, key: row.idempotencyKey, fields: { material: { after, afterCanonical: pairing.canonicalChangeValue(after, TEMPLATE_FIELDS.get('material')) } } }]
}

test('CP-P09 (N3, C06) a reviewed cell the sheet no longer carries is HELD even when the source moved to exactly that value (V8PG-15): reason reviewed_content_moved, before = the reviewed value, after = the source; the plan cycle closes; no duplicate, no false positive', async () => {
  const sheet = await F.firstPullSheet()
  const partA = sheet.find((row) => row.componentSourceId === 'PART-A')
  // The source moved PART-A's material AND a host-side write put exactly that value into the sheet (version bumped).
  const hostWritten = sheet.map((row) => (row === partA ? F.withRecordRef({ ...row, material: 'M-N3-NEW' }, pairing.recordRefOf(row).id, 4) : row))
  const read = await contentRead({ material: 'M-N3-NEW', partCUsage: 4 })
  const expected = expectedMaterial(partA, 'M-N3-REVIEWED')
  // Without the expected content the planner sees nothing at all (the hole: sheet = source).
  const blind = plan(read, hostWritten, {})
  assert.equal(contentHolds(blind).length, 0, 'no ordinary detection fires')
  // With it: ONE content hold for PART-A's material, from the reviewed value to the source value.
  const held = plan(read, hostWritten, { expectedContent: expected })
  const holds = contentHolds(held)
  assert.equal(holds.length, 1, JSON.stringify(held.holds.map((hold) => hold.kind)))
  assert.equal(holds[0].kind, 'content_change')
  assert.equal(holds[0].detail.reason, pairing.REVIEWED_CONTENT_MOVED_REASON)
  assert.equal(holds[0].detail.recordId, pairing.recordRefOf(partA).id)
  assert.deepEqual(holds[0].detail.fields, { material: { before: 'M-N3-REVIEWED', after: 'M-N3-NEW' } })
  assert.equal(held.suspended, true)
  // Stable: the same computation again yields the same fingerprint (the hold is KEPT, never churned).
  assert.equal(contentHolds(plan(read, hostWritten, { expectedContent: expected }))[0].fingerprint, holds[0].fingerprint)
  // Pilot or not (the content under review stays under detection after a pilot exit).
  assert.equal(contentHolds(plan(read, hostWritten, { pilot: false, expectedContent: expected }))[0].detail.reason, pairing.REVIEWED_CONTENT_MOVED_REASON)
  // The plan cycle: confirmed from that hold, the next pass MATCHES and authorizes ONE UPDATE (the source value, the
  // sheet already holds it) — no hold left.
  const changePlan = planInputFor(held.holds)
  const bound = plan(read, hostWritten, { expectedContent: expected, changePlan })
  assert.equal(bound.continuation.changePlan.verdict, 'matches')
  assert.equal(contentHolds(bound).length, 0)
  const updates = changePlanUpdates(bound)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].patch.material, 'M-N3-NEW')
  // After that plan is written and reviewed, the expected content IS the sheet's: nothing is held.
  assert.equal(contentHolds(plan(read, hostWritten, { expectedContent: expectedMaterial(partA, 'M-N3-NEW') })).length, 0)
  // No false positive: the sheet still holds the reviewed value and the source agrees => nothing.
  const untouched = await contentRead({ material: 'M-N3-REVIEWED', partCUsage: 4 })
  const reviewedSheet = sheet.map((row) => (row === partA ? F.withRecordRef({ ...row, material: 'M-N3-REVIEWED' }, pairing.recordRefOf(row).id, 3) : row))
  assert.equal(contentHolds(plan(untouched, reviewedSheet, { expectedContent: expected })).length, 0)
  // No duplicate: a source that differs from the sheet is the ORDINARY hold (sheet value -> source value), alone.
  const further = await contentRead({ material: 'M-N3-OTHER', partCUsage: 4 })
  const ordinary = contentHolds(plan(further, hostWritten, { expectedContent: expected }))
  assert.equal(ordinary.length, 1)
  assert.notEqual(ordinary[0].detail.reason, pairing.REVIEWED_CONTENT_MOVED_REASON)
  assert.deepEqual(ordinary[0].detail.fields.material, { before: 'M-N3-NEW', after: 'M-N3-OTHER' })
  // A row the expected content names under ANOTHER key is not the reviewed row: nothing.
  assert.equal(contentHolds(plan(read, hostWritten, { expectedContent: [{ ...expected[0], key: '{"other":true}' }] })).length, 0)
  // A person's cell (not a trigger field) moving is never a reviewed-content move.
  const noted = hostWritten.map((row) => (pairing.recordRefOf(row).id === pairing.recordRefOf(partA).id ? F.withRecordRef({ ...row, notes: 'synthetic person note' }, pairing.recordRefOf(row).id, 5) : row))
  assert.equal(contentHolds(plan(read, noted, { expectedContent: expectedMaterial(partA, 'M-N3-NEW') })).length, 0)
  // The closed shape: an unknown key / a cell without afterCanonical refuses (a lane defect).
  for (const bad of [[{ ...expected[0], extra: 1 }], [{ ...expected[0], fields: { material: { after: 'x' } } }], [expected[0], expected[0]]]) {
    assert.throws(() => pairing.normalizeContinuationInput(F.continuationInput({ expectedContent: bad })), (error) => error.code === pairing.CONTINUATION_ERROR_CODES.INPUT_INVALID)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-change-plan-planner.test.cjs', tests)
