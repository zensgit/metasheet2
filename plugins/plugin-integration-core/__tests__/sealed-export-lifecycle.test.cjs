'use strict'

// Sealed-export S1 — lifecycle state machine battery. Plain node test, hermetic.
//
// The states and edges below are transcribed from §8 of the ratified S0 baseline,
// NOT read out of lifecycle.cjs. §8 says, verbatim:
//
//   REQUESTED -> CAPTURING -> MANIFEST_VERIFIED -> UPLOADING -> UPLOAD_COMPLETE
//     -> STAGING -> SEALED -> APPLYING -> VERIFIED -> ACTIVE
//   any pre-ACTIVE state -- signer/binding/qualification revocation or expiry -->
//     QUARANTINED
//
// The no-stuck-absorbing-state property is asserted MECHANICALLY over the transition
// table — every non-terminal state must reach a terminal state — not by inspection.

const assert = require('node:assert/strict')
const path = require('node:path')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const lifecycle = require(path.join(SEALED_DIR, 'lifecycle.cjs'))
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))

// §8's chain, transcribed from the document.
const DOCUMENT_SECTION_8_PROGRESSION = [
  'REQUESTED',
  'CAPTURING',
  'MANIFEST_VERIFIED',
  'UPLOADING',
  'UPLOAD_COMPLETE',
  'STAGING',
  'SEALED',
  'APPLYING',
  'VERIFIED',
  'ACTIVE',
]
const DOCUMENT_QUARANTINE_STATE = 'QUARANTINED'

function throws(fn, label) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof vocabulary.SealedExportError, 'expected SealedExportError: ' + label)
  return caught
}

function statesAndEdgesMatchTheDocument() {
  assert.deepEqual(
    Array.from(lifecycle.SEALED_EXPORT_PROGRESSION_STATES),
    DOCUMENT_SECTION_8_PROGRESSION,
    '§8 progression, in order',
  )
  assert.deepEqual(
    Array.from(lifecycle.SEALED_EXPORT_LIFECYCLE_STATES).slice().sort(),
    DOCUMENT_SECTION_8_PROGRESSION.concat([DOCUMENT_QUARANTINE_STATE]).sort(),
    'state set = progression + QUARANTINED, nothing invented',
  )
  assert.equal(lifecycle.SEALED_EXPORT_INITIAL_STATE, 'REQUESTED')

  // Build §8's edge set independently and require exact agreement.
  const expected = []
  for (let index = 0; index + 1 < DOCUMENT_SECTION_8_PROGRESSION.length; index += 1) {
    expected.push(DOCUMENT_SECTION_8_PROGRESSION[index] + '->' + DOCUMENT_SECTION_8_PROGRESSION[index + 1])
  }
  // "any pre-ACTIVE state -> QUARANTINED"
  for (let index = 0; index < DOCUMENT_SECTION_8_PROGRESSION.length; index += 1) {
    const state = DOCUMENT_SECTION_8_PROGRESSION[index]
    if (state === 'ACTIVE') continue
    expected.push(state + '->' + DOCUMENT_QUARANTINE_STATE)
  }
  const actual = lifecycle.SEALED_EXPORT_LIFECYCLE_TRANSITIONS.map((edge) => edge[0] + '->' + edge[1])
  assert.deepEqual(actual.slice().sort(), expected.slice().sort(), '§8 edge set')

  // ACTIVE is not pre-ACTIVE, so it has no quarantine edge: "Any failure before
  // ACTIVE leaves the previous active generation unchanged."
  assert.deepEqual(Array.from(lifecycle.nextStates('ACTIVE')), [], 'ACTIVE is terminal')
  assert.deepEqual(Array.from(lifecycle.nextStates(DOCUMENT_QUARANTINE_STATE)), [],
    'QUARANTINED has no named exit in §8')
  assert.equal(lifecycle.isPreActiveState('ACTIVE'), false)
  assert.equal(lifecycle.isPreActiveState(DOCUMENT_QUARANTINE_STATE), false,
    'QUARANTINED is off the progression and cannot re-enter the flow')
  assert.equal(lifecycle.isPreActiveState('REQUESTED'), true)
}

// ---------------------------------------------------------------------------
// The no-stuck-absorbing-state proof, asserted over the TABLE.
// ---------------------------------------------------------------------------
function noStuckAbsorbingState() {
  const shipped = lifecycle.analyzeShippedLifecycle()
  assert.deepEqual(Array.from(shipped.stuckStates), [], 'no non-terminal state may be stuck')
  assert.deepEqual(Array.from(shipped.deadEndStates), [], 'no non-terminal dead end')
  assert.deepEqual(Array.from(shipped.terminalWithOutgoing), [], 'no terminal state may leave')
  assert.deepEqual(Array.from(shipped.unreachableStates), [], 'every state reachable from REQUESTED')

  // Independent restatement of the property: from EVERY non-terminal state, walk the
  // table and require a terminal state to be reachable. This does not reuse the
  // module's own analysis, so a bug in that analysis cannot hide a bug in the table.
  const terminals = new Set(lifecycle.SEALED_EXPORT_TERMINAL_STATES)
  for (const start of lifecycle.SEALED_EXPORT_LIFECYCLE_STATES) {
    if (terminals.has(start)) continue
    const seen = new Set([start])
    const queue = [start]
    let reached = false
    while (queue.length > 0 && !reached) {
      const current = queue.shift()
      if (terminals.has(current)) { reached = true; break }
      for (const next of lifecycle.nextStates(current)) {
        if (!seen.has(next)) { seen.add(next); queue.push(next) }
      }
    }
    assert.equal(reached, true, 'no terminal reachable from ' + start)
  }
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS for the analysis itself. The table is a PARAMETER, so the
// analysis can be pointed at a table whose defect is known. An analysis that only
// ever runs against the healthy table proves nothing about its own power.
// ---------------------------------------------------------------------------
function analysisDetectsDamagedTables() {
  const states = Array.from(lifecycle.SEALED_EXPORT_LIFECYCLE_STATES)
  const terminals = Array.from(lifecycle.SEALED_EXPORT_TERMINAL_STATES)
  const healthy = lifecycle.SEALED_EXPORT_LIFECYCLE_TRANSITIONS.map((edge) => [edge[0], edge[1]])

  // Control 0: the unmodified table is clean, so any finding below is caused by the
  // damage and not by the analysis being broken.
  const control = lifecycle.analyzeLifecycleReachability(states, healthy, terminals, 'REQUESTED')
  assert.deepEqual(Array.from(control.stuckStates), [])
  assert.deepEqual(Array.from(control.deadEndStates), [])

  // Damage A — sever every route out of VERIFIED. VERIFIED becomes a dead end AND
  // a stuck state; nothing else changes.
  const severed = healthy.filter((edge) => edge[0] !== 'VERIFIED')
  const severedResult = lifecycle.analyzeLifecycleReachability(states, severed, terminals, 'REQUESTED')
  assert.deepEqual(Array.from(severedResult.stuckStates), ['VERIFIED'], 'stuck state detected')
  assert.deepEqual(Array.from(severedResult.deadEndStates), ['VERIFIED'], 'dead end detected')

  // Damage B — an absorbing SELF-LOOP. VERIFIED can only go to itself, which is
  // exactly the "stuck absorbing state" the acceptance bar names. A naive
  // "has an outgoing edge" check would pass this; the analysis must not.
  const selfLoop = severed.concat([['VERIFIED', 'VERIFIED']])
  const selfLoopResult = lifecycle.analyzeLifecycleReachability(states, selfLoop, terminals, 'REQUESTED')
  assert.deepEqual(Array.from(selfLoopResult.stuckStates), ['VERIFIED'],
    'a self-loop is still stuck')
  assert.deepEqual(Array.from(selfLoopResult.deadEndStates), ['VERIFIED'],
    'a self-loop is not progress')

  // Damage C — a terminal state that can still leave.
  const leakyTerminal = healthy.concat([['ACTIVE', 'REQUESTED']])
  const leakyResult = lifecycle.analyzeLifecycleReachability(states, leakyTerminal, terminals, 'REQUESTED')
  assert.deepEqual(Array.from(leakyResult.terminalWithOutgoing), ['ACTIVE'], 'leaky terminal detected')

  // Damage D — an unreachable state.
  const orphaned = healthy.filter((edge) => edge[1] !== 'CAPTURING')
  const orphanResult = lifecycle.analyzeLifecycleReachability(states, orphaned, terminals, 'REQUESTED')
  assert.ok(Array.from(orphanResult.unreachableStates).indexOf('CAPTURING') >= 0,
    'unreachable state detected')

  // Damage E — a two-state cycle with no exit: neither member is a dead end (each
  // has an outgoing edge to the other) yet both are stuck.
  const cycle = healthy
    .filter((edge) => edge[0] !== 'STAGING' && edge[0] !== 'SEALED')
    .concat([['STAGING', 'SEALED'], ['SEALED', 'STAGING']])
  const cycleResult = lifecycle.analyzeLifecycleReachability(states, cycle, terminals, 'REQUESTED')
  assert.deepEqual(Array.from(cycleResult.stuckStates).sort(), ['SEALED', 'STAGING'],
    'a closed cycle is stuck even though neither state is a dead end')
  assert.deepEqual(Array.from(cycleResult.deadEndStates), [],
    'and neither is reported as a dead end — the two checks are independent')
}

// ---------------------------------------------------------------------------
function transitionsFailClosed() {
  // POSITIVE CONTROL: every §8 edge is accepted. Without this, "refuse everything"
  // would satisfy all the negative assertions.
  for (let index = 0; index + 1 < DOCUMENT_SECTION_8_PROGRESSION.length; index += 1) {
    const from = DOCUMENT_SECTION_8_PROGRESSION[index]
    const to = DOCUMENT_SECTION_8_PROGRESSION[index + 1]
    assert.equal(lifecycle.assertLifecycleTransition(from, to), to, 'legal edge ' + from + '->' + to)
  }
  for (let index = 0; index < DOCUMENT_SECTION_8_PROGRESSION.length; index += 1) {
    const from = DOCUMENT_SECTION_8_PROGRESSION[index]
    if (from === 'ACTIVE') continue
    assert.equal(lifecycle.assertLifecycleTransition(from, DOCUMENT_QUARANTINE_STATE),
      DOCUMENT_QUARANTINE_STATE, 'quarantine edge from ' + from)
  }

  // Skipping a rung fails closed.
  throws(() => lifecycle.assertLifecycleTransition('REQUESTED', 'SEALED'), 'skip forward')
  // Going backwards fails closed.
  throws(() => lifecycle.assertLifecycleTransition('SEALED', 'STAGING'), 'backwards')
  // ACTIVE cannot be quarantined: §7 sends an already-active generation to the
  // separate incident-response path instead.
  throws(() => lifecycle.assertLifecycleTransition('ACTIVE', DOCUMENT_QUARANTINE_STATE), 'active quarantine')
  // QUARANTINED cannot re-enter the flow.
  throws(() => lifecycle.assertLifecycleTransition(DOCUMENT_QUARANTINE_STATE, 'REQUESTED'), 'quarantine exit')
  // A self-transition is not an edge.
  throws(() => lifecycle.assertLifecycleTransition('STAGING', 'STAGING'), 'self transition')

  // Unknown states are refused, and the refusal NAMES which side was unknown.
  // §10 declares no transition-invalid reason, so the fixed internal error is used.
  const unknownFrom = throws(() => lifecycle.assertLifecycleTransition('ZZ-NOT-A-STATE', 'ACTIVE'), 'from')
  assert.equal(unknownFrom.reason, 'SEALED_EXPORT_INTERNAL_ERROR')
  assert.deepEqual(unknownFrom.details, { field: 'state' },
    'the refusal must survive the details discipline, not arrive empty')

  const unknownTo = throws(() => lifecycle.assertLifecycleTransition('REQUESTED', 'ZZ-NOT-A-STATE'), 'to')
  assert.equal(unknownTo.reason, 'SEALED_EXPORT_INTERNAL_ERROR')
  assert.deepEqual(unknownTo.details, { field: 'targetState' })

  const illegalEdge = throws(() => lifecycle.assertLifecycleTransition('REQUESTED', 'SEALED'), 'edge')
  assert.deepEqual(illegalEdge.details, { state: 'REQUESTED', targetState: 'SEALED' })

  // A caller-supplied value must never be echoed back.
  const marker = 'ZZ-LIFECYCLE-MARKER-4636'
  const echoed = throws(() => lifecycle.assertLifecycleTransition(marker, 'ACTIVE'), 'echo probe')
  assert.equal(echoed.message.indexOf(marker), -1)
  assert.equal(JSON.stringify(echoed.details).indexOf(marker), -1)
  assert.equal(String(echoed.stack).indexOf(marker), -1)

  // Non-string states are refused, not coerced.
  throws(() => lifecycle.assertLifecycleTransition(null, 'ACTIVE'), 'null from')
  throws(() => lifecycle.assertLifecycleTransition('REQUESTED', 0), 'numeric to')
  assert.equal(lifecycle.isKnownState('REQUESTED'), true)
  assert.equal(lifecycle.isKnownState('requested'), false)
  assert.equal(lifecycle.isKnownState(null), false)
  assert.equal(lifecycle.isTerminalState('ACTIVE'), true)
  assert.equal(lifecycle.isTerminalState(DOCUMENT_QUARANTINE_STATE), true)
  assert.equal(lifecycle.isTerminalState('SEALED'), false)
}

function main() {
  statesAndEdgesMatchTheDocument()
  noStuckAbsorbingState()
  analysisDetectsDamagedTables()
  transitionsFailClosed()
  console.log('sealed-export-lifecycle.test.cjs OK')
}

main()
