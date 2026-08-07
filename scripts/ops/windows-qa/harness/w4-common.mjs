/**
 * Attendance Windows-native QA v2 — shared W4 harness helpers.
 *
 * Draft/HOLD. Synthetic data only. Pinned SOURCE_SHA 0dc3596dd (unchanged by QA tooling).
 */
import crypto from 'node:crypto'
import { importProduct } from './qa-runtime.mjs'

/**
 * Ensure the synthetic shadow org is in `shadow` posture, via the REAL transition boundary — so
 * PQA-06/08/09/10 are each independently runnable (they need W4 enabled, historically "per PQA-05").
 * Sets the exact-org allowlist env the posture resolver + transition both gate on. Idempotent:
 * no-op if already shadow; bootstraps legacy(v1) and transitions to shadow otherwise.
 */
export async function ensureShadowPosture(client, orgId, actorId) {
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
  const existing = (await client.query(
    `SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1`,
    [orgId],
  )).rows[0]
  if (existing && existing.state === 'shadow') return { state: 'shadow', bootstrapped: false }
  if (existing && existing.state !== 'legacy') {
    throw new Error(`org ${orgId} is in state ${existing.state}; cannot ensure shadow from here`)
  }
  const expectedVersion = existing ? Number(existing.version) : 1
  const { transitionAttendanceCalculationRolloutV1 } = await importProduct('attendance/w4c3a-rollout-control')
  const result = await transitionAttendanceCalculationRolloutV1(client, {
    orgId,
    actorId,
    correlationId: crypto.randomUUID(),
    engineVersion: 'qa_synth_engine_v1',
    targetState: 'shadow',
    expectedState: 'legacy',
    expectedVersion,
    evidenceManifestSha256: crypto.createHash('sha256').update('qa_synth_ensure_shadow').digest('hex'),
    evidenceReferences: {
      imageSha: 'qa_synth_image_sha_shadow',
      ownerAuthorizationRef: 'qa_synth_owner_auth_shadow',
      syntheticOrgRef: 'qa_synth_org_ref_shadow',
    },
    reasonCode: 'rollout_transition',
  })
  if (result.state !== 'shadow') throw new Error(`ensureShadowPosture: transition returned ${result.state}`)
  return { state: 'shadow', bootstrapped: true }
}

/** A 64-hex business-key fingerprint from a synthetic label (matches chk_areo_business_key_fp). */
export function synthFingerprint(label) {
  return crypto.createHash('sha256').update(`qa_synth::${label}`).digest('hex')
}

/**
 * Business tables a single outbox dispatch must NOT create or duplicate rows in — the core dispatcher
 * only flips the claimed row's delivery_state (w4c2-outbox-dispatcher.ts). Used as PQA-09's
 * "no duplicate DML" baseline: snapshot counts before/after the fail+retry passes and require equality.
 */
export const ATTENDANCE_BUSINESS_DML_TABLES = Object.freeze([
  'attendance_scheduled_runs',
  'attendance_scheduled_run_targets',
  'attendance_scheduled_run_target_outcomes',
  'attendance_result_operations',
  'attendance_result_operation_batches',
  'attendance_record_calculations',
  'attendance_record_segments',
  'attendance_result_event_outbox',
])

/** Row-count snapshot of ATTENDANCE_BUSINESS_DML_TABLES on the isolated DB. */
export async function businessDmlCounts(client) {
  const out = {}
  for (const table of ATTENDANCE_BUSINESS_DML_TABLES) {
    out[table] = Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
  }
  return out
}

/**
 * Create a scheduled run with ONE `generate` target through the REAL product path
 * (createOrResumeAttendanceScheduledRunV1 inside the canonical SERIALIZABLE wrapper). Ensures the
 * org is in shadow posture first. Returns { runId, created }.
 */
export async function createScheduledRunWithOneGenerateTarget(client, { orgId, adminId, userId, workDate }) {
  await ensureShadowPosture(client, orgId, adminId)
  const { createOrResumeAttendanceScheduledRunV1 } = await importProduct('attendance/w4c2-scheduled-run')
  const { runAttendanceResultOperationTransactionV1 } = await importProduct('attendance/w4c0-operation-registry')
  const created = await runAttendanceResultOperationTransactionV1(client, (trx) =>
    createOrResumeAttendanceScheduledRunV1(
      trx,
      { orgId, initiator: 'cron', workDate },
      async () => [{ userId, targetKind: 'generate', reviewReasonCode: null }],
    ),
  )
  if (created.kind !== 'created_running') throw new Error(`expected created_running run, got ${created.kind}`)
  return { runId: created.runId, created }
}

/**
 * Re-trigger the SAME scheduled-run identity (org, initiator:'cron', workDate) through the REAL
 * product path. With a running row already present and the target set unchanged,
 * createOrResumeAttendanceScheduledRunV1 RESUMES it rather than forking a second running row — the
 * identity-idempotence the runbook's S2 re-trigger asserts. Returns the `resumed` result.
 */
export async function resumeScheduledRunWithOneGenerateTarget(client, { orgId, userId, workDate }) {
  const { createOrResumeAttendanceScheduledRunV1 } = await importProduct('attendance/w4c2-scheduled-run')
  const { runAttendanceResultOperationTransactionV1 } = await importProduct('attendance/w4c0-operation-registry')
  return runAttendanceResultOperationTransactionV1(client, (trx) =>
    createOrResumeAttendanceScheduledRunV1(
      trx,
      { orgId, initiator: 'cron', workDate },
      async () => [{ userId, targetKind: 'generate', reviewReasonCode: null }],
    ),
  )
}

/**
 * Run the REAL scheduled-run sweep worker ONCE against the isolated DB. Opens its own product Pool
 * (the worker takes a Pool with `.connect()`), claims due running runs (stamping `last_attempt_at`),
 * and processes each candidate. `recoverCandidate` is a no-op here (the harness only needs to prove the
 * sweep observes/claims the running run). Returns the sweep tick result. Caller must have opened the
 * pool via openIsolatedPool (asserts the isolated DB) and is responsible for ending it.
 */
export async function sweepScheduledRunsOnceViaProduct(pool) {
  const { sweepAttendanceScheduledRunsOnceV1 } = await importProduct('attendance/w4c2-scheduled-run-ops-worker')
  return sweepAttendanceScheduledRunsOnceV1(pool, {
    limit: 16,
    recoverCandidate: async () => {},
  })
}

/**
 * Seal a scheduled run's single `generate` target through the REAL product path: the CANONICAL
 * registry claims the per-user operation row (attendanceResultOperationPreflightV1 — the harness
 * writes NO raw DML on the w4_canonical operation registry), the canonical seal completes it
 * (sealAttendanceResultOperationV1), and the terminal outcome is recorded — all inside ONE
 * canonical SERIALIZABLE transaction (the claimed-commit guard rejects a `claimed` row committed
 * alone). The authorization is the product's OWN internal-scheduler context (posture `scheduler`
 * + the registered ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1 + org_scheduler scope — exactly the
 * actor production's scheduled entrypoint runs as). The preflight derives the operation identity
 * from the SAME closed scheduled source tuple the run-creation transaction assigned the target,
 * asserted below, so recordAttendanceScheduledRunTargetOutcomeV1's operation_id lookup matches.
 * Returns the sealed operation id.
 */
export async function sealScheduledGenerateTargetOutcome(client, { orgId, runId, userId, workDate }) {
  const { attendanceResultOperationPreflightV1, runAttendanceResultOperationTransactionV1, sealAttendanceResultOperationV1 } =
    await importProduct('attendance/w4c0-operation-registry')
  const { recordAttendanceScheduledRunTargetOutcomeV1 } = await importProduct('attendance/w4c2-scheduled-run')
  const { ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1, createAuthorizedAttendanceWriteContextV1 } =
    await importProduct('attendance/w4c0-authorization')

  const opRow = (await client.query(
    `SELECT operation_id::text AS id FROM attendance_scheduled_run_targets
      WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3::uuid AND target_kind = 'generate'`,
    [orgId, runId, userId],
  )).rows[0]
  if (!opRow || !opRow.id) throw new Error('generate target operation_id not found for seal')
  const operationId = opRow.id

  const authorization = createAuthorizedAttendanceWriteContextV1({
    actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
    actorPosture: 'scheduler',
    tokenSubjectUserId: null,
    orgId,
    subjectScope: { kind: 'org_scheduler' },
    capability: 'scheduled',
    sourceRef: 'ref:qa_synth_scheduled',
  })
  const source = { sourceKind: 'scheduled', scheduledRunId: runId, userId, workDate }

  await runAttendanceResultOperationTransactionV1(client, async (trx) => {
    const preflight = await attendanceResultOperationPreflightV1(trx, authorization, {
      orgId,
      entrypoint: 'scheduled',
      batch: null,
      commands: [{ source, commandFingerprint: synthFingerprint(`scheduled::${runId}::${userId}::${workDate}`) }],
    })
    if (preflight.kind !== 'claimed' || preflight.itemIdentities.length !== 1) {
      throw new Error(`expected canonical preflight to claim 1 scheduled item, got ${JSON.stringify(preflight.kind)}`)
    }
    const witness = preflight.itemIdentities[0]
    if (witness.id !== operationId) {
      throw new Error(
        `derived scheduled operation id mismatch: preflight=${witness.id} target row=${operationId}`,
      )
    }
    await sealAttendanceResultOperationV1(trx, witness, { responseSnapshot: { inserted: true } })
    await recordAttendanceScheduledRunTargetOutcomeV1(trx, witness, { terminalOutcome: 'completed' })
  })
  return operationId
}

/** Finalize a scheduled run through the REAL product path — enqueues the run-level outbox row(s). */
export async function finalizeScheduledRunViaProduct(client, { orgId, runId, workDate }) {
  const { runAttendanceResultOperationTransactionV1 } = await importProduct('attendance/w4c0-operation-registry')
  const { finalizeAttendanceScheduledRunV1 } = await importProduct('attendance/w4c2-scheduled-run')
  return runAttendanceResultOperationTransactionV1(client, (trx) =>
    finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId }),
  )
}
