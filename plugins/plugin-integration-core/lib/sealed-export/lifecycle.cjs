'use strict'

// Sealed-export S1 — latent lifecycle state machine (issue #4636 deliverable 3).
//
// LATENT: no runtime consumer, no persistence, no scheduler. This module is the
// transition TABLE plus a pure graph analysis over it. It stores nothing and
// advances nothing on its own.
//
// States and edges come from §8 verbatim:
//
//   REQUESTED -> CAPTURING -> MANIFEST_VERIFIED -> UPLOADING -> UPLOAD_COMPLETE
//     -> STAGING -> SEALED -> APPLYING -> VERIFIED -> ACTIVE
//   any pre-ACTIVE state -- signer/binding/qualification revocation or expiry -->
//     QUARANTINED
//
// TWO PLACES §8 IS SILENT, BOTH RESOLVED THE NARROWER WAY:
//   - No exit from QUARANTINED is named. §8's "Failed generations remain invisible
//     and are retried or retention-cleaned" is prose about operations, not a named
//     transition, so QUARANTINED is modelled as TERMINAL. Widening it later is an
//     additive change; assuming an unnamed recovery edge now would be an invention.
//   - No event/trigger names are given for the chain edges. Transitions are
//     therefore (from, to) pairs only. No event vocabulary is invented.
//
// AN ILLEGAL TRANSITION raises the fixed SEALED_EXPORT_INTERNAL_ERROR: §10 names no
// transition-invalid reason, and the fixed internal error is the substitute §10
// itself prescribes for a reason the vocabulary does not declare.

const { failSealedExport } = require('./failure-vocabulary.cjs')

const SEALED_EXPORT_LIFECYCLE_STATES = Object.freeze([
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
  'QUARANTINED',
])

const SEALED_EXPORT_INITIAL_STATE = 'REQUESTED'
const SEALED_EXPORT_TERMINAL_STATES = Object.freeze(['ACTIVE', 'QUARANTINED'])

// The §8 progression, in order. ACTIVE closes it.
const SEALED_EXPORT_PROGRESSION_STATES = Object.freeze([
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
])

function buildTransitionTable() {
  const pairs = []
  for (let index = 0; index + 1 < SEALED_EXPORT_PROGRESSION_STATES.length; index += 1) {
    pairs.push(Object.freeze([
      SEALED_EXPORT_PROGRESSION_STATES[index],
      SEALED_EXPORT_PROGRESSION_STATES[index + 1],
    ]))
  }
  // "any pre-ACTIVE state -> QUARANTINED": every progression state except ACTIVE.
  for (let index = 0; index < SEALED_EXPORT_PROGRESSION_STATES.length; index += 1) {
    const state = SEALED_EXPORT_PROGRESSION_STATES[index]
    if (state === 'ACTIVE') continue
    pairs.push(Object.freeze([state, 'QUARANTINED']))
  }
  return Object.freeze(pairs)
}

const SEALED_EXPORT_LIFECYCLE_TRANSITIONS = buildTransitionTable()

function isKnownState(state) {
  return typeof state === 'string' && SEALED_EXPORT_LIFECYCLE_STATES.indexOf(state) >= 0
}

function isTerminalState(state) {
  return SEALED_EXPORT_TERMINAL_STATES.indexOf(state) >= 0
}

// Pre-ACTIVE, in the §8 sense: a progression state that is not ACTIVE. QUARANTINED is
// not on the progression, so it is not pre-ACTIVE and cannot re-enter the flow.
function isPreActiveState(state) {
  return SEALED_EXPORT_PROGRESSION_STATES.indexOf(state) >= 0 && state !== 'ACTIVE'
}

function nextStates(state, transitions) {
  const table = transitions || SEALED_EXPORT_LIFECYCLE_TRANSITIONS
  const out = []
  for (let index = 0; index < table.length; index += 1) {
    if (table[index][0] === state) out.push(table[index][1])
  }
  return Object.freeze(out)
}

function assertLifecycleTransition(fromState, toState) {
  if (!isKnownState(fromState)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR', { field: 'state' })
  }
  if (!isKnownState(toState)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR', { field: 'targetState' })
  }
  const allowed = nextStates(fromState)
  if (allowed.indexOf(toState) < 0) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR', { state: fromState, targetState: toState })
  }
  return toState
}

// ---------------------------------------------------------------------------
// Mechanical no-stuck-absorbing-state analysis.
//
// The table is a PARAMETER, not a closed-over constant, so a test can feed a damaged
// table and observe the analysis detect the damage. An analysis that can only ever
// be run against the shipped (healthy) table proves nothing about its own power.
//
// Reported defects:
//   stuckStates            non-terminal states from which no terminal state is
//                          reachable (the absorbing-state defect itself);
//   deadEndStates          non-terminal states with no outgoing edge, or whose only
//                          outgoing edges are self-loops;
//   terminalWithOutgoing   terminal states that can still leave;
//   unreachableStates      states not reachable from the initial state.
// ---------------------------------------------------------------------------
function analyzeLifecycleReachability(states, transitions, terminalStates, initialState) {
  const stateList = Array.isArray(states) ? states.slice() : []
  const table = Array.isArray(transitions) ? transitions : []
  const terminals = Array.isArray(terminalStates) ? terminalStates.slice() : []

  const successors = new Map()
  for (let index = 0; index < stateList.length; index += 1) successors.set(stateList[index], [])
  for (let index = 0; index < table.length; index += 1) {
    const edge = table[index]
    if (!Array.isArray(edge) || edge.length !== 2) continue
    if (!successors.has(edge[0])) successors.set(edge[0], [])
    successors.get(edge[0]).push(edge[1])
  }

  const reachesTerminal = (start) => {
    const seen = new Set([start])
    const queue = [start]
    while (queue.length > 0) {
      const current = queue.shift()
      if (terminals.indexOf(current) >= 0) return true
      const outgoing = successors.get(current) || []
      for (let index = 0; index < outgoing.length; index += 1) {
        if (!seen.has(outgoing[index])) {
          seen.add(outgoing[index])
          queue.push(outgoing[index])
        }
      }
    }
    return false
  }

  const stuckStates = []
  const deadEndStates = []
  const terminalWithOutgoing = []
  for (let index = 0; index < stateList.length; index += 1) {
    const state = stateList[index]
    const outgoing = successors.get(state) || []
    if (terminals.indexOf(state) >= 0) {
      if (outgoing.length > 0) terminalWithOutgoing.push(state)
      continue
    }
    const progressing = outgoing.filter((target) => target !== state)
    if (progressing.length === 0) deadEndStates.push(state)
    if (!reachesTerminal(state)) stuckStates.push(state)
  }

  const reachable = new Set()
  if (successors.has(initialState) || stateList.indexOf(initialState) >= 0) {
    const queue = [initialState]
    reachable.add(initialState)
    while (queue.length > 0) {
      const current = queue.shift()
      const outgoing = successors.get(current) || []
      for (let index = 0; index < outgoing.length; index += 1) {
        if (!reachable.has(outgoing[index])) {
          reachable.add(outgoing[index])
          queue.push(outgoing[index])
        }
      }
    }
  }
  const unreachableStates = stateList.filter((state) => !reachable.has(state))

  return Object.freeze({
    stuckStates: Object.freeze(stuckStates),
    deadEndStates: Object.freeze(deadEndStates),
    terminalWithOutgoing: Object.freeze(terminalWithOutgoing),
    unreachableStates: Object.freeze(unreachableStates),
  })
}

function analyzeShippedLifecycle() {
  return analyzeLifecycleReachability(
    SEALED_EXPORT_LIFECYCLE_STATES,
    SEALED_EXPORT_LIFECYCLE_TRANSITIONS,
    SEALED_EXPORT_TERMINAL_STATES,
    SEALED_EXPORT_INITIAL_STATE,
  )
}

module.exports = {
  SEALED_EXPORT_LIFECYCLE_STATES,
  SEALED_EXPORT_LIFECYCLE_TRANSITIONS,
  SEALED_EXPORT_PROGRESSION_STATES,
  SEALED_EXPORT_TERMINAL_STATES,
  SEALED_EXPORT_INITIAL_STATE,
  isKnownState,
  isTerminalState,
  isPreActiveState,
  nextStates,
  assertLifecycleTransition,
  analyzeLifecycleReachability,
  analyzeShippedLifecycle,
}
