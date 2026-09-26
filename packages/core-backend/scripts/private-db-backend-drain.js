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
 * reason that residual census does not log role names. What is emitted is
 * `pid`, `backend_type`, `state`, `application_name`, and `backend_start`,
 * each passed through a positive charset bound.
 */

const PRIVATE_DB_BACKEND_DRAIN_MS = 10_000
const PRIVATE_DB_BACKEND_POLL_MS = 200

/** The only census this helper issues. It must not name `query` or `usename`. */
const PRIVATE_DB_BACKEND_CENSUS_SQL =
  'SELECT pid, application_name, backend_type, state, backend_start FROM pg_stat_activity WHERE datname = $1 ORDER BY pid'

const IDENTITY_TOKEN = /[^A-Za-z0-9_.-]+/g
const CATEGORY_TOKEN = /[^A-Za-z0-9_. -]+/g

function identityToken(value) {
  const cleaned = String(value ?? '').replace(IDENTITY_TOKEN, '').slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'unknown'
}

function categoryToken(value) {
  const cleaned = String(value ?? '').replace(CATEGORY_TOKEN, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'unknown'
}

function formatPid(value) {
  const pid = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(pid) || pid < 0 || pid > 2_147_483_647) return 'unknown'
  return String(pid)
}

function formatBackendStart(value) {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'unknown'
  return date.toISOString()
}

function formatCensusRow(row) {
  return [
    `pid=${formatPid(row.pid)}`,
    `backend_type=${categoryToken(row.backend_type)}`,
    `state=${categoryToken(row.state)}`,
    `application_name=${identityToken(row.application_name)}`,
    `backend_start=${formatBackendStart(row.backend_start)}`,
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
  const detail = rows.map((row) => formatCensusRow(row)).join(' | ')
  throw new Error(`private database backends remain after ${drainTimeoutMs}ms: ${detail}`)
}

exports.PRIVATE_DB_BACKEND_DRAIN_MS = PRIVATE_DB_BACKEND_DRAIN_MS
exports.PRIVATE_DB_BACKEND_POLL_MS = PRIVATE_DB_BACKEND_POLL_MS
exports.PRIVATE_DB_BACKEND_CENSUS_SQL = PRIVATE_DB_BACKEND_CENSUS_SQL
exports.assertPrivateDatabaseBackendsExited = assertPrivateDatabaseBackendsExited
