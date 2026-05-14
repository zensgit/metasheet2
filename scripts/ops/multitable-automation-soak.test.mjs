import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolveAutomationSoakConfig, runAutomationSoak } from './multitable-automation-soak.mjs'

const SCRIPT = 'scripts/ops/multitable-automation-soak.mjs'

function makeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

function makeFakeFetch() {
  let fieldSeq = 0
  let ruleSeq = 0
  let recordSeq = 0
  const fields = []
  const rules = []
  const records = []
  const executionsByRuleId = new Map()

  function addExecutions(record) {
    for (const rule of rules) {
      const step = {
        actionType: rule.actionType,
        status: rule.expectedFailure ? 'failed' : 'success',
      }
      if (rule.actionType === 'update_record') {
        step.output = { updatedFields: Object.keys(rule.actionConfig.fields ?? {}) }
        Object.assign(record.data, rule.actionConfig.fields ?? {})
      } else if (rule.actionType === 'send_email') {
        step.output = { recipientCount: 2, notificationStatus: 'sent' }
      } else if (rule.actionType === 'send_webhook' && rule.expectedFailure) {
        step.error = 'Webhook failed after 3 attempts: HTTP 500'
      } else if (rule.actionType === 'send_webhook') {
        step.output = { httpStatus: 204, attempt: 1 }
      }
      const execution = {
        id: `exec_${rule.id}_${record.id}`,
        status: rule.expectedFailure ? 'failed' : 'success',
        steps: [step],
      }
      const current = executionsByRuleId.get(rule.id) ?? []
      executionsByRuleId.set(rule.id, [execution, ...current])
    }
  }

  return async function fakeFetch(url, options = {}) {
    const parsed = new URL(url)
    const route = parsed.pathname
    const body = options.body ? JSON.parse(options.body) : {}

    if (options.method === 'POST' && route === '/api/multitable/bases') {
      return makeJsonResponse(200, { data: { base: { id: 'base_fake', name: body.name } } })
    }
    if (options.method === 'POST' && route === '/api/multitable/sheets') {
      return makeJsonResponse(200, { data: { sheet: { id: 'sheet_fake', baseId: body.baseId } } })
    }
    if (options.method === 'POST' && route === '/api/multitable/fields') {
      fieldSeq += 1
      const field = { id: `field_${fieldSeq}`, name: body.name, type: body.type }
      fields.push(field)
      return makeJsonResponse(200, { data: { field } })
    }
    if (options.method === 'POST' && route === '/api/multitable/sheets/sheet_fake/automations') {
      ruleSeq += 1
      const rule = {
        id: `rule_${ruleSeq}`,
        actionType: body.actionType,
        actionConfig: body.actionConfig,
        expectedFailure: body.name.includes('fail'),
      }
      rules.push(rule)
      executionsByRuleId.set(rule.id, [])
      return makeJsonResponse(200, { data: { rule } })
    }
    if (options.method === 'POST' && route === '/api/multitable/records') {
      recordSeq += 1
      const record = { id: `record_${recordSeq}`, data: { ...body.data } }
      records.push(record)
      addExecutions(record)
      return makeJsonResponse(200, { data: { record } })
    }
    if (options.method === 'GET' && route === '/api/multitable/records') {
      return makeJsonResponse(200, { data: { records } })
    }
    const logs = route.match(/^\/api\/multitable\/sheets\/sheet_fake\/automations\/([^/]+)\/logs$/)
    if (options.method === 'GET' && logs) {
      return makeJsonResponse(200, { executions: executionsByRuleId.get(logs[1]) ?? [] })
    }
    return makeJsonResponse(404, { error: { message: `unhandled ${options.method} ${route}` } })
  }
}

function completeEnv() {
  return {
    API_BASE: 'https://metasheet.test',
    AUTH_TOKEN: 'fake-admin-token',
    MULTITABLE_AUTOMATION_SOAK_CONFIRM: '1',
    MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE: 'mock',
    MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL: 'https://sink.test/success',
    MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL: 'https://sink.test/fail',
    MULTITABLE_AUTOMATION_SOAK_ITERATIONS: '2',
    POLL_TIMEOUT_MS: '200',
    POLL_INTERVAL_MS: '1',
  }
}

test('resolveAutomationSoakConfig blocks by default', () => {
  const config = resolveAutomationSoakConfig({})
  assert.equal(config.ok, false)
  assert.ok(config.missingEnv.includes('API_BASE'))
  assert.ok(config.messages.some((message) => message.includes('CONFIRM')))
})

test('resolveAutomationSoakConfig rejects credential-bearing API_BASE', () => {
  const config = resolveAutomationSoakConfig({
    ...completeEnv(),
    API_BASE: 'https://user:pass@metasheet.test?token=secret',
  })
  assert.equal(config.ok, false)
  assert.ok(config.messages.some((message) => message.includes('credentials')))
})

test('runAutomationSoak returns blocked report when required env is missing', async () => {
  const report = await runAutomationSoak({ env: {}, fetchFn: makeFakeFetch() })
  assert.equal(report.status, 'blocked')
  assert.equal(report.exitCode, 2)
  assert.ok(report.missingEnv.includes('AUTH_TOKEN'))
})

test('runAutomationSoak passes against fake API and validates expected-failure webhook logs', async () => {
  const report = await runAutomationSoak({ env: completeEnv(), fetchFn: makeFakeFetch() })
  assert.equal(report.status, 'pass')
  assert.equal(report.exitCode, 0)
  assert.equal(report.evidence.iterations, 2)
  assert.equal(report.evidence.recordsCreated, 2)
  const failureRule = report.evidence.rules.find((rule) => rule.expectedFailure)
  assert.equal(failureRule.actionType, 'send_webhook')
  assert.equal(failureRule.executions, 2)
})

test('spawned script blocks by default and writes redacted artifacts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-automation-soak-'))
  try {
    const result = spawnSync('node', [SCRIPT], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_SOAK_OUTPUT_DIR: dir,
        AUTOMATION_SOAK_JSON: path.join(dir, 'report.json'),
        AUTOMATION_SOAK_MD: path.join(dir, 'report.md'),
        AUTH_TOKEN: 'Bearer leaky-admin-token-value',
        MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL: 'https://sink.test/success?access_token=leaky-token',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
    const json = readFileSync(path.join(dir, 'report.json'), 'utf8')
    const md = readFileSync(path.join(dir, 'report.md'), 'utf8')
    const all = `${result.stdout}\n${result.stderr}\n${json}\n${md}`
    assert.doesNotMatch(all, /leaky-admin-token-value/)
    assert.doesNotMatch(all, /leaky-token/)
    assert.match(all, /blocked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
