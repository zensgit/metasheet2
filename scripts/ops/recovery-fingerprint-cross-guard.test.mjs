// Cross-guard: the RUNTIME lease-posture fingerprints must agree with the CONTAINMENT constants.
//
// WHY THIS EXISTS (a failure that already happened once):
// The expected recovery-authority function bodies live in TWO independently hand-maintained places:
//   (1) scripts/ops/multitable-recovery-schema-containment.mjs — body constants, fingerprinted at
//       runtime; drives postdeploy-full, the drift lane, and the L1 battery's posture preflight.
//   (2) packages/core-backend/src/multitable/recovery-authorization-stability.ts — a SECOND copy,
//       as hardcoded `bodyFingerprint` hex, driving the RUNTIME lease posture check
//       (acquireRecoveryAuthorityLease).
// When F3 (#5081) rewrote the function bodies to fix search_path shadowing, copy (1) was updated as
// part of the change while copy (2) was found only because a reviewer enumerated couplings by hand.
// Had it been missed, `acquireRecoveryAuthorityLease` would have returned 'unavailable' IN
// PRODUCTION against correct, armed functions — a fail-closed outage caused by a stale constant.
// Nothing mechanically tied the two copies together. This guard is that tie.
//
// HOW IT COMPARES (the two copies normalise differently, so raw hex cannot be compared):
// stability.ts fingerprints a body as sha256(JSON.stringify(body.replace(/\s+/g,' ').trim())).
// This guard applies THAT algorithm to containment's body constants and asserts the result equals
// stability's pinned hex, per function. So the assertion is "the two copies describe the SAME body",
// not "two hashes happen to match" — a change to either side that is not mirrored reds here.
//
// Hermetic: no database, no network. Reads both files as source.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { EXPECTED_AUTHORITY_FUNCTIONS } from './multitable-recovery-schema-containment.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const STABILITY = join(REPO, 'packages/core-backend/src/multitable/recovery-authorization-stability.ts')
const stabilitySource = readFileSync(STABILITY, 'utf8')

/** stability.ts's own algorithm, replicated verbatim (see its normalizeFunctionBody/functionBodyFingerprint). */
function stabilityFingerprint(body) {
  return createHash('sha256')
    .update(JSON.stringify(String(body ?? '').replace(/\s+/g, ' ').trim()))
    .digest('hex')
}

/**
 * Parse stability.ts's RECOVERY_AUTHORITY_FUNCTION_SPECS into { functionName -> bodyFingerprint }.
 * Fail-closed: a parse that yields nothing (file moved, shape changed) is a FAILURE, never a pass —
 * an empty comparison silently green is the exact trap this whole line keeps re-learning.
 */
function parseStabilitySpecs(source) {
  const start = source.indexOf('const RECOVERY_AUTHORITY_FUNCTION_SPECS')
  assert.ok(start >= 0, 'RECOVERY_AUTHORITY_FUNCTION_SPECS not found in stability.ts — the guard cannot compare and must not pass')
  const end = source.indexOf('] as const', start)
  assert.ok(end > start, 'could not find the end of RECOVERY_AUTHORITY_FUNCTION_SPECS')
  const block = source.slice(start, end)
  const out = new Map()
  const re = /functionName:\s*'([^']+)'[\s\S]*?bodyFingerprint:\s*'([0-9a-f]{64})'/g
  let m
  while ((m = re.exec(block)) !== null) out.set(m[1], m[2])
  return out
}

test('cross-guard: stability.ts fingerprints are PARSEABLE and non-empty (fail-closed)', () => {
  const specs = parseStabilitySpecs(stabilitySource)
  assert.ok(specs.size >= 6, `expected >= 6 function specs in stability.ts, parsed ${specs.size} — refusing to compare against a truncated set`)
  assert.ok(
    EXPECTED_AUTHORITY_FUNCTIONS.length >= 6,
    `expected >= 6 containment function constants, found ${EXPECTED_AUTHORITY_FUNCTIONS.length}`,
  )
})

test('cross-guard: every containment function body hashes to the fingerprint stability.ts pins', () => {
  const specs = parseStabilitySpecs(stabilitySource)
  const mismatches = []
  const unseen = []
  for (const fn of EXPECTED_AUTHORITY_FUNCTIONS) {
    const pinned = specs.get(fn.functionName)
    if (!pinned) {
      unseen.push(fn.functionName)
      continue
    }
    const derived = stabilityFingerprint(fn.body)
    if (derived !== pinned) {
      mismatches.push(`${fn.functionName}: containment body hashes to ${derived}, stability.ts pins ${pinned}`)
    }
  }
  assert.deepEqual(
    unseen,
    [],
    `containment declares functions that stability.ts does not pin: ${unseen.join(', ')} — the runtime lease check would not verify them`,
  )
  assert.deepEqual(
    mismatches,
    [],
    'the two hand-maintained copies of the recovery-authority function bodies have DRIFTED. ' +
      'Update BOTH: the body constants in scripts/ops/multitable-recovery-schema-containment.mjs AND the ' +
      'bodyFingerprint hex in packages/core-backend/src/multitable/recovery-authorization-stability.ts. ' +
      'A stale stability.ts makes acquireRecoveryAuthorityLease return "unavailable" in production against ' +
      'correct functions.\n' + mismatches.join('\n'),
  )
})

test('cross-guard: stability.ts pins no function containment does not declare (no orphan pin)', () => {
  const specs = parseStabilitySpecs(stabilitySource)
  const declared = new Set(EXPECTED_AUTHORITY_FUNCTIONS.map((fn) => fn.functionName))
  const orphans = [...specs.keys()].filter((name) => !declared.has(name))
  assert.deepEqual(orphans, [], `stability.ts pins functions containment does not declare: ${orphans.join(', ')}`)
})
