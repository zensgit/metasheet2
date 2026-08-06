#!/usr/bin/env node
/**
 * PQA-09 — Outbox retry — harness (owner Fix 4). Route-less internal (dispatcher is worker-only).
 *
 * Drives the REAL product dispatcher `dispatchAttendanceResultEventOutboxV1`
 * (w4c2-outbox-dispatcher.ts:84) in-process against the isolated metasheet_windows_qa:
 *   pass 1: emit() throws -> the row stays pending, attempts=1, next_attempt_at scheduled;
 *   pass 2: emit() succeeds -> the SAME row -> delivered, attempts=2, delivered_at set.
 * Proves: one synthetic dispatch failure + retry yields ONE delivered effect and NO duplicate DML
 * (uq_areo_identity), driven by the real claim/deliver/retry predicate.
 *
 * The pending row is hand-seeded (INSERT is unguarded; the outbox rejects only DELETE via
 * trg_areo_deny_delete), but SHAPE-FAITHFUL: it uses the scheduled_run identity union — a REAL
 * scheduled run (created through createOrResumeAttendanceScheduledRunV1) satisfies the FK
 * fk_areo_scheduled_run, event_kind 'attendance.absence.generated' maps to
 * identity_kind='scheduled_run' (chk_areo_kind_identity_map), entrypoint='scheduled'
 * (chk_areo_run_entrypoint), and business_key_fingerprint ~ ^[0-9a-f]{64}$. The row hits the
 * dispatcher's exact claim predicate (delivery_state='pending' AND next_attempt_at<=now()).
 * retryBackoffMs=0 so the pass-1 reschedule is immediately due for pass 2 in one run.
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
import { ensureShadowPosture, synthFingerprint } from './w4-common.mjs'

const CASE_ID = 'PQA-09'
const TITLE = 'Outbox retry'
const WORK_DATE = '2026-01-09'

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgShadow = ids.orgs.orgShadow
  const adminId = ids.users.admin.id
  const u1Id = ids.users.u1.id

  const { dispatchAttendanceResultEventOutboxV1 } = await importProduct('attendance/w4c2-outbox-dispatcher')
  const { createOrResumeAttendanceScheduledRunV1 } = await importProduct('attendance/w4c2-scheduled-run')
  const { runAttendanceResultOperationTransactionV1 } = await importProduct('attendance/w4c0-operation-registry')
  const client = await openIsolatedClient()
  try {
    await ensureShadowPosture(client, orgShadow, adminId)

    // A REAL scheduled run gives the outbox row a valid fk_areo_scheduled_run target.
    const run = await runAttendanceResultOperationTransactionV1(client, (trx) =>
      createOrResumeAttendanceScheduledRunV1(
        trx,
        { orgId: orgShadow, initiator: 'cron', workDate: WORK_DATE },
        async () => [{ userId: u1Id, targetKind: 'generate', reviewReasonCode: null }],
      ),
    )
    if (run.kind !== 'created_running') throw new Error(`expected created_running run, got ${run.kind}`)
    const scheduledRunId = run.runId

    // Seed ONE shape-faithful pending outbox row on the scheduled_run identity union.
    await client.query(
      `INSERT INTO attendance_result_event_outbox
         (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
       VALUES ($1, 'scheduled', 'scheduled_run', $2::uuid, 'attendance.absence.generated', $3::jsonb, 1, $4)`,
      [orgShadow, scheduledRunId, JSON.stringify({ synthetic: true }), synthFingerprint('pqa09-outbox')],
    )

    // Pass 1: sink throws -> contained per row, scheduled for retry.
    const pass1 = await dispatchAttendanceResultEventOutboxV1(client, {
      emit: async () => {
        throw new Error('qa_synth_injected_sink_failure')
      },
      retryBackoffMs: 0,
    })

    const afterFail = (await client.query(
      `SELECT delivery_state, attempts, delivered_at FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [scheduledRunId],
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
      [scheduledRunId],
    )).rows[0]
    const rowCount = Number((await client.query(
      `SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`,
      [scheduledRunId],
    )).rows[0].n)

    if (afterOk.delivery_state !== 'delivered' || Number(afterOk.attempts) !== 2 || afterOk.delivered_at === null) {
      throw new Error(`after retry expected delivered/attempts=2/delivered_at set, got ${JSON.stringify(afterOk)}`)
    }
    if (rowCount !== 1) throw new Error(`expected exactly 1 outbox row (no duplicate DML), got ${rowCount}`)
    if (delivered.length !== 1 || delivered[0] !== 'attendance.absence.generated') {
      throw new Error(`expected sink called once with attendance.absence.generated, got ${JSON.stringify(delivered)}`)
    }

    const evidence =
      `real scheduled run ${scheduledRunId} -> outbox row; ` +
      `dispatchAttendanceResultEventOutboxV1 pass1=${JSON.stringify(pass1)} (row -> pending, attempts=1); ` +
      `pass2=${JSON.stringify(pass2)} (SAME row -> delivered, attempts=2, delivered_at set); ` +
      `rows=1 (no duplicate DML); sink called 1x with attendance.absence.generated.`
    emitCaseEvidence(evidenceDir, {
      id: CASE_ID,
      title: TITLE,
      status: 'PASS',
      reason: 'Real outbox dispatcher: one injected failure then retry produced one delivered effect and no duplicate DML.',
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
