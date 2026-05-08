#!/usr/bin/env node
/**
 * Multitable RC Staging Smoke — automated remote verification.
 *
 * Pure HTTP harness (no Playwright / no browser) covering the six
 * RC TODO smoke surfaces against a deployed multitable backend:
 *
 *   1. lifecycle           — create base/sheet/field/view/record + GET records
 *   2. public-form         — admin enable accessMode='public' + anonymous submit + admin verify persisted
 *   3. hierarchy           — self-table link parent field + PATCH self-parent → 400 + HIERARCHY_CYCLE
 *   4. gantt-config        — gantt view with non-link dependencyFieldId → 400 + VALIDATION_ERROR + self-table link msg
 *   5. formula             — formula field with `={A.id}+{B.id}` expression + verify persisted property
 *   6. automation-email    — record.created → send_email rule + create record + poll /logs ≤12s + assert step shape
 *   7. autoNumber-backfill — autoNumber field on existing-records sheet + verify backfilled values
 *
 * The harness does NOT trigger real SMTP — the default
 * EmailNotificationChannel mocks the send and returns
 * notificationStatus='sent', so the smoke validates the wire
 * without depending on mail infrastructure.
 *
 * Companion to the local Playwright specs at
 * `packages/core-backend/tests/e2e/multitable-*-smoke.spec.ts`. The
 * Playwright specs run against a local dev stack and skip when
 * unreachable; this script runs against a deployed staging URL and
 * fails-loud (non-zero exit) when checks miss.
 *
 * Env (all read from process.env):
 *   API_BASE         http://host:port — required, no trailing slash
 *   AUTH_TOKEN       Bearer token of an admin-capable user — required
 *   OUTPUT_DIR       directory for report artifacts (default output/multitable-rc-staging-smoke)
 *   REPORT_JSON      report.json path (default <OUTPUT_DIR>/report.json)
 *   REPORT_MD        report.md path (default <OUTPUT_DIR>/report.md)
 *   POLL_TIMEOUT_MS  send_email log poll timeout (default 12000)
 *   POLL_INTERVAL_MS send_email log poll interval (default 1000)
 *   SKIP             comma-separated check names to skip (e.g. SKIP=automation-email)
 *
 * Exit codes:
 *   0 — all selected checks passed
 *   1 — at least one check failed
 *   2 — env / fatal error before any check ran
 *
 * Usage:
 *   AUTH_TOKEN=<jwt> API_BASE=http://142.171.239.56:8081 \
 *     node scripts/verify-multitable-rc-staging-smoke.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const apiBase = (process.env.API_BASE || '').replace(/\/+$/, '')
const authToken = process.env.AUTH_TOKEN || ''
const outputDir = process.env.OUTPUT_DIR || 'output/multitable-rc-staging-smoke'
const reportJsonPath = process.env.REPORT_JSON || path.join(outputDir, 'report.json')
const reportMdPath = process.env.REPORT_MD || path.join(outputDir, 'report.md')
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS || 12000)
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000)
const skipSet = new Set(
  (process.env.SKIP || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
)

if (!apiBase) {
  console.error('[rc-smoke] API_BASE env is required (e.g. http://142.171.239.56:8081)')
  process.exit(2)
}
if (!authToken) {
  console.error('[rc-smoke] AUTH_TOKEN env is required (Bearer token of an admin user)')
  process.exit(2)
}

mkdirSync(outputDir, { recursive: true })

const authHeaders = {
  Authorization: `Bearer ${authToken}`,
  'Content-Type': 'application/json',
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`
const uniqueLabel = (prefix) => `rc-${prefix}-${stamp}-${Math.floor(Math.random() * 1000)}`

async function authPost(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch {}
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(json)}`)
  }
  return json
}

async function authPostExpectingFailure(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

async function authPatch(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch {}
  if (!res.ok) {
    throw new Error(`PATCH ${path} → ${res.status}: ${JSON.stringify(json)}`)
  }
  return json
}

async function authPatchExpectingFailure(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

async function authGet(path) {
  const res = await fetch(`${apiBase}${path}`, { method: 'GET', headers: authHeaders })
  let json = null
  try { json = await res.json() } catch {}
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(json)}`)
  }
  return json
}

async function anonPost(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, ok: res.ok, body: json }
}

function requireValue(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Expected ${label} in API response`)
  }
  return value
}

async function createBase(name) {
  return requireValue((await authPost('/api/multitable/bases', { name })).data?.base, 'base')
}

async function createSheet(baseId, name) {
  return requireValue((await authPost('/api/multitable/sheets', { baseId, name })).data?.sheet, 'sheet')
}

async function createField(sheetId, name, type, property) {
  const body = { sheetId, name, type }
  if (property) body.property = property
  return requireValue((await authPost('/api/multitable/fields', body)).data?.field, `${type} field ${name}`)
}

async function createView(sheetId, name, type, config) {
  const body = { sheetId, name }
  if (type) body.type = type
  if (config) body.config = config
  return requireValue((await authPost('/api/multitable/views', body)).data?.view, `${type ?? 'grid'} view ${name}`)
}

async function createRecord(sheetId, data) {
  return requireValue((await authPost('/api/multitable/records', { sheetId, data })).data?.record, 'record')
}

const checks = []

function registerCheck(name, fn) {
  checks.push({ name, fn })
}

// ── 1. lifecycle ────────────────────────────────────────────────────────────

registerCheck('lifecycle', async () => {
  const label = uniqueLabel('lifecycle')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const field = await createField(sheet.id, 'Title', 'string')
  const cellValue = `lifecycle-${stamp}`
  const record = await createRecord(sheet.id, { [field.id]: cellValue })
  if (record.data?.[field.id] !== cellValue) {
    throw new Error(`Created record value mismatch: expected '${cellValue}', got '${record.data?.[field.id]}'`)
  }
  const recordsBody = await authGet(`/api/multitable/records?sheetId=${sheet.id}`)
  const rows = recordsBody.data?.records ?? []
  const persisted = rows.find((row) => row.id === record.id)
  if (!persisted) throw new Error(`Record ${record.id} not visible via GET /records`)
  if (persisted.data?.[field.id] !== cellValue) {
    throw new Error(`Record value drift after read-back: '${persisted.data?.[field.id]}'`)
  }
  return { sheetId: sheet.id, recordId: record.id, fieldId: field.id }
})

// ── 2. public-form ──────────────────────────────────────────────────────────

registerCheck('public-form', async () => {
  const label = uniqueLabel('pf')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const field = await createField(sheet.id, 'Title', 'string')
  const view = await createView(sheet.id, 'Default Grid', 'grid')

  const shareBody = await authPatch(
    `/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share`,
    { enabled: true, accessMode: 'public' },
  )
  const publicToken = requireValue(shareBody.data?.publicToken, 'publicToken')

  const submitValue = `pf-anon-${stamp}`
  const submit = await anonPost(`/api/multitable/views/${view.id}/submit`, {
    publicToken,
    data: { [field.id]: submitValue },
  })
  if (!submit.ok) throw new Error(`Anonymous submit failed: ${submit.status} ${JSON.stringify(submit.body)}`)
  const newRecordId = requireValue(submit.body?.data?.record?.id, 'submitted record id')

  const recordsBody = await authGet(`/api/multitable/records?sheetId=${sheet.id}`)
  const persisted = (recordsBody.data?.records ?? []).find((row) => row.id === newRecordId)
  if (!persisted) throw new Error(`Submitted record ${newRecordId} not visible to admin`)
  if (persisted.data?.[field.id] !== submitValue) {
    throw new Error(`Submitted value drift: '${persisted.data?.[field.id]}'`)
  }

  // Negative: stale token must reject
  const stale = await anonPost(`/api/multitable/views/${view.id}/submit`, {
    publicToken: 'definitely-not-the-real-token',
    data: { [field.id]: 'should-not-persist' },
  })
  if (stale.status !== 401) {
    throw new Error(`Expected 401 for stale-token anonymous submit; got ${stale.status}`)
  }
  return { sheetId: sheet.id, viewId: view.id, recordId: newRecordId }
})

// ── 3. hierarchy ────────────────────────────────────────────────────────────

registerCheck('hierarchy', async () => {
  const label = uniqueLabel('h')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const title = await createField(sheet.id, 'Title', 'string')
  const parent = await createField(sheet.id, 'Parent', 'link', {
    foreignSheetId: sheet.id,
    limitSingleRecord: true,
  })
  await createView(sheet.id, 'Hierarchy', 'hierarchy', { parentFieldId: parent.id })

  const record = await createRecord(sheet.id, { [title.id]: 'self-loop-candidate' })
  const fail = await authPatchExpectingFailure(`/api/multitable/records/${record.id}`, {
    sheetId: sheet.id,
    data: { [parent.id]: [record.id] },
  })
  if (fail.status !== 400) {
    throw new Error(`Self-parent PATCH expected 400, got ${fail.status}: ${JSON.stringify(fail.body)}`)
  }
  if (fail.body?.error?.code !== 'HIERARCHY_CYCLE') {
    throw new Error(`Expected error.code 'HIERARCHY_CYCLE', got '${fail.body?.error?.code}'`)
  }
  return { sheetId: sheet.id, parentFieldId: parent.id, recordId: record.id }
})

// ── 4. gantt-config ─────────────────────────────────────────────────────────

registerCheck('gantt-config', async () => {
  const label = uniqueLabel('g')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const title = await createField(sheet.id, 'Title', 'string')
  const startField = await createField(sheet.id, 'Start', 'date')
  const endField = await createField(sheet.id, 'End', 'date')
  const view = await createView(sheet.id, 'Gantt', 'gantt', {
    startFieldId: startField.id,
    endFieldId: endField.id,
    titleFieldId: title.id,
  })

  // Non-link dependencyFieldId must be rejected by validateGanttDependencyConfig.
  const fail = await authPatchExpectingFailure(`/api/multitable/views/${view.id}`, {
    sheetId: sheet.id,
    type: 'gantt',
    config: {
      startFieldId: startField.id,
      endFieldId: endField.id,
      titleFieldId: title.id,
      dependencyFieldId: title.id,
    },
  })
  if (fail.status !== 400) {
    throw new Error(`Non-link dependency PATCH expected 400, got ${fail.status}: ${JSON.stringify(fail.body)}`)
  }
  if (fail.body?.error?.code !== 'VALIDATION_ERROR') {
    throw new Error(`Expected error.code 'VALIDATION_ERROR', got '${fail.body?.error?.code}'`)
  }
  if (typeof fail.body?.error?.message !== 'string' || !fail.body.error.message.includes('self-table link field')) {
    throw new Error(`Expected error.message to contain 'self-table link field', got '${fail.body?.error?.message}'`)
  }
  return { sheetId: sheet.id, viewId: view.id }
})

// ── 5. formula ──────────────────────────────────────────────────────────────

registerCheck('formula', async () => {
  const label = uniqueLabel('f')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const numA = await createField(sheet.id, 'A', 'number')
  const numB = await createField(sheet.id, 'B', 'number')
  const expression = `={${numA.id}} + {${numB.id}}`
  const formula = await createField(sheet.id, 'Sum', 'formula', { expression })

  const fieldsBody = await authGet(`/api/multitable/fields?sheetId=${sheet.id}`)
  const fields = fieldsBody.data?.fields ?? []
  const persisted = fields.find((f) => f.id === formula.id)
  if (!persisted) throw new Error(`Formula field ${formula.id} not in field list`)
  if (persisted.type !== 'formula') {
    throw new Error(`Formula field type drift: '${persisted.type}'`)
  }
  if (persisted.property?.expression !== expression) {
    throw new Error(`Formula expression drift: '${persisted.property?.expression}' vs '${expression}'`)
  }
  return { sheetId: sheet.id, formulaFieldId: formula.id }
})

// ── 6. automation-email ─────────────────────────────────────────────────────

registerCheck('automation-email', async () => {
  const label = uniqueLabel('ae')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const title = await createField(sheet.id, 'Title', 'string')
  const owner = await createField(sheet.id, 'Owner', 'string')

  const recipients = ['team@test.local', 'lead@test.local']
  const ruleEnv = await authPost(`/api/multitable/sheets/${sheet.id}/automations`, {
    name: `${label}-rule`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'send_email',
    actionConfig: {
      recipients,
      subjectTemplate: `[rc-staging] new record {{recordId}}`,
      bodyTemplate: `Title={{record.${title.id}}} Owner={{record.${owner.id}}}`,
    },
    enabled: true,
  })
  const rule = requireValue(ruleEnv.data?.rule, 'rule')

  await createRecord(sheet.id, { [title.id]: `rc-staging-task-${stamp}`, [owner.id]: 'Alice' })

  const deadline = Date.now() + pollTimeoutMs
  let lastBody = null
  while (Date.now() < deadline) {
    const res = await fetch(
      `${apiBase}/api/multitable/sheets/${sheet.id}/automations/${rule.id}/logs?limit=10`,
      { headers: authHeaders },
    )
    if (res.ok) {
      const body = await res.json().catch(() => null)
      lastBody = body
      const execution = body?.executions?.[0]
      if (execution) {
        if (execution.status !== 'success') {
          throw new Error(`Execution status='${execution.status}'; expected 'success'. Body: ${JSON.stringify(body)}`)
        }
        const step = execution.steps?.[0]
        if (step?.actionType !== 'send_email') {
          throw new Error(`step.actionType='${step?.actionType}'; expected 'send_email'`)
        }
        if (step?.status !== 'success') {
          throw new Error(`step.status='${step?.status}'; expected 'success'`)
        }
        if (step?.output?.recipientCount !== recipients.length) {
          throw new Error(`step.output.recipientCount=${step?.output?.recipientCount}; expected ${recipients.length}`)
        }
        if (step?.output?.notificationStatus !== 'sent') {
          throw new Error(`step.output.notificationStatus='${step?.output?.notificationStatus}'; expected 'sent'`)
        }
        return { sheetId: sheet.id, ruleId: rule.id, executionId: execution.id }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`No automation execution observed within ${pollTimeoutMs}ms; last logs body: ${JSON.stringify(lastBody)}`)
})

// ── 7. autoNumber-backfill ──────────────────────────────────────────────────

registerCheck('autoNumber-backfill', async () => {
  const label = uniqueLabel('an')
  const base = await createBase(`${label}-base`)
  const sheet = await createSheet(base.id, `${label}-sheet`)
  const title = await createField(sheet.id, 'Title', 'string')

  // Create records BEFORE the autoNumber field, so backfill is exercised.
  const r1 = await createRecord(sheet.id, { [title.id]: `pre-an-1-${stamp}` })
  const r2 = await createRecord(sheet.id, { [title.id]: `pre-an-2-${stamp}` })
  const r3 = await createRecord(sheet.id, { [title.id]: `pre-an-3-${stamp}` })

  const startAt = 1000
  const seq = await createField(sheet.id, 'No.', 'autoNumber', {
    start: startAt,
    prefix: 'INV-',
    digits: 4,
  })

  const recordsBody = await authGet(`/api/multitable/records?sheetId=${sheet.id}`)
  const rows = recordsBody.data?.records ?? []
  const ids = [r1.id, r2.id, r3.id]
  const values = ids.map((id) => rows.find((row) => row.id === id)?.data?.[seq.id])
  for (const [i, value] of values.entries()) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new Error(`Backfill missing for record[${i}] ${ids[i]}; got: ${JSON.stringify(value)}`)
    }
  }

  // Server-side raw-write rejection: client cannot supply autoNumber value.
  const raw = await authPostExpectingFailure('/api/multitable/records', {
    sheetId: sheet.id,
    data: { [title.id]: 'raw-write-attempt', [seq.id]: 9999 },
  })
  if (raw.status !== 403) {
    throw new Error(`Raw autoNumber write expected 403, got ${raw.status}: ${JSON.stringify(raw.body)}`)
  }
  if (raw.body?.error?.code !== 'FIELD_READONLY') {
    throw new Error(`Expected error.code 'FIELD_READONLY', got '${raw.body?.error?.code}'`)
  }

  // Subsequent fresh record gets next value (after backfill consumed [startAt..startAt+2]).
  const r4 = await createRecord(sheet.id, { [title.id]: `post-an-${stamp}` })
  const r4Value = r4.data?.[seq.id]
  if (typeof r4Value !== 'number') {
    throw new Error(`New record after backfill missing autoNumber value; got: ${JSON.stringify(r4Value)}`)
  }
  if (r4Value < startAt + 3) {
    throw new Error(`New record value=${r4Value} < expected >=${startAt + 3} after 3-record backfill`)
  }

  return { sheetId: sheet.id, fieldId: seq.id, backfilled: values, freshValue: r4Value }
})

// ── runner ──────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
const results = []
for (const { name, fn } of checks) {
  if (skipSet.has(name)) {
    console.error(`[rc-smoke] SKIP ${name}`)
    results.push({ name, status: 'skipped', durationMs: 0 })
    continue
  }
  const t0 = Date.now()
  try {
    const evidence = await fn()
    const durationMs = Date.now() - t0
    console.error(`[rc-smoke] PASS ${name} (${durationMs}ms)`)
    results.push({ name, status: 'pass', durationMs, evidence })
  } catch (err) {
    const durationMs = Date.now() - t0
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[rc-smoke] FAIL ${name} (${durationMs}ms): ${message}`)
    results.push({ name, status: 'fail', durationMs, error: message })
  }
}
const finishedAt = new Date().toISOString()

const passes = results.filter((r) => r.status === 'pass').length
const fails = results.filter((r) => r.status === 'fail').length
const skips = results.filter((r) => r.status === 'skipped').length

const report = {
  apiBase,
  startedAt,
  finishedAt,
  total: results.length,
  passes,
  fails,
  skips,
  results,
}

writeFileSync(reportJsonPath, JSON.stringify(report, null, 2))

const mdLines = []
mdLines.push(`# Multitable RC Staging Smoke Report`)
mdLines.push('')
mdLines.push(`- API: \`${apiBase}\``)
mdLines.push(`- Started: ${startedAt}`)
mdLines.push(`- Finished: ${finishedAt}`)
mdLines.push(`- Total: ${results.length} (pass=${passes}, fail=${fails}, skip=${skips})`)
mdLines.push('')
mdLines.push('| Check | Status | Duration |')
mdLines.push('| --- | --- | --- |')
for (const r of results) {
  mdLines.push(`| ${r.name} | ${r.status} | ${r.durationMs}ms |`)
}
mdLines.push('')
const failures = results.filter((r) => r.status === 'fail')
if (failures.length > 0) {
  mdLines.push('## Failures')
  mdLines.push('')
  for (const r of failures) {
    mdLines.push(`### ${r.name}`)
    mdLines.push('')
    mdLines.push('```')
    mdLines.push(r.error ?? '(unknown error)')
    mdLines.push('```')
    mdLines.push('')
  }
}
writeFileSync(reportMdPath, mdLines.join('\n') + '\n')

console.error(`[rc-smoke] report json: ${reportJsonPath}`)
console.error(`[rc-smoke] report md:   ${reportMdPath}`)
console.error(`[rc-smoke] result: ${passes} pass / ${fails} fail / ${skips} skip / ${results.length} total`)

process.exit(fails > 0 ? 1 : 0)
