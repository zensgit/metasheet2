import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { requireImportSessionOrg } from './attendance-import-scope.mjs'

const repoRoot = process.cwd()
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8')

const productionFlow = read('scripts/verify-attendance-production-flow.mjs')
const fullFlow = read('scripts/verify-attendance-full-flow.mjs')
const attendanceView = read('apps/web/src/views/AttendanceView.vue')
const gateContractRunner = read('scripts/ops/attendance-run-gate-contract-case.sh')
const smoke = read('scripts/ops/attendance-smoke-api.mjs')
const perf = read('scripts/ops/attendance-import-perf.mjs')

function functionSlice(raw, name, nextDeclaration) {
  const start = raw.indexOf(`async function ${name}`)
  const end = raw.indexOf(`\n${nextDeclaration}`, start + 1)
  assert.notEqual(start, -1, `${name} must exist`)
  assert.ok(end > start, `${name} must have a bounded function body`)
  return raw.slice(start, end)
}

function executable(raw, name, nextDeclaration, dependencies) {
  return Function(...Object.keys(dependencies), `${functionSlice(raw, name, nextDeclaration)}; return ${name}`)(...Object.values(dependencies))
}

test('request verifier expands the real collapsed overview panel before filling', async () => {
  assert.match(attendanceView, /<details[\s\S]*?data-attendance-request-tools[\s\S]*?<summary/)
  for (const initial of ['visible', 'closed', 'open-but-hidden']) {
    const calls = []
    let visible = initial === 'visible'
    const date = { first() { return this }, async isVisible() { return visible }, async waitFor(options) {
      calls.push('date-visible')
      assert.equal(options.state, 'visible')
      assert.equal(visible, true)
    } }
    const tools = { first() { return this }, async waitFor() { calls.push('tools-visible') },
      async getAttribute(name) { assert.equal(name, 'open'); return initial === 'closed' ? null : '' },
      locator(selector) { assert.equal(selector, 'summary'); return { async click() { calls.push('expand'); visible = true } } },
    }
    const page = { locator(selector) {
      if (selector === '#attendance-request-work-date') return date
      assert.equal(selector, '[data-attendance-request-tools]')
      return tools
    } }
    const ensure = executable(productionFlow, 'ensureRequestFormVisible', 'async function selectAdminSection', {
      timeoutMs: 1000, switchToOverview: async () => { calls.push('overview'); visible = initial !== 'closed' },
    })
    assert.equal(await ensure(page), date)
    assert.deepEqual(calls, initial === 'visible' ? [] : initial === 'closed'
      ? ['overview', 'tools-visible', 'expand', 'date-visible'] : ['overview', 'tools-visible', 'date-visible'])
  }
  assert.match(productionFlow, /const requestDate = await ensureRequestFormVisible\(page\)\s+await requestDate\.fill\(workDate\)/)
})

test('import session check matches authenticated organization precedence and fails closed', () => {
  const envelope = (user) => ({ success: true, data: { user } })
  assert.equal(requireImportSessionOrg(envelope({ orgId: 'o', workspaceId: 'w', tenantId: 't' }), 'o'), 'o')
  assert.equal(requireImportSessionOrg(envelope({ workspaceId: 'w', tenantId: 't' }), 'w'), 'w')
  assert.equal(requireImportSessionOrg(envelope({ tenantId: ' t ' }), 't'), 't')
  assert.equal(requireImportSessionOrg(envelope({ orgId: 12 }), '12'), '12')
  for (const body of [null, { success: false }, envelope({}), envelope({ orgId: '' }),
    envelope({ orgId: 'foreign', tenantId: 'o' }), envelope({ tenantId: 12 }), envelope({ orgId: {} })]) {
    assert.throws(() => requireImportSessionOrg(body, 'o'), /ATTENDANCE_IMPORT_SESSION_ORG_MISMATCH/)
  }
})

for (const [name, raw, next] of [['smoke', smoke, 'async function run'], ['perf', perf, 'async function recoverAsyncCommitJobByIdempotency']]) {
  test(`${name} job polling sends the requested organization`, async () => {
    const urls = []
    const poll = executable(raw, 'pollImportJob', next, {
      orgId: 'qa org&1', log() {}, assertOk: (r) => assert.equal(r.res.ok, true),
      apiFetch: async (url) => { urls.push(new URL(url, 'https://qa.invalid')); return { res: { ok: true }, body: { ok: true, data: { status: 'completed' } } } },
    })
    assert.equal((await poll('job/1')).status, 'completed')
    assert.equal(urls.length, 1)
    assert.equal(urls[0].pathname, '/attendance/import/jobs/job%2F1')
    assert.equal(urls[0].searchParams.get('orgId'), 'qa org&1')
  })
  test(`${name} validates session before starting import writes`, () => {
    assert.match(raw, /assertOk\(me, 'GET \/auth\/me'\)\s+requireImportSessionOrg\(me\.body, orgId\)/)
  })
}

test('perf rollback refuses a mismatched session before POST and accepts its same-org control', async () => {
  for (const tenantId of ['qa-org', 'other']) {
    const calls = []
    const rollback = executable(perf, 'rollbackImportBatch', 'function assertOk', {
      orgId: 'qa-org', rollbackRetryAttempts: 1, nowMs: () => 0, requireImportSessionOrg,
      assertOk: (r) => assert.equal(r.res.ok, true),
      apiFetch: async (url, init) => { calls.push({ url, init }); return {
        res: { ok: true }, body: url === '/auth/me' ? { success: true, data: { user: { tenantId } } } : { ok: true },
      } },
    })
    if (tenantId === 'other') {
      await assert.rejects(rollback('batch/1'), /ATTENDANCE_IMPORT_SESSION_ORG_MISMATCH/)
      assert.equal(calls.length, 1)
    } else {
      assert.deepEqual(await rollback('batch/1'), { attempts: 1, rollbackMs: 0 })
      assert.equal(calls[1].url, '/attendance/import/rollback/batch%2F1')
      assert.equal(calls[1].init.body, '{}')
    }
  }
  assert.match(smoke, /requireImportSessionOrg\(rollbackSession\.body, orgId\)\s+const asyncRollback = await apiFetch/)
})

test('batch URL expressions in the three verifiers retain org and existing query options', () => {
  let count = 0
  for (const raw of [smoke, perf, productionFlow]) {
    const expressions = [...raw.matchAll(/`((?:\$\{apiBase\})?\/attendance\/import\/batches\/[^`]+)`/g)]
    assert.ok(expressions.length > 0)
    for (const [, expression] of expressions) {
      const value = Function('apiBase', 'batchId', 'asyncBatchId', 'orgId', 'exportType', `return \`${expression}\``)(
        'https://qa.invalid/api', 'batch/1', 'async/1', 'qa org&1', 'anomalies',
      )
      const url = new URL(value, 'https://qa.invalid')
      assert.equal(url.searchParams.get('orgId'), 'qa org&1')
      if (url.pathname.endsWith('/items')) assert.ok(['50', '200'].includes(url.searchParams.get('pageSize')))
      if (url.pathname.endsWith('/export.csv')) assert.equal(url.searchParams.get('type'), 'anomalies')
      count++
    }
  }
  assert.equal(count, 6)
})

test('attendance import payload remains inside the collapsed advanced panel contract', () => {
  const toggle = attendanceView.indexOf('data-testid="attendance-import-advanced-toggle"')
  const advanced = attendanceView.indexOf('data-testid="attendance-import-advanced"', toggle + 1)
  const payload = attendanceView.indexOf('id="attendance-import-payload"', advanced + 1)

  assert.notEqual(toggle, -1)
  assert.notEqual(advanced, -1)
  assert.notEqual(payload, -1)
  assert.ok(toggle < advanced)
  assert.ok(advanced < payload)
  assert.match(attendanceView.slice(advanced - 120, advanced + 120), /v-show="importAdvancedOpen"/)
})

for (const [name, raw] of [
  ['production flow', productionFlow],
  ['full flow', fullFlow],
]) {
  test(`${name} expands advanced import options before using the payload`, () => {
    const helper = functionSlice(raw, 'ensureImportAdvancedOptionsVisible', name === 'production flow'
      ? 'async function waitForJsonResponse'
      : 'function squashWhitespace')

    assert.match(helper, /payloadInput\.isVisible\(\)\.catch/)
    assert.match(helper, /attendance-import-advanced-toggle/)
    assert.match(helper, /const expanded = await toggle\.getAttribute\('aria-expanded'\)/)
    assert.match(helper, /if \(expanded !== 'true'\)/)
    assert.match(helper, /await toggle\.click\(\)/)
    assert.match(helper, /attendance-import-advanced/)
    assert.match(helper, /payloadInput\.waitFor\(\{ state: 'visible', timeout: waitMs \}\)/)
    assert.match(helper, /return payloadInput/)
  })
}

test('production flow opens advanced options after loading the import template', () => {
  const loadTemplate = productionFlow.indexOf("uiText.loadTemplate) }).click()")
  const expand = productionFlow.indexOf('await ensureImportAdvancedOptionsVisible(importSection)', loadTemplate)
  const buildCsv = productionFlow.indexOf('// Prepare a tiny CSV', loadTemplate)

  assert.notEqual(loadTemplate, -1)
  assert.notEqual(expand, -1)
  assert.notEqual(buildCsv, -1)
  assert.ok(loadTemplate < expand)
  assert.ok(expand < buildCsv)
})

test('full flow opens advanced options in retry and recovery entry points', () => {
  const retry = functionSlice(fullFlow, 'assertAdminRetryState', 'async function assertAdminSettingsSaveCycle')
  const recovery = functionSlice(fullFlow, 'assertImportJobRecoveryFlow', 'async function run')

  assert.match(retry, /const payloadInput = await ensureImportAdvancedOptionsVisible\(importSection\)/)
  assert.match(recovery, /const payloadInput = await ensureImportAdvancedOptionsVisible\(importSection\)/)
})

test('required strict contract case executes this verifier contract', () => {
  const strictCase = gateContractRunner.slice(
    gateContractRunner.indexOf('if [[ "$CASE_ID" == "strict" ]]'),
    gateContractRunner.indexOf('if [[ "$CASE_ID" == "openapi" ]]'),
  )

  assert.match(strictCase, /node --test \.\/scripts\/ops\/attendance-strict-import-advanced-contract\.test\.mjs/)
})

test('required openapi contract case executes attendance runtime-parity contract', () => {
  const openapiCase = gateContractRunner.slice(
    gateContractRunner.indexOf('if [[ "$CASE_ID" == "openapi" ]]'),
    gateContractRunner.indexOf('if [[ "$CASE_ID" == "dashboard" ]]'),
  )

  assert.match(
    openapiCase,
    /node --test \.\/scripts\/ops\/attendance-openapi-parity-4556-contract\.test\.mjs/,
  )
})
