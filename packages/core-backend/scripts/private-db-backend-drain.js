/**
 * Wait until a private database has no backends, then fail closed if any remain.
 *
 * `client.end()` and pool destroy return when the client has asked to quit.
 * PostgreSQL drops the backend from `pg_stat_activity` later. Callers poll
 * instead of reading the census once.
 *
 * This file is plain CommonJS on purpose. The checkpoint script is ESM and
 * imports it by name. tsx compiles a neighboring `.ts` file as CommonJS in a
 * shape Node cannot link, so the named export disappears. `exports.name =`
 * is a shape Node's CJS export detector accepts.
 *
 * The failure text is values-free. `query` is not selected: statement text can
 * embed row values (review #4799 P2-2). `usename` is omitted for the same
 * reason that residual census does not log role names. The caller-chosen
 * connection label is omitted too. What is emitted is `pid` (a server-assigned
 * integer), `backend_type` and `state` (server categories), and `age_seconds`
 * (a non-negative integer). On failure those rows are written to stderr with
 * the marker SYNTHETIC_DATABASE_CONNECTIONS_REMAIN, then the helper throws.
 */

const PRIVATE_DB_BACKEND_DRAIN_MS = 10_000
const PRIVATE_DB_BACKEND_POLL_MS = 200

/** The only census this helper issues. It must not name `query`, `usename`, or the caller-chosen connection label. */
const PRIVATE_DB_BACKEND_CENSUS_SQL =
  'SELECT pid, backend_type, state, round(extract(epoch FROM now()-backend_start))::int AS age_seconds FROM pg_stat_activity WHERE datname = $1 ORDER BY pid'

const CATEGORY_TOKEN = /[^A-Za-z0-9_. -]+/g

function categoryToken(value) {
  const cleaned = String(value ?? '').replace(CATEGORY_TOKEN, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'unknown'
}

function formatPid(value) {
  const pid = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(pid) || pid < 0 || pid > 2_147_483_647) return 'unknown'
  return String(pid)
}

function formatAgeSeconds(value) {
  const age = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(age) || age < 0 || age > 2_147_483_647) return 'unknown'
  return String(age)
}

function formatCensusRow(row) {
  return [
    `pid=${formatPid(row.pid)}`,
    `backend_type=${categoryToken(row.backend_type)}`,
    `state=${categoryToken(row.state)}`,
    `age_seconds=${formatAgeSeconds(row.age_seconds)}`,
  ].join(' ')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Returns when `datname` has zero backends. Throws when the deadline passes
 * with any backend still attached. Does not call `pg_terminate_backend`.
 */
async function assertPrivateDatabaseBackendsExited(admin, databaseName, options = {}) {
  const drainTimeoutMs = options.drainTimeoutMs ?? PRIVATE_DB_BACKEND_DRAIN_MS
  const pollIntervalMs = options.pollIntervalMs ?? PRIVATE_DB_BACKEND_POLL_MS
  const deadline = Date.now() + drainTimeoutMs
  let rows = []
  for (;;) {
    const result = await admin.query(PRIVATE_DB_BACKEND_CENSUS_SQL, [databaseName])
    rows = result.rows
    if (rows.length === 0) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(pollIntervalMs, remaining))
  }
  const formatted = rows.map((row) => formatCensusRow(row))
  console.error('SYNTHETIC_DATABASE_CONNECTIONS_REMAIN', formatted)
  throw new Error(`private database backends remain after ${drainTimeoutMs}ms: ${formatted.join(' | ')}`)
}

exports.PRIVATE_DB_BACKEND_DRAIN_MS = PRIVATE_DB_BACKEND_DRAIN_MS
exports.PRIVATE_DB_BACKEND_POLL_MS = PRIVATE_DB_BACKEND_POLL_MS
exports.PRIVATE_DB_BACKEND_CENSUS_SQL = PRIVATE_DB_BACKEND_CENSUS_SQL
exports.assertPrivateDatabaseBackendsExited = assertPrivateDatabaseBackendsExited
