#!/usr/bin/env node

/**
 * Multitable Phase 3 Automation Soak Gate.
 *
 * Remote/API harness for the shipped automation execution paths. It is
 * blocked by default and only runs when an operator provides an admin token,
 * a deployed API, explicit confirmation, and controlled webhook sinks.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { buildReport, writeReport } from './multitable-phase3-release-gate-report.mjs'
import { redactString } from './multitable-phase3-release-gate-redact.mjs'

const TOOL = 'multitable-automation-soak'
const DEFAULT_OUTPUT_DIR = 'output/multitable-automation-soak'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_BLOCKED = 2

export const REQUIRED_ENV = [
  'API_BASE',
  'AUTH_TOKEN',
  'MULTITABLE_AUTOMATION_SOAK_CONFIRM',
  'MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE',
  'MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL',
  'MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL',
]

function envString(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : ''
}

function normalizeApiBase(rawValue) {
  const value = (rawValue || '').trim().replace(/\/+$/, '')
  if (!value) return { ok: false, value: '', error: 'API_BASE is required' }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, value: '', error: 'API_BASE must be an absolute http(s) URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, value: '', error: 'API_BASE must use http or https' }
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      ok: false,
      value: '',
      error: 'API_BASE must not contain credentials, query, or fragment',
    }
  }
  return { ok: true, value }
}

function normalizeWebhookUrl(rawValue, label) {
  const value = (rawValue || '').trim()
  if (!value) return { ok: false, value: '', error: `${label} is required` }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, value: '', error: `${label} must be an absolute http(s) URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, value: '', error: `${label} must use http or https` }
  }
  return { ok: true, value }
}

function normalizeIterations(rawValue) {
  if (!rawValue) return 3
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(1, Math.min(10, Math.floor(parsed)))
}

export function resolveAutomationSoakConfig(env = process.env) {
  const missingEnv = REQUIRED_ENV.filter((name) => !envString(env, name))
  const messages = []
  const apiBase = normalizeApiBase(envString(env, 'API_BASE'))
  const webhookUrl = normalizeWebhookUrl(
    envString(env, 'MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL'),
    'MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL',
  )
  const failWebhookUrl = normalizeWebhookUrl(
    envString(env, 'MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL'),
    'MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL',
  )
  const confirm = envString(env, 'MULTITABLE_AUTOMATION_SOAK_CONFIRM') === '1'
  const emailSafeMode = envString(env, 'MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE')
  if (!apiBase.ok) messages.push(apiBase.error)
  if (!webhookUrl.ok) messages.push(webhookUrl.error)
  if (!failWebhookUrl.ok) messages.push(failWebhookUrl.error)
  if (!confirm) messages.push('MULTITABLE_AUTOMATION_SOAK_CONFIRM=1 is required')
  if (emailSafeMode !== 'mock') {
    messages.push('MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE=mock is required')
  }
  return {
    ok:
      missingEnv.length === 0 &&
      apiBase.ok &&
      webhookUrl.ok &&
      failWebhookUrl.ok &&
      confirm &&
      emailSafeMode === 'mock',
    apiBase: apiBase.value,
    authToken: envString(env, 'AUTH_TOKEN'),
    webhookUrl: webhookUrl.value,
    failWebhookUrl: failWebhookUrl.value,
    iterations: normalizeIterations(envString(env, 'MULTITABLE_AUTOMATION_SOAK_ITERATIONS')),
    pollTimeoutMs: Number(envString(env, 'POLL_TIMEOUT_MS')) || 15000,
    pollIntervalMs: Number(envString(env, 'POLL_INTERVAL_MS')) || 1000,
    missingEnv,
    messages,
  }
}

function requireValue(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Expected ${label} in API response`)
  }
  return value
}

function uniqueLabel(prefix) {
  return `phase3-soak-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function makeClient(config, fetchFn) {
  const headers = {
    Authorization: `Bearer ${config.authToken}`,
    'Content-Type': 'application/json',
  }
  async function request(method, urlPath, body) {
    const response = await fetchFn(`${config.apiBase}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json = null
    try {
      json = await response.json()
    } catch {}
    if (!response.ok) {
      throw new Error(`${method} ${urlPath} -> ${response.status}: ${JSON.stringify(json)}`)
    }
    return json
  }
  return {
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body) => request('POST', urlPath, body),
  }
}

async function createBase(client, name) {
  return requireValue((await client.post('/api/multitable/bases', { name })).data?.base, 'base')
}

async function createSheet(client, baseId, name) {
  return requireValue((await client.post('/api/multitable/sheets', { baseId, name })).data?.sheet, 'sheet')
}

async function createField(client, sheetId, name, type) {
  return requireValue(
    (await client.post('/api/multitable/fields', { sheetId, name, type })).data?.field,
    `${type} field ${name}`,
  )
}

async function createRecord(client, sheetId, data) {
  return requireValue(
    (await client.post('/api/multitable/records', { sheetId, data })).data?.record,
    'record',
  )
}

async function createAutomationRule(client, sheetId, body) {
  return requireValue(
    (await client.post(`/api/multitable/sheets/${sheetId}/automations`, body)).data?.rule,
    `automation rule ${body.name}`,
  )
}

async function getAutomationLogs(client, sheetId, ruleId, limit) {
  const body = await client.get(`/api/multitable/sheets/${sheetId}/automations/${ruleId}/logs?limit=${limit}`)
  return Array.isArray(body?.executions) ? body.executions : []
}

async function pollForExecutions(client, config, sheetId, ruleId, count) {
  const deadline = Date.now() + config.pollTimeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await getAutomationLogs(client, sheetId, ruleId, Math.max(20, count + 5))
    if (last.length >= count) return last.slice(0, count)
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))
  }
  throw new Error(`Expected ${count} executions for rule ${ruleId}; observed ${last.length}`)
}

function assertAllExecutions(executions, ruleName, expectedStatus, expectedActionType) {
  for (const execution of executions) {
    if (execution.status !== expectedStatus) {
      throw new Error(`${ruleName} execution ${execution.id} status=${execution.status}; expected ${expectedStatus}`)
    }
    const step = execution.steps?.[0]
    if (step?.actionType !== expectedActionType) {
      throw new Error(`${ruleName} step.actionType=${step?.actionType}; expected ${expectedActionType}`)
    }
    if (step?.status !== expectedStatus) {
      throw new Error(`${ruleName} step.status=${step?.status}; expected ${expectedStatus}`)
    }
  }
}

async function runConfiguredSoak(config, fetchFn) {
  const client = makeClient(config, fetchFn)
  const label = uniqueLabel('d4')
  const base = await createBase(client, `${label}-base`)
  const sheet = await createSheet(client, base.id, `${label}-sheet`)
  const title = await createField(client, sheet.id, 'Title', 'string')
  const status = await createField(client, sheet.id, 'Status', 'string')
  const owner = await createField(client, sheet.id, 'Owner', 'string')

  const updateRule = await createAutomationRule(client, sheet.id, {
    name: `${label}-update-record`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'update_record',
    actionConfig: { fields: { [status.id]: 'soaked' } },
    enabled: true,
  })
  const emailRule = await createAutomationRule(client, sheet.id, {
    name: `${label}-send-email`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'send_email',
    actionConfig: {
      recipients: ['phase3-soak-team-test-local', 'phase3-soak-lead-test-local'],
      subjectTemplate: '[phase3-soak] {{recordId}}',
      bodyTemplate: `Title={{record.${title.id}}} Owner={{record.${owner.id}}}`,
    },
    enabled: true,
  })
  const webhookRule = await createAutomationRule(client, sheet.id, {
    name: `${label}-send-webhook`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'send_webhook',
    actionConfig: {
      url: config.webhookUrl,
      method: 'POST',
      body: { source: 'phase3-automation-soak', mode: 'success' },
    },
    enabled: true,
  })
  const failWebhookRule = await createAutomationRule(client, sheet.id, {
    name: `${label}-send-webhook-fail`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'send_webhook',
    actionConfig: {
      url: config.failWebhookUrl,
      method: 'POST',
      body: { source: 'phase3-automation-soak', mode: 'expected-failure' },
    },
    enabled: true,
  })

  const createdRecords = []
  for (let i = 0; i < config.iterations; i += 1) {
    const record = await createRecord(client, sheet.id, {
      [title.id]: `${label}-record-${i + 1}`,
      [owner.id]: `owner-${i + 1}`,
    })
    createdRecords.push(record.id)
  }

  const [updateExecutions, emailExecutions, webhookExecutions, failWebhookExecutions] = await Promise.all([
    pollForExecutions(client, config, sheet.id, updateRule.id, config.iterations),
    pollForExecutions(client, config, sheet.id, emailRule.id, config.iterations),
    pollForExecutions(client, config, sheet.id, webhookRule.id, config.iterations),
    pollForExecutions(client, config, sheet.id, failWebhookRule.id, config.iterations),
  ])

  assertAllExecutions(updateExecutions, 'update_record', 'success', 'update_record')
  assertAllExecutions(emailExecutions, 'send_email', 'success', 'send_email')
  assertAllExecutions(webhookExecutions, 'send_webhook', 'success', 'send_webhook')
  assertAllExecutions(failWebhookExecutions, 'send_webhook expected failure', 'failed', 'send_webhook')

  for (const step of emailExecutions.map((execution) => execution.steps?.[0])) {
    if (step?.output?.recipientCount !== 2) {
      throw new Error(`send_email recipientCount=${step?.output?.recipientCount}; expected 2`)
    }
    if (step?.output?.notificationStatus !== 'sent') {
      throw new Error(`send_email notificationStatus=${step?.output?.notificationStatus}; expected sent`)
    }
  }
  for (const step of webhookExecutions.map((execution) => execution.steps?.[0])) {
    const httpStatus = Number(step?.output?.httpStatus)
    if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
      throw new Error(`send_webhook httpStatus=${step?.output?.httpStatus}; expected 2xx`)
    }
  }
  for (const step of failWebhookExecutions.map((execution) => execution.steps?.[0])) {
    if (!step?.error) {
      throw new Error('expected-failure webhook step did not record an error')
    }
  }

  const records = (await client.get(`/api/multitable/records?sheetId=${sheet.id}`)).data?.records ?? []
  for (const recordId of createdRecords) {
    const persisted = records.find((record) => record.id === recordId)
    if (!persisted) throw new Error(`created record ${recordId} missing from read-back`)
    if (persisted.data?.[status.id] !== 'soaked') {
      throw new Error(`record ${recordId} status=${persisted.data?.[status.id]}; expected soaked`)
    }
  }

  return {
    sheetId: sheet.id,
    iterations: config.iterations,
    recordsCreated: createdRecords.length,
    rules: [
      { actionType: 'update_record', ruleId: updateRule.id, executions: updateExecutions.length },
      { actionType: 'send_email', ruleId: emailRule.id, executions: emailExecutions.length },
      { actionType: 'send_webhook', ruleId: webhookRule.id, executions: webhookExecutions.length },
      {
        actionType: 'send_webhook',
        ruleId: failWebhookRule.id,
        executions: failWebhookExecutions.length,
        expectedFailure: true,
      },
    ],
  }
}

export async function runAutomationSoak({ env = process.env, fetchFn = globalThis.fetch } = {}) {
  const startedAt = new Date().toISOString()
  const config = resolveAutomationSoakConfig(env)
  if (!config.ok) {
    return {
      tool: TOOL,
      gate: 'automation:soak',
      status: 'blocked',
      exitCode: EXIT_BLOCKED,
      reason: 'Automation soak is BLOCKED until API/auth/confirm/email-safe-mode/webhook sink env is configured.',
      requiredEnv: REQUIRED_ENV,
      missingEnv: config.missingEnv,
      messages: config.messages,
      startedAt,
      completedAt: new Date().toISOString(),
    }
  }
  try {
    const evidence = await runConfiguredSoak(config, fetchFn)
    return {
      tool: TOOL,
      gate: 'automation:soak',
      status: 'pass',
      exitCode: EXIT_PASS,
      reason: 'Automation soak passed.',
      startedAt,
      completedAt: new Date().toISOString(),
      iterations: config.iterations,
      evidence,
    }
  } catch (error) {
    return {
      tool: TOOL,
      gate: 'automation:soak',
      status: 'fail',
      exitCode: EXIT_FAIL,
      reason: redactString(error instanceof Error ? error.message : String(error)),
      startedAt,
      completedAt: new Date().toISOString(),
      iterations: config.iterations,
    }
  }
}

function outputPath(env, envName, fallback) {
  const raw = envString(env, envName)
  return path.resolve(process.cwd(), raw || fallback)
}

async function main() {
  const outputDir = outputPath(process.env, 'AUTOMATION_SOAK_OUTPUT_DIR', DEFAULT_OUTPUT_DIR)
  const outputJson = outputPath(process.env, 'AUTOMATION_SOAK_JSON', path.join(outputDir, 'report.json'))
  const outputMd = outputPath(process.env, 'AUTOMATION_SOAK_MD', path.join(outputDir, 'report.md'))
  mkdirSync(outputDir, { recursive: true })
  const result = await runAutomationSoak()
  const report = buildReport(result)
  writeReport({ outputJson, outputMd, report })
  console.log(redactString(`[${TOOL}] status=${report.status} exit=${report.exitCode}`))
  console.log(redactString(`[${TOOL}] report json: ${outputJson}`))
  console.log(redactString(`[${TOOL}] report md:   ${outputMd}`))
  return report.exitCode
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  main()
    .then((exitCode) => {
      process.exit(exitCode)
    })
    .catch((error) => {
      console.error(redactString(error instanceof Error ? error.message : String(error)))
      process.exit(EXIT_FAIL)
    })
}
