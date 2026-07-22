'use strict'

// General-prep-system P4 carry-policy battery. Plain node test (throws on
// failure; run with `node <file>`). Hermetic: no DB, no network, no fs. Values-
// free: fixtures use abstract identity tokens only — never a customer value.
//
// Covers the LOCKED semantics (module header) plus a MUTATION battery that pins
// the two load-bearing branches:
//   (M1) flip the 1→N branch to auto-pick        → guard/real output go RED
//   (M2) drop the confirm requirement (silent-ADD) → guard/real output go RED

const assert = require('node:assert/strict')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-carry-policy.cjs')
const {
  CARRY_KEYS,
  MANUAL_ROW_REATTACH_MODES,
  CARRY_DECISIONS,
  CARRY_WRITE_VIA,
  StockPreparationCarryPolicyError,
  normalizeCarryPolicy,
  classifyCarry,
  planCarry,
  __internals,
} = require(MODULE_PATH)

const { DECISIONS } = require('../lib/stock-preparation-conflict-planner.cjs')
const { HUMAN_PRESERVED_FIELD_IDS } = require('../lib/stock-preparation-templates.cjs')

function assertThrowsReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.ok(
    thrown instanceof StockPreparationCarryPolicyError,
    `${label}: expected StockPreparationCarryPolicyError, got ${thrown && thrown.name}`,
  )
  assert.equal(thrown.reason, reason, `${label}: expected reason ${reason}, got ${thrown.reason}`)
  return thrown
}

// A removed/inactive prior-batch row (carry SOURCE) with abstract tokens.
function removedRow(key, componentSourceId, human = {}) {
  return { idempotencyKey: key, componentSourceId, active: false, ...human }
}
function newAdd(key, componentSourceId) {
  return { idempotencyKey: key, componentSourceId, active: true }
}

function frozenVocabularies() {
  assert.ok(Object.isFrozen(CARRY_KEYS))
  assert.ok(Object.isFrozen(MANUAL_ROW_REATTACH_MODES))
  assert.ok(Object.isFrozen(CARRY_DECISIONS))
  assert.deepEqual([...CARRY_KEYS], ['idempotency_key', 'component_source_id'])
  assert.deepEqual([...MANUAL_ROW_REATTACH_MODES], ['none', 'propose_confirm'])
  assert.equal(CARRY_DECISIONS.NO_CARRY, 'no_carry')
  assert.equal(CARRY_DECISIONS.CARRY_VIA_CONFIRM, 'carry_via_confirm')
  // MANUAL_CONFIRM MUST be the planner literal so apply-writer:487 holds it.
  assert.equal(CARRY_DECISIONS.MANUAL_CONFIRM, DECISIONS.MANUAL_CONFIRM, 'carry manual_confirm == planner MANUAL_CONFIRM')
  assert.equal(CARRY_DECISIONS.MANUAL_CONFIRM, 'manual_confirm')
}

function policyNormalization() {
  // defaults: manualRowReattach defaults to 'propose_confirm' (safe — a proposal
  // writes nothing without the K2 confirm) so a bare component_source_id carry
  // reaches CARRY_VIA_CONFIRM on a single match (see bareDefaultSingleMatch).
  assert.deepEqual(normalizeCarryPolicy(undefined), { carryKey: 'idempotency_key', manualRowReattach: 'propose_confirm' })
  assert.deepEqual(normalizeCarryPolicy({}), { carryKey: 'idempotency_key', manualRowReattach: 'propose_confirm' })
  assert.deepEqual(
    normalizeCarryPolicy({ carryKey: 'component_source_id' }),
    { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' },
  )
  assert.deepEqual(
    normalizeCarryPolicy({ carryKey: 'component_source_id', manualRowReattach: 'none' }),
    { carryKey: 'component_source_id', manualRowReattach: 'none' },
  )
  assert.deepEqual(
    normalizeCarryPolicy({ carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' }),
    { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' },
  )
  // fail-closed on unknown vocab / shape / stray keys
  assertThrowsReason(() => normalizeCarryPolicy({ carryKey: 'latest_create_time' }), 'UNKNOWN_CARRY_KEY', 'bad carryKey')
  assertThrowsReason(() => normalizeCarryPolicy({ manualRowReattach: 'auto' }), 'UNKNOWN_MANUAL_ROW_REATTACH', 'bad reattach')
  assertThrowsReason(() => normalizeCarryPolicy({ createTime: 'x' }), 'UNKNOWN_CARRY_POLICY_KEY', 'stray key')
  assertThrowsReason(() => normalizeCarryPolicy('none'), 'CARRY_POLICY_NOT_OBJECT', 'string policy')
  assertThrowsReason(() => normalizeCarryPolicy([]), 'CARRY_POLICY_NOT_OBJECT', 'array policy')
}

function inputValidation() {
  assertThrowsReason(() => planCarry([], null, {}), 'NEW_ADD_ROW_INVALID', 'null newAddRow')
  assertThrowsReason(() => planCarry([], { componentSourceId: 'c1' }, {}), 'MISSING_IDEMPOTENCY_KEY', 'no key')
  assertThrowsReason(
    () => planCarry('nope', newAdd('k1', 'c1'), { carryKey: 'component_source_id' }),
    'PREV_ROWS_INVALID',
    'non-array prev rows',
  )
  // component_source_id carry needs a componentSourceId on the new row.
  assertThrowsReason(
    () => planCarry([], { idempotencyKey: 'k1', active: true }, { carryKey: 'component_source_id' }),
    'MISSING_COMPONENT_SOURCE_ID',
    'component carry without source id',
  )
  // idempotency_key path does NOT require componentSourceId (returns NO_CARRY).
  const noCarry = planCarry([], { idempotencyKey: 'k1', active: true }, {})
  assert.equal(noCarry.decision, CARRY_DECISIONS.NO_CARRY)
}

// carryKey is the SOLE driver; idempotency_key is always NO_CARRY regardless of
// reattach mode (1→1 already free via UPDATE-preserve).
function idempotencyKeyIsAlwaysNoCarry() {
  const prev = [removedRow('old-1', 'c1', { notes: 't', materialType: 'mt' })]
  for (const manualRowReattach of MANUAL_ROW_REATTACH_MODES) {
    const decision = planCarry(prev, newAdd('k-new', 'c1'), { carryKey: 'idempotency_key', manualRowReattach })
    assert.equal(decision.decision, CARRY_DECISIONS.NO_CARRY, `idempotency_key/${manualRowReattach} → NO_CARRY`)
    assert.equal(decision.reason, 'same_key_update_preserve')
    assert.equal(decision.carry, false)
  }
}

function componentSourceZeroMatch() {
  // A prior row that is still active is NOT a source; and a different source id
  // does not match. Both yield no_source_match.
  const prev = [
    { idempotencyKey: 'still-active', componentSourceId: 'c1', active: true, notes: 't' },
    removedRow('other', 'c-different', { notes: 't' }),
  ]
  const decision = planCarry(prev, newAdd('k-new', 'c1'), {
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
  })
  assert.equal(decision.decision, CARRY_DECISIONS.NO_CARRY)
  assert.equal(decision.reason, 'no_source_match')
}

function componentSourceSingleMatchProposeConfirm() {
  const prev = [removedRow('old-1', 'c1', { notes: 'n', materialType: 'mt', leadTimeDays: 5 })]
  const decision = planCarry(prev, newAdd('k-new', 'c1'), {
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
  })
  assert.equal(decision.decision, CARRY_DECISIONS.CARRY_VIA_CONFIRM, 'single match + propose_confirm → CARRY_VIA_CONFIRM')
  assert.equal(decision.requiresConfirm, true)
  assert.equal(decision.writeVia, CARRY_WRITE_VIA)
  assert.equal(decision.carry, true)
  assert.equal(decision.sourceIdempotencyKey, 'old-1')
  assert.equal(decision.componentSourceId, 'c1')
  // carryFields are NAMES from the human whitelist only — never values.
  assert.deepEqual([...decision.carryFields].sort(), ['leadTimeDays', 'materialType', 'notes'].sort())
  for (const field of decision.carryFields) {
    assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes(field), `${field} is a human-preserved field name`)
  }
  // No human VALUE is smuggled onto the decision, and no ADD-shaped record exists.
  for (const humanField of HUMAN_PRESERVED_FIELD_IDS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(decision, humanField), `decision has no ${humanField} value`)
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(decision, 'record'), 'no ADD-shaped record')
  // The decision passes the confirm-shape guard by construction.
  __internals.assertCarryViaConfirmShape(decision)
}

function bareDefaultSingleMatch() {
  // The task's plainest sentence: carryKey='component_source_id' + exactly ONE
  // match → CARRY_VIA_CONFIRM, stated with NO manualRowReattach qualifier. The
  // default ('propose_confirm') must make it true without any extra opt-in.
  const prev = [removedRow('old-1', 'c1', { notes: 'n' })]
  const decision = planCarry(prev, newAdd('k-new', 'c1'), { carryKey: 'component_source_id' })
  assert.equal(decision.decision, CARRY_DECISIONS.CARRY_VIA_CONFIRM, 'bare component_source_id single match → CARRY_VIA_CONFIRM')
  assert.equal(decision.requiresConfirm, true)
  assert.equal(decision.manualRowReattach, 'propose_confirm')
}

function componentSourceSingleMatchNoneHolds() {
  // Default reattach 'none' surfaces a hold — NOT NO_CARRY, NOT an ADD.
  const prev = [removedRow('old-1', 'c1', { notes: 'n' })]
  const decision = planCarry(prev, newAdd('k-new', 'c1'), {
    carryKey: 'component_source_id',
    manualRowReattach: 'none',
  })
  assert.equal(decision.decision, CARRY_DECISIONS.MANUAL_CONFIRM, 'single match + none → hold')
  assert.equal(decision.conflictSummary.type, 'carry_reattach_requires_confirm')
  assert.equal(decision.conflictSummary.matchCount, 1)
  assert.equal(decision.carry, false)
}

function componentSourceSingleMatchNoHumanContext() {
  // A single match whose source has no human values → nothing to carry.
  const prev = [removedRow('old-1', 'c1')]
  const decision = planCarry(prev, newAdd('k-new', 'c1'), {
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
  })
  assert.equal(decision.decision, CARRY_DECISIONS.NO_CARRY)
  assert.equal(decision.reason, 'no_human_context')
}

function componentSourceMultiMatchHolds() {
  // 1→N ambiguity: two distinct removed rows share the source id under different
  // keys. ALWAYS a hold, regardless of reattach mode. Never auto-pick.
  const prev = [
    removedRow('old-a', 'c1', { notes: 'na' }),
    removedRow('old-b', 'c1', { materialType: 'mt' }),
  ]
  for (const manualRowReattach of MANUAL_ROW_REATTACH_MODES) {
    const decision = planCarry(prev, newAdd('k-new', 'c1'), { carryKey: 'component_source_id', manualRowReattach })
    assert.equal(decision.decision, CARRY_DECISIONS.MANUAL_CONFIRM, `1→N/${manualRowReattach} → hold`)
    assert.equal(decision.conflictSummary.type, 'carry_ambiguous_component_source')
    assert.equal(decision.conflictSummary.matchCount, 2)
    assert.equal(decision.carry, false)
    // apply-writer routes this literal to `held` (no writer change needed).
    assert.equal(decision.decision, DECISIONS.MANUAL_CONFIRM)
  }
}

function sourceSelectionEdges() {
  // Same idempotencyKey as the new row is the UPDATE-preserve path, NOT a source.
  const sameKey = [removedRow('k-new', 'c1', { notes: 'n' })]
  assert.equal(
    planCarry(sameKey, newAdd('k-new', 'c1'), { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' }).reason,
    'no_source_match',
    'same-key inactive row is not a cross-key carry source',
  )
  // Duplicate source rows sharing ONE key collapse to a single match (carry, not hold).
  const dupKey = [removedRow('old-1', 'c1', { notes: 'n' }), removedRow('old-1', 'c1', { notes: 'n' })]
  const decision = planCarry(dupKey, newAdd('k-new', 'c1'), {
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
  })
  assert.equal(decision.decision, CARRY_DECISIONS.CARRY_VIA_CONFIRM, 'de-dup by key: one source key = one match')
  assert.deepEqual(__internals.findComponentSourceMatches(dupKey, newAdd('k-new', 'c1')).matches.map((r) => r.idempotencyKey), ['old-1'])
}

// classifyCarry is the pure branch selector — pin every cell of the decision table.
function classifyBranchTable() {
  const c = (carryKey, manualRowReattach, matchCount, hasHumanContext) =>
    classifyCarry({ carryKey, manualRowReattach, matchCount, hasHumanContext })
  assert.equal(c('idempotency_key', 'propose_confirm', 5, true).decision, CARRY_DECISIONS.NO_CARRY)
  assert.equal(c('component_source_id', 'propose_confirm', 0, false).decision, CARRY_DECISIONS.NO_CARRY)
  assert.equal(c('component_source_id', 'propose_confirm', 1, true).decision, CARRY_DECISIONS.CARRY_VIA_CONFIRM)
  assert.equal(c('component_source_id', 'propose_confirm', 1, false).decision, CARRY_DECISIONS.NO_CARRY)
  assert.equal(c('component_source_id', 'none', 1, true).decision, CARRY_DECISIONS.MANUAL_CONFIRM)
  assert.equal(c('component_source_id', 'propose_confirm', 2, true).decision, CARRY_DECISIONS.MANUAL_CONFIRM)
  assert.equal(c('component_source_id', 'none', 9, true).decision, CARRY_DECISIONS.MANUAL_CONFIRM)
}

// ── MUTATION BATTERY ─────────────────────────────────────────────────────────
// Each mutation is applied to the module's OWN emitted shapes, then routed
// through the real guards and the real planCarry, proving both go RED.

// M1: flip the 1→N branch to AUTO-PICK. Simulate the mutant by taking planCarry's
// own single-match CARRY_VIA_CONFIRM builder and firing it on a 3-match scenario
// (auto-pick the first source). The ambiguity guard MUST reject it.
function mutationAutoPickAmbiguity() {
  const three = [
    removedRow('old-a', 'c1', { notes: 'na' }),
    removedRow('old-b', 'c1', { materialType: 'mt' }),
    removedRow('old-c', 'c1', { leadTimeDays: 3 }),
  ]
  const newRow = newAdd('k-new', 'c1')
  const { matches } = __internals.findComponentSourceMatches(three, newRow)
  assert.equal(matches.length, 3, 'fixture yields a genuine 1→N')

  // The mutant output: an auto-picked carry instead of a hold.
  const mutantAutoPick = __internals.makeCarryViaConfirm(
    newRow,
    matches[0],
    { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' },
    ['notes'],
  )
  // RED: the ambiguity guard rejects an auto-pick at matchCount > 1.
  assertThrowsReason(
    () => __internals.assertAmbiguityRoutedToHold(mutantAutoPick, matches.length),
    'AMBIGUITY_MUST_HOLD',
    'M1 auto-pick rejected by ambiguity guard',
  )
  // GREEN: the real planCarry holds (never carries) on the same fixture.
  const real = planCarry(three, newRow, { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' })
  assert.equal(real.decision, CARRY_DECISIONS.MANUAL_CONFIRM, 'real planCarry holds on 1→N')
  __internals.assertAmbiguityRoutedToHold(real, matches.length) // does not throw
}

// M2: drop the confirm requirement so human fields would SILENT-ADD. Simulate the
// mutant by building an ADD-shaped decision that embeds source human-field VALUES
// and drops requiresConfirm. The confirm-shape guard MUST reject each variant.
function mutationSilentAddHumanFields() {
  const base = {
    decision: CARRY_DECISIONS.CARRY_VIA_CONFIRM,
    idempotencyKey: 'k-new',
    sourceIdempotencyKey: 'old-1',
    componentSourceId: 'c1',
    carryFields: ['notes'],
    writeVia: CARRY_WRITE_VIA,
    requiresConfirm: true,
    carry: true,
  }
  // (a) confirm requirement dropped.
  assertThrowsReason(
    () => __internals.assertCarryViaConfirmShape({ ...base, requiresConfirm: false }),
    'CARRY_CONFIRM_SHAPE_VIOLATION',
    'M2a requiresConfirm dropped',
  )
  // (b) rerouted away from k2_confirm.
  assertThrowsReason(
    () => __internals.assertCarryViaConfirmShape({ ...base, writeVia: 'planner_add' }),
    'CARRY_CONFIRM_SHAPE_VIOLATION',
    'M2b writeVia rerouted',
  )
  // (c) ADD-shaped record smuggled in.
  assertThrowsReason(
    () => __internals.assertCarryViaConfirmShape({ ...base, record: { notes: 'leaked' } }),
    'CARRY_CONFIRM_SHAPE_VIOLATION',
    'M2c ADD-shaped record',
  )
  // (d) human-field VALUE spread onto the decision (the silent-ADD payload).
  assertThrowsReason(
    () => __internals.assertCarryViaConfirmShape({ ...base, notes: 'leaked', materialType: 'mt' }),
    'CARRY_CONFIRM_SHAPE_VIOLATION',
    'M2d human value smuggled',
  )
  // (e) carryFields escaping the whitelist.
  assertThrowsReason(
    () => __internals.assertCarryViaConfirmShape({ ...base, carryFields: ['notes', 'componentCode'] }),
    'CARRY_CONFIRM_SHAPE_VIOLATION',
    'M2e non-human carryField',
  )
  // GREEN: the real single-match decision passes the guard and never carries values.
  const real = planCarry(
    [removedRow('old-1', 'c1', { notes: 'n' })],
    newAdd('k-new', 'c1'),
    { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' },
  )
  __internals.assertCarryViaConfirmShape(real) // does not throw
  assert.equal(real.requiresConfirm, true)
}

// The human-field whitelist must not drift from the template (mirrors planner).
function whitelistDriftGuard() {
  // Default template resolves cleanly.
  assert.deepEqual(__internals.resolveHumanFields().sort(), HUMAN_PRESERVED_FIELD_IDS.slice().sort())
  // A template that normalizes cleanly (all required human fields present) but
  // carries an EXTRA human_preserved field NOT in the frozen whitelist → drift.
  const mainTemplate = require('../lib/stock-preparation-templates.cjs').STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
  const drifted = {
    id: 'x', objectId: 'x', label: 'x', version: 'v1', keyFields: ['idempotencyKey'],
    feasibilityGate: {
      mode: 'flat_parameterized_reads', sourceKind: 'data-source:sql-readonly', matchField: 'FileCode',
      relationDescriptors: [
        { id: 'r1', kind: 'root_by_project', matchField: 'FileCode', sourceIdField: 'OBJ_ID' },
        { id: 'r2', kind: 'children_by_parent', parentField: 'parentSourceId', childField: 'componentSourceId', sourceIdField: 'OBJ_ID' },
      ],
    },
    fields: [
      ...mainTemplate.fields.map((f) => ({ ...f })),
      { id: 'extraHumanField', label: 'Extra Human Field', type: 'string', ownership: 'human_preserved' },
    ],
  }
  assertThrowsReason(
    () => planCarry([removedRow('old-1', 'c1', { materialType: 'mt' })], newAdd('k-new', 'c1'),
      { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' }, { template: drifted }),
    'HUMAN_FIELD_WHITELIST_DRIFT',
    'template human-field drift fails closed',
  )
}

// No live Set / *_SET mirror leaks on the export surface (poisoning class).
function exportSurfaceClean() {
  const mod = require(MODULE_PATH)
  const seen = new WeakSet()
  const walk = (value, at) => {
    assert.ok(!(value instanceof Set), `${at}: live Set exported`)
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!key.includes('_SET'), `${at}.${key}: no exported Set-mirror`)
      walk(child, `${at}.${key}`)
    }
  }
  walk(mod, 'module')
}

// review P2: two prior rows sharing an idempotencyKey but carrying DIFFERENT human
// content must HOLD — and the outcome must not depend on input order.
function sameKeyConflictingContentHolds() {
  const rowA = removedRow('dup', 'c1', { notes: 'a' })
  const rowB = removedRow('dup', 'c1', { materialType: 'b' }) // same key, different human content
  const policy = { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' }

  const forward = planCarry([rowA, rowB], newAdd('k-new', 'c1'), policy)
  assert.equal(forward.decision, CARRY_DECISIONS.MANUAL_CONFIRM, 'same-key conflicting content → hold (forward order)')
  assert.equal(forward.carry, false, 'a conflicting hold never carries any human field')

  const reversed = planCarry([rowB, rowA], newAdd('k-new', 'c1'), policy)
  assert.equal(reversed.decision, CARRY_DECISIONS.MANUAL_CONFIRM, 'same-key conflicting content → hold (reversed order)')
  // Order-independence: the two orderings must not disagree, and neither silently carries.
  assert.equal(forward.decision, reversed.decision, 'decision is order-independent')

  // Identical duplicates under one key are still a clean single match (dedup is fine).
  const idA = removedRow('dup2', 'c2', { notes: 'same' })
  const idB = removedRow('dup2', 'c2', { notes: 'same' })
  const clean = planCarry([idA, idB], newAdd('k-new2', 'c2'), { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' })
  assert.equal(clean.decision, CARRY_DECISIONS.CARRY_VIA_CONFIRM, 'identical duplicates collapse to one clean match')
}

function main() {
  frozenVocabularies()
  sameKeyConflictingContentHolds()
  policyNormalization()
  inputValidation()
  idempotencyKeyIsAlwaysNoCarry()
  componentSourceZeroMatch()
  componentSourceSingleMatchProposeConfirm()
  bareDefaultSingleMatch()
  componentSourceSingleMatchNoneHolds()
  componentSourceSingleMatchNoHumanContext()
  componentSourceMultiMatchHolds()
  sourceSelectionEdges()
  classifyBranchTable()
  mutationAutoPickAmbiguity()
  mutationSilentAddHumanFields()
  whitelistDriftGuard()
  exportSurfaceClean()
}

main()
console.log('stock-preparation-carry-policy.test.cjs OK')
