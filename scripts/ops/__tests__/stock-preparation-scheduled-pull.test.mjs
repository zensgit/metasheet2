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
const { main } = await import(pathToFileURL(SCRIPT_PATH).href)

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

test('an unknown flag is refused with a non-zero exit', () => {
  const result = runScript(['--nonsense'], { MS_API: 'http://127.0.0.1:1', MS_TOKEN: TENANT_TOKEN, MS_TENANT_ID: 'tenant-a', MS_PROJECT_NOS: 'P-1' })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /--nonsense/)
})

// ---------------------------------------------------------------------------
// (b) IN-PROCESS — everything that needs an HTTP round trip, via a mocked fetch
// ---------------------------------------------------------------------------

/**
 * Installs a recording `fetch` stub for the duration of `run(...)`, restoring the real (absent, in
 * this test process — Node's global fetch is left untouched otherwise) one afterwards regardless of
 * whether `run` throws. `handler(url, init)` returns `{ status, json }` (status defaults to 200).
 */
async function withMockFetch(handler, run) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    let body = null
    try { body = init.body ? JSON.parse(init.body) : null } catch { body = null }
    const record = { url: String(url), method: init.method, headers: init.headers || {}, body }
    requests.push(record)
    const result = (await handler(record)) || {}
    const status = result.status || 200
    const json = result.json !== undefined ? result.json : { ok: true, data: {} }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return json },
    }
  }
  try {
    return { requests, result: await run() }
  } finally {
    globalThis.fetch = original
  }
}

/** Captures everything `process.stdout.write` / `process.stderr.write` would have sent. */
function captureOutput() {
  const stdout = []
  const stderr = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk, ...rest) => { stdout.push(String(chunk)); return true }
  process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return true }
  return {
    restore() { process.stdout.write = originalOut; process.stderr.write = originalErr },
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
