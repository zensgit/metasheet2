#!/usr/bin/env node
/**
 * PQA-06 — Ambiguous evidence — harness (owner Fix 4). BLOCKED-with-evidence (decision primitive).
 *
 * Invokes the REAL boundary DECISION PRIMITIVE `calculateAttendanceSegmentsV1`
 * (w4c1-segment-calculator.ts:836 — pure) with a synthetic frozen context + DUPLICATE check-in
 * evidence, and asserts the product returns outcome='review_required' with a duplicate reason and
 * dailyProjection=null (no fabricated authoritative projection). A positive control (clean full-day
 * evidence -> outcome='completed') proves the input is otherwise valid, so the review verdict comes
 * from the duplicate, not from a malformed fixture.
 *
 * WHY BLOCKED, NOT PASS (owner gate 3): this executes the boundary's decision PRIMITIVE, not the
 * full boundary COMPOSITION `createAttendanceLiveScheduledBoundaryV1` — that factory needs the five
 * plugin-internal legacyAdapters (plugins/plugin-attendance/index.cjs:24715, closed over plugin
 * runtime state) which are not importable without booting the plugin/server. The end-to-end boundary
 * route + the DB persistence of the review verdict remain operator-verified on the Windows host.
 */
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  emitCaseEvidence,
  importProduct,
  loadIdentities,
  parseArg,
} from './qa-runtime.mjs'

const CASE_ID = 'PQA-06'
const TITLE = 'Ambiguous evidence'

// Minimal frozen-context/attribution builders (Asia/Shanghai base day, +08:00), matching the
// product's own unit fixtures. Pure inputs — the calculator never touches the DB or identity parser.
const sh = (time, dayShift = 0) => `2026-07-0${1 + dayShift}T${time}:00+08:00`
const seg = (index, startTime, endTime) => ({
  index,
  startTime,
  endTime,
  startDayOffset: 0,
  endDayOffset: 0,
  lateGraceMinutes: 5,
  earlyLeaveGraceMinutes: 5,
})
const punch = (ref, direction, occurredAt) => ({ kind: 'punch', ref, direction, occurredAt, source: 'attendance_event' })

function makeContext(orgId, userId) {
  return {
    schemaVersion: 1,
    selector: 'legacy',
    orgId,
    userId,
    workDate: '2026-07-01',
    timezone: 'Asia/Shanghai',
    shiftId: 'qa_synth_shift_pqa06',
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 45,
    absenceLateThresholdMinutes: 90,
    segments: [seg(0, '09:00', '12:00'), seg(1, '13:00', '18:00')],
  }
}

function makeAttribution(orgId, userId) {
  return {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2,
      resolverVersion: 'w2-resolver@3',
      orgId,
      userId,
      workDate: '2026-07-01',
      shiftId: 'qa_synth_shift_pqa06',
      reasonCode: 'assignment_match',
      resolvedAt: '2026-07-02T00:05:00+08:00',
      absoluteWindow: { startAt: '2026-06-30T16:00:00Z', endAt: '2026-07-02T16:00:00Z' },
      attributionWindow: { startAt: '2026-06-30T20:00:00Z', endAt: '2026-07-01T20:00:00Z' },
      attributionTailMinutes: 240,
      extendedByApprovedOvertime: false,
      windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'live_resolution',
    },
  }
}

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgId = ids.orgs.orgA
  const userId = ids.users.u1.id

  const { calculateAttendanceSegmentsV1 } = await importProduct('attendance/w4c1-segment-calculator')

  // Positive control: clean full-day evidence -> completed (input is otherwise valid).
  const clean = calculateAttendanceSegmentsV1({
    attribution: makeAttribution(orgId, userId),
    context: makeContext(orgId, userId),
    evidence: [
      punch('ev-in-1', 'check_in', sh('08:58')),
      punch('ev-out-1', 'check_out', sh('12:01')),
      punch('ev-in-2', 'check_in', sh('12:59')),
      punch('ev-out-2', 'check_out', sh('18:02')),
    ],
    approvedFacts: [],
  })
  if (clean.outcome !== 'completed') {
    throw new Error(`positive control failed: clean evidence gave outcome=${clean.outcome} (expected completed)`)
  }

  // Ambiguous: TWO check-ins in segment 0 -> duplicate -> review_required, projection null.
  const dup = calculateAttendanceSegmentsV1({
    attribution: makeAttribution(orgId, userId),
    context: makeContext(orgId, userId),
    evidence: [
      punch('dup-in-1', 'check_in', sh('09:20')),
      punch('dup-in-2', 'check_in', sh('09:40')),
      punch('ev-out-1', 'check_out', sh('12:01')),
    ],
    approvedFacts: [],
  })
  if (dup.outcome !== 'review_required') {
    throw new Error(`duplicate evidence gave outcome=${dup.outcome} (expected review_required)`)
  }
  if (!/duplicate|ambiguous/.test(dup.outcomeReasonCode)) {
    throw new Error(`unexpected review reason: ${dup.outcomeReasonCode}`)
  }
  if (dup.dailyProjection !== null) {
    throw new Error(`review_required must NOT fabricate a projection; got ${JSON.stringify(dup.dailyProjection)}`)
  }

  const evidence =
    `calculateAttendanceSegmentsV1: positive control (clean evidence) -> outcome=completed; ` +
    `duplicate check-ins -> outcome=review_required, outcomeReasonCode=${dup.outcomeReasonCode}, ` +
    `dailyProjection=null (no fabricated authoritative projection).`
  emitCaseEvidence(evidenceDir, {
    id: CASE_ID,
    title: TITLE,
    status: 'BLOCKED',
    reason:
      'Decision primitive verified (duplicate -> review_required, projection null). Full boundary ' +
      'composition + DB persistence of the review verdict remain operator-verified on the Windows host.',
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
