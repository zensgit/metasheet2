#!/usr/bin/env node
// YiDa L4 preflight: the pre-start server checks of the L3/L4 operator checklist ("开工前" part B,
// items 6-8) as ONE read-only, values-free command whose last line is a machine verdict.
//
// Run from the Windows on-prem deploy root (Windows PowerShell 5.1 is fine):
//
//   node scripts\ops\integration-yida-l4-preflight.mjs
//
// Why it exists: L4 (one-time YiDa local initialization) is irreversible. A backend that is not in
// production mode seals the four credentials under the PUBLIC built-in encryption defaults, and after
// a later key change the sealed slot can no longer be opened (there is no re-key path). The operator
// must therefore prove production mode, strong encryption material and a backup BEFORE L4.
//
// What it DOES (and nothing else):
//   - reads docker\app.env and checks whether a root app.env exists;
//   - runs `pm2 jlist` once, and only when pm2's RPC endpoint already exists (on Windows the
//     machine-level pipe \\.\pipe\rpc.sock, which `pm2 jlist` pings before it would launch a daemon)
//     and the pm2 home of this window is already set up (so pm2 creates no folder or file there);
//     see pm2Gate. So it never makes pm2 spawn a daemon;
//   - reads the last encrypted-store-probe line of the backend out log (pm2's pm_out_log_path, else
//     output\logs\metasheet-backend.out.log) and requires it to be newer than the backend's start.
//
// What it NEVER does: write a file, open a network connection (no http/https/net/dns/fetch), start,
// restart or stop anything, or call the backend. It never prints a value, part of a value, a length,
// a hash, a path or any pm2 output -- only check names, True/False, counts and fixed category words,
// on every path including errors.
//
// Exit codes: 0 = L4_PREFLIGHT=PASS, 1 = L4_PREFLIGHT=STOP <failing checks>, 2 = usage error.
//
// SENTINEL COPIES (deliberate). This file ships inside the on-prem package and runs with a bare
// `node`; importing the backend dist would load its logger/tracing module graph (winston, request
// and trace context) from the deploy root, and the YiDa sample list is a module-private const there.
// So the values below are copies, and scripts/ops/integration-yida-l4-preflight.test.mjs reads the
// backend TypeScript source text and turns red when any copy diverges:
//   DEFAULT_ENCRYPTION_KEY / DEFAULT_ENCRYPTION_SALT  <- packages/core-backend/src/security/encrypted-secrets.ts
//   DEV_FALLBACK_JWT_SECRET / INSECURE_JWT_SECRET_VALUES <- packages/core-backend/src/security/auth-runtime-config.ts
//   probe log phrases                                 <- packages/core-backend/src/security/encrypted-store-probe.ts
//   switch names                                      <- packages/core-backend/src/index.ts
//   app name / out log path                           <- ecosystem.config.cjs
//   SAMPLE_ENCRYPTION_VALUES                          <- the docs named per value below; when the backend
//     carries its own list (yida-initialization-runtime.ts, PR #6691) the test also requires every
//     backend sample to be in this list, so this operator-side check is never weaker than the backend.

import { closeSync, existsSync, fstatSync, openSync, readSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BACKEND_APP_NAME = 'metasheet-backend'
export const APP_ENV_RELATIVE_PARTS = Object.freeze(['docker', 'app.env'])
export const ROOT_APP_ENV_NAME = 'app.env'
export const BACKEND_OUT_LOG_RELATIVE_PARTS = Object.freeze(['output', 'logs', 'metasheet-backend.out.log'])

export const DEFAULT_ENCRYPTION_KEY = 'default-key-change-in-production'
export const DEFAULT_ENCRYPTION_SALT = 'default-salt-change-in-production'
export const DEV_FALLBACK_JWT_SECRET = 'fallback-development-secret-change-in-production'
export const INSECURE_JWT_SECRET_VALUES = Object.freeze([
  'test',
  'dev-secret',
  'dev-secret-key',
  'fallback-development-secret-change-in-production',
  'change-me',
  'change-me-in-production',
  'your-secret-key-here',
  'your-dev-secret-key-here',
])

// Documented sample values for ENCRYPTION_KEY / ENCRYPTION_SALT, lower case, compared ignoring case.
// Any other value wrapped in <...> is an unfilled placeholder too (see isPlaceholderOrSample).
export const SAMPLE_ENCRYPTION_VALUE_SOURCES = Object.freeze([
  Object.freeze({ value: '<openssl rand -hex 32>', docs: Object.freeze(['docs/deployment/multitable-windows-onprem-easy-start-20260319.md']) }),
  Object.freeze({ value: '<openssl rand -hex 32, generated separately>', docs: Object.freeze(['docs/deployment/multitable-windows-onprem-easy-start-20260319.md']) }),
  Object.freeze({ value: 'your-32-byte-key-here', docs: Object.freeze(['docs/CONFIG_SECRET_MANAGEMENT_REPORT.md']) }),
  Object.freeze({ value: 'your-salt-here', docs: Object.freeze(['docs/CONFIG_SECRET_MANAGEMENT_REPORT.md']) }),
  Object.freeze({
    value: 'abcdef0123456789abcdef0123456789',
    docs: Object.freeze([
      'docs/development/ops-encryption-material-preflight-design-20260914.md',
      'docs/development/ops-encryption-material-preflight-verification-20260914.md',
    ]),
  }),
  Object.freeze({ value: '0123456789abcdef0123456789abcdef', docs: Object.freeze(['docs/development/ops-encryption-material-preflight-verification-20260914.md']) }),
])
export const SAMPLE_ENCRYPTION_VALUES = Object.freeze(SAMPLE_ENCRYPTION_VALUE_SOURCES.map(entry => entry.value))

export const SEND_SWITCH_FLAG = 'INTEGRATION_YIDA_OWNER_SEND_ENABLED'
export const CONNECTION_TEST_SWITCH_FLAG = 'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED'

export const PROBE_SUMMARY_PATTERN = /Encrypted store probe: \d+ encrypted/
export const PROBE_UNDECRYPTABLE_PATTERN = /; (\d+) undecryptable with the current material/
export const PROBE_UNREADABLE_PATTERN = /; (\d+) store field\(s\) unreadable/
export const PROBE_MATERIAL_UNAVAILABLE_PHRASE = 'not trial-decrypted (encryption material unavailable)'
export const PROBE_COULD_NOT_RUN_PHRASE = 'Encrypted store probe could not run'

export const MIN_RECOMMENDED_MATERIAL_LENGTH = 32
const PM2_TIMEOUT_MS = 60_000
const PM2_MAX_BUFFER = 256 * 1024 * 1024
const LOG_CHUNK_BYTES = 1024 * 1024
const ENCRYPTION_NAMES = Object.freeze(['ENCRYPTION_KEY', 'ENCRYPTION_SALT'])

const USAGE = [
  'Usage: node scripts\\ops\\integration-yida-l4-preflight.mjs',
  '',
  'Run from the deploy root. Read-only, values-free. Last line: L4_PREFLIGHT=PASS or',
  'L4_PREFLIGHT=STOP <failing checks>. Exit 0 = PASS, 1 = STOP, 2 = usage error.',
].join('\n')

const tf = value => (value ? 'True' : 'False')
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// ── docker\app.env ──────────────────────────────────────────────────────────────────────────────

/**
 * Same reading as the checklist block (Get-AppEnvValue): non-comment lines whose trimmed text starts
 * with `NAME\s*=`; the LAST match's value, trimmed, with one pair of matching outer quotes removed.
 * `count` is the number of matching lines. The backend's loader (ecosystem.config.cjs) reads the same
 * shape, so with exactly one line both agree on the value byte for byte.
 */
export function readAppEnvEntry(text, name) {
  let count = 0
  let value = ''
  const prefix = new RegExp(`^${name}\\s*=`)
  for (const line of text.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !prefix.test(trimmed)) continue
    count += 1
    let candidate = trimmed.slice(trimmed.indexOf('=') + 1).trim()
    if (candidate.length >= 2 && ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'")))) {
      candidate = candidate.slice(1, -1)
    }
    value = candidate
  }
  return { count, value }
}

/** Returns { status: 'present' | 'missing' | 'unreadable' | 'unsupported_encoding', text }. */
export function readAppEnvFile(root) {
  const file = path.join(root, ...APP_ENV_RELATIVE_PARTS)
  try {
    if (!existsSync(file)) return { status: 'missing', text: '' }
    const bytes = readFileSync(file)
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
      return { status: 'unsupported_encoding', text: '' }
    }
    // A UTF-8 BOM needs no handling: it decodes to U+FEFF, which String.prototype.trim removes in
    // readAppEnvEntry exactly as the backend loader's line.trim() does (ecosystem.config.cjs).
    return { status: 'present', text: bytes.toString('utf8') }
  } catch {
    return { status: 'unreadable', text: '' }
  }
}

// ── material rules ──────────────────────────────────────────────────────────────────────────────

export function isPlaceholderOrSample(value) {
  const trimmed = String(value).trim()
  if (/^<[\s\S]*>$/u.test(trimmed)) return true
  return SAMPLE_ENCRYPTION_VALUES.includes(trimmed.toLowerCase())
}

/** Either built-in default (so a swapped pair is caught too), ignoring case and surrounding space. */
export function isBuiltInDefault(value) {
  const lowered = String(value).trim().toLowerCase()
  return lowered === DEFAULT_ENCRYPTION_KEY.toLowerCase() || lowered === DEFAULT_ENCRYPTION_SALT.toLowerCase()
}

/** Material is sealed byte for byte: surrounding whitespace or any control character is a stop. */
export function hasSurroundingWhitespaceOrControl(value) {
  const text = String(value)
  if (text !== text.trim()) return true
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

export function characterCount(value) {
  return Array.from(String(value).trim()).length
}

// ── pm2 ─────────────────────────────────────────────────────────────────────────────────────────

/** pm2's own home resolution (pm2/paths.js getDefaultPM2Home). */
export function resolvePm2Home(env = process.env) {
  if (env.PM2_HOME) return env.PM2_HOME
  if (env.HOME && !env.HOMEPATH) return path.resolve(env.HOME, '.pm2')
  if (env.HOME || env.HOMEPATH) return path.resolve(env.HOMEDRIVE || '', env.HOME || env.HOMEPATH, '.pm2')
  return path.resolve('/etc', '.pm2')
}

/**
 * pm2's RPC endpoint (pm2/paths.js): on Windows the machine-level pipe \\.\pipe\rpc.sock whatever
 * PM2_HOME is; elsewhere <PM2_HOME>/rpc.sock (or PM2_DAEMON_RPC_PORT, which paths.js also honours).
 */
export function pm2RpcEndpoint(env = process.env, platform = process.platform) {
  if (platform === 'win32' || platform === 'win64') return '\\\\.\\pipe\\rpc.sock'
  return env.PM2_DAEMON_RPC_PORT || path.join(resolvePm2Home(env), 'rpc.sock')
}

/**
 * `pm2 jlist` pings the RPC endpoint (pm2/lib/Client.js pingDaemon) and LAUNCHES a daemon when nothing
 * answers; its client constructor also creates logs/, pids/, modules/ and module_conf.json in PM2_HOME
 * when they are missing (Client.js initFileStructure). So pm2 is run only when:
 *   - the endpoint exists: statSync succeeds or throws EBUSY (a busy pipe exists); ENOENT means no
 *     daemon (existsSync cannot be used: it reports a busy pipe as absent); any other error is treated
 *     as unreachable, never as present;
 *   - PM2_HOME already holds everything initFileStructure would create.
 * Returns a fixed category: 'ok' | 'daemon_not_found' | 'daemon_unreachable' | 'pm2_home_not_initialized'.
 */
export function pm2Gate(env = process.env, { rpcEndpoint, platform = process.platform } = {}) {
  const endpoint = rpcEndpoint ?? pm2RpcEndpoint(env, platform)
  try {
    statSync(endpoint)
  } catch (error) {
    if (error?.code === 'ENOENT') return 'daemon_not_found'
    if (error?.code !== 'EBUSY') return 'daemon_unreachable'
  }
  try {
    const home = resolvePm2Home(env)
    const isDir = rel => statSync(path.join(home, rel)).isDirectory()
    if (!isDir('logs') || !isDir('pids') || !isDir('modules') || !statSync(path.join(home, 'module_conf.json')).isFile()) {
      return 'pm2_home_not_initialized'
    }
  } catch {
    return 'pm2_home_not_initialized'
  }
  return 'ok'
}

export const PM2_HINTS = Object.freeze({
  daemon_not_found:
    'HINT no pm2 daemon is listening on this machine, so pm2 was not run (it would start a new one). Start nothing; report to the owner.',
  daemon_unreachable:
    'HINT the pm2 daemon endpoint exists but cannot be opened from this window. Run this command as the Windows user that started the backend.',
  pm2_home_not_initialized:
    'HINT the pm2 home of this window (PM2_HOME, default .pm2 in the user folder) is not set up, so pm2 was not run (it would create files there). ' +
    'If the backend runs under pm2-runtime, set PM2_HOME in this window to the home it was started with (for example the .pm2-runtime folder) and rerun.',
})

function windowsCmd() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
  if (systemRoot) {
    const candidate = path.join(systemRoot, 'System32', 'cmd.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'cmd.exe'
}

/**
 * Node 20 refuses to spawn a .cmd file without a shell (CVE-2024-27980). Prefer running pm2's own JS
 * entry with this node (no shell at all); only when that entry is absent go through cmd.exe with a
 * FIXED command line (no caller input is ever part of it).
 */
export function resolvePm2Invocation(root, { testStub, platform = process.platform } = {}) {
  if (testStub) return { source: 'test_stub', command: process.execPath, args: [testStub, 'jlist'], verbatim: false }
  const isWindows = platform === 'win32'
  const localShim = path.join(root, 'node_modules', '.bin', isWindows ? 'pm2.cmd' : 'pm2')
  const localEntry = path.join(root, 'node_modules', 'pm2', 'bin', 'pm2')
  if (existsSync(localShim)) {
    if (existsSync(localEntry)) return { source: 'local', command: process.execPath, args: [localEntry, 'jlist'], verbatim: false }
    if (isWindows) return { source: 'local', command: windowsCmd(), args: ['/d', '/s', '/c', '"node_modules\\.bin\\pm2.cmd jlist"'], verbatim: true }
    return { source: 'local', command: localShim, args: ['jlist'], verbatim: false }
  }
  if (isWindows) return { source: 'global', command: windowsCmd(), args: ['/d', '/s', '/c', '"pm2 jlist"'], verbatim: true }
  return { source: 'global', command: 'pm2', args: ['jlist'], verbatim: false }
}

/** Parses pm2 jlist stdout. Never returns or throws any part of it. */
export function parsePm2List(stdout) {
  const text = String(stdout ?? '').trim()
  const attempt = candidate => {
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch {
      return { ok: false }
    }
  }
  let parsed = attempt(text)
  if (!parsed.ok) {
    const lines = text.split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean)
    if (lines.length > 0) parsed = attempt(lines[lines.length - 1])
  }
  if (!parsed.ok) return { status: 'output_not_json', apps: null }
  if (!Array.isArray(parsed.value)) return { status: 'unexpected_shape', apps: null }
  return { status: 'ok', apps: parsed.value }
}

/**
 * Returns { source, status, app, entries }. status is a fixed category word; entries is how many pm2
 * entries are named metasheet-backend; app is that entry only when there is exactly one (more than one
 * is ambiguous and checked as a stop, never resolved by list order).
 */
export function readBackendFromPm2(root, { testStub, rpcEndpoint, env = process.env, timeoutMs = PM2_TIMEOUT_MS } = {}) {
  let invocation
  try {
    invocation = resolvePm2Invocation(root, { testStub })
  } catch {
    return { source: 'unknown', status: 'resolve_failed', app: null, entries: 0 }
  }
  const gate = pm2Gate(env, { rpcEndpoint })
  if (gate !== 'ok') return { source: invocation.source, status: gate, app: null, entries: 0 }
  const childEnv = { ...env }
  // PM2_DISCRETE_MODE makes the pm2 client write PM2_HOME/touch (Client.js initFileStructure).
  delete childEnv.PM2_DISCRETE_MODE
  let result
  try {
    result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      env: childEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: PM2_MAX_BUFFER,
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return { source: invocation.source, status: 'spawn_failed', app: null, entries: 0 }
  }
  if (result.error) {
    const code = result.error.code
    const status = code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOENT' ? 'not_found' : code === 'ENOBUFS' ? 'output_too_large' : 'spawn_failed'
    return { source: invocation.source, status, app: null, entries: 0 }
  }
  if (result.status !== 0) return { source: invocation.source, status: 'exit_nonzero', app: null, entries: 0 }
  const list = parsePm2List(result.stdout)
  if (list.status !== 'ok') return { source: invocation.source, status: list.status, app: null, entries: 0 }
  const matches = list.apps.filter(entry => isObject(entry) && entry.name === BACKEND_APP_NAME)
  return { source: invocation.source, status: 'ok', app: matches.length === 1 ? matches[0] : null, entries: matches.length }
}

/** Same comparison as attendance-onprem-start-pm2.ps1 ConvertTo-ComparablePath: full path, no trailing separator, case-folded on Windows. */
export function comparablePath(candidate, platform = process.platform) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return ''
  let full = path.resolve(candidate.trim())
  while (full.length > 1 && /[\\/]$/.test(full) && !/^[A-Za-z]:[\\/]$/.test(full)) full = full.slice(0, -1)
  return platform === 'win32' ? full.toLowerCase() : full
}

function realComparablePath(candidate, platform) {
  try {
    return comparablePath(realpathSync.native(candidate), platform)
  } catch {
    return ''
  }
}

/** pm2_env.pm_cwd is this deploy root (as given, or after resolving junctions / links on both sides). */
export function backendCwdIsRoot(app, root, platform = process.platform) {
  if (!isObject(app) || !isObject(app.pm2_env) || typeof app.pm2_env.pm_cwd !== 'string') return false
  const cwd = app.pm2_env.pm_cwd
  const direct = comparablePath(cwd, platform)
  if (direct !== '' && direct === comparablePath(root, platform)) return true
  const real = realComparablePath(cwd, platform)
  return real !== '' && real === realComparablePath(root, platform)
}

function lookupKey(object, name) {
  if (Object.prototype.hasOwnProperty.call(object, name)) return object[name]
  const lowered = name.toLowerCase()
  for (const key of Object.keys(object)) {
    if (key.toLowerCase() === lowered) return object[key]
  }
  return undefined
}

/** Same lookup as the checklist block (Get-ProcEnv): pm2_env.NAME first, then pm2_env.env.NAME. */
export function runningEnvValue(app, name) {
  if (!isObject(app) || !isObject(app.pm2_env)) return null
  const top = lookupKey(app.pm2_env, name)
  if (top !== undefined && top !== null) return String(top)
  if (isObject(app.pm2_env.env)) {
    const nested = lookupKey(app.pm2_env.env, name)
    if (nested !== undefined && nested !== null) return String(nested)
  }
  return null
}

export function tlsOverridesInRunningBackend(app) {
  if (!isObject(app)) return true
  if (runningEnvValue(app, 'NODE_TLS_REJECT_UNAUTHORIZED')) return true
  if (runningEnvValue(app, 'NODE_EXTRA_CA_CERTS')) return true
  const nodeArgs = isObject(app.pm2_env) ? app.pm2_env.node_args : undefined
  const argsText = Array.isArray(nodeArgs) ? nodeArgs.map(String).join(' ') : typeof nodeArgs === 'string' ? nodeArgs : ''
  return /use-system-ca|use-openssl-ca/i.test(`${runningEnvValue(app, 'NODE_OPTIONS') ?? ''} ${argsText}`)
}

// ── backend out log ─────────────────────────────────────────────────────────────────────────────

// The backend logger (core/logger.ts) adds an ISO UTC "timestamp" to every line's JSON tail; pm2 with
// `time: true` (ecosystem.config.cjs) prefixes each line with local 'YYYY-MM-DDTHH:mm:ss: '.
const WINSTON_TIMESTAMP_PATTERN = /"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)"/
const PM2_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}): /
/** A probe line older than the backend start by more than this is from an earlier start. */
export const PROBE_START_TOLERANCE_MS = 2000

/** Epoch ms of a log line (winston UTC timestamp, else pm2 local prefix); null when neither parses. */
export function probeLineTime(line) {
  const winston = WINSTON_TIMESTAMP_PATTERN.exec(line)
  if (winston) {
    const ms = Date.parse(winston[1])
    if (Number.isFinite(ms)) return ms
  }
  const pm2 = PM2_TIMESTAMP_PATTERN.exec(line)
  if (pm2) {
    const ms = Date.parse(pm2[1]) // no offset: parsed as local time, the zone pm2 wrote it in
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/** Classifies one log line; null when it is not a probe summary / could-not-run line. */
export function classifyProbeLine(line) {
  const timeMs = probeLineTime(line)
  if (line.includes(PROBE_COULD_NOT_RUN_PHRASE)) return { category: 'could_not_run', undecryptable: null, unreadable: null, timeMs }
  if (!PROBE_SUMMARY_PATTERN.test(line)) return null
  const unreadableMatch = PROBE_UNREADABLE_PATTERN.exec(line)
  const unreadable = unreadableMatch ? Number(unreadableMatch[1]) : null
  if (line.includes(PROBE_MATERIAL_UNAVAILABLE_PHRASE)) return { category: 'material_unavailable', undecryptable: null, unreadable, timeMs }
  const match = PROBE_UNDECRYPTABLE_PATTERN.exec(line)
  if (!match) return { category: 'unrecognized', undecryptable: null, unreadable, timeMs }
  const undecryptable = Number(match[1])
  return { category: undecryptable === 0 ? 'ok' : 'undecryptable', undecryptable, unreadable, timeMs }
}

/**
 * An 'ok' probe line counts only when it was written after the running backend started
 * (pm2_env.pm_uptime): otherwise it may describe an earlier start under other material.
 */
export function probeFreshness(probe, app) {
  if (probe.category !== 'ok') return probe
  const uptime = isObject(app) && isObject(app.pm2_env) ? Number(app.pm2_env.pm_uptime) : Number.NaN
  if (!Number.isFinite(uptime) || uptime <= 0) return { ...probe, category: 'start_time_unknown' }
  if (probe.timeMs === null || probe.timeMs === undefined) return { ...probe, category: 'no_timestamp' }
  if (probe.timeMs < uptime - PROBE_START_TOLERANCE_MS) return { ...probe, category: 'stale' }
  return probe
}

/** The out log pm2 writes for the backend (pm_out_log_path), else the ecosystem default under root. */
export function backendOutLogPath(root, app) {
  const fromPm2 = isObject(app) && isObject(app.pm2_env) ? app.pm2_env.pm_out_log_path : undefined
  if (typeof fromPm2 === 'string' && fromPm2.trim() !== '') return { source: 'pm2', file: path.resolve(root, fromPm2) }
  return { source: 'default', file: path.join(root, ...BACKEND_OUT_LOG_RELATIVE_PARTS) }
}

/** Scans the out log from the end in 1 MiB chunks; latin1 keeps the bytes exact for ASCII matching. */
export function readLastProbeLine(file) {
  let fd
  try {
    if (!existsSync(file)) return { category: 'log_missing', undecryptable: null, unreadable: null }
    fd = openSync(file, 'r')
    const stats = fstatSync(fd)
    if (!stats.isFile()) return { category: 'log_unreadable', undecryptable: null, unreadable: null }
    let position = stats.size
    let carry = ''
    while (position > 0) {
      const length = Math.min(LOG_CHUNK_BYTES, position)
      position -= length
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, position + read)
        if (n <= 0) break
        read += n
      }
      const lines = (buffer.subarray(0, read).toString('latin1') + carry).split(/\r\n|\n|\r/)
      carry = position > 0 ? lines.shift() : ''
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const found = classifyProbeLine(lines[index])
        if (found) return found
      }
    }
    if (carry) {
      const found = classifyProbeLine(carry)
      if (found) return found
    }
    return { category: 'missing', undecryptable: null, unreadable: null }
  } catch {
    return { category: 'log_unreadable', undecryptable: null, unreadable: null }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // read-only handle; nothing to recover
      }
    }
  }
}

// ── evaluation ──────────────────────────────────────────────────────────────────────────────────

/**
 * Pure: turns what was read into output lines and a verdict. Only check names, True/False, counts and
 * fixed category words ever reach `lines`.
 */
export function evaluate({ root, appEnv, rootAppEnvExists, pm2, probe, probeLogSource = 'default', testOverrides = false }) {
  const lines = []
  const failing = []
  const warnings = []
  const check = (name, ok) => {
    if (!ok) failing.push(name)
    return ok
  }
  const entries = Number.isInteger(pm2.entries) ? pm2.entries : 0
  const app = entries === 1 ? pm2.app : null
  const hasApp = isObject(app)
  const online = hasApp && isObject(app.pm2_env) && app.pm2_env.status === 'online'

  if (testOverrides) lines.push('INFO test overrides in use (not an operator run)')
  lines.push(`pm2Source=${pm2.source} pm2Status=${pm2.status}`)
  if (PM2_HINTS[pm2.status]) lines.push(PM2_HINTS[pm2.status])
  lines.push(
    `backendInPm2=${tf(check('backendInPm2', hasApp))} backendEntries=${entries} backendOnline=${tf(check('backendOnline', online))} ` +
      `backendCwdIsThisRoot=${tf(check('backendCwdIsThisRoot', hasApp && backendCwdIsRoot(app, root)))} ` +
      `rootAppEnvExists=${tf(!check('rootAppEnvExists', !rootAppEnvExists))}`,
  )
  lines.push(`appEnvFile=${appEnv.status}`)
  check('appEnvFile', appEnv.status === 'present')

  const material = {}
  for (const name of ENCRYPTION_NAMES) {
    const entry = readAppEnvEntry(appEnv.text, name)
    const value = entry.value
    const running = runningEnvValue(app, name)
    const set = value.trim().length > 0
    const result = {
      lines: check(`${name}.lines`, entry.count === 1),
      set: check(`${name}.set`, set),
      notDefault: check(`${name}.notDefault`, set && !isBuiltInDefault(value)),
      notPlaceholderOrSample: check(`${name}.notPlaceholderOrSample`, set && !isPlaceholderOrSample(value)),
      noSurroundingWhitespaceOrControl: check(
        `${name}.noSurroundingWhitespaceOrControl`,
        !hasSurroundingWhitespaceOrControl(value) && (running === null || !hasSurroundingWhitespaceOrControl(running)),
      ),
      sameInRunningBackend: check(`${name}.sameInRunningBackend`, value.length > 0 && running !== null && running === value),
      atLeast32: characterCount(value) >= MIN_RECOMMENDED_MATERIAL_LENGTH,
    }
    material[name] = value
    lines.push(
      `${name}: lines=${entry.count} set=${tf(result.set)} notDefault=${tf(result.notDefault)} ` +
        `notPlaceholderOrSample=${tf(result.notPlaceholderOrSample)} noSurroundingWhitespaceOrControl=${tf(result.noSurroundingWhitespaceOrControl)} ` +
        `sameInRunningBackend=${tf(result.sameInRunningBackend)} atLeast32=${tf(result.atLeast32)}`,
    )
    if (set && !result.atLeast32) {
      warnings.push(
        `WARN ${name} is shorter than ${MIN_RECOMMENDED_MATERIAL_LENGTH} characters. Not a stop, but the YiDa seal made at L4 ` +
          'cannot be re-keyed later. Do not change the value yourself (other stored secrets depend on it); report to the owner.',
      )
    }
  }
  const key = material.ENCRYPTION_KEY.trim()
  const salt = material.ENCRYPTION_SALT.trim()
  lines.push(`ENCRYPTION_KEY_SALT: keyDiffersFromSalt=${tf(check('ENCRYPTION_KEY_SALT.keyDiffersFromSalt', !(key.length > 0 && key === salt)))}`)

  const nodeEnv = readAppEnvEntry(appEnv.text, 'NODE_ENV')
  const runningNodeEnv = runningEnvValue(app, 'NODE_ENV')
  check('NODE_ENV.lines', nodeEnv.count === 1)
  // Case-sensitive on purpose: the backend treats ONLY the exact string 'production' as production.
  const fileIsProduction = check('NODE_ENV.fileIsProduction', nodeEnv.value === 'production')
  const runningIsProduction = check('NODE_ENV.runningIsProduction', runningNodeEnv !== null && runningNodeEnv.trim() === 'production')
  lines.push(`NODE_ENV: lines=${nodeEnv.count} fileIsProduction=${tf(fileIsProduction)} runningIsProduction=${tf(runningIsProduction)}`)

  const jwt = (runningEnvValue(app, 'JWT_SECRET') ?? '').trim()
  const jwtSet = check('JWT_SECRET.setInRunningBackend', jwt.length > 0)
  const jwtNotFallback = check('JWT_SECRET.notPublicFallback', jwt.length > 0 && !INSECURE_JWT_SECRET_VALUES.includes(jwt))
  lines.push(`JWT_SECRET: setInRunningBackend=${tf(jwtSet)} notPublicFallback=${tf(jwtNotFallback)}`)

  lines.push(`tlsOverridesInRunningBackend=${tf(!check('tlsOverridesInRunningBackend', !tlsOverridesInRunningBackend(app)))}`)
  const sendSwitch = !hasApp || runningEnvValue(app, SEND_SWITCH_FLAG) !== null
  lines.push(`sendSwitchInRunningBackend=${tf(!check('sendSwitchInRunningBackend', !sendSwitch))}`)
  const connectionTest = runningEnvValue(app, CONNECTION_TEST_SWITCH_FLAG)
  lines.push(`INFO connectionTestSwitchInRunningBackend=${!hasApp ? 'unknown' : connectionTest === 'true' ? 'on' : 'off'} (information only, not a check)`)

  probe = probeFreshness(probe, app)
  const probeOk = check('encryptedStoreProbe', probe.category === 'ok')
  lines.push(
    `encryptedStoreProbe=${probe.category} probeLog=${probeLogSource}` +
      (probe.undecryptable === null ? '' : ` undecryptable=${probe.undecryptable}`) +
      (probe.unreadable === null ? '' : ` unreadableStoreFields=${probe.unreadable}`),
  )
  if (probeOk && probe.unreadable !== null && probe.unreadable > 0) {
    warnings.push('WARN the last encrypted store probe could not read some store fields; their values were not checked. Report to the owner.')
  }

  lines.push(...warnings)
  lines.push('REMINDER backup (checklist section C: a full database dump plus a copy of docker\\app.env, kept together) is manual and NOT checked by this script.')
  lines.push(failing.length === 0 ? 'L4_PREFLIGHT=PASS' : `L4_PREFLIGHT=STOP ${failing.join(',')}`)
  return { lines, failing, exitCode: failing.length === 0 ? 0 : 1 }
}

export function parseArgs(argv) {
  const options = { help: false, testStub: null, testRpc: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--test-pm2-command' || arg === '--test-pm2-rpc') {
      // Test-only. --test-pm2-command replaces pm2 with `node <file> jlist` (pm2Source=test_stub);
      // --test-pm2-rpc replaces pm2's RPC endpoint for the daemon gate. Either prints an INFO line.
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) return { error: true }
      if (arg === '--test-pm2-command') options.testStub = value
      else options.testRpc = value
      index += 1
    } else return { error: true }
  }
  return options
}

export function main(argv = process.argv.slice(2), { root = process.cwd(), env = process.env, write = text => process.stdout.write(text) } = {}) {
  const options = parseArgs(argv)
  if (options.error) {
    // Never echo the argument: an operator may have pasted a secret by mistake.
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  if (options.help) {
    write(`${USAGE}\n`)
    return 0
  }
  try {
    write('YIDA_L4_PREFLIGHT read-only; no value is ever printed\n')
    const appEnv = readAppEnvFile(root)
    let rootAppEnvExists = true
    try {
      rootAppEnvExists = existsSync(path.join(root, ROOT_APP_ENV_NAME))
    } catch {
      rootAppEnvExists = true
    }
    const pm2 = readBackendFromPm2(root, { testStub: options.testStub, rpcEndpoint: options.testRpc ?? undefined, env })
    const outLog = backendOutLogPath(root, pm2.entries === 1 ? pm2.app : null)
    const probe = readLastProbeLine(outLog.file)
    const testOverrides = Boolean(options.testStub || options.testRpc)
    const result = evaluate({ root, appEnv, rootAppEnvExists, pm2, probe, probeLogSource: outLog.source, testOverrides })
    write(`${result.lines.join('\n')}\n`)
    return result.exitCode
  } catch {
    write('L4_PREFLIGHT=STOP internal_error\n')
    return 1
  }
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false
    // Node realpaths the ESM entry, so behind a junction / symlink argv[1] and import.meta.url differ
    // until both sides are resolved. Without this the script would print nothing and exit 0.
    const invoked = realpathSync.native(path.resolve(process.argv[1]))
    const self = realpathSync.native(fileURLToPath(import.meta.url))
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exitCode = main()
}
