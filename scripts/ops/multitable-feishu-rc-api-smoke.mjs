#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveMultitableAuthToken } from '../multitable-auth.mjs'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_TEMPLATE_ID = 'project-tracker'

const FIELD_SPECS = [
  { key: 'currency', type: 'currency', property: { code: 'CNY', decimals: 2 }, value: 123.45 },
  { key: 'percent', type: 'percent', property: { decimals: 2 }, value: 0.42 },
  { key: 'rating', type: 'rating', property: { max: 5 }, value: 4 },
  { key: 'url', type: 'url', property: {}, value: 'https://example.com/rc-smoke' },
  { key: 'email', type: 'email', property: {}, value: 'rc-smoke@example.com' },
  { key: 'phone', type: 'phone', property: {}, value: '+14155550123' },
  { key: 'barcode', type: 'barcode', property: {}, value: 'RC-SMOKE-001' },
  {
    key: 'location',
    type: 'location',
    property: {},
    value: { address: 'RC Smoke Location', latitude: 37.7749, longitude: -122.4194 },
  },
  { key: 'dateTime', type: 'dateTime', property: { timezone: 'UTC' }, value: '2026-05-06T12:00:00.000Z' },
  {
    key: 'multiSelect',
    type: 'multiSelect',
    property: {
      options: [
        { value: 'Alpha', color: '#2563eb' },
        { value: 'Beta', color: '#16a34a' },
        { value: 'Gamma', color: '#f97316' },
      ],
    },
    value: ['Alpha', 'Beta'],
  },
]

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function parseBoolean(value) {
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes'
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)
}

function buildDefaultOutputDir(now = new Date()) {
  return `output/multitable-feishu-rc-api-smoke/${timestampSlug(now)}`
}

export function parseConfig(env = process.env, now = new Date()) {
  const apiBase = normalizeBaseUrl(env.API_BASE || env.BASE_URL || env.STAGING_BASE_URL)
  const outputDir = String(env.OUTPUT_DIR || buildDefaultOutputDir(now))
  const timeoutMs = Number(env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  return {
    apiBase,
    authToken: String(env.AUTH_TOKEN || env.TOKEN || '').trim(),
    allowDevToken: parseBoolean(env.ALLOW_DEV_TOKEN),
    confirmWrite: parseBoolean(env.CONFIRM_WRITE),
    allowInstall: parseBoolean(env.ALLOW_INSTALL),
    templateId: String(env.TEMPLATE_ID || DEFAULT_TEMPLATE_ID).trim(),
    smokeSheetId: String(env.SMOKE_SHEET_ID || '').trim(),
    expectedCommit: String(env.EXPECTED_COMMIT || env.DEPLOY_SHA || env.GIT_SHA || '').trim(),
    outputDir,
    reportPath: String(env.REPORT_JSON || path.join(outputDir, 'report.json')),
    reportMdPath: String(env.REPORT_MD || path.join(outputDir, 'report.md')),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    skipPublicForm: parseBoolean(env.SKIP_PUBLIC_FORM),
    cleanup: parseBoolean(env.CLEANUP),
    runId: String(env.RUN_ID || `rc-api-smoke-${timestampSlug(now)}`).slice(0, 80),
  }
}

export function validateConfig(config) {
  const missing = []
  if (!config.apiBase) missing.push('API_BASE or BASE_URL')
  if (!config.authToken && !config.allowDevToken) missing.push('AUTH_TOKEN or TOKEN')
  if (!config.confirmWrite) missing.push('CONFIRM_WRITE=1')
  if (!config.smokeSheetId && !config.allowInstall) missing.push('SMOKE_SHEET_ID or ALLOW_INSTALL=1')
  return missing
}

export function renderRcApiSmokeMarkdown(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const failing = checks.filter((check) => check && check.ok === false)
  const skipped = checks.filter((check) => check?.details?.skipped === true)
  const lines = [
    '# Multitable Feishu RC API Smoke',
    '',
    `- Overall: **${report?.ok === false ? 'FAIL' : 'PASS'}**`,
    `- API base: \`${report?.apiBase || 'missing'}\``,
    `- Run ID: \`${report?.runId || 'missing'}\``,
    `- Started at: \`${report?.startedAt || 'missing'}\``,
    `- Finished at: \`${report?.finishedAt || 'missing'}\``,
    `- Expected commit: \`${report?.expectedCommit || 'not-set'}\``,
    `- JSON report: \`${report?.reportPath || 'missing'}\``,
    `- Markdown report: \`${report?.reportMdPath || 'missing'}\``,
    '',
    '## Checks',
    '',
    `- Total checks: \`${checks.length}\``,
    failing.length
      ? `- Failing checks: ${failing.map((check) => `\`${check.name}\``).join(', ')}`
      : '- Failing checks: none',
    skipped.length
      ? `- Skipped checks: ${skipped.map((check) => `\`${check.name}\``).join(', ')}`
      : '- Skipped checks: none',
  ]

  if (report?.metadata && Object.keys(report.metadata).length > 0) {
    lines.push('', '## Metadata', '')
    for (const [key, value] of Object.entries(report.metadata)) {
      lines.push(`- ${key}: \`${String(value)}\``)
    }
  }

  if (report?.error) {
    lines.push('', '## Error', '', `\`${report.error}\``)
  }

  lines.push('', '## Check Results', '')
  for (const check of checks) {
    const suffix = check.details?.skipped === true ? ' (skipped)' : ''
    lines.push(`- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}**${suffix}`)
    if (check.details?.reason) {
      lines.push(`  - reason: \`${check.details.reason}\``)
    }
    if (check.details?.status !== undefined) {
      lines.push(`  - status: \`${check.details.status}\``)
    }
  }

  lines.push(
    '',
    '## Manual Follow-up',
    '',
    '- XLSX import/export UI still needs browser verification.',
    '- Formula editor, filter builder, Gantt, hierarchy, and visual conditional formatting still need browser verification.',
    '- This smoke intentionally covers API-contract evidence only.',
  )

  return `${lines.join('\n')}\n`
}

function writeArtifacts(report) {
  fs.mkdirSync(path.dirname(report.reportPath), { recursive: true })
  fs.mkdirSync(path.dirname(report.reportMdPath), { recursive: true })
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(report.reportMdPath, renderRcApiSmokeMarkdown(report))
}

function createRecorder(report) {
  return (name, ok, details = {}) => {
    report.checks.push({ name, ok: Boolean(ok), details })
  }
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = { raw: text }
      }
    }
    return { res, json }
  } finally {
    clearTimeout(timeout)
  }
}

function authHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

async function requestJson(config, token, route, options = {}) {
  const url = `${config.apiBase}${route}`
  return fetchJson(url, {
    ...options,
    headers: {
      ...(token ? authHeaders(token) : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  }, config.timeoutMs)
}

function body(input) {
  return JSON.stringify(input)
}

function ensureOk(name, result) {
  if (!result.res.ok || result.json?.ok === false) {
    const code = result.json?.error?.code || result.json?.code || 'UNKNOWN'
    const message = result.json?.error?.message || result.json?.message || result.res.statusText
    throw new Error(`${name} failed (${result.res.status} ${code}): ${message}`)
  }
  return result.json
}

async function resolveToken(config, record) {
  if (config.authToken) {
    record('auth.token-present', true, { source: 'AUTH_TOKEN' })
    return config.authToken
  }
  if (!config.allowDevToken) {
    throw new Error('AUTH_TOKEN/TOKEN is required unless ALLOW_DEV_TOKEN=1')
  }
  return resolveMultitableAuthToken({
    apiBase: config.apiBase,
    envToken: '',
    fetchJson: (url) => fetchJson(url, {}, config.timeoutMs),
    record,
    perms: 'multitable:read,multitable:write,multitable:admin',
    userId: 'rc-api-smoke-admin',
    roles: 'admin',
  })
}

async function checkHealth(config, record) {
  const attempts = ['/api/health', '/health']
  let last = null
  for (const route of attempts) {
    const result = await fetchJson(`${config.apiBase}${route}`, {}, config.timeoutMs)
    last = result
    if (result.res.ok) {
      record('api.health', true, {
        route,
        status: result.res.status,
        ok: result.json?.ok ?? result.json?.status ?? null,
        pluginsSummary: result.json?.pluginsSummary ? JSON.stringify(result.json.pluginsSummary) : undefined,
        dbPool: result.json?.dbPool ? JSON.stringify(result.json.dbPool) : undefined,
      })
      return
    }
  }
  record('api.health', false, { status: last?.res?.status ?? 0 })
}

async function checkAuth(config, token, record, report) {
  const result = await requestJson(config, token, '/api/auth/me')
  const json = ensureOk('auth.me', result)
  const user = json?.user || json?.data?.user || json?.data || {}
  report.metadata.userHash = sha(user?.id || user?.userId || 'unknown')
  record('api.auth.me', true, { status: result.res.status, userHash: report.metadata.userHash })
}

async function probeIntegrationDescriptors(config, token, record) {
  const result = await requestJson(config, token, '/api/integration/staging/descriptors')
  if (!result.res.ok) {
    record('api.integration-staging.descriptors', true, {
      skipped: true,
      status: result.res.status,
      reason: 'integration staging plugin unavailable or disabled',
    })
    return
  }
  const descriptors = result.json?.data?.descriptors || result.json?.descriptors || []
  record('api.integration-staging.descriptors', true, {
    status: result.res.status,
    count: Array.isArray(descriptors) ? descriptors.length : 0,
  })
}

async function listTemplates(config, token, record) {
  const result = await requestJson(config, token, '/api/multitable/templates')
  const json = ensureOk('templates.list', result)
  const templates = json?.data?.templates || []
  const templateIds = Array.isArray(templates) ? templates.map((item) => item?.id).filter(Boolean) : []
  record('api.templates.list', templateIds.includes(config.templateId), {
    status: result.res.status,
    templateIds: templateIds.join(','),
  })
  if (!templateIds.includes(config.templateId)) {
    throw new Error(`Template not available: ${config.templateId}`)
  }
}

async function installTemplate(config, token, record, report) {
  const baseName = `RC API Smoke ${config.runId}`.slice(0, 255)
  const result = await requestJson(config, token, `/api/multitable/templates/${encodeURIComponent(config.templateId)}/install`, {
    method: 'POST',
    body: body({ baseName }),
  })
  const json = ensureOk('templates.install', result)
  const data = json?.data || {}
  const sheet = Array.isArray(data.sheets) ? data.sheets[0] : null
  if (!data.base?.id || !sheet?.id) {
    throw new Error('Template install response missing base/sheet ids')
  }
  report.metadata.baseId = data.base.id
  report.metadata.sheetId = sheet.id
  report.metadata.templateId = data.template?.id || config.templateId
  record('api.templates.install', true, {
    status: result.res.status,
    baseId: data.base.id,
    sheetId: sheet.id,
  })
  return { baseId: data.base.id, sheetId: sheet.id }
}

async function resolveWorkingSheet(config, token, record, report) {
  if (config.smokeSheetId) {
    const result = await requestJson(config, token, `/api/multitable/context?sheetId=${encodeURIComponent(config.smokeSheetId)}`)
    const json = ensureOk('context.sheet', result)
    const sheet = json?.data?.sheet || null
    if (!sheet?.id) throw new Error(`Unable to resolve SMOKE_SHEET_ID: ${config.smokeSheetId}`)
    report.metadata.baseId = sheet.baseId || json?.data?.base?.id || ''
    report.metadata.sheetId = sheet.id
    record('api.context.smoke-sheet', true, { status: result.res.status, sheetId: sheet.id })
    return { baseId: sheet.baseId || '', sheetId: sheet.id }
  }
  return installTemplate(config, token, record, report)
}

async function createSmokeFields(config, token, sheetId, record) {
  const created = {}
  for (const spec of FIELD_SPECS) {
    const result = await requestJson(config, token, '/api/multitable/fields', {
      method: 'POST',
      body: body({
        sheetId,
        name: `RC ${spec.key} ${config.runId}`.slice(0, 255),
        type: spec.type,
        property: spec.property,
      }),
    })
    const json = ensureOk(`fields.create.${spec.key}`, result)
    const field = json?.data?.field
    if (!field?.id || field.type !== spec.type) {
      throw new Error(`Field create response invalid for ${spec.key}`)
    }
    created[spec.key] = field
  }
  record('api.fields.batch-types', true, {
    count: Object.keys(created).length,
    types: FIELD_SPECS.map((spec) => spec.type).join(','),
  })
  return created
}

async function createRecord(config, token, sheetId, fields, record) {
  const data = {}
  for (const spec of FIELD_SPECS) {
    data[fields[spec.key].id] = spec.value
  }
  const result = await requestJson(config, token, '/api/multitable/records', {
    method: 'POST',
    body: body({ sheetId, data }),
  })
  const json = ensureOk('records.create', result)
  const created = json?.data?.record
  if (!created?.id || typeof created.version !== 'number') {
    throw new Error('Record create response missing id/version')
  }
  record('api.records.create', true, { status: result.res.status, recordId: created.id, version: created.version })
  return created
}

async function patchRecord(config, token, sheetId, fields, createdRecord, record) {
  const result = await requestJson(config, token, '/api/multitable/patch', {
    method: 'POST',
    body: body({
      sheetId,
      changes: [{
        recordId: createdRecord.id,
        fieldId: fields.currency.id,
        value: 234.56,
        expectedVersion: createdRecord.version,
      }],
    }),
  })
  const json = ensureOk('records.patch', result)
  const updated = json?.data?.updated || []
  const ok = Array.isArray(updated) && updated.some((item) => item?.recordId === createdRecord.id)
  record('api.records.patch.expected-version', ok, {
    status: result.res.status,
    updatedCount: Array.isArray(updated) ? updated.length : 0,
  })
  if (!ok) throw new Error('Patch response did not include created record')
}

async function createConditionalFormattingView(config, token, sheetId, fields, record) {
  const result = await requestJson(config, token, '/api/multitable/views', {
    method: 'POST',
    body: body({
      sheetId,
      name: `RC conditional ${config.runId}`.slice(0, 255),
      type: 'grid',
      config: {
        conditionalFormattingRules: [{
          id: `rc-rule-${sha(config.runId)}`,
          order: 0,
          fieldId: fields.currency.id,
          operator: 'gt',
          value: 100,
          style: { backgroundColor: '#fff4cc', textColor: '#7c2d12', applyToRow: false },
        }],
      },
    }),
  })
  const json = ensureOk('views.conditional-formatting', result)
  const rules = json?.data?.view?.config?.conditionalFormattingRules
  const ok = Array.isArray(rules) && rules.length === 1 && rules[0]?.fieldId === fields.currency.id
  record('api.views.conditional-formatting', ok, { status: result.res.status, ruleCount: Array.isArray(rules) ? rules.length : 0 })
  if (!ok) throw new Error('Conditional formatting rule was not persisted')
}

async function runPublicFormSmoke(config, token, sheetId, fields, record) {
  if (config.skipPublicForm) {
    record('api.public-form.submit', true, { skipped: true, reason: 'SKIP_PUBLIC_FORM=1' })
    return
  }
  const viewResult = await requestJson(config, token, '/api/multitable/views', {
    method: 'POST',
    body: body({
      sheetId,
      name: `RC public form ${config.runId}`.slice(0, 255),
      type: 'form',
      hiddenFieldIds: [],
      config: {},
    }),
  })
  const viewJson = ensureOk('views.form.create', viewResult)
  const viewId = viewJson?.data?.view?.id
  if (!viewId) throw new Error('Form view create response missing id')

  const shareResult = await requestJson(config, token, `/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share`, {
    method: 'PATCH',
    body: body({ enabled: true, accessMode: 'public' }),
  })
  const shareJson = ensureOk('form-share.enable', shareResult)
  const publicToken = shareJson?.data?.publicToken || shareJson?.data?.publicForm?.publicToken
  if (!publicToken) throw new Error('Public form share did not return a public token')

  const contextResult = await fetchJson(
    `${config.apiBase}/api/multitable/form-context?viewId=${encodeURIComponent(viewId)}&publicToken=${encodeURIComponent(publicToken)}`,
    {},
    config.timeoutMs,
  )
  ensureOk('form-context.public', contextResult)

  const submitResult = await fetchJson(
    `${config.apiBase}/api/multitable/views/${encodeURIComponent(viewId)}/submit?publicToken=${encodeURIComponent(publicToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body({
        data: {
          [fields.email.id]: 'public-submit@example.com',
          [fields.currency.id]: 88.8,
          [fields.rating.id]: 5,
        },
      }),
    },
    config.timeoutMs,
  )
  const submitJson = ensureOk('public-form.submit', submitResult)
  record('api.public-form.submit', true, {
    status: submitResult.res.status,
    recordId: submitJson?.data?.record?.id || submitJson?.data?.recordId || '',
  })
}

async function cleanupCreatedSheet(config, token, sheetId, record) {
  if (!config.cleanup) return
  const result = await requestJson(config, token, `/api/multitable/sheets/${encodeURIComponent(sheetId)}`, {
    method: 'DELETE',
  })
  if (result.res.ok) {
    record('api.cleanup.sheet', true, { status: result.res.status, sheetId })
  } else {
    record('api.cleanup.sheet', true, {
      skipped: true,
      status: result.res.status,
      reason: 'cleanup failed; smoke evidence was already collected',
    })
  }
}

export async function runRcApiSmoke(inputConfig = parseConfig()) {
  const config = { ...inputConfig }
  const report = {
    ok: false,
    apiBase: config.apiBase,
    runId: config.runId,
    expectedCommit: config.expectedCommit,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    reportPath: config.reportPath,
    reportMdPath: config.reportMdPath,
    checks: [],
    metadata: {},
  }
  const record = createRecorder(report)

  try {
    const missing = validateConfig(config)
    if (missing.length > 0) {
      throw new Error(`Missing required config: ${missing.join(', ')}`)
    }

    await checkHealth(config, record)
    const token = await resolveToken(config, record)
    await checkAuth(config, token, record, report)
    await probeIntegrationDescriptors(config, token, record)
    await listTemplates(config, token, record)
    const { sheetId } = await resolveWorkingSheet(config, token, record, report)
    const fields = await createSmokeFields(config, token, sheetId, record)
    const createdRecord = await createRecord(config, token, sheetId, fields, record)
    await patchRecord(config, token, sheetId, fields, createdRecord, record)
    await createConditionalFormattingView(config, token, sheetId, fields, record)
    await runPublicFormSmoke(config, token, sheetId, fields, record)
    await cleanupCreatedSheet(config, token, sheetId, record)

    report.ok = report.checks.every((check) => check.ok !== false)
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
    report.ok = false
  } finally {
    report.finishedAt = new Date().toISOString()
    writeArtifacts(report)
  }

  if (!report.ok) {
    throw new Error(`Multitable Feishu RC API smoke failed; see ${report.reportMdPath}`)
  }
  return report
}

async function main() {
  await runRcApiSmoke(parseConfig())
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
