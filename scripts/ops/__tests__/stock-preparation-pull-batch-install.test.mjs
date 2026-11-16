// stock-preparation-pull-batch-install.test.mjs — the ops client of the per-sheet 批次标识 install (BI-2; register R-65).
// In-process (the scheduled-pull suite's model): the module is imported, `globalThis.fetch` is replaced with a recording
// stub, and output goes through the test sinks. Synthetic values only.
//
//   OPS-1  default dry-run over the file: one line per INPUT ORDINAL, the project number never printed
//   OPS-2  --install without each required flag is a usage error, no value echoed, no HTTP call
//   OPS-3  the write_budget loop and its bound
//   OPS-4  refusal codes relayed; non-zero exit
//   OPS-5  a tenantless token is refused before any HTTP call
//   OPS-6  the token is redacted
//   OPS-7  --abort
//   OPS-8  only allow-listed keys leave a server answer

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { main, parseArgs, readProjects, UsageError, __setOutputSinksForTesting } from '../stock-preparation-pull-batch-install.mjs'

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const TENANT_TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: 'u_admin', tenantId: 'tenant-a' })}.signature_syn_0123456789`
const TENANTLESS_TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: 'u_admin' })}.signature_syn_0123456789`
const ENV = { MS_API: 'http://stub.invalid', MS_TOKEN: TENANT_TOKEN, MS_TENANT_ID: 'tenant-a' }
const PROJECTS = '# synthetic\nPRJ-SYN-OPS-1\n\nPRJ-SYN-OPS-2\n'
const DIGEST = 'a'.repeat(64)

async function run(args, { env = ENV, handler, file = PROJECTS } = {}) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ url: String(url), body, headers: init.headers })
    const answer = handler ? handler({ url: String(url), body, count: requests.length }) : { json: { ok: true, data: {} } }
    return { ok: (answer.status || 200) < 400, status: answer.status || 200, json: async () => answer.json }
  }
  let stdout = ''
  let stderr = ''
  const restore = __setOutputSinksForTesting({ stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } })
  try {
    const code = await main(args, env, { readFile: () => file })
    return { code, stdout, stderr, requests, lines: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
  } finally {
    restore()
    globalThis.fetch = original
  }
}

test('OPS-1 the default dry-run: one line per input ordinal, comments and blanks ignored, the project number never printed', async () => {
  assert.deepEqual(readProjects(PROJECTS), ['PRJ-SYN-OPS-1', 'PRJ-SYN-OPS-2'])
  const result = await run(['--projects-file', 'projects.txt'], {
    handler: ({ body }) => ({ json: { ok: true, data: { mode: 'dry_run', run: 'first_install', plan: { K: 2 }, planDigest: DIGEST, refusals: [], requires: { confirmHistoricalBatchCount: { inferred: 2, unknownMin: 0 } }, echo: body.confirmProjectNo } } }),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.requests.length, 2)
  assert.deepEqual(result.requests.map((request) => request.body.mode), ['dry_run', 'dry_run'])
  assert.ok(result.requests[0].url.endsWith('/target/pull-batch?tenantId=tenant-a'))
  assert.deepEqual(result.lines.map((line) => line.ordinal), [1, 2, undefined])
  assert.deepEqual([result.lines[0].K, result.lines[0].planDigest, result.lines[0].confirmCountInferred], [2, DIGEST, 2])
  assert.equal(result.stdout.includes('PRJ-SYN-OPS'), false, 'never the project number')
  assert.equal(result.lines[2].summary.failed, 0)
})

test('OPS-2 --install without each required flag is a usage error naming the flag only — no value echoed, no HTTP call', async () => {
  const full = ['--projects-file', 'p', '--install', '--ordinal', '1', '--approval-ref', 'R-65', '--plan-digest', DIGEST, '--confirm-count', '2']
  assert.equal(parseArgs(full).confirmCount, 2)
  for (const drop of ['--ordinal', '--approval-ref', '--plan-digest', '--confirm-count']) {
    const index = full.indexOf(drop)
    const args = [...full.slice(0, index), ...full.slice(index + 2)]
    assert.throws(() => parseArgs(args), UsageError, drop)
    const result = await run(args)
    assert.equal(result.code, 2)
    assert.equal(result.requests.length, 0)
  }
  const secretLike = await run(['--projects-file', 'p', '--install', '--ordinal', '1', '--approval-ref', '#leaked-value', '--plan-digest', DIGEST, '--confirm-count', '2'])
  assert.equal(secretLike.stderr.includes('#leaked-value'), false, 'the value is not echoed')
  const stray = await run(['--projects-file', 'p', 'tok_positional_secret'])
  assert.equal(stray.stderr.includes('tok_positional_secret'), false)
})

test('OPS-3 --install re-posts while the route answers write_budget, then stops on the resolve; the loop is bounded', async () => {
  const args = ['--projects-file', 'p', '--install', '--ordinal', '2', '--approval-ref', 'R-65', '--plan-digest', DIGEST, '--confirm-count', '2']
  const result = await run(args, {
    handler: ({ count }) => ({ json: { ok: true, data: count < 3 ? { mode: 'install', resolved: false, reason: 'write_budget', remaining: 3 - count } : { mode: 'install', resolved: true, reason: null } } }),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.requests.length, 3)
  assert.deepEqual(result.requests[0].body, { mode: 'install', confirmProjectNo: 'PRJ-SYN-OPS-2', approvalRef: 'R-65', planDigest: DIGEST, confirmHistoricalBatchCount: 2 })
  assert.deepEqual(result.lines.at(-1).summary, { projectCount: 2, mode: 'install', failed: 0, resolved: true, rounds: 3 })
  const endless = await run(args, { handler: () => ({ json: { ok: true, data: { mode: 'install', resolved: false, reason: 'write_budget', remaining: 9 } } }) })
  assert.equal(endless.code, 1)
  assert.equal(endless.requests.length, 200)
  assert.equal(endless.lines.at(-1).summary.budgetRoundsExhausted, true)
  const unresolved = await run(args, { handler: () => ({ json: { ok: true, data: { mode: 'install', resolved: false, reason: 'rows_after_plan', count: 1 } } }) })
  assert.equal(unresolved.code, 3, 'answered but not resolved: run again')
})

test('OPS-4 a refusal is relayed by its closed code (never its message or details) and exits non-zero', async () => {
  const result = await run(['--projects-file', 'p', '--install', '--ordinal', '1', '--approval-ref', 'R-65', '--plan-digest', DIGEST, '--confirm-count', '3'], {
    handler: () => ({ status: 409, json: { ok: false, error: { code: 'STOCK_PREP_PULL_BATCH_HISTORY_COUNT_MISMATCH', message: 'PRJ-SYN-OPS-1 message', details: { K: 2, secret: 'PRJ-SYN-OPS-1' } } } }),
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.lines[0], { ordinal: 1, httpStatus: 409, ok: false, code: 'STOCK_PREP_PULL_BATCH_HISTORY_COUNT_MISMATCH' })
  assert.equal(result.stdout.includes('PRJ-SYN-OPS-1'), false)
})

test('OPS-5 a token without a tenantId claim is refused before any HTTP call (unless --allow-tenantless)', async () => {
  const refused = await run(['--projects-file', 'p'], { env: { ...ENV, MS_TOKEN: TENANTLESS_TOKEN } })
  assert.equal(refused.code, 1)
  assert.equal(refused.requests.length, 0)
  const allowed = await run(['--projects-file', 'p', '--allow-tenantless'], { env: { ...ENV, MS_TOKEN: TENANTLESS_TOKEN } })
  assert.equal(allowed.requests.length, 2)
})

test('OPS-6 the token never reaches the output — echoed raw or as a Bearer header', async () => {
  const result = await run(['--projects-file', 'p'], {
    handler: () => ({ status: 500, json: { ok: false, error: { code: `X_${TENANT_TOKEN}`, message: `Bearer ${TENANT_TOKEN}` } } }),
  })
  assert.equal(result.stdout.includes(TENANT_TOKEN), false)
  assert.equal(result.stderr.includes(TENANT_TOKEN), false)
  assert.equal(result.requests[0].headers.authorization, `Bearer ${TENANT_TOKEN}`, 'sent, never printed')
})

test('OPS-7 --abort posts the abort of ONE project with its approval reference', async () => {
  const result = await run(['--projects-file', 'p', '--abort', '--ordinal', '1', '--approval-ref', 'R-65'], {
    handler: () => ({ json: { ok: true, data: { mode: 'abort', historyStatus: 'pending', firstInstall: true, settingsReleased: true } } }),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.requests.map((request) => request.body), [{ mode: 'abort', confirmProjectNo: 'PRJ-SYN-OPS-1', approvalRef: 'R-65' }])
  assert.deepEqual([result.lines[0].mode, result.lines[0].historyStatus], ['abort', 'pending'])
})

test('OPS-8 only allow-listed keys leave a server answer (a planted key never printed)', async () => {
  const SENTINEL = 'syn_sentinel_never_printed'
  const result = await run(['--projects-file', 'p'], { handler: () => ({ json: { ok: true, data: { mode: 'dry_run', run: 'noop', [SENTINEL]: SENTINEL, classes: { machine: 9 }, settings: { placement: 'left' } } } }) })
  assert.equal(result.stdout.includes(SENTINEL), false)
  assert.equal(result.stdout.includes('classes'), false)
  assert.deepEqual(Object.keys(result.lines[0]).sort(), ['httpStatus', 'mode', 'ok', 'ordinal', 'run'])
})
