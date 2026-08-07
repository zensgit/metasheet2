#!/usr/bin/env node
/**
 * PQA-05 — Shadow posture — harness (owner Fix 4). Route-less internal command.
 *
 * Invokes the REAL product transition boundary `transitionAttendanceCalculationRolloutV1`
 * (w4c3a-rollout-control.ts:1125 — the ONLY transition DML path, no HTTP route) in-process against
 * the isolated metasheet_windows_qa, moving the synthetic shadow org legacy(v1) -> shadow(v2). The
 * command bootstraps the legacy row itself (lockRolloutStateForBootstrapOrRead:483), so no pre-seed.
 *
 * VERDICT: BLOCKED (owner Fix 4). The rollout STATE transition below is real and route-less, but it is
 * only a fragment of PQA-05's objective. The objective's other two halves — "keeps the legacy
 * projection" and "appends W4 shadow calculation rows" — are produced only by
 * createAttendanceLiveScheduledBoundaryV1, which needs five plugin-owned legacyAdapters compiled in
 * plugins/plugin-attendance/index.cjs (not TS-importable). So this case stays BLOCKED with that honest
 * reason rather than flipping to PASS on the narrower transition-only predicate.
 *
 * Run under tsx against source (macOS) or node against dist (Windows):
 *   QA_SYNTH_PASSWORD=... DATABASE_URL=postgresql://<local>/metasheet_windows_qa \
 *     node --import tsx scripts/ops/windows-qa/harness/pqa-05-rollout.mjs
 */
import crypto from 'node:crypto'
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  emitCaseEvidence,
  importProduct,
  loadIdentities,
  openIsolatedClient,
  parseArg,
} from './qa-runtime.mjs'

const CASE_ID = 'PQA-05'
const TITLE = 'Shadow posture'

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgShadow = ids.orgs.orgShadow
  const adminId = ids.users.admin.id

  // The rollout-control boundary gates on the SAME exact-org allowlist as the posture resolver.
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgShadow

  const { transitionAttendanceCalculationRolloutV1 } = await importProduct('attendance/w4c3a-rollout-control')
  const client = await openIsolatedClient()
  try {
    const input = {
      orgId: orgShadow,
      actorId: adminId,
      correlationId: crypto.randomUUID(),
      engineVersion: 'qa_synth_engine_v1',
      targetState: 'shadow',
      expectedState: 'legacy',
      expectedVersion: 1,
      evidenceManifestSha256: crypto.createHash('sha256').update('qa_synth_pqa05_manifest').digest('hex'),
      evidenceReferences: {
        imageSha: 'qa_synth_image_sha_pqa05',
        ownerAuthorizationRef: 'qa_synth_owner_auth_pqa05',
        syntheticOrgRef: 'qa_synth_org_ref_shadow',
      },
      reasonCode: 'rollout_transition',
    }

    const result = await transitionAttendanceCalculationRolloutV1(client, input)
    if (result.state !== 'shadow') {
      throw new Error(`transition returned state=${result.state}, expected shadow`)
    }

    // Assert the persisted state machine: shadow @ version 2, prior_state legacy, + an appended event.
    const stateRow = (await client.query(
      `SELECT state, version, prior_state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1`,
      [orgShadow],
    )).rows[0]
    const eventCount = Number((await client.query(
      `SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1`,
      [orgShadow],
    )).rows[0].n)

    if (!stateRow || stateRow.state !== 'shadow' || Number(stateRow.version) !== 2 || stateRow.prior_state !== 'legacy') {
      throw new Error(`persisted rollout state mismatch: ${JSON.stringify(stateRow)}`)
    }
    if (stateRow.scope !== 'synthetic_staging') {
      throw new Error(`rollout scope is ${stateRow.scope}, expected synthetic_staging`)
    }
    if (eventCount < 1) throw new Error('no rollout event was appended')

    const evidence =
      `transitionAttendanceCalculationRolloutV1(org=${orgShadow}) -> state=shadow; ` +
      `persisted state=${stateRow.state} version=${stateRow.version} prior_state=${stateRow.prior_state} ` +
      `scope=${stateRow.scope}; rollout_events appended=${eventCount}.`
    // Owner FIX 4 verdict — BLOCKED (honest reason): the FULL matrix objective ("keeps the legacy
    // projection AND appends W4 shadow calculation rows") is NOT assertable route-lessly from Node.
    // The shadow-calculation append (attendance_record_calculations mode='shadow' via the
    // module-private insertShadowCalculation, w4c2-live-scheduled-boundary.ts:742) is produced ONLY by
    // createAttendanceLiveScheduledBoundaryV1 (:1066), whose constructor throws
    // W4C2_LEGACY_ADAPTERS_INVALID unless supplied the five plugin-owned legacyAdapters; and the
    // "legacy projection" is assembled by those same adapters (applyLivePunchProjectionLegacyV1),
    // compiled in plugins/plugin-attendance/index.cjs (no .ts — not importable). Only the rollout-state
    // transition (asserted above, carried as evidence) is reachable from core-backend; that alone is
    // NOT the objective, so we do NOT flip to PASS on the narrower predicate.
    emitCaseEvidence(evidenceDir, {
      id: CASE_ID,
      title: TITLE,
      status: 'BLOCKED',
      reason:
        'full objective (legacy projection unchanged + appended W4 shadow calculation rows) is not ' +
        'assertable route-lessly: the shadow-calculation append and the legacy projection are produced ' +
        'only by createAttendanceLiveScheduledBoundaryV1, which requires the five plugin-owned ' +
        'legacyAdapters compiled in plugins/plugin-attendance/index.cjs (not TS-importable). Only the ' +
        'rollout-state transition (evidence below) is reachable from core-backend.',
      evidence,
    })
    console.log(`[${CASE_ID}] BLOCKED (full objective needs plugin legacyAdapters — see reason): ${evidence}`)
  } finally {
    await client.end()
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // Emit a BLOCKED verdict WITH the failure as evidence rather than silently exiting.
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
