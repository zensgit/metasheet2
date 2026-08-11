/**
 * P08 child process B — canonical processor only.
 * Env: DATABASE_URL
 * Argv: jobId
 * Stdout: JSON deterministic projection (+ resultKind)
 */
import { Pool } from 'pg'
import {
  processP08JobId,
  readP08DeterministicProjection,
} from './attendance-w4c3a-p08-fixture'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  const jobId = process.argv[2]
  if (!url || !jobId) {
    console.error(JSON.stringify({ ok: false, error: 'missing_env_or_jobId' }))
    process.exit(2)
  }
  for (const k of Object.keys(process.env)) {
    if (/PAYLOAD|RULE_SET|MAPPING_PROFILE|LEGACY_REQUEST|P08_FIXTURE/i.test(k)) {
      console.error(JSON.stringify({ ok: false, error: 'forbidden_env', key: k }))
      process.exit(3)
    }
  }
  const outcome = await processP08JobId(url, jobId)
  const pool = new Pool({ connectionString: url })
  try {
    if (outcome.kind === 'completed') {
      const projection = await readP08DeterministicProjection(pool, jobId)
      console.log(JSON.stringify({ ok: true, ...projection, resultKind: outcome.kind }))
      return
    }
    const job = await pool.query(
      `SELECT status, w4_execution_reason_code AS reason
         FROM attendance_import_jobs WHERE id = $1::uuid`,
      [jobId],
    )
    console.log(
      JSON.stringify({
        ok: false,
        resultKind: outcome.kind,
        status: job.rows[0]?.status ?? null,
        reason: job.rows[0]?.reason ?? null,
      }),
    )
    process.exit(5)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.stack ?? error) }))
  process.exit(1)
})
