import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, copyFile, symlink, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Contract tests for the RC-A (#4437) abort-provenance diagnostic client. No live server, no DB.
// Owner-required coverage: HTTP 2xx, helper-signal abort, outside-signal abort, anomalous runtime,
// leaked timer. The provenance seam is exercised against the REAL exact-SHA helper shape by
// importing requestJson from the in-repo extended smoke harness.

import {
  AUTH_READ_PATHNAME,
  DIAGNOSTIC_HEADER,
  HELPER_BASENAME_ALLOWLIST,
  HELPER_CONTENT_SHA256,
  HELPER_SIBLING_REQUIREMENTS,
  RESULT_FIELD_ORDER,
  RESULT_VOCABULARY,
  TIMEOUT_MS,
  TOKEN_SCRUB_SENTINEL,
  UsageError,
  baselineFields,
  buildAuthReadPathname,
  buildProvenanceFetchImpl,
  classifyElapsedNs,
  classifyHttpStatusClass,
  classifyAuthReadStatusClass,
  classifyAuthReadReasonClass,
  AUTH_READ_REASON_ALLOWLIST,
  classifyNodeMajor,
  classifyRejection,
  classifyTypeErrorBoundary,
  composeBlockedBlock,
  composeResultBlock,
  composeScrubbedBlock,
  deriveAbortProvenance,
  deriveExternalWrite,
  detectRuntime,
  isInternalTarget,
  parseArgs,
  resolveRealHelperFiles,
  runDiagnostic,
  runTimerProbe,
  verifyHelperContent,
} from './stock-preparation-rca-abort-provenance.mjs'

import { requestJson as realRequestJson } from './stock-preparation-prep-line-extended-smoke.mjs'

const BASE_URL = 'http://127.0.0.1:9'

function makeDomError(name) {
  // DOMException carries the same name/shape undici uses for abort-family rejections.
  return new DOMException('probe', name)
}

function jsonResponse(status, body = '{}') {
  return { status, text: async () => body }
}

function countingTimerHooks() {
  const scheduled = []
  const cleared = []
  return {
    scheduled,
    cleared,
    hooks: {
      setTimeout: (fn, delay) => {
        const handle = setTimeout(fn, delay)
        scheduled.push({ handle, delay })
        return handle
      },
      clearTimeout: (handle) => {
        cleared.push(handle)
        clearTimeout(handle)
      },
    },
  }
}

// ── Closed vocabulary + rendering ────────────────────────────────────────────────────────────────

test('composeResultBlock renders header plus every field in fixed order', () => {
  const rendered = composeResultBlock(baselineFields())
  const lines = rendered.split('\n')
  assert.equal(lines[0], DIAGNOSTIC_HEADER)
  assert.equal(lines.length, 1 + RESULT_FIELD_ORDER.length)
  RESULT_FIELD_ORDER.forEach((key, index) => {
    assert.ok(lines[1 + index].startsWith(`${key}=`))
    const value = lines[1 + index].slice(key.length + 1)
    assert.ok(RESULT_VOCABULARY[key].includes(value))
  })
})

test('composeResultBlock refuses any value outside the closed vocabulary', () => {
  const fields = { ...baselineFields(), authReadResult: 'HTTP_302' }
  assert.throws(() => composeResultBlock(fields), TypeError)
  const injected = { ...baselineFields(), networkTarget: 'http://10.0.0.1/exfil' }
  assert.throws(() => composeResultBlock(injected), TypeError)
})

test('composeBlockedBlock renders a values-free blocked block', () => {
  const rendered = composeBlockedBlock('USAGE')
  assert.ok(rendered.includes('executionState=DIAGNOSTIC_BLOCKED'))
  assert.ok(rendered.includes('blockedReasonClass=USAGE'))
  assert.ok(rendered.includes('networkRequestCount=0'))
  assert.ok(rendered.includes('flagTouched=false'))
})

// ── Arg parsing: fixed timeout is not overridable ────────────────────────────────────────────────

test('parseArgs accepts the three known flags and validates the base url', () => {
  const args = parseArgs(['node', 'x', '--helper', 'pkg/scripts/ops/stock-preparation-prep-line-extended-smoke.mjs', '--base-url', 'http://127.0.0.1:8081', '--tenant-id', 't1'])
  assert.equal(args.tenantId, 't1')
  assert.equal(args.baseUrl, 'http://127.0.0.1:8081')
})

test('parseArgs rejects --timeout-ms: the 15000 timeout is a fixed constant', () => {
  assert.throws(
    () => parseArgs(['node', 'x', '--helper', 'a/stock-preparation-prep-line-extended-smoke.mjs', '--base-url', 'http://h', '--timeout-ms', '200']),
    UsageError,
  )
  assert.equal(TIMEOUT_MS, 15000)
  assert.deepEqual(RESULT_VOCABULARY.timeoutArgumentMs, ['15000'])
})

test('parseArgs fails closed on unknown flags, missing requireds, bad urls, non-allowlisted helpers', () => {
  assert.throws(() => parseArgs(['node', 'x', '--helper', 'a/stock-preparation-prep-line-extended-smoke.mjs', '--base-url', 'http://h', '--out-dir', '/tmp']), UsageError)
  assert.throws(() => parseArgs(['node', 'x', '--base-url', 'http://h']), UsageError)
  assert.throws(() => parseArgs(['node', 'x', '--helper', 'a/stock-preparation-prep-line-extended-smoke.mjs']), UsageError)
  assert.throws(() => parseArgs(['node', 'x', '--helper', 'a/evil-module.mjs', '--base-url', 'http://h']), UsageError)
  assert.throws(() => parseArgs(['node', 'x', '--helper', 'a/stock-preparation-prep-line-extended-smoke.mjs', '--base-url', 'not a url']), UsageError)
  assert.throws(() => parseArgs(['node', 'x', '--helper', 'a/stock-preparation-prep-line-extended-smoke.mjs', '--base-url', 'file:///etc/passwd']), UsageError)
  assert.deepEqual(
    [...HELPER_BASENAME_ALLOWLIST],
    ['stock-preparation-prep-line-extended-smoke.mjs', 'stock-preparation-mvp-postdeploy-smoke.mjs'],
    'allowlist is exactly the two RC-A smoke harnesses',
  )
})

// ── Runtime identity (anomalous-runtime coverage) ────────────────────────────────────────────────

test('detectRuntime: NODE only when no Bun/Deno marker is present', () => {
  assert.equal(detectRuntime({ versions: { node: '20.11.1' }, bunGlobal: false, denoGlobal: false }), 'NODE')
  assert.equal(detectRuntime({ versions: { node: '20.11.1', bun: '1.1.0' }, bunGlobal: false, denoGlobal: false }), 'BUN')
  assert.equal(detectRuntime({ versions: { node: '20.11.1' }, bunGlobal: true, denoGlobal: false }), 'BUN')
  assert.equal(detectRuntime({ versions: { node: '20.11.1' }, bunGlobal: false, denoGlobal: true }), 'DENO')
  assert.equal(detectRuntime({ versions: {}, bunGlobal: false, denoGlobal: false }), 'OTHER')
  assert.equal(detectRuntime({ versions: undefined, bunGlobal: false, denoGlobal: false }), 'OTHER')
})

test('classifyNodeMajor: enumerated LTS majors, OTHER for the rest, UNAVAILABLE when unparseable', () => {
  assert.equal(classifyNodeMajor('18.19.0'), '18')
  assert.equal(classifyNodeMajor('20.11.1'), '20')
  assert.equal(classifyNodeMajor('22.6.0'), '22')
  assert.equal(classifyNodeMajor('24.1.0'), '24')
  assert.equal(classifyNodeMajor('19.9.0'), 'OTHER')
  assert.equal(classifyNodeMajor('25.9.0'), 'OTHER')
  assert.equal(classifyNodeMajor('weird'), 'UNAVAILABLE')
  assert.equal(classifyNodeMajor(undefined), 'UNAVAILABLE')
})

// ── Timer probe (leaked-timer + early-abort coverage) ────────────────────────────────────────────

test('runTimerProbe NORMAL: healthy timers, and the abort timer is ALWAYS cleared in finally', async () => {
  const { hooks, scheduled, cleared } = countingTimerHooks()
  const probe = await runTimerProbe({
    sleepTargetMs: 60,
    minSleepMs: 40,
    maxSleepMs: 4000,
    abortTimerMs: 5000,
    timerHooks: hooks,
  })
  assert.equal(probe.timerProbeResult, 'NORMAL')
  const abortEntry = scheduled.find((entry) => entry.delay === 5000)
  assert.ok(abortEntry, 'abort timer was scheduled')
  assert.ok(cleared.includes(abortEntry.handle), 'abort timer handle was cleared — a leaked 15s timer would pollute the subsequent real request')
})

test('runTimerProbe ABORT_EARLY: a long abort timer firing during a short sleep is reported', async () => {
  const { hooks, scheduled, cleared } = countingTimerHooks()
  const probe = await runTimerProbe({
    sleepTargetMs: 80,
    minSleepMs: 1,
    maxSleepMs: 4000,
    abortTimerMs: 10,
    timerHooks: hooks,
  })
  assert.equal(probe.timerProbeResult, 'ABORT_EARLY')
  const abortEntry = scheduled.find((entry) => entry.delay === 10)
  assert.ok(cleared.includes(abortEntry.handle), 'abort timer cleared even on the anomaly path')
})

test('runTimerProbe CLOCK_ANOMALY: monotonic elapsed outside the plausible sleep window', async () => {
  let tick = 0n
  const fakeNowNs = () => {
    tick += 10_000_000_000n // each reading advances 10s: the 50ms sleep "took" 10s monotonically
    return tick
  }
  const probe = await runTimerProbe({
    sleepTargetMs: 50,
    minSleepMs: 30,
    maxSleepMs: 5000,
    abortTimerMs: 5000,
    nowNs: fakeNowNs,
  })
  assert.equal(probe.timerProbeResult, 'CLOCK_ANOMALY')
})

// ── Elapsed classification boundaries (hrtime.bigint buckets) ────────────────────────────────────

test('classifyElapsedNs pins every bucket boundary', () => {
  assert.equal(classifyElapsedNs(0n), 'LT_1S')
  assert.equal(classifyElapsedNs(999_999_999n), 'LT_1S')
  assert.equal(classifyElapsedNs(1_000_000_000n), '1_TO_14S')
  assert.equal(classifyElapsedNs(14_999_999_999n), '1_TO_14S')
  assert.equal(classifyElapsedNs(15_000_000_000n), '15_TO_20S')
  assert.equal(classifyElapsedNs(20_000_000_000n), '15_TO_20S')
  assert.equal(classifyElapsedNs(20_000_000_001n), 'GT_20S')
  assert.equal(classifyElapsedNs(-1n), 'UNAVAILABLE')
  assert.equal(classifyElapsedNs(1500), 'UNAVAILABLE')
})

// ── Rejection classification ─────────────────────────────────────────────────────────────────────

test('classifyRejection separates AbortError, TimeoutError, TypeError, and unknown rejections', () => {
  assert.deepEqual(classifyRejection(makeDomError('AbortError')), {
    authReadResult: 'ABORT_ERROR',
    typeErrorBoundary: 'NONE',
    abortErrorNameClass: 'ABORT_ERROR',
  })
  assert.deepEqual(classifyRejection(makeDomError('TimeoutError')), {
    authReadResult: 'ABORT_ERROR',
    typeErrorBoundary: 'NONE',
    abortErrorNameClass: 'TIMEOUT_ERROR',
  })
  const connectError = new TypeError('fetch failed')
  connectError.cause = { code: 'ECONNREFUSED' }
  assert.deepEqual(classifyRejection(connectError), {
    authReadResult: 'TYPE_ERROR',
    typeErrorBoundary: 'CONNECT',
    abortErrorNameClass: 'NONE',
  })
  assert.deepEqual(classifyRejection(new Error('weird')), {
    authReadResult: 'OTHER',
    typeErrorBoundary: 'NONE',
    abortErrorNameClass: 'OTHER',
  })
})

test('classifyTypeErrorBoundary maps closed cause-code families', () => {
  const withCause = (code) => {
    const error = new TypeError('fetch failed')
    error.cause = { code }
    return error
  }
  assert.equal(classifyTypeErrorBoundary(withCause('ENOTFOUND')), 'DNS')
  assert.equal(classifyTypeErrorBoundary(withCause('ECONNRESET')), 'CONNECT')
  assert.equal(classifyTypeErrorBoundary(withCause('UND_ERR_CONNECT_TIMEOUT')), 'CONNECT')
  assert.equal(classifyTypeErrorBoundary(withCause('ERR_TLS_CERT_ALTNAME_INVALID')), 'TLS')
  assert.equal(classifyTypeErrorBoundary(withCause('DEPTH_ZERO_SELF_SIGNED_CERT')), 'TLS')
  assert.equal(classifyTypeErrorBoundary(withCause('UND_ERR_HEADERS_TIMEOUT')), 'RESPONSE_READ')
  assert.equal(classifyTypeErrorBoundary(withCause('ERR_INVALID_URL')), 'INVALID_URL')
  assert.equal(classifyTypeErrorBoundary(withCause('SOMETHING_ELSE')), 'OTHER')
  assert.equal(classifyTypeErrorBoundary(new TypeError('bare')), 'FETCH_API')
})

test('classifyTypeErrorBoundary reads AggregateError members (Node >=20 connection-refused shape)', () => {
  const aggregate = new TypeError('fetch failed')
  const member = new Error('connect ECONNREFUSED')
  member.code = 'ECONNREFUSED'
  aggregate.cause = new AggregateError([member], 'aggregate connect failure')
  assert.equal(classifyTypeErrorBoundary(aggregate), 'CONNECT')

  const nested = new TypeError('fetch failed')
  const inner = new Error('socket hang up')
  inner.code = 'UND_ERR_SOCKET'
  nested.cause = { cause: inner }
  assert.equal(classifyTypeErrorBoundary(nested), 'CONNECT')
})

// ── Provenance seam against the REAL helper (2xx + helper-signal + outside-signal coverage) ──────

test('2xx path: real requestJson passes its own signal into fetchImpl; provenance stays NONE', async () => {
  const { fetchImpl, state } = buildProvenanceFetchImpl({
    baseUrl: BASE_URL,
    fetchDelegate: async (url, init) => {
      assert.ok(String(url).startsWith(BASE_URL))
      assert.ok(init.signal, 'helper must thread its AbortController signal through the seam')
      return jsonResponse(200)
    },
  })
  const response = await realRequestJson(BASE_URL, AUTH_READ_PATHNAME, {
    timeoutMs: 15000,
    label: 'probe-2xx',
    leakExempt: true,
    fetchImpl,
  })
  assert.equal(response.status, 200)
  assert.equal(state.requestCount, 1)
  assert.equal(state.networkTarget, 'INTERNAL_API_ONLY')
  assert.equal(state.helperSignalObserved, 'FALSE')
  assert.equal(deriveAbortProvenance({ authReadResult: 'HTTP_2XX', helperSignalObserved: state.helperSignalObserved }), 'NONE')
})

test('helper-signal abort: when the helper timer fires, provenance reports HELPER_SIGNAL', async () => {
  const { fetchImpl, state } = buildProvenanceFetchImpl({
    baseUrl: BASE_URL,
    fetchDelegate: (url, init) =>
      new Promise((resolve, reject) => {
        // Simulate undici: never respond; reject with AbortError only when the caller's signal fires.
        init.signal.addEventListener('abort', () => reject(makeDomError('AbortError')), { once: true })
      }),
  })
  await assert.rejects(
    // Short timeout here only to keep the test fast; the diagnostic's own contract (fixed 15000)
    // is pinned separately in the runDiagnostic test below.
    realRequestJson(BASE_URL, AUTH_READ_PATHNAME, { timeoutMs: 30, label: 'probe-abort', leakExempt: true, fetchImpl }),
    (error) => error.name === 'AbortError',
  )
  assert.equal(state.helperSignalObserved, 'TRUE')
  assert.equal(typeof state.helperSignalElapsedNs, 'bigint')
  assert.equal(deriveAbortProvenance({ authReadResult: 'ABORT_ERROR', helperSignalObserved: state.helperSignalObserved }), 'HELPER_SIGNAL')
})

test('outside-signal abort: an AbortError with the helper signal never firing is OUTSIDE_HELPER_SIGNAL', async () => {
  const { fetchImpl, state } = buildProvenanceFetchImpl({
    baseUrl: BASE_URL,
    fetchDelegate: async () => {
      throw makeDomError('AbortError') // aborted by something that is NOT the helper's controller
    },
  })
  await assert.rejects(
    realRequestJson(BASE_URL, AUTH_READ_PATHNAME, { timeoutMs: 15000, label: 'probe-outside', leakExempt: true, fetchImpl }),
    (error) => error.name === 'AbortError',
  )
  assert.equal(state.helperSignalObserved, 'FALSE', 'helper signal never fired')
  assert.equal(deriveAbortProvenance({ authReadResult: 'ABORT_ERROR', helperSignalObserved: state.helperSignalObserved }), 'OUTSIDE_HELPER_SIGNAL')
})

test('deriveAbortProvenance: non-abort outcomes report NONE; unobserved signal reports UNAVAILABLE', () => {
  assert.equal(deriveAbortProvenance({ authReadResult: 'HTTP_2XX', helperSignalObserved: 'FALSE' }), 'NONE')
  assert.equal(deriveAbortProvenance({ authReadResult: 'TYPE_ERROR', helperSignalObserved: 'FALSE' }), 'NONE')
  assert.equal(deriveAbortProvenance({ authReadResult: 'ABORT_ERROR', helperSignalObserved: 'UNAVAILABLE' }), 'UNAVAILABLE')
})

// ── Network accounting fail-closed ───────────────────────────────────────────────────────────────

test('externalWrite fail-closed: anything beyond exactly one internal request reports true', () => {
  assert.equal(deriveExternalWrite({ requestCount: 0, networkTarget: 'UNAVAILABLE' }), 'false')
  assert.equal(deriveExternalWrite({ requestCount: 1, networkTarget: 'INTERNAL_API_ONLY' }), 'false')
  assert.equal(deriveExternalWrite({ requestCount: 1, networkTarget: 'OTHER' }), 'true')
  assert.equal(deriveExternalWrite({ requestCount: 2, networkTarget: 'INTERNAL_API_ONLY' }), 'true')
})

test('provenance shim latches networkTarget=OTHER once any non-internal target is seen', async () => {
  const { fetchImpl, state } = buildProvenanceFetchImpl({ baseUrl: BASE_URL, fetchDelegate: async () => jsonResponse(200) })
  await fetchImpl(`${BASE_URL}/api/one`, {})
  await fetchImpl('http://93.184.216.34/exfil', {})
  await fetchImpl(`${BASE_URL}/api/two`, {})
  assert.equal(state.requestCount, 3)
  assert.equal(state.networkTarget, 'OTHER')
})

// ── Exact-SHA content binding (basename allowlist alone is not a binding) ────────────────────────

const OPS_DIR = path.dirname(fileURLToPath(import.meta.url))
const EXTENDED_BASENAME = 'stock-preparation-prep-line-extended-smoke.mjs'
const MVP_BASENAME = 'stock-preparation-mvp-postdeploy-smoke.mjs'

test('pinned digest constants: exactly the allowlisted basenames, 64-hex values, sibling map closed', () => {
  assert.deepEqual(Object.keys(HELPER_CONTENT_SHA256).sort(), [...HELPER_BASENAME_ALLOWLIST].sort())
  for (const digest of Object.values(HELPER_CONTENT_SHA256)) {
    assert.match(digest, /^[0-9a-f]{64}$/)
  }
  assert.deepEqual([...HELPER_SIBLING_REQUIREMENTS[EXTENDED_BASENAME]], [MVP_BASENAME])
  assert.deepEqual([...HELPER_SIBLING_REQUIREMENTS[MVP_BASENAME]], [])
})

test('repo-parity tripwire: the frozen smoke harnesses still hash to the release-pinned digests', async () => {
  for (const name of HELPER_BASENAME_ALLOWLIST) {
    const bytes = await readFile(path.join(OPS_DIR, name))
    const actual = createHash('sha256').update(bytes).digest('hex')
    assert.equal(
      actual,
      HELPER_CONTENT_SHA256[name],
      `${name} drifted from the RC-A exact-SHA content — editing the frozen smokes requires cutting a new pinned diagnostic release`,
    )
  }
})

async function makeHelperFixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rca-probe-fixture-'))
  await copyFile(path.join(OPS_DIR, EXTENDED_BASENAME), path.join(dir, EXTENDED_BASENAME))
  await copyFile(path.join(OPS_DIR, MVP_BASENAME), path.join(dir, MVP_BASENAME))
  return dir
}

test('verifyHelperContent: byte-exact copies PASS; any tamper of target or sibling FAILs closed', async () => {
  const dir = await makeHelperFixtureDir()
  assert.equal(await verifyHelperContent(path.join(dir, EXTENDED_BASENAME)), 'PASS')
  assert.equal(await verifyHelperContent(path.join(dir, MVP_BASENAME)), 'PASS')

  const sibling = path.join(dir, MVP_BASENAME)
  await writeFile(sibling, `${await readFile(sibling, 'utf8')}\n// tampered`)
  assert.equal(await verifyHelperContent(path.join(dir, EXTENDED_BASENAME)), 'FAIL', 'tampered sibling in the static import chain must FAIL')
  assert.equal(await verifyHelperContent(sibling), 'FAIL', 'tampered target must FAIL')

  const lonely = await mkdtemp(path.join(os.tmpdir(), 'rca-probe-lonely-'))
  await copyFile(path.join(OPS_DIR, EXTENDED_BASENAME), path.join(lonely, EXTENDED_BASENAME))
  assert.equal(await verifyHelperContent(path.join(lonely, EXTENDED_BASENAME)), 'FAIL', 'missing required sibling must FAIL')
  assert.equal(await verifyHelperContent(path.join(dir, 'evil-module.mjs')), 'FAIL', 'non-allowlisted basename must FAIL')
})

test('symlink bypass (owner round-3 repro): verify+import must resolve the SAME real files', async () => {
  // Real dir holds the genuine, byte-correct helper + sibling.
  const realDir = await makeHelperFixtureDir()
  // Attack dir: a byte-correct sibling copy, but the TARGET is a symlink into the real dir. The
  // pre-fix code verified the sibling from the symlink's own directory while Node would import the
  // sibling that lives beside the symlink's REAL target — a different file could execute unverified.
  const linkDir = await mkdtemp(path.join(os.tmpdir(), 'rca-probe-link-'))
  await symlink(path.join(realDir, EXTENDED_BASENAME), path.join(linkDir, EXTENDED_BASENAME))
  await copyFile(path.join(OPS_DIR, MVP_BASENAME), path.join(linkDir, MVP_BASENAME))

  const realDirCanonical = await realpath(realDir) // macOS /var -> /private/var
  const resolved = await resolveRealHelperFiles(path.join(linkDir, EXTENDED_BASENAME))
  assert.ok(resolved, 'symlink to a same-named real target resolves')
  assert.equal(resolved.realTarget, path.join(realDirCanonical, EXTENDED_BASENAME), 'target resolves into the REAL dir')
  assert.equal(resolved.dir, realDirCanonical, 'sibling verification directory is the real dir, not the link dir')
  for (const f of resolved.files) {
    assert.equal(path.dirname(f.realPath), realDirCanonical, `${f.name} is verified from the real dir Node will import from`)
  }
  // Byte-correct real files => PASS, and it is the real sibling that was hashed.
  assert.equal(await verifyHelperContent(path.join(linkDir, EXTENDED_BASENAME)), 'PASS')

  // Now tamper the REAL sibling: verification must FAIL even though the link-dir sibling is clean.
  const realSibling = path.join(realDir, MVP_BASENAME)
  await writeFile(realSibling, `${await readFile(realSibling, 'utf8')}\n// tampered real sibling`)
  assert.equal(
    await verifyHelperContent(path.join(linkDir, EXTENDED_BASENAME)),
    'FAIL',
    'the real sibling Node imports is tampered — a clean link-dir copy must not mask it',
  )
})

test('resolveRealHelperFiles refuses a symlink whose real target has a different logical name', async () => {
  const realDir = await makeHelperFixtureDir()
  const linkDir = await mkdtemp(path.join(os.tmpdir(), 'rca-probe-link2-'))
  // extended.mjs -> real mvp.mjs: logical name and real basename disagree; must refuse.
  await symlink(path.join(realDir, MVP_BASENAME), path.join(linkDir, EXTENDED_BASENAME))
  assert.equal(await resolveRealHelperFiles(path.join(linkDir, EXTENDED_BASENAME)), null)
  assert.equal(await verifyHelperContent(path.join(linkDir, EXTENDED_BASENAME)), 'FAIL')
})

test('resolveRealHelperFiles refuses a sibling that realpaths OUT of the target real directory', async () => {
  // Real target dir; its sibling is a symlink to a byte-correct copy in a DIFFERENT directory.
  // Node would import that escaped sibling; a content-only check would pass it. The residence guard
  // requires the executed sibling to live in the target's real dir under its own name, so it FAILs.
  const realDir = await mkdtemp(path.join(os.tmpdir(), 'rca-probe-escape-'))
  await copyFile(path.join(OPS_DIR, EXTENDED_BASENAME), path.join(realDir, EXTENDED_BASENAME))
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'rca-probe-elsewhere-'))
  await copyFile(path.join(OPS_DIR, MVP_BASENAME), path.join(elsewhere, MVP_BASENAME)) // byte-correct
  await symlink(path.join(elsewhere, MVP_BASENAME), path.join(realDir, MVP_BASENAME))
  assert.equal(
    await resolveRealHelperFiles(path.join(realDir, EXTENDED_BASENAME)),
    null,
    'a byte-correct sibling that escapes the pinned directory is still refused',
  )
  assert.equal(await verifyHelperContent(path.join(realDir, EXTENDED_BASENAME)), 'FAIL')
})

// ── Internal-target classification (origin, not string prefix) ───────────────────────────────────

test('isInternalTarget: same-origin only — the evil-suffix host is external', () => {
  assert.equal(isInternalTarget('http://internal.example/api/integration/status', 'http://internal.example'), true)
  assert.equal(isInternalTarget('http://internal.example:8081/api/x', 'http://internal.example:8081'), true)
  // The bug: startsWith would call this internal; origin comparison rejects it.
  assert.equal(isInternalTarget('http://internal.example.evil/api/x', 'http://internal.example'), false)
  assert.equal(isInternalTarget('http://internal.example:9999/api/x', 'http://internal.example:8081'), false)
  assert.equal(isInternalTarget('https://internal.example/api/x', 'http://internal.example'), false)
  assert.equal(isInternalTarget('not a url', 'http://internal.example'), false)
  // Base with a path prefix: only true subpaths are internal.
  assert.equal(isInternalTarget('http://h/base/api', 'http://h/base'), true)
  assert.equal(isInternalTarget('http://h/baseevil/api', 'http://h/base'), false)
})

test('provenance shim uses origin classification: evil-suffix target latches OTHER', async () => {
  const { fetchImpl, state } = buildProvenanceFetchImpl({ baseUrl: 'http://internal.example', fetchDelegate: async () => jsonResponse(200) })
  await fetchImpl('http://internal.example.evil/api/x', {})
  assert.equal(state.networkTarget, 'OTHER')
})

test('runDiagnostic on a content mismatch: BLOCKED/HELPER_MISMATCH, zero imports, zero requests', async () => {
  let importCalls = 0
  let fetchCalls = 0
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: async () => 'FAIL',
    importImpl: async () => {
      importCalls += 1
      return { requestJson: async () => jsonResponse(200) }
    },
    fetchDelegate: async () => {
      fetchCalls += 1
      return jsonResponse(200)
    },
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.helperContentVerified, 'FAIL')
  assert.equal(fields.executionState, 'DIAGNOSTIC_BLOCKED')
  assert.equal(fields.blockedReasonClass, 'HELPER_MISMATCH')
  assert.equal(fields.fileUrlImport, 'UNAVAILABLE', 'no dynamic import may run on unverified content')
  assert.equal(fields.networkRequestCount, '0')
  assert.equal(importCalls, 0)
  assert.equal(fetchCalls, 0)
})

test('runDiagnostic zero-request closure: verified + imported but no dispatch is BLOCKED/NO_REQUEST, never COMPLETE', async () => {
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: async () => 'PASS',
    importImpl: () => import('./stock-preparation-prep-line-extended-smoke.mjs'),
    fetchDelegate: null, // a runtime without fetch: request phase must not silently pass as COMPLETE
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.fileUrlImport, 'PASS')
  assert.equal(fields.networkRequestCount, '0')
  assert.equal(fields.executionState, 'DIAGNOSTIC_BLOCKED')
  assert.equal(fields.blockedReasonClass, 'NO_REQUEST')
})

// A stand-in helper whose requestJson dispatches through the provided fetchImpl N times to whichever
// targets — used to prove the closure rejects anything but exactly one clean internal request.
function multiDispatchHelperImport(targets) {
  return async () => ({
    requestJson: async (baseUrl, pathname, opts) => {
      let last
      for (const t of targets) {
        last = await opts.fetchImpl(t === 'INTERNAL' ? `${baseUrl}${pathname}` : t, { signal: new AbortController().signal })
      }
      return last
    },
  })
}

test('runDiagnostic REQUEST_ANOMALY: two dispatches never read as COMPLETE (externalWrite=true, exit-2 posture)', async () => {
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: async () => 'PASS',
    importImpl: multiDispatchHelperImport(['INTERNAL', 'INTERNAL']),
    fetchDelegate: async () => jsonResponse(200),
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.networkRequestCount, 'OTHER')
  assert.equal(fields.externalWrite, 'true')
  assert.equal(fields.executionState, 'DIAGNOSTIC_BLOCKED')
  assert.equal(fields.blockedReasonClass, 'REQUEST_ANOMALY')
})

test('runDiagnostic REQUEST_ANOMALY: one dispatch to a non-internal target is not COMPLETE', async () => {
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: async () => 'PASS',
    importImpl: multiDispatchHelperImport(['http://exfil.example/x']),
    fetchDelegate: async () => jsonResponse(200),
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.networkRequestCount, '1')
  assert.equal(fields.networkTarget, 'OTHER')
  assert.equal(fields.externalWrite, 'true')
  assert.equal(fields.executionState, 'DIAGNOSTIC_BLOCKED')
  assert.equal(fields.blockedReasonClass, 'REQUEST_ANOMALY')
})

// ── End-to-end runDiagnostic ─────────────────────────────────────────────────────────────────────

const REAL_HELPER_IMPORT = () => import('./stock-preparation-prep-line-extended-smoke.mjs')
const VERIFY_PASS = async () => 'PASS'

test('runDiagnostic 2xx end-to-end: fixed 15000 reaches the real helper call site', async () => {
  let seenOptions = null
  const importImpl = async () => {
    const mod = await REAL_HELPER_IMPORT()
    return {
      requestJson: (baseUrl, pathname, options) => {
        seenOptions = options
        return mod.requestJson(baseUrl, pathname, options)
      },
    }
  }
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: 't1' },
    token: 'tok_secret_1',
    verifyImpl: VERIFY_PASS,
    importImpl,
    fetchDelegate: async (url) => {
      assert.ok(String(url).includes('tenantId=t1'), 'tenant scope rides the query like the smoke AUTH shape')
      return jsonResponse(200)
    },
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(seenOptions.timeoutMs, 15000, 'the fixed timeout constant must reach the helper unchanged')
  assert.equal(seenOptions.leakExempt, true)
  assert.equal(typeof seenOptions.fetchImpl, 'function')
  assert.equal(fields.executionState, 'DIAGNOSTIC_COMPLETE')
  assert.equal(fields.fileUrlImport, 'PASS')
  assert.equal(fields.timerProbeResult, 'NORMAL')
  assert.equal(fields.networkRequestCount, '1')
  assert.equal(fields.networkTarget, 'INTERNAL_API_ONLY')
  assert.equal(fields.authReadResult, 'HTTP_2XX')
  assert.equal(fields.abortProvenance, 'NONE')
  assert.equal(fields.externalWrite, 'false')
  assert.equal(fields.timeoutArgumentMs, '15000')
  assert.equal(fields.flagTouched, 'false')
})

test('runDiagnostic outside-signal abort end-to-end classifies ABORT_ERROR + OUTSIDE_HELPER_SIGNAL', async () => {
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: VERIFY_PASS,
    importImpl: REAL_HELPER_IMPORT,
    fetchDelegate: async () => {
      throw makeDomError('AbortError')
    },
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.authReadResult, 'ABORT_ERROR')
  assert.equal(fields.abortErrorNameClass, 'ABORT_ERROR')
  assert.equal(fields.abortProvenance, 'OUTSIDE_HELPER_SIGNAL')
  assert.equal(fields.elapsedClass, 'LT_1S')
  assert.equal(fields.executionState, 'DIAGNOSTIC_COMPLETE')
})

test('runDiagnostic import failure blocks the request phase entirely', async () => {
  let delegateCalls = 0
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: VERIFY_PASS,
    importImpl: async () => {
      throw new Error('module not found')
    },
    fetchDelegate: async () => {
      delegateCalls += 1
      return jsonResponse(200)
    },
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.fileUrlImport, 'FAIL')
  assert.equal(fields.executionState, 'DIAGNOSTIC_BLOCKED')
  assert.equal(fields.blockedReasonClass, 'IMPORT')
  assert.equal(fields.networkRequestCount, '0')
  assert.equal(delegateCalls, 0, 'no request may be dispatched when the helper import failed')
})

test('runDiagnostic import of a module without requestJson is also an import failure', async () => {
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: VERIFY_PASS,
    importImpl: async () => ({ somethingElse: true }),
    fetchDelegate: async () => jsonResponse(200),
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.fileUrlImport, 'FAIL')
  assert.equal(fields.executionState, 'DIAGNOSTIC_BLOCKED')
})

test('runDiagnostic on an anomalous runtime surface still completes with identity fields', async () => {
  const fields = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    runtimeSurface: { versions: { node: '21.7.0', bun: '1.1.0' }, bunGlobal: true, denoGlobal: false },
    verifyImpl: VERIFY_PASS,
    importImpl: REAL_HELPER_IMPORT,
    fetchDelegate: async () => jsonResponse(200),
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(fields.runtimeIdentity, 'BUN')
  assert.equal(fields.nodeMajorClass, 'OTHER')
  assert.equal(fields.executionState, 'DIAGNOSTIC_COMPLETE')
})

test('runDiagnostic classifies 4xx/5xx and TypeError CONNECT outcomes', async () => {
  const run = (fetchDelegate) =>
    runDiagnostic({
      args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
      verifyImpl: VERIFY_PASS,
      importImpl: REAL_HELPER_IMPORT,
      fetchDelegate,
      timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
    })
  const unauthorized = await run(async () => jsonResponse(401))
  assert.equal(unauthorized.authReadResult, 'HTTP_4XX')
  const failing = await run(async () => jsonResponse(500))
  assert.equal(failing.authReadResult, 'HTTP_5XX')
  const refused = await run(async () => {
    const error = new TypeError('fetch failed')
    error.cause = { code: 'ECONNREFUSED' }
    throw error
  })
  assert.equal(refused.authReadResult, 'TYPE_ERROR')
  assert.equal(refused.typeErrorBoundary, 'CONNECT')
  assert.equal(refused.abortProvenance, 'NONE')
})

// ── v2 acceleration: 4XX sub-classification (one dispositive run) ─────────────────────────────────

test('classifyAuthReadStatusClass splits 401/403/404/409 from other 4xx', () => {
  assert.equal(classifyAuthReadStatusClass(200), 'HTTP_2XX')
  assert.equal(classifyAuthReadStatusClass(204), 'HTTP_2XX')
  assert.equal(classifyAuthReadStatusClass(401), 'HTTP_401')
  assert.equal(classifyAuthReadStatusClass(403), 'HTTP_403')
  assert.equal(classifyAuthReadStatusClass(404), 'HTTP_404')
  assert.equal(classifyAuthReadStatusClass(409), 'HTTP_409')
  assert.equal(classifyAuthReadStatusClass(400), 'HTTP_4XX_OTHER')
  assert.equal(classifyAuthReadStatusClass(429), 'HTTP_4XX_OTHER')
  assert.equal(classifyAuthReadStatusClass(500), 'HTTP_5XX')
  assert.equal(classifyAuthReadStatusClass(302), 'OTHER')
  assert.equal(classifyAuthReadStatusClass(undefined), 'UNAVAILABLE')
})

test('classifyAuthReadReasonClass maps ONLY the server closed error codes; anything else -> OTHER', () => {
  // 2xx has no reason.
  assert.equal(classifyAuthReadReasonClass(200, { ok: true }), 'NONE')
  // the four codebase-mapped codes pass through verbatim.
  assert.deepEqual([...AUTH_READ_REASON_ALLOWLIST], ['UNAUTHORIZED', 'PASSWORD_CHANGE_REQUIRED', 'UNAUTHENTICATED', 'FORBIDDEN'])
  assert.equal(classifyAuthReadReasonClass(401, { ok: false, error: { code: 'UNAUTHORIZED' } }), 'UNAUTHORIZED')
  assert.equal(classifyAuthReadReasonClass(403, { ok: false, error: { code: 'PASSWORD_CHANGE_REQUIRED' } }), 'PASSWORD_CHANGE_REQUIRED')
  assert.equal(classifyAuthReadReasonClass(401, { ok: false, error: { code: 'UNAUTHENTICATED' } }), 'UNAUTHENTICATED')
  assert.equal(classifyAuthReadReasonClass(403, { ok: false, error: { code: 'FORBIDDEN' } }), 'FORBIDDEN')
  // values-free by construction: an unknown or business-shaped code folds to OTHER.
  assert.equal(classifyAuthReadReasonClass(403, { ok: false, error: { code: 'MAT-001-SECRET' } }), 'OTHER')
  assert.equal(classifyAuthReadReasonClass(404, { ok: false, error: {} }), 'OTHER')
  assert.equal(classifyAuthReadReasonClass(404, null), 'OTHER')
  assert.equal(classifyAuthReadReasonClass(400, { error: { code: 42 } }), 'OTHER')
})

test('runDiagnostic v2: one run is dispositive — the four 4XX sub-classes come through end to end', async () => {
  const run = (status, code) =>
    runDiagnostic({
      args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
      verifyImpl: VERIFY_PASS,
      importImpl: REAL_HELPER_IMPORT,
      fetchDelegate: async () => jsonResponse(status, JSON.stringify({ ok: false, error: { code } })),
      timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
    })
  const tokenBad = await run(401, 'UNAUTHORIZED')
  assert.equal(tokenBad.authReadStatusClass, 'HTTP_401')
  assert.equal(tokenBad.authReadReasonClass, 'UNAUTHORIZED')
  const pwChange = await run(403, 'PASSWORD_CHANGE_REQUIRED')
  assert.equal(pwChange.authReadStatusClass, 'HTTP_403')
  assert.equal(pwChange.authReadReasonClass, 'PASSWORD_CHANGE_REQUIRED')
  const forbidden = await run(403, 'FORBIDDEN')
  assert.equal(forbidden.authReadStatusClass, 'HTTP_403')
  assert.equal(forbidden.authReadReasonClass, 'FORBIDDEN')

  // success arm: 2xx -> NONE, and the run reports DIAGNOSTIC_COMPLETE (fast-track eligible).
  const ok = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: VERIFY_PASS,
    importImpl: REAL_HELPER_IMPORT,
    fetchDelegate: async () => jsonResponse(200, JSON.stringify({ ok: true, data: {} })),
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(ok.authReadResult, 'HTTP_2XX')
  assert.equal(ok.authReadStatusClass, 'HTTP_2XX')
  assert.equal(ok.authReadReasonClass, 'NONE')
  assert.equal(ok.executionState, 'DIAGNOSTIC_COMPLETE')

  // transport rejection: no HTTP response to sub-classify.
  const aborted = await runDiagnostic({
    args: { helperPath: 'x/stock-preparation-prep-line-extended-smoke.mjs', baseUrl: BASE_URL, tenantId: '' },
    verifyImpl: VERIFY_PASS,
    importImpl: REAL_HELPER_IMPORT,
    fetchDelegate: async () => { throw makeDomError('AbortError') },
    timerProbeOverrides: { sleepTargetMs: 40, minSleepMs: 20, maxSleepMs: 4000, abortTimerMs: 2000 },
  })
  assert.equal(aborted.authReadStatusClass, 'UNAVAILABLE')
  assert.equal(aborted.authReadReasonClass, 'UNAVAILABLE')
})

// ── Pathname shape ───────────────────────────────────────────────────────────────────────────────

test('buildAuthReadPathname mirrors the smoke AUTH shape: bare path, tenant via query when scoped', () => {
  assert.equal(buildAuthReadPathname(''), AUTH_READ_PATHNAME)
  assert.equal(buildAuthReadPathname('t1'), `${AUTH_READ_PATHNAME}?tenantId=t1`)
})

// ── Token scrub (belt-and-suspenders over the closed vocabulary) ─────────────────────────────────

test('composeScrubbedBlock: PASS when token absent from render, NOT_USED when no token', () => {
  const clean = composeScrubbedBlock(baselineFields(), 'tok_never_rendered')
  assert.ok(clean.includes('tokenScrubbed=PASS'))
  assert.ok(!clean.includes('tok_never_rendered'))
  const untokened = composeScrubbedBlock(baselineFields(), '')
  assert.ok(untokened.includes('tokenScrubbed=NOT_USED'))
})

test('composeScrubbedBlock: a token colliding with rendered text flips to FAIL and is scrubbed', () => {
  // Adversarial collision: a "token" equal to a vocabulary word must still never survive printing.
  const rendered = composeScrubbedBlock(baselineFields(), 'DIAGNOSTIC_COMPLETE')
  assert.ok(rendered.includes('tokenScrubbed=FAIL'))
  assert.ok(!rendered.includes('DIAGNOSTIC_COMPLETE'))
  assert.ok(rendered.includes(TOKEN_SCRUB_SENTINEL))
})
