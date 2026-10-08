/**
 * P08 child process A — production enqueue surface only.
 * Env: DATABASE_URL, P08_FIXTURE_JSON (P08FixtureIds)
 * Stdout: single line jobId
 */
import { Pool } from 'pg'
import {
  enqueueP08FullPlanV1,
  type P08FixtureIds,
} from './attendance-w4c3a-p08-fixture'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  const raw = process.env.P08_FIXTURE_JSON
  if (!url || !raw) {
    console.error('missing_DATABASE_URL_or_P08_FIXTURE_JSON')
    process.exit(2)
  }
  for (const k of Object.keys(process.env)) {
    if (/PAYLOAD|RULE_SET|MAPPING_PROFILE|LEGACY_REQUEST/i.test(k)) {
      console.error(`forbidden_env:${k}`)
      process.exit(3)
    }
  }
  const ids = JSON.parse(raw) as P08FixtureIds
  const pool = new Pool({ connectionString: url })
  try {
    // Discriminator: must not already have a V1 job (parent must not enqueue on B).
    const prior = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_import_jobs
        WHERE org_id = $1 AND w4_contract_version = 1`,
      [ids.orgId],
    )
    if (Number(prior.rows[0].n) !== 0) {
      console.error('parent_already_enqueued')
      process.exit(4)
    }
    const jobId = await enqueueP08FullPlanV1(pool, ids)
    // Print ONLY jobId.
    console.log(jobId)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error))
  process.exit(1)
})
