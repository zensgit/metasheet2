// stock-preparation-scheduled-pull.test.mjs — the ops script's own suite.
//
// TWO STYLES, DELIBERATELY.
//
//   (a) THE CLI/PROCESS BOUNDARY — env var validation, --help, and the tenant-claim refusal that
//       costs zero HTTP calls — is exercised as a REAL subprocess (`spawnSync('node', [SCRIPT_PATH]
//       ...`), the same convention every other scripts/ops/*.test.mjs in this repo uses. These never
//       touch the network, so they are safe here.
//   (b) EVERYTHING THAT NEEDS AN HTTP ROUND TRIP is exercised IN-PROCESS: the module is imported
//       directly (its `main`/`pullOneProject`/etc. are guarded to run ONLY when the file is the
//       process entry point — see the `isEntryPoint` check at the bottom of the script — so importing
//       it here does not also invoke the CLI or call `process.exit`), and `globalThis.fetch` is
//       replaced with a recording stub for the duration of each test. This was a deliberate choice,
//       not a shortcut: on this Windows workstation, a REAL two-level process nesting — this test
//       process hosting an `http.createServer` and a `spawnSync`-launched CHILD process trying to
//       `fetch()` back into it — hangs indefinitely (`spawnSync ETIMEDOUT`) regardless of the Claude
//       Code sandbox setting, reproduced identically via both the Bash and PowerShell tool and via a
//       plain two-file parent/child script with no test framework involved at all. That is a local
//       environment restriction (very likely endpoint-security software intercepting a freshly
//       spawned, unrecognized `node.exe`'s outbound sockets), not a defect in the script under test —
//       CI (Linux) is not expected to have it, matching this repo's existing "local Windows sandbox
//       vs. CI" pattern for a handful of other suites. Testing the HTTP client logic in-process next
//       to a real subprocess-boundary test for everything that does NOT need the network gives full
//       coverage of both halves without depending on that networking behaving a particular way here.
//
// WHAT THIS PINS:
//   * missing required env var(s) -> non-zero exit, no HTTP call made.
//   * ready + --apply -> apply is POSTed in the SAME run, carrying the SAME dryRunToken the dry-run
//     just returned.
//   * manual_confirm_required -> recorded, apply is NEVER called.
//   * large_bom_bounded -> recorded as skipped, apply is NEVER called.
//   * not_found -> recorded, apply is NEVER called.
//   * an HTTP 500 (or any dry-run/apply failure) -> that project is marked failed and the run's exit
//     code is non-zero, but other projects in the same run still get processed.
//   * MS_TOKEN never appears anywhere in stdout or stderr, under any scenario.
//   * a token with no `tenantId` claim is refused (non-zero exit, ZERO HTTP calls) unless
//     --allow-tenantless is passed, in which case it proceeds and warns on stderr.
//   * a token WITH a tenantId claim runs normally.

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// `fileURLToPath`, not `new URL(...).pathname` — on Windows the latter yields `/C:/Users/...` (a
// leading slash before the drive letter), which `path.dirname`/`path.resolve` then mangle into a
// bogus path and break every subprocess spawn below.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'stock-preparation-scheduled-pull.mjs')

// Dynamic `import()` (not a static one) so the module's `isEntryPoint` guard sees `process.argv[1]`
// as THIS test file, never the script — a static import would behave identically here, but dynamic
// keeps the intent explicit: this is a plain module load, not "run the CLI".
const { main, __setOutputSinksForTesting } = await import(pathToFileURL(SCRIPT_PATH).href)

function base64Url(input) {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A minimal unsigned JWT shape — the script only ever decodes the payload, never verifies. */
function makeToken(payload) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64Url(JSON.stringify(payload))
  return `${header}.${body}.unsigned`
}

const TENANT_TOKEN = makeToken({ sub: 'svc-account-1', tenantId: 'tenant-a' })
const TENANTLESS_TOKEN = makeToken({ sub: 'svc-account-platform-admin' })

function runScript(args, env) {
  return spawnSync('node', [SCRIPT_PATH, ...args], {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

// ---------------------------------------------------------------------------
// (a) REAL SUBPROCESS — the CLI boundary, no network involved
// ---------------------------------------------------------------------------

test('missing every required env var exits non-zero and names them, with no HTTP call', () => {
  const result = runScript([], { MS_API: '', MS_TOKEN: '', MS_TENANT_ID: '', MS_PROJECT_NOS: '' })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /MS_API/)
  assert.match(result.stderr, /MS_TOKEN/)
  assert.match(result.stderr, /MS_PROJECT_NOS/)
})

test('missing only MS_PROJECT_NOS is named on its own', () => {
  const result = runScript([], { MS_API: 'http://127.0.0.1:1', MS_TOKEN: TENANT_TOKEN, MS_TENANT_ID: 'tenant-a', MS_PROJECT_NOS: '' })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /MS_PROJECT_NOS/)
  assert.doesNotMatch(result.stderr, /MS_API is|MS_API,/)
  assert.doesNotMatch(result.stderr, /MS_TOKEN is|MS_TOKEN,/)
})

test('a token with no tenantId claim is refused before any HTTP call is made (real subprocess)', () => {
  // MS_API deliberately points at a port nothing listens on: if the script tried to make an HTTP
  // call despite the refusal, this would hang/timeout rather than exit quickly with the refusal text.
  const result = runScript([], {
    MS_API: 'http://127.0.0.1:1',
    MS_TOKEN: TENANTLESS_TOKEN,
    MS_TENANT_ID: 'tenant-a',
    MS_PROJECT_NOS: 'P-1',
  })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /tenantId claim/)
  assert.doesNotMatch(result.stdout, new RegExp(TENANTLESS_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(result.stderr, new RegExp(TENANTLESS_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('--help prints usage and exits 0 without any env vars', () => {
  const result = runScript(['--help'], { MS_API: '', MS_TOKEN: '', MS_TENANT_ID: '', MS_PROJECT_NOS: '' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Usage:/)
})

test('an unknown flag is refused with a non-zero exit, and its VALUE is never echoed', () => {
  const result = runScript(['--nonsense'], { MS_API: 'http://127.0.0.1:1', MS_TOKEN: TENANT_TOKEN, MS_TENANT_ID: 'tenant-a', MS_PROJECT_NOS: 'P-1' })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  // The POSITION is reported (useful for finding the offending argument), the VALUE is not — see the
  // next test for why: an accidentally-passed credential must never land in stderr just because it
  // showed up where a flag was expected.
  assert.match(result.stderr, /position 0/)
  assert.doesNotMatch(result.stderr, /--nonsense/)
})

test('a credential accidentally passed as a CLI argument (not an env var) is never echoed', () => {
  // Simulates the exact mistake this refusal exists to be safe under: someone runs the script with
  // the token as a bare positional argument (e.g. copy-pasted the wrong line from a runbook) instead
  // of setting MS_TOKEN. `parseArgs` rejects it as an unrecognized argument — correctly, it is not a
  // flag — and must not put it in stderr on the way out.
  const looksLikeATokenButIsNot = TENANT_TOKEN
  const result = runScript([looksLikeATokenButIsNot], {
    MS_API: 'http://127.0.0.1:1', MS_TOKEN: TENANT_TOKEN, MS_TENANT_ID: 'tenant-a', MS_PROJECT_NOS: 'P-1',
  })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, new RegExp(TENANT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result.stderr, /position 0/)
})

// ---------------------------------------------------------------------------
// (b) IN-PROCESS — everything that needs an HTTP round trip, via a mocked fetch
// ---------------------------------------------------------------------------

/**
 * Installs a recording `fetch` stub for the duration of `run(...)`, restoring the real (absent, in
 * this test process — Node's global fetch is left untouched otherwise) one afterwards regardless of
 * whether `run` throws.
 *
 * `handler(record)` returns one of:
 *   - `{ status, json }` (status defaults to 200) — an ordinary response.
 *   - `{ throw: error }` — the fetch call itself rejects with `error`, simulating a network/client-side
 *     failure (used to reproduce the exact `Headers.append` `TypeError` shape the redaction tests
 *     below are pinned against).
 *   - `{ hangBody: true, status }` — `fetch(...)` itself resolves promptly (status line/headers
 *     "arrived"), but the returned response's `.json()` never resolves on its own — only the SAME
 *     `AbortSignal` races it down. This is what distinguishes a CONNECT-phase timeout (the top-level
 *     `fetch()` call never resolves) from a BODY-phase one (headers arrived, the body then trickled
 *     too slowly) — `postJson` must classify both as `'timeout'`, not just the first.
 *   - a promise that never settles — simulating a hung backend at the connect phase, to exercise the
 *     script's own `AbortSignal.timeout` handling below.
 *
 * THE MOCK HONOURS `init.signal`, deliberately: `postJson` passes a REAL `AbortSignal.timeout(...)`
 * (not a mock — timers/abort are native, this file never stubs them), so a handler that hangs forever
 * must still be racing against that real signal exactly as the real `fetch` would, or the timeout
 * tests below would not be testing anything.
 */
async function withMockFetch(handler, run) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    let settled = false
    const settleResolve = (value) => { if (!settled) { settled = true; resolve(value) } }
    const settleReject = (error) => { if (!settled) { settled = true; reject(error) } }

    const signal = init.signal
    const abortErrorFor = () => (signal && signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    if (signal) {
      const onAbort = () => settleReject(abortErrorFor())
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    ;(async () => {
      let body = null
      try { body = init.body ? JSON.parse(init.body) : null } catch { body = null }
      const record = { url: String(url), method: init.method, headers: init.headers || {}, body }
      requests.push(record)
      const outcome = await handler(record)
      if (outcome && outcome.throw) {
        settleReject(outcome.throw)
        return
      }
      if (outcome && outcome.hangBody) {
        // The OUTER promise settles now (headers "arrived"); `.json()` below is its own promise that
        // only the abort signal can ever settle — nothing else resolves it, by design.
        settleResolve({
          ok: true,
          status: outcome.status || 200,
          json: () => new Promise((_bodyResolve, bodyReject) => {
            if (!signal) return // would hang forever — every caller here passes a real timeout signal
            if (signal.aborted) { bodyReject(abortErrorFor()); return }
            signal.addEventListener('abort', () => bodyReject(abortErrorFor()), { once: true })
          }),
        })
        return
      }
      const result = outcome || {}
      const status = result.status || 200
      const json = result.json !== undefined ? result.json : { ok: true, data: {} }
      settleResolve({
        ok: status >= 200 && status < 300,
        status,
        async json() { return json },
      })
    })().catch(settleReject)
  })
  try {
    return { requests, result: await run() }
  } finally {
    globalThis.fetch = original
  }
}

/** Captures everything `process.stdout.write` / `process.stderr.write` would have sent. */
// Uses the module's OWN `__setOutputSinksForTesting` seam — NOT a global monkey-patch of
// `process.stdout.write` — precisely because a global patch races with Node's own `node:test` runner:
// several tests below span a REAL timer wait (the script's `AbortSignal.timeout`, or a mock racing
// against it), and the runner flushes a PREVIOUS test's own reporter line through that same
// process-wide stream during that window. A global patch captures the runner's output right along
// with the script's, corrupting the captured text non-deterministically. Swapping the script's sinks
// instead never touches the real stream, so there is nothing for the runner's own output to collide
// with. (This was found the hard way — see the module's own header comment for the seam's rationale.)
function captureOutput() {
  const stdout = []
  const stderr = []
  const restore = __setOutputSinksForTesting({
    stdout: (text) => { stdout.push(String(text)) },
    stderr: (text) => { stderr.push(String(text)) },
  })
  return {
    restore,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  }
}

function jsonLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function runMain(args, env) {
  const capture = captureOutput()
  try {
    const code = await main(args, env)
    return { code, stdout: capture.stdoutText(), stderr: capture.stderrText() }
  } finally {
    capture.restore()
  }
}

const BASE_ENV = { MS_API: 'http://stub.invalid', MS_TOKEN: TENANT_TOKEN, MS_TENANT_ID: 'tenant-a', MS_PROJECT_NOS: 'P-1' }

test('ready + --apply posts apply in the SAME run, carrying the SAME dryRunToken', async () => {
  const { requests, result } = await withMockFetch(
    (record) => {
      if (record.url.includes('/dry-run')) {
        return {
          json: {
            ok: true,
            data: {
              status: 'ready',
              canApply: true,
              largeBom: false,
              dryRunToken: 'tok_abc123',
              revision: 'rev_7',
              counts: { add: 3, update: 1, inactive: 0, skip: 5, manual_confirm: 0 },
            },
          },
        }
      }
      if (record.url.includes('/apply')) {
        return { json: { ok: true, data: { counts: { created: 3, updated: 1, inactive: 0, skipped: 5, failed: 0 } } } }
      }
      return { status: 404, json: { ok: false, error: { code: 'NOT_FOUND' } } }
    },
    () => runMain(['--apply'], { ...BASE_ENV, MS_PROJECT_NOS: 'P-READY' }),
  )

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(requests.length, 2, 'exactly one dry-run and one apply')
  const applyRequest = requests.find((r) => r.url.includes('/apply'))
  assert.ok(applyRequest, 'apply was called')
  assert.equal(applyRequest.body.confirm.dryRunToken, 'tok_abc123', 'apply carries the SAME token dry-run returned')
  assert.equal(applyRequest.body.confirm.dryRunRevision, 'rev_7')
  assert.equal(applyRequest.body.parameters.projectNo, 'P-READY')
  assert.equal(applyRequest.headers.authorization, `Bearer ${TENANT_TOKEN}`)
  assert.equal(applyRequest.headers['x-tenant-id'], 'tenant-a')

  const lines = jsonLines(result.stdout)
  assert.equal(lines.length, 2, 'one project line + one summary line')
  assert.equal(lines[0].projectNo, 'P-READY')
  assert.equal(lines[0].action, 'applied')
  assert.equal(lines[1].summary.applied, 1)
  assert.equal(lines[1].summary.failed, 0)
})

test('ready WITHOUT --apply never calls apply', async () => {
  const { requests, result } = await withMockFetch(
    (record) => {
      if (record.url.includes('/dry-run')) {
        return { json: { ok: true, data: { status: 'ready', canApply: true, dryRunToken: 'tok_never_used', revision: 'rev_1', counts: {} } } }
      }
      return { status: 500, json: { ok: false, error: { code: 'SHOULD_NOT_BE_CALLED' } } }
    },
    () => runMain([], BASE_ENV),
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(requests.length, 1, 'dry-run-only default never calls apply')
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'skipped_dry_run_only')
})

test('manual_confirm_required is recorded and NEVER applied, even with --apply', async () => {
  const { requests, result } = await withMockFetch(
    (record) => {
      if (record.url.includes('/dry-run')) {
        return { json: { ok: true, data: { status: 'manual_confirm_required', canApply: false, counts: { manual_confirm: 2 } } } }
      }
      return { status: 500, json: { ok: false, error: { code: 'SHOULD_NOT_BE_CALLED' } } }
    },
    () => runMain(['--apply'], BASE_ENV),
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(requests.length, 1, 'apply is never reached')
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'skipped_manual_confirm_required')
  assert.equal(lines[1].summary.skippedManualConfirmRequired, 1)
  assert.equal(lines[1].summary.failed, 0)
})

test('large_bom_bounded is recorded as skipped and NEVER applied', async () => {
  const { requests, result } = await withMockFetch(
    (record) => {
      if (record.url.includes('/dry-run')) {
        return { json: { ok: true, data: { status: 'large_bom_bounded', canApply: false, largeBom: true, counts: {} } } }
      }
      return { status: 500, json: { ok: false, error: { code: 'SHOULD_NOT_BE_CALLED' } } }
    },
    () => runMain(['--apply'], BASE_ENV),
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(requests.length, 1)
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'skipped_large_bom_bounded')
  assert.equal(lines[1].summary.skippedLargeBomBounded, 1)
})

test('not_found is recorded, not treated as a failure', async () => {
  const { result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found', canApply: false, counts: {} } } }),
    () => runMain([], BASE_ENV),
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'skipped_not_found')
  assert.equal(lines[1].summary.skippedNotFound, 1)
})

test('an HTTP 500 on dry-run marks that project failed and exits non-zero', async () => {
  const { result } = await withMockFetch(
    () => ({ status: 500, json: { ok: false, error: { code: 'INTERNAL', message: 'boom' } } }),
    () => runMain([], BASE_ENV),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'error')
  assert.equal(lines[0].failed, true)
  assert.equal(lines[1].summary.failed, 1)
})

test('an apply failure (HTTP 500) marks that project failed even though dry-run succeeded', async () => {
  const { result } = await withMockFetch(
    (record) => {
      if (record.url.includes('/dry-run')) {
        return { json: { ok: true, data: { status: 'ready', canApply: true, dryRunToken: 'tok_x', revision: 'r1', counts: {} } } }
      }
      return { status: 500, json: { ok: false, error: { code: 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH' } } }
    },
    () => runMain(['--apply'], BASE_ENV),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'error')
  assert.equal(lines[0].failed, true)
  assert.match(lines[0].error, /TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH/)
})

test('one failing project does not stop the others in the same run', async () => {
  const { requests, result } = await withMockFetch(
    (record) => {
      const projectNo = record.body && record.body.parameters && record.body.parameters.projectNo
      if (projectNo === 'P-BAD') return { status: 500, json: { ok: false, error: { code: 'INTERNAL' } } }
      return { json: { ok: true, data: { status: 'not_found', canApply: false, counts: {} } } }
    },
    () => runMain([], { ...BASE_ENV, MS_PROJECT_NOS: 'P-BAD,P-GOOD' }),
  )
  assert.notEqual(result.code, 0)
  assert.equal(requests.length, 2, 'both projects were dry-run despite the first failing')
  const lines = jsonLines(result.stdout)
  assert.equal(lines.length, 3, 'two project lines + one summary line')
  assert.equal(lines[0].projectNo, 'P-BAD')
  assert.equal(lines[0].failed, true)
  assert.equal(lines[1].projectNo, 'P-GOOD')
  assert.equal(lines[1].action, 'skipped_not_found')
  assert.equal(lines[2].summary.failed, 1)
  assert.equal(lines[2].summary.projectCount, 2)
})

// ---------------------------------------------------------------------------
// the token must NEVER appear in output — checked across every outcome shape
// ---------------------------------------------------------------------------

test('MS_TOKEN never appears in stdout or stderr, across every scenario', async () => {
  const tokenPattern = new RegExp(TENANT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const scenarios = [
    { args: ['--apply'], dryRun: { status: 'ready', canApply: true, dryRunToken: 'tok_x', revision: 'r1', counts: {} }, apply: { counts: {} } },
    { args: [], dryRun: { status: 'manual_confirm_required', canApply: false, counts: {} } },
    { args: [], dryRun: { status: 'large_bom_bounded', canApply: false, counts: {} } },
    { args: [], dryRun: { status: 'not_found', canApply: false, counts: {} } },
  ]
  for (const scenario of scenarios) {
    const { result } = await withMockFetch(
      (record) => {
        if (record.url.includes('/apply')) return { json: { ok: true, data: scenario.apply || {} } }
        return { json: { ok: true, data: scenario.dryRun } }
      },
      () => runMain(scenario.args, BASE_ENV),
    )
    assert.doesNotMatch(result.stdout, tokenPattern)
    assert.doesNotMatch(result.stderr, tokenPattern)
    assert.doesNotMatch(result.stdout, /Bearer /, 'the header VALUE must never be echoed either')
  }
})

/** No 16-character (or longer) substring of `token` may appear anywhere in `text`. */
function assertNoTokenSubstring(token, text, label) {
  const WINDOW = 16
  for (let i = 0; i + WINDOW <= token.length; i += 1) {
    const chunk = token.slice(i, i + WINDOW)
    assert.ok(!text.includes(chunk), `${label}: output contains a ${WINDOW}-char token substring "${chunk}"`)
  }
}

// ---------------------------------------------------------------------------
// D1 — a control-character MS_TOKEN is refused BEFORE it ever reaches a header,
// and even a fetch-level error whose OWN message embeds "Bearer <token>" never reaches output.
// ---------------------------------------------------------------------------

test('a three-segment token with an embedded LF is refused by readConfig, before any HTTP call', async () => {
  // A JWT-shaped token (three dot-separated segments) whose middle segment payload decodes fine, but
  // the raw string itself carries an embedded newline — the real-world cause named in the module
  // header (a token file that got word-wrapped, or pasted across lines).
  const tokenWithLf = `${TENANT_TOKEN.slice(0, 20)}\n${TENANT_TOKEN.slice(20)}`
  const { requests, result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found' } } }),
    () => runMain([], { ...BASE_ENV, MS_TOKEN: tokenWithLf }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /control character/)
  assert.equal(requests.length, 0, 'refusing at config time costs zero HTTP calls')
  assertNoTokenSubstring(TENANT_TOKEN, result.stdout, 'stdout')
  assertNoTokenSubstring(TENANT_TOKEN, result.stderr, 'stderr')
})

test(
  'a fetch-level error whose .message embeds "Bearer <token>" (the real Headers.append shape) never reaches stdout/stderr',
  async () => {
    // Reproduces, verbatim, the exact failure the design record's D1 finding named:
    //   TypeError: Headers.append: "Bearer <token>" is an invalid header value.
    // This token has NO control characters, so it passes `readConfig` and reaches `postJson` — the
    // point is to prove the SECOND, independent layer (postJson relaying only `.name`/`.code`, plus
    // `redact()` as a belt-and-braces net) holds even when the thrown error's own `.message` embeds
    // the token, regardless of what upstream cause produced that shape.
    const embeddingError = new TypeError(`Headers.append: "Bearer ${TENANT_TOKEN}" is an invalid header value.`)
    const { result } = await withMockFetch(
      () => ({ throw: embeddingError }),
      () => runMain([], BASE_ENV),
    )
    assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
    assertNoTokenSubstring(TENANT_TOKEN, result.stdout, 'stdout')
    assertNoTokenSubstring(TENANT_TOKEN, result.stderr, 'stderr')
    assert.doesNotMatch(result.stdout, /Bearer /)
    assert.doesNotMatch(result.stderr, /Bearer /)
    const lines = jsonLines(result.stdout)
    assert.equal(lines[0].failed, true)
    // The reported error is the safe, closed vocabulary (name/code) — never the raw `.message`.
    assert.match(lines[0].error, /TypeError/)
    assert.doesNotMatch(lines[0].error, /Bearer/)
  },
)

// ---------------------------------------------------------------------------
// D2 — every HTTP call is bounded, and so is the whole run
// ---------------------------------------------------------------------------

test('a dry-run that never responds times out (MS_TIMEOUT_MS) and is recorded as "timeout"', async () => {
  const { result } = await withMockFetch(
    () => new Promise(() => {}), // never settles — only the AbortSignal.timeout races it down
    () => runMain([], { ...BASE_ENV, MS_TIMEOUT_MS: '50' }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'error')
  assert.equal(lines[0].failed, true)
  assert.equal(lines[0].error, 'timeout', 'the timeout case reports the fixed string "timeout", nothing composed')
})

test('MS_TIMEOUT_MS must be a positive integer, or readConfig refuses (no HTTP call)', async () => {
  const { requests, result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found' } } }),
    () => runMain([], { ...BASE_ENV, MS_TIMEOUT_MS: '-5' }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /MS_TIMEOUT_MS/)
  assert.equal(requests.length, 0)
})

test('the whole run has a wall-clock budget (MS_TOTAL_TIMEOUT_MS): once exceeded, remaining projects fail without an HTTP call', async () => {
  const { requests, result } = await withMockFetch(
    async (record) => {
      // The FIRST project's dry-run takes just long enough that the (tiny) total budget has expired
      // by the time the loop reaches the second project.
      if (record.body.parameters.projectNo === 'P-SLOW') {
        await new Promise((done) => { setTimeout(done, 40) })
      }
      return { json: { ok: true, data: { status: 'not_found', canApply: false, counts: {} } } }
    },
    () => runMain([], { ...BASE_ENV, MS_PROJECT_NOS: 'P-SLOW,P-NEVER-CALLED', MS_TOTAL_TIMEOUT_MS: '10' }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(requests.length, 1, 'only the first (slow) project ever made an HTTP call')
  const lines = jsonLines(result.stdout)
  assert.equal(lines.length, 3, 'two project lines + one summary line')
  assert.equal(lines[0].projectNo, 'P-SLOW')
  assert.equal(lines[1].projectNo, 'P-NEVER-CALLED')
  assert.equal(lines[1].action, 'error')
  assert.equal(lines[1].error, 'total run timeout exceeded')
  assert.equal(lines[1].failed, true)
})

test('MS_TOTAL_TIMEOUT_MS must be a positive integer, or readConfig refuses (no HTTP call)', async () => {
  const { requests, result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found' } } }),
    () => runMain([], { ...BASE_ENV, MS_TOTAL_TIMEOUT_MS: 'not-a-number' }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /MS_TOTAL_TIMEOUT_MS/)
  assert.equal(requests.length, 0)
})

test('a body that arrives too slowly (headers OK, .json() hangs) is ALSO classified as "timeout", never a mislabeled HTTP failure', async () => {
  // Distinguishes the body-phase timeout `postJson` now catches from the connect-phase one the
  // earlier test above already covers. Before this fix, `response.json()` rejecting with an
  // AbortError fell into the generic `parseError` branch, and the project was reported as
  // `"dry-run failed with HTTP 200"` — technically true (the status line DID arrive) but misleading:
  // the request timed out, it did not fail server-side.
  const { result } = await withMockFetch(
    () => ({ hangBody: true, status: 200 }),
    () => runMain([], { ...BASE_ENV, MS_TIMEOUT_MS: '60' }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].action, 'error')
  assert.equal(lines[0].error, 'timeout', 'a body-phase timeout reports the SAME fixed string as a connect-phase one')
  assert.doesNotMatch(lines[0].error, /HTTP 200/, 'never mislabeled as an HTTP-level failure')
})

// ---------------------------------------------------------------------------
// D1 follow-up: redaction must survive whitespace-padded env vars and JSON-string escaping —
// not just the raw, already-clean token used by every test above.
// ---------------------------------------------------------------------------

test('MS_TOKEN with leading/trailing whitespace is trimmed, matches what is actually sent, and a server response echoing it back is fully redacted', async () => {
  const paddedToken = `  ${TENANT_TOKEN}\n`
  const { requests, result } = await withMockFetch(
    (record) => {
      // A server that echoes exactly what it received in the Authorization header — the scenario
      // this test pins: if `readConfig` did NOT trim, `activeSecret` (untrimmed) would never match
      // this echoed (trimmed, because that is what was actually sent) token, and it would leak.
      const sentToken = (record.headers.authorization || '').replace(/^Bearer\s+/, '')
      return { status: 401, json: { ok: false, error: { code: `unauthorized for token ${sentToken}` } } }
    },
    () => runMain([], { ...BASE_ENV, MS_TOKEN: paddedToken }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(requests[0].headers.authorization, `Bearer ${TENANT_TOKEN}`, 'the header carries the TRIMMED token, not the padded env var')
  assertNoTokenSubstring(TENANT_TOKEN, result.stdout, 'stdout')
  assertNoTokenSubstring(TENANT_TOKEN, result.stderr, 'stderr')
  // jsonLines() itself JSON.parses every line — a throw here means redaction corrupted the payload.
  const lines = jsonLines(result.stdout)
  assert.equal(lines[0].failed, true)
  assert.match(lines[0].error, /unauthorized for token <redacted>/)
})

test('a token containing characters JSON.stringify escapes (quote, backslash) is still redacted from the serialized line', async () => {
  // A token shape `readConfig`'s control-character check does NOT reject (no \x00-\x1f in it) but
  // whose JSON-STRING-ESCAPED form differs from its raw form — proving `redact()`'s second substring
  // pass (`JSON.stringify(activeSecret).slice(1, -1)`) is load-bearing, not redundant with the first.
  // Reuses TENANT_TOKEN's header+payload (so `jwtHasTenantClaim` still sees a valid tenantId claim
  // and this run reaches `postJson` at all) with a "signature" segment carrying the quirky
  // characters — `jwtHasTenantClaim` never inspects that segment, only decodes `parts[1]`.
  const [tokenHeader, tokenPayload] = TENANT_TOKEN.split('.')
  const quirkyToken = `${tokenHeader}.${tokenPayload}.tok"with\\quirks_0123456789ABCDEF`
  const { result } = await withMockFetch(
    (record) => {
      const sentToken = (record.headers.authorization || '').replace(/^Bearer\s+/, '')
      return { status: 401, json: { ok: false, error: { code: `rejected: ${sentToken}` } } }
    },
    () => runMain([], { ...BASE_ENV, MS_TOKEN: quirkyToken }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout) // throws if redaction broke JSON validity
  assert.doesNotMatch(lines[0].error, /quirks_0123456789ABCDEF/, 'the escaped form of the token is redacted too')
  assert.doesNotMatch(result.stdout, /quirks_0123456789ABCDEF/)
})

test('a "Bearer <token>" substring inside a compact JSON error is redacted WITHOUT swallowing the rest of the line', async () => {
  // Pins the over-eating fix directly: the old `/Bearer\s+\S+/g` pattern would consume everything up
  // to the next whitespace, including the closing `"` / `}` of a compact (single-line) JSON payload —
  // corrupting the "one JSON line per project" contract. The tightened pattern stops at the token's
  // own alphabet, leaving the text (and JSON structure) AFTER it intact.
  const { result } = await withMockFetch(
    () => ({
      status: 401,
      json: { ok: false, error: { code: `token invalid: Bearer ${TENANT_TOKEN} please retry with a fresh one` } },
    }),
    () => runMain([], BASE_ENV),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const lines = jsonLines(result.stdout) // throws if the line no longer parses
  assert.match(lines[0].error, /please retry with a fresh one/, 'text AFTER the token survives redaction intact')
  assertNoTokenSubstring(TENANT_TOKEN, result.stdout, 'stdout')
})

// ---------------------------------------------------------------------------
// the tenant-binding gate, exercised in-process too (same claims, plus a real HTTP call proof)
// ---------------------------------------------------------------------------

test('in-process: a token with no tenantId claim is refused before any HTTP call', async () => {
  const { requests, result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found' } } }),
    () => runMain([], { ...BASE_ENV, MS_TOKEN: TENANTLESS_TOKEN }),
  )
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /tenantId claim/)
  assert.equal(requests.length, 0, 'refusing must cost zero HTTP calls')
})

test('in-process: a token with no tenantId claim proceeds under --allow-tenantless, with a warning', async () => {
  const { requests, result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found' } } }),
    () => runMain(['--allow-tenantless'], { ...BASE_ENV, MS_TOKEN: TENANTLESS_TOKEN }),
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /allow-tenantless/)
  assert.equal(requests.length, 1, 'the run proceeded and made its one dry-run call')
})

test('in-process: a token WITH a tenantId claim runs normally, no refusal', async () => {
  const { requests, result } = await withMockFetch(
    () => ({ json: { ok: true, data: { status: 'not_found' } } }),
    () => runMain([], BASE_ENV),
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /tenantId claim/)
  assert.equal(requests.length, 1)
})
