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
 * Seal a scheduled run's single `generate` target through the REAL product path: claim the per-user
 * operation row and record the terminal outcome inside ONE canonical SERIALIZABLE transaction. The
 * claimed-commit guard (attendance_w4_operations_claimed_commit_guard) rejects a `claimed` row
 * committed alone, so the claim + seal MUST share a transaction — this mirrors production's
 * preflight-claims-then-caller-seals shape (attendance-w4c2-p12-run-transactions.db.test.ts). The
 * operation witness is minted with the SAME derived scheduled operation id the run-creation
 * transaction assigned the target, so recordAttendanceScheduledRunTargetOutcomeV1's operation_id
 * lookup matches. Returns the sealed operation id.
 */
export async function sealScheduledGenerateTargetOutcome(client, { orgId, runId, userId, workDate }) {
  const { runAttendanceResultOperationTransactionV1 } = await importProduct('attendance/w4c0-operation-registry')
  const { recordAttendanceScheduledRunTargetOutcomeV1 } = await importProduct('attendance/w4c2-scheduled-run')
  const { createVerifiedAttendanceOperationIdentityV1, createVerifiedAttendanceOrgIdentityV1, resolveSegmentCalculationPosture } =
    await importProduct('attendance/w4c0-identity')

  const opRow = (await client.query(
    `SELECT operation_id::text AS id FROM attendance_scheduled_run_targets
      WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3::uuid AND target_kind = 'generate'`,
    [orgId, runId, userId],
  )).rows[0]
  if (!opRow || !opRow.id) throw new Error('generate target operation_id not found for seal')
  const operationId = opRow.id

  await runAttendanceResultOperationTransactionV1(client, async (trx) => {
    await trx.query(
      `INSERT INTO attendance_result_operations (
          org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id,
          proof_work_date, source_ref, actor_id, actor_posture, capability, subject_scope,
          command_fingerprint, accepted_write_posture, state
        ) VALUES ($1,'scheduled',$2,'scheduled',$3,$4,$5,'ref:qa_synth_scheduled',
                  'qa_synth_scheduler','scheduler','scheduled','{}'::jsonb,$6,'shadow','claimed')`,
      [orgId, operationId, runId, userId, workDate, synthFingerprint(`op::${operationId}`)],
    )
    const org = createVerifiedAttendanceOrgIdentityV1({
      orgKey: orgId,
      posture: await resolveSegmentCalculationPosture(trx, orgId),
    })
    const witness = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'scheduled',
      source: { sourceKind: 'scheduled', scheduledRunId: runId, userId, workDate },
    })
    await trx.query(
      `UPDATE attendance_result_operations
          SET state = 'completed', response_snapshot = $3::jsonb, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND entrypoint = 'scheduled' AND operation_id = $2::uuid AND state = 'claimed'`,
      [orgId, operationId, JSON.stringify({ inserted: true })],
    )
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
