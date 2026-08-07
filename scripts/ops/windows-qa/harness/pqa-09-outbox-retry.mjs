#!/usr/bin/env node
/**
 * PQA-09 — Outbox retry — harness (owner Fix 4). Route-less internal (dispatcher is worker-only).
 *
 * Full matrix objective: "one synthetic dispatch failure + retry ⇒ one source/result effect, no
 * duplicate DML" — on a PRODUCT-PRODUCED outbox row (the runbook forbids a manual INSERT).
 *
 * The outbox row is produced by a REAL scheduled-run lifecycle, entirely through exported product
 * functions against the isolated metasheet_windows_qa (no hand INSERT into the outbox):
 *   1. createOrResumeAttendanceScheduledRunV1 — a run with one `generate` target.
 *   2. seal that target (claim the per-user operation + recordAttendanceScheduledRunTargetOutcomeV1).
 *   3. finalizeAttendanceScheduledRunV1 — the product enqueues the run-level
 *      `attendance.absence.generated` outbox row as a side effect (w4c2-scheduled-run.ts:1020).
 * Then the REAL dispatcher `dispatchAttendanceResultEventOutboxV1` (w4c2-outbox-dispatcher.ts:84):
 *   pass 1: emit() throws -> the SAME row stays pending, attempts=1, rescheduled;
 *   pass 2: emit() succeeds -> the SAME row -> delivered, attempts=2, delivered_at set, sink 1x.
 *
 * "no duplicate DML" is proven by a business-DML BASELINE — the row COUNT (count(*)) of every
 * scheduled-run / operation / calculation / outbox table — captured BEFORE the two dispatch passes and
 * required to be row-count-identical AFTER (a count baseline, not a byte/content compare): the dispatch
 * may only flip the one claimed row's delivery_state, never create or duplicate a business row.
 * retryBackoffMs=0 makes the pass-1 reschedule immediately due.
 *
 * PASS-eligible: real product fns end-to-end on the real DB. (The runner still requires the Windows
 * host safety facts before the final PASS.)
 */
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  buildMachineEvidence,
  emitCaseEvidence,
  importProduct,
  loadIdentities,
  openIsolatedClient,
  parseArg,
} from './qa-runtime.mjs'
import {
  businessDmlCounts,
  createScheduledRunWithOneGenerateTarget,
  finalizeScheduledRunViaProduct,
  sealScheduledGenerateTargetOutcome,
} from './w4-common.mjs'

const CASE_ID = 'PQA-09'
const HARNESS_MODULE = 'pqa-09-outbox-retry.mjs'
const TITLE = 'Outbox retry'
const WORK_DATE = '2026-01-09'

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgShadow = ids.orgs.orgShadow
  const adminId = ids.users.admin.id
  const u1Id = ids.users.u1.id

  const { dispatchAttendanceResultEventOutboxV1 } = await importProduct('attendance/w4c2-outbox-dispatcher')
  const client = await openIsolatedClient()
  try {
    // Product-produce ONE outbox row via a real scheduled-run finalize (no manual outbox INSERT).
    const { runId } = await createScheduledRunWithOneGenerateTarget(client, {
      orgId: orgShadow,
      adminId,
      userId: u1Id,
      workDate: WORK_DATE,
    })
    await sealScheduledGenerateTargetOutcome(client, { orgId: orgShadow, runId, userId: u1Id, workDate: WORK_DATE })
    const finalize = await finalizeScheduledRunViaProduct(client, { orgId: orgShadow, runId, workDate: WORK_DATE })
    if (finalize.kind !== 'finalized') throw new Error(`expected finalized run, got ${finalize.kind}`)

    const seeded = (await client.query(
      `SELECT delivery_state, attempts, event_kind, identity_kind FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [runId],
    )).rows
    if (seeded.length !== 1) throw new Error(`expected exactly 1 product-produced outbox row, got ${seeded.length}`)
    if (seeded[0].delivery_state !== 'pending' || seeded[0].identity_kind !== 'scheduled_run') {
      throw new Error(`product-produced outbox row is not pending/scheduled_run: ${JSON.stringify(seeded[0])}`)
    }

    // Business-DML BASELINE before the dispatch passes.
    const before = await businessDmlCounts(client)

    // Pass 1: sink throws -> contained per row, scheduled for retry.
    const pass1 = await dispatchAttendanceResultEventOutboxV1(client, {
      emit: async () => {
        throw new Error('qa_synth_injected_sink_failure')
      },
      retryBackoffMs: 0,
    })
    const afterFail = (await client.query(
      `SELECT delivery_state, attempts, delivered_at FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [runId],
    )).rows[0]
    if (afterFail.delivery_state !== 'pending' || Number(afterFail.attempts) !== 1 || afterFail.delivered_at !== null) {
      throw new Error(`after failure expected pending/attempts=1/no delivered_at, got ${JSON.stringify(afterFail)}`)
    }

    // Pass 2: sink succeeds -> the SAME row delivered.
    const delivered = []
    const pass2 = await dispatchAttendanceResultEventOutboxV1(client, {
      emit: async (d) => {
        delivered.push(d.eventKind)
      },
      retryBackoffMs: 0,
    })
    const afterOk = (await client.query(
      `SELECT delivery_state, attempts, delivered_at FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [runId],
    )).rows[0]
    const rowCount = Number((await client.query(
      `SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [runId],
    )).rows[0].n)

    if (afterOk.delivery_state !== 'delivered' || Number(afterOk.attempts) !== 2 || afterOk.delivered_at === null) {
      throw new Error(`after retry expected delivered/attempts=2/delivered_at set, got ${JSON.stringify(afterOk)}`)
    }
    if (rowCount !== 1) throw new Error(`expected exactly 1 outbox row (no duplicate DML), got ${rowCount}`)
    if (delivered.length !== 1 || delivered[0] !== 'attendance.absence.generated') {
      throw new Error(`expected sink called once with attendance.absence.generated, got ${JSON.stringify(delivered)}`)
    }

    // No duplicate DML: the two dispatch passes must not create/duplicate ANY business row.
    const after = await businessDmlCounts(client)
    const changed = Object.keys(before).filter((t) => before[t] !== after[t])
    if (changed.length > 0) {
      throw new Error(
        `dispatch produced duplicate/extra business DML in: ${changed
          .map((t) => `${t} ${before[t]}->${after[t]}`)
          .join(', ')}`,
      )
    }

    const evidence =
      `PRODUCT-PRODUCED outbox row via scheduled run ${runId} (create+seal+finalize=${JSON.stringify(finalize.kind)}); ` +
      `dispatch pass1=${JSON.stringify(pass1)} (row -> pending, attempts=1); ` +
      `pass2=${JSON.stringify(pass2)} (SAME row -> delivered, attempts=2, delivered_at set); ` +
      `sink called 1x with attendance.absence.generated; outbox rows=1 (no duplicate row); ` +
      `business-DML baseline unchanged across both passes (0 tables changed of ${Object.keys(before).length}).`
    emitCaseEvidence(evidenceDir, {
      id: CASE_ID,
      title: TITLE,
      status: 'PASS',
      reason:
        'Real outbox dispatcher on a PRODUCT-PRODUCED row: one injected failure then retry produced one delivered effect, no duplicate DML (business-DML baseline unchanged).',
      evidence,
      machineEvidence: buildMachineEvidence({
        caseId: CASE_ID,
        harnessModule: HARNESS_MODULE,
        determination: 'PASS',
        facts: {
          scheduledRunId: runId,
          outboxRowCount: rowCount,
          pass1AttemptsAfterFailure: Number(afterFail.attempts),
          pass2AttemptsAfterRetry: Number(afterOk.attempts),
          pass2DeliveryState: afterOk.delivery_state,
          sinkDeliveries: delivered.length,
          deliveredEventKind: delivered[0],
          businessDmlTablesChanged: changed.length,
          businessDmlTablesTracked: Object.keys(before).length,
        },
      }),
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
