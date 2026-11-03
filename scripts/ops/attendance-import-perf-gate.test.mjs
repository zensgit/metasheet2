import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const script = path.join(root, 'scripts/ops/attendance-import-perf.mjs')
const deployed = 'a'.repeat(40)
const tenant = 'fixture-perf-org'
const jwt = id => `fixture.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.synthetic-signature`
const initialToken = jwt('initial-user')
const nextToken = jwt('replacement-user')
const proof = { success: true, data: { user: { id: 'fixture-user', tenantId: tenant } } }
const telemetry = { engine: 'standard', processedRows: 1, failedRows: 0, elapsedMs: 1 }

// Run the real consumer with only synthetic HTTP IO. Returning undefined uses
// the valid default response; overrides can change identity between requests.
async function runConsumer({ env: overrides = {}, handle = () => {}, fastClock = false, cwd = root } = {}) {
  await mkdir(path.join(root, 'tmp'), { recursive: true })
  const output = await mkdtemp(path.join(root, 'tmp/attendance-perf-gate-'))
  const requests = []
  let handlerError
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const url = new URL(req.url, 'http://fixture.invalid')
      const bodyValue = raw ? (req.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : raw) : null
      const entry = { pathname: url.pathname, query: url.searchParams, method: req.method, token: req.headers.authorization, body: bodyValue }
      requests.push(entry)
      const custom = await handle(entry, requests)
      if (custom?.disconnect) { req.socket.destroy(); return }
      if (custom?.redirect) {
        res.writeHead(302, { Location: custom.redirect }); res.end(); return
      }
      let body
      switch (entry.pathname) {
        case '/api/health': body = { ok: true, build: { commit: deployed } }; break
        case '/api/auth/me': body = proof; break
        case '/api/auth/refresh-token': body = { success: true, data: { token: initialToken } }; break
        case '/api/attendance/import/template': body = { success: true, data: { payloadExample: { source: 'dingtalk', mode: 'override' } } }; break
        case '/api/attendance/import/upload': body = { ok: true, data: { fileId: 'fixture-csv' } }; break
        case '/api/attendance/import/prepare': body = { success: true, data: { commitToken: 'fixture-commit-token' } }; break
        case '/api/attendance/import/preview': body = { success: true, data: { items: [{ userId: 'fixture-user' }], rowCount: 1 } }; break
        case '/api/attendance/import/preview-async': body = { success: true, data: { job: { id: 'fixture-preview-job' } } }; break
        case '/api/attendance/import/commit': body = { success: true, data: { ...telemetry, batchId: 'fixture-batch' } }; break
        case '/api/attendance/import/commit-async': body = { success: true, data: { job: { id: 'fixture-job', status: 'completed', batchId: 'fixture-batch', ...telemetry } } }; break
        case '/api/attendance/import/jobs/fixture-preview-job': body = { success: true, data: { id: 'fixture-preview-job', status: 'completed', ...telemetry, preview: { items: [{}] } } }; break
        case '/api/attendance/import/jobs/fixture-job': body = { success: true, data: { id: 'fixture-job', status: 'completed', batchId: 'fixture-batch', ...telemetry } }; break
        case '/api/attendance/import/rollback/fixture-batch': body = { success: true }; break
        case '/api/attendance/import/batches/fixture-batch': body = { success: true, data: { ...telemetry, batchId: 'fixture-batch' } }; break
        default: throw new Error(`unhandled fixture route ${entry.pathname}`)
      }
      res.writeHead(custom?.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(custom?.raw ?? JSON.stringify(custom && 'body' in custom ? custom.body : body))
    } catch (error) {
      handlerError = error
      res.writeHead(500); res.end('{}')
    }
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const env = {
      PATH: process.env.PATH, API_BASE: `http://127.0.0.1:${server.address().port}/api`, AUTH_TOKEN: initialToken,
      ORG_ID: tenant, ATTENDANCE_SYNTHETIC_ORG_ID: tenant, AUTH_EXPECTED_TENANT_ID: tenant,
      ATTENDANCE_EXPECTED_DEPLOY_SHA: deployed, OUTPUT_DIR: output,
      ROWS: '1', PAYLOAD_SOURCE: 'rows', API_RETRY_ATTEMPTS: '2', API_RETRY_DELAY_MS: '100',
      PREVIEW_RETRIES: '2', COMMIT_RETRIES: '2', MUTATION_RETRY_DELAY_MS: '100', MUTATION_RETRY_JITTER_RATIO: '0',
      IMPORT_JOB_POLL_INTERVAL_MS: '500', IMPORT_JOB_POLL_TIMEOUT_MS: '60000', ...overrides,
    }
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
    const clock = 'let clock = 1700000000000; Date.now = () => (clock += 61001)'
    const args = [...(fastClock ? ['--import', `data:text/javascript,${encodeURIComponent(clock)}`] : []), script]
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    clearTimeout(timer)
    if (handlerError) throw handlerError
    const summaries = []
    for (const dir of await readdir(output)) {
      try { summaries.push(JSON.parse(await readFile(path.join(output, dir, 'perf-summary.json'), 'utf8'))) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { code, stdout, stderr, requests, summaries }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(output, { recursive: true, force: true })
  }
}

const mutations = result => result.requests.filter(entry => entry.pathname.startsWith('/api/attendance/') && entry.method !== 'GET')
function blocked(result, reason, count = 0) {
  assert.equal(result.code, 1, `exit=${result.code}; performance mutations=${mutations(result).length}; summaries=${result.summaries.length}; ${result.stderr}`)
  assert.equal(result.stderr.trim(), `[attendance-import-perf] Failed: ${reason}`)
  assert.equal(mutations(result).length, count)
  assert.deepEqual(result.summaries, [])
}

for (const [name, body] of [
  ['wrong', { success: true, data: { user: { id: 'fixture-user', tenantId: 'other-org' } } }],
  ['missing', { success: true, data: { user: { id: 'fixture-user' } } }],
  ['malformed', { success: true, data: { user: { id: 'fixture-user', tenantId: [tenant] } } }],
  ['unsuccessful', { ...proof, success: false }],
]) {
  test(`bound consumer blocks ${name} tenant before mutations`, async () => {
    blocked(await runConsumer({ handle: req => req.pathname === '/api/auth/me' ? { body } : undefined }), 'ACCEPTANCE_TENANT_UNVERIFIED')
  })
}

for (const [name, health, reason] of [
  ['mismatch', { ok: true, build: { commit: 'b'.repeat(40) } }, 'ACCEPTANCE_DEPLOYMENT_MISMATCH'],
  ['missing', { ok: true }, 'ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE'],
  ['malformed', { ok: true, build: { commit: 'main' } }, 'ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE'],
]) {
  test(`bound consumer blocks ${name} runtime SHA before mutations`, async () => {
    blocked(await runConsumer({ handle: req => req.pathname === '/api/health' ? { body: health } : undefined }), reason)
  })
}

test('real HTTP positive control commits and rolls back with independent source identities', async () => {
  const result = await runConsumer({ cwd: '/tmp', env: { CHECKOUT_SHA: 'f'.repeat(40), GITHUB_SHA: 'e'.repeat(40), GIT_DIR: '/nonexistent-fixture-git' } })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(mutations(result).map(req => req.pathname), [
    '/api/attendance/import/prepare', '/api/attendance/import/preview', '/api/attendance/import/prepare',
    '/api/attendance/import/commit', '/api/attendance/import/rollback/fixture-batch',
  ])
  assert.equal(result.summaries.length, 1)
  assert.deepEqual(result.summaries[0].provenance, {
    checkoutSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    expectedDeploymentSha: deployed, observedDeploymentSha: deployed, source: 'backend_health_build_commit',
  })
  assert.equal(result.summaries[0].rolledBack, true)
})

test('CSV upload positive control traverses the text request gate', async () => {
  const result = await runConsumer({ env: { PAYLOAD_SOURCE: 'csv', UPLOAD_CSV: 'true', MODE: 'preview' } })
  assert.equal(result.code, 0, result.stderr)
  const upload = result.requests.find(req => req.pathname === '/api/attendance/import/upload')
  assert.equal(upload.query.get('orgId'), tenant)
  assert.equal(typeof upload.body, 'string')
  assert.equal(result.summaries[0].provenance.observedDeploymentSha, deployed)
  assert.equal(result.summaries[0].mode, 'preview')
})

test('source drift before CSV upload blocks the text mutation before send', async () => {
  let drift = false
  const result = await runConsumer({ env: { PAYLOAD_SOURCE: 'csv', UPLOAD_CSV: 'true' }, handle: req => {
    if (req.pathname === '/api/attendance/import/template') drift = true
    if (req.pathname === '/api/health' && drift) return { body: { ok: true } }
  } })
  blocked(result, 'ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE')
})

for (const workflow of ['baseline', 'highscale', 'longrun']) {
  for (const missing of ['SHA', 'org']) {
    test(`${workflow} workflow missing repository ${missing} remains explicitly bound and fails before IO`, async () => {
      const raw = await readFile(path.join(root, `.github/workflows/attendance-import-perf-${workflow}.yml`), 'utf8')
      const env = {}
      const vars = missing === 'SHA' ? { ATTENDANCE_SYNTHETIC_ORG_ID: tenant } : { ATTENDANCE_EXPECTED_DEPLOY_SHA: deployed }
      for (const key of ['ORG_ID', 'AUTH_EXPECTED_TENANT_ID', 'ATTENDANCE_SYNTHETIC_ORG_ID', 'ATTENDANCE_EXPECTED_DEPLOY_SHA']) {
        const field = raw.match(new RegExp(`^      ${key}: \\$\\{\\{ vars\\.([A-Z_]+) \\|\\| '' \\}\\}$`, 'm'))
        assert.ok(field, `explicit workflow field ${key} required`)
        env[key] = vars[field[1]] ?? ''
      }
      const result = await runConsumer({ env })
      blocked(result, missing === 'SHA' ? 'ACCEPTANCE_EXPECTED_SHA_REQUIRED' : 'ACCEPTANCE_SYNTHETIC_ORG_REQUIRED')
      assert.deepEqual(result.requests, [])
    })
  }
}

test('required Node ops command preserves upstream suites and runs the real consumer tests', async () => {
  const raw = await readFile(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')
  const command = raw.split('\n').find(line => line.trim().startsWith('node --test scripts/ops/attendance-import-scope.test.mjs '))
  assert.ok(command)
  assert.deepEqual(command.trim().split(/\s+/), [
    'node', '--test', 'scripts/ops/attendance-import-scope.test.mjs', 'scripts/ops/attendance-history-reconcile.test.mjs',
    'scripts/ops/attendance-acceptance-preflight.test.mjs', 'scripts/ops/attendance-import-perf-payload.test.mjs',
    'scripts/ops/attendance-import-perf-gate.test.mjs',
  ])
  assert.ok(raw.includes('node --test scripts/ops/attendance-window-runner-pipeline.test.mjs'))
  assert.ok(raw.includes('node --test scripts/verify-attendance-production-flow.test.mjs'))
})

for (const [key, value, reason] of [
  ['AUTH_EXPECTED_TENANT_ID', '', 'ACCEPTANCE_ORG_MISMATCH'],
  ['AUTH_EXPECTED_TENANT_ID', undefined, 'ACCEPTANCE_ORG_MISMATCH'],
  ['AUTH_EXPECTED_TENANT_ID', ' other-org ', 'ACCEPTANCE_ORG_MISMATCH'],
  ['ORG_ID', undefined, 'ACCEPTANCE_ORG_MISMATCH'],
  ['ORG_ID', '', 'ACCEPTANCE_ORG_MISMATCH'],
  ['ATTENDANCE_SYNTHETIC_ORG_ID', undefined, 'ACCEPTANCE_SYNTHETIC_ORG_REQUIRED'],
  ['ATTENDANCE_SYNTHETIC_ORG_ID', '', 'ACCEPTANCE_SYNTHETIC_ORG_REQUIRED'],
  ['ATTENDANCE_SYNTHETIC_ORG_ID', ' bad\norg ', 'ACCEPTANCE_SYNTHETIC_ORG_REQUIRED'],
  ['ATTENDANCE_EXPECTED_DEPLOY_SHA', undefined, 'ACCEPTANCE_EXPECTED_SHA_REQUIRED'],
  ['ATTENDANCE_EXPECTED_DEPLOY_SHA', '', 'ACCEPTANCE_EXPECTED_SHA_REQUIRED'],
  ['ATTENDANCE_EXPECTED_DEPLOY_SHA', 'main', 'ACCEPTANCE_EXPECTED_SHA_REQUIRED'],
  ['API_BASE', 'https://synthetic:secret@example.invalid/api', 'ACCEPTANCE_API_BASE_INVALID'],
]) {
  test(`explicit binding rejects ${key} ${JSON.stringify(value)} without network IO`, async () => {
    const result = await runConsumer({ env: { [key]: value } })
    blocked(result, reason)
    assert.deepEqual(result.requests, [])
    assert.equal(result.stdout, '')
  })
}

test('legacy tenant-only config now fails closed without explicit source expectation', async () => {
  const result = await runConsumer({ env: { ATTENDANCE_SYNTHETIC_ORG_ID: undefined, ATTENDANCE_EXPECTED_DEPLOY_SHA: undefined } })
  blocked(result, 'ACCEPTANCE_SYNTHETIC_ORG_REQUIRED')
  assert.deepEqual(result.requests, [])
})

test('fully unbound local compatibility retains existing summary and no health requests', async () => {
  const result = await runConsumer({ env: { AUTH_EXPECTED_TENANT_ID: undefined, ATTENDANCE_SYNTHETIC_ORG_ID: undefined, ATTENDANCE_EXPECTED_DEPLOY_SHA: undefined } })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(mutations(result).length, 5)
  assert.equal('provenance' in result.summaries[0], false)
  assert.equal(result.requests.some(req => req.pathname === '/api/health'), false)
})

for (const endpoint of ['/api/auth/me', '/api/health']) {
  for (const [name, failure] of [
    ['redirect', { redirect: '/api/redirect-target-sensitive' }],
    ['network disconnect', { disconnect: true }],
    ['malformed JSON', { raw: 'sensitive-malformed-body' }],
    ['HTTP failure', { status: 503, body: { sensitive: 'fixture-private-error' } }],
  ]) {
    test(`${endpoint} proof ${name} blocks mutations with a fixed error`, async () => {
      const result = await runConsumer({ handle: req => req.pathname === endpoint ? failure : undefined })
      blocked(result, endpoint === '/api/auth/me' ? 'ACCEPTANCE_TENANT_UNVERIFIED' : 'ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE')
      assert.equal(result.requests.some(req => req.pathname === '/api/redirect-target-sensitive'), false)
      assert.equal(result.stdout.includes('sensitive'), false)
    })
  }
}

for (const [name, body] of [
  ['wrong tenant', { success: true, data: { user: { tenantId: 'other-org' } } }],
  ['missing tenant', { success: true, data: { user: {} } }],
  ['malformed tenant', { success: true, data: { user: { tenantId: 123 } } }],
]) {
  test(`refresh candidate ${name} is terminal before adoption or performance writes`, async () => {
    const result = await runConsumer({ handle: req => {
      if (req.pathname === '/api/auth/refresh-token') return { body: { success: true, data: { token: nextToken } } }
      if (req.pathname === '/api/auth/me' && req.token === `Bearer ${nextToken}`) return { body }
    } })
    blocked(result, 'ACCEPTANCE_TENANT_UNVERIFIED')
    assert.equal(result.requests.filter(req => req.pathname === '/api/auth/refresh-token').length, 1)
    assert.equal(result.stdout.includes('token refresh error'), false)
  })
}

test('401 request retry uses the verified replacement Authorization', async () => {
  let refreshes = 0
  let prepares = 0
  const result = await runConsumer({ handle: req => {
    if (req.pathname === '/api/auth/refresh-token') {
      refreshes++
      return { body: { success: true, data: { token: refreshes === 1 ? initialToken : nextToken } } }
    }
    if (req.pathname === '/api/attendance/import/prepare' && ++prepares === 1) return { status: 401 }
  } })
  assert.equal(result.code, 0, result.stderr)
  const attempts = result.requests.filter(req => req.pathname === '/api/attendance/import/prepare')
  assert.equal(attempts.length, 3)
  assert.equal(attempts[0].token, `Bearer ${initialToken}`)
  assert.equal(attempts[1].token, `Bearer ${nextToken}`)
  assert.equal(attempts[2].token, `Bearer ${nextToken}`)
})

test('401 replacement tenant drift blocks the request retry', async () => {
  let refreshes = 0
  const result = await runConsumer({ handle: req => {
    if (req.pathname === '/api/auth/refresh-token') return { body: { success: true, data: { token: ++refreshes === 1 ? initialToken : nextToken } } }
    if (req.pathname === '/api/auth/me' && req.token === `Bearer ${nextToken}`) return { body: { success: true, data: { user: { tenantId: 'other-org' } } } }
    if (req.pathname === '/api/attendance/import/prepare') return { status: 401 }
  } })
  blocked(result, 'ACCEPTANCE_TENANT_UNVERIFIED', 1)
  assert.equal(result.requests.filter(req => req.pathname === '/api/auth/refresh-token').length, 2)
})

for (const stage of ['request retry', 'preview retry', 'commit retry', 'rollback retry', 'metadata', 'async poll', 'async recovery']) {
  test(`${stage} rechecks source and stops before the next mutation`, async () => {
    let drift = false
    const target = {
      'request retry': '/api/attendance/import/prepare',
      'preview retry': '/api/attendance/import/preview',
      'commit retry': '/api/attendance/import/commit',
      'rollback retry': '/api/attendance/import/rollback/fixture-batch',
      metadata: '/api/attendance/import/commit',
      'async poll': '/api/attendance/import/commit-async',
      'async recovery': '/api/attendance/import/jobs/fixture-job',
    }[stage]
    const result = await runConsumer({
      env: { COMMIT_ASYNC: stage.startsWith('async') ? 'true' : 'false', ROLLBACK_RETRY_DELAY_MS: '100' },
      fastClock: stage === 'async recovery',
      handle: req => {
        if (req.pathname === '/api/health' && drift) return { body: { ok: true, build: { commit: 'b'.repeat(40) } } }
        if (req.pathname === target) {
          drift = true
          if (stage === 'async recovery') return { body: { success: true, data: { id: 'fixture-job', status: 'running' } } }
          if (stage.endsWith('retry')) return { status: 503 }
        }
      },
    })
    const count = { 'request retry': 1, 'preview retry': 2, 'commit retry': 4, 'rollback retry': 5, metadata: 4, 'async poll': 4, 'async recovery': 4 }[stage]
    blocked(result, 'ACCEPTANCE_DEPLOYMENT_MISMATCH', count)
    assert.equal(result.requests.filter(req => req.pathname === target).length, 1)
    assert.equal(result.stdout.includes('network error'), false)
    if (stage === 'metadata') assert.equal(result.stdout.includes('batch metadata fetch failed'), false)
    if (stage === 'async recovery') assert.equal(result.stdout.includes('idempotency recovery failed'), false)
  })
}

test('async preview, commit and rollback positive control uses the same bound gate', async () => {
  const result = await runConsumer({ env: { COMMIT_ASYNC: 'true', PREVIEW_MODE: 'async' } })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.summaries[0].rolledBack, true)
  assert.equal(result.summaries[0].provenance.observedDeploymentSha, deployed)
  assert.equal(result.requests.filter(req => req.pathname.startsWith('/api/attendance/import/jobs/')).length, 2)
})

test('async idempotency recovery positive control reaches real recovery POST', async () => {
  let polls = 0
  const result = await runConsumer({ env: { COMMIT_ASYNC: 'true' }, fastClock: true, handle: req => {
    if (req.pathname === '/api/attendance/import/jobs/fixture-job' && ++polls === 1) return { body: { success: true, data: { id: 'fixture-job', status: 'running' } } }
  } })
  assert.equal(result.code, 0, result.stderr)
  const commits = result.requests.filter(req => req.pathname === '/api/attendance/import/commit-async')
  assert.equal(commits.length, 2)
  assert.equal(commits[0].body.idempotencyKey, commits[1].body.idempotencyKey)
  assert.equal('commitToken' in commits[1].body, false)
  assert.equal(result.summaries[0].rolledBack, true)
})

for (const stage of ['request retry', 'async recovery']) {
  test(`${stage} rechecks tenant even when the token bytes have not changed`, async () => {
    let drift = false
    const target = stage === 'request retry' ? '/api/attendance/import/prepare' : '/api/attendance/import/jobs/fixture-job'
    const result = await runConsumer({
      env: { COMMIT_ASYNC: stage === 'async recovery' ? 'true' : 'false' }, fastClock: stage === 'async recovery',
      handle: req => {
        if (req.pathname === '/api/auth/me' && drift) return { body: { success: true, data: { user: { tenantId: 'other-org' } } } }
        if (req.pathname === target) {
          drift = true
          return stage === 'request retry' ? { status: 503 } : { body: { success: true, data: { id: 'fixture-job', status: 'running' } } }
        }
      },
    })
    blocked(result, 'ACCEPTANCE_TENANT_UNVERIFIED', stage === 'request retry' ? 1 : 4)
    assert.equal(result.requests.filter(req => req.pathname === target).length, 1)
  })
}
