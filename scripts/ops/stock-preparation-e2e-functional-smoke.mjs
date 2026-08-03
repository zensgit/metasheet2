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

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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

function require_(relativePath) {
  return requireFromPlugin(path.join(REPO_ROOT, relativePath))
}

const SUMMARY_HEADER = 'STOCK_PREPARATION_E2E_FUNCTIONAL_SMOKE'
const S = {
  mode: 'functional_testing_synthetic_data',
  substituteForEntityAcceptance: false,
}
const CHECKS = []

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
export async function requestJson(pathname, { method = 'GET', body, token, accept = [200] } = {}) {
  const headers = { 'x-tenant-id': TENANT_ID }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
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
  try {
    proc.kill('SIGTERM')
    await Promise.race([once(proc, 'exit'), delay(8000)])
  } catch {
    // ignore
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGKILL')
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
  note(`server (${label}) stopped`)
  // Give the OS a beat to release the port before the next spawn.
  await delay(1500)
}

// ── auth ─────────────────────────────────────────────────────────────────────────────────────────────
export async function getDevToken() {
  const res = await fetch(
    `${BASE_URL}/api/auth/dev-token?userId=${encodeURIComponent(ADMIN_USER_ID)}&tenantId=${encodeURIComponent(TENANT_ID)}&roles=admin&expiresIn=2h`,
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
export async function s6aRunProbe(token, operationId) {
  return requestJson('/api/integration/internal/stock-preparation/sqlserver-sealed-snapshot/run', {
    method: 'POST',
    token,
    body: { operationId },
    accept: [200, 201, 404, 400, 403, 409, 422, 503],
  })
}

// NOTE on the DISABLED error code: plugin-integration-core only ADDS the S6-A route to the Express app
// (registerIntegrationRoutes, http-routes.cjs ~5003-5006) when services.stockPreparationSqlServerRuntime
// is truthy at plugin-construction time — i.e. only when the flag was already 'true' at boot. When the
// flag is off, the route is never mounted at all, so a request to it falls through to the framework's
// generic unmatched-route 404 (no JSON error envelope, no `error.code`) — it does NOT reach the
// `STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED` HttpRouteError inside the handler
// (http-routes.cjs ~4900-4911), because that handler is unreachable code under this wiring: the same
// truthy/falsy check gates both route registration and the handler's local runtime reference. This is
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

function buildBomPayload(index, salt) {
  const projectId = `s6a-e2e-${salt}`
  return {
    bomLevel: index === 0 ? 0 : 1,
    childDrawingNo: `E2E-CHILD-${index + 1}-${salt}`,
    childVersion: null,
    designQty: '1.5',
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

async function prepareSqlServerRelation(salt) {
  const rows = [0, 1, 2].map((index) => buildBomPayload(index, salt))
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
  payload nvarchar(4000) NOT NULL
);`)
      const request = dbPool.request()
      const values = []
      rows.forEach((rowPayload, index) => {
        const rowIdParam = `rowId${index}`
        const payloadParam = `payload${index}`
        request.input(rowIdParam, sql.Int, index + 1)
        request.input(payloadParam, sql.NVarChar(4000), canonicalText(rowPayload))
        values.push(`(@${rowIdParam}, 1, @${payloadParam})`)
      })
      await request.query(`INSERT INTO ${MSSQL_TABLE} (row_id, payload_version, payload) VALUES ${values.join(',')}`)
      await dbPool.request().batch(`GRANT SELECT ON OBJECT::${MSSQL_TABLE} TO [${MSSQL_READER_LOGIN}];`)
    } finally {
      await dbPool.close()
    }
  })
  return { rows, projectId: rows[0].projectId, snapshotBatchId: rows[0].snapshotBatchId }
}

async function registerExternalSystem(token, systemId) {
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
    method: 'POST', token, body, accept: [200, 201],
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
  const baseToken = await getDevToken()
  const registered = await registerExternalSystem(baseToken, systemId)
  const registeredOk = must('S6-A: external system registered', registered.ok, `http=${registered.status}`)
  S.s6aExternalSystemRegistered = registeredOk ? 'PASS' : 'FAIL'
  if (!registeredOk) {
    S.s6aFlagOnRun = 'NOT_RUN'
    S.s6aFlagOnReason = 'EXTERNAL_SYSTEM_REGISTRATION_FAILED'
    return
  }

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
      return
    }

    // mvp/ensure is idempotent per tenant/workspace — defensive re-provisioning of the underlying
    // multitable object/field templates the persist step needs (the existing-chain phase already ran
    // this once for the SAME tenant, but this phase can run standalone).
    await requestJson('/api/integration/stock-preparation/mvp/ensure', { method: 'POST', token, body: {}, accept: [200, 201] })

    const operationId = `s6a-e2e-op-${salt}`
    const firstRun = await s6aRunProbe(token, operationId)
    const firstData = firstRun.body?.data || {}
    S.s6aFirstRunHttp = firstRun.status
    S.s6aFirstRunMode = firstData.mode || '<unregistered>'
    S.s6aFirstRunStatus = firstData.status || '<unregistered>'
    S.s6aBusinessLineCount = Number.isInteger(firstData.businessLineCount) ? firstData.businessLineCount : -1
    S.s6aFirstRunExternalWrite = firstData.externalWrite === false ? 'false' : '<unregistered>'
    const firstOk = firstRun.ok && firstData.status === 'COMPLETED' && firstData.mode === 'internal_persist' &&
      firstData.externalWrite === false && firstData.businessLineCount === relation.rows.length
    must('S6-A: first run -> COMPLETED, internal_persist, externalWrite=false, businessLineCount matches',
      firstOk, `http=${firstRun.status} mode=${S.s6aFirstRunMode} status=${S.s6aFirstRunStatus} lines=${S.s6aBusinessLineCount}`)
    S.s6aFirstRun = firstOk ? 'PASS' : 'FAIL'
    if (!firstOk) {
      S.s6aReplayRun = 'NOT_RUN'
      return
    }

    const replay = await s6aRunProbe(token, operationId)
    const replayData = replay.body?.data || {}
    S.s6aReplayHttp = replay.status
    S.s6aReplayMode = replayData.mode || '<unregistered>'
    const replayOk = replay.ok && replayData.mode === 'internal_noop' && replayData.replay === true &&
      replayData.sourceReadCount === 1 && replayData.businessLineCount === relation.rows.length &&
      replayData.externalWrite === false
    must('S6-A: replay same operationId -> internal_noop, sourceReadCount=1, same businessLineCount',
      replayOk, `http=${replay.status} mode=${S.s6aReplayMode}`)
    S.s6aReplayRun = replayOk ? 'PASS' : 'FAIL'
    S.s6aFlagOnRun = (firstOk && replayOk) ? 'PASS' : 'FAIL'
  } finally {
    await stopServer()
  }
}

// ── negative arm helper (exported for the workflow's separate negative-control job) ───────────────────
export async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // Phase 1: flag-OFF arm.
  await runFlagArm(undefined, false, 'flagOff')

  // Phase 2: exact-match arms — '1' and 'yes' must NOT enable the route.
  await runFlagArm('1', false, 'exactMatch1')
  await runFlagArm('yes', false, 'exactMatchYes')

  // Phase 3: existing chain (T4 extended smoke) against a fresh flag-OFF server.
  await startServer({}, 'existing-chain')
  try {
    const token = await getDevToken()
    await runExistingChain(token)
  } finally {
    await stopServer()
  }

  // Phase 4: S6-A real flag-ON attempt (best-effort; every failure point reports NOT_RUN honestly).
  try {
    await attemptS6ARealRun()
  } catch (error) {
    S.s6aFlagOnRun = S.s6aFlagOnRun || 'NOT_RUN'
    S.s6aFlagOnReason = S.s6aFlagOnReason || 'UNEXPECTED_ERROR'
    must('S6-A flag-ON real run attempted', false, String(error && error.message || error))
    await stopServer()
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
