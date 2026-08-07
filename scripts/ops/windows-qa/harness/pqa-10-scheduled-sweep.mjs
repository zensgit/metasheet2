#!/usr/bin/env node
/**
 * PQA-10 — Scheduled identity/outcome/outbox — harness (owner Fix 4). Route-less internals.
 *
 * Full matrix objective: "re-evaluate scheduled identity, target OUTCOME, and OUTBOX durability" —
 * generate AND verify the target outcome AND the outbox, not just that a sweep observes a running run.
 *
 * Driven entirely through exported product functions against the isolated metasheet_windows_qa:
 *   - IDENTITY: createOrResumeAttendanceScheduledRunV1 mints the (org,initiator,work_date) scheduled
 *     run identity inside the canonical SERIALIZABLE wrapper; the persisted running row is asserted.
 *   - TARGET OUTCOME: the run's single `generate` target is sealed through the real path (claim the
 *     per-user operation, then recordAttendanceScheduledRunTargetOutcomeV1) and the persisted
 *     attendance_scheduled_run_target_outcomes row (terminal_outcome='completed') is asserted.
 *   - OUTBOX DURABILITY: finalizeAttendanceScheduledRunV1 — with the target's terminal outcome
 *     present, the product finalizes the run and enqueues the durable run-level
 *     `attendance.absence.generated` outbox row (w4c2-scheduled-run.ts:1020). The row is asserted and
 *     then delivered once by the real dispatcher (durable AND deliverable).
 *
 * PASS-eligible: real product fns end-to-end on the real DB. (The runner still requires the Windows
 * host safety facts before the final PASS.)
 */
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  emitCaseEvidence,
  importProduct,
  loadIdentities,
  openIsolatedClient,
  parseArg,
} from './qa-runtime.mjs'
import {
  createScheduledRunWithOneGenerateTarget,
  finalizeScheduledRunViaProduct,
  sealScheduledGenerateTargetOutcome,
} from './w4-common.mjs'

const CASE_ID = 'PQA-10'
const TITLE = 'Scheduled identity/outcome/outbox'
const WORK_DATE = '2026-01-05'

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgShadow = ids.orgs.orgShadow
  const adminId = ids.users.admin.id
  const u1Id = ids.users.u1.id

  const { dispatchAttendanceResultEventOutboxV1 } = await importProduct('attendance/w4c2-outbox-dispatcher')
  const client = await openIsolatedClient()
  try {
    // (1) IDENTITY — create the scheduled run (identity = org,initiator,work_date) with one generate target.
    const { runId, created } = await createScheduledRunWithOneGenerateTarget(client, {
      orgId: orgShadow,
      adminId,
      userId: u1Id,
      workDate: WORK_DATE,
    })
    const runRow = (await client.query(
      `SELECT initiator, work_date::text AS work_date, state, expected_user_count
         FROM attendance_scheduled_runs WHERE org_id = $1 AND run_id = $2::uuid`,
      [orgShadow, runId],
    )).rows[0]
    if (!runRow || runRow.state !== 'running' || runRow.initiator !== 'cron' || runRow.work_date !== WORK_DATE) {
      throw new Error(`persisted scheduled-run identity mismatch: ${JSON.stringify(runRow)}`)
    }

    // (2) TARGET OUTCOME — seal the generate target through the real path, then assert the outcome row.
    const operationId = await sealScheduledGenerateTargetOutcome(client, {
      orgId: orgShadow,
      runId,
      userId: u1Id,
      workDate: WORK_DATE,
    })
    const outcomeRows = (await client.query(
      `SELECT terminal_outcome, failure_reason_code FROM attendance_scheduled_run_target_outcomes
        WHERE org_id = $1 AND run_id = $2::uuid`,
      [orgShadow, runId],
    )).rows
    if (outcomeRows.length !== 1 || outcomeRows[0].terminal_outcome !== 'completed' || outcomeRows[0].failure_reason_code !== null) {
      throw new Error(`persisted target OUTCOME mismatch: ${JSON.stringify(outcomeRows)}`)
    }

    // (3) OUTBOX DURABILITY — finalize (product enqueues the run-level outbox row), assert it, deliver it.
    const finalize = await finalizeScheduledRunViaProduct(client, { orgId: orgShadow, runId, workDate: WORK_DATE })
    if (finalize.kind !== 'finalized') throw new Error(`expected finalized run, got ${finalize.kind}`)
    const runAfter = (await client.query(
      `SELECT state, generated_count FROM attendance_scheduled_runs WHERE org_id = $1 AND run_id = $2::uuid`,
      [orgShadow, runId],
    )).rows[0]
    if (runAfter.state !== 'completed') throw new Error(`run not completed after finalize: ${JSON.stringify(runAfter)}`)

    const outbox = (await client.query(
      `SELECT event_kind, delivery_state, attempts, identity_kind FROM attendance_result_event_outbox
        WHERE scheduled_run_id = $1::uuid`,
      [runId],
    )).rows
    if (outbox.length !== 1 || outbox[0].event_kind !== 'attendance.absence.generated' ||
        outbox[0].delivery_state !== 'pending' || outbox[0].identity_kind !== 'scheduled_run') {
      throw new Error(`durable OUTBOX row mismatch: ${JSON.stringify(outbox)}`)
    }

    const delivered = []
    const dispatch = await dispatchAttendanceResultEventOutboxV1(client, {
      emit: async (d) => {
        delivered.push(d.eventKind)
      },
      retryBackoffMs: 0,
    })
    const outboxDelivered = (await client.query(
      `SELECT delivery_state, attempts FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [runId],
    )).rows[0]
    if (outboxDelivered.delivery_state !== 'delivered' || delivered.length !== 1) {
      throw new Error(`outbox not delivered once: row=${JSON.stringify(outboxDelivered)} sink=${JSON.stringify(delivered)}`)
    }

    const evidence =
      `IDENTITY createOrResumeAttendanceScheduledRunV1 -> ${JSON.stringify(created.kind)} run_id=${runId} ` +
      `identity=(${orgShadow},cron,${WORK_DATE}) persisted state=running; ` +
      `TARGET OUTCOME operation ${operationId} sealed -> attendance_scheduled_run_target_outcomes ` +
      `terminal_outcome=completed; OUTBOX finalize=${JSON.stringify(finalize.kind)} enqueued a durable ` +
      `attendance.absence.generated row (identity_kind=scheduled_run), then dispatch=${JSON.stringify(dispatch)} ` +
      `delivered it once (run state=completed).`
    emitCaseEvidence(evidenceDir, {
      id: CASE_ID,
      title: TITLE,
      status: 'PASS',
      reason:
        'Real scheduled-run identity + recorded target OUTCOME + finalize-enqueued durable OUTBOX row (delivered once) — full identity/outcome/outbox objective on the isolated DB.',
      evidence,
    })
    console.log(`[${CASE_ID}] PASS: ${evidence}`)
  } finally {
    await client.end()
  }
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
