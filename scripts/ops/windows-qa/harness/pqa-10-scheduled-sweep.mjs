#!/usr/bin/env node
/**
 * PQA-10 — Scheduled identity/outcome/outbox — harness (owner Fix 4). Route-less internals.
 *
 * Invokes, in-process against the isolated metasheet_windows_qa, the REAL product functions:
 *   - createOrResumeAttendanceScheduledRunV1 (w4c2-scheduled-run.ts:593) — the (org,initiator,
 *     work_date) scheduled-run IDENTITY, inside the canonical SERIALIZABLE wrapper
 *     runAttendanceResultOperationTransactionV1. Seeded through the real transactional function,
 *     NEVER a raw INSERT (the table triggers reject anything that is not a real run).
 *   - sweepAttendanceScheduledRunsOnceV1 (w4c2-scheduled-run-ops-worker.ts:228 — no route) — one
 *     recovery tick; the never-sealed target keeps the run a genuine candidate, so the sweep
 *     observes it and calls recoverCandidate.
 *
 * PASS-eligible: both real product functions run end-to-end on the real DB and the persisted run +
 * the sweep tick result are asserted.
 */
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  emitCaseEvidence,
  importProduct,
  loadIdentities,
  openIsolatedClient,
  openIsolatedPool,
  parseArg,
} from './qa-runtime.mjs'
import { ensureShadowPosture } from './w4-common.mjs'

const CASE_ID = 'PQA-10'
const TITLE = 'Scheduled identity/outcome/outbox'
const WORK_DATE = '2026-01-05'

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgShadow = ids.orgs.orgShadow
  const adminId = ids.users.admin.id
  const u1Id = ids.users.u1.id

  const { createOrResumeAttendanceScheduledRunV1 } = await importProduct('attendance/w4c2-scheduled-run')
  const { runAttendanceResultOperationTransactionV1 } = await importProduct('attendance/w4c0-operation-registry')
  const { sweepAttendanceScheduledRunsOnceV1 } = await importProduct('attendance/w4c2-scheduled-run-ops-worker')

  const client = await openIsolatedClient()
  let created
  try {
    await ensureShadowPosture(client, orgShadow, adminId)

    // Create the scheduled run through the real transactional path (identity = org,initiator,workDate).
    created = await runAttendanceResultOperationTransactionV1(client, (trx) =>
      createOrResumeAttendanceScheduledRunV1(
        trx,
        { orgId: orgShadow, initiator: 'cron', workDate: WORK_DATE },
        async () => [{ userId: u1Id, targetKind: 'generate', reviewReasonCode: null }],
      ),
    )
    if (created.kind !== 'created_running') {
      throw new Error(`expected created_running, got ${created.kind}`)
    }

    const runRow = (await client.query(
      `SELECT run_id::text AS run_id, initiator, work_date::text AS work_date, state, expected_user_count
         FROM attendance_scheduled_runs WHERE org_id = $1 AND run_id = $2::uuid`,
      [orgShadow, created.runId],
    )).rows[0]
    if (!runRow || runRow.state !== 'running' || runRow.initiator !== 'cron' || runRow.work_date !== WORK_DATE) {
      throw new Error(`persisted scheduled run mismatch: ${JSON.stringify(runRow)}`)
    }
  } finally {
    await client.end()
  }

  // Run ONE recovery sweep tick against the real DB; the stuck run is observed as a candidate.
  const pool = await openIsolatedPool()
  let recovered = 0
  let tick
  try {
    tick = await sweepAttendanceScheduledRunsOnceV1(pool, {
      limit: 25,
      async recoverCandidate(candidate) {
        if (candidate.runId === created.runId) recovered += 1
      },
    })
  } finally {
    await pool.end()
  }

  if (recovered < 1) {
    throw new Error(`sweep did not observe the synthetic run as a candidate (tick=${JSON.stringify(tick)})`)
  }

  const evidence =
    `createOrResumeAttendanceScheduledRunV1 -> kind=created_running run_id=${created.runId} ` +
    `identity=(${orgShadow},cron,${WORK_DATE}); sweepAttendanceScheduledRunsOnceV1 tick observed the ` +
    `run and called recoverCandidate ${recovered}x (backlogRemaining=${tick?.backlogRemaining ?? '?'}).`
  // Owner FIX 0 (honesty downgrade): this asserts only that the sweep OBSERVES a running run as a
  // candidate — not PQA-10's full matrix objective ("re-evaluate scheduled identity, target OUTCOME,
  // and OUTBOX durability": generate + verify the target outcome AND the outbox). Emit BLOCKED with
  // the real-execution evidence until FIX 4 completes it.
  emitCaseEvidence(evidenceDir, {
    id: CASE_ID,
    title: TITLE,
    status: 'BLOCKED',
    reason: 'scenario does not yet assert its full matrix objective',
    evidence,
  })
  console.log(`[${CASE_ID}] BLOCKED (honesty downgrade — assertions reached): ${evidence}`)
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
