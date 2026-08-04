#!/usr/bin/env node
'use strict'

// Stock-preparation E2E functional smoke (RD-E2E, #4695-adjacent — functional testing, NOT the #4695
// controlled acceptance).
//
// Stands up a containerized, synthetic-data-only, entity-machine-free harness against a LOCALLY-booted
// core-backend server (Postgres + SQL Server service containers, dispatched job only) and proves:
//
//   1. the EXISTING chain (scripts/ops/stock-preparation-prep-line-extended-smoke.mjs, T4) reproduces its
//      documented 8/8 audit-action coverage over real HTTP against this local server;
//   2. the S6-A sealed-snapshot route's flag gate is real — a flag-OFF arm (404 DISABLED), an exact-match
//      arm ('1' and 'yes' must NOT enable it), and (when the full runtime can be provisioned in-job) a
//      flag-ON arm that walks capture -> private ingestion -> generation kernel -> apply over a REAL,
//      first-party, ephemeral SQL Server container — never a customer source, never the #4695 entity
//      machine, never a production flag default.
//
// Honesty discipline (repo standing instruction): any phase that cannot complete in this CI job is
// reported NOT_RUN, never PASS. A non-zero script exit is itself not evidence — the values-free result
// block below is the evidence, and every field there is either a fixed enum, a count, or a boolean.
//
// This script assumes it runs INSIDE the isolated CI job described by
// .github/workflows/stock-preparation-e2e-functional-smoke.yml: Postgres + SQL Server service containers,
// dependencies installed, and the two sealed-export Postgres roles + all migrations already applied. It
// manages its OWN core-backend server process lifecycle (multiple restarts, one per env-var arm) and never
// touches the deployed entity host or any `origin`-tracked production configuration.
//
// R9 restructure — E2E_S6A_ARM ('primary' | 'midtier' | 'rejection', default 'primary'): a single
// invocation of this script executes exactly ONE arm's S6-A work, never two, because each arm provisions
// its OWN ACTIVE sealed-export binding and migrations/073's single-ACTIVE-binding-in-the-whole-table
// constraint (a RATIFIED design, never widened) means a second arm's provisioning attempt in the SAME
// database permanently fails once any earlier arm's binding is ACTIVE. See the block comment above the
// S6A_ARM constant for the full rationale, and
// scripts/ops/stock-preparation-e2e-compute-scale-slope.mjs for how the primary-vs-mid-tier timing slope
// is reassembled downstream from separate job outputs now that the arms are separate processes.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const requireFromPlugin = createRequire(
  path.join(REPO_ROOT, 'plugins/plugin-integration-core/package.json'),
)

const canonicalCodec = require_(
  'plugins/plugin-integration-core/lib/sealed-export/canonical-json.cjs',
)
// The product's OWN declared row-count bound (stock-preparation-sealed-snapshot-decoder.cjs's
// MAX_BUSINESS_LINES, itself derived from stock-preparation-sync-run-persist.cjs's
// PERSIST_MAX_PLAN_LINES = 500*50-1 = 24999). Read from the product rather than hardcoded here, so the
// rejection arm below always tests "one over whatever the product currently declares", never a stale
// number this harness invented independently.
const sealedSnapshotDecoder = require_(
  'plugins/plugin-integration-core/lib/stock-preparation-sealed-snapshot-decoder.cjs',
)
const MAX_BUSINESS_LINES = sealedSnapshotDecoder.MAX_BUSINESS_LINES

function require_(relativePath) {
  return requireFromPlugin(path.join(REPO_ROOT, relativePath))
}

const SUMMARY_HEADER = 'STOCK_PREPARATION_E2E_FUNCTIONAL_SMOKE'
const S = {
  mode: 'functional_testing_synthetic_data',
  substituteForEntityAcceptance: false,
}
// Exported (not just module-private) so other scripts in this lane — specifically
// stock-preparation-e2e-negative-control.mjs — can derive their own exit code from the SAME array via
// the SAME `CHECKS.some((c) => !c.ok)` formula main() uses below, instead of hardcoding an exit code that
// does not actually depend on whether any check failed.
export const CHECKS = []

export function must(name, ok, detail = '') {
  CHECKS.push({ name, ok: ok === true, detail })
  const mark = ok === true ? 'ok' : 'FAIL'
  process.stderr.write(`[e2e] ${name}: ${mark}${detail ? ` (${detail})` : ''}\n`)
  return ok === true
}

function note(name, detail = '') {
  process.stderr.write(`[e2e] ${name}${detail ? ` (${detail})` : ''}\n`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The S6-A authority chain's requiredFutureInstant (sealed-export-lifecycle-provisioning.cjs:168-180)
// requires SECONDS-precision UTC ISO-8601 (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/`) — a plain
// `new Date(...).toISOString()` carries a milliseconds component and fails that format check, which
// surfaces as SEALED_EXPORT_BINDING_UNQUALIFIED with no further detail (root-caused via a temporary
// error.stack replay of provisionInitial, since removed: failSealedExport -> requiredFutureInstant ->
// normalizeAuthorityInput -> provisionInitialStockPreparationBinding). This mirrors the SAME
// seconds-truncation the production code's own toUtcSecondsIso helper performs.
function toUtcSecondsIso(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ── config ──────────────────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.E2E_SERVER_PORT || 7801)
const BASE_URL = `http://127.0.0.1:${PORT}`
const TENANT_ID = 'e2efunc-tenant'
const ADMIN_USER_ID = 'e2efunc-admin'
const REQUEST_TIMEOUT_MS = 20000
const HEALTH_TIMEOUT_MS = 90000
const ARTIFACT_ROOT = process.env.E2E_ARTIFACT_ROOT || path.join(os.tmpdir(), 'stock-prep-e2e-artifact-root')
const OUT_DIR = process.env.E2E_OUT_DIR || path.join(REPO_ROOT, 'output/stock-preparation-e2e-functional-smoke')

// Postgres sealed-export authority roles the workflow already created + migrated against.
const RUNTIME_DB_ROLE = process.env.E2E_S6A_RUNTIME_DB_ROLE || ''
const RUNTIME_DB_URL = process.env.E2E_S6A_RUNTIME_DB_URL || ''
const PROVISIONING_DB_ROLE = process.env.E2E_S6A_PROVISIONING_DB_ROLE || ''
const PROVISIONING_DB_URL = process.env.E2E_S6A_PROVISIONING_DB_URL || ''

// SQL Server service container (first-party, ephemeral, synthetic data only).
const MSSQL_HOST = process.env.MSSQL_HOST || '127.0.0.1'
const MSSQL_PORT = Number(process.env.MSSQL_PORT || 1433)
const MSSQL_SA_USER = process.env.MSSQL_USERNAME || 'sa'
const MSSQL_SA_PASSWORD = process.env.MSSQL_PASSWORD || ''
const MSSQL_DATABASE = 'metasheet_e2e_stock_prep'
const MSSQL_TABLE = 'dbo.stock_prep_e2e_rows'
const MSSQL_READER_LOGIN = 'e2e_s6a_reader'
const MSSQL_READER_PASSWORD = `E2eReader_${crypto.randomBytes(9).toString('hex')}!Aa1`

// ── R9 scale-leg config ─────────────────────────────────────────────────────────────────────────────
//
// The declared bound (packages/core-backend/migrations/073_*.sql CHECK business_line_count BETWEEN 1 AND
// 24999; runtime guards at stock-preparation-runtime-store.cjs:234/:591; MAX_BUSINESS_LINES above) had —
// until this leg — never been exercised end-to-end, only in a pure in-process decoder unit test. This
// config block parameterises the row count so that gap can be closed WITHOUT changing what today's
// default dispatch does.
function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer for E2E_S6A_ROW_COUNT-style env var: ${JSON.stringify(raw)}`)
  }
  return parsed
}
// The S6-A fixture row count (requirement 1). Default 3 preserves EXACTLY today's behaviour: the primary
// walk below (attemptS6ARealRun) always seeds exactly DEFAULT_S6A_ROW_COUNT rows regardless of this
// value, and the NEW mid-tier + rejection scale legs only execute when this env var requests something
// other than the default — see S6A_SCALE_REQUESTED. A default (unset) dispatch therefore runs the SAME
// single 3-row walk it always has; the scale legs report NOT_RUN/SCALE_NOT_REQUESTED instead of executing.
const DEFAULT_S6A_ROW_COUNT = 3
const S6A_ROW_COUNT = parsePositiveInt(process.env.E2E_S6A_ROW_COUNT, DEFAULT_S6A_ROW_COUNT)
const S6A_SCALE_REQUESTED = S6A_ROW_COUNT !== DEFAULT_S6A_ROW_COUNT
// One over the product's OWN declared bound (requirement 6) — never independently invented, always
// "whatever MAX_BUSINESS_LINES currently is, plus one".
const S6A_REJECTION_ROW_COUNT = MAX_BUSINESS_LINES + 1

// ── R9 restructure: one arm per process ─────────────────────────────────────────────────────────────
//
// migrations/073_create_sealed_export_stock_prep_runtime_authority.sql's
// uniq_integration_sealed_export_stock_prep_single_customer is a UNIQUE INDEX on the CONSTANT expression
// `(1)` WHERE status='ACTIVE' — at most ONE ACTIVE binding in the ENTIRE table, across every tenant, not
// just within one tenant (the comment directly above that index in the migration: "S6-A is deliberately
// single-customer... a later multi-customer profile must use a separately ratified schema/version rather
// than widening this index" — a RATIFIED constraint this harness works within, never around). There is
// also no retirement path: BINDING_TABLE has exactly three operations repo-wide (selectOneForUpdate +
// insertOne in sealed-export-lifecycle-provisioning.cjs, selectOne in stock-preparation-runtime-store.cjs)
// — no UPDATE, no DELETE — so once ANY arm's binding goes ACTIVE, it is ACTIVE forever. Running the
// primary walk, the mid-tier walk and the rejection arm in the SAME process against the SAME database (as
// this file did before this restructure) therefore meant the primary walk's binding permanently blocked
// both scale arms' own provisioning attempts — dispatched runs 30880831626 and 30881132451 both show the
// primary walk activating its binding, then both scale arms failing provisioning with
// SEALED_EXPORT_INTERNAL_ERROR. The only fix within the ratified single-ACTIVE-binding design is to give
// each arm its OWN pristine database — which GitHub Actions can only do PER JOB (`services:` containers
// are scoped to a job, not a step, not a process). E2E_S6A_ARM selects exactly ONE arm's S6-A work per
// process; a run never touches more than one arm. Default 'primary' reproduces exactly what this whole
// file did before this env var existed (Phases 1-4 below, unconditionally) — see the functional-smoke /
// scale-midtier / scale-rejection jobs in .github/workflows/stock-preparation-e2e-functional-smoke.yml.
// The two-point slope this file used to compute in-process from the primary and mid-tier walks' own
// timings (now impossible — they are different processes, different job runs, potentially different
// wall-clock machines) is computed by a dedicated downstream job instead, from job outputs each arm
// publishes — see scripts/ops/stock-preparation-e2e-compute-scale-slope.mjs.
const S6A_VALID_ARMS = new Set(['primary', 'midtier', 'rejection'])
const S6A_ARM = String(process.env.E2E_S6A_ARM || 'primary').trim()
if (!S6A_VALID_ARMS.has(S6A_ARM)) {
  throw new Error(`invalid E2E_S6A_ARM: ${JSON.stringify(process.env.E2E_S6A_ARM)} (want one of: ${[...S6A_VALID_ARMS].join(', ')})`)
}
// The S6-A run POST gets its OWN timeout (requirement 4), separate from REQUEST_TIMEOUT_MS (20s, sized
// for cheap health/flag probes) — a real capture of thousands of rows needs materially longer, and using
// the same 20s budget for both would make every scale-leg POST time out by construction, not by measurement.
const S6A_POST_TIMEOUT_MS = Number(process.env.E2E_S6A_POST_TIMEOUT_MS || 240000)
// T-SQL hard-caps a multi-row `INSERT ... VALUES (...), (...), ...` statement at 1000 rows (this is a row
// count limit, not a byte-length limit, so the one oversized-payload row in a batch does not change it).
// 500 leaves comfortable headroom under that cap.
const SQLSERVER_INSERT_BATCH_SIZE = 500
// The scale legs CANNOT reuse TENANT_ID (the primary walk's tenant): the S6-A route hardcodes
// `workspaceId: null` server-side (http-routes.cjs's stockPreparationSqlServerSealedSnapshotRun), and
// provisionInitialStockPreparationBinding's own `activeBinding` lookup is scoped ONLY by
// `{tenant_id, workspace_id, object_key}` — NOT by binding_version or external_system_id
// (sealed-export-lifecycle-provisioning.cjs ~line 491). Once the primary walk's binding is ACTIVE for
// TENANT_ID, a second provisioning attempt for a DIFFERENT binding identity under the SAME
// (tenant, workspace, object_key) finds that row, fails `initialProvisioningMatches` (different
// binding_version/external_system_id) and `initialProvisioningCanRefreshQualification` (same match
// requirement), and refuses SEALED_EXPORT_BINDING_UNQUALIFIED — permanently, not just on the first
// attempt. Verified by reading the function directly, not run. Each scale arm therefore gets its OWN
// dedicated tenant (workspaceId stays null, matching what the route hardcodes), making its
// {tenant_id, workspace_id, object_key} scope disjoint from the primary's and from every other arm's.
const SCALE_TENANT_ID_PREFIX = 'e2efunc-tenant-scale'

const BASE_ENV = Object.freeze({
  ...process.env,
  DISABLE_WORKFLOW: 'true',
  DISABLE_EVENT_BUS: 'true',
  NODE_ENV: 'development',
  LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'warn',
  PORT: String(PORT),
  RBAC_TOKEN_TRUST: 'true',
  JWT_SECRET: process.env.E2E_JWT_SECRET,
  INTEGRATION_ENCRYPTION_KEY: process.env.E2E_INTEGRATION_ENCRYPTION_KEY,
})

if (!BASE_ENV.JWT_SECRET || BASE_ENV.JWT_SECRET.length < 32) {
  throw new Error('E2E_JWT_SECRET must be set (>=32 chars) by the workflow before this script runs')
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set (the application database, NOT the sealed-export authority roles)')
}

// ── tiny HTTP helper ────────────────────────────────────────────────────────────────────────────────
// `timeoutMs` (requirement 4) defaults to REQUEST_TIMEOUT_MS so every EXISTING call site is unaffected;
// only callers that explicitly pass a longer budget (the S6-A scale-leg POSTs) get one.
// `tenantId` defaults to the module TENANT_ID so every EXISTING call site is unaffected; the scale legs
// pass their OWN dedicated tenant explicitly — see the comment above SCALE_TENANT_ID_PREFIX for why they
// cannot share TENANT_ID with the primary walk.
export async function requestJson(pathname, { method = 'GET', body, token, accept = [200], timeoutMs = REQUEST_TIMEOUT_MS, tenantId = TENANT_ID } = {}) {
  const headers = { 'x-tenant-id': tenantId }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: response.status, body: parsed, ok: accept.includes(response.status) }
  } finally {
    clearTimeout(timer)
  }
}

// ── server process lifecycle ────────────────────────────────────────────────────────────────────────
//
// RD-E2E finding (this lane, S6-A flag-ON arm): `stopServer()` used to send SIGTERM to the `pnpm`
// wrapper process only, then wait a flat 1500ms and declare the server stopped. Killing that ONE pid is
// not proof the actual `tsx src/index.ts` process it spawned (via `pnpm run dev:core`) went down with
// it — a package-manager wrapper does not always forward signals to, or die together with, its own
// child. When it didn't, the OLD process kept listening on PORT, and the NEXT `startServer()` call's
// `waitForHealth()` — which only checks "does something answer /health", not "does MY spawn answer" —
// passed instantly by hitting the STALE process instead of the one it just spawned. Every arm before
// the flag-ON one expects flagOn===false, so a stale flag-OFF process answering in its place was
// invisible; only the flag-ON arm (the one arm expecting a DIFFERENT value) exposed it, as
// `s6aHealthFlagOn=FAIL` with the underlying route never having been restarted at all. Evidence: dispatched
// run 30831507305 job 91746459841 shows "server (flag-on) healthy" logged 4ms after the provisioning
// script's own completion line — every other arm transition in that SAME run took ~1.5s (the
// stopServer→startServer round trip), which a freshly spawned server cannot beat; the only process that
// could answer in 4ms is one that was ALREADY running the whole time.
//
// Fix, entirely inside this harness (no production code touched): (1) spawn detached so the whole
// process TREE pnpm creates can be signalled as one group, not just the wrapper pid; (2) `stopServer()`
// now ACTIVELY CONFIRMS the port stopped accepting connections — with a last-resort OS-level sweep for
// anything still bound to it — instead of assuming a flat delay was enough; a port that will not free is
// a loud thrown error, never a silent return. This makes "the next arm's health check passed" mean what
// it says: MY spawn is the one that answered, because nothing else could have been listening on that
// port when the check began.
let currentServer = null

async function waitForHealth(deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await delay(1000)
  }
  return false
}

function isPortFree(port) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.createConnection({ port, host: '127.0.0.1' })
    const finish = (free) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(free)
    }
    socket.once('connect', () => finish(false)) // something accepted the connection — still bound
    socket.once('error', () => finish(true)) // nothing there (ECONNREFUSED) — free
    socket.setTimeout(1000, () => finish(true))
  })
}

async function waitForPortFree(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true
    await delay(250)
  }
  return false
}

// Last-resort fallback if the process-group signal above did not reach whatever is still listening
// (e.g. it re-parented into a session of its own). Best-effort only: a missing/failing `lsof` here is a
// no-op, not a crash — `waitForPortFree()` is what actually decides pass/fail for stopServer(), not this.
async function killAnyProcessOnPort(port) {
  await new Promise((resolve) => {
    const finder = spawn('sh', ['-c', `lsof -ti tcp:${port} 2>/dev/null || true`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    finder.stdout.on('data', (chunk) => { out += chunk.toString() })
    finder.on('close', () => {
      for (const pidText of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const foundPid = Number(pidText)
        if (Number.isInteger(foundPid) && foundPid > 0) {
          try {
            process.kill(foundPid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
      }
      resolve()
    })
    finder.on('error', () => resolve())
  })
}

export async function startServer(extraEnv, label) {
  if (currentServer) throw new Error('a server is already running; stop it before starting another')
  const env = { ...BASE_ENV, ...extraEnv }
  const logPath = path.join(OUT_DIR, `server-${label}.log`)
  // Self-sufficient regardless of caller: main() mkdir's OUT_DIR, but the negative-control entry point
  // calls startServer() directly without ever creating it first.
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const logFd = fs.openSync(logPath, 'a')
  const proc = spawn('pnpm', ['--filter', '@metasheet/core-backend', 'run', 'dev:core'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', logFd, logFd],
    // Its own process group leader, so stopServer() can signal the WHOLE tree pnpm spawns underneath it
    // (see the block comment above) instead of only the wrapper pid.
    detached: true,
  })
  currentServer = { proc, logFd, label }
  const healthy = await waitForHealth(HEALTH_TIMEOUT_MS)
  if (!healthy) {
    await stopServer()
    throw new Error(`server (${label}) did not become healthy within ${HEALTH_TIMEOUT_MS}ms — see server-${label}.log`)
  }
  note(`server (${label}) healthy`, `port=${PORT}`)
  return true
}

export async function stopServer() {
  if (!currentServer) return
  const { proc, logFd, label } = currentServer
  currentServer = null
  const pid = proc.pid
  function killGroup(signal) {
    if (!pid) return
    try {
      // `-pid` targets the whole process group (valid because startServer() spawns with detached: true),
      // not just the pnpm wrapper — see the block comment above this section.
      process.kill(-pid, signal)
    } catch {
      // ESRCH (already gone) or no process-group support on this platform — best effort either way.
    }
  }
  try {
    killGroup('SIGTERM')
    await Promise.race([once(proc, 'exit'), delay(8000)])
  } catch {
    // ignore
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    killGroup('SIGKILL')
    try {
      await Promise.race([once(proc, 'exit'), delay(3000)])
    } catch {
      // ignore
    }
  }
  try {
    fs.closeSync(logFd)
  } catch {
    // ignore
  }
  // The wrapper process exiting is NOT proof the actual server process is gone (that is exactly the bug
  // this section fixes — see the block comment above). Confirm the port itself stopped accepting
  // connections before declaring this server stopped; a stale listener here would silently hand the
  // NEXT startServer()'s health check a WRONG process to talk to instead of the one it is about to spawn.
  let portFree = await waitForPortFree(PORT, 5000)
  if (!portFree) {
    await killAnyProcessOnPort(PORT)
    portFree = await waitForPortFree(PORT, 5000)
  }
  if (!portFree) {
    throw new Error(
      `server (${label}) process group did not release port ${PORT} — a stale server may still be listening; ` +
      'refusing to continue, since the next arm would silently talk to the wrong process',
    )
  }
  note(`server (${label}) stopped`, `port=${PORT} confirmedFree=true`)
}

// ── auth ─────────────────────────────────────────────────────────────────────────────────────────────
// `tenantId` defaults to the module TENANT_ID (every EXISTING call site is unaffected); the scale legs
// pass their own — see the comment above SCALE_TENANT_ID_PREFIX.
export async function getDevToken(tenantId = TENANT_ID) {
  const res = await fetch(
    `${BASE_URL}/api/auth/dev-token?userId=${encodeURIComponent(ADMIN_USER_ID)}&tenantId=${encodeURIComponent(tenantId)}&roles=admin&expiresIn=2h`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  if (!res.ok) throw new Error(`dev-token request failed: http=${res.status}`)
  const parsed = await res.json()
  if (!parsed || typeof parsed.token !== 'string' || parsed.token.length < 1) {
    throw new Error('dev-token response missing token')
  }
  return parsed.token
}

// ── control arms ─────────────────────────────────────────────────────────────────────────────────────
// `timeoutMs` (requirement 4) is optional and defaults to requestJson's own default (REQUEST_TIMEOUT_MS)
// — every EXISTING caller (the flag arms, the primary walk) is unaffected; only the scale legs pass a
// longer S6A_POST_TIMEOUT_MS explicitly.
//
// `500` was ADDED to `accept` below for the rejection arm (runS6ARejectionArm): a SealedExportError (the
// class every sealed-export refusal throws, failure-vocabulary.cjs) carries no `.status`/`.code`, only
// `.reason` — so http-routes.cjs's sendError()/inferHttpStatus() (read directly at http-routes.cjs:437-458,
// not guessed) falls through every named-error branch to the generic `return 500` at the end, with
// `inferErrorCode()` falling back to `error.name` ('SealedExportError'). 500 is therefore the ACTUAL status
// the product returns for an internal sealed-export refusal, not a guess. This only WIDENS which statuses
// count as `ok` here — every existing caller of this function still asserts an EXACT `probe.status === 404`
// (or similar) itself, independent of `ok`, so nothing that passed before is weakened by also accepting 500.
export async function s6aRunProbe(token, operationId, { timeoutMs, tenantId } = {}) {
  return requestJson('/api/integration/internal/stock-preparation/sqlserver-sealed-snapshot/run', {
    method: 'POST',
    token,
    tenantId,
    body: { operationId },
    accept: [200, 201, 400, 403, 404, 409, 422, 500, 503],
    timeoutMs,
  })
}

// NOTE on the DISABLED error code: plugin-integration-core only ADDS the S6-A route to the Express app
// (registerIntegrationRoutes, http-routes.cjs ~5003-5006) when services.stockPreparationSqlServerRuntime
// is truthy at plugin-construction time — i.e. only when the flag was already 'true' at boot. When the
// flag is off, the route is never mounted at all, so a request to it falls through to the framework's
// generic unmatched-route 404 (no JSON error envelope, no `error.code`) — it does NOT reach the
// `STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED` HttpRouteError inside the handler
// (http-routes.cjs ~4900-4911) IN THIS SPECIFIC ARM, because that branch is unreachable when the flag is
// off (route registration checks only Boolean(runtime); the DISABLED branch fires on falsy runtime). That
// branch is NOT unreachable in general, though: it also fires when `typeof runtime.run !== 'function'`,
// which registration does not check — so a truthy-but-malformed runtime still registers the route AND
// still hits DISABLED at request time. This arm just never constructs that runtime shape. This is
// confirmed by the existing unit test plugin-integration-core/__tests__/http-routes.test.cjs
// `testStockPreparationSqlServerSealedSnapshotInternalRoute`, which asserts
// `disabled.routes.has('POST ' + routePath) === false` for the flag-off construction. So this arm does
// NOT assert the specific JSON error code (that would be asserting dead code) — it asserts three things
// together, which is what actually distinguishes "genuinely gated" from "route never wired / auth or
// prefix broken / typo'd path", none of which a bare `http === 404` can rule out on its own:
//   1. /api/integration/health capability boolean reads false (a deliberate signal — Boolean(runtime) —
//      not an absence: plugin-integration-core/index.cjs ~96)
//   2. a SIBLING route that is ALWAYS registered regardless of the flag (mvp/readiness) answers 200 in
//      the SAME server process — proving the server, auth, and /api/integration prefix are alive, so the
//      S6-A 404 cannot be explained by "nothing is mounted"
//   3. the S6-A path itself returns 404
async function runFlagArm(flagValue, expectEnabled, label) {
  await startServer(
    flagValue === undefined
      ? {}
      : { MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: flagValue },
    `arm-${label}`,
  )
  try {
    const token = await getDevToken()
    const health = await requestJson('/api/integration/health', { token })
    const flagOn = health.body?.capabilities?.stockPreparationSqlServerSealedSnapshot === true
    const sibling = await requestJson('/api/integration/stock-preparation/mvp/readiness', { token, accept: [200] })
    const probe = await s6aRunProbe(token, `probe-${label}-${crypto.randomUUID()}`)
    S[`${label}HealthFlagOn`] = flagOn
    S[`${label}SiblingRouteHttp`] = sibling.status
    S[`${label}Http`] = probe.status
    // Informational only (kept for evidence/debuggability) — NOT part of the pass condition. See the
    // block comment above: this code is unreachable dead code under current route-registration wiring
    // when the flag is off, so requiring it here would assert a claim the shipped code cannot make true.
    S[`${label}Code`] = probe.body?.error?.code || '<none>'
    const pass = expectEnabled
      ? flagOn === true && sibling.ok
      : flagOn === false && sibling.ok && probe.status === 404
    must(`flag arm ${label}: ${expectEnabled ? 'flag reads enabled (+ sibling route alive)' : 'flag reads disabled + sibling route alive + S6-A 404'}`,
      pass, `flagOn=${flagOn} siblingHttp=${sibling.status} http=${probe.status} code=${S[`${label}Code`]}`)
    S[`${label}Pass`] = pass ? 'PASS' : 'FAIL'
  } finally {
    await stopServer()
  }
}

// ── S6-A flag NORMALIZATION arms (finding: no arm discriminated the two implementations) ──────────────
// stock-preparation-runtime-config.cjs's featureEnabled() is
// `String(env[FLAG] ?? '').trim().toLowerCase() === 'true'` — it NORMALISES before comparing. The
// exact-match arms above ('1', 'yes') only prove values that fail BOTH a strict `=== 'true'` AND the
// real normalising comparison stay disabled — every arm before this one happens to agree on the SAME
// (disabled) answer, so none of them can tell the two implementations apart. 'TRUE', ' true ' (leading +
// trailing whitespace), and 'True' all normalise to 'true' under trim+lowercase but would NOT survive a
// naive strict-equals — only arms built from these three values pin the normalising comparison.
// Each arm builds its OWN throwaway runtime-construction material (never the SQL Server relation, the
// external-system record, or the provisioning spec attemptS6ARealRun() below sets up — this only proves
// the runtime CONSTRUCTS for a given flag string, the same signal S6-A's own health capability boolean
// already carries, not that a run succeeds) so it can run standalone, before the heavier real-run
// attempt, using only the runtime-database role/URL the workflow already provisioned.
async function runFlagNormalizationArm(flagValue, label) {
  if (!RUNTIME_DB_ROLE || !RUNTIME_DB_URL) {
    S[`${label}Pass`] = 'NOT_RUN'
    S[`${label}Reason`] = 'RUNTIME_DB_ENV_MISSING'
    must(`flag normalization arm ${label}: runtime constructed`, false, 'runtime DB env not provided by workflow')
    return
  }
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), `s6a-e2e-normkeys-${label}-`))
  const identityKeyFile = path.join(keysDir, 'identity.key')
  const evidenceKeyFile = path.join(keysDir, 'evidence.key')
  const qualificationKeyFile = path.join(keysDir, 'qualification.key')
  const signerKeyFile = path.join(keysDir, 'signer.pem')
  fs.writeFileSync(identityKeyFile, crypto.randomBytes(32))
  fs.writeFileSync(evidenceKeyFile, crypto.randomBytes(32))
  fs.writeFileSync(qualificationKeyFile, crypto.randomBytes(32))
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(signerKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const normArtifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), `s6a-e2e-normroot-${label}-`))
  const runtimeEnv = {
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: flagValue,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT: normArtifactRoot,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_EVIDENCE_KEY_FILE: evidenceKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE: identityKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE: qualificationKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID: `${label}-qual-key-v1`,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_ROLE: RUNTIME_DB_ROLE,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_URL: RUNTIME_DB_URL,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE: signerKeyFile,
  }
  try {
    await startServer(runtimeEnv, label)
  } catch (error) {
    S[`${label}Pass`] = 'NOT_RUN'
    S[`${label}Reason`] = 'RUNTIME_SERVER_START_FAILED'
    must(`flag normalization arm ${label}: runtime constructed`, false, String(error && error.message || error))
    return
  }
  try {
    const token = await getDevToken()
    const health = await requestJson('/api/integration/health', { token })
    const flagOn = health.body?.capabilities?.stockPreparationSqlServerSealedSnapshot === true
    S[`${label}HealthFlagOn`] = flagOn
    must(`flag normalization arm ${label}: string variant normalises to enabled (runtime CONSTRUCTED, not just flag-string-present)`,
      flagOn, `flagOn=${flagOn}`)
    S[`${label}Pass`] = flagOn ? 'PASS' : 'FAIL'
  } finally {
    await stopServer()
  }
}

// ── existing chain (T4 extended smoke) ──────────────────────────────────────────────────────────────
async function runExistingChain(token) {
  const outDir = path.join(OUT_DIR, 'existing-chain')
  fs.mkdirSync(outDir, { recursive: true })
  const args = [
    path.join(REPO_ROOT, 'scripts/ops/stock-preparation-prep-line-extended-smoke.mjs'),
    '--base-url', BASE_URL,
    '--tenant-id', TENANT_ID,
    '--project-prefix', 'stockprep-e2efunc',
    '--timeout-ms', String(REQUEST_TIMEOUT_MS),
    '--out-dir', outDir,
  ]
  const exitCode = await new Promise((resolve) => {
    const proc = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, METASHEET_AUTH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })
    proc.on('close', (code) => resolve({ code, stdout }))
  }).then(({ code, stdout }) => {
    fs.writeFileSync(path.join(outDir, 'stdout.txt'), stdout)
    return code
  })
  let summary = {}
  try {
    const summaryText = fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8')
    for (const line of summaryText.split('\n').slice(1)) {
      const idx = line.indexOf('=')
      if (idx === -1) continue
      summary[line.slice(0, idx)] = line.slice(idx + 1)
    }
  } catch {
    summary = {}
  }
  S.existingChainScriptExit = exitCode
  S.existingChainAuditActionsCovered = summary.auditActionsCovered || '<not-run>'
  S.existingChainExternalWrite = summary.externalWrite || '<not-run>'
  S.existingChainLeakScanClean = summary.leakScanClean || '<not-run>'
  const pass = exitCode === 0 && summary.pass === 'true' && summary.auditActionsCovered === '8/8' &&
    summary.externalWrite === 'false'
  must('existing chain (T4 extended smoke) reproduces 8/8 audit coverage, externalWrite=false',
    pass, `exit=${exitCode} audit=${S.existingChainAuditActionsCovered} externalWrite=${S.existingChainExternalWrite}`)
  S.existingChainPass = pass ? 'PASS' : 'FAIL'
  return pass
}

// ── S6-A real flag-ON attempt (best-effort; every step reports NOT_RUN, not PASS, on failure) ────────
function canonicalText(value) {
  const result = canonicalCodec.tryCanonicalJson(value)
  if (!result.ok) throw new Error('failed to canonicalize S6-A fixture value')
  return result.bytes.toString('utf8')
}

// Deterministic oversized-payload padding (requirement 3). designQty is the ONLY sealed-snapshot payload
// field with no decoder length cap: stock-preparation-sealed-snapshot-decoder.cjs's positiveDecimal only
// bounds the INTEGER part to Number.MAX_SAFE_INTEGER (verified by reading the function directly — every
// OTHER field goes through boundedString/nullableString, capped at 512 by default, 64 for designUnit, 32
// for lineStatus, 1024 for pathKey). An all-zero fraction keeps the DECODED numeric value harmless (1,
// via `Number('1.000...0')`) while making the WIRE payload text exceed nvarchar(4000) — the fixture/
// contract mismatch this leg fixes (sqlserver-sealed-snapshot-action.cjs's "Never CAST to nvarchar(4000)"
// comment). Fixed length, no randomness: fixture generation stays deterministic run to run.
const OVERSIZED_DESIGN_QTY_FRACTION_DIGITS = 4500

function buildBomPayload(index, salt, { oversized = false } = {}) {
  const projectId = `s6a-e2e-${salt}`
  return {
    bomLevel: index === 0 ? 0 : 1,
    childDrawingNo: `E2E-CHILD-${index + 1}-${salt}`,
    childVersion: null,
    designQty: oversized ? `1.${'0'.repeat(OVERSIZED_DESIGN_QTY_FRACTION_DIGITS)}` : '1.5',
    designUnit: 'EA',
    lineStatus: 'active',
    parentDrawingNo: index === 0 ? null : `E2E-CHILD-1-${salt}`,
    parentVersion: null,
    pathKey: `root/${index + 1}`,
    projectId,
    projectName: `S6A E2E Project ${salt}`,
    snapshotBatchId: `s6a-e2e-batch-${salt}`,
    snapshotVersion: 1,
    sourceBomId: `s6a-e2e-bom-${salt}`,
    sourceProjectNo: `S6A-E2E-${salt}`,
    syncRunId: `s6a-e2e-sync-${salt}`,
  }
}

async function withSqlServerAdmin(fn) {
  const sql = requireFromPlugin('mssql')
  const pool = new sql.ConnectionPool({
    server: MSSQL_HOST,
    port: MSSQL_PORT,
    user: MSSQL_SA_USER,
    password: MSSQL_SA_PASSWORD,
    database: 'master',
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 15000,
  })
  await pool.connect()
  try {
    return await fn(pool, sql)
  } finally {
    await pool.close()
  }
}

// The S6-A capture path's own snapshot-capability proof (sqlserver-sealed-snapshot-source-session.cjs
// assertSnapshotCapability) REQUIRES sys.databases.snapshot_isolation_state = 1 for the target database
// — it is OFF by default on a freshly CREATE DATABASE'd database, so a fixture that skips this step gets
// SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE regardless of how correct its role/grant setup is. This is the
// SAME incantation + poll-for-effect pattern the existing sealed-export S2/S5 CI evidence scripts already
// use (scripts/ops/run-sealed-export-s5-sqlserver-evidence.cjs waitForSnapshotState) — reused here rather
// than re-derived, since ALLOW_SNAPSHOT_ISOLATION can take a moment to actually apply.
async function waitForSnapshotIsolationOn(pool) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await pool.request().query(`
SELECT snapshot_isolation_state AS snapshotIsolationState
FROM sys.databases
WHERE name = N'${MSSQL_DATABASE}'`)
    const state = Number(result.recordset?.[0]?.snapshotIsolationState)
    if (state === 1) return
    await delay(250)
  }
  throw new Error('SQL Server database never reported snapshot_isolation_state=1 after ALLOW_SNAPSHOT_ISOLATION ON')
}

// Batched insert (requirement 2): a single INSERT...VALUES statement for thousands of rows is not just
// slow, it is ILLEGAL — T-SQL caps a multi-row VALUES list at 1000 rows per statement. SQLSERVER_INSERT_
// BATCH_SIZE (500) stays well under that. Each chunk gets its OWN `request()` (mssql parameter names are
// scoped to a single Request), so parameter names are reused per-chunk (`rowId0..rowId499`), not globally
// unique — deterministic, no randomness, same content every run for the same (salt, rowCount, oversized).
async function insertRowsBatched(dbPool, sql, rows) {
  for (let start = 0; start < rows.length; start += SQLSERVER_INSERT_BATCH_SIZE) {
    const chunk = rows.slice(start, start + SQLSERVER_INSERT_BATCH_SIZE)
    const request = dbPool.request()
    const values = []
    chunk.forEach((rowPayload, offset) => {
      const rowIdParam = `rowId${offset}`
      const payloadParam = `payload${offset}`
      request.input(rowIdParam, sql.Int, start + offset + 1)
      // nvarchar(max) (requirement 3): matches the product's own capture query, which CASTs to
      // nvarchar(max) and explicitly comments "Never CAST to nvarchar(4000)"
      // (sqlserver-sealed-snapshot-action.cjs buildRowIdPayloadSourceSql). `sql.MAX` (=65535, verified
      // against the mssql@10.0.4 source: lib/base/index.js's `exports.exports.MAX = 65535`) exceeds
      // datatypes.js's declare() `length > 4000` threshold, so `sql.NVarChar(sql.MAX)` renders as
      // `nvarchar(max)` in the generated parameter declaration, not a numeric length.
      request.input(payloadParam, sql.NVarChar(sql.MAX), canonicalText(rowPayload))
      values.push(`(@${rowIdParam}, 1, @${payloadParam})`)
    })
    await request.query(`INSERT INTO ${MSSQL_TABLE} (row_id, payload_version, payload) VALUES ${values.join(',')}`)
  }
}

// `rowCount` (requirement 1) and `oversizedLastRow` (requirement 3) both default to today's exact
// behaviour (3 plain rows) — the ONE existing call site below (attemptS6ARealRun's `prepareSqlServerRelation(salt)`)
// is therefore untouched and produces byte-identical fixture content to before this leg existed. The NEW
// scale-leg call sites (runS6AMidTierScaleWalk, runS6ARejectionArm) pass both explicitly.
async function prepareSqlServerRelation(salt, rowCount = DEFAULT_S6A_ROW_COUNT, { oversizedLastRow = false } = {}) {
  const rows = []
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(buildBomPayload(index, salt, { oversized: oversizedLastRow && index === rowCount - 1 }))
  }
  // Positive control (requirement 3): prove the fixture we are ABOUT to seed actually needs nvarchar(max)
  // — i.e. this number is not merely asserted, it is measured off the SAME canonicalText() the insert
  // below uses.
  const oversizedPayloadTextLength = oversizedLastRow
    ? canonicalText(rows[rows.length - 1]).length
    : null
  await withSqlServerAdmin(async (pool, sql) => {
    await pool.request().batch(`
IF DB_ID(N'${MSSQL_DATABASE}') IS NULL
BEGIN
  CREATE DATABASE ${MSSQL_DATABASE};
END`)
    await pool.request().batch(`ALTER DATABASE [${MSSQL_DATABASE}] SET ALLOW_SNAPSHOT_ISOLATION ON;`)
    await waitForSnapshotIsolationOn(pool)
    await pool.request().batch(`
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${MSSQL_READER_LOGIN}')
BEGIN
  CREATE LOGIN [${MSSQL_READER_LOGIN}] WITH PASSWORD = N'${MSSQL_READER_PASSWORD}', CHECK_POLICY = OFF;
END`)
    const dbPool = new sql.ConnectionPool({
      server: MSSQL_HOST,
      port: MSSQL_PORT,
      user: MSSQL_SA_USER,
      password: MSSQL_SA_PASSWORD,
      database: MSSQL_DATABASE,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 15000,
    })
    await dbPool.connect()
    try {
      await dbPool.request().batch(`
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${MSSQL_READER_LOGIN}')
BEGIN
  CREATE USER [${MSSQL_READER_LOGIN}] FOR LOGIN [${MSSQL_READER_LOGIN}];
END`)
      await dbPool.request().batch(`
IF OBJECT_ID(N'${MSSQL_TABLE}', N'U') IS NOT NULL DROP TABLE ${MSSQL_TABLE};
CREATE TABLE ${MSSQL_TABLE} (
  row_id int NOT NULL PRIMARY KEY,
  payload_version int NOT NULL,
  payload nvarchar(max) NOT NULL
);`)
      await insertRowsBatched(dbPool, sql, rows)
      await dbPool.request().batch(`GRANT SELECT ON OBJECT::${MSSQL_TABLE} TO [${MSSQL_READER_LOGIN}];`)
    } finally {
      await dbPool.close()
    }
  })
  return { rows, projectId: rows[0].projectId, snapshotBatchId: rows[0].snapshotBatchId, oversizedPayloadTextLength }
}

// `tenantId` is optional (requestJson's own default TENANT_ID applies when omitted) — the ONE existing
// call site (attemptS6ARealRun's) is unaffected; the scale legs pass their own.
async function registerExternalSystem(token, systemId, tenantId) {
  const body = {
    id: systemId,
    name: 'e2e-func-s6a-source',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: {
      sealedSnapshotSqlServer: {
        database: MSSQL_DATABASE,
        encrypt: true,
        instanceName: null,
        port: MSSQL_PORT,
        server: MSSQL_HOST,
        trustServerCertificate: true,
      },
    },
    credentials: {
      sealedSnapshotSqlServer: {
        password: MSSQL_READER_PASSWORD,
        user: MSSQL_READER_LOGIN,
      },
    },
  }
  const res = await requestJson('/api/integration/external-systems', {
    method: 'POST', token, body, accept: [200, 201], tenantId,
  })
  return res
}

async function runProvisioningScript(env) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs')],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => { stdout += c.toString() })
    proc.stderr.on('data', (c) => { stderr += c.toString() })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ── Step 3 (database-observable proof) ──────────────────────────────────────────────────────────────
// A 200 with a COMPLETED-looking response body is not evidence the generation kernel actually wrote
// anything — it is only evidence the HTTP layer said so. This queries the rows the kernel is supposed
// to have written directly, over a SEPARATE connection using the APPLICATION's own DATABASE_URL (the
// migration/superuser role) rather than the S6-A runtime role, so the proof does not depend on the same
// identity that (allegedly) wrote the rows also being the one asked to confirm they exist. Values-free:
// only fixed status tokens and counts are read into the evidence block, no row payload content.
async function withApplicationPool(fn) {
  const pg = requireFromPlugin('pg')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

// The write state the S6-A walk is supposed to produce EXACTLY ONCE per operationId, as counts and
// identities rather than payloads. Used on both sides of the replay call: the replay's own HTTP body
// claiming `mode=internal_noop` is the runtime reporting on itself, and cannot distinguish "did nothing"
// from "did it all again and reported the first result". Comparing this snapshot before/after can.
// `tenantId` defaults to the module TENANT_ID (the ONE existing call sites — attemptS6ARealRun's — are
// unaffected); the scale legs pass their own dedicated tenant.
async function snapshotS6AWriteState(pool, operationId, tenantId = TENANT_ID) {
  const run = (await pool.query(
    `SELECT status, generation_id, ingestion_session_id, business_line_count, source_read_count
     FROM integration_sealed_export_stock_prep_runs
     WHERE tenant_id = $1 AND operation_id = $2`,
    [tenantId, operationId],
  )).rows[0] || null
  const counts = {}
  for (const [key, sql] of [
    ['runs', 'SELECT COUNT(*)::int AS n FROM integration_sealed_export_stock_prep_runs WHERE tenant_id = $1'],
    ['generations', 'SELECT COUNT(*)::int AS n FROM integration_sealed_export_generations WHERE tenant_id = $1'],
    ['ingestionSessions', 'SELECT COUNT(*)::int AS n FROM integration_sealed_export_ingestion_sessions WHERE tenant_id = $1'],
    ['generationRows', 'SELECT COUNT(*)::int AS n FROM integration_sealed_export_generation_rows WHERE tenant_id = $1'],
    ['activePointers', 'SELECT COUNT(*)::int AS n FROM integration_sealed_export_active_pointers WHERE tenant_id = $1'],
  ]) {
    counts[key] = (await pool.query(sql, [tenantId])).rows[0].n
  }
  return {
    counts,
    runStatus: run ? run.status : '<none>',
    // Identities, not payloads: a second generation would change these even if the counts somehow did not.
    generationId: run && run.generation_id ? run.generation_id : '<none>',
    ingestionSessionId: run && run.ingestion_session_id ? run.ingestion_session_id : '<none>',
    businessLineCount: run ? Number(run.business_line_count) : -1,
    sourceReadCount: run ? Number(run.source_read_count) : -1,
  }
}

// Positive control on the OBSERVABILITY QUERIES THEMSELVES, independent of whether the walk succeeds.
// assertS6ARunDatabaseObservable() and snapshotS6AWriteState() only execute on a successful walk, so
// until one happens their SQL is unexercised text: a mistyped column would surface later as a FAIL that
// is indistinguishable from a real defect. This runs the SAME queries against a scope that matches
// nothing — proving they parse and every column resolves — on EVERY dispatch, including failing ones.
async function assertS6AObservabilityQueriesResolve() {
  try {
    await withApplicationPool(async (pool) => {
      const snapshot = await snapshotS6AWriteState(pool, '<no-such-operation-id>')
      if (snapshot.runStatus !== '<none>' || snapshot.generationId !== '<none>') {
        throw new Error('pre-flight scope unexpectedly matched a run row')
      }
      await pool.query(
        `SELECT status, source_read_count, business_line_count, generation_id, ingestion_session_id
         FROM integration_sealed_export_stock_prep_runs
         WHERE tenant_id = $1 AND operation_id = $2`,
        [TENANT_ID, '<no-such-operation-id>'],
      )
      await pool.query(
        `SELECT status, applied_row_count FROM integration_sealed_export_generations
         WHERE generation_id = $1 AND tenant_id = $2`,
        ['<no-such-generation-id>', TENANT_ID],
      )
      await pool.query(
        `SELECT status, accepted_chunk_count, expected_chunk_count
         FROM integration_sealed_export_ingestion_sessions
         WHERE session_id = $1 AND tenant_id = $2`,
        ['<no-such-session-id>', TENANT_ID],
      )
    })
    S.s6aObservabilityQueriesResolve = 'PASS'
  } catch (error) {
    S.s6aObservabilityQueriesResolve = 'FAIL'
    must('S6-A: the database-observability queries parse and every column resolves (schema pre-flight, '
      + 'scope matches nothing)', false, String(error && error.message || error))
    return false
  }
  must('S6-A: the database-observability queries parse and every column resolves (schema pre-flight, '
    + 'scope matches nothing)', true, 'preflight=PASS')
  return true
}

// `keyPrefix`/`label`/`tenantId` (all default to the ORIGINAL 's6a'/'S6-A'/TENANT_ID) let the scale legs
// below reuse this exact query/assertion logic under their OWN evidence-key namespace and tenant instead
// of silently overwriting the primary walk's fields or colliding with its data — the default params mean
// the ONE existing call site (`assertS6ARunDatabaseObservable(operationId, relation.rows.length)`) is
// untouched and produces byte-identical key names, message text and query scope to before this leg existed.
async function assertS6ARunDatabaseObservable(operationId, expectedBusinessLineCount, keyPrefix = 's6a', label = 'S6-A', tenantId = TENANT_ID) {
  return withApplicationPool(async (pool) => {
    const runRows = await pool.query(
      `SELECT status, source_read_count, business_line_count, generation_id, ingestion_session_id
       FROM integration_sealed_export_stock_prep_runs
       WHERE tenant_id = $1 AND operation_id = $2`,
      [tenantId, operationId],
    )
    const run = runRows.rows[0] || null
    S[`${keyPrefix}DbRunRowFound`] = run ? 'true' : 'false'
    S[`${keyPrefix}DbRunStatus`] = run ? run.status : '<none>'
    S[`${keyPrefix}DbRunSourceReadCount`] = run ? Number(run.source_read_count) : -1
    S[`${keyPrefix}DbRunBusinessLineCount`] = run ? Number(run.business_line_count) : -1

    // The GENERATION KERNEL's own rows. `applied_row_count` is what the kernel wrote during apply, so
    // asserting it equals the fixture's row count proves apply actually moved rows, not merely that a
    // generation row exists in some terminal-looking status.
    let generationFound = false
    let generationStatus = '<none>'
    let generationAppliedRowCount = -1
    if (run && run.generation_id) {
      const generationRows = await pool.query(
        `SELECT status, applied_row_count FROM integration_sealed_export_generations
         WHERE generation_id = $1 AND tenant_id = $2`,
        [run.generation_id, tenantId],
      )
      generationFound = generationRows.rows.length === 1
      if (generationFound) {
        generationStatus = generationRows.rows[0].status
        generationAppliedRowCount = Number(generationRows.rows[0].applied_row_count)
      }
    }
    S[`${keyPrefix}DbGenerationRowFound`] = generationFound ? 'true' : 'false'
    S[`${keyPrefix}DbGenerationStatus`] = generationStatus
    S[`${keyPrefix}DbGenerationAppliedRowCount`] = generationAppliedRowCount

    // The PRIVATE INGESTION session the walk is supposed to have driven to UPLOAD_COMPLETE. Without
    // this, "capture -> private ingestion -> generation kernel -> apply" would be asserted only at its
    // two ends, and the middle leg would be inferred rather than observed.
    let ingestionFound = false
    let ingestionStatus = '<none>'
    let ingestionChunksComplete = 'false'
    if (run && run.ingestion_session_id) {
      const ingestionRows = await pool.query(
        `SELECT status, accepted_chunk_count, expected_chunk_count
         FROM integration_sealed_export_ingestion_sessions
         WHERE session_id = $1 AND tenant_id = $2`,
        [run.ingestion_session_id, tenantId],
      )
      ingestionFound = ingestionRows.rows.length === 1
      if (ingestionFound) {
        ingestionStatus = ingestionRows.rows[0].status
        ingestionChunksComplete = String(
          Number(ingestionRows.rows[0].accepted_chunk_count) ===
          Number(ingestionRows.rows[0].expected_chunk_count),
        )
      }
    }
    S[`${keyPrefix}DbIngestionSessionFound`] = ingestionFound ? 'true' : 'false'
    S[`${keyPrefix}DbIngestionSessionStatus`] = ingestionStatus
    S[`${keyPrefix}DbIngestionChunksComplete`] = ingestionChunksComplete

    // Not just "a row exists" — the rows the kernel was supposed to write for THIS fixture: the same
    // business-line count the HTTP-level assertion already checked on the response body, now confirmed
    // independently against the persisted rows, at every leg of the walk.
    const dbOk = run !== null && run.status === 'COMPLETED' && Number(run.source_read_count) === 1 &&
      Number(run.business_line_count) === expectedBusinessLineCount && generationFound &&
      generationAppliedRowCount === expectedBusinessLineCount &&
      ['VERIFIED', 'ACTIVE'].includes(generationStatus) &&
      ingestionFound && ingestionStatus === 'UPLOAD_COMPLETE' && ingestionChunksComplete === 'true'
    must(
      `${label}: database-observable proof — stock_prep_runs row COMPLETED (source_read_count=1, ` +
      'business_line_count matches the fixture) + the ingestion session UPLOAD_COMPLETE with every ' +
      'chunk accepted + a matching generations row whose applied_row_count matches the fixture, ' +
      'queried over a SEPARATE (superuser, non-runtime-role) connection',
      dbOk,
      `runFound=${S[`${keyPrefix}DbRunRowFound`]} runStatus=${S[`${keyPrefix}DbRunStatus`]} lines=${S[`${keyPrefix}DbRunBusinessLineCount`]} ` +
      `genFound=${S[`${keyPrefix}DbGenerationRowFound`]} genStatus=${S[`${keyPrefix}DbGenerationStatus`]} ` +
      `genApplied=${S[`${keyPrefix}DbGenerationAppliedRowCount`]} ingFound=${S[`${keyPrefix}DbIngestionSessionFound`]} ` +
      `ingStatus=${S[`${keyPrefix}DbIngestionSessionStatus`]} ingChunks=${S[`${keyPrefix}DbIngestionChunksComplete`]}`,
    )
    S[`${keyPrefix}DatabaseObservable`] = dbOk ? 'PASS' : 'FAIL'
    return dbOk
  })
}

// Root-cause evidence for the projection fix, taken from the database rather than inferred from a grep.
// `integration_external_systems.created_at` is TIMESTAMPTZ and this repository installs no
// `setTypeParser`, so `pg` hands back a native JS Date — which is precisely what canonical-json.cjs
// refuses (EXOTIC_OBJECT) and why canonicalising the WHOLE adapter record refused every production-shaped
// record. Reported as a closed boolean/type token; no column VALUE is ever emitted.
async function reportAdapterTimestampRuntimeType(systemId) {
  try {
    await withApplicationPool(async (pool) => {
      const rows = await pool.query(
        'SELECT created_at, updated_at FROM integration_external_systems WHERE tenant_id = $1 AND id = $2',
        [TENANT_ID, systemId],
      )
      const row = rows.rows[0] || null
      S.s6aAdapterRowFound = String(row !== null)
      S.s6aAdapterCreatedAtIsDate = String(Boolean(row) && row.created_at instanceof Date)
      S.s6aAdapterUpdatedAtIsDate = String(Boolean(row) && row.updated_at instanceof Date)
    })
  } catch {
    S.s6aAdapterRowFound = '<query-failed>'
    S.s6aAdapterCreatedAtIsDate = '<query-failed>'
    S.s6aAdapterUpdatedAtIsDate = '<query-failed>'
  }
}

// Diagnostic-only counterpart for the first-run FAILURE path — see the call site's comment. Never
// asserts (no must()); purely reports closed tokens/booleans into the values-free evidence. `keyPrefix`/
// `tenantId` default to 's6a'/TENANT_ID (the ONE existing call site is unaffected); the scale legs pass
// their own.
async function assertS6ARunDatabaseObservableOnFailure(operationId, keyPrefix = 's6a', tenantId = TENANT_ID) {
  const pg = requireFromPlugin('pg')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    const runRows = await pool.query(
      `SELECT status, failure_reason FROM integration_sealed_export_stock_prep_runs
       WHERE tenant_id = $1 AND operation_id = $2`,
      [tenantId, operationId],
    )
    const run = runRows.rows[0] || null
    S[`${keyPrefix}DbRunRowFoundOnFailure`] = String(run !== null)
    S[`${keyPrefix}DbRunStatusOnFailure`] = run ? run.status : '<none>'
    S[`${keyPrefix}DbRunFailureReason`] = run && run.failure_reason ? run.failure_reason : '<none>'
    // Run 30889715065 made this necessary. The mid-tier arm returned HTTP 503
    // SEALED_EXPORT_INTERNAL_ERROR while THIS probe reported the run row as ACTIVATED — and ACTIVATED is
    // the second-to-last state (CAPTURED -> INGESTED -> ACTIVATED -> COMPLETED), so the caller was told
    // the operation failed at the point where the generation should already be live.
    //
    // The probe could not answer the only question that matters to an operator holding a
    // non-repeatable window: IS THE DATA ACTUALLY LIVE? It read the run row and not the generation row.
    // Without that, "retry" and "do not retry" are indistinguishable — and with a one-shot,
    // irreversible binding, guessing wrong is expensive in one direction and useless in the other.
    //
    // Closed tokens and counts only; no identifiers, no business values.
    const genRows = await pool.query(
      `SELECT g.status, g.applied_row_count
         FROM integration_sealed_export_generations g
         JOIN integration_sealed_export_stock_prep_runs r
           ON r.generation_id = g.generation_id AND r.tenant_id = g.tenant_id
        WHERE r.tenant_id = $1 AND r.operation_id = $2`,
      [tenantId, operationId],
    )
    const gen = genRows.rows[0] || null
    S[`${keyPrefix}DbGenerationRowFoundOnFailure`] = String(gen !== null)
    S[`${keyPrefix}DbGenerationStatusOnFailure`] = gen ? gen.status : '<none>'
    S[`${keyPrefix}DbGenerationAppliedRowCountOnFailure`] =
      gen && gen.applied_row_count !== null ? Number(gen.applied_row_count) : -1
    // The operator-facing reading, derived — not a second opinion, just the two rows stated together.
    S[`${keyPrefix}DbDataLiveOnFailure`] =
      gen && gen.status === 'ACTIVE' ? 'YES_DATA_IS_LIVE_DESPITE_ERROR' : 'NO_OR_UNKNOWN'
  } catch {
    S[`${keyPrefix}DbRunRowFoundOnFailure`] = '<query-failed>'
    S[`${keyPrefix}DbRunStatusOnFailure`] = '<query-failed>'
    S[`${keyPrefix}DbRunFailureReason`] = '<query-failed>'
    S[`${keyPrefix}DbGenerationRowFoundOnFailure`] = '<query-failed>'
    S[`${keyPrefix}DbGenerationStatusOnFailure`] = '<query-failed>'
    S[`${keyPrefix}DbGenerationAppliedRowCountOnFailure`] = -1
    S[`${keyPrefix}DbDataLiveOnFailure`] = '<query-failed>'
  } finally {
    await pool.end()
  }
}

// ── capture-half refusal narrowing (values-free, drives the REAL modules) ───────────────────────────
// failSealedExport's vocabulary is deliberately cause-free, and SEALED_EXPORT_CAPTURE_FAILED has call
// sites in FOUR production modules — the token alone cannot say which stage refused. This walks the SAME
// production sequence the capture service walks, using the SAME production modules and the SAME
// production SQL builders (never a re-implementation of either), and reports which stage it reaches as
// closed tokens and counts. It NEVER loosens anything: it only observes, in its own read-only snapshot
// transaction, after the real run has already failed.
async function diagnoseS6ACaptureRefusal({
  approvedConfigVersionId,
  bindingVersion,
  identityKeyFile,
  systemId,
}) {
  S.s6aCaptureProbeConnectionConfig = 'NOT_RUN'
  S.s6aCaptureProbeSession = 'NOT_RUN'
  S.s6aCaptureProbeSessionReason = '<none>'
  S.s6aCaptureProbeDriverCode = 'NOT_RUN'
  S.s6aCaptureProbeMetadata = 'NOT_RUN'
  S.s6aCaptureProbeMetadataStrictObject = 'NOT_RUN'
  S.s6aCaptureProbeMetadataTypes = 'NOT_RUN'
  S.s6aCaptureProbeOrderingKey = 'NOT_RUN'
  S.s6aCaptureProbeSourceRead = 'NOT_RUN'
  S.s6aCaptureProbeSourceReadRows = -1
  S.s6aCaptureProbeRowStrictObject = 'NOT_RUN'
  S.s6aCaptureProbeRowTypes = 'NOT_RUN'
  const closedReason = (error) => (
    error && typeof error.reason === 'string' ? error.reason : '<non-sealed-throw>'
  )
  // VALUES-FREE by construction: emits the row's KEY NAMES — which are fixed aliases written by the
  // production SQL builders, not customer data — and the `typeof` of each value. Never a value. This is
  // what discriminates the row-shape family of SEALED_EXPORT_CAPTURE_FAILED sites (hasExactKeys, the
  // strict-plain-object predicate, and the per-field normalizers) from every other family.
  const shapeOf = (row) => {
    if (row === null || typeof row !== 'object') return `<${typeof row}>`
    return Object.keys(row)
      .sort()
      .map((key) => {
        const value = row[key]
        const kind = value === null ? 'null' : typeof value
        return `${key}:${kind}`
      })
      .join('|')
  }
  let context = null
  let connectionConfig = null
  try {
    const authority = require_(
      'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs',
    )
    const runtimeStore = require_(
      'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-store.cjs',
    )
    const action = require_(
      'plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-action.cjs',
    )
    const sourceSession = require_(
      'plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-source-session.cjs',
    )
    // The connection config is DERIVED by the production source authority, not assembled here, so the
    // probe cannot succeed against connection material the product would never build.
    const derived = authority.deriveStockPreparationSqlServerSourceAnchors({
      binding: {
        approvedConfigVersionId,
        bindingVersion,
        canonicalObjectVersion: authority.CANONICAL_OBJECT_VERSION,
        externalSystemId: systemId,
        objectKey: runtimeStore.OBJECT_KEY,
        relationId: runtimeStore.RELATION_ID,
        tableRef: MSSQL_TABLE,
        tenantId: TENANT_ID,
        workspaceId: null,
      },
      externalSystem: {
        config: {
          sealedSnapshotSqlServer: {
            database: MSSQL_DATABASE,
            encrypt: true,
            instanceName: null,
            port: MSSQL_PORT,
            server: MSSQL_HOST,
            trustServerCertificate: true,
          },
        },
        credentials: {
          sealedSnapshotSqlServer: {
            password: MSSQL_READER_PASSWORD,
            user: MSSQL_READER_LOGIN,
          },
        },
        id: systemId,
        kind: 'data-source:sql-readonly',
        role: 'source',
        status: 'active',
        tenantId: TENANT_ID,
        workspaceId: null,
      },
      identityKey: fs.readFileSync(identityKeyFile),
    })
    connectionConfig = derived.connectionConfig
    S.s6aCaptureProbeConnectionConfig = 'DERIVED'

    try {
      context = await sourceSession.openMssqlSnapshotCaptureContext({
        connectionConfig,
        tableRef: MSSQL_TABLE,
      })
      S.s6aCaptureProbeSession = 'OPENED'
    } catch (error) {
      S.s6aCaptureProbeSession = 'REFUSED'
      S.s6aCaptureProbeSessionReason = closedReason(error)
    }

    if (context === null) {
      // The only SEALED_EXPORT_CAPTURE_FAILED site upstream of the snapshot proof is the driver
      // connect, so a raw connect with the SAME derived config splits "cannot connect at all" from
      // "connects, refuses later". `error.code` here is the driver's own closed token (ELOGIN,
      // ESOCKET, ETIMEOUT, ...), never a message.
      const sql = requireFromPlugin('mssql')
      const pool = new sql.ConnectionPool(connectionConfig)
      try {
        await pool.connect()
        S.s6aCaptureProbeDriverCode = '<connected>'
      } catch (error) {
        S.s6aCaptureProbeDriverCode =
          error && typeof error.code === 'string' ? error.code : '<no-code>'
      } finally {
        try { await pool.close() } catch { /* best-effort */ }
      }
      return
    }

    try {
      const metadataRow = await context.queryMetadata(action.CAPTURE_METADATA_SQL)
      S.s6aCaptureProbeMetadata = 'PASS'
      S.s6aCaptureProbeMetadataStrictObject =
        String(canonicalCodec.__internals.isStrictPlainObject(metadataRow))
      S.s6aCaptureProbeMetadataTypes = shapeOf(metadataRow)
    } catch (error) {
      S.s6aCaptureProbeMetadata = `REFUSED:${closedReason(error)}`
    }

    const relation = action.CERTIFIED_RELATIONS[runtimeStore.RELATION_ID]
    try {
      await context.queryProbe(relation.buildOrderingKeyUniquenessProbeSql(MSSQL_TABLE))
      S.s6aCaptureProbeOrderingKey = 'PASS'
    } catch (error) {
      S.s6aCaptureProbeOrderingKey = `REFUSED:${closedReason(error)}`
    }

    try {
      const started = await context.startSourceRead(relation.buildSourceReadSql(MSSQL_TABLE))
      let rows = 0
      for await (const row of started.stream) {
        if (rows === 0) {
          // The FIRST streamed row is the one the production row normalizer sees first, so its shape
          // is what decides hasExactKeys / isStrictPlainObject / the per-field normalizers.
          S.s6aCaptureProbeRowStrictObject =
            String(canonicalCodec.__internals.isStrictPlainObject(row))
          S.s6aCaptureProbeRowTypes = shapeOf(row)
        }
        rows += 1
      }
      const completion = await started.completion
      S.s6aCaptureProbeSourceReadRows = rows
      S.s6aCaptureProbeSourceRead = completion && completion.ok === true ? 'PASS' : 'FAIL'
    } catch (error) {
      S.s6aCaptureProbeSourceRead = `REFUSED:${closedReason(error)}`
    }
  } catch (error) {
    if (S.s6aCaptureProbeConnectionConfig === 'NOT_RUN') {
      S.s6aCaptureProbeConnectionConfig = `REFUSED:${closedReason(error)}`
    }
  } finally {
    if (context !== null) {
      try { await context.rollback() } catch { /* best-effort */ }
      try { await context.close() } catch { /* best-effort */ }
    }
  }
}

// ── post-capture refusal narrowing (values-free) ────────────────────────────────────────────────────
// Once the run row gets PAST the capture half, a SEALED_EXPORT_INTERNAL_ERROR is privateBoundary's
// catch-all for an UNTRUSTED throw — most often a raw driver error the failure contract deliberately
// discards. Migration 073's under-scoped grant (repaired by 074, PR #4728) was exactly that shape, so
// this reports (a) where the run row stopped, (b) the generation/pointer rows the activation step reads,
// and (c) whether the RUNTIME role can actually perform the reads and locking reads that step needs.
// Only closed tokens: table names, PostgreSQL SQLSTATE codes, counts and booleans — never a row value.
async function diagnoseS6APostCaptureRefusal() {
  const ACTIVATION_TABLES = [
    'integration_sealed_export_active_pointers',
    'integration_sealed_export_authority_state',
    'integration_sealed_export_generation_audit',
    'integration_sealed_export_generation_rows',
    'integration_sealed_export_generations',
    'integration_sealed_export_stock_prep_runs',
  ]
  S.s6aPostCaptureGenerationStatus = 'NOT_RUN'
  S.s6aPostCaptureActivePointerRows = -1
  S.s6aRuntimeRoleSelect = 'NOT_RUN'
  S.s6aRuntimeRoleSelectForUpdate = 'NOT_RUN'
  try {
    await withApplicationPool(async (pool) => {
      const generation = await pool.query(
        `SELECT g.status FROM integration_sealed_export_generations g
         JOIN integration_sealed_export_stock_prep_runs r ON r.generation_id = g.generation_id
         WHERE r.tenant_id = $1`,
        [TENANT_ID],
      )
      S.s6aPostCaptureGenerationStatus =
        generation.rows.length === 1 ? generation.rows[0].status : `<rows:${generation.rows.length}>`
      const pointers = await pool.query(
        'SELECT COUNT(*)::int AS n FROM integration_sealed_export_active_pointers WHERE tenant_id = $1',
        [TENANT_ID],
      )
      S.s6aPostCaptureActivePointerRows = pointers.rows[0].n
    })
  } catch (error) {
    S.s6aPostCaptureGenerationStatus = '<query-failed>'
  }
  if (!RUNTIME_DB_URL) return
  const pg = requireFromPlugin('pg')
  const runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL, max: 1 })
  const plain = []
  const locking = []
  try {
    for (const table of ACTIVATION_TABLES) {
      // `WHERE false` — a privilege probe, never a data read: PostgreSQL checks the privilege before it
      // checks whether any row qualifies, so this reports the grant without touching a single row.
      try {
        await runtimePool.query(`SELECT 1 FROM ${table} WHERE false`)
        plain.push(`${table.replace('integration_sealed_export_', '')}:ok`)
      } catch (error) {
        plain.push(`${table.replace('integration_sealed_export_', '')}:${error && error.code ? error.code : 'ERR'}`)
      }
      // A locking read is what migration 073 got wrong once already: PostgreSQL requires UPDATE
      // privilege for SELECT ... FOR UPDATE, independent of whether a row exists to lock.
      try {
        await runtimePool.query(`SELECT 1 FROM ${table} WHERE false FOR UPDATE`)
        locking.push(`${table.replace('integration_sealed_export_', '')}:ok`)
      } catch (error) {
        locking.push(`${table.replace('integration_sealed_export_', '')}:${error && error.code ? error.code : 'ERR'}`)
      }
    }
    S.s6aRuntimeRoleSelect = plain.join('|')
    S.s6aRuntimeRoleSelectForUpdate = locking.join('|')
  } catch {
    S.s6aRuntimeRoleSelect = '<probe-failed>'
    S.s6aRuntimeRoleSelectForUpdate = '<probe-failed>'
  } finally {
    try { await runtimePool.end() } catch { /* best-effort */ }
  }
}

async function attemptS6ARealRun() {
  const salt = `t${Math.floor(Date.now() / 1000)}`
  const systemId = `e2efunc-s6a-source-${salt}`
  const bindingVersion = `e2efunc-binding-${salt}`
  const approvedConfigVersionId = `e2efunc-config-${salt}`
  const qualificationKeyId = 'e2efunc-qual-key-v1'

  if (!RUNTIME_DB_ROLE || !RUNTIME_DB_URL || !PROVISIONING_DB_ROLE || !PROVISIONING_DB_URL) {
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'RUNTIME_DB_ENV_MISSING'
    must('S6-A flag-ON real run attempted', false, 'runtime/provisioning DB env not provided by workflow')
    return
  }

  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 's6a-e2e-keys-'))
  const identityKeyFile = path.join(keysDir, 'identity.key')
  const evidenceKeyFile = path.join(keysDir, 'evidence.key')
  const qualificationKeyFile = path.join(keysDir, 'qualification.key')
  const signerKeyFile = path.join(keysDir, 'signer.pem')
  fs.writeFileSync(identityKeyFile, crypto.randomBytes(32))
  fs.writeFileSync(evidenceKeyFile, crypto.randomBytes(32))
  fs.writeFileSync(qualificationKeyFile, crypto.randomBytes(32))
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(signerKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true })
  // FIXED (RD-E2E, R2c / R3) — the capture root is now created by the product.
  //
  // stock-preparation-runtime-core.cjs derives `captureRoot = <artifactRoot>/capture` and
  // stock-preparation-sqlserver-runtime.cjs hands it to the sealed-snapshot service as its
  // `artifactRoot`. sqlserver-sealed-snapshot-service-core.cjs's execute() now does
  // `fsPromises.mkdir(artifactRoot, { recursive: true, mode: 0o700 })` immediately before its
  // `mkdtemp`, mirroring private-ingestion-blob-store.cjs's createSessionArea(), which already did the
  // same for its own structurally identical derived root. `recursive: true` means the product would
  // create the WHOLE chain, ARTIFACT_ROOT included, if none of it existed — ARTIFACT_ROOT is no longer
  // a precondition the product depends on either; the mkdirSync above exists only because THIS harness
  // needs the directory sooner, for the key files it just wrote into it.
  //
  // This harness therefore no longer pre-creates the capture root. Two fields prove the product created
  // it: `s6aCaptureRootExistedBeforeRun` records that the harness did not, and
  // `s6aCaptureRootCreatedByProduct` (set after the run, see below) proves the directory exists
  // afterward despite that — i.e. the product created it, not this harness.
  const captureRoot = path.join(path.resolve(ARTIFACT_ROOT), 'capture')
  S.s6aCaptureRootExistedBeforeRun = String(fs.existsSync(captureRoot))
  // Seeded now, overwritten once the first run completes (below) — so an early return
  // between here and there still emits the field rather than silently dropping it.
  S.s6aCaptureRootCreatedByProduct = 'NOT_RUN'

  // 1. real SQL Server relation (ephemeral, first-party, synthetic rows only)
  let relation
  try {
    relation = await prepareSqlServerRelation(salt)
    must('S6-A: SQL Server relation + SELECT-only login prepared', true,
      `rows=${relation.rows.length}`)
  } catch (error) {
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'SQLSERVER_RELATION_SETUP_FAILED'
    must('S6-A: SQL Server relation + SELECT-only login prepared', false, String(error && error.message || error))
    return
  }

  // 2. real external system record (must exist BEFORE the runtime attempts a run; visible via the
  // ordinary external-systems HTTP surface, credentials plaintext only inside this request body).
  //
  // RD-E2E finding: this step calls the HTTP API, which needs a server actually listening — this file
  // previously had NO startServer() call here at all. That was masked for a long time by the
  // stopServer() bug fixed above (the "existing chain" server from the PREVIOUS phase was leaking and
  // silently answering these requests instead), so this gap was invisible until that masking bug was
  // fixed: with stopServer() now actually killing the previous server and confirming the port is free,
  // this step failed outright with a raw "fetch failed" (nothing listening at all) — see dispatched run
  // 30833734088. A flag-OFF server is sufficient (registration is unrelated to the S6-A flag), and it
  // MUST be fully stopped again before step 4's flag-ON restart — two servers cannot hold PORT at once,
  // and stopServer() now enforces exactly that.
  let registeredOk = false
  try {
    await startServer({}, 'pre-flag-on-registration')
    try {
      const baseToken = await getDevToken()
      const registered = await registerExternalSystem(baseToken, systemId)
      registeredOk = must('S6-A: external system registered', registered.ok, `http=${registered.status}`)
      // Diagnostic (Step 1 discipline applied to this next layer, not a guess): the run-time re-resolves
      // this SAME external system from the DB (externalSystemRegistry.getExternalSystemForAdapter), and
      // its credential lookup returns `undefined` — silently dropping the `credentials` property entirely
      // — if the stored ciphertext is missing or empty. `hasCredentials` is a boolean already exposed by
      // the ordinary GET route (rowToPublicExternalSystem) — never the credential content itself — so
      // this is safe to read directly into the values-free evidence.
      if (registeredOk) {
        const fetched = await requestJson(`/api/integration/external-systems/${encodeURIComponent(systemId)}`,
          { token: baseToken, accept: [200] })
        S.s6aExternalSystemHasCredentials = String(fetched.body?.data?.hasCredentials === true)
      }
    } finally {
      await stopServer()
    }
  } catch (error) {
    S.s6aExternalSystemRegistered = 'FAIL'
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'EXTERNAL_SYSTEM_REGISTRATION_FAILED'
    must('S6-A: external system registered', false, String(error && error.message || error))
    return
  }
  S.s6aExternalSystemRegistered = registeredOk ? 'PASS' : 'FAIL'
  if (!registeredOk) {
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'EXTERNAL_SYSTEM_REGISTRATION_FAILED'
    return
  }
  // The root cause the projection fix addresses, observed against the real database rather than inferred
  // from "grep found no setTypeParser": read this row's TIMESTAMPTZ columns back over pg and report
  // whether the driver hands them back as native JS Date. Values-free — the type, never the value.
  await reportAdapterTimestampRuntimeType(systemId)
  // Prove the observability queries themselves are sound BEFORE the walk needs them, so a green/red
  // verdict from them later is about the walk and not about their own SQL.
  await assertS6AObservabilityQueriesResolve()

  // 3. provisioning spec (inline external-system connection material — no DB registry lookup at
  // provisioning time; the runtime independently re-resolves the SAME record at run time).
  // bindingExpiresAt and signerExpiresAt share ONE `nowMs` snapshot: normalizeAuthorityInput
  // (sealed-export-lifecycle-provisioning.cjs) also fail-closes if bindingExpiresAt > signerExpiresAt,
  // and two separate Date.now() calls truncated to seconds could straddle a second boundary and make
  // bindingExpiresAt the later of the two by one second — rare but avoidable.
  const expiresAtIso = toUtcSecondsIso(Date.now() + 24 * 60 * 60 * 1000)
  const provisioningSpec = {
    binding: {
      approvedConfigVersionId,
      bindingExpiresAt: expiresAtIso,
      bindingId: `e2efunc-binding-id-${salt}`,
      bindingVersion,
      externalSystemId: systemId,
      signerExpiresAt: expiresAtIso,
      tableRef: MSSQL_TABLE,
      tenantId: TENANT_ID,
      workspaceId: null,
    },
    externalSystem: {
      config: {
        sealedSnapshotSqlServer: {
          database: MSSQL_DATABASE,
          encrypt: true,
          instanceName: null,
          port: MSSQL_PORT,
          server: MSSQL_HOST,
          trustServerCertificate: true,
        },
      },
      credentials: {
        sealedSnapshotSqlServer: {
          password: MSSQL_READER_PASSWORD,
          user: MSSQL_READER_LOGIN,
        },
      },
      id: systemId,
      kind: 'data-source:sql-readonly',
      role: 'source',
      status: 'active',
      tenantId: TENANT_ID,
      workspaceId: null,
    },
  }
  const specFile = path.join(keysDir, 'provisioning-spec.json')
  fs.writeFileSync(specFile, JSON.stringify(provisioningSpec))

  const provisioningEnv = {
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT: ARTIFACT_ROOT,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE: identityKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE: qualificationKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID: qualificationKeyId,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE: signerKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_ROLE: PROVISIONING_DB_ROLE,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_URL: PROVISIONING_DB_URL,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_SPEC_FILE: specFile,
  }
  const provisioned = await runProvisioningScript(provisioningEnv)
  let provisionedOk = false
  let provisioningFailureCode = '<unparseable>'
  try {
    const parsed = JSON.parse(provisioned.stdout.trim().split('\n').pop() || '{}')
    provisionedOk = provisioned.code === 0 && parsed.ok === true && parsed.externalWrite === false && parsed.valuesFree === true
    S.s6aProvisioningChanged = typeof parsed.changed === 'boolean' ? String(parsed.changed) : '<unregistered>'
    // The provisioning script's own failure contract declares `valuesFree: true` on its `code` field
    // (plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs)
    // — safe to surface for diagnosis. Job-log only (process.stderr): this is NOT written to
    // summary.txt/checks.json, which are uploaded as CI artifacts and must stay strictly values-free —
    // the failure-vocabulary `code` enum is trusted, but keeping it out of the retained evidence artifact
    // is the conservative choice.
    if (!provisionedOk && typeof parsed.code === 'string') provisioningFailureCode = parsed.code
  } catch {
    provisionedOk = false
  }
  if (!provisionedOk) {
    // Known finding (root-caused via a temporary error.stack + pg-driver replay, since removed from this
    // script): if this code is SEALED_EXPORT_INTERNAL_ERROR, the underlying cause — confirmed against a
    // real Postgres 16 container — is a raw "permission denied for table
    // integration_sealed_export_signer_public_keys" that migrations/073_create_sealed_export_stock_prep_
    // runtime_authority.sql's own GRANT statement causes: it grants the provisioning role only
    // SELECT, INSERT on that table, but provisionInitialStockPreparationBinding
    // (sealed-export-lifecycle-provisioning.cjs) runs `SELECT ... FOR UPDATE` against it
    // (trx.selectOneForUpdate, via db.cjs:212) — a locking read that Postgres requires UPDATE privilege
    // for, independent of whether a row exists to lock. This reproduces for ANY tenant's first S6-A
    // provisioning attempt under migration 073's grants as written, not just this harness's fixture; it is
    // a production finding to report, not something this E2E harness can or should paper over.
    note('S6-A: provisioning script failure detail (job log only, not in uploaded evidence)',
      `code=${provisioningFailureCode}`)
  }
  must('S6-A: provisioning script -> ok:true, externalWrite:false, valuesFree:true', provisionedOk,
    `exit=${provisioned.code}`)
  S.s6aProvisioning = provisionedOk ? 'PASS' : 'FAIL'
  if (!provisionedOk) {
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'PROVISIONING_FAILED'
    return
  }

  // 4. flag-ON restart with the full runtime authority wired.
  //
  // RD-E2E finding, NOW FIXED IN A PRODUCTION FILE (R2c) — kept here because the harness is what found
  // it and what re-proves it. Root-caused via a temporary --require preload that wrapped
  // failSealedExport and captured a stack for SEALED_EXPORT_BINDING_UNQUALIFIED (since REMOVED; the
  // preload only ever observed, it never changed behavior, but any green obtained with production
  // modules monkey-patched is a green under instrumented modules, so it does not belong in the merged
  // harness). The captured stack pinned the refusal to
  // stock-preparation-sqlserver-source-authority.cjs's normalizeExternalSystem -> ownedCanonical ->
  // canonicalCodec.tryFreezeCanonical(raw), called with the FULL adapter-shaped object
  // external-systems.cjs's rowToAdapterExternalSystem returns for a real DB row (id, tenantId,
  // workspaceId, kind, role, status, config, credentials, PLUS projectId, name, capabilities,
  // lastTestedAt, lastError, createdAt, updatedAt). createdAt/updatedAt are always non-null JS `Date`
  // instances (integration_external_systems.created_at/updated_at are `TIMESTAMPTZ NOT NULL DEFAULT
  // NOW()`, and no `pg` type-parser override exists anywhere in this repo, confirmed by grep AND, since
  // R2c, by reportAdapterTimestampRuntimeType() reading the column back off the real database into
  // s6aAdapterCreatedAtIsDate), and the canonical-json codec's domain explicitly refuses Date
  // (`EXOTIC_OBJECT`). This reproduced for ANY external-system row created through the ordinary product
  // API, not just this harness's fixture.
  //
  // The fix does NOT widen the codec and does NOT change rowToAdapterExternalSystem: the source
  // authority now projects the record down to EXTERNAL_SYSTEM_PROJECTION_FIELDS — the closed set of
  // members it actually reads — before canonicalising, with every field-set and identity check running
  // unchanged on the projection. Pinned by
  // plugins/plugin-integration-core/__tests__/sealed-export-s6a-source-authority-adapter-projection.test.cjs,
  // which builds its record through the REAL rowToAdapterExternalSystem from a pg-shaped row with
  // native Date values (the hand-built ISO-string fixture every previous test used is exactly why this
  // survived), and carries both a string-timestamp positive control and a projection-removed negative
  // control.
  const runtimeEnv = {
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: 'true',
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT: ARTIFACT_ROOT,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_EVIDENCE_KEY_FILE: evidenceKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE: identityKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE: qualificationKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID: qualificationKeyId,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_ROLE: RUNTIME_DB_ROLE,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_URL: RUNTIME_DB_URL,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE: signerKeyFile,
  }
  try {
    await startServer(runtimeEnv, 'flag-on')
  } catch (error) {
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'RUNTIME_SERVER_START_FAILED'
    must('S6-A: flag-ON server started with runtime authority constructed', false, String(error && error.message || error))
    return
  }

  try {
    const token = await getDevToken()
    const health = await requestJson('/api/integration/health', { token })
    const flagOn = health.body?.capabilities?.stockPreparationSqlServerSealedSnapshot === true
    S.s6aHealthFlagOn = flagOn ? 'PASS' : 'FAIL'
    if (!must('S6-A: health reports runtime CONSTRUCTED (not just flag-string-true)', flagOn,
      `flagOn=${flagOn}`)) {
      S.s6aFlagOnRun = 'NOT_RUN'
      S.s6aFlagOnReason = 'RUNTIME_NOT_CONSTRUCTED'
      // Step 1 diagnostic: index.cjs's try/catch around runtime construction discards the actual cause
      // and logs ONE fixed warning line on ANY failure (index.cjs, "sealed-snapshot runtime
      // initialization refused; capability disabled") — by design, not a bug to route around. This does
      // not change that discard on the production path; it only reports, as closed presence booleans
      // (never the log's own text, which can carry MULTITABLE_..._RUNTIME_DATABASE_URL's password), which
      // of two disjoint explanations the flag-on server's OWN log shows: the plugin's catch fired
      // (construction was attempted and refused) vs. it never fired at all (the server did not even reach
      // that code path — e.g. it crashed on boot for an unrelated reason such as a port conflict).
      const flagOnLogPath = path.join(OUT_DIR, 'server-flag-on.log')
      let logText = ''
      try {
        logText = fs.readFileSync(flagOnLogPath, 'utf8')
      } catch {
        // log not readable — both presence booleans stay false, which is itself an honest signal
      }
      S.s6aFlagOnCatchFired = String(logText.includes('sealed-snapshot runtime initialization refused'))
      S.s6aFlagOnLogHasEaddrinuse = String(logText.includes('EADDRINUSE'))
      return
    }

    // mvp/ensure is idempotent per tenant/workspace — defensive re-provisioning of the underlying
    // multitable object/field templates the persist step needs (the existing-chain phase already ran
    // this once for the SAME tenant, but this phase can run standalone).
    await requestJson('/api/integration/stock-preparation/mvp/ensure', { method: 'POST', token, body: {}, accept: [200, 201] })

    const operationId = `s6a-e2e-op-${salt}`
    // Wall-clock (requirement 4), on the S6-A POST's own timeout — additive evidence only; this walk's
    // PASS/FAIL semantics are unchanged. Published as this job's own `primary_duration_ms` output (R9
    // restructure) and reassembled downstream, together with the mid-tier arm's own duration from its OWN
    // job, into the primary (N=3) data point for the scale-slope job's two-point fit — see
    // scripts/ops/stock-preparation-e2e-compute-scale-slope.mjs.
    const firstRunStartedAtMs = Date.now()
    const firstRun = await s6aRunProbe(token, operationId, { timeoutMs: S6A_POST_TIMEOUT_MS })
    S.s6aFirstRunPostDurationMs = Date.now() - firstRunStartedAtMs
    const firstData = firstRun.body?.data || {}
    S.s6aFirstRunHttp = firstRun.status
    S.s6aFirstRunMode = firstData.mode || '<unregistered>'
    S.s6aFirstRunStatus = firstData.status || '<unregistered>'
    S.s6aBusinessLineCount = Number.isInteger(firstData.businessLineCount) ? firstData.businessLineCount : -1
    S.s6aFirstRunExternalWrite = firstData.externalWrite === false ? 'false' : '<unregistered>'
    // A refusal's `error.code` here is ALWAYS a member of the frozen sealed-export failure vocabulary (or
    // the http-routes.cjs error-code set) — never caller-derived text (failure-vocabulary.cjs's own
    // details discipline guarantees that) — so it is safe to surface directly in the values-free evidence,
    // the same way the flag-arm probes already surface `${label}Code` above.
    S.s6aFirstRunErrorCode = firstRun.body?.error?.code || '<none>'
    // Proves the PRODUCT created the capture root, not this harness: s6aCaptureRootExistedBeforeRun
    // above is false (the harness never mkdirs `<ARTIFACT_ROOT>/capture`, only `<ARTIFACT_ROOT>`
    // itself), and the directory exists now regardless of how the run above concluded — execute()'s
    // mkdir runs before any capture I/O, so it fires whether the walk goes on to succeed or refuse for
    // an unrelated reason downstream.
    S.s6aCaptureRootCreatedByProduct = String(fs.existsSync(captureRoot))
    const firstOk = firstRun.ok && firstData.status === 'COMPLETED' && firstData.mode === 'internal_persist' &&
      firstData.externalWrite === false && firstData.businessLineCount === relation.rows.length
    must('S6-A: first run -> COMPLETED, internal_persist, externalWrite=false, businessLineCount matches',
      firstOk,
      `http=${firstRun.status} mode=${S.s6aFirstRunMode} status=${S.s6aFirstRunStatus} lines=${S.s6aBusinessLineCount} code=${S.s6aFirstRunErrorCode}`)
    S.s6aFirstRun = firstOk ? 'PASS' : 'FAIL'
    if (!firstOk) {
      // Diagnostic: does a run row exist at all for this (tenant, operationId)? A refusal upstream of
      // any capture attempt (binding/qualification resolution) leaves NO row; a refusal DURING capture
      // leaves a CAPTURE_FAILED row with a persisted `failure_reason` token (migration 073's own CHECK
      // constraint requires one). This splits which half of the pipeline to look at — the closed
      // `error.code` alone cannot, since many call sites across the codebase share the same token.
      await assertS6ARunDatabaseObservableOnFailure(operationId)
      // Narrow WHICH stage of the capture half refused, by walking the same production sequence with
      // the same production modules. Never loosens anything — see diagnoseS6ACaptureRefusal's comment.
      await diagnoseS6ACaptureRefusal({
        approvedConfigVersionId,
        bindingVersion,
        identityKeyFile,
        systemId,
      })
      // ...and if the run row got PAST the capture half, narrow the post-capture half too.
      await diagnoseS6APostCaptureRefusal()
      S.s6aDatabaseObservable = 'NOT_RUN'
      S.s6aReplayRun = 'NOT_RUN'
      S.s6aReplayNoSecondWrite = 'NOT_RUN'
      // Finding (review #4724): this early return used to fall straight through to main()'s evidence
      // write with NO s6aFlagOnRun key at all — absence of a key is not distinguishable from
      // not-applicable, and this IS the path that actually executes today. Always emit it, on every exit
      // out of this function, not just the ones above. NOT_RUN (not FAIL): this is the phase ROLL-UP key,
      // and its vocabulary elsewhere in this function is PASS/NOT_RUN — "the walk did not establish its
      // claim", not "the walk ran and failed" (that per-step verdict is S.s6aFirstRun, set above).
      S.s6aFlagOnRun = 'NOT_RUN'
      S.s6aFlagOnReason = 'FIRST_RUN_FAILED'
      return
    }

    // Step 3: the HTTP response saying COMPLETED is not proof anything was written — confirm the
    // generation kernel's own rows exist, over a connection independent of the runtime role that wrote
    // them.
    const dbOk = await assertS6ARunDatabaseObservable(operationId, relation.rows.length)
    if (!dbOk) {
      S.s6aReplayRun = 'NOT_RUN'
      S.s6aReplayNoSecondWrite = 'NOT_RUN'
      // Same rationale as the !firstOk branch above: always emit the roll-up key on every exit out of
      // this function.
      S.s6aFlagOnRun = 'NOT_RUN'
      S.s6aFlagOnReason = 'DATABASE_OBSERVABLE_FAILED'
      return
    }

    // Step 4: idempotent replay. "Idempotent" is a claim about WRITES, and the replay's own response
    // body cannot substantiate it — a runtime that silently ran the whole walk a second time and then
    // reported the first result would produce a byte-identical `mode=internal_noop` body. So the write
    // state is snapshotted on both sides of the identical second call and required to be unchanged.
    const beforeReplay = await withApplicationPool((pool) => snapshotS6AWriteState(pool, operationId))
    const replayStartedAtMs = Date.now()
    const replay = await s6aRunProbe(token, operationId, { timeoutMs: S6A_POST_TIMEOUT_MS })
    S.s6aReplayPostDurationMs = Date.now() - replayStartedAtMs
    const replayData = replay.body?.data || {}
    S.s6aReplayHttp = replay.status
    S.s6aReplayMode = replayData.mode || '<unregistered>'
    const replayResponseOk = replay.ok && replayData.mode === 'internal_noop' && replayData.replay === true &&
      replayData.sourceReadCount === 1 && replayData.businessLineCount === relation.rows.length &&
      replayData.externalWrite === false
    must('S6-A: replay same operationId -> internal_noop, sourceReadCount=1, same businessLineCount',
      replayResponseOk, `http=${replay.status} mode=${S.s6aReplayMode}`)

    const afterReplay = await withApplicationPool((pool) => snapshotS6AWriteState(pool, operationId))
    const unchanged = JSON.stringify(beforeReplay) === JSON.stringify(afterReplay)
    S.s6aReplayRunRowCountBefore = beforeReplay.counts.runs
    S.s6aReplayRunRowCountAfter = afterReplay.counts.runs
    S.s6aReplayGenerationCountBefore = beforeReplay.counts.generations
    S.s6aReplayGenerationCountAfter = afterReplay.counts.generations
    S.s6aReplayIngestionSessionCountBefore = beforeReplay.counts.ingestionSessions
    S.s6aReplayIngestionSessionCountAfter = afterReplay.counts.ingestionSessions
    S.s6aReplayGenerationRowCountBefore = beforeReplay.counts.generationRows
    S.s6aReplayGenerationRowCountAfter = afterReplay.counts.generationRows
    S.s6aReplayGenerationIdStable = String(beforeReplay.generationId === afterReplay.generationId)
    S.s6aReplayIngestionSessionIdStable =
      String(beforeReplay.ingestionSessionId === afterReplay.ingestionSessionId)
    // Positive control on the snapshot itself: a comparator that always reports "unchanged" (because it
    // read nothing) would pass this arm vacuously. Require the snapshot to have actually observed the
    // walk's own writes before its stability is allowed to mean anything.
    const snapshotIsLive = beforeReplay.counts.runs >= 1 && beforeReplay.counts.generations >= 1 &&
      beforeReplay.counts.ingestionSessions >= 1 &&
      beforeReplay.counts.generationRows === relation.rows.length &&
      beforeReplay.generationId !== '<none>' && beforeReplay.ingestionSessionId !== '<none>'
    S.s6aReplayWriteStateSnapshotLive = snapshotIsLive ? 'PASS' : 'FAIL'
    must(
      'S6-A: replay wrote NOTHING — run/generation/ingestion-session/generation-row counts and the ' +
      'run row\'s generation_id + ingestion_session_id are byte-identical across the second identical ' +
      'call (and the snapshot demonstrably observed the first walk\'s writes)',
      unchanged && snapshotIsLive,
      `unchanged=${unchanged} snapshotLive=${snapshotIsLive} ` +
      `gens=${beforeReplay.counts.generations}->${afterReplay.counts.generations} ` +
      `sessions=${beforeReplay.counts.ingestionSessions}->${afterReplay.counts.ingestionSessions} ` +
      `genRows=${beforeReplay.counts.generationRows}->${afterReplay.counts.generationRows}`,
    )
    S.s6aReplayNoSecondWrite = (unchanged && snapshotIsLive) ? 'PASS' : 'FAIL'
    const replayOk = replayResponseOk && unchanged && snapshotIsLive
    S.s6aReplayRun = replayOk ? 'PASS' : 'FAIL'
    S.s6aFlagOnRun = (firstOk && dbOk && replayOk) ? 'PASS' : 'FAIL'
  } finally {
    await stopServer()
  }
}

// ── R9 scale legs (each its OWN arm/process/job — see S6A_ARM — gated on S6A_SCALE_REQUESTED) ──────────
//
// Closes the gap this leg exists for: the 24999-row bound had, until now, only ever been exercised by a
// pure in-process decoder unit test (stock-preparation-sealed-snapshot-decoder.test.cjs) — no SQL Server
// capture, private ingestion, generation kernel, apply, activation or HTTP layer had ANY scale coverage.
//
// Reuses attemptS6ARealRun's helper functions (prepareSqlServerRelation, registerExternalSystem,
// runProvisioningScript, assertS6ARunDatabaseObservable, snapshotS6AWriteState, withApplicationPool,
// s6aRunProbe, getDevToken, startServer/stopServer) rather than re-deriving them — attemptS6ARealRun
// ITSELF IS UNCHANGED (its one internal call `prepareSqlServerRelation(salt)` keeps using this module's
// new optional-parameter defaults, which reproduce exactly what it always passed).

// All four come from the SAME check (stock-preparation-runtime-store.cjs's loadCurrentAuthority, lines
// ~355-388), which runs BEFORE capture even starts and is checked once, at the top of runInternal —
// before the capture that reads whatever rowCount is in the table. A rejection-arm response carrying one
// of these means the run never got far enough to exercise the row-count bound at all, most plausibly
// because the 5-minute qualification window (QUALIFICATION_TTL_MS = 5*60*1000,
// sqlserver-sealed-snapshot-service-core.cjs:122) had ALREADY elapsed by the time the POST reached this
// check — i.e. between provisioning and the POST being received, NOT during the capture that follows (the
// rejection arm's own row-count seeding happens BEFORE provisioning issues the qualification — see
// setupS6AScaleBinding — so seeding time is not charged against this window at all; only server-restart +
// request-dispatch overhead is). The mid-tier walk is the one with MORE exposure to the TTL, not this
// arm: it runs all the way through capture -> ingestion -> generation, and generation-kernel.cjs's OWN
// check (line ~280) fires AFTER capture, so a slow capture-through-generation sequence pushes toward the
// deadline in a way this arm's early-exit (refuses at the manifest check, inside the SAME try block as
// the capture call, before ingestion/generation ever start) cannot. Treating one of these as "the bound
// was proven" would still be GREEN for the wrong reason regardless of which arm sees it; runS6ARejectionArm
// below treats them as inconclusive (see s6aRejectionElapsedSinceQualificationMs for the timing evidence
// that would explain it), and runS6AMidTierScaleWalk parses the same reason into
// s6aMidTierFirstRunReasonToken as a diagnostic (not a pass/fail classification — a mid-tier TTL casualty
// is legitimately a FAILED walk, not an inconclusive one, since completing IS what that arm claims).
const SEALED_EXPORT_AUTHORITY_EXPIRY_FAMILY = new Set([
  'SEALED_EXPORT_SIGNER_UNENROLLED',
  'SEALED_EXPORT_SIGNER_EXPIRED',
  'SEALED_EXPORT_SIGNER_REVOKED',
  'SEALED_EXPORT_BINDING_UNQUALIFIED',
])

// A SealedExportError (the ONLY class every sealed-export refusal throws — failure-vocabulary.cjs) has no
// `.status`/`.code`, only `.reason`. http-routes.cjs's sendError()/inferHttpStatus()/inferErrorCode()
// (read directly at http-routes.cjs:406-458, not guessed here) therefore fall through every named-error
// branch to the generic `return 500`, with `inferErrorCode()` falling back to `error.name`
// ('SealedExportError') — the actual reason token only survives in `error.message`, which
// SealedExportError's constructor sets to the FIXED string `'sealed-export refusal: ' + reason` (`reason`
// is guaranteed to be a closed-vocabulary member by failSealedExport() — never caller-derived text — so
// this string is values-free by construction). This parses that fixed shape back out; a message that does
// not match it yields `null`, never a guess.
function extractSealedExportReasonFromMessage(message) {
  if (typeof message !== 'string') return null
  const match = /^sealed-export refusal: ([A-Z_]+)$/.exec(message)
  return match ? match[1] : null
}

// Shared setup for a scale-leg arm: SQL Server relation (batched, optionally with an oversized last row)
// -> external-system registration (its own throwaway flag-OFF server) -> provisioning (issues the
// 5-minute qualification the caller must race against). Returns enough for the caller to either run the
// flag-ON walk (mid-tier) or a single flag-ON refusal probe (rejection), or to explain why it could not.
// `tenantId` is supplied by the caller (deterministically `${SCALE_TENANT_ID_PREFIX}-${label}` — see the
// comment above SCALE_TENANT_ID_PREFIX for why this arm cannot share TENANT_ID or any other arm's
// tenant), not re-derived here, so a caller that needs it BEFORE setup completes (e.g. for a pre-arm
// baseline snapshot) and this function compute the identical value from a single source of truth.
async function setupS6AScaleBinding({ label, salt, rowCount, oversizedLastRow, artifactRoot, tenantId }) {
  const systemId = `e2efunc-s6a-${label}-source-${salt}`
  const bindingVersion = `e2efunc-${label}-binding-${salt}`
  const approvedConfigVersionId = `e2efunc-${label}-config-${salt}`
  const qualificationKeyId = `e2efunc-${label}-qual-key-v1`

  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), `s6a-e2e-${label}-keys-`))
  const identityKeyFile = path.join(keysDir, 'identity.key')
  const evidenceKeyFile = path.join(keysDir, 'evidence.key')
  const qualificationKeyFile = path.join(keysDir, 'qualification.key')
  const signerKeyFile = path.join(keysDir, 'signer.pem')
  fs.writeFileSync(identityKeyFile, crypto.randomBytes(32))
  fs.writeFileSync(evidenceKeyFile, crypto.randomBytes(32))
  fs.writeFileSync(qualificationKeyFile, crypto.randomBytes(32))
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(signerKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  fs.mkdirSync(artifactRoot, { recursive: true })

  let relation = null
  try {
    relation = await prepareSqlServerRelation(salt, rowCount, { oversizedLastRow })
    must(`${label}: SQL Server relation + SELECT-only login prepared (rowCount=${rowCount})`, true,
      `rows=${relation.rows.length}`)
  } catch (error) {
    must(`${label}: SQL Server relation + SELECT-only login prepared (rowCount=${rowCount})`, false,
      String(error && error.message || error))
    return { ok: false, reason: 'SQLSERVER_RELATION_SETUP_FAILED', relation: null }
  }

  let registeredOk = false
  let hasCredentials = 'unknown'
  try {
    await startServer({}, `pre-flag-on-registration-${label}`)
    try {
      const baseToken = await getDevToken(tenantId)
      const registered = await registerExternalSystem(baseToken, systemId, tenantId)
      registeredOk = must(`${label}: external system registered`, registered.ok, `http=${registered.status}`)
      if (registeredOk) {
        const fetched = await requestJson(`/api/integration/external-systems/${encodeURIComponent(systemId)}`,
          { token: baseToken, accept: [200], tenantId })
        hasCredentials = String(fetched.body?.data?.hasCredentials === true)
      }
    } finally {
      await stopServer()
    }
  } catch (error) {
    must(`${label}: external system registered`, false, String(error && error.message || error))
    return { ok: false, reason: 'EXTERNAL_SYSTEM_REGISTRATION_FAILED', relation, hasCredentials }
  }
  if (!registeredOk) {
    return { ok: false, reason: 'EXTERNAL_SYSTEM_REGISTRATION_FAILED', relation, hasCredentials }
  }

  const expiresAtIso = toUtcSecondsIso(Date.now() + 24 * 60 * 60 * 1000)
  const provisioningSpec = {
    binding: {
      approvedConfigVersionId,
      bindingExpiresAt: expiresAtIso,
      bindingId: `e2efunc-${label}-binding-id-${salt}`,
      bindingVersion,
      externalSystemId: systemId,
      signerExpiresAt: expiresAtIso,
      tableRef: MSSQL_TABLE,
      tenantId,
      workspaceId: null,
    },
    externalSystem: {
      config: {
        sealedSnapshotSqlServer: {
          database: MSSQL_DATABASE,
          encrypt: true,
          instanceName: null,
          port: MSSQL_PORT,
          server: MSSQL_HOST,
          trustServerCertificate: true,
        },
      },
      credentials: {
        sealedSnapshotSqlServer: {
          password: MSSQL_READER_PASSWORD,
          user: MSSQL_READER_LOGIN,
        },
      },
      id: systemId,
      kind: 'data-source:sql-readonly',
      role: 'source',
      status: 'active',
      tenantId,
      workspaceId: null,
    },
  }
  const specFile = path.join(keysDir, 'provisioning-spec.json')
  fs.writeFileSync(specFile, JSON.stringify(provisioningSpec))

  const provisioningEnv = {
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT: artifactRoot,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE: identityKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE: qualificationKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID: qualificationKeyId,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE: signerKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_ROLE: PROVISIONING_DB_ROLE,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_URL: PROVISIONING_DB_URL,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_SPEC_FILE: specFile,
  }
  const provisioned = await runProvisioningScript(provisioningEnv)
  let provisionedOk = false
  // Parity with the primary walk (see the S6-A provisioning block above): capture the child's closed-set
  // failure code, not just its exit status. Run 30880831626 proved why this matters — BOTH scale arms
  // reported `PROVISIONING_FAILED exit=1` and the 2008-line job log contained ZERO SEALED_EXPORT_* tokens,
  // so the failure was completely undiagnosable. An exit code is not a reason.
  let provisioningFailureCode = '<unparsed>'
  try {
    const parsed = JSON.parse(provisioned.stdout.trim().split('\n').pop() || '{}')
    provisionedOk = provisioned.code === 0 && parsed.ok === true && parsed.externalWrite === false && parsed.valuesFree === true
    if (!provisionedOk && typeof parsed.code === 'string') provisioningFailureCode = parsed.code
  } catch {
    provisionedOk = false
  }
  // The instant provisioning succeeds is the instant the qualification this arm must race against was
  // issued (stock-preparation-runtime-provisioning.cjs sets qualification_expires_at = now +
  // QUALIFICATION_TTL_MS here) — requirement 4's "elapsed time since qualification issuance" is measured
  // from THIS timestamp, taken right after this step, not an estimate. It is taken after
  // runProvisioningScript's own process RETURNS, not at the instant the script computed the qualification
  // internally — every elapsed figure below therefore UNDERSTATES true elapsed time by that process's own
  // tail (JSON serialization, stdout flush, process exit), which is the conservative direction for
  // reporting evidence but the WRONG direction if this number were ever used to predict how close to the
  // TTL a run actually was.
  const qualificationIssuedAtMs = Date.now()
  must(`${label}: provisioning script -> ok:true, externalWrite:false, valuesFree:true`, provisionedOk,
    `exit=${provisioned.code} code=${provisioningFailureCode}`)
  if (!provisionedOk) {
    // Closed-set token only — never the child's raw stderr, which is not values-free.
    return {
      ok: false,
      reason: 'PROVISIONING_FAILED',
      provisioningFailureCode,
      relation,
      hasCredentials,
      qualificationIssuedAtMs,
    }
  }

  const runtimeEnv = {
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: 'true',
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT: artifactRoot,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_EVIDENCE_KEY_FILE: evidenceKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE: identityKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE: qualificationKeyFile,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID: qualificationKeyId,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_ROLE: RUNTIME_DB_ROLE,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_URL: RUNTIME_DB_URL,
    MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE: signerKeyFile,
  }
  return { ok: true, relation, hasCredentials, qualificationIssuedAtMs, runtimeEnv, systemId, tenantId }
}

// Mid-tier calibration walk (requirements 5 & 7): a FULL first-run + database-observable + idempotent-
// replay walk at S6A_ROW_COUNT rows (default suggestion ~2500), run BEFORE the rejection arm so its
// timing predicts the full-scale (MAX_BUSINESS_LINES) cost rather than requiring an actual 24999-row run
// in CI. Carries the oversized-payload row (requirement 3 — "one leg, not two").
async function runS6AMidTierScaleWalk() {
  const keyPrefix = 's6aMidTier'
  const label = 'midtier'
  const rowCount = S6A_ROW_COUNT
  const salt = `${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const artifactRoot = path.join(path.resolve(ARTIFACT_ROOT), label)
  // Dedicated tenant (requirement, see SCALE_TENANT_ID_PREFIX): this arm's provisioning attempt MUST NOT
  // share TENANT_ID with the primary walk — the S6-A route hardcodes workspaceId:null and
  // provisionInitialStockPreparationBinding's activeBinding lookup is scoped only by
  // {tenant_id, workspace_id, object_key}, so a second, DIFFERENT binding identity under the SAME tenant
  // would refuse SEALED_EXPORT_BINDING_UNQUALIFIED against the primary's already-ACTIVE binding.
  const tenantId = `${SCALE_TENANT_ID_PREFIX}-${label}`

  S[`${keyPrefix}RowCount`] = rowCount

  // Baseline taken at the TOP of this arm, before it does anything at all (including before its own SQL
  // Server relation prep). This arm's tenant is dedicated (see above), so in practice this baseline is
  // always zero-ish — kept as a DELTA (not an absolute count) anyway as defense in depth against any
  // future change that shares a tenant across arms again.
  const preArmSnapshot = await withApplicationPool((pool) => snapshotS6AWriteState(pool, '<no-such-operation-id>', tenantId))

  const setup = await setupS6AScaleBinding({ label, salt, rowCount, oversizedLastRow: true, artifactRoot, tenantId })
  S[`${keyPrefix}OversizedPayloadTextLength`] = setup.relation?.oversizedPayloadTextLength ?? -1
  if (setup.relation?.oversizedPayloadTextLength != null) {
    must(`${keyPrefix}: oversized fixture row's canonical payload text exceeds nvarchar(4000) (the fixture/contract mismatch this leg fixes)`,
      setup.relation.oversizedPayloadTextLength > 4000,
      `length=${setup.relation.oversizedPayloadTextLength}`)
  }
  if (!setup.ok) {
    S[`${keyPrefix}Run`] = 'NOT_RUN'
    S[`${keyPrefix}Reason`] = setup.reason
    // Surface the closed-set provisioning token in the values-free block, not just in the job log —
    // run 30880831626 produced PROVISIONING_FAILED with no recoverable reason anywhere.
    if (setup.provisioningFailureCode) S[`${keyPrefix}ProvisioningCode`] = setup.provisioningFailureCode
    return
  }

  try {
    await startServer(setup.runtimeEnv, `arm-${label}`)
  } catch (error) {
    S[`${keyPrefix}Run`] = 'NOT_RUN'
    S[`${keyPrefix}Reason`] = 'RUNTIME_SERVER_START_FAILED'
    must(`${keyPrefix}: flag-ON server started with runtime authority constructed`, false, String(error && error.message || error))
    return
  }

  try {
    const token = await getDevToken(tenantId)
    const health = await requestJson('/api/integration/health', { token, tenantId })
    const flagOn = health.body?.capabilities?.stockPreparationSqlServerSealedSnapshot === true
    S[`${keyPrefix}HealthFlagOn`] = flagOn ? 'PASS' : 'FAIL'
    if (!must(`${keyPrefix}: health reports runtime CONSTRUCTED (not just flag-string-true)`, flagOn, `flagOn=${flagOn}`)) {
      S[`${keyPrefix}Run`] = 'NOT_RUN'
      S[`${keyPrefix}Reason`] = 'RUNTIME_NOT_CONSTRUCTED'
      return
    }

    await requestJson('/api/integration/stock-preparation/mvp/ensure', { method: 'POST', token, body: {}, accept: [200, 201], tenantId })

    const operationId = `s6a-e2e-${label}-op-${salt}`
    // Wall-clock + elapsed-since-qualification (requirement 4), on its OWN timeout (S6A_POST_TIMEOUT_MS),
    // separate from REQUEST_TIMEOUT_MS.
    const firstRunStartedAtMs = Date.now()
    const firstRun = await s6aRunProbe(token, operationId, { timeoutMs: S6A_POST_TIMEOUT_MS, tenantId })
    S[`${keyPrefix}FirstRunPostDurationMs`] = Date.now() - firstRunStartedAtMs
    S[`${keyPrefix}FirstRunElapsedSinceQualificationMs`] = Date.now() - setup.qualificationIssuedAtMs
    const firstData = firstRun.body?.data || {}
    S[`${keyPrefix}FirstRunHttp`] = firstRun.status
    S[`${keyPrefix}FirstRunMode`] = firstData.mode || '<unregistered>'
    S[`${keyPrefix}FirstRunStatus`] = firstData.status || '<unregistered>'
    S[`${keyPrefix}BusinessLineCount`] = Number.isInteger(firstData.businessLineCount) ? firstData.businessLineCount : -1
    S[`${keyPrefix}FirstRunErrorCode`] = firstRun.body?.error?.code || '<none>'
    // Diagnostic only (this arm's PASS/FAIL is unaffected — completing IS what it claims, so a TTL
    // casualty here is legitimately a failure, not inconclusive the way it is for the rejection arm).
    // Parses the same fixed 'sealed-export refusal: <REASON>' shape s6aRejection* does — see
    // extractSealedExportReasonFromMessage — so a TTL blowout during this arm's (longer) capture ->
    // ingestion -> generation sequence is legible as SEALED_EXPORT_BINDING_UNQUALIFIED /
    // SEALED_EXPORT_SIGNER_EXPIRED etc. instead of only the generic 'SealedExportError' code.
    S[`${keyPrefix}FirstRunReasonToken`] =
      extractSealedExportReasonFromMessage(firstRun.body?.error?.message) || S[`${keyPrefix}FirstRunErrorCode`]
    const firstOk = firstRun.ok && firstData.status === 'COMPLETED' && firstData.mode === 'internal_persist' &&
      firstData.externalWrite === false && firstData.businessLineCount === rowCount
    must(`${keyPrefix}: first run -> COMPLETED, internal_persist, externalWrite=false, businessLineCount matches (rowCount=${rowCount})`,
      firstOk,
      `http=${firstRun.status} mode=${S[`${keyPrefix}FirstRunMode`]} status=${S[`${keyPrefix}FirstRunStatus`]} ` +
      `lines=${S[`${keyPrefix}BusinessLineCount`]} code=${S[`${keyPrefix}FirstRunErrorCode`]} ` +
      `reason=${S[`${keyPrefix}FirstRunReasonToken`]} durationMs=${S[`${keyPrefix}FirstRunPostDurationMs`]}`)
    S[`${keyPrefix}FirstRun`] = firstOk ? 'PASS' : 'FAIL'
    if (!firstOk) {
      await assertS6ARunDatabaseObservableOnFailure(operationId, keyPrefix, tenantId)
      S[`${keyPrefix}DatabaseObservable`] = 'NOT_RUN'
      S[`${keyPrefix}ReplayRun`] = 'NOT_RUN'
      S[`${keyPrefix}Run`] = 'NOT_RUN'
      S[`${keyPrefix}Reason`] = 'FIRST_RUN_FAILED'
      return
    }

    const dbOk = await assertS6ARunDatabaseObservable(operationId, rowCount, keyPrefix, 'S6-A mid-tier scale', tenantId)
    if (!dbOk) {
      S[`${keyPrefix}ReplayRun`] = 'NOT_RUN'
      S[`${keyPrefix}Run`] = 'NOT_RUN'
      S[`${keyPrefix}Reason`] = 'DATABASE_OBSERVABLE_FAILED'
      return
    }

    const beforeReplay = await withApplicationPool((pool) => snapshotS6AWriteState(pool, operationId, tenantId))
    const replayStartedAtMs = Date.now()
    const replay = await s6aRunProbe(token, operationId, { timeoutMs: S6A_POST_TIMEOUT_MS, tenantId })
    S[`${keyPrefix}ReplayPostDurationMs`] = Date.now() - replayStartedAtMs
    S[`${keyPrefix}ReplayElapsedSinceQualificationMs`] = Date.now() - setup.qualificationIssuedAtMs
    const replayData = replay.body?.data || {}
    S[`${keyPrefix}ReplayHttp`] = replay.status
    S[`${keyPrefix}ReplayMode`] = replayData.mode || '<unregistered>'
    const replayResponseOk = replay.ok && replayData.mode === 'internal_noop' && replayData.replay === true &&
      replayData.sourceReadCount === 1 && replayData.businessLineCount === rowCount && replayData.externalWrite === false
    must(`${keyPrefix}: replay same operationId -> internal_noop, sourceReadCount=1, same businessLineCount`,
      replayResponseOk, `http=${replay.status} mode=${S[`${keyPrefix}ReplayMode`]} durationMs=${S[`${keyPrefix}ReplayPostDurationMs`]}`)

    const afterReplay = await withApplicationPool((pool) => snapshotS6AWriteState(pool, operationId, tenantId))
    const unchanged = JSON.stringify(beforeReplay) === JSON.stringify(afterReplay)
    S[`${keyPrefix}ReplayGenerationIdStable`] = String(beforeReplay.generationId === afterReplay.generationId)
    S[`${keyPrefix}ReplayIngestionSessionIdStable`] =
      String(beforeReplay.ingestionSessionId === afterReplay.ingestionSessionId)
    // DELTA against preArmSnapshot, not an absolute count — see the comment above preArmSnapshot. This is
    // the ONLY line that differs from attemptS6ARealRun's equivalent check; everything else here mirrors
    // it exactly.
    const generationRowsDelta = beforeReplay.counts.generationRows - preArmSnapshot.counts.generationRows
    const snapshotIsLive = beforeReplay.counts.runs >= 1 && beforeReplay.counts.generations >= 1 &&
      beforeReplay.counts.ingestionSessions >= 1 &&
      generationRowsDelta === rowCount &&
      beforeReplay.generationId !== '<none>' && beforeReplay.ingestionSessionId !== '<none>'
    S[`${keyPrefix}ReplayWriteStateSnapshotLive`] = snapshotIsLive ? 'PASS' : 'FAIL'
    must(
      `${keyPrefix}: replay wrote NOTHING — run/generation/ingestion-session/generation-row counts and the ` +
      'run row\'s generation_id + ingestion_session_id are byte-identical across the second identical ' +
      'call (and this arm\'s OWN delta against its pre-arm baseline demonstrably observed its first walk\'s writes)',
      unchanged && snapshotIsLive,
      `unchanged=${unchanged} snapshotLive=${snapshotIsLive} generationRowsDelta=${generationRowsDelta}`,
    )
    S[`${keyPrefix}ReplayNoSecondWrite`] = (unchanged && snapshotIsLive) ? 'PASS' : 'FAIL'
    const replayOk = replayResponseOk && unchanged && snapshotIsLive
    S[`${keyPrefix}ReplayRun`] = replayOk ? 'PASS' : 'FAIL'
    S[`${keyPrefix}Run`] = (firstOk && dbOk && replayOk) ? 'PASS' : 'FAIL'
  } finally {
    await stopServer()
  }
}

// Rejection arm (requirement 6): the product MUST refuse rowCount = MAX_BUSINESS_LINES + 1. GREEN means
// refused-and-provably-because-of-the-bound; RED means either accepted (a real defect) or refused for an
// unrelated, inconclusive reason (the authority-expiry family above) — a generic "did it refuse" check
// would go GREEN in that second case too, proving nothing about the bound.
//
// Cost characteristic worth naming plainly: the bound is only checked AFTER a full capture of every row
// completes (stock-preparation-runtime-core.cjs:337's `manifest.totalRows > MAX_BUSINESS_LINES` check, in
// the SAME try block as the capture call) — there is no cheap pre-flight refusal. A 25000-row rejection
// costs a full-scale capture, same as the mid-tier walk's first run; this arm PROVES that in `s6aRejectionPostDurationMs`,
// it does not merely assert it.
async function runS6ARejectionArm() {
  const keyPrefix = 's6aRejection'
  const label = 'rejection'
  const rowCount = S6A_REJECTION_ROW_COUNT
  const salt = `${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const artifactRoot = path.join(path.resolve(ARTIFACT_ROOT), label)
  // Dedicated tenant — see the comment in runS6AMidTierScaleWalk / above SCALE_TENANT_ID_PREFIX. Also
  // keeps this arm's (intentionally refused, so it writes no generation rows) attempt from sharing ANY
  // state with the mid-tier arm's tenant, though that arm's writes would not collide either way.
  const tenantId = `${SCALE_TENANT_ID_PREFIX}-${label}`

  S[`${keyPrefix}RowCount`] = rowCount
  S[`${keyPrefix}Bound`] = MAX_BUSINESS_LINES

  const setup = await setupS6AScaleBinding({ label, salt, rowCount, oversizedLastRow: true, artifactRoot, tenantId })
  S[`${keyPrefix}OversizedPayloadTextLength`] = setup.relation?.oversizedPayloadTextLength ?? -1
  if (setup.relation?.oversizedPayloadTextLength != null) {
    must(`${keyPrefix}: oversized fixture row's canonical payload text exceeds nvarchar(4000)`,
      setup.relation.oversizedPayloadTextLength > 4000,
      `length=${setup.relation.oversizedPayloadTextLength}`)
  }
  if (!setup.ok) {
    S[`${keyPrefix}Run`] = 'NOT_RUN'
    S[`${keyPrefix}Reason`] = setup.reason
    // Surface the closed-set provisioning token in the values-free block, not just in the job log —
    // run 30880831626 produced PROVISIONING_FAILED with no recoverable reason anywhere.
    if (setup.provisioningFailureCode) S[`${keyPrefix}ProvisioningCode`] = setup.provisioningFailureCode
    return
  }

  try {
    await startServer(setup.runtimeEnv, `arm-${label}`)
  } catch (error) {
    S[`${keyPrefix}Run`] = 'NOT_RUN'
    S[`${keyPrefix}Reason`] = 'RUNTIME_SERVER_START_FAILED'
    must(`${keyPrefix}: flag-ON server started with runtime authority constructed`, false, String(error && error.message || error))
    return
  }

  try {
    const token = await getDevToken(tenantId)
    const health = await requestJson('/api/integration/health', { token, tenantId })
    const flagOn = health.body?.capabilities?.stockPreparationSqlServerSealedSnapshot === true
    S[`${keyPrefix}HealthFlagOn`] = flagOn ? 'PASS' : 'FAIL'
    // Explicit must() here, not a silent early return into NOT_RUN: a scale dispatch where the flag-on
    // restart quietly failed (or the route never mounted) would otherwise surface as a 404
    // STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED from the probe below — which IS a "refusal" by
    // HTTP status, but proves NOTHING about the row-count bound. Gating here, as a hard FAIL rather than
    // NOT_RUN, keeps "refused" and "never actually tested" from looking identical to a caller only
    // reading s6aRejectionRun.
    if (!must(`${keyPrefix}: health reports runtime CONSTRUCTED before the refusal probe (not just flag-string-true)`,
      flagOn, `flagOn=${flagOn}`)) {
      S[`${keyPrefix}Run`] = 'FAIL'
      S[`${keyPrefix}Reason`] = 'RUNTIME_NOT_CONSTRUCTED'
      return
    }

    await requestJson('/api/integration/stock-preparation/mvp/ensure', { method: 'POST', token, body: {}, accept: [200, 201], tenantId })

    const operationId = `s6a-e2e-${label}-op-${salt}`
    const startedAtMs = Date.now()
    let probe
    try {
      probe = await s6aRunProbe(token, operationId, { timeoutMs: S6A_POST_TIMEOUT_MS, tenantId })
    } catch (error) {
      // A capture of `rowCount` rows that never returns within S6A_POST_TIMEOUT_MS is itself an honest
      // limit to report, not a script crash — same NOT_RUN discipline as every other unreachable step in
      // this file.
      S[`${keyPrefix}PostDurationMs`] = Date.now() - startedAtMs
      S[`${keyPrefix}Run`] = 'NOT_RUN'
      S[`${keyPrefix}Reason`] = 'POST_TIMED_OUT_OR_FAILED'
      must(`${keyPrefix}: refusal probe completed within its own timeout (${S6A_POST_TIMEOUT_MS}ms)`, false,
        String(error && error.message || error))
      return
    }
    S[`${keyPrefix}PostDurationMs`] = Date.now() - startedAtMs
    S[`${keyPrefix}ElapsedSinceQualificationMs`] = Date.now() - setup.qualificationIssuedAtMs
    S[`${keyPrefix}Http`] = probe.status
    const accepted = probe.status === 200 && probe.body?.data?.status === 'COMPLETED'
    const directCode = probe.body?.error?.code || '<none>'
    const messageReason = extractSealedExportReasonFromMessage(probe.body?.error?.message)
    const effectiveReason = messageReason || directCode
    S[`${keyPrefix}ErrorCode`] = directCode
    S[`${keyPrefix}ReasonToken`] = effectiveReason
    const isAuthorityExpiryFamily = SEALED_EXPORT_AUTHORITY_EXPIRY_FAMILY.has(effectiveReason)
    S[`${keyPrefix}AuthorityExpiryFamily`] = String(isAuthorityExpiryFamily)
    const provesBound = !accepted && !isAuthorityExpiryFamily
    must(
      `${keyPrefix}: rowCount=${rowCount} (bound=${MAX_BUSINESS_LINES}+1) is refused — never COMPLETED — and the ` +
      'refusal is not merely an authority/qualification-window artifact (see AuthorityExpiryFamily)',
      provesBound,
      `http=${probe.status} accepted=${accepted} code=${directCode} reason=${effectiveReason} ` +
      `authorityExpiryFamily=${isAuthorityExpiryFamily} durationMs=${S[`${keyPrefix}PostDurationMs`]} ` +
      `elapsedSinceQualificationMs=${S[`${keyPrefix}ElapsedSinceQualificationMs`]}`,
    )
    S[`${keyPrefix}Run`] = provesBound ? 'PASS' : 'FAIL'
  } finally {
    await stopServer()
  }
}

// R9 restructure: the two-point slope (primary walk duration vs. mid-tier walk duration) used to be
// computed HERE, in-process, because all three arms ran sequentially in the same process and could read
// each other's S fields directly. They no longer can — see the "R9 restructure: one arm per process"
// block comment above S6A_ARM. Each arm now only ever knows its OWN duration; the slope is reassembled
// downstream, from job outputs, by scripts/ops/stock-preparation-e2e-compute-scale-slope.mjs (invoked by
// the workflow's `scale-slope` job) — never fabricated here from a single arm's partial view.

// ── negative arm helper (exported for the workflow's separate negative-control job) ───────────────────
export async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // Evidence that is true regardless of which arm this process is (R9 restructure — see the block
  // comment above S6A_ARM). s6aBoundMaxBusinessLines and s6aPrimaryRowCount are compile-time constants of
  // THIS file, reported here rather than re-derived downstream — the scale-slope aggregator job reads
  // them off the primary arm's own job output instead of re-requiring product code, so there is exactly
  // ONE place that knows what the product's declared bound is and what the primary walk's row count is.
  S.s6aArm = S6A_ARM
  S.s6aBoundMaxBusinessLines = MAX_BUSINESS_LINES
  S.s6aPrimaryRowCount = DEFAULT_S6A_ROW_COUNT

  if (S6A_ARM === 'primary') {
    // Phases 1-3 run inside their own try/catch for the SAME reason Phase 4 already had one: an unexpected
    // throw here (including from stopServer()'s own port-free assertion — see the block comment above
    // startServer()/stopServer()) must not skip the evidence write at the bottom of this function. A red
    // job with NO summary.txt/checks.json artifact at all is strictly worse than one that at least names
    // which phase failed and why — `must()` below records it as a failed check so `overallPass` still
    // reflects it, and CHECKS already accumulated by any phase that DID complete is preserved, not lost.
    try {
      // Phase 1: flag-OFF arm.
      await runFlagArm(undefined, false, 'flagOff')

      // Phase 2: exact-match arms — '1' and 'yes' must NOT enable the route.
      await runFlagArm('1', false, 'exactMatch1')
      await runFlagArm('yes', false, 'exactMatchYes')

      // Phase 2b: normalization arms — 'TRUE', ' true ', 'True' MUST enable the route (they normalise to
      // 'true' under trim+lowercase). Unlike phase 2's arms, these actually distinguish a strict
      // `=== 'true'` comparison from the real normalising one — see the block comment above
      // runFlagNormalizationArm().
      await runFlagNormalizationArm('TRUE', 'normTrueUpper')
      await runFlagNormalizationArm(' true ', 'normTrueSpaced')
      await runFlagNormalizationArm('True', 'normTrueTitle')

      // Phase 3: existing chain (T4 extended smoke) against a fresh flag-OFF server.
      await startServer({}, 'existing-chain')
      try {
        const token = await getDevToken()
        await runExistingChain(token)
      } finally {
        await stopServer()
      }
    } catch (error) {
      must('phases 1-3 (flag-gate arms + existing chain) completed without an unexpected harness error',
        false, String(error && error.message || error))
      await stopServer().catch(() => {})
    }

    // Phase 4: S6-A real flag-ON attempt (best-effort; every failure point reports NOT_RUN honestly).
    try {
      await attemptS6ARealRun()
    } catch (error) {
      S.s6aFlagOnRun = S.s6aFlagOnRun || 'NOT_RUN'
      S.s6aFlagOnReason = S.s6aFlagOnReason || 'UNEXPECTED_ERROR'
      must('S6-A flag-ON real run attempted', false, String(error && error.message || error))
      // .catch(), not a bare await: stopServer() can itself throw (its own port-free assertion — see the
      // block comment above startServer()/stopServer()), and a throw HERE would escape this catch and skip
      // the evidence write below entirely, which is exactly the failure mode this whole block exists to
      // avoid.
      await stopServer().catch(() => {})
    }
  }

  // Phase 5 (R9, restructured onto separate jobs — see the block comment above S6A_ARM): the mid-tier
  // calibration walk and the rejection arm each provision their OWN ACTIVE binding, and this whole
  // process can only ever be ONE arm, so at most one of the three branches below ever does real work.
  S.s6aScaleRequested = String(S6A_SCALE_REQUESTED)
  S.s6aScaleRowCount = S6A_ROW_COUNT
  if (S6A_ARM === 'midtier') {
    if (!S6A_SCALE_REQUESTED) {
      // Unlike the pre-restructure single-process design, this branch being REACHED AT ALL means the
      // scale-midtier job ran — and that job's own workflow-level `if:` gate exists SPECIFICALLY to keep
      // it from running unless scale was requested. Reaching here with scale not requested therefore
      // means that gate did not do its job (or someone re-ran/dispatched this job directly) — a silent
      // NOT_RUN here would be exactly the "skipped job reported as a pass" failure mode this whole
      // restructure must avoid, just arriving through a different door. This is a hard FAIL, not a
      // declined-optional-work NOT_RUN — see negative-control.mjs's own `CHECKS.length === 0` guard for
      // the same principle applied to an empty-CHECKS harness.
      S.s6aMidTierRun = 'NOT_RUN'
      S.s6aMidTierReason = 'SCALE_NOT_REQUESTED'
      must('S6-A mid-tier scale leg: this dedicated job ran but E2E_S6A_ROW_COUNT does not request scale '
        + '(the workflow-level job gate should have skipped this job entirely)', false, `rowCount=${S6A_ROW_COUNT}`)
    } else if (!RUNTIME_DB_ROLE || !RUNTIME_DB_URL || !PROVISIONING_DB_ROLE || !PROVISIONING_DB_URL) {
      // Same precondition attemptS6ARealRun already guards on — the workflow always provides these, so
      // seeing them missing here is itself noteworthy, not a normal "nothing to do" path, hence must().
      S.s6aMidTierRun = 'NOT_RUN'
      S.s6aMidTierReason = 'RUNTIME_DB_ENV_MISSING'
      must('S6-A mid-tier scale leg attempted', false, 'runtime/provisioning DB env not provided by workflow')
    } else {
      // This job's database is fresh — it never ran attemptS6ARealRun(), which is where this preflight
      // used to run (once per dispatch, ahead of the primary walk). A mistyped column here would
      // otherwise surface later as a database-observable FAIL indistinguishable from a real defect — see
      // assertS6AObservabilityQueriesResolve()'s own comment.
      await assertS6AObservabilityQueriesResolve()
      try {
        await runS6AMidTierScaleWalk()
      } catch (error) {
        S.s6aMidTierRun = S.s6aMidTierRun || 'NOT_RUN'
        S.s6aMidTierReason = S.s6aMidTierReason || 'UNEXPECTED_ERROR'
        must('S6-A mid-tier scale walk attempted', false, String(error && error.message || error))
        await stopServer().catch(() => {})
      }
    }
  } else if (S6A_ARM === 'rejection') {
    if (!S6A_SCALE_REQUESTED) {
      // Same hard-FAIL discipline as the mid-tier branch above — see its comment.
      S.s6aRejectionRun = 'NOT_RUN'
      S.s6aRejectionReason = 'SCALE_NOT_REQUESTED'
      must('S6-A rejection arm: this dedicated job ran but E2E_S6A_ROW_COUNT does not request scale '
        + '(the workflow-level job gate should have skipped this job entirely)', false, `rowCount=${S6A_ROW_COUNT}`)
    } else if (!RUNTIME_DB_ROLE || !RUNTIME_DB_URL || !PROVISIONING_DB_ROLE || !PROVISIONING_DB_URL) {
      S.s6aRejectionRun = 'NOT_RUN'
      S.s6aRejectionReason = 'RUNTIME_DB_ENV_MISSING'
      must('S6-A rejection arm attempted', false, 'runtime/provisioning DB env not provided by workflow')
    } else {
      try {
        await runS6ARejectionArm()
      } catch (error) {
        S.s6aRejectionRun = S.s6aRejectionRun || 'NOT_RUN'
        S.s6aRejectionReason = S.s6aRejectionReason || 'UNEXPECTED_ERROR'
        must('S6-A rejection arm attempted', false, String(error && error.message || error))
        await stopServer().catch(() => {})
      }
    }
  } else {
    // S6A_ARM === 'primary': the mid-tier walk and rejection arm no longer run in THIS process (see the
    // block comment above S6A_ARM) — they are the scale-midtier/scale-rejection jobs' job now, regardless
    // of whether scale was requested for this dispatch. The REASON differs by whether scale was actually
    // requested, so this never reads as "scale was not requested" when it was: SCALE_NOT_REQUESTED
    // reproduces the exact wording this file used before this restructure (default-dispatch parity), and
    // RUNS_IN_DEDICATED_JOB is the new, honest answer for a scale dispatch, whose actual mid-tier/
    // rejection evidence lives in the scale-midtier/scale-rejection jobs' own summary.txt instead.
    const reason = S6A_SCALE_REQUESTED ? 'RUNS_IN_DEDICATED_JOB' : 'SCALE_NOT_REQUESTED'
    S.s6aMidTierRun = 'NOT_RUN'
    S.s6aMidTierReason = reason
    S.s6aRejectionRun = 'NOT_RUN'
    S.s6aRejectionReason = reason
  }

  // Overall PASS requires every check that ran to have passed — including the S6-A real-run attempt.
  // A S6-A step that legitimately could not proceed is recorded as NOT_RUN in the result block (never
  // as PASS), but the `must()` that reports it still counts toward the job's own conclusion: this
  // script does not manufacture a green job out of an incomplete real-run attempt. The values-free
  // result block below is the durable evidence regardless of which way the exit code goes.
  const anyFail = CHECKS.some((c) => !c.ok)
  S.overallPass = !anyFail ? 'PASS' : 'FAIL'

  const lines = [SUMMARY_HEADER]
  for (const [key, value] of Object.entries(S)) lines.push(`${key}=${value}`)
  const block = lines.join('\n')
  process.stdout.write(`${block}\n`)
  fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), `${block}\n`)
  fs.writeFileSync(path.join(OUT_DIR, 'checks.json'), JSON.stringify(CHECKS, null, 2))
  process.exitCode = anyFail ? 1 : 0
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (invokedDirectly) {
  main().catch(async (error) => {
    process.stderr.write(`[e2e] fatal: ${error && error.stack ? error.stack : error}\n`)
    await stopServer().catch(() => {})
    process.exitCode = 1
  })
}
