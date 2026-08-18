#!/usr/bin/env node
'use strict'

// Stock Preparation LAB-0 host inventory — DRAFT (non-mutating, values-free).
//
// STATUS: DRAFT. Not wired into any workflow, not referenced by any runbook,
// and not authorized to be run against a customer machine. It exists so the
// LAB-0 reply that #4708 and #4695 currently ask a human to hand-assemble can
// be produced by a script instead.
//
// WHY THIS EXISTS
// ---------------
// #4708 "Phase LAB-0: inventory only" and #4695's PostgreSQL readiness lane
// both stop the whole delivery path on a values-free block that an operator
// types by hand:
//
//   #4695 six-field reply (issue comment 5161121847):
//     metasheetTestRuntimeAvailable / postgresServiceAvailable /
//     postgresMajorVersion / canCreateIsolatedTestDatabase /
//     canCreateSelectOnlyTestPrincipal / factsProvider
//
// Every round-trip of that block costs a full owner<->operator cycle, and the
// 2026-08-03 reply left two of the six as UNKNOWN — which cost another cycle
// for facts a read-only catalog query answers in milliseconds. This tool emits
// exactly that block, plus the LAB-0 environment facts around it, from
// read-only probes.
//
// WHAT IT MUST NEVER DO (enforced by review + the sibling contract test)
// ---------------------------------------------------------------------
//   * no install, download, package fetch, or dependency command;
//   * no database creation, role/principal creation, GRANT, or migration;
//   * no deploy, service start/stop/restart, or PM2 call;
//   * no feature-flag read-modify-write of any kind;
//   * no business-row read — the only SQL executed is one catalog SELECT
//     against pg_roles/current_setting, and it is the ONLY SQL string in the
//     file;
//   * no write of any kind beyond stdout: no file is created, appended to, or
//     removed, and no environment variable is exported.
//
// VALUES-FREE DISCIPLINE
// ----------------------
// Every emitted field is a member of a closed token set declared in TOKEN
// below (or the operator-supplied GitHub handle that #4695's template asks
// for by name, shape-validated before it is echoed). Hostnames, ports,
// database names, role names, connection strings, paths, versions as free
// text, byte counts, and HTTP bodies are never emitted — a PostgreSQL server
// version becomes PG15/PG16/PG17/PG_OTHER, free disk becomes a class, and a
// health response becomes PASS/FAIL. formatReport() self-scans the composed
// report against the configured inputs before returning it, so a future edit
// that interpolates a URL into a field is caught rather than published.
//
// Style follows scripts/ops/stock-preparation-s6a-operator-preflight.mjs:
// pure exported helpers, an injectable probe surface so the contract test
// needs no host, and a fixed report shape.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// The complete closed token vocabulary. Nothing outside this set (plus a
// shape-validated GitHub handle for factsProvider) is ever written to stdout.
// ---------------------------------------------------------------------------
const TOKEN = Object.freeze({
  BLOCKED: 'BLOCKED',
  COMPLETE: 'COMPLETE',
  DISK_10_TO_40GIB: 'DISK_10_TO_40GIB',
  DISK_GE_40GIB: 'DISK_GE_40GIB',
  DISK_LT_10GIB: 'DISK_LT_10GIB',
  FAIL: 'FAIL',
  FALSE: 'false',
  INVALID_FORMAT: 'INVALID_FORMAT',
  MEM_GE_16GIB: 'MEM_GE_16GIB',
  MEM_LT_16GIB: 'MEM_LT_16GIB',
  NO: 'NO',
  NODE20: 'NODE20',
  NODE22: 'NODE22',
  NODE_OTHER: 'NODE_OTHER',
  OTHER: 'OTHER',
  PASS: 'PASS',
  PG15: 'PG15',
  PG16: 'PG16',
  PG17: 'PG17',
  PG_OTHER: 'PG_OTHER',
  UNKNOWN: 'UNKNOWN',
  UNSET: 'UNSET',
  YES: 'YES',
  ZERO: '0',
})

const CLOSED_TOKENS = Object.freeze(new Set(Object.values(TOKEN)))

// The exact field names, in the exact order, of #4695's requested reply
// (issue comment 5161121847). Pinned by the contract test so a rename here
// cannot silently produce a block the issue will reject.
const SIX_FIELD_ORDER = Object.freeze([
  'metasheetTestRuntimeAvailable',
  'postgresServiceAvailable',
  'postgresMajorVersion',
  'canCreateIsolatedTestDatabase',
  'canCreateSelectOnlyTestPrincipal',
  'factsProvider',
])

// The ONE SQL statement this tool may execute. Read-only catalog access:
// current_setting() is a function call, pg_roles is a system view, and the
// predicate is the current session's own role. It reads no business relation
// and mutates nothing. Kept as a single exported constant so the contract
// test can assert it is the only SQL in the file and that it starts SELECT.
const CATALOG_READ_SQL =
  'SELECT current_setting(\'server_version_num\') AS server_version_num, '
  + '(rolcreatedb OR rolsuper) AS can_create_database, '
  + '(rolcreaterole OR rolsuper) AS can_create_role '
  + 'FROM pg_roles WHERE rolname = current_user'

const GIB = 1024 * 1024 * 1024
const DISK_HIGH_WATER_BYTES = 40 * GIB
const DISK_LOW_WATER_BYTES = 10 * GIB
const MEMORY_WATER_BYTES = 16 * GIB

const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8900/api/health'
const DEFAULT_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// Pure classifiers. Each maps a raw observation to a closed token; none of
// them can return an unregistered string.
// ---------------------------------------------------------------------------
function classifyNodeMajor(rawMajor) {
  const major = Number.parseInt(String(rawMajor ?? ''), 10)
  if (!Number.isInteger(major)) return TOKEN.UNKNOWN
  if (major === 20) return TOKEN.NODE20
  if (major === 22) return TOKEN.NODE22
  return TOKEN.NODE_OTHER
}

// PostgreSQL server_version_num is major * 10000 + minor for major >= 10.
function classifyPostgresMajor(rawServerVersionNum) {
  const num = Number.parseInt(String(rawServerVersionNum ?? ''), 10)
  if (!Number.isInteger(num) || num <= 0) return TOKEN.UNKNOWN
  const major = Math.floor(num / 10000)
  if (major === 15) return TOKEN.PG15
  if (major === 16) return TOKEN.PG16
  if (major === 17) return TOKEN.PG17
  return TOKEN.PG_OTHER
}

// The six-field template asks for postgresMajorVersion as a bare number, so
// the version class is projected back onto the closed set 15|16|17|OTHER.
function postgresMajorField(versionClass) {
  if (versionClass === TOKEN.PG15) return '15'
  if (versionClass === TOKEN.PG16) return '16'
  if (versionClass === TOKEN.PG17) return '17'
  if (versionClass === TOKEN.PG_OTHER) return TOKEN.OTHER
  return TOKEN.UNKNOWN
}

function classifyDiskFree(freeBytes) {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return TOKEN.UNKNOWN
  if (freeBytes >= DISK_HIGH_WATER_BYTES) return TOKEN.DISK_GE_40GIB
  if (freeBytes >= DISK_LOW_WATER_BYTES) return TOKEN.DISK_10_TO_40GIB
  return TOKEN.DISK_LT_10GIB
}

function classifyMemory(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return TOKEN.UNKNOWN
  return bytes >= MEMORY_WATER_BYTES ? TOKEN.MEM_GE_16GIB : TOKEN.MEM_LT_16GIB
}

// #4695's template names factsProvider as a GitHub handle, so a handle is the
// one non-token value this tool may echo. Anything that is not handle-shaped
// is refused rather than printed — an operator who pastes a hostname or an
// email address into the flag gets INVALID_FORMAT, not a leak.
function classifyFactsProvider(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') return TOKEN.UNSET
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(bare)) {
    return TOKEN.INVALID_FORMAT
  }
  return `@${bare}`
}

function yesNo(value) {
  if (value === true) return TOKEN.YES
  if (value === false) return TOKEN.NO
  return TOKEN.UNKNOWN
}

function passFail(value) {
  if (value === true) return TOKEN.PASS
  if (value === false) return TOKEN.FAIL
  return TOKEN.UNKNOWN
}

// ---------------------------------------------------------------------------
// Default probes. Every one is read-only; each returns a plain observation and
// classification happens above, so a probe can never invent a token.
// ---------------------------------------------------------------------------
function probeNodeMajor() {
  return process.versions.node.split('.')[0]
}

// Windows PowerShell 5.1 and PowerShell 7 are separate executables and #4708
// asks about both. `$PSVersionTable.PSVersion.Major` is a read of an
// in-process variable; -NoProfile prevents any profile script from running.
function probePowerShellMajor(executable) {
  try {
    const result = spawnSync(
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, windowsHide: true },
    )
    if (result.error || result.status !== 0) return null
    return Number.parseInt(String(result.stdout).trim(), 10)
  } catch {
    return null
  }
}

// TCP connect + immediate destroy. No bytes are sent, so this cannot reach a
// protocol handler, authenticate, or leave a session behind.
function probeTcpReachable(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // best effort
      }
      resolve(value)
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// Loads `pg` if the host already has it (a deployed package does). Never
// installs it — an absent driver is reported as a fact, not repaired.
function loadPgClient() {
  try {
    const mod = require('pg')
    return mod && mod.Client ? mod.Client : null
  } catch {
    return null
  }
}

async function probePostgresCatalog(connectionString, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const Client = loadPgClient()
  if (!Client) return { driverAvailable: false }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  })
  try {
    await client.connect()
    const result = await client.query(CATALOG_READ_SQL)
    const row = result && result.rows && result.rows[0]
    if (!row) return { connected: true, driverAvailable: true }
    return {
      canCreateDatabase: row.can_create_database === true,
      canCreateRole: row.can_create_role === true,
      connected: true,
      driverAvailable: true,
      serverVersionNum: row.server_version_num,
    }
  } catch {
    return { connected: false, driverAvailable: true }
  } finally {
    try {
      await client.end()
    } catch {
      // best effort
    }
  }
}

// Unauthenticated GET of the public health route. The body is never parsed,
// stored, or echoed — only "did a 2xx come back".
async function probeHealth(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.status >= 200 && response.status < 300
  } catch {
    return null
  }
}

function probeDiskFreeBytes(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

function probeMemory() {
  return { freeBytes: os.freemem(), totalBytes: os.totalmem() }
}

const DEFAULT_PROBES = Object.freeze({
  diskFreeBytes: probeDiskFreeBytes,
  health: probeHealth,
  memory: probeMemory,
  nodeMajor: probeNodeMajor,
  postgresCatalog: probePostgresCatalog,
  powerShellMajor: probePowerShellMajor,
  tcpReachable: probeTcpReachable,
})

// ---------------------------------------------------------------------------
// Configuration. Inputs arrive as environment variables and are NEVER echoed;
// only whether they were supplied ever reaches the report indirectly, through
// the resulting UNKNOWN/determinate token.
// ---------------------------------------------------------------------------
const ENV_VAR = Object.freeze({
  diskPath: 'LAB0_DISK_PATH',
  factsProvider: 'LAB0_FACTS_PROVIDER',
  healthUrl: 'LAB0_HEALTH_URL',
  postgresUrl: 'LAB0_POSTGRES_URL',
  probeHealth: 'LAB0_PROBE_HEALTH',
  probePowerShell: 'LAB0_PROBE_POWERSHELL',
})

function readConfig(env) {
  return Object.freeze({
    diskPath: env[ENV_VAR.diskPath] || path.parse(process.cwd()).root || process.cwd(),
    factsProviderRaw: env[ENV_VAR.factsProvider] || '',
    healthProbeEnabled: env[ENV_VAR.probeHealth] !== '0',
    healthUrl: env[ENV_VAR.healthUrl] || DEFAULT_HEALTH_URL,
    postgresUrl: env[ENV_VAR.postgresUrl] || '',
    powerShellProbeEnabled: env[ENV_VAR.probePowerShell] !== '0',
  })
}

// A connection string is parsed only to obtain a host/port for the TCP probe.
// Neither is returned to the caller and neither is ever emitted.
function tcpTargetFromPostgresUrl(connectionString) {
  try {
    const parsed = new URL(connectionString)
    const port = Number.parseInt(parsed.port || '5432', 10)
    const host = parsed.hostname
    if (!host || !Number.isInteger(port)) return null
    return { host, port }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------
async function runInventory({ env = process.env, probes = DEFAULT_PROBES } = {}) {
  const config = readConfig(env)
  const p = { ...DEFAULT_PROBES, ...probes }

  const nodeClass = classifyNodeMajor(p.nodeMajor())

  let windowsPowerShellMajor = null
  let pwshMajor = null
  if (config.powerShellProbeEnabled) {
    windowsPowerShellMajor = p.powerShellMajor('powershell')
    pwshMajor = p.powerShellMajor('pwsh')
  }

  let postgresReachable = null
  let postgres = { driverAvailable: false }
  if (config.postgresUrl) {
    const target = tcpTargetFromPostgresUrl(config.postgresUrl)
    postgresReachable = target ? await p.tcpReachable(target.host, target.port) : null
    postgres = await p.postgresCatalog(config.postgresUrl)
    // A successful authenticated catalog read is stronger evidence of
    // reachability than a bare TCP connect, so it can only upgrade the answer.
    if (postgres.connected === true) postgresReachable = true
  }

  const postgresVersionClass = postgres.connected === true
    ? classifyPostgresMajor(postgres.serverVersionNum)
    : TOKEN.UNKNOWN

  const isolatedDatabaseCapability = postgres.connected === true
    && typeof postgres.canCreateDatabase === 'boolean'
    ? postgres.canCreateDatabase
    : null
  const selectOnlyPrincipalCapability = postgres.connected === true
    && typeof postgres.canCreateRole === 'boolean'
    ? postgres.canCreateRole
    : null

  const runtimeHealthy = config.healthProbeEnabled ? await p.health(config.healthUrl) : null

  const diskFreeClass = classifyDiskFree(p.diskFreeBytes(config.diskPath))
  const memory = p.memory()
  const memoryTotalClass = classifyMemory(memory.totalBytes)
  const memoryFreeClass = classifyMemory(memory.freeBytes)

  const fields = Object.freeze({
    canCreateIsolatedTestDatabase: yesNo(isolatedDatabaseCapability),
    canCreateSelectOnlyTestPrincipal: yesNo(selectOnlyPrincipalCapability),
    diskFreeClass,
    externalWrite: TOKEN.FALSE,
    factsProvider: classifyFactsProvider(config.factsProviderRaw),
    freeDiskAtLeast40GiB: diskFreeClass === TOKEN.UNKNOWN
      ? TOKEN.UNKNOWN
      : yesNo(diskFreeClass === TOKEN.DISK_GE_40GIB),
    freeMemoryAtLeast16GiB: memoryFreeClass === TOKEN.UNKNOWN
      ? TOKEN.UNKNOWN
      : yesNo(memoryFreeClass === TOKEN.MEM_GE_16GIB),
    memoryTotalClass,
    metasheetRuntimeHealth: passFail(runtimeHealthy),
    node20Available: yesNo(nodeClass === TOKEN.NODE20),
    nodeMajorClass: nodeClass,
    postgresDriverAvailable: yesNo(postgres.driverAvailable === true),
    postgresServiceReachable: yesNo(postgresReachable),
    postgresVersionClass,
    powershell51Available: windowsPowerShellMajor === null
      ? TOKEN.UNKNOWN
      : yesNo(windowsPowerShellMajor === 5),
    pwsh7Available: pwshMajor === null ? TOKEN.UNKNOWN : yesNo(pwshMajor >= 7),
    selectOnlyPrincipalCapability: passFail(selectOnlyPrincipalCapability),
    isolatedDatabaseCapability: passFail(isolatedDatabaseCapability),
  })

  const sixField = Object.freeze({
    canCreateIsolatedTestDatabase: fields.canCreateIsolatedTestDatabase,
    canCreateSelectOnlyTestPrincipal: fields.canCreateSelectOnlyTestPrincipal,
    factsProvider: fields.factsProvider,
    metasheetTestRuntimeAvailable: fields.metasheetRuntimeHealth === TOKEN.PASS
      ? TOKEN.YES
      : fields.metasheetRuntimeHealth === TOKEN.FAIL
        ? TOKEN.NO
        : TOKEN.UNKNOWN,
    postgresMajorVersion: postgresMajorField(postgresVersionClass),
    postgresServiceAvailable: fields.postgresServiceReachable,
  })

  // LAB-0 is COMPLETE only when every fact is determinate. An UNKNOWN is what
  // burned the 2026-08-03 round-trip, so it is a blocking outcome here, not a
  // footnote.
  const blocking = SIX_FIELD_ORDER
    .filter((name) => name !== 'factsProvider')
    .some((name) => sixField[name] === TOKEN.UNKNOWN)
  const providerMissing = sixField.factsProvider === TOKEN.UNSET
    || sixField.factsProvider === TOKEN.INVALID_FORMAT
  const lab0Status = blocking || providerMissing ? TOKEN.BLOCKED : TOKEN.COMPLETE

  return Object.freeze({
    config,
    exitCode: lab0Status === TOKEN.COMPLETE ? 0 : 1,
    fields,
    lab0Status,
    sixField,
  })
}

// ---------------------------------------------------------------------------
// Report composition + self-scan.
// ---------------------------------------------------------------------------
const HOST_FIELD_ORDER = Object.freeze([
  'nodeMajorClass',
  'node20Available',
  'powershell51Available',
  'pwsh7Available',
  'postgresDriverAvailable',
  'postgresServiceReachable',
  'postgresVersionClass',
  'isolatedDatabaseCapability',
  'selectOnlyPrincipalCapability',
  'metasheetRuntimeHealth',
  'diskFreeClass',
  'freeDiskAtLeast40GiB',
  'memoryTotalClass',
  'freeMemoryAtLeast16GiB',
  'externalWrite',
])

function assertClosedSet(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'factsProvider') continue
    if (!CLOSED_TOKENS.has(value)) {
      throw new Error(`LAB0_UNREGISTERED_TOKEN: ${name}`)
    }
  }
}

// Composed-output self-scan: nothing the operator configured may appear in the
// report. Cheap, and it converts "we were careful" into "it cannot ship".
function assertNoConfiguredInputLeaked(report, config) {
  const sentinels = [config.postgresUrl, config.healthUrl, config.diskPath]
  for (const sentinel of sentinels) {
    if (typeof sentinel !== 'string' || sentinel.length < 4) continue
    if (report.includes(sentinel)) {
      throw new Error('LAB0_INPUT_LEAKED_INTO_REPORT')
    }
  }
  return report
}

function formatReport(result) {
  assertClosedSet(result.fields)
  const lines = [
    '=== LAB-0 host inventory (DRAFT — non-mutating, values-free) ===',
    'inventoryTool=stock-preparation-lab0-inventory/v1-draft',
    'mutationsPerformed=0',
    'businessRowsRead=0',
  ]
  for (const name of HOST_FIELD_ORDER) {
    lines.push(`${name}=${result.fields[name]}`)
  }
  lines.push('')
  lines.push('=== #4695 six-field PostgreSQL readiness reply (paste verbatim) ===')
  for (const name of SIX_FIELD_ORDER) {
    lines.push(`${name}=${result.sixField[name]}`)
  }
  lines.push('')
  lines.push(`lab0Status=${result.lab0Status}`)
  return assertNoConfiguredInputLeaked(lines.join('\n'), result.config)
}

function buildOperatorGuidance() {
  const pad = (text) => `  ${text.padEnd(26, ' ')}`
  const cont = ' '.repeat(28)
  return [
    '=== How to run (values-free; nothing below installs, creates, or deploys) ===',
    'All inputs are environment variables and none of them is ever printed.',
    '',
    `${pad(ENV_VAR.postgresUrl)}connection string for the candidate PostgreSQL`,
    `${cont}service, authenticating as the account that would`,
    `${cont}later create the isolated database and the`,
    `${cont}SELECT-only principal. Unset -> the three`,
    `${cont}PostgreSQL fields report UNKNOWN.`,
    `${pad(ENV_VAR.healthUrl)}MetaSheet health route (default: the on-prem`,
    `${cont}template port on loopback).`,
    `${pad(ENV_VAR.diskPath)}filesystem to measure (default: the drive root).`,
    `${pad(ENV_VAR.factsProvider)}the GitHub handle #4695 asks for in factsProvider.`,
    `${pad(`${ENV_VAR.probeHealth}=0`)}skip the health probe (reports UNKNOWN).`,
    `${pad(`${ENV_VAR.probePowerShell}=0`)}skip the PowerShell probes (report UNKNOWN).`,
    '',
    'The only SQL this tool executes is one read-only catalog SELECT against',
    'pg_roles for the connected session\'s own role. It creates no database, no',
    'role, and no grant; those remain a later, separately authorized step.',
    '',
    'lab0Status=BLOCKED means at least one fact is still UNKNOWN (or factsProvider',
    'was not supplied) — report it as-is; do not fill a gap by hand.',
  ].join('\n')
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

async function main() {
  const result = await runInventory({ env: process.env })
  process.stdout.write(formatReport(result))
  process.stdout.write('\n\n')
  process.stdout.write(buildOperatorGuidance())
  process.stdout.write('\n')
  process.exitCode = result.exitCode
}

if (isMain) {
  await main()
}

export {
  CATALOG_READ_SQL,
  CLOSED_TOKENS,
  ENV_VAR,
  HOST_FIELD_ORDER,
  SIX_FIELD_ORDER,
  TOKEN,
  buildOperatorGuidance,
  classifyDiskFree,
  classifyFactsProvider,
  classifyMemory,
  classifyNodeMajor,
  classifyPostgresMajor,
  formatReport,
  postgresMajorField,
  runInventory,
}
