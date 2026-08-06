#!/usr/bin/env node
/**
 * PQA-07 — Authorization isolation — CREATE-fixture setup (owner Fix 1/3). BLOCKED-with-evidence.
 *
 * The synthetic actors + memberships are already created via the product path by
 * provision-synth-directory.mjs. This step completes the case fixture, parameterized ENTIRELY from
 * qa-identities.json (no hardcoded ids): it seeds one self-owned attendance_records row per active
 * user (current_calculation_id left NULL, so a self read returns 200 {calculation:null} — a positive
 * control), and flips u3's org_a membership INACTIVE (the inactive-membership probe subject).
 *
 * WHY BLOCKED, NOT PASS (owner gate 3): the actual authorization PROBES (same-org other-user,
 * cross-org, forged witness, inactive membership -> fail before result SQL) run through the
 * authenticated HTTP routes on the running server + real login sessions — the operator-verified
 * Windows surface. This step only proves the CREATE fixture executes and is drop/recreate-cleanable.
 */
import {
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_IDENTITIES_PATH,
  emitCaseEvidence,
  loadIdentities,
  openIsolatedClient,
  parseArg,
} from './qa-runtime.mjs'

const CASE_ID = 'PQA-07'
const TITLE = 'Authorization isolation'
const WORK_DATE = '2026-01-05'

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const ids = loadIdentities(parseArg('--identities', DEFAULT_IDENTITIES_PATH))
  const orgA = ids.orgs.orgA
  const u1 = ids.users.u1.id
  const u2 = ids.users.u2.id
  const u3 = ids.users.u3.id

  const client = await openIsolatedClient()
  try {
    // One self-owned record per active user (no calculation seeded -> self read = 200 {null}).
    await client.query(
      `INSERT INTO attendance_records (user_id, work_date, org_id)
       VALUES ($1, $3::date, $4), ($2, $3::date, $4)
       ON CONFLICT (user_id, work_date, org_id) DO NOTHING`,
      [u1, u2, WORK_DATE, orgA],
    )
    // u3: INACTIVE membership in org_a (the inactive-membership probe subject).
    await client.query(
      `UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2`,
      [u3, orgA],
    )

    const recCount = Number((await client.query(
      `SELECT count(*)::int AS n FROM attendance_records WHERE org_id = $1 AND user_id IN ($2, $3)`,
      [orgA, u1, u2],
    )).rows[0].n)
    const u3Active = (await client.query(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [u3, orgA],
    )).rows[0]?.is_active
    if (recCount !== 2) throw new Error(`expected 2 seeded records, got ${recCount}`)
    if (u3Active !== false) throw new Error(`u3 membership should be inactive, got is_active=${u3Active}`)

    const evidence =
      `seeded ${recCount} self-owned attendance_records (u1,u2 in org_a, current_calculation_id NULL); ` +
      `u3 org_a membership set is_active=false. Authorization probes (same-org other-user / cross-org / ` +
      `forged witness / inactive membership) run through authenticated HTTP on the running server ` +
      `(operator-verified on the Windows host).`
    emitCaseEvidence(evidenceDir, {
      id: CASE_ID,
      title: TITLE,
      status: 'BLOCKED',
      reason: 'CREATE fixture built + drop/recreate-cleanable; authorization HTTP probes operator-verified on the Windows host.',
      evidence,
    })
    console.log(`[${CASE_ID}] BLOCKED-with-evidence: ${evidence}`)
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
