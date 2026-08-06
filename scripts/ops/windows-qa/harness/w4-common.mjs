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
