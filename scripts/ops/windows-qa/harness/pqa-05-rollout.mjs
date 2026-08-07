#!/usr/bin/env node
/**
 * PQA-05 — Shadow posture — harness (owner Fix 4). Route-less internal command.
 *
 * Invokes the REAL product transition boundary `transitionAttendanceCalculationRolloutV1`
 * (w4c3a-rollout-control.ts:1125 — the ONLY transition DML path, no HTTP route) in-process against
 * the isolated metasheet_windows_qa, moving the synthetic shadow org legacy(v1) -> shadow(v2). The
 * command bootstraps the legacy row itself (lockRolloutStateForBootstrapOrRead:483), so no pre-seed.
 *
 * PASS-eligible: the real product function runs end-to-end on the real DB and the persisted state
 * machine is asserted. (The runner still requires the Windows host safety facts before final PASS.)
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
    // Owner FIX 0 (honesty downgrade): the assertions above only cover the rollout STATE transition,
    // not PQA-05's full matrix objective ("keeps the legacy projection AND appends W4 shadow
    // evidence"). Emit BLOCKED — with the real-execution evidence, so this is distinguishable from an
    // error BLOCKED — until FIX 4 genuinely completes the objective.
    emitCaseEvidence(evidenceDir, {
      id: CASE_ID,
      title: TITLE,
      status: 'BLOCKED',
      reason: 'scenario does not yet assert its full matrix objective',
      evidence,
    })
    console.log(`[${CASE_ID}] BLOCKED (honesty downgrade — assertions reached): ${evidence}`)
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
