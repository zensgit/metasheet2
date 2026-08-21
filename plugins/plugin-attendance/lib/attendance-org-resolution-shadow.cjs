'use strict'

const { extractRequestedPunchOrgIdV1, loadActiveMembershipOrgIdsV1 } = require('./attendance-punch-org-resolution.cjs')

// SHADOW audit of the self-service punch route's org resolution
// (POST /api/attendance/punch only, plugins/plugin-attendance/index.cjs).
//
// This module never changes what org a punch is recorded under and never changes the
// response. It exists purely to answer, out of band, one question: if the route resolved
// org membership from the token CLAIM and the caller's `user_orgs` roster instead of (or in
// addition to) the request-supplied-org check that already ships
// (attendance-punch-org-resolution.cjs), would it have landed on the SAME org the route
// actually used? One audit row per punch, written to `attendance_org_resolution_shadow`
// (migration zzzz20260821090000_create_attendance_org_resolution_shadow.ts), never blocking
// or altering the punch itself.
//
// This module is wired into the route BEFORE `enforcePunchConstraints` (geofence/min-interval
// checks) and before any punch DML — a shadow row is written for every punch ATTEMPT that
// reaches this point in the route, not only for attempts that go on to succeed. A request that
// later 422s (e.g. WORK_DATE_ATTRIBUTION_AMBIGUOUS) or is rejected by the geofence check still
// gets one shadow row. There is no `punch_outcome` column distinguishing "attempted" from
// "actually recorded" — out of scope for a shadow-only audit — so a reader joining this table
// against `attendance_records` should expect more shadow rows than successful punches. There is
// also no retention/pruning policy yet for this table (owner item, not addressed by this PR).
//
// Env `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1` (tri-state, parsed ONCE at plugin startup
// by `parseAttendanceOrgResolutionShadowModeV1` — see plugins/plugin-attendance/index.cjs's
// `activate()`):
//   - unset / 'off' (the default): completely inert. The route never calls into this module
//     at all on this posture — not "the module runs and no-ops", the CALL SITE itself is
//     gated, so there is exactly zero additional query and zero additional row on the hot
//     path. This is the byte-identical-when-off contract this line's other flags all keep.
//   - 'shadow': the ONLY implemented active mode. On POST /api/attendance/punch, AFTER the
//     route has already resolved (and, for a request-supplied org, membership-checked) the
//     org it is about to use, this module independently re-derives what a claim/membership
//     driven resolution would have picked and persists ONE comparison row. The insert is
//     wrapped in try/catch and any failure is logged at WARN (throttled — see
//     `throttledShadowWarn` below) and swallowed — never surfaced to the caller, never
//     blocking the punch (see `recordShadowOrgResolutionV1`).
//   - 'enforce' or any other value: NOT implemented here. Rather than silently falling back
//     to 'off' — a contract bug: an enum field must reject an unrecognised value, never
//     silently default — an unsupported value fails PLUGIN STARTUP closed
//     (`parseAttendanceOrgResolutionShadowModeV1` throws; `activate()` calls it early enough
//     that the throw takes the whole plugin down, not just this feature). 'enforce' semantics
//     are a future PR's work, not this one's.
//
// `org_claim` is `req.authenticatedTenantId` — NOT the raw, unverified JWT payload value.
// `AuthService.verifyToken` (packages/core-backend/src/auth/AuthService.ts) re-derives it PER
// REQUEST: the token's own `tenantId` claim is looked up against the caller's REAL active
// `user_orgs` membership (`AuthService.resolveSessionTenantId`) and only survives onto the
// returned user — and therefore onto `req.authenticatedTenantId`, which `jwt-middleware.ts`
// sets ONLY from that already-verified user (jwt-middleware.ts:101-103), BEFORE that same
// middleware lets an `x-tenant-id` header backfill `req.user.tenantId` for a token that carries
// no claim of its own — if the membership check passes. Reading `req.user.tenantId` here would
// additionally blur "the caller's membership-verified claim asserts org X" with "this one
// request's header said X", which is exactly the ambiguity a resolution audit needs to keep
// apart.
//
// `orgLegacy` (the `org_legacy` column) is supplied by the CALLER (the route, via
// `ctx.orgLegacy`) and is a fully opaque pass-through value as far as this module is concerned
// — it is never re-derived from `req` here, never defaulted, never validated. The route MUST
// pass the exact same value it is about to write the punch under (see the call site in
// `index.cjs`, right after `const orgId = punchOrgResolution.orgId`) — NOT a fresh call to the
// route's `getOrgId(req)` helper, which uses `??` on RAW (unnormalized) values and therefore
// diverges from the actually-resolved org whenever the request supplies an EMPTY-STRING
// `body.orgId` alongside a usable `x-org-id` header (`getOrgId` locks onto the empty string via
// `??` and never reaches the header; `extractRequestedPunchOrgIdV1`, which the route's actual
// resolution goes through, normalizes first and correctly falls through to the header). This is
// a call-site correctness property this module cannot verify from the inside — see the real-DB
// suite's dedicated case for the constructed proof.
//
// Values-free by construction on the failure path: the only thing ever logged when the insert
// fails is a Postgres error CODE (or 'UNKNOWN') — never the org ids, the user id, or the
// driver's own error message, none of which belong in a warn log for an audit table.
//
// SCHEDULING (owner-review P2): `recordShadowOrgResolutionV1` is fire-and-forget from the call
// site (`plugins/plugin-attendance/index.cjs`, right after the punch route resolves `orgId` —
// see that call site's own comment) — `void recordShadowOrgResolutionV1(...).catch(() => {})`,
// never `await`ed into the punch response. A lock/pool wait inside this module must never drag
// the punch response, and this function's own returned promise is never on that critical path.
//
// RESOURCE ISOLATION (owner-review P2 follow-up): fire-and-forget alone does not stop a stuck
// shadow query from tying up a connection on the SAME pool the punch route itself depends on —
// a background query that never returns still holds a checked-out connection forever. Three
// routes to isolate this module's DB usage from the shared pool were investigated, in the order
// the owner asked for:
//   1. A connection string / secrets channel on the plugin context: NOT exposed.
//      `packages/core-backend/src/types/plugin.ts`'s `DatabaseAPI` is `{ query, transaction,
//      model }` only, and `PluginContext.config` is plugin-manifest config
//      (`resolvePluginRuntimeConfig`, packages/core-backend/src/index.ts), not a DB secret.
//   2. A named-pool factory: `PoolManager.createPool(name, opts)` DOES exist
//      (packages/core-backend/src/integration/db/connection-pool.ts, already used for shard
//      pools) — but it is NOT reachable from a plugin. No `.cjs` plugin file in this repo
//      `require()`s into `packages/core-backend` internals (checked: zero hits); doing so here
//      would be a new precedent, and exposing `createPool` through `context.api` would be a
//      CoreAPI surface change affecting every plugin, not a P2 fix's remit.
//   3. A plugin-owned raw `pg.Pool`: there IS a precedent
//      (`plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-database.cjs`),
//      but it deliberately uses a SEPARATE, role-bound credential from its own config loader —
//      not the shared `DATABASE_URL` — for least-privilege isolation, which is a different
//      problem than this module has. Reusing the shared `DATABASE_URL` here via a hand-rolled
//      `new Pool(...)` would mean re-deriving, and inevitably drifting from,
//      `PoolManager`'s ~15 lines of SSL/timeout/secret-source logic
//      (`DB_SSL`/`DB_SSL_REJECT_UNAUTHORIZED`/`DB_SSL_CA`/`DB_SSL_CERT`/`DB_SSL_KEY`,
//      `secretManager.get('DATABASE_URL', ...)`, prod-only SSL gating) outside the one place
//      that already owns it — a real drift/security risk for a default-off audit feature, not a
//      hypothetical one.
//
// All three routes closed, so this module takes the fallback the owner authorized: use the
// EXISTING, already-vetted `db.transaction(...)` capability (still backed by the shared pool),
// but issue `SET LOCAL statement_timeout` as the transaction's first statement
// (`SHADOW_STATEMENT_TIMEOUT_MS`) so a stuck membership SELECT or audit INSERT is CANCELLED
// SERVER-SIDE by Postgres itself — not merely abandoned client-side — and the connection is
// still released back to the shared pool by `ConnectionPool.transaction`'s own
// `finally { rawClient.release() }` once Postgres raises the cancellation. `SET LOCAL` is
// transaction-scoped and self-resets at COMMIT/ROLLBACK, so it never leaks onto any other
// query on that connection.
//
// `SHADOW_STATEMENT_TIMEOUT_MS` does NOT bound the time to ACQUIRE a connection from an already
// full pool in the first place (`pool.connect()`, inside `ConnectionPool.transaction`) — only a
// running statement. `RECORD_TIMEOUT_MS`'s outer `Promise.race` (in `recordShadowOrgResolutionV1`
// below) is the backstop for THAT case: it bounds how long this module's own returned promise
// can stay open regardless of where the stall is, though the underlying work (including
// whatever connection it may be holding) is not cancelled by the race losing — only by
// Postgres's own `statement_timeout`, or by the caller's own connection/pool timeouts.
//
// `IN_FLIGHT_CAP` bounds how many of this module's own transactions can be concurrently
// outstanding at all — once that many are already in flight, a new punch's shadow sample is
// DROPPED (never even attempts a connection) rather than queued, so the worst case this module
// can ever tie up on the shared pool is `IN_FLIGHT_CAP` connections for at most
// `SHADOW_STATEMENT_TIMEOUT_MS` each, not an unbounded, growing number.
//
// METRICS: `attempted = written + timed_out + dropped + failed` always holds — every call to
// `recordShadowOrgResolutionV1` increments `attempted` exactly once and resolves into EXACTLY
// ONE of the other four buckets (see `recordTerminalOnce` below), never zero, never two. This
// is an in-process counter only (module-level, like the warn-throttle clock above) — see
// `getShadowMetricsSnapshotForTestingV1` / `startShadowMetricsLoggingV1`.

const DEFAULT_ORG_ID = 'default'

const SHADOW_MODE_OFF = 'off'
const SHADOW_MODE_SHADOW = 'shadow'

const SHADOW_RULE_REQUEST = 'request'
const SHADOW_RULE_CLAIM = 'claim'
const SHADOW_RULE_SOLE_NON_DEFAULT_MEMBERSHIP = 'sole_non_default_membership'
const SHADOW_RULE_LEGACY_DEFAULT = 'legacy_default'
const SHADOW_RULE_AMBIGUOUS = 'ambiguous'

/**
 * Enum-strict tri-state parser for `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1`. Unset (or
 * blank) and `'off'` both mean the same inert default. `'shadow'` is the only implemented
 * active mode. Every other non-empty value — including the reserved, not-yet-implemented
 * `'enforce'` — throws rather than silently defaulting to `'off'`: a misconfigured enum
 * failing the deploy loudly is the point, not an inconvenience to work around.
 *
 * @param {string | undefined | null} rawValue
 * @returns {'off' | 'shadow'}
 */
function parseAttendanceOrgResolutionShadowModeV1(rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (trimmed.length === 0 || trimmed === SHADOW_MODE_OFF) return SHADOW_MODE_OFF
  if (trimmed === SHADOW_MODE_SHADOW) return SHADOW_MODE_SHADOW
  throw new Error(
    `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1=${JSON.stringify(rawValue)} is not a supported value. `
      + `Use "off" (the default; omit the variable entirely for the same effect) or "shadow". `
      + `"enforce" is reserved for a future PR and is NOT implemented by this build; any other `
      + `value is rejected the same way — the plugin fails to activate rather than silently `
      + `falling back to "off".`,
  )
}

/**
 * Pure decision core. Takes already-extracted, already-normalized data — no Express req/res,
 * no DB — so every branch is unit-testable in isolation. Mirrors the shape of
 * `decidePunchOrgResolutionV1` in the sibling module: a plain object in, a plain object out.
 *
 * Rule order (first match wins):
 *   1. `request`                      — the request itself supplied an org (already
 *                                        membership-checked upstream by
 *                                        attendance-punch-org-resolution.cjs); the org the
 *                                        route actually used (`orgLegacy`) IS that org, so this
 *                                        module's guess is simply that same value.
 *   2. `claim`                        — no request-supplied org, but the token carries a
 *                                        tenant CLAIM, and either that claim is not the
 *                                        legacy default sentinel OR the caller has no
 *                                        non-default membership to prefer instead. This is the
 *                                        ONLY branch that trusts the claim outright.
 *   3. `sole_non_default_membership`  — no usable claim (see 2's guard below), but the caller
 *                                        has EXACTLY ONE non-default active membership: an
 *                                        unambiguous single alternative to the legacy default.
 *   4. `legacy_default`               — no usable claim, and the caller has ZERO non-default
 *                                        memberships at all: 'default' is the only membership
 *                                        that could possibly apply.
 *   5. `ambiguous`                    — none of the above: either the claim IS the legacy
 *                                        default sentinel while the caller ALSO holds one or
 *                                        more non-default memberships (the claim is refused as
 *                                        a false-positive default — see rule 2's guard), or the
 *                                        caller holds two-or-more non-default memberships with
 *                                        no claim and no request to break the tie. `orgChosen`
 *                                        is `null`: refusing to guess is the honest answer, not
 *                                        picking one arbitrarily.
 *
 * Rule 2's guard is the load-bearing branch this whole audit exists to surface: a token claim
 * of exactly `'default'` — the shape a pre-existing/backfilled user's token carries when no
 * tenant was ever chosen — must NOT be trusted as "the caller's real org" the moment that same
 * caller also holds a real, non-default membership. Trusting it there would silently prefer a
 * placeholder value over an actual membership; refusing it here is deliberate, not an omission.
 *
 * `orgLegacy` is used ONLY as a plain equality target for `agree` (and, verbatim, as
 * `orgChosen` under rule `request`) — this function never re-derives, defaults, or validates
 * it. Whatever the caller passes in is what gets echoed back; correctness of that value is
 * entirely the caller's responsibility (see the module doc comment above).
 *
 * @param {{
 *   requestOrgSupplied: boolean,
 *   orgLegacy: string,
 *   orgClaim: string | null,
 *   activeMembershipOrgIds: string[],
 * }} input
 * @returns {{
 *   membershipCount: number,
 *   nonDefaultMembershipCount: number,
 *   orgChosen: string | null,
 *   agree: boolean,
 *   rule: 'request' | 'claim' | 'sole_non_default_membership' | 'legacy_default' | 'ambiguous',
 * }}
 */
function decideShadowOrgResolutionV1(input) {
  const requestOrgSupplied = input && input.requestOrgSupplied === true
  const orgLegacy = input && typeof input.orgLegacy === 'string' ? input.orgLegacy : ''
  const orgClaim = input && typeof input.orgClaim === 'string' && input.orgClaim.length > 0 ? input.orgClaim : null
  const activeMembershipOrgIds = input && Array.isArray(input.activeMembershipOrgIds) ? input.activeMembershipOrgIds : []

  const membershipCount = activeMembershipOrgIds.length
  const nonDefaultMemberships = activeMembershipOrgIds.filter((orgId) => orgId !== DEFAULT_ORG_ID)
  const nonDefaultMembershipCount = nonDefaultMemberships.length

  let orgChosen = null
  let rule = SHADOW_RULE_AMBIGUOUS

  if (requestOrgSupplied) {
    orgChosen = orgLegacy
    rule = SHADOW_RULE_REQUEST
  } else if (orgClaim !== null && (orgClaim !== DEFAULT_ORG_ID || nonDefaultMembershipCount === 0)) {
    orgChosen = orgClaim
    rule = SHADOW_RULE_CLAIM
  } else if (nonDefaultMembershipCount === 1) {
    orgChosen = nonDefaultMemberships[0]
    rule = SHADOW_RULE_SOLE_NON_DEFAULT_MEMBERSHIP
  } else if (nonDefaultMembershipCount === 0) {
    orgChosen = DEFAULT_ORG_ID
    rule = SHADOW_RULE_LEGACY_DEFAULT
  } else {
    orgChosen = null
    rule = SHADOW_RULE_AMBIGUOUS
  }

  return {
    membershipCount,
    nonDefaultMembershipCount,
    orgChosen,
    agree: orgChosen === orgLegacy,
    rule,
  }
}

// Warn-log throttling: at most one warn per process per WARN_THROTTLE_WINDOW_MS, regardless of
// how many recordShadowOrgResolutionV1 failures happen in that window. This is a
// non-fatal/best-effort audit write on a hot path (every punch, when the flag is on) — a
// sustained failure (e.g. the table dropped, or a connection-pool outage) must not turn into a
// warn-per-punch log storm. `lastWarnAtMs` is module-level (shared across every call in this
// process), matching "once per process", not once per request/user/table.
const WARN_THROTTLE_WINDOW_MS = 60_000
let lastWarnAtMs = 0

function resolveWarnFn(logger) {
  return logger && typeof logger.warn === 'function'
    ? logger.warn.bind(logger)
    : typeof console !== 'undefined' && typeof console.warn === 'function'
      ? console.warn.bind(console)
      : () => {}
}

function throttledShadowWarn(logger, message, meta) {
  const now = Date.now()
  if (now - lastWarnAtMs < WARN_THROTTLE_WINDOW_MS) return
  lastWarnAtMs = now
  resolveWarnFn(logger)(message, meta)
}

/**
 * Test-only: resets the module-level warn-throttle clock so a test suite can assert throttling
 * behaviour deterministically regardless of what ran (and warned) earlier in the same process.
 * Never called from production code.
 */
function resetShadowWarnThrottleForTestingV1() {
  lastWarnAtMs = 0
}

// ---------------------------------------------------------------------------------------------
// Timeouts, in-flight cap, metrics — see the "SCHEDULING" / "RESOURCE ISOLATION" / "METRICS"
// paragraphs in the module doc comment above for the full rationale.
// ---------------------------------------------------------------------------------------------

// Server-side statement timeout for the recorder's transaction (SET LOCAL, see
// performShadowRecordV1). A fixed internal constant — never request-derived — so inlining it
// into SQL text is not an injection risk (SET does not accept bound parameters).
const SHADOW_STATEMENT_TIMEOUT_MS = 4000

// Outer JS-side backstop. Strictly greater than SHADOW_STATEMENT_TIMEOUT_MS so a normal
// DB-side statement cancellation has a chance to settle `work` first (and land in the `failed`
// bucket); this timer exists for stalls statement_timeout cannot see — acquiring a connection
// from an exhausted pool in the first place.
const RECORD_TIMEOUT_MS = 5000

// How many of this module's own transactions may be concurrently outstanding at once. Once
// this many are already in flight, a new sample is DROPPED (no connection is even attempted)
// rather than queued — this is what actually bounds worst-case pool tie-up, not the timeout
// alone (a hung DB could otherwise let in-flight work grow without limit).
const IN_FLIGHT_CAP = 8

const SHADOW_TIMEOUT_WARN_MESSAGE =
  'attendance_org_resolution_shadow exceeded the 5000ms safety timeout; the underlying query/transaction is NOT cancelled by this timer (Postgres statement_timeout may still cancel it server-side) and may still complete in the background'
const SHADOW_DROPPED_WARN_MESSAGE =
  'attendance_org_resolution_shadow dropped: in-flight cap reached; sample skipped, no connection attempted'

// In-process metrics. `attempted = written + timed_out + dropped + failed` always holds — see
// recordTerminalOnce below for the exactly-once accounting that keeps it true.
const shadowMetrics = { attempted: 0, written: 0, timed_out: 0, dropped: 0, failed: 0 }

/**
 * Test-only: a snapshot copy of the current metrics counters. Never mutated by the caller —
 * callers get a plain object, not a reference into module state.
 * @returns {{ attempted: number, written: number, timed_out: number, dropped: number, failed: number }}
 */
function getShadowMetricsSnapshotForTestingV1() {
  return { ...shadowMetrics }
}

/**
 * Test-only: zeroes every metrics counter so a test suite's assertions are independent of what
 * ran earlier in the same process. Never called from production code.
 */
function resetShadowMetricsForTestingV1() {
  shadowMetrics.attempted = 0
  shadowMetrics.written = 0
  shadowMetrics.timed_out = 0
  shadowMetrics.dropped = 0
  shadowMetrics.failed = 0
}

function resolveLoggerFn(logger, level) {
  if (logger && typeof logger[level] === 'function') return logger[level].bind(logger)
  if (typeof console !== 'undefined' && typeof console[level] === 'function') return console[level].bind(console)
  return () => {}
}

/**
 * Logs the current metrics snapshot at INFO. Values-free by construction: only integer counts,
 * never user/org identifiers.
 * @param {{ info?: (message: string, meta?: Record<string, unknown>) => void }} [logger]
 */
function logShadowMetricsSnapshotV1(logger) {
  resolveLoggerFn(logger, 'info')('attendance_org_resolution_shadow metrics snapshot', getShadowMetricsSnapshotForTestingV1())
}

const SHADOW_METRICS_LOG_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Starts periodic metrics logging (owner requirement: a 30-day shadow sample must not silently
 * lose data during an incident without at least a periodic log trail). Returns a stop function.
 * Callers (plugins/plugin-attendance/index.cjs's activate/deactivate) MUST call the returned
 * stop function on deactivation/reactivation — `activatePluginInstance` does not call
 * `deactivate()` before re-running `activate()`, so a caller that starts a new interval on every
 * activation without stopping the previous one would leak timers across plugin reloads.
 * @param {{ info?: (message: string, meta?: Record<string, unknown>) => void }} [logger]
 * @param {number} [intervalMs]
 * @returns {() => void}
 */
function startShadowMetricsLoggingV1(logger, intervalMs = SHADOW_METRICS_LOG_INTERVAL_MS) {
  const handle = setInterval(() => logShadowMetricsSnapshotV1(logger), intervalMs)
  if (handle && typeof handle.unref === 'function') handle.unref()
  return () => clearInterval(handle)
}

// In-flight bookkeeping. Fire-and-forget scheduling at the call site means the punch response
// can return before this module's own DB work has completed — this counter (and the waiter
// list below) is the ONLY way a test can deterministically know "no recorder work is currently
// outstanding" instead of sleeping a guessed duration.
let inFlightCount = 0
let idleWaiters = []

function markRecorderStarted() {
  inFlightCount += 1
}

function markRecorderSettled() {
  inFlightCount -= 1
  if (inFlightCount <= 0) {
    inFlightCount = 0
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/**
 * Test-only: resolves once no recordShadowOrgResolutionV1 work is currently in flight anywhere
 * in this process (module-level counter, matching the module-level nature of the warn-throttle
 * clock above). A DROPPED sample never increments the in-flight counter in the first place, so
 * this resolves immediately when the cap is the only thing that fired. NEVER used in production
 * code — the whole point of the fire-and-forget call site is that production code never waits
 * on this. Real-DB integration tests use this instead of a sleep to deterministically wait for
 * background work before asserting on rows it writes.
 * @returns {Promise<void>}
 */
function whenIdleForTestingV1() {
  if (inFlightCount <= 0) return Promise.resolve()
  return new Promise((resolve) => { idleWaiters.push(resolve) })
}

/**
 * Test-only: forces the in-flight counter and waiter list back to a clean slate. A test that
 * deliberately leaves recorder work permanently pending (e.g. a never-resolving mock db, to
 * prove the timeout or cap behaviour) would otherwise leak an elevated `inFlightCount` into
 * every later test in the same process — this is the cleanup hook for exactly that case. Does
 * NOT resolve any outstanding `whenIdleForTestingV1()` waiters (a reset is "start fresh", not a
 * real settle event) — a test that still has one pending after calling this has a bug of its
 * own, and will hang/time out rather than silently pass. Never called from production code.
 */
function resetShadowInFlightForTestingV1() {
  inFlightCount = 0
  idleWaiters = []
}

/**
 * The actual DB work: loads the caller's active memberships (ONE query — the same `user_orgs`
 * predicate the sibling punch-org-resolution module already uses, reused here rather than
 * re-implemented), runs the pure core, and inserts ONE audit row — all inside ONE transaction
 * whose first statement sets a server-side statement timeout (see the module doc comment's
 * "RESOURCE ISOLATION" paragraph). Non-fatal by construction — any failure (missing table,
 * connection error, constraint violation, statement-timeout cancellation) is caught, logged at
 * WARN, throttled, and swallowed — this function itself never rejects. `onTerminal` is called
 * exactly once, with 'written' or 'failed', before this function returns — see
 * recordShadowOrgResolutionV1's `recordTerminalOnce` for why exactly-once matters.
 *
 * @param {{ transaction: (cb: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<void>) => Promise<void> }} db
 * @param {object} req
 * @param {{ userId: string, orgLegacy: string, route: string }} ctx
 * @param {{ warn: (message: string, meta?: Record<string, unknown>) => void }} [logger]
 * @param {(bucket: 'written' | 'failed') => void} onTerminal
 * @returns {Promise<void>}
 */
async function performShadowRecordV1(db, req, ctx, logger, onTerminal) {
  try {
    const userId = ctx && typeof ctx.userId === 'string' && ctx.userId.length > 0 ? ctx.userId : null
    if (userId === null) {
      // attendance_org_resolution_shadow.user_id is NOT NULL. The route always supplies a
      // non-empty ctx.userId here — the SAME value already required non-null by the route's
      // own pre-existing 401 check (getUserId(req)) before this is ever reached — so this
      // branch should be unreachable in production. Skip the otherwise-guaranteed-to-fail
      // INSERT rather than issue a query that can only violate the NOT NULL constraint, and
      // warn (throttled, like every other failure path here) instead of staying silent. Counted
      // as 'failed' (never wrote a row) for the metrics invariant — there is no separate bucket
      // for this unreachable-in-production shape.
      throttledShadowWarn(logger, 'attendance_org_resolution_shadow skipped: missing userId', {})
      onTerminal('failed')
      return
    }

    const orgLegacy = ctx && typeof ctx.orgLegacy === 'string' ? ctx.orgLegacy : ''
    const route = ctx && typeof ctx.route === 'string' ? ctx.route : ''

    const requestedOrgId = extractRequestedPunchOrgIdV1(req)
    const requestOrgSupplied = requestedOrgId !== null
    const rawClaim = req && req.authenticatedTenantId
    const orgClaim = typeof rawClaim === 'string' && rawClaim.trim().length > 0 ? rawClaim.trim() : null

    await db.transaction(async (trx) => {
      // Real, server-side statement cancellation scoped to THIS transaction only — see the
      // module doc comment's "RESOURCE ISOLATION" paragraph for why this exists instead of a
      // dedicated pool. Must be the FIRST statement in the transaction to cover both queries
      // below.
      await trx.query(`SET LOCAL statement_timeout = '${SHADOW_STATEMENT_TIMEOUT_MS}ms'`)

      const activeMembershipOrgIds = await loadActiveMembershipOrgIdsV1(trx, userId)

      const decision = decideShadowOrgResolutionV1({
        requestOrgSupplied,
        orgLegacy,
        orgClaim,
        activeMembershipOrgIds,
      })

      await trx.query(
        `INSERT INTO attendance_org_resolution_shadow
           (user_id, route, org_legacy, org_claim, request_org_supplied, membership_count,
            non_default_membership_count, org_chosen, agree, rule)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId,
          route,
          orgLegacy,
          orgClaim,
          requestOrgSupplied,
          decision.membershipCount,
          decision.nonDefaultMembershipCount,
          decision.orgChosen,
          decision.agree,
          decision.rule,
        ],
      )
    })
    onTerminal('written')
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'UNKNOWN'
    throttledShadowWarn(logger, 'attendance_org_resolution_shadow insert failed; non-fatal, punch response unaffected', { code })
    onTerminal('failed')
  }
}

/**
 * Public entry point, called fire-and-forget from the punch route (see the module doc comment's
 * "SCHEDULING" paragraph) — `void recordShadowOrgResolutionV1(...).catch(() => {})`. This
 * function itself is designed to never reject (performShadowRecordV1 catches everything
 * internally), but the call site's own `.catch` is belt-and-braces in case an unexpected
 * synchronous throw or rejected promise ever slips through.
 *
 * Orchestrates, in order: (1) metrics `attempted`, (2) the in-flight CAP check — over cap drops
 * the sample immediately, no connection attempted, (3) in-flight bookkeeping +
 * performShadowRecordV1, raced against a RECORD_TIMEOUT_MS backstop so this function's own
 * returned promise cannot stay open forever even if the underlying work does. Exactly one of
 * {written, timed_out, dropped, failed} is recorded per call — `recordTerminalOnce` is the
 * single choke point that guarantees that, regardless of whether the timeout or the underlying
 * work "wins" the race.
 *
 * Callers MUST gate the call itself on `parseAttendanceOrgResolutionShadowModeV1(...) ===
 * 'shadow'` — this function does not re-check the env itself, so the 'off' posture's
 * zero-queries guarantee depends entirely on the call site never invoking it, not on an
 * internal early-return.
 *
 * @param {{ transaction: (cb: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<void>) => Promise<void> }} db
 * @param {object} req - Express request (`.user`, `.body`, `.query`, `.headers`,
 *   `.authenticatedTenantId`)
 * @param {{ userId: string, orgLegacy: string, route: string }} ctx - `userId` is the SAME
 *   value the route already derived via `getUserId(req)` for its own 401 check, passed in
 *   rather than re-extracted here so there is exactly one source of caller identity per
 *   request. `orgLegacy` is the org the route is actually about to use (post membership-check)
 *   — see the module doc comment for the exact call-site correctness requirement on this value.
 *   `route` is the route's own literal path, not `req.path` — this module is wired into ONE
 *   route only, and a literal keeps this row honest even if the route is ever remounted.
 * @param {{ warn: (message: string, meta?: Record<string, unknown>) => void }} [logger]
 * @returns {Promise<void>}
 */
async function recordShadowOrgResolutionV1(db, req, ctx, logger) {
  shadowMetrics.attempted += 1

  if (inFlightCount >= IN_FLIGHT_CAP) {
    shadowMetrics.dropped += 1
    throttledShadowWarn(logger, SHADOW_DROPPED_WARN_MESSAGE, { reason: 'cap_exceeded' })
    return
  }

  let terminalRecorded = false
  const recordTerminalOnce = (bucket) => {
    if (terminalRecorded) return
    terminalRecorded = true
    shadowMetrics[bucket] += 1
  }

  markRecorderStarted()
  const work = performShadowRecordV1(db, req, ctx, logger, recordTerminalOnce)
  // Belt-and-braces: performShadowRecordV1 never rejects by construction, but attaching a
  // handler here means even an unexpected rejection can never surface as an unhandled
  // rejection, independent of whether Promise.race below already "handled" it.
  work.finally(markRecorderSettled).catch(() => {})

  let timeoutHandle
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      recordTerminalOnce('timed_out')
      throttledShadowWarn(logger, SHADOW_TIMEOUT_WARN_MESSAGE, { reason: 'timeout' })
      resolve()
    }, RECORD_TIMEOUT_MS)
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref()
  })

  try {
    await Promise.race([work, timeoutPromise])
  } finally {
    clearTimeout(timeoutHandle)
  }
}

module.exports = {
  parseAttendanceOrgResolutionShadowModeV1,
  decideShadowOrgResolutionV1,
  recordShadowOrgResolutionV1,
  resetShadowWarnThrottleForTestingV1,
  whenIdleForTestingV1,
  resetShadowInFlightForTestingV1,
  getShadowMetricsSnapshotForTestingV1,
  resetShadowMetricsForTestingV1,
  startShadowMetricsLoggingV1,
  logShadowMetricsSnapshotV1,
  WARN_THROTTLE_WINDOW_MS,
  SHADOW_STATEMENT_TIMEOUT_MS,
  RECORD_TIMEOUT_MS,
  IN_FLIGHT_CAP,
  SHADOW_METRICS_LOG_INTERVAL_MS,
  SHADOW_MODE_OFF,
  SHADOW_MODE_SHADOW,
  SHADOW_RULE_REQUEST,
  SHADOW_RULE_CLAIM,
  SHADOW_RULE_SOLE_NON_DEFAULT_MEMBERSHIP,
  SHADOW_RULE_LEGACY_DEFAULT,
  SHADOW_RULE_AMBIGUOUS,
}
