/* eslint-env node */
// Fresh process: the only command input is the durable job ID. No frozen record is passed.
const started = Date.now()
const stage = name => process.stdout.write('PUNCH_PREVIEW_CHILD_STAGE ' + JSON.stringify({ name, elapsedMs: Date.now() - started }) + '\n')
stage('boot')
// This entry is bundled from current source by the parent fixture before process startup.
// eslint-disable-next-line @typescript-eslint/no-var-requires -- Keep the fresh child in one CommonJS graph.
const { Pool } = require('pg')
// eslint-disable-next-line @typescript-eslint/no-var-requires -- The registered TS loader preserves private module capabilities.
const { createAttendancePunchDetailPreviewJobHostV1 } = require('../../src/attendance/w4c3a-punch-detail-preview-job-host.ts')
stage('host')
const pool = new Pool({ connectionString: process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL })
const sql = []
const deps = { async acquireConnection() {
  const client = await pool.connect()
  const query = client.query.bind(client)
  return { client: { async query(text, params) { sql.push(text); return query(text, params) } },
    release(error) { client.release(error) } }
} }
// Deliberately a DB-backed test callback, not the production scoped-policy adapter.
const authorize = async (client, input) => (await client.query(
  "SELECT 1 FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:import'",
  [input.scope.actorId])).length === 1
async function main() {
  stage('execute')
  let result
  try {
    result = await createAttendancePunchDetailPreviewJobHostV1(deps)
      .processPunchDetailPreviewJob({ jobId: process.argv[2] }, authorize)
  } catch (error) { result = { kind: 'refused', code: error.code || error.message } }
  const businessQueries = sql.filter(text => /\b(attendance_records|attendance_events|attendance_record_calculations|attendance_record_segments|attendance_import_batches|attendance_import_items|attendance_result_operations|attendance_result_event_outbox)\b/.test(text)).length
  const fullSnapshotReads = sql.filter(text => /r\.snapshot\s/.test(text) && !text.includes("snapshot->'envelope'")).length
  process.stdout.write('PUNCH_PREVIEW_CHILD ' + JSON.stringify({ result, pid: process.pid,
    businessQueries, fullSnapshotReads, namespaceReads: sql.filter(text => text.includes('FROM user_namespace_admissions')).length }) + '\n')
}
main().catch(() => { process.exitCode = 1 }).finally(() => pool.end())
