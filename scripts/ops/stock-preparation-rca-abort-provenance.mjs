#!/usr/bin/env node
// stock-preparation-rca-abort-provenance.mjs — RC-A (#4437) abort-provenance diagnostic client.
//
// Why this exists: the #4437 diagnostic chain observed authReadResult=ABORT_ERROR with
// elapsedClass=LT_1S while the exact-SHA smoke helper was given the numeric literal
// timeoutMs=15000. The helper's only abort source is `setTimeout(() => controller.abort(),
// timeoutMs)` cleared in `finally`, so a sub-second AbortError cannot come from that timer in a
// standard Node runtime. This script replaces hand-written operator wrappers with a tested,
// values-free client that separates the remaining hypotheses:
//   - runtime identity (Node vs Bun vs Deno vs other; Node major class),
//   - local timer/abort semantics against a monotonic clock (no network),
//   - abort provenance for one real request: did the HELPER's own signal fire, observed through
//     the helper's existing `fetchImpl` seam, or did the abort originate outside it?
//
// Discipline (owner verdict on #4437):
//   - flag OFF posture: this client performs at most ONE internal read-only GET, zero writes,
//     zero external systems, and never touches service-side flags (flagTouched=false constant).
//   - timeoutMs is FIXED at 15000; there is deliberately no CLI override (unknown flags fail
//     closed with a usage error — including --timeout-ms).
//   - the exact-SHA helper module is imported via pathToFileURL from an allowlisted basename;
//     this script ships separately and does not require republishing the RC-A package.
//   - the provenance fetchImpl only observes the helper-provided AbortSignal and delegates to
//     global fetch; it never patches globals.
//   - every timer this script schedules is cleared in a `finally`.
//   - elapsed time uses process.hrtime.bigint() (monotonic), classified into coarse buckets.
//   - output is a fixed values-free block: every field is validated against a closed vocabulary
//     before rendering, and the rendered block is scrubbed against the auth token as a final
//     fail-closed check. No error text, URL, path, or identifier is ever printed.
//
// Interpretation notes (kept deliberately neutral):
//   - abortProvenance=OUTSIDE_HELPER_SIGNAL only states the abort did not come from the helper's
//     controller. It does not by itself attribute the abort to any specific layer (fetch
//     implementation, runtime, or embedding context).
//   - abortErrorNameClass=TIMEOUT_ERROR is a strong hint that some AbortSignal.timeout() exists
//     in the failure path (the helper's mechanism produces plain AbortError), but it is reported
//     as an observation, not as sole attribution.

import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const DIAGNOSTIC_HEADER = 'STOCK_PREPARATION_RCA_ABORT_PROVENANCE'
export const DIAGNOSTIC_ACTION = 'RUNTIME_ABORT_PROVENANCE'
export const TIMEOUT_MS = 15000
export const AUTH_READ_PATHNAME = '/api/integration/status'
export const TOKEN_SCRUB_SENTINEL = '<scrubbed>'

// Fail closed on what this client may import: only the two RC-A smoke harnesses that export the
// requestJson helper under test. This keeps the diagnostic from becoming a generic module runner.
export const HELPER_BASENAME_ALLOWLIST = Object.freeze([
  'stock-preparation-prep-line-extended-smoke.mjs',
  'stock-preparation-mvp-postdeploy-smoke.mjs',
])

// A basename allowlist alone does not bind the probe to the exact-SHA helper: any file renamed to
// an allowlisted basename would be dynamically imported and executed. Before ANY import, the
// target file — and, because the extended smoke statically imports its sanitizing layer from the
// W6 smoke, that sibling too — must byte-match the release-pinned SHA-256 digests below, computed
// from the RC-A exact package SHA d87e086fd1218b4cfb150177d43f2c52904b1d6d. Any mismatch blocks
// the diagnostic (HELPER_MISMATCH) with zero imports and zero network requests. Editing the
// frozen smoke harnesses requires cutting a new pinned diagnostic release (a repo-parity test
// fails loudly otherwise).
export const HELPER_CONTENT_SHA256 = Object.freeze({
  'stock-preparation-prep-line-extended-smoke.mjs': '912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049',
  'stock-preparation-mvp-postdeploy-smoke.mjs': 'e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4',
})
export const HELPER_SIBLING_REQUIREMENTS = Object.freeze({
  'stock-preparation-prep-line-extended-smoke.mjs': Object.freeze(['stock-preparation-mvp-postdeploy-smoke.mjs']),
  'stock-preparation-mvp-postdeploy-smoke.mjs': Object.freeze([]),
})

// Closed vocabulary per field, in fixed render order. composeResultBlock refuses any value
// outside its field's registry, so the printed surface is values-free by construction.
export const RESULT_VOCABULARY = Object.freeze({
  executionState: Object.freeze(['DIAGNOSTIC_COMPLETE', 'DIAGNOSTIC_BLOCKED']),
  diagnosticAction: Object.freeze([DIAGNOSTIC_ACTION]),
  blockedReasonClass: Object.freeze(['NONE', 'USAGE', 'HELPER_MISMATCH', 'IMPORT', 'NO_REQUEST', 'REQUEST_ANOMALY', 'INTERNAL']),
  runtimeIdentity: Object.freeze(['NODE', 'BUN', 'DENO', 'OTHER', 'UNAVAILABLE']),
  nodeMajorClass: Object.freeze(['18', '20', '22', '24', 'OTHER', 'UNAVAILABLE']),
  timerProbeResult: Object.freeze(['NORMAL', 'ABORT_EARLY', 'CLOCK_ANOMALY', 'UNAVAILABLE']),
  helperContentVerified: Object.freeze(['PASS', 'FAIL', 'UNAVAILABLE']),
  fileUrlImport: Object.freeze(['PASS', 'FAIL', 'UNAVAILABLE']),
  timeoutArgumentMs: Object.freeze(['15000']),
  networkRequestCount: Object.freeze(['0', '1', 'OTHER']),
  networkTarget: Object.freeze(['INTERNAL_API_ONLY', 'OTHER', 'UNAVAILABLE']),
  authReadResult: Object.freeze(['HTTP_2XX', 'HTTP_4XX', 'HTTP_5XX', 'TYPE_ERROR', 'ABORT_ERROR', 'OTHER', 'UNAVAILABLE']),
  authReadStatusClass: Object.freeze(['HTTP_2XX', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_409', 'HTTP_4XX_OTHER', 'HTTP_5XX', 'OTHER', 'UNAVAILABLE']),
  authReadReasonClass: Object.freeze(['NONE', 'UNAUTHORIZED', 'PASSWORD_CHANGE_REQUIRED', 'FORBIDDEN', 'INCONSISTENT', 'OTHER', 'UNAVAILABLE']),
  authReadContractClass: Object.freeze(['VALID', 'RESPONSE_CONTRACT_INVALID', 'UNAVAILABLE']),
  elapsedClass: Object.freeze(['LT_1S', '1_TO_14S', '15_TO_20S', 'GT_20S', 'UNAVAILABLE']),
  typeErrorBoundary: Object.freeze(['INVALID_URL', 'REQUEST_HEADERS', 'CONNECT', 'DNS', 'TLS', 'FETCH_API', 'RESPONSE_READ', 'OTHER', 'NONE', 'UNAVAILABLE']),
  abortErrorNameClass: Object.freeze(['ABORT_ERROR', 'TIMEOUT_ERROR', 'OTHER', 'NONE']),
  abortProvenance: Object.freeze(['HELPER_SIGNAL', 'OUTSIDE_HELPER_SIGNAL', 'NONE', 'UNAVAILABLE']),
  externalWrite: Object.freeze(['false', 'true']),
  tokenScrubbed: Object.freeze(['PASS', 'FAIL', 'NOT_USED']),
  flagTouched: Object.freeze(['false']),
})
export const RESULT_FIELD_ORDER = Object.freeze(Object.keys(RESULT_VOCABULARY))

export const USAGE_TEXT = [
  'usage: node scripts/ops/stock-preparation-rca-abort-provenance.mjs \\',
  '         --helper <exact-sha-smoke-module-path> --base-url <http-or-https-base-url> [--tenant-id <tenant>]',
  'notes: timeoutMs is fixed at 15000 and cannot be overridden; at most one internal read-only GET;',
  '       auth token is read from the METASHEET_AUTH_TOKEN environment variable and never printed.',
].join('\n')

export class UsageError extends Error {}

export function parseArgs(argv) {
  const args = { helperPath: '', baseUrl: '', tenantId: '' }
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const next = () => {
      const value = rest[i + 1]
      if (value === undefined) throw new UsageError('missing flag value')
      i += 1
      return value
    }
    if (flag === '--helper') args.helperPath = next()
    else if (flag === '--base-url') args.baseUrl = next()
    else if (flag === '--tenant-id') args.tenantId = next()
    // Unknown flags fail closed. This is load-bearing for the fixed-timeout contract: --timeout-ms
    // must be rejected, not silently ignored.
    else throw new UsageError('unknown flag')
  }
  if (!args.helperPath || !args.baseUrl) throw new UsageError('missing required flag')
  if (!HELPER_BASENAME_ALLOWLIST.includes(path.basename(args.helperPath))) {
    throw new UsageError('helper module not allowlisted')
  }
  let parsedBaseUrl
  try {
    parsedBaseUrl = new URL(args.baseUrl)
  } catch {
    throw new UsageError('base url unparseable')
  }
  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new UsageError('base url protocol not allowed')
  }
  return args
}

// ── Runtime identity ─────────────────────────────────────────────────────────────────────────────

export function defaultRuntimeSurface() {
  return {
    versions: typeof process === 'object' && process ? process.versions : undefined,
    bunGlobal: typeof globalThis.Bun !== 'undefined',
    denoGlobal: typeof globalThis.Deno !== 'undefined',
  }
}

// Bun/Deno both emulate process.versions.node, so the compat markers are checked first and NODE is
// only reported when neither marker is present.
export function detectRuntime(surface = defaultRuntimeSurface()) {
  const versions = surface && typeof surface.versions === 'object' && surface.versions !== null ? surface.versions : {}
  if (typeof versions.bun === 'string' || surface?.bunGlobal) return 'BUN'
  if (surface?.denoGlobal) return 'DENO'
  if (typeof versions.node === 'string' && versions.node.length > 0) return 'NODE'
  return 'OTHER'
}

export function classifyNodeMajor(versionString) {
  if (typeof versionString !== 'string') return 'UNAVAILABLE'
  const match = /^(\d+)\./.exec(versionString)
  if (!match) return 'UNAVAILABLE'
  const major = match[1]
  return ['18', '20', '22', '24'].includes(major) ? major : 'OTHER'
}

// ── Local timer/abort semantics probe (no network) ───────────────────────────────────────────────

export function defaultNowNs() {
  return process.hrtime.bigint()
}

export function defaultTimerHooks() {
  return { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
}

export const TIMER_PROBE_DEFAULTS = Object.freeze({
  sleepTargetMs: 1200,
  minSleepMs: 1000,
  maxSleepMs: 5000,
  abortTimerMs: TIMEOUT_MS,
})

// Schedules the same abort-timer shape the helper uses (setTimeout -> controller.abort()), sleeps
// well short of it, and checks against a monotonic clock:
//   ABORT_EARLY   — the long abort timer fired during the short sleep (broken timer semantics).
//   CLOCK_ANOMALY — the sleep's measured monotonic duration fell outside its plausible window.
//   NORMAL        — neither anomaly observed.
// The abort timer is cleared in `finally` so it can never outlive the probe and pollute the
// subsequent real request.
export async function runTimerProbe({
  sleepTargetMs = TIMER_PROBE_DEFAULTS.sleepTargetMs,
  minSleepMs = TIMER_PROBE_DEFAULTS.minSleepMs,
  maxSleepMs = TIMER_PROBE_DEFAULTS.maxSleepMs,
  abortTimerMs = TIMER_PROBE_DEFAULTS.abortTimerMs,
  nowNs = defaultNowNs,
  timerHooks = defaultTimerHooks(),
} = {}) {
  if (typeof AbortController !== 'function') return { timerProbeResult: 'UNAVAILABLE' }
  const controller = new AbortController()
  let abortTimer
  try {
    const startedNs = nowNs()
    abortTimer = timerHooks.setTimeout(() => controller.abort(), abortTimerMs)
    await new Promise((resolve) => {
      timerHooks.setTimeout(resolve, sleepTargetMs)
    })
    const elapsedMs = Number((nowNs() - startedNs) / 1_000_000n)
    if (controller.signal.aborted) return { timerProbeResult: 'ABORT_EARLY' }
    if (elapsedMs < minSleepMs || elapsedMs > maxSleepMs) return { timerProbeResult: 'CLOCK_ANOMALY' }
    return { timerProbeResult: 'NORMAL' }
  } finally {
    timerHooks.clearTimeout(abortTimer)
  }
}

// ── Abort-provenance fetchImpl (observe-only shim over the helper's existing seam) ───────────────

// Same-origin test, not a string prefix: `startsWith(baseUrl)` classifies
// `http://internal.example.evil/…` as internal against base `http://internal.example` (owner
// round-3 P3). Parse both and require identical origin (protocol + host + port); when the base
// carries a path prefix, require the target path to sit under it. Unparseable targets fail closed
// to non-internal.
export function isInternalTarget(url, baseUrl) {
  let target
  let base
  try {
    target = new URL(String(url))
    base = new URL(String(baseUrl))
  } catch {
    return false
  }
  if (target.origin !== base.origin) return false
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')
  if (!basePath) return true
  return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
}

// Records, without altering behavior: how many requests the helper dispatched, whether every
// target stayed under the supplied base URL, and whether the helper's own AbortSignal ever fired.
// helperSignalObserved: UNAVAILABLE until a request carrying a signal is seen, then FALSE, then
// TRUE if that signal aborts before settle.
export function buildProvenanceFetchImpl({ baseUrl, nowNs = defaultNowNs, fetchDelegate = globalThis.fetch } = {}) {
  const state = {
    requestCount: 0,
    networkTarget: 'UNAVAILABLE',
    helperSignalObserved: 'UNAVAILABLE',
    helperSignalElapsedNs: null,
    startedNs: null,
  }
  const fetchImpl = (url, init) => {
    state.requestCount += 1
    if (state.startedNs === null) state.startedNs = nowNs()
    const internal = isInternalTarget(url, baseUrl)
    state.networkTarget = state.networkTarget === 'OTHER' ? 'OTHER' : internal ? 'INTERNAL_API_ONLY' : 'OTHER'
    const signal = init ? init.signal : undefined
    if (signal && typeof signal.addEventListener === 'function') {
      if (state.helperSignalObserved === 'UNAVAILABLE') state.helperSignalObserved = 'FALSE'
      signal.addEventListener(
        'abort',
        () => {
          state.helperSignalObserved = 'TRUE'
          state.helperSignalElapsedNs = nowNs() - state.startedNs
        },
        { once: true },
      )
    }
    return fetchDelegate(url, init)
  }
  return { fetchImpl, state }
}

// ── Outcome classification ───────────────────────────────────────────────────────────────────────

export function classifyElapsedNs(elapsedNs) {
  if (typeof elapsedNs !== 'bigint' || elapsedNs < 0n) return 'UNAVAILABLE'
  if (elapsedNs < 1_000_000_000n) return 'LT_1S'
  if (elapsedNs < 15_000_000_000n) return '1_TO_14S'
  if (elapsedNs <= 20_000_000_000n) return '15_TO_20S'
  return 'GT_20S'
}

export function classifyHttpStatusClass(status) {
  if (!Number.isInteger(status)) return 'OTHER'
  if (status >= 200 && status <= 299) return 'HTTP_2XX'
  if (status >= 400 && status <= 499) return 'HTTP_4XX'
  if (status >= 500 && status <= 599) return 'HTTP_5XX'
  return 'OTHER'
}

// v2 acceleration: a finer HTTP status class so ONE run with a known-good token
// is dispositive. 401 vs 403 splits token-invalid from account/permission
// failures without a second sidecar. Values-free: HTTP status is a closed
// protocol enum, not business data.
export function classifyAuthReadStatusClass(status) {
  if (!Number.isInteger(status)) return 'UNAVAILABLE'
  if (status >= 200 && status <= 299) return 'HTTP_2XX'
  if (status === 401) return 'HTTP_401'
  if (status === 403) return 'HTTP_403'
  if (status === 404) return 'HTTP_404'
  if (status === 409) return 'HTTP_409'
  if (status >= 400 && status <= 499) return 'HTTP_4XX_OTHER'
  if (status >= 500 && status <= 599) return 'HTTP_5XX'
  return 'OTHER'
}

// The reason class is bound to the EXACT (status, code) pair, not the code alone
// (review P2): a 404+FORBIDDEN or 401+PASSWORD_CHANGE_REQUIRED is a contradiction,
// not a FORBIDDEN / PASSWORD_CHANGE_REQUIRED. Only these three pairs occur for
// GET /api/integration/status auth failures on a real deployment (behind the
// global JWT gate, the plugin's 401 UNAUTHENTICATED is unreachable — deliberately
// NOT a recognized branch). A recognized code with the wrong status is
// INCONSISTENT; any other/absent code is OTHER — no free-text ever surfaces.
const AUTH_READ_REASON_PAIRS = Object.freeze({
  '401|UNAUTHORIZED': 'UNAUTHORIZED',
  '403|PASSWORD_CHANGE_REQUIRED': 'PASSWORD_CHANGE_REQUIRED',
  '403|FORBIDDEN': 'FORBIDDEN',
})
export const AUTH_READ_REASON_CODES = Object.freeze(['UNAUTHORIZED', 'PASSWORD_CHANGE_REQUIRED', 'FORBIDDEN'])
const AUTH_READ_REASON_CODE_SET = new Set(AUTH_READ_REASON_CODES)

export function classifyAuthReadReasonClass(status, body) {
  if (!Number.isInteger(status)) return 'UNAVAILABLE'
  if (status >= 200 && status <= 299) return 'NONE'
  const code = body && body.error && typeof body.error.code === 'string' ? body.error.code : ''
  const exact = AUTH_READ_REASON_PAIRS[`${status}|${code}`]
  if (exact) return exact
  // A recognized auth code paired with the wrong status is a contradiction.
  if (AUTH_READ_REASON_CODE_SET.has(code)) return 'INCONSISTENT'
  return 'OTHER'
}

// Success-response contract (review P1): a bare 200 is NOT proof of a healthy API.
// A login/HTML page returns 200 and parses to body=null yet would otherwise read
// as HTTP_2XX/NONE and unlock the RC-A fast-track. A genuine status success is
// { ok:true, data:{ adapters:[...], routes:[...] } } — validate it or fail closed
// to RESPONSE_CONTRACT_INVALID (never fast-track). Non-2xx has no success contract.
export function classifyAuthReadContractClass(status, body) {
  if (!Number.isInteger(status) || status < 200 || status > 299) return 'UNAVAILABLE'
  const valid =
    body &&
    typeof body === 'object' &&
    body.ok === true &&
    body.data &&
    typeof body.data === 'object' &&
    Array.isArray(body.data.adapters) &&
    Array.isArray(body.data.routes)
  return valid ? 'VALID' : 'RESPONSE_CONTRACT_INVALID'
}

// Error codes are collected from a small closed set of locations: the error itself, its cause,
// the cause's AggregateError members (Node >=20 wraps connection failures this way), and one
// nested cause level. Values are never printed — they only feed the closed classification below.
export function collectErrorCodes(error) {
  const codes = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) codes.push(value)
  }
  push(error && error.code)
  const cause = error && error.cause
  push(cause && cause.code)
  const nested = cause && cause.errors
  if (Array.isArray(nested)) {
    for (const item of nested) push(item && item.code)
  }
  push(cause && cause.cause && cause.cause.code)
  return codes
}

function classifySingleErrorCode(code) {
  if (code === 'ERR_INVALID_URL') return 'INVALID_URL'
  if (code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN') return 'REQUEST_HEADERS'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS'
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return 'CONNECT'
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) return 'TLS'
  if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)) return 'RESPONSE_READ'
  return null
}

// Coarse boundary classification for TypeError rejections. UND_ERR_SOCKET (peer closed
// mid-exchange) is grouped under CONNECT deliberately: it is a transport-layer failure, not a
// parsed-response failure. No code at any collected location -> FETCH_API (the fetch layer itself
// rejected); codes present but all unrecognized -> OTHER.
export function classifyTypeErrorBoundary(error) {
  const codes = collectErrorCodes(error)
  if (codes.length === 0) return 'FETCH_API'
  for (const code of codes) {
    const family = classifySingleErrorCode(code)
    if (family) return family
  }
  return 'OTHER'
}

export function classifyRejection(error) {
  const name = error && typeof error.name === 'string' ? error.name : ''
  if (name === 'AbortError') {
    return { authReadResult: 'ABORT_ERROR', typeErrorBoundary: 'NONE', abortErrorNameClass: 'ABORT_ERROR' }
  }
  if (name === 'TimeoutError') {
    return { authReadResult: 'ABORT_ERROR', typeErrorBoundary: 'NONE', abortErrorNameClass: 'TIMEOUT_ERROR' }
  }
  if (name === 'TypeError' || error instanceof TypeError) {
    return { authReadResult: 'TYPE_ERROR', typeErrorBoundary: classifyTypeErrorBoundary(error), abortErrorNameClass: 'NONE' }
  }
  return { authReadResult: 'OTHER', typeErrorBoundary: 'NONE', abortErrorNameClass: 'OTHER' }
}

// HELPER_SIGNAL / OUTSIDE_HELPER_SIGNAL are deliberately neutral: OUTSIDE only states the helper's
// own controller did not fire before the abort-shaped rejection. Attribution beyond that (fetch
// implementation, runtime, embedding context) is out of scope for this client.
export function deriveAbortProvenance({ authReadResult, helperSignalObserved }) {
  if (authReadResult !== 'ABORT_ERROR') return 'NONE'
  if (helperSignalObserved === 'TRUE') return 'HELPER_SIGNAL'
  if (helperSignalObserved === 'FALSE') return 'OUTSIDE_HELPER_SIGNAL'
  return 'UNAVAILABLE'
}

// Fail closed: anything beyond exactly one internal request is reported as externalWrite=true,
// over-reporting rather than under-reporting risk. The single request is a GET by construction
// (this client passes neither method nor body to the helper).
export function deriveExternalWrite({ requestCount, networkTarget }) {
  if (requestCount === 0) return 'false'
  return networkTarget === 'INTERNAL_API_ONLY' && requestCount === 1 ? 'false' : 'true'
}

export function buildAuthReadPathname(tenantId) {
  if (!tenantId) return AUTH_READ_PATHNAME
  const params = new URLSearchParams()
  params.set('tenantId', tenantId)
  return `${AUTH_READ_PATHNAME}?${params.toString()}`
}

// ── Helper content verification + import (realpath-bound) ────────────────────────────────────────

// Resolve the exact real files the Node loader will execute. A basename allowlist plus
// `path.resolve` (which normalises `..` but does NOT follow symlinks) is not enough: Node imports
// a symlinked module by its REAL path and resolves that module's static sibling import relative to
// the real directory, so a symlink in a directory holding a byte-correct sibling copy would let an
// UNVERIFIED real sibling execute (owner round-3 repro). `realpath` every file so verification and
// import operate on identical bytes. Also require each real file's basename to equal its logical
// name — a symlink pointing at a differently-named target is refused rather than silently accepted.
export async function resolveRealHelperFiles(helperPath, { realpathImpl = realpath } = {}) {
  const base = path.basename(helperPath)
  const siblings = HELPER_SIBLING_REQUIREMENTS[base]
  if (!Array.isArray(siblings)) return null
  let realTarget
  try {
    realTarget = await realpathImpl(helperPath)
  } catch {
    return null
  }
  if (path.basename(realTarget) !== base) return null
  const dir = path.dirname(realTarget)
  const files = [{ name: base, realPath: realTarget }]
  for (const name of siblings) {
    let realSibling
    try {
      realSibling = await realpathImpl(path.join(dir, name))
    } catch {
      return null
    }
    // The sibling Node will import must live in the target's real directory under its own name;
    // a sibling that realpaths elsewhere (a nested symlink) is refused.
    if (path.dirname(realSibling) !== dir || path.basename(realSibling) !== name) return null
    files.push({ name, realPath: realSibling })
  }
  return { realTarget, dir, files }
}

// Byte-binds the probe to the exact-SHA helper before any dynamic import: every real file the
// loader will execute (target + required sibling(s)) must hash to the release-pinned digests.
// Returns 'PASS' | 'FAIL' only — unresolvable paths, symlink redirection, unknown basenames, and
// digest mismatches all FAIL closed.
export async function verifyHelperContent(helperPath, { readFileImpl = readFile, realpathImpl = realpath } = {}) {
  const resolved = await resolveRealHelperFiles(helperPath, { realpathImpl })
  if (!resolved) return 'FAIL'
  for (const { name, realPath } of resolved.files) {
    const expected = HELPER_CONTENT_SHA256[name]
    if (typeof expected !== 'string') return 'FAIL'
    let bytes
    try {
      bytes = await readFileImpl(realPath)
    } catch {
      return 'FAIL'
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) return 'FAIL'
  }
  return 'PASS'
}

// Import the verified real target (not the caller-supplied, possibly-symlinked path) so the module
// that executes is exactly the one whose bytes were hashed. When importImpl is injected (tests),
// realpath resolution is skipped and the caller-supplied path is used directly.
export async function importHelperModule(helperPath, { importImpl, realpathImpl = realpath } = {}) {
  let href
  if (importImpl) {
    href = pathToFileURL(path.resolve(helperPath)).href
  } else {
    const resolved = await resolveRealHelperFiles(helperPath, { realpathImpl })
    if (!resolved) throw new Error('helper path could not be resolved to verified real files')
    href = pathToFileURL(resolved.realTarget).href
  }
  const mod = importImpl ? await importImpl(href) : await import(href)
  if (!mod || typeof mod.requestJson !== 'function') {
    throw new Error('helper module missing requestJson export')
  }
  return mod
}

// ── Orchestration ────────────────────────────────────────────────────────────────────────────────

export function baselineFields() {
  return {
    executionState: 'DIAGNOSTIC_COMPLETE',
    diagnosticAction: DIAGNOSTIC_ACTION,
    blockedReasonClass: 'NONE',
    runtimeIdentity: 'UNAVAILABLE',
    nodeMajorClass: 'UNAVAILABLE',
    timerProbeResult: 'UNAVAILABLE',
    helperContentVerified: 'UNAVAILABLE',
    fileUrlImport: 'UNAVAILABLE',
    timeoutArgumentMs: '15000',
    networkRequestCount: '0',
    networkTarget: 'UNAVAILABLE',
    authReadResult: 'UNAVAILABLE',
    authReadStatusClass: 'UNAVAILABLE',
    authReadReasonClass: 'UNAVAILABLE',
    authReadContractClass: 'UNAVAILABLE',
    elapsedClass: 'UNAVAILABLE',
    typeErrorBoundary: 'UNAVAILABLE',
    abortErrorNameClass: 'NONE',
    abortProvenance: 'UNAVAILABLE',
    externalWrite: 'false',
    tokenScrubbed: 'NOT_USED',
    flagTouched: 'false',
  }
}

export async function runDiagnostic({
  args,
  token = '',
  runtimeSurface = defaultRuntimeSurface(),
  nowNs = defaultNowNs,
  timerHooks = defaultTimerHooks(),
  timerProbeOverrides = {},
  verifyImpl = verifyHelperContent,
  importImpl,
  fetchDelegate = globalThis.fetch,
} = {}) {
  const fields = baselineFields()

  fields.runtimeIdentity = detectRuntime(runtimeSurface)
  fields.nodeMajorClass = classifyNodeMajor(runtimeSurface && runtimeSurface.versions ? runtimeSurface.versions.node : undefined)

  const timerProbe = await runTimerProbe({ nowNs, timerHooks, ...timerProbeOverrides })
  fields.timerProbeResult = timerProbe.timerProbeResult

  // Content verification gates the dynamic import: a FAIL means the exact-SHA binding could not
  // be proven, so nothing is imported and no request is dispatched.
  let helper = null
  try {
    fields.helperContentVerified = (await verifyImpl(args.helperPath)) === 'PASS' ? 'PASS' : 'FAIL'
  } catch {
    fields.helperContentVerified = 'FAIL'
  }
  if (fields.helperContentVerified === 'PASS') {
    try {
      helper = await importHelperModule(args.helperPath, importImpl ? { importImpl } : {})
      fields.fileUrlImport = 'PASS'
    } catch {
      fields.fileUrlImport = 'FAIL'
    }
  }

  if (helper && typeof fetchDelegate === 'function') {
    const { fetchImpl, state } = buildProvenanceFetchImpl({ baseUrl: args.baseUrl, nowNs, fetchDelegate })
    const pathname = buildAuthReadPathname(args.tenantId)
    const startedNs = nowNs()
    let outcome
    try {
      const response = await helper.requestJson(args.baseUrl, pathname, {
        token,
        tenantId: args.tenantId || undefined,
        timeoutMs: TIMEOUT_MS,
        label: 'rca-abort-provenance',
        leakExempt: true,
        fetchImpl,
      })
      outcome = { resolved: true, response }
    } catch (error) {
      outcome = { resolved: false, error }
    }
    const elapsedNs = nowNs() - startedNs
    fields.elapsedClass = classifyElapsedNs(elapsedNs)
    fields.networkRequestCount = state.requestCount === 0 ? '0' : state.requestCount === 1 ? '1' : 'OTHER'
    fields.networkTarget = state.requestCount === 0 ? 'UNAVAILABLE' : state.networkTarget
    if (outcome.resolved) {
      const status = outcome.response ? outcome.response.status : undefined
      const body = outcome.response ? outcome.response.body : undefined
      fields.authReadResult = classifyHttpStatusClass(status)
      fields.authReadStatusClass = classifyAuthReadStatusClass(status)
      fields.authReadReasonClass = classifyAuthReadReasonClass(status, body)
      fields.authReadContractClass = classifyAuthReadContractClass(status, body)
      fields.typeErrorBoundary = 'NONE'
      fields.abortErrorNameClass = 'NONE'
    } else {
      const rejection = classifyRejection(outcome.error)
      fields.authReadResult = rejection.authReadResult
      fields.typeErrorBoundary = rejection.typeErrorBoundary
      fields.abortErrorNameClass = rejection.abortErrorNameClass
      // A transport/abort rejection produced no HTTP response to classify.
      fields.authReadStatusClass = 'UNAVAILABLE'
      fields.authReadReasonClass = 'UNAVAILABLE'
      fields.authReadContractClass = 'UNAVAILABLE'
    }
    fields.abortProvenance = deriveAbortProvenance({
      authReadResult: fields.authReadResult,
      helperSignalObserved: state.helperSignalObserved,
    })
    fields.externalWrite = deriveExternalWrite({ requestCount: state.requestCount, networkTarget: state.networkTarget })
  }

  // DIAGNOSTIC_COMPLETE is a contract, not a default: the exact-SHA binding must be proven, the
  // import must succeed, and EXACTLY ONE request must have been dispatched to the internal target
  // with externalWrite=false. A run that never fired its request (missing fetch, skipped phase) is
  // NO_REQUEST; a run that fired more than one, hit a non-internal target, or tripped the
  // external-write guard is REQUEST_ANOMALY — neither may read as a completed diagnostic (owner
  // round-3: two dispatches / networkRequestCount=OTHER / externalWrite=true must exit 2).
  if (fields.helperContentVerified !== 'PASS') {
    fields.executionState = 'DIAGNOSTIC_BLOCKED'
    fields.blockedReasonClass = 'HELPER_MISMATCH'
  } else if (fields.fileUrlImport !== 'PASS') {
    fields.executionState = 'DIAGNOSTIC_BLOCKED'
    fields.blockedReasonClass = 'IMPORT'
  } else if (fields.networkRequestCount === '0' || fields.authReadResult === 'UNAVAILABLE') {
    fields.executionState = 'DIAGNOSTIC_BLOCKED'
    fields.blockedReasonClass = 'NO_REQUEST'
  } else if (
    fields.networkRequestCount !== '1' ||
    fields.networkTarget !== 'INTERNAL_API_ONLY' ||
    fields.externalWrite !== 'false'
  ) {
    fields.executionState = 'DIAGNOSTIC_BLOCKED'
    fields.blockedReasonClass = 'REQUEST_ANOMALY'
  }

  return fields
}

// ── Rendering (closed vocabulary + token scrub) ──────────────────────────────────────────────────

export function composeResultBlock(fields) {
  const lines = [DIAGNOSTIC_HEADER]
  for (const key of RESULT_FIELD_ORDER) {
    const value = fields[key]
    const allowed = RESULT_VOCABULARY[key]
    if (!allowed.includes(value)) {
      throw new TypeError('result field outside closed vocabulary')
    }
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n')
}

// Belt-and-suspenders: the vocabulary already makes a token leak impossible by construction, but
// the rendered block is still scanned for the auth token; a hit flips tokenScrubbed to FAIL and
// replaces every occurrence with a fixed sentinel.
export function composeScrubbedBlock(fields, token) {
  const tentative = composeResultBlock({ ...fields, tokenScrubbed: token ? 'PASS' : 'NOT_USED' })
  if (!token || !tentative.includes(token)) return tentative
  const failed = composeResultBlock({ ...fields, tokenScrubbed: 'FAIL' })
  return failed.split(token).join(TOKEN_SCRUB_SENTINEL)
}

export function composeBlockedBlock(blockedReasonClass) {
  return composeResultBlock({
    ...baselineFields(),
    executionState: 'DIAGNOSTIC_BLOCKED',
    blockedReasonClass,
  })
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv)
  } catch (error) {
    process.stdout.write(`${composeBlockedBlock(error instanceof UsageError ? 'USAGE' : 'INTERNAL')}\n`)
    process.stdout.write(`${USAGE_TEXT}\n`)
    process.exitCode = 2
    return
  }
  const token = process.env.METASHEET_AUTH_TOKEN || ''
  let fields
  try {
    fields = await runDiagnostic({ args, token })
  } catch {
    process.stdout.write(`${composeBlockedBlock('INTERNAL')}\n`)
    process.exitCode = 2
    return
  }
  process.stdout.write(`${composeScrubbedBlock(fields, token)}\n`)
  process.exitCode = fields.executionState === 'DIAGNOSTIC_COMPLETE' ? 0 : 2
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (invokedDirectly) {
  main()
}
