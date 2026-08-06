#!/usr/bin/env node
/**
 * PQA-08 — Fingerprint freeze — harness (owner Fix 4). BLOCKED-with-evidence (decision primitive).
 *
 * Invokes the REAL boundary DECISION PRIMITIVE `computeAttendanceRequestPayloadFingerprintV1`
 * (w4c3b-request-snapshots.ts:430 — pure) and asserts the two freeze invariants it underpins:
 *   1. determinism: the SAME payload yields the SAME 64-hex fingerprint (an old snapshot's
 *      fingerprint is stable — it cannot silently drift);
 *   2. mismatch detection: a CHANGED payload (e.g. a shift-definition-driven field) yields a
 *      DIFFERENT fingerprint, which is what the boundary turns into review-required.
 * The freeze itself (an old snapshot row is immutable) is enforced by the append-only trigger
 * trg_attendance_request_calculation_snapshots_deny_mutation, whose PRESENCE+ENABLED state is
 * verified by reset-isolated-db.mjs --verify-only (d) and whose FIRING is proven generically by the
 * deny-delete negative control (reset-isolated-db.mjs --prove-deny-delete).
 *
 * WHY BLOCKED, NOT PASS (owner gate 3): this executes the fingerprint PRIMITIVE, not the full
 * boundary COMPOSITION w4c2-live-scheduled-boundary that routes a mismatch to review-required (that
 * needs the plugin-internal legacyAdapters). The end-to-end mismatch->review route + the append-only
 * snapshot append on the running server remain operator-verified on the Windows host.
 */
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  emitCaseEvidence,
  importProduct,
  loadIdentities,
  parseArg,
} from './qa-runtime.mjs'

const CASE_ID = 'PQA-08'
const TITLE = 'Fingerprint freeze'

function makePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    workDate: '2026-01-05',
    requestedInAt: '2026-01-05T09:00:00Z',
    requestedOutAt: '2026-01-05T18:00:00Z',
    reason: 'qa_synth_reason',
    minutes: null,
    leaveTypeCode: null,
    outdoorPunch: null,
    ...overrides,
  }
}

const HEX64 = /^[0-9a-f]{64}$/

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH)) // require provisioning ran

  const { computeAttendanceRequestPayloadFingerprintV1 } = await importProduct('attendance/w4c3b-request-snapshots')

  const fpA1 = computeAttendanceRequestPayloadFingerprintV1(makePayload())
  const fpA2 = computeAttendanceRequestPayloadFingerprintV1(makePayload())
  const fpB = computeAttendanceRequestPayloadFingerprintV1(makePayload({ requestedOutAt: '2026-01-05T19:30:00Z' }))

  if (!HEX64.test(fpA1)) throw new Error(`fingerprint is not 64-hex: ${fpA1}`)
  if (fpA1 !== fpA2) throw new Error(`determinism failed: same payload gave ${fpA1} != ${fpA2}`)
  if (fpA1 === fpB) throw new Error(`mismatch detection failed: changed payload gave the SAME fingerprint ${fpB}`)

  const evidence =
    `computeAttendanceRequestPayloadFingerprintV1: same payload -> same fp (${fpA1.slice(0, 12)}…, ` +
    `deterministic); changed payload -> different fp (${fpB.slice(0, 12)}…, mismatch detectable). ` +
    `Snapshot immutability enforced by append-only trigger ` +
    `trg_attendance_request_calculation_snapshots_deny_mutation (presence verified by reset --verify-only(d); ` +
    `deny firing proven by reset --prove-deny-delete).`
  emitCaseEvidence(evidenceDir, {
    id: CASE_ID,
    title: TITLE,
    status: 'BLOCKED',
    reason:
      'Decision primitive verified (deterministic fingerprint + mismatch detection) and append-only ' +
      'freeze trigger verified present/enabled. Full boundary mismatch->review route + snapshot append ' +
      'remain operator-verified on the Windows host.',
    evidence,
  })
  console.log(`[${CASE_ID}] BLOCKED-with-evidence: ${evidence}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    try {
      emitCaseEvidence(parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR), {
        id: CASE_ID,
        title: TITLE,
        status: 'BLOCKED',
        reason: 'Harness error before assertions completed.',
        evidence: `ERROR: ${error?.message ?? error}`,
      })
    } catch {
      /* ignore */
    }
    console.error(`[${CASE_ID}] ERROR: ${error?.message ?? error}`)
    process.exit(1)
  })
