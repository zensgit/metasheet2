import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { chromium } from '@playwright/test'
import { resolveMultitableAuthToken } from './multitable-auth.mjs'

const require = createRequire(import.meta.url)
const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/multitable-live-smoke'
const reportPath = process.env.REPORT_JSON || path.join(outputDir, 'report.json')
const reportMdPath = process.env.REPORT_MD || path.join(outputDir, 'report.md')
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.TIMEOUT_MS || 30000)
const runMode = process.env.RUN_MODE || 'local'

const report = {
  ok: true,
  apiBase,
  webBase,
  runMode,
  outputDir: path.resolve(outputDir),
  reportPath: path.resolve(reportPath),
  reportMdPath: path.resolve(reportMdPath),
  headless,
  startedAt: new Date().toISOString(),
  checks: [],
}
const recordedCheckNames = new Set()

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) report.ok = false
}

function recordOnce(name, ok, details = {}) {
  if (recordedCheckNames.has(name)) return
  recordedCheckNames.add(name)
  record(name, ok, details)
}

function exactTextRegex(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
}

const fieldTypeSmokeSpecs = [
  {
    key: 'currency',
    idPart: 'currency',
    label: 'Currency',
    type: 'currency',
    property: { code: 'CNY', decimals: 2 },
    value: 1234.56,
  },
  {
    key: 'percent',
    idPart: 'percent',
    label: 'Percent',
    type: 'percent',
    property: { decimals: 1 },
    value: 37.5,
  },
  {
    key: 'rating',
    idPart: 'rating',
    label: 'Rating',
    type: 'rating',
    property: { max: 5 },
    value: 4,
  },
  {
    key: 'url',
    idPart: 'url',
    label: 'URL',
    type: 'url',
    value: 'https://example.com/multitable-rc',
  },
  {
    key: 'email',
    idPart: 'email',
    label: 'Email',
    type: 'email',
    value: 'rc-field-types@example.com',
  },
  {
    key: 'phone',
    idPart: 'phone',
    label: 'Phone',
    type: 'phone',
    value: '+86 138 0000 0000',
  },
  {
    key: 'longText',
    idPart: 'long_text',
    label: 'Long Text',
    type: 'longText',
    value: 'Line one field smoke\nLine two field smoke',
  },
  {
    key: 'multiSelect',
    idPart: 'multi_select',
    label: 'Multi Select',
    type: 'multiSelect',
    property: {
      options: [
        { value: 'Alpha', color: '#3b82f6' },
        { value: 'Beta', color: '#22c55e' },
        { value: 'Gamma', color: '#f59e0b' },
      ],
    },
    value: ['Alpha', 'Gamma'],
  },
]

function formFieldByLabel(page, fieldName) {
  return page.locator('.meta-form-view__field').filter({
    has: page.locator('.meta-form-view__label').filter({ hasText: exactTextRegex(fieldName) }),
  }).first()
}

function recordCommentsButton(page) {
  return page.locator('.meta-record-drawer__btn--comment[title="Comments"]').first()
}

async function importXlsxModule() {
  const resolved = require.resolve('xlsx', {
    paths: [
      path.resolve('apps/web'),
      path.resolve('packages/core-backend'),
      process.cwd(),
    ],
  })
  return import(pathToFileURL(resolved).href)
}

async function addAndResolveRecordComment(page) {
  const commentsDrawer = page.locator('.meta-comments-drawer')
  await commentsDrawer.waitFor({ state: 'visible', timeout: timeoutMs })
  const commentText = `smoke comment ${Date.now()}`
  const commentBox = commentsDrawer.getByRole('textbox', { name: 'Add a comment...' })
  await commentBox.fill(commentText)
  await commentsDrawer.getByRole('button', { name: 'Send' }).click()
  const commentThread = commentsDrawer.locator('.meta-comments-drawer__thread').filter({ hasText: commentText }).first()
  await commentThread.waitFor({ state: 'attached', timeout: timeoutMs })
  await commentThread.scrollIntoViewIfNeeded()
  await commentThread.locator('.meta-comments-drawer__resolve').click()
  await commentThread.locator('.meta-comments-drawer__badge').getByText('Resolved', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })
  return commentText
}

export function renderSmokeMarkdown(reportPayload) {
  const checks = Array.isArray(reportPayload?.checks) ? reportPayload.checks : []
  const failingChecks = checks.filter((item) => item && item.ok === false)
  const metadata = reportPayload?.metadata && typeof reportPayload.metadata === 'object' ? reportPayload.metadata : null
  const lines = [
    '# Multitable Live Smoke',
    '',
    `- Overall: **${reportPayload?.ok === false ? 'FAIL' : 'PASS'}**`,
    `- Run mode: \`${reportPayload?.runMode || 'local'}\``,
    `- API base: \`${reportPayload?.apiBase || 'missing'}\``,
    `- Web base: \`${reportPayload?.webBase || 'missing'}\``,
    `- Headless: \`${reportPayload?.headless === false ? 'false' : 'true'}\``,
    `- Started at: \`${reportPayload?.startedAt || 'missing'}\``,
    `- Finished at: \`${reportPayload?.finishedAt || 'missing'}\``,
    `- JSON report: \`${reportPayload?.reportPath || 'missing'}\``,
    `- Markdown report: \`${reportPayload?.reportMdPath || 'missing'}\``,
    '',
    '## Checks',
    '',
    `- Total checks: \`${checks.length}\``,
    failingChecks.length
      ? `- Failing checks: ${failingChecks.map((item) => `\`${item.name}\``).join(', ')}`
      : '- Failing checks: none',
  ]

  if (reportPayload?.error) {
    lines.push(`- Error: \`${reportPayload.error}\``)
  }

  if (metadata && Object.keys(metadata).length) {
    lines.push('', '## Metadata', '')
    for (const [key, value] of Object.entries(metadata)) {
      lines.push(`- ${key}: \`${String(value)}\``)
    }
  }

  lines.push('', '## Check Results', '')
  for (const check of checks) {
    lines.push(`- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
  }

  return `${lines.join('\n')}\n`
}

function writeSmokeArtifacts(reportPayload) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(reportPayload, null, 2))
  fs.mkdirSync(path.dirname(reportMdPath), { recursive: true })
  fs.writeFileSync(reportMdPath, renderSmokeMarkdown(reportPayload))
}

async function waitForLocatorInputValue(locator, expectedValue) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await locator.inputValue() === expectedValue) return
    } catch {
      // Keep polling while the dialog/input settles.
    }
    await locator.page().waitForTimeout(100)
  }
  throw new Error(`Timed out waiting for input value ${expectedValue}`)
}

async function waitForPredicate(predicate, label) {
  const deadline = Date.now() + timeoutMs
  let lastValue = null
  while (Date.now() < deadline) {
    try {
      lastValue = await predicate()
      if (lastValue?.ok) return lastValue
    } catch (error) {
      lastValue = { error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`${label} timed out: ${JSON.stringify(lastValue)}`)
}

async function waitForActionButtonEnabled(button, label) {
  return waitForPredicate(async () => {
    const visible = await button.isVisible().catch(() => false)
    const disabled = await button.isDisabled().catch(() => true)
    const warningTexts = await button.page().locator('.meta-import__warning').allTextContents().catch(() => [])
    const warningText = warningTexts.map((text) => text.trim()).filter(Boolean).join(' | ')
    const fixesVisible = await button.page().locator('.meta-import__fixes').isVisible().catch(() => false)
    return {
      ok: visible && !disabled,
      visible,
      disabled,
      warningText,
      fixesVisible,
    }
  }, label)
}

async function ensureImportFieldMapped(page, { headerText, fieldId, label }) {
  const mappingRow = page.locator('.meta-import__map-row').filter({ hasText: headerText }).first()
  const fieldSelect = mappingRow.locator('.meta-import__field-select')
  await fieldSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  const currentValue = await fieldSelect.inputValue().catch(() => '')
  if (currentValue !== fieldId) {
    await fieldSelect.selectOption(fieldId)
  }
  await waitForLocatorInputValue(fieldSelect, fieldId)
  return waitForPredicate(async () => {
    const value = await fieldSelect.inputValue().catch(() => '')
    return {
      ok: value === fieldId,
      value,
      headerText,
      fieldId,
    }
  }, label)
}

async function ensureImportFieldMappedByColumnIndex(page, { columnIndex, fieldId, label }) {
  const fieldSelect = page.locator('.meta-import__field-select').nth(columnIndex)
  await fieldSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  const currentValue = await fieldSelect.inputValue().catch(() => '')
  if (currentValue !== fieldId) {
    await fieldSelect.selectOption(fieldId)
  }
  return waitForPredicate(async () => {
    const value = await fieldSelect.inputValue().catch(() => '')
    return {
      ok: value === fieldId,
      value,
      columnIndex,
      fieldId,
    }
  }, label)
}

async function selectLinkPickerOption(page, { display, label }) {
  const pickerSearch = page.locator('.meta-link-picker__input')
  await pickerSearch.fill(display)
  const target = page.locator('.meta-link-picker__item').filter({ hasText: display }).first()
  const directMatch = await target.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 10_000) })
    .then(() => true)
    .catch(() => false)
  if (directMatch) {
    await target.click()
    return display
  }

  // Some live people sheets use generated IDs as display values; the search
  // endpoint can be stricter than the initial option list. Fall back to the
  // first selectable option so repair flows still exercise a real link choice.
  await pickerSearch.fill('')
  const fallbackTarget = page.locator('.meta-link-picker__item').first()
  await waitForPredicate(async () => {
    const visible = await fallbackTarget.isVisible().catch(() => false)
    const loading = await page.locator('.meta-link-picker__loading').isVisible().catch(() => false)
    const empty = await page.locator('.meta-link-picker__empty').isVisible().catch(() => false)
    const fallbackText = visible ? (await fallbackTarget.textContent().catch(() => '')) : ''
    return {
      ok: visible && !loading,
      visible,
      loading,
      empty,
      display,
      fallbackText,
    }
  }, `${label} fallback option`)
  const fallbackText = ((await fallbackTarget.textContent()) ?? '').trim().replace(/\s+/g, ' ')
  await fallbackTarget.click()
  return fallbackText || display
}

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

async function ensureOk(name, result, details = {}) {
  const ok = Boolean(result?.res?.ok && (result?.json?.ok ?? true))
  record(name, ok, {
    status: result?.res?.status ?? 0,
    ...details,
    ...(ok ? {} : { body: result?.json }),
  })
  if (!ok) {
    const permissionDenied = result?.res?.status === 403 && result?.json?.error === 'Insufficient permissions'
    if (permissionDenied) {
      throw new Error(`${name} failed: insufficient permissions. For local dev-token smoke, restart the backend with RBAC_TOKEN_TRUST=true or use a real admin token.`)
    }
    throw new Error(`${name} failed`)
  }
  return result.json
}

async function getAuthToken() {
  const perms = [
    'multitable:read',
    'multitable:write',
    'comments:read',
    'comments:write',
    'permissions:read',
    'permissions:write',
    'approvals:read',
    'approvals:write',
  ].join(',')
  return resolveMultitableAuthToken({
    apiBase,
    envToken: process.env.AUTH_TOKEN || '',
    fetchJson,
    record,
    perms,
  })
}

async function fetchHealth() {
  const result = await fetchJson(`${apiBase}/health`)
  await ensureOk('api.health', result)
}

async function fetchBases(token) {
  const result = await fetchJson(`${apiBase}/api/multitable/bases`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.bases', result)
  return Array.isArray(json?.data?.bases) ? json.data.bases : []
}

async function fetchContext(token, query) {
  const result = await fetchJson(`${apiBase}/api/multitable/context?${new URLSearchParams(query).toString()}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.context', result, query)
  return json.data
}

async function createSheet(token, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/sheets`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.create-sheet', result, input)
  return json.data.sheet
}

async function fetchFields(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.fields', result, { sheetId })
  return Array.isArray(json?.data?.fields) ? json.data.fields : []
}

async function createField(token, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.create-field', result, { sheetId: input.sheetId, fieldId: input.id, name: input.name, type: input.type })
  return json.data.field
}

async function createFieldTypeSmokeFields(token, sheetId, titlePrefix) {
  const stamp = Date.now()
  const fields = []
  for (const spec of fieldTypeSmokeSpecs) {
    const field = await createField(token, {
      id: `fld_pilot_${spec.idPart}_${stamp}`,
      sheetId,
      name: `${spec.label} ${titlePrefix}`,
      type: spec.type,
      ...(spec.property ? { property: spec.property } : {}),
    })
    fields.push({ ...spec, field })
  }
  return fields
}

function fieldTypeSmokePatchValues(specs) {
  return Object.fromEntries(specs.map((spec) => [spec.field.id, spec.value]))
}

async function updateField(token, fieldId, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields/${encodeURIComponent(fieldId)}`, {
    method: 'PATCH',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.update-field', result, { fieldId, ...input })
  return json.data.field
}

async function preparePersonField(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/person-fields/prepare`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sheetId }),
  })
  const json = await ensureOk('api.multitable.prepare-person-field', result, { sheetId })
  return json.data
}

async function fetchViews(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/views?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.views', result, { sheetId })
  return Array.isArray(json?.data?.views) ? json.data.views : []
}

async function createView(token, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/views`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.create-view', result, input)
  return json.data.view
}

async function updateView(token, viewId, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/views/${encodeURIComponent(viewId)}`, {
    method: 'PATCH',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.update-view', result, { viewId, ...input })
  return json.data.view
}

async function deleteField(token, fieldId) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields/${encodeURIComponent(fieldId)}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  await ensureOk('api.multitable.delete-field', result, { fieldId })
}

async function deleteView(token, viewId) {
  const result = await fetchJson(`${apiBase}/api/multitable/views/${encodeURIComponent(viewId)}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  await ensureOk('api.multitable.delete-view', result, { viewId })
}

async function fetchViewData(token, params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const result = await fetchJson(`${apiBase}/api/multitable/view?${query.toString()}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.view', result, params)
  return json.data
}

async function fetchRecord(token, sheetId, recordId) {
  const result = await fetchJson(`${apiBase}/api/multitable/records/${encodeURIComponent(recordId)}?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.record', result, { sheetId, recordId })
  return json.data
}

async function patchRecord(token, { sheetId, viewId, recordId, fieldId, value, expectedVersion }) {
  const result = await fetchJson(`${apiBase}/api/multitable/patch`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      sheetId,
      viewId,
      changes: [{ recordId, fieldId, value, expectedVersion }],
    }),
  })
  const json = await ensureOk('api.multitable.patch', result, { sheetId, viewId, recordId, fieldId })
  return json.data
}

async function patchFields(token, { sheetId, viewId, recordId, expectedVersion, values }) {
  const result = await fetchJson(`${apiBase}/api/multitable/patch`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      sheetId,
      viewId,
      changes: Object.entries(values).map(([fieldId, value]) => ({
        recordId,
        fieldId,
        value,
        expectedVersion,
      })),
    }),
  })
  const json = await ensureOk('api.multitable.patch', result, { sheetId, viewId, recordId, fieldIds: Object.keys(values) })
  return json.data
}

async function fetchLinkOptions(token, fieldId, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const result = await fetchJson(`${apiBase}/api/multitable/fields/${encodeURIComponent(fieldId)}/link-options?${query.toString()}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.link-options', result, { fieldId, ...params })
  return json.data
}

async function deleteAttachment(token, attachmentId) {
  const result = await fetchJson(`${apiBase}/api/multitable/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  await ensureOk('api.multitable.delete-attachment', result, { attachmentId })
}

async function uploadAttachmentApi(token, { sheetId, recordId, fieldId }) {
  const filename = `smoke-test-${Date.now()}.txt`
  const content = `smoke test attachment ${new Date().toISOString()}\n`
  const form = new FormData()
  form.set('sheetId', sheetId)
  form.set('recordId', recordId)
  form.set('fieldId', fieldId)
  form.set('file', new File([content], filename, { type: 'text/plain' }))
  return fetchJson(`${apiBase}/api/multitable/attachments`, {
    method: 'POST',
    headers: headers(token),
    body: form,
  })
}

async function createCommentApi(token, { spreadsheetId, rowId, content, mentions }) {
  return fetchJson(`${apiBase}/api/comments`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ spreadsheetId, rowId, content, mentions: mentions ?? [] }),
  })
}

async function listCommentsApi(token, spreadsheetId, rowId) {
  return fetchJson(`${apiBase}/api/comments?spreadsheetId=${encodeURIComponent(spreadsheetId)}&rowId=${encodeURIComponent(rowId)}`, {
    headers: headers(token),
  })
}

async function resolveCommentApi(token, commentId) {
  return fetchJson(`${apiBase}/api/comments/${encodeURIComponent(commentId)}/resolve`, {
    method: 'POST',
    headers: headers(token),
  })
}

async function deleteCommentApi(token, commentId) {
  return fetchJson(`${apiBase}/api/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
    headers: headers(token),
  })
}

async function deleteRecord(token, recordId, expectedVersion) {
  const query = typeof expectedVersion === 'number'
    ? `?expectedVersion=${encodeURIComponent(String(expectedVersion))}`
    : ''
  const result = await fetchJson(`${apiBase}/api/multitable/records/${encodeURIComponent(recordId)}${query}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  await ensureOk('api.multitable.delete-record', result, { recordId })
}

async function submitViewForm(token, viewId, data) {
  const result = await fetchJson(`${apiBase}/api/multitable/views/${encodeURIComponent(viewId)}/submit`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data }),
  })
  const json = await ensureOk('api.multitable.view-submit', result, {
    viewId,
    fieldIds: Object.keys(data),
  })
  return json.data
}

async function createAdminUser(token, input) {
  const result = await fetchJson(`${apiBase}/api/admin/users`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.admin.create-user', result, {
    email: input.email,
    role: input.role,
  })
  return json.data
}

async function ensurePilotSheet(token, baseId) {
  const context = await fetchContext(token, { baseId })
  const existing = Array.isArray(context?.sheets)
    ? context.sheets.find((sheet) => sheet.name === 'Multitable Pilot Smoke')
    : null
  if (existing) return existing
  return createSheet(token, {
    id: 'sheet_multitable_pilot_smoke',
    baseId,
    name: 'Multitable Pilot Smoke',
    description: 'Browser smoke sheet for multitable pilot validation',
    seed: false,
  })
}

async function ensureField(token, sheetId, matcher, createInput) {
  const fields = await fetchFields(token, sheetId)
  const existing = fields.find(matcher)
  if (existing) return existing
  return createField(token, createInput)
}

async function ensureFieldMatches(token, field, expected) {
  const patch = {}
  if (typeof expected.name === 'string' && field.name !== expected.name) {
    patch.name = expected.name
  }
  if (typeof expected.type === 'string' && field.type !== expected.type) {
    patch.type = expected.type
  }
  if (expected.property !== undefined) {
    const actualProperty = JSON.stringify(field.property ?? null)
    const expectedProperty = JSON.stringify(expected.property ?? null)
    if (actualProperty !== expectedProperty) {
      patch.property = expected.property
    }
  }
  if (!Object.keys(patch).length) return field
  return updateField(token, field.id, patch)
}

async function ensurePilotFields(token, sheetId) {
  const titleField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_title' || (field.name === 'Title' && field.type === 'string'),
    { id: 'fld_pilot_title', sheetId, name: 'Title', type: 'string' },
  )
  const normalizedTitleField = await ensureFieldMatches(token, titleField, {
    name: 'Title',
    type: 'string',
  })

  const attachmentField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_files' || (field.name === 'Files' && field.type === 'attachment'),
    { id: 'fld_pilot_files', sheetId, name: 'Files', type: 'attachment' },
  )
  const normalizedAttachmentField = await ensureFieldMatches(token, attachmentField, {
    name: 'Files',
    type: 'attachment',
    property: {
      maxFiles: 7,
      acceptedMimeTypes: ['text/plain'],
    },
  })

  const personPreset = await preparePersonField(token, sheetId)

  const fields = await fetchFields(token, sheetId)
  const existingPersonField = fields.find((field) =>
    field.id === 'fld_pilot_owner' ||
    (field.name === 'Owner' && field.type === 'link' && field.property?.refKind === 'user'),
  )
  if (existingPersonField) {
    const normalizedPersonField = await ensureFieldMatches(token, existingPersonField, {
      name: 'Owner',
      type: 'link',
      property: personPreset.fieldProperty,
    })
    return { titleField: normalizedTitleField, attachmentField: normalizedAttachmentField, personField: normalizedPersonField }
  }

  const personField = await createField(token, {
    id: 'fld_pilot_owner',
    sheetId,
    name: 'Owner',
    type: 'link',
    property: personPreset.fieldProperty,
  })

  return { titleField: normalizedTitleField, attachmentField: normalizedAttachmentField, personField }
}

async function ensureSelectablePersonOption(token, sheetId, personFieldId) {
  const initial = await fetchLinkOptions(token, personFieldId, { limit: 20 })
  const initialChoice = Array.isArray(initial?.records) ? initial.records[0] : null
  if (initialChoice?.id) return initialChoice

  const email = `multitable-pilot-${Date.now()}@example.com`
  await createAdminUser(token, {
    email,
    name: 'Multitable Pilot User',
    role: 'admin',
    password: 'PilotSmoke123!',
    isActive: true,
  })

  await preparePersonField(token, sheetId)
  const replay = await fetchLinkOptions(token, personFieldId, { limit: 20 })
  const replayChoice = Array.isArray(replay?.records) ? replay.records[0] : null
  if (replayChoice?.id) return replayChoice

  throw new Error('No selectable person record available for person preset smoke')
}

async function ensureReplayFields(token, sheetId) {
  const statusField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_status' || (field.name === 'Status' && field.type === 'select'),
    {
      id: 'fld_pilot_status',
      sheetId,
      name: 'Status',
      type: 'select',
      property: {
        options: [
          { value: 'Todo', color: '#94a3b8' },
          { value: 'Doing', color: '#f59e0b' },
          { value: 'Done', color: '#22c55e' },
        ],
      },
    },
  )

  const priorityField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_priority' || (field.name === 'Priority' && field.type === 'select'),
    {
      id: 'fld_pilot_priority',
      sheetId,
      name: 'Priority',
      type: 'select',
      property: {
        options: [
          { value: 'P1', color: '#ef4444' },
          { value: 'P2', color: '#3b82f6' },
        ],
      },
    },
  )

  const startField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_start' || (field.name === 'Start' && field.type === 'date'),
    { id: 'fld_pilot_start', sheetId, name: 'Start', type: 'date' },
  )

  const endField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_end' || (field.name === 'End' && field.type === 'date'),
    { id: 'fld_pilot_end', sheetId, name: 'End', type: 'date' },
  )

  return { statusField, priorityField, startField, endField }
}

async function ensureView(token, sheetId, { id, type, name, config, groupInfo }) {
  const views = await fetchViews(token, sheetId)
  const existing = views.find((view) => view.id === id || (view.type === type && view.name === name))
  if (existing) {
    if (config || groupInfo) {
      return updateView(token, existing.id, { name, config, groupInfo })
    }
    return existing
  }
  const created = await createView(token, { id, sheetId, type, name, config, groupInfo })
  if (config || groupInfo) {
    return updateView(token, created.id, { name, config, groupInfo })
  }
  return created
}

async function ensurePilotViews(token, sheetId, fieldIds = {}) {
  const gridView = await ensureView(token, sheetId, {
    id: 'view_pilot_grid',
    type: 'grid',
    name: 'Pilot Grid',
  })
  const formView = await ensureView(token, sheetId, {
    id: 'view_pilot_form',
    type: 'form',
    name: 'Pilot Form',
  })
  const galleryView = await ensureView(token, sheetId, {
    id: 'view_pilot_gallery',
    type: 'gallery',
    name: 'Pilot Gallery',
    config: {
      titleFieldId: fieldIds.titleFieldId ?? 'fld_pilot_title',
      coverFieldId: fieldIds.attachmentFieldId ?? 'fld_pilot_files',
      fieldIds: [fieldIds.statusFieldId ?? 'fld_pilot_status', fieldIds.personFieldId ?? 'fld_pilot_owner'],
      columns: 2,
      cardSize: 'medium',
    },
  })
  const calendarView = await ensureView(token, sheetId, {
    id: 'view_pilot_calendar',
    type: 'calendar',
    name: 'Pilot Calendar',
    config: {
      dateFieldId: fieldIds.startFieldId ?? 'fld_pilot_start',
      endDateFieldId: fieldIds.endFieldId ?? 'fld_pilot_end',
      titleFieldId: fieldIds.titleFieldId ?? 'fld_pilot_title',
      defaultView: 'month',
      weekStartsOn: 1,
    },
  })
  const timelineView = await ensureView(token, sheetId, {
    id: 'view_pilot_timeline',
    type: 'timeline',
    name: 'Pilot Timeline',
    config: {
      startFieldId: fieldIds.startFieldId ?? 'fld_pilot_start',
      endFieldId: fieldIds.endFieldId ?? 'fld_pilot_end',
      labelFieldId: fieldIds.titleFieldId ?? 'fld_pilot_title',
      zoom: 'week',
    },
  })
  const kanbanView = await ensureView(token, sheetId, {
    id: 'view_pilot_kanban',
    type: 'kanban',
    name: 'Pilot Kanban',
    config: {
      groupFieldId: fieldIds.statusFieldId ?? 'fld_pilot_status',
      cardFieldIds: [
        fieldIds.personFieldId ?? 'fld_pilot_owner',
        fieldIds.attachmentFieldId ?? 'fld_pilot_files',
      ],
    },
    groupInfo: {
      fieldId: fieldIds.statusFieldId ?? 'fld_pilot_status',
    },
  })
  return { gridView, formView, galleryView, calendarView, timelineView, kanbanView }
}

async function findRecordBySearch(token, sheetId, viewId, search) {
  const data = await fetchViewData(token, {
    sheetId,
    viewId,
    limit: 10,
    offset: 0,
    includeLinkSummaries: true,
    search,
  })
  return {
    row: Array.isArray(data?.rows) ? data.rows[0] : null,
    linkSummaries: data?.linkSummaries ?? {},
    attachmentSummaries: data?.attachmentSummaries ?? {},
    page: data?.page ?? null,
  }
}

async function waitForImportedGridRow(page, {
  token,
  baseId,
  sheetId,
  viewId,
  searchValue,
  label,
}) {
  const imported = await waitForPredicate(async () => {
    const result = await findRecordBySearch(token, sheetId, viewId, searchValue)
    return {
      ok: !!result.row?.id,
      rowId: result.row?.id ?? null,
      total: result.page?.total ?? null,
    }
  }, `${label} api hydration`)

  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.grid-entry',
    baseId,
    sheetId,
    viewId,
  })
  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  await page.locator('.meta-grid__row').filter({ hasText: searchValue }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  return imported
}

function multitableUrl(baseId, sheetId, viewId, extra = {}) {
  const query = new URLSearchParams({ baseId, ...extra })
  return `${webBase}/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}?${query.toString()}`
}

async function mountEmbedHostHarness(page, src) {
  await page.goto(webBase, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Multitable Embed Host Smoke</title>
        <style>
          html, body {
            margin: 0;
            height: 100%;
            background: #0f172a;
          }
          body {
            display: grid;
            place-items: stretch;
          }
          iframe {
            width: 100%;
            height: 100%;
            border: 0;
            background: #ffffff;
          }
        </style>
      </head>
      <body>
        <script>
          window.__mtMessages = []
          window.__mtMessageHistory = []
          window.addEventListener('message', (event) => {
            const payload = event?.data
            if (!payload || typeof payload !== 'object') return
            if (typeof payload.type !== 'string' || !payload.type.startsWith('mt:')) return
            const nextMessage = {
              ...payload,
              __origin: event.origin,
            }
            window.__mtMessages.push(nextMessage)
            window.__mtMessageHistory.push(nextMessage)
          })
          window.__mtClearMessages = () => {
            window.__mtMessages = []
          }
          window.__mtGetMessages = () => window.__mtMessages.slice()
          window.__mtGetMessageHistory = () => window.__mtMessageHistory.slice()
          window.__mtPostMessage = (payload) => {
            const iframe = document.getElementById('mt-embed-frame')
            if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) {
              throw new Error('Embed host iframe unavailable')
            }
            iframe.contentWindow.postMessage(payload, window.location.origin)
          }
          window.__mtGetFrameLocation = () => {
            const iframe = document.getElementById('mt-embed-frame')
            if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) return null
            try {
              return {
                href: iframe.contentWindow.location.href,
                pathname: iframe.contentWindow.location.pathname,
                search: iframe.contentWindow.location.search,
                origin: iframe.contentWindow.location.origin,
              }
            } catch {
              return null
            }
          }
        </script>
      </body>
    </html>
  `)
  await page.evaluate((iframeSrc) => {
    const iframe = document.createElement('iframe')
    iframe.id = 'mt-embed-frame'
    iframe.title = 'Multitable Embed Smoke'
    iframe.src = iframeSrc
    document.body.appendChild(iframe)
  }, src)
}

async function getEmbedHostMessages(page) {
  return await page.evaluate(() => window.__mtGetMessages())
}

async function getEmbedHostMessageHistory(page) {
  return await page.evaluate(() => window.__mtGetMessageHistory())
}

async function clearEmbedHostMessages(page) {
  await page.evaluate(() => window.__mtClearMessages())
}

async function postEmbedHostMessage(page, payload) {
  await page.evaluate((message) => window.__mtPostMessage(message), payload)
}

async function waitForEmbedHostMessage(page, predicate, description) {
  const deadline = Date.now() + timeoutMs
  let lastMessages = []
  while (Date.now() < deadline) {
    const messages = await getEmbedHostMessages(page)
    lastMessages = Array.isArray(messages) ? messages : []
    const found = lastMessages.find(predicate)
    if (found) return found
    await page.waitForTimeout(100)
  }
  const [frameLocation, messageHistory] = await Promise.all([
    getEmbedFrameLocation(page),
    getEmbedHostMessageHistory(page),
  ])
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify({
    recentMessages: lastMessages.slice(-8),
    messageHistoryTail: Array.isArray(messageHistory) ? messageHistory.slice(-16) : [],
    frameLocation,
  })}`)
}

async function getEmbedFrameLocation(page) {
  return await page.evaluate(() => window.__mtGetFrameLocation())
}

async function waitForEmbedFrameContext(page, { baseId, sheetId, viewId }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const location = await getEmbedFrameLocation(page)
    if (location?.href) {
      const url = new URL(location.href)
      const pathParts = url.pathname.split('/').filter(Boolean)
      const actualSheetId = pathParts.at(-2) ? decodeURIComponent(pathParts.at(-2)) : ''
      const actualViewId = pathParts.at(-1) ? decodeURIComponent(pathParts.at(-1)) : ''
      if (
        actualSheetId === sheetId &&
        actualViewId === viewId &&
        url.searchParams.get('baseId') === baseId
      ) {
        return {
          href: url.href,
          pathname: url.pathname,
          search: url.search,
        }
      }
    }
    await page.waitForTimeout(100)
  }
  throw new Error(`Timed out waiting for embed frame context ${baseId}/${sheetId}/${viewId}`)
}

async function verifyEmbedHostProtocol(page, {
  baseId,
  sheetId,
  initialViewId,
  targetViewId,
}) {
  await mountEmbedHostHarness(page, multitableUrl(baseId, sheetId, initialViewId, {
    embedded: '1',
    role: 'editor',
  }))
  await page.frameLocator('#mt-embed-frame').getByRole('searchbox', { name: 'Search records' }).waitFor({
    state: 'visible',
    timeout: timeoutMs,
  })

  const readyMessage = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:ready' &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === initialViewId
  ), 'mt:ready')
  const readyOk = readyMessage.__origin === new URL(webBase).origin
  record('ui.embed-host.ready', readyOk, {
    baseId,
    sheetId,
    viewId: initialViewId,
    origin: readyMessage.__origin,
  })
  if (!readyOk) {
    throw new Error('Embed host ready origin mismatch')
  }

  await clearEmbedHostMessages(page)
  const initialStateRequestId = 'req_embed_state_initial'
  await postEmbedHostMessage(page, {
    type: 'mt:get-navigation-state',
    requestId: initialStateRequestId,
  })
  const initialState = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigation-state' &&
    message.requestId === initialStateRequestId
  ), 'initial mt:navigation-state')
  const initialStateOk = initialState.currentContext?.baseId === baseId &&
    initialState.currentContext?.sheetId === sheetId &&
    initialState.currentContext?.viewId === initialViewId &&
    initialState.pendingContext == null
  record('ui.embed-host.state-query.initial', initialStateOk, {
    requestId: initialStateRequestId,
    currentContext: initialState.currentContext,
    pendingContext: initialState.pendingContext,
  })
  if (!initialStateOk) {
    throw new Error('Embed host initial navigation state mismatch')
  }

  await clearEmbedHostMessages(page)
  await postEmbedHostMessage(page, {
    type: 'mt:navigate',
    baseId,
    sheetId,
    viewId: targetViewId,
  })
  const appliedResult = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigate-result' &&
    message.status === 'applied' &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === targetViewId
  ), 'applied mt:navigate-result')
  const generatedRequestId = appliedResult.requestId
  const generatedRequestIdOk = typeof generatedRequestId === 'string' && generatedRequestId.startsWith('mt_nav_')
  record('ui.embed-host.navigate.generated-request-id', generatedRequestIdOk, {
    requestId: generatedRequestId,
    targetViewId,
  })
  if (!generatedRequestIdOk) {
    throw new Error('Embed host did not synthesize requestId for host navigate without requestId')
  }
  await waitForEmbedFrameContext(page, { baseId, sheetId, viewId: targetViewId })
  const appliedNavigated = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigated' &&
    message.requestId === generatedRequestId &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === targetViewId
  ), 'applied mt:navigated')
  record('ui.embed-host.navigate.applied', true, {
    requestId: generatedRequestId,
    resultStatus: appliedResult.status,
    navigatedViewId: appliedNavigated.viewId,
  })

  await clearEmbedHostMessages(page)
  const explicitRequestId = 'req_embed_back_to_grid'
  await postEmbedHostMessage(page, {
    type: 'mt:navigate',
    baseId,
    sheetId,
    viewId: initialViewId,
    requestId: explicitRequestId,
  })
  const explicitResult = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigate-result' &&
    message.status === 'applied' &&
    message.requestId === explicitRequestId &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === initialViewId
  ), 'explicit mt:navigate-result')
  await waitForEmbedFrameContext(page, { baseId, sheetId, viewId: initialViewId })
  await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigated' &&
    message.requestId === explicitRequestId &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === initialViewId
  ), 'explicit mt:navigated')
  record('ui.embed-host.navigate.explicit-request-id', true, {
    requestId: explicitRequestId,
    resultStatus: explicitResult.status,
    viewId: initialViewId,
  })

  await clearEmbedHostMessages(page)
  const finalStateRequestId = 'req_embed_state_final'
  await postEmbedHostMessage(page, {
    type: 'mt:get-navigation-state',
    requestId: finalStateRequestId,
  })
  const finalState = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigation-state' &&
    message.requestId === finalStateRequestId
  ), 'final mt:navigation-state')
  const finalStateOk = finalState.currentContext?.baseId === baseId &&
    finalState.currentContext?.sheetId === sheetId &&
    finalState.currentContext?.viewId === initialViewId &&
    finalState.pendingContext == null
  record('ui.embed-host.state-query.final', finalStateOk, {
    requestId: finalStateRequestId,
    currentContext: finalState.currentContext,
    pendingContext: finalState.pendingContext,
  })
  if (!finalStateOk) {
    throw new Error('Embed host final navigation state mismatch')
  }

  await page.screenshot({
    path: path.join(outputDir, 'embed-host-smoke.png'),
    fullPage: true,
  })

  return {
    generatedRequestId,
    explicitRequestId,
  }
}

async function verifyEmbedHostDirtyFormNavigation(page, {
  token,
  baseId,
  sheetId,
  formViewId,
  targetViewId,
  recordId,
  titleFieldId,
  originalTitle,
}) {
  await mountEmbedHostHarness(page, multitableUrl(baseId, sheetId, formViewId, {
    embedded: '1',
    role: 'editor',
    mode: 'form',
    recordId,
  }))
  const frame = page.frameLocator('#mt-embed-frame')
  const titleInput = frame.locator(`#field_${titleFieldId}`)
  await titleInput.waitFor({ state: 'visible', timeout: timeoutMs })

  const readyMessage = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:ready' &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === formViewId
  ), 'form mt:ready')
  record('ui.embed-host.form-ready', readyMessage.__origin === new URL(webBase).origin, {
    baseId,
    sheetId,
    viewId: formViewId,
    recordId,
    origin: readyMessage.__origin,
  })

  const draftTitle = `${originalTitle} draft`
  await titleInput.fill(draftTitle)
  const draftValue = await titleInput.inputValue()
  const dirtyDraftOk = draftValue === draftTitle
  record('ui.embed-host.form-draft', dirtyDraftOk, {
    recordId,
    fieldId: titleFieldId,
    draftTitle,
    draftValue,
  })
  if (!dirtyDraftOk) {
    throw new Error('Embed host form draft input did not retain the edited value')
  }

  await clearEmbedHostMessages(page)
  const blockedRequestId = 'req_embed_form_blocked'
  const blockedDialogPromise = page.waitForEvent('dialog', { timeout: timeoutMs })
  await postEmbedHostMessage(page, {
    type: 'mt:navigate',
    baseId,
    sheetId,
    viewId: targetViewId,
    requestId: blockedRequestId,
  })
  const blockedDialog = await blockedDialogPromise
  const blockedDialogOk = blockedDialog.message() === 'Discard unsaved changes before leaving the current sheet or view?'
  record('ui.embed-host.navigate.blocked-dialog', blockedDialogOk, {
    requestId: blockedRequestId,
    message: blockedDialog.message(),
  })
  if (!blockedDialogOk) {
    await blockedDialog.dismiss()
    throw new Error(`Unexpected blocked navigation dialog message: ${blockedDialog.message()}`)
  }
  await blockedDialog.dismiss()
  const blockedResult = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigate-result' &&
    message.status === 'blocked' &&
    message.requestId === blockedRequestId
  ), 'blocked mt:navigate-result')
  await page.waitForTimeout(200)
  const blockedMessages = await getEmbedHostMessages(page)
  const blockedNavigated = blockedMessages.some((message) => (
    message?.type === 'mt:navigated' &&
    message.requestId === blockedRequestId
  ))
  const blockedStateRequestId = 'req_embed_form_blocked_state'
  await postEmbedHostMessage(page, {
    type: 'mt:get-navigation-state',
    requestId: blockedStateRequestId,
  })
  const blockedState = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigation-state' &&
    message.requestId === blockedStateRequestId
  ), 'blocked mt:navigation-state')
  const blockedDraftValue = await titleInput.inputValue()
  const blockedOk = blockedResult.reason === 'user-cancelled' &&
    blockedResult.baseId === baseId &&
    blockedResult.sheetId === sheetId &&
    blockedResult.viewId === targetViewId &&
    !blockedNavigated &&
    blockedState.currentContext?.baseId === baseId &&
    blockedState.currentContext?.sheetId === sheetId &&
    blockedState.currentContext?.viewId === formViewId &&
    blockedDraftValue === draftTitle
  record('ui.embed-host.navigate.blocked', blockedOk, {
    requestId: blockedRequestId,
    resultReason: blockedResult.reason,
    currentContext: blockedState.currentContext,
    draftValue: blockedDraftValue,
    blockedNavigated,
  })
  if (!blockedOk) {
    throw new Error('Embed host blocked navigation did not keep the dirty form context stable')
  }

  await clearEmbedHostMessages(page)
  const confirmRequestId = 'req_embed_form_confirmed'
  const confirmDialogPromise = page.waitForEvent('dialog', { timeout: timeoutMs })
  await postEmbedHostMessage(page, {
    type: 'mt:navigate',
    baseId,
    sheetId,
    viewId: targetViewId,
    requestId: confirmRequestId,
  })
  const confirmDialog = await confirmDialogPromise
  const confirmDialogOk = confirmDialog.message() === 'Discard unsaved changes before leaving the current sheet or view?'
  record('ui.embed-host.navigate.confirm-dialog', confirmDialogOk, {
    requestId: confirmRequestId,
    message: confirmDialog.message(),
  })
  if (!confirmDialogOk) {
    await confirmDialog.dismiss()
    throw new Error(`Unexpected confirm navigation dialog message: ${confirmDialog.message()}`)
  }
  await confirmDialog.accept()
  const confirmedResult = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigate-result' &&
    message.status === 'applied' &&
    message.requestId === confirmRequestId
  ), 'confirmed mt:navigate-result')
  await waitForEmbedFrameContext(page, { baseId, sheetId, viewId: targetViewId })
  await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigated' &&
    message.requestId === confirmRequestId &&
    message.baseId === baseId &&
    message.sheetId === sheetId &&
    message.viewId === targetViewId
  ), 'confirmed mt:navigated')
  const confirmedRecord = await fetchRecord(token, sheetId, recordId)
  const discardedOk = confirmedRecord.record?.data?.[titleFieldId] === originalTitle
  record('api.embed-host.discard-unsaved-form-draft', discardedOk, {
    requestId: confirmRequestId,
    recordId,
    fieldId: titleFieldId,
    expectedTitle: originalTitle,
    persistedTitle: confirmedRecord.record?.data?.[titleFieldId],
  })
  if (!discardedOk) {
    throw new Error('Embed host confirmed navigation unexpectedly persisted an unsaved form draft')
  }

  await clearEmbedHostMessages(page)
  const finalStateRequestId = 'req_embed_form_final_state'
  await postEmbedHostMessage(page, {
    type: 'mt:get-navigation-state',
    requestId: finalStateRequestId,
  })
  const finalState = await waitForEmbedHostMessage(page, (message) => (
    message?.type === 'mt:navigation-state' &&
    message.requestId === finalStateRequestId
  ), 'confirmed final mt:navigation-state')
  const finalStateOk = confirmedResult.baseId === baseId &&
    confirmedResult.sheetId === sheetId &&
    confirmedResult.viewId === targetViewId &&
    finalState.currentContext?.baseId === baseId &&
    finalState.currentContext?.sheetId === sheetId &&
    finalState.currentContext?.viewId === targetViewId &&
    finalState.pendingContext == null
  record('ui.embed-host.navigate.confirmed', finalStateOk, {
    requestId: confirmRequestId,
    currentContext: finalState.currentContext,
    pendingContext: finalState.pendingContext,
  })
  if (!finalStateOk) {
    throw new Error('Embed host confirmed navigation did not land on the expected target context')
  }

  await page.screenshot({
    path: path.join(outputDir, 'embed-host-form-blocked-confirmed.png'),
    fullPage: true,
  })

  return {
    blockedRequestId,
    confirmRequestId,
  }
}

async function verifyEmbedHostBusyDeferredNavigation(page, {
  token,
  baseId,
  sheetId,
  formViewId,
  currentViewId,
  deferredViewId,
  supersedingViewId,
  recordId,
  titleFieldId,
  originalTitle,
}) {
  await mountEmbedHostHarness(page, multitableUrl(baseId, sheetId, formViewId, {
    embedded: '1',
    role: 'editor',
    mode: 'form',
    recordId,
  }))
  const frame = page.frameLocator('#mt-embed-frame')
  const titleInput = frame.locator(`#field_${titleFieldId}`)
  await titleInput.waitFor({ state: 'visible', timeout: timeoutMs })
  await frame.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible', timeout: timeoutMs })

  const requestPattern = `**/api/multitable/views/${formViewId}/submit`
  let capturedRoute = null
  let releaseSubmitRoute = null
  const submitIntercepted = new Promise((resolve) => {
    capturedRoute = resolve
  })
  releaseSubmitRoute = () => {}
  const releaseSubmit = new Promise((resolve) => {
    releaseSubmitRoute = resolve
  })
  const routeHandler = async (route) => {
    capturedRoute(route)
    await releaseSubmit
    await route.continue()
  }
  await page.route(requestPattern, routeHandler)

  try {
    const busyTitle = `${originalTitle} busy-save`
    const saveResponsePromise = page.waitForResponse((response) => (
      response.url().includes(`/api/multitable/views/${formViewId}/submit`) &&
      response.request().method() === 'POST'
    ), { timeout: timeoutMs })

    await titleInput.fill(busyTitle)
    await frame.getByRole('button', { name: 'Save' }).click()
    await submitIntercepted

    await clearEmbedHostMessages(page)
    const deferredRequestId = 'req_embed_form_deferred'
    await postEmbedHostMessage(page, {
      type: 'mt:navigate',
      baseId,
      sheetId,
      viewId: deferredViewId,
      requestId: deferredRequestId,
    })
    const deferredResult = await waitForEmbedHostMessage(page, (message) => (
      message?.type === 'mt:navigate-result' &&
      message.status === 'deferred' &&
      message.requestId === deferredRequestId
    ), 'deferred mt:navigate-result')
    const deferredOk = deferredResult.reason === 'busy' &&
      deferredResult.baseId === baseId &&
      deferredResult.sheetId === sheetId &&
      deferredResult.viewId === deferredViewId
    record('ui.embed-host.navigate.deferred', deferredOk, {
      requestId: deferredRequestId,
      resultReason: deferredResult.reason,
      deferredViewId,
    })
    if (!deferredOk) {
      throw new Error('Embed host busy deferred navigation did not report the expected pending target')
    }

    const supersedingRequestId = 'req_embed_form_superseding'
    await postEmbedHostMessage(page, {
      type: 'mt:navigate',
      baseId,
      sheetId,
      viewId: supersedingViewId,
      requestId: supersedingRequestId,
    })
    const supersededResult = await waitForEmbedHostMessage(page, (message) => (
      message?.type === 'mt:navigate-result' &&
      message.status === 'superseded' &&
      message.requestId === deferredRequestId
    ), 'superseded mt:navigate-result')
    const latestDeferredResult = await waitForEmbedHostMessage(page, (message) => (
      message?.type === 'mt:navigate-result' &&
      message.status === 'deferred' &&
      message.requestId === supersedingRequestId
    ), 'latest deferred mt:navigate-result')
    const supersededOk = supersededResult.reason === 'superseded' &&
      supersededResult.baseId === baseId &&
      supersededResult.sheetId === sheetId &&
      supersededResult.viewId === deferredViewId &&
      latestDeferredResult.reason === 'busy' &&
      latestDeferredResult.baseId === baseId &&
      latestDeferredResult.sheetId === sheetId &&
      latestDeferredResult.viewId === supersedingViewId
    record('ui.embed-host.navigate.superseded', supersededOk, {
      supersededRequestId: deferredRequestId,
      latestRequestId: supersedingRequestId,
      supersededReason: supersededResult.reason,
      latestReason: latestDeferredResult.reason,
      supersedingViewId,
    })
    if (!supersededOk) {
      throw new Error('Embed host busy navigation did not supersede the older deferred target correctly')
    }

    const deferredStateRequestId = 'req_embed_form_busy_state'
    await postEmbedHostMessage(page, {
      type: 'mt:get-navigation-state',
      requestId: deferredStateRequestId,
    })
    const deferredState = await waitForEmbedHostMessage(page, (message) => (
      message?.type === 'mt:navigation-state' &&
      message.requestId === deferredStateRequestId
    ), 'busy deferred mt:navigation-state')
    const deferredStateOk = deferredState.currentContext?.baseId === baseId &&
      deferredState.currentContext?.sheetId === sheetId &&
      deferredState.currentContext?.viewId === currentViewId &&
      deferredState.pendingContext?.baseId === baseId &&
      deferredState.pendingContext?.sheetId === sheetId &&
      deferredState.pendingContext?.viewId === supersedingViewId &&
      deferredState.pendingContext?.requestId === supersedingRequestId &&
      deferredState.pendingContext?.reason === 'busy' &&
      deferredState.busy === true
    record('ui.embed-host.state-query.deferred', deferredStateOk, {
      requestId: deferredStateRequestId,
      currentContext: deferredState.currentContext,
      pendingContext: deferredState.pendingContext,
      busy: deferredState.busy,
    })
    if (!deferredStateOk) {
      throw new Error('Embed host busy deferred state query did not retain the latest pending target')
    }

    releaseSubmitRoute()
    await saveResponsePromise
    const replayApplied = await waitForEmbedHostMessage(page, (message) => (
      message?.type === 'mt:navigate-result' &&
      message.status === 'applied' &&
      message.requestId === supersedingRequestId
    ), 'replayed applied mt:navigate-result')
    await waitForEmbedFrameContext(page, { baseId, sheetId, viewId: supersedingViewId })
    const replayNavigated = await waitForEmbedHostMessage(page, (message) => (
      message?.type === 'mt:navigated' &&
      message.requestId === supersedingRequestId &&
      message.baseId === baseId &&
      message.sheetId === sheetId &&
      message.viewId === supersedingViewId
    ), 'replayed mt:navigated')
    const replayedOk = replayApplied.baseId === baseId &&
      replayApplied.sheetId === sheetId &&
      replayApplied.viewId === supersedingViewId &&
      replayNavigated.viewId === supersedingViewId
    record('ui.embed-host.navigate.replayed', replayedOk, {
      requestId: supersedingRequestId,
      replayedViewId: replayNavigated.viewId,
    })
    if (!replayedOk) {
      throw new Error('Embed host busy deferred navigation did not replay the latest pending target after save completion')
    }

    const persistedRecord = await fetchRecord(token, sheetId, recordId)
    const persistedOk = persistedRecord.record?.data?.[titleFieldId] === busyTitle
    record('api.embed-host.persisted-busy-form-save', persistedOk, {
      requestId: supersedingRequestId,
      recordId,
      fieldId: titleFieldId,
      expectedTitle: busyTitle,
      persistedTitle: persistedRecord.record?.data?.[titleFieldId],
    })
    if (!persistedOk) {
      throw new Error('Embed host busy deferred replay dropped the in-flight form save unexpectedly')
    }

    await page.screenshot({
      path: path.join(outputDir, 'embed-host-form-busy-deferred-replay.png'),
      fullPage: true,
    })

    return {
      deferredRequestId,
      supersedingRequestId,
    }
  } finally {
    await page.unroute(requestPattern, routeHandler)
  }
}

function verifyDirectRouteEntry(page, {
  checkName,
  baseId,
  sheetId,
  viewId,
  extra = {},
}) {
  const expected = new URL(multitableUrl(baseId, sheetId, viewId, extra))
  const current = new URL(page.url())
  const expectedPairs = expected.searchParams
  const currentPairs = current.searchParams
  const expectedKeys = [...expectedPairs.keys()]
  const ok = current.pathname === expected.pathname &&
    expectedKeys.every((key) => currentPairs.get(key) === expectedPairs.get(key))

  recordOnce(checkName, ok, {
    expectedPath: expected.pathname,
    actualPath: current.pathname,
    expectedQuery: Object.fromEntries(expectedPairs.entries()),
    actualQuery: Object.fromEntries(currentPairs.entries()),
  })
  if (!ok) {
    throw new Error(`${checkName} failed: expected ${expected.pathname}${expected.search}, got ${current.pathname}${current.search}`)
  }
}

async function importRecordViaGrid(page, { baseId, sheetId, viewId, csvPath, searchValue }) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.grid-entry',
    baseId,
    sheetId,
    viewId,
  })
  await page.getByRole('button', { name: 'Import records' }).click()
  await page.getByText('Import Records').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('input.meta-import__file-input[type="file"]').setInputFiles(csvPath)
  await page.getByRole('button', { name: 'Preview' }).click()
  const importButton = page.getByRole('button', { name: /Import 1 record\(s\)/ })
  await waitForActionButtonEnabled(importButton, 'grid import button enable')
  await importButton.click()
  await page.getByText('1 record(s) imported').waitFor({ state: 'visible', timeout: timeoutMs })

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: searchValue }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'grid-import.png'), fullPage: true })
  record('ui.grid.import', true, { searchValue })
}

async function loadXlsxApi() {
  const mod = await importXlsxModule()
  return mod.default?.utils ? mod.default : mod
}

async function writeXlsxFixture(filePath, { sheetName, headers, rows }) {
  const xlsx = await loadXlsxApi()
  const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows])
  const workbook = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName)
  xlsx.writeFile(workbook, filePath)
}

async function readXlsxRows(filePath) {
  const xlsx = await loadXlsxApi()
  const workbook = xlsx.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  return xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
}

async function verifyXlsxImportExport(page, {
  token,
  baseId,
  sheetId,
  viewId,
  titleFieldId,
  importedRowTitle,
  onImportedRecord,
}) {
  const xlsxPath = path.join(outputDir, 'pilot-import.xlsx')
  await writeXlsxFixture(xlsxPath, {
    sheetName: 'Import',
    headers: ['Title'],
    rows: [[importedRowTitle]],
  })

  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Import records' }).click()
  await page.getByText('Import Records').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('input.meta-import__file-input[type="file"]').setInputFiles(xlsxPath)
  await page.getByText('1 record(s) detected. Map columns to fields:').waitFor({ state: 'visible', timeout: timeoutMs })
  await ensureImportFieldMappedByColumnIndex(page, {
    columnIndex: 0,
    fieldId: titleFieldId,
    label: 'xlsx import title mapping',
  })
  const importButton = page.getByRole('button', { name: /Import 1 record\(s\)/ })
  await waitForActionButtonEnabled(importButton, 'xlsx import button enable')
  await importButton.click()
  await page.getByText('1 record(s) imported').waitFor({ state: 'visible', timeout: timeoutMs })

  await waitForImportedGridRow(page, {
    token,
    baseId,
    sheetId,
    viewId,
    searchValue: importedRowTitle,
    label: 'xlsx file import',
  })
  const imported = await findRecordBySearch(token, sheetId, viewId, importedRowTitle)
  const importOk = !!imported.row?.id
  record('ui.xlsx.import-file', importOk, {
    baseId,
    sheetId,
    viewId,
    recordId: imported.row?.id ?? null,
    title: importedRowTitle,
  })
  if (!importOk) {
    throw new Error('XLSX import did not hydrate the imported row')
  }
  if (typeof onImportedRecord === 'function') {
    onImportedRecord(imported.row)
  }

  const exportPromise = page.waitForEvent('download', { timeout: timeoutMs })
  await page.getByRole('button', { name: 'Export Excel' }).click()
  const download = await exportPromise
  const suggestedFilename = download.suggestedFilename()
  const exportPath = path.join(outputDir, `pilot-export-${Date.now()}.xlsx`)
  await download.saveAs(exportPath)
  const stats = fs.statSync(exportPath)
  const rows = await readXlsxRows(exportPath)
  const flattened = rows.flat().map((value) => String(value))
  const exportOk = suggestedFilename.endsWith('.xlsx') &&
    stats.size > 0 &&
    flattened.includes('Title') &&
    flattened.includes(importedRowTitle)
  record('ui.xlsx.export-download', exportOk, {
    suggestedFilename,
    bytes: stats.size,
    title: importedRowTitle,
    rowCount: rows.length,
    exportPath,
  })
  if (!exportOk) {
    throw new Error('XLSX export did not include the imported row')
  }

  await page.screenshot({ path: path.join(outputDir, 'grid-xlsx-import-export.png'), fullPage: true })
  return imported.row
}

async function importRecordsViaGridWithRetry(page, {
  baseId,
  sheetId,
  viewId,
  csvPath,
  titleFieldId,
  retryRowTitle,
  importedRowTitle,
}) {
  let failedRetryRowAttempts = 0
  const observedImportTitles = new Set()
  const routeHandler = async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') {
      await route.continue()
      return
    }
    const rawPostData = request.postData() ?? ''
    let body = null
    try {
      body = request.postDataJSON()
    } catch {
      try {
        body = rawPostData ? JSON.parse(rawPostData) : null
      } catch {
        body = null
      }
    }
    const rowTitle = body?.data?.[titleFieldId] ?? body?.data?.Title ?? body?.record?.data?.[titleFieldId]
    if (typeof rowTitle === 'string' && rowTitle.trim()) {
      observedImportTitles.add(rowTitle.trim())
    }
    const shouldFailRetryRow = rowTitle === retryRowTitle || rawPostData.includes(retryRowTitle)
    // Exhaust the built-in transport retry so the UI surfaces the manual
    // "Retry failed rows" flow instead of silently succeeding on retry.
    if (shouldFailRetryRow && failedRetryRowAttempts < 2) {
      failedRetryRowAttempts += 1
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: {
            code: 'TRANSIENT_ERROR',
            message: 'Temporary import failure',
          },
        }),
      })
      return
    }
    await route.continue()
  }

  await page.route('**/api/multitable/records*', routeHandler)
  try {
    await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
    verifyDirectRouteEntry(page, {
      checkName: 'ui.route.grid-entry',
      baseId,
      sheetId,
      viewId,
    })
    await page.locator('.meta-field-header__name').filter({ hasText: 'Title' }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    await page.getByRole('button', { name: 'Import records' }).click()
    await page.getByText('Import Records').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('input.meta-import__file-input[type="file"]').setInputFiles(csvPath)
    await page.getByRole('button', { name: 'Preview' }).click()
    await ensureImportFieldMappedByColumnIndex(page, {
      columnIndex: 0,
      fieldId: titleFieldId,
      label: 'grid retry import title mapping',
    })
    const importButton = page.getByRole('button', { name: /Import 2 record\(s\)/ })
    await waitForActionButtonEnabled(importButton, 'grid retry import button enable')
    await importButton.click()
    await page.getByRole('button', { name: 'Retry failed rows' }).waitFor({ state: 'visible', timeout: timeoutMs })
    if (failedRetryRowAttempts < 2) {
      throw new Error(`Import retry interception did not exhaust transport retries. Attempts=${failedRetryRowAttempts}; observed titles: ${JSON.stringify(Array.from(observedImportTitles))}`)
    }
    await page.locator('.meta-import__failure').first().waitFor({ state: 'visible', timeout: timeoutMs })
    await page.getByRole('button', { name: 'Retry failed rows' }).click()
    await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })
    await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  } finally {
    await page.unroute('**/api/multitable/records*', routeHandler).catch(() => {})
  }

  record('ui.import.failed-retry', true, {
    baseId,
    sheetId,
    viewId,
    importedRowTitle,
    retryRowTitle,
    observedImportTitles: Array.from(observedImportTitles),
    failedRetryRowAttempts,
  })
}

async function importRecordViaGridWithPeopleManualFix(page, {
  token,
  baseId,
  sheetId,
  viewId,
  csvPath,
  titleFieldId,
  personFieldId,
  personFieldName,
  importedRowTitle,
  personDisplay,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.grid-entry',
    baseId,
    sheetId,
    viewId,
  })
  await page.getByRole('button', { name: 'Import records' }).click()
  await page.getByText('Import Records').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('input.meta-import__file-input[type="file"]').setInputFiles(csvPath)
  await page.getByRole('button', { name: 'Preview' }).click()
  await ensureImportFieldMappedByColumnIndex(page, {
    columnIndex: 0,
    fieldId: titleFieldId,
    label: 'people manual-fix title mapping',
  })
  await ensureImportFieldMappedByColumnIndex(page, {
    columnIndex: 1,
    fieldId: personFieldId,
    label: 'people manual-fix owner mapping',
  })
  const importButton = page.getByRole('button', { name: /Import 1 record\(s\)/ })
  await waitForActionButtonEnabled(importButton, 'grid people manual-fix import button enable')
  await importButton.click()
  await page.locator('.meta-import__fixes').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: /Select person|Select people|Choose person|Choose people/ }).click()
  await page.locator('.meta-link-picker').waitFor({ state: 'visible', timeout: timeoutMs })
  const selectedPersonDisplay = await selectLinkPickerOption(page, {
    display: personDisplay,
    label: 'people manual-fix picker option',
  })
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.locator('.meta-import__fix-selected').getByText(selectedPersonDisplay).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Apply fixes and retry' }).click()
  await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })
  await waitForImportedGridRow(page, {
    token,
    baseId,
    sheetId,
    viewId,
    searchValue: importedRowTitle,
    label: 'people manual-fix import',
  })
  await page.screenshot({ path: path.join(outputDir, 'grid-import-people-manual-fix.png'), fullPage: true })
  record('ui.import.people-manual-fix', true, {
    baseId,
    sheetId,
    viewId,
    importedRowTitle,
    personDisplay: selectedPersonDisplay,
  })
}

async function verifyImportMappingReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
  fieldId,
  fieldName,
  renamedFieldName,
  formulaFieldName,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.grid-entry',
    baseId,
    sheetId,
    viewId,
  })
  await page.getByRole('button', { name: 'Import records' }).click()
  await page.getByText('Import Records').waitFor({ state: 'visible', timeout: timeoutMs })

  await page.locator('.meta-import__textarea').fill(`${fieldName}\nDraft Value`)
  await page.getByRole('button', { name: 'Preview' }).click()

  const fieldSelect = page.locator('.meta-import__field-select').first()
  await ensureImportFieldMappedByColumnIndex(page, {
    columnIndex: 0,
    fieldId,
    label: 'import mapping reconcile initial mapping',
  })

  await updateField(token, fieldId, { name: renamedFieldName })

  await page.waitForFunction(({ selector, expectedLabel }) => {
    const element = document.querySelector(selector)
    return element instanceof HTMLSelectElement
      && element.selectedOptions[0]?.textContent?.trim() === expectedLabel
      && !document.querySelector('.meta-import__warning')
  }, { selector: '.meta-import__field-select', expectedLabel: renamedFieldName }, { timeout: timeoutMs })

  await updateField(token, fieldId, {
    name: formulaFieldName,
    type: 'formula',
    property: {},
  })

  const warning = page.locator('.meta-import__warning').filter({ hasText: 'no longer an importable field' })
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'import-mapping-reconcile.png'), fullPage: true })

  const importButton = page.getByRole('button', { name: /Import 1 record\(s\)/ })
  const importDisabledBeforeReconcile = await importButton.isDisabled()
  const warningText = (await warning.textContent())?.trim() ?? ''

  await page.getByRole('button', { name: 'Reconcile draft' }).click()
  await page.waitForFunction(() => {
    const warningNode = document.querySelector('.meta-import__warning')
    const selectNode = document.querySelector('.meta-import__field-select')
    return !warningNode && selectNode instanceof HTMLSelectElement && selectNode.value === ''
  }, undefined, { timeout: timeoutMs })

  const mappingClearedAfterReconcile = await fieldSelect.inputValue()
  const ok = importDisabledBeforeReconcile
    && warningText.includes(formulaFieldName)
    && mappingClearedAfterReconcile === ''
  record('ui.import.mapping-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
    renamedFieldName,
    formulaFieldName,
    warningText,
    importDisabledBeforeReconcile,
    mappingClearedAfterReconcile,
  })
  if (!ok) {
    throw new Error(`Import mapping reconcile failed for ${fieldId}`)
  }

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.meta-import__close').click()
  await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })
}

async function verifyPeopleRepairReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
  titleFieldId,
  fieldId,
  fieldName,
  renamedFieldName,
  importedRowTitle,
  personDisplay,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.grid-entry',
    baseId,
    sheetId,
    viewId,
  })
  await page.getByRole('button', { name: 'Import records' }).click()
  await page.getByText('Import Records').waitFor({ state: 'visible', timeout: timeoutMs })

  await page.locator('.meta-import__textarea').fill(`Title\t${fieldName}\n${importedRowTitle}\t__needs_fix__`)
  await page.getByRole('button', { name: 'Preview' }).click()
  await ensureImportFieldMappedByColumnIndex(page, {
    columnIndex: 0,
    fieldId: titleFieldId,
    label: 'people repair title mapping',
  })
  await ensureImportFieldMappedByColumnIndex(page, {
    columnIndex: 1,
    fieldId,
    label: 'people repair field mapping',
  })
  const importButton = page.getByRole('button', { name: /Import 1 record\(s\)/ })
  await waitForActionButtonEnabled(importButton, 'grid people repair import button enable')
  await importButton.click()
  await page.locator('.meta-import__fixes').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: /Select person|Select people|Choose person|Choose people/ }).click()
  await page.locator('.meta-link-picker').waitFor({ state: 'visible', timeout: timeoutMs })
  const selectedPersonDisplay = await selectLinkPickerOption(page, {
    display: personDisplay,
    label: 'people repair picker option',
  })
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.locator('.meta-import__fix-selected').getByText(selectedPersonDisplay).waitFor({ state: 'visible', timeout: timeoutMs })

  await updateField(token, fieldId, {
    name: renamedFieldName,
    type: 'string',
    property: {},
  })

  const warning = page.locator('.meta-import__warning').filter({ hasText: 'changed type' })
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'import-people-repair-reconcile.png'), fullPage: true })

  const applyButton = page.getByRole('button', { name: 'Apply fixes and retry' })
  const applyDisabledBeforeReconcile = await applyButton.isDisabled()
  const warningText = (await warning.textContent())?.trim() ?? ''

  await page.getByRole('button', { name: 'Reconcile draft' }).click()
  await warning.waitFor({ state: 'hidden', timeout: timeoutMs })

  const pickerButtonsAfterReconcile = await page.getByRole('button', { name: /Select person|Select people|Choose person|Choose people/ }).count()
  const applyState = await waitForActionButtonEnabled(applyButton, 'grid people repair apply button enable')
  const applyDisabledAfterReconcile = applyState.disabled
  const createRecordRequestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/multitable/records'),
    { timeout: timeoutMs },
  ).catch(() => null)
  const createRecordResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/multitable/records'),
    { timeout: timeoutMs },
  ).catch(() => null)
  await applyButton.click()
  try {
    await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })
  } catch (error) {
    const modalText = (await page.locator('.meta-import-modal').textContent().catch(() => ''))?.trim() ?? ''
    await page.screenshot({ path: path.join(outputDir, 'import-people-repair-after-apply.png'), fullPage: true }).catch(() => {})
    record('ui.import.people-repair-reconcile-diagnostic', false, {
      baseId,
      sheetId,
      viewId,
      fieldId,
      renamedFieldName,
      modalText,
    })
    throw error
  }

  const createRecordRequest = await createRecordRequestPromise
  const createRecordResponse = await createRecordResponsePromise
  let createRecordPayload = null
  let createRecordResponseBody = null
  const createRecordStatus = createRecordResponse?.status?.() ?? null
  if (createRecordRequest) {
    try {
      createRecordPayload = createRecordRequest.postDataJSON()
    } catch {
      createRecordPayload = createRecordRequest.postData() ?? null
    }
  }
  if (createRecordResponse) {
    try {
      createRecordResponseBody = await createRecordResponse.json()
    } catch {
      createRecordResponseBody = await createRecordResponse.text().catch(() => null)
    }
  }

  let imported
  try {
    imported = await waitForImportedGridRow(page, {
      token,
      baseId,
      sheetId,
      viewId,
      searchValue: importedRowTitle,
      label: 'people repair reconcile import',
    })
  } catch (error) {
    record('ui.import.people-repair-reconcile-diagnostic', false, {
      baseId,
      sheetId,
      viewId,
      fieldId,
      renamedFieldName,
      importedRowTitle,
      createRecordPayload,
      createRecordStatus,
      createRecordResponseBody,
    })
    throw error
  }

  const ok = applyDisabledBeforeReconcile
    && warningText.includes(renamedFieldName)
    && pickerButtonsAfterReconcile === 0
    && !applyDisabledAfterReconcile
  record('ui.import.people-repair-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
    renamedFieldName,
    importedRowTitle,
    importedRowId: imported.rowId ?? null,
    personDisplay: selectedPersonDisplay,
    warningText,
    applyDisabledBeforeReconcile,
    applyDisabledAfterReconcile,
    pickerButtonsAfterReconcile,
  })
  if (!ok) {
    throw new Error(`People repair reconcile failed for ${fieldId}`)
  }
}

async function assignPersonViaDrawer(page, { searchValue, personFieldName, personDisplay }) {
  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  const row = page.locator('.meta-grid__row').filter({ hasText: searchValue }).first()
  await row.click()
  await page.locator('.meta-record-drawer').waitFor({ state: 'visible', timeout: timeoutMs })

  const personField = page.locator('.meta-record-drawer__field').filter({ hasText: personFieldName }).first()
  await personField.locator('.meta-record-drawer__link-btn').click()
  await page.locator('.meta-link-picker').waitFor({ state: 'visible', timeout: timeoutMs })
  const selectedPersonDisplay = await selectLinkPickerOption(page, {
    display: personDisplay,
    label: 'drawer people picker option',
  })
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.locator('.meta-record-drawer__link-summary').getByText(selectedPersonDisplay).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByText('Linked records updated').waitFor({ state: 'visible', timeout: timeoutMs })
  record('ui.person.assign', true, { personDisplay: selectedPersonDisplay })
}

async function verifyFormUploadAndComments(page, { baseId, sheetId, viewId, recordId, attachmentFieldName, attachmentName }) {
  await page.goto(multitableUrl(baseId, sheetId, viewId, { mode: 'form', recordId }), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.form-entry',
    baseId,
    sheetId,
    viewId,
    extra: { mode: 'form', recordId },
  })

  const uploadPath = path.join(outputDir, attachmentName)
  fs.writeFileSync(uploadPath, `multitable smoke ${new Date().toISOString()}\n`)
  const attachmentField = formFieldByLabel(page, attachmentFieldName)
  await attachmentField.locator('input[type="file"]').setInputFiles(uploadPath)
  await attachmentField.getByText('Uploading...').waitFor({ state: 'visible', timeout: timeoutMs })
  await attachmentField.getByText('Uploading...').waitFor({ state: 'hidden', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('Changes saved').first().waitFor({ state: 'visible', timeout: timeoutMs })

  const commentsButton = recordCommentsButton(page)
  await commentsButton.click()
  await page.getByRole('heading', { name: 'Comments' }).waitFor({ state: 'visible', timeout: timeoutMs })
  await addAndResolveRecordComment(page)

  await page.screenshot({ path: path.join(outputDir, 'form-comments.png'), fullPage: true })
  record('ui.form.upload-comments', true, { recordId, attachmentName })
}

async function verifyFormAttachmentLifecycle(page, {
  token,
  baseId,
  sheetId,
  viewId,
  recordId,
  attachmentFieldName,
  attachmentFieldId,
  attachmentNames,
  cleanupAttachmentIds,
  onPersistedRecord,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId, { mode: 'form', recordId }), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.form-entry',
    baseId,
    sheetId,
    viewId,
    extra: { mode: 'form', recordId },
  })

  const uploads = attachmentNames.map((attachmentName) => {
    const uploadPath = path.join(outputDir, attachmentName)
    fs.writeFileSync(uploadPath, `multitable smoke ${attachmentName} ${new Date().toISOString()}\n`)
    return uploadPath
  })

  const attachmentField = formFieldByLabel(page, attachmentFieldName)
  await attachmentField.locator('input[type="file"]').setInputFiles(uploads)
  await attachmentField.getByText('Uploading...').waitFor({ state: 'visible', timeout: timeoutMs })
  await attachmentField.getByText('Uploading...').waitFor({ state: 'hidden', timeout: timeoutMs })
  for (const attachmentName of attachmentNames) {
    await attachmentField.getByText(attachmentName, { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })
  }
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('Changes saved').first().waitFor({ state: 'visible', timeout: timeoutMs })

  const uploadState = await waitForPredicate(async () => {
    const afterUpload = await fetchRecord(token, sheetId, recordId)
    const uploadedAttachments = afterUpload.attachmentSummaries?.[attachmentFieldId] ?? []
    return {
      ok: uploadedAttachments.length === attachmentNames.length,
      afterUpload,
      uploadedAttachments,
      actual: uploadedAttachments.length,
      recordVersion: afterUpload.record?.version ?? null,
      fieldValue: afterUpload.record?.data?.[attachmentFieldId] ?? null,
    }
  }, 'form attachment upload persisted')
  const afterUpload = uploadState.afterUpload
  const uploadedAttachments = afterUpload.attachmentSummaries?.[attachmentFieldId] ?? []
  if (typeof onPersistedRecord === 'function') {
    onPersistedRecord(afterUpload.record)
  }
  if (uploadedAttachments.length !== attachmentNames.length) {
    record('api.form.attachment-upload', false, {
      recordId,
      fieldId: attachmentFieldId,
      expected: attachmentNames.length,
      actual: uploadedAttachments.length,
      recordVersion: afterUpload.record?.version ?? null,
      fieldValue: afterUpload.record?.data?.[attachmentFieldId] ?? null,
    })
    throw new Error(`Expected ${attachmentNames.length} uploaded attachment(s), got ${uploadedAttachments.length}`)
  }
  for (const attachment of uploadedAttachments) {
    cleanupAttachmentIds.add(attachment.id)
  }
  record('api.form.attachment-upload', true, {
    recordId,
    fieldId: attachmentFieldId,
    attachmentIds: uploadedAttachments.map((item) => item.id),
  })

  const commentsButton = recordCommentsButton(page)
  await commentsButton.click()
  await page.getByRole('heading', { name: 'Comments' }).waitFor({ state: 'visible', timeout: timeoutMs })
  await addAndResolveRecordComment(page)

  await page.screenshot({ path: path.join(outputDir, 'form-comments.png'), fullPage: true })
  record('ui.form.upload-comments', true, { recordId, attachmentNames })
}

async function verifyAttachmentDeleteClear(page, {
  token,
  baseId,
  sheetId,
  viewId,
  recordId,
  attachmentFieldName,
  attachmentFieldId,
  cleanupAttachmentIds,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId, { mode: 'form', recordId }), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible', timeout: timeoutMs })
  verifyDirectRouteEntry(page, {
    checkName: 'ui.route.form-entry',
    baseId,
    sheetId,
    viewId,
    extra: { mode: 'form', recordId },
  })

  const attachmentField = formFieldByLabel(page, attachmentFieldName)
  const initialRecord = await fetchRecord(token, sheetId, recordId)
  let remainingAttachmentIds = (initialRecord.attachmentSummaries?.[attachmentFieldId] ?? []).map((item) => item.id)
  cleanupAttachmentIds.clear()
  for (const id of remainingAttachmentIds) cleanupAttachmentIds.add(id)
  while (remainingAttachmentIds.length) {
    const removeButton = attachmentField.locator('.meta-attachment-list__remove').first()
    await removeButton.click()
    await attachmentField.getByText('Removing...').waitFor({ state: 'visible', timeout: timeoutMs })
    await attachmentField.getByText('Removing...').waitFor({ state: 'hidden', timeout: timeoutMs })
    await page.getByRole('button', { name: 'Save' }).click()
    await page.getByText('Changes saved').first().waitFor({ state: 'visible', timeout: timeoutMs })

    const afterDelete = await fetchRecord(token, sheetId, recordId)
    const currentAttachments = afterDelete.attachmentSummaries?.[attachmentFieldId] ?? []
    const currentIds = currentAttachments.map((item) => item.id)
    const expectedRemaining = remainingAttachmentIds.slice(1)
    const cleared = currentAttachments.length === expectedRemaining.length &&
      currentIds.every((id, currentIndex) => id === expectedRemaining[currentIndex])
    if (!cleared) {
      record('api.form.attachment-delete-clear', false, {
        recordId,
        fieldId: attachmentFieldId,
        remaining: currentIds,
        expectedRemaining,
      })
      throw new Error(`Attachment delete/clear failed for ${attachmentFieldId}`)
    }
    remainingAttachmentIds = currentIds
    cleanupAttachmentIds.clear()
    for (const id of currentIds) cleanupAttachmentIds.add(id)
  }

  const afterClear = await fetchRecord(token, sheetId, recordId)
  const clearedAttachments = afterClear.attachmentSummaries?.[attachmentFieldId] ?? []
  const clearedFieldValue = afterClear.record?.data?.[attachmentFieldId] ?? []
  const isCleared = clearedAttachments.length === 0 && (!Array.isArray(clearedFieldValue) || clearedFieldValue.length === 0)
  record('api.form.attachment-delete-clear', isCleared, {
    recordId,
    fieldId: attachmentFieldId,
    clearedAttachments: clearedAttachments.length,
  })
  if (!isCleared) {
    throw new Error(`Attachment field ${attachmentFieldId} was not cleared`)
  }
  cleanupAttachmentIds.clear()
}

async function verifyGridHydration(page, { baseId, sheetId, viewId, searchValue, titleText, attachmentName, personDisplay }) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: titleText }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  if (attachmentName) {
    await page.getByText(attachmentName).first().waitFor({ state: 'visible', timeout: timeoutMs })
  }
  await page.getByText(personDisplay).first().waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'grid-hydrated.png'), fullPage: true })
  record('ui.grid.search-hydration', true, { searchValue, attachmentName, personDisplay })
}

function fieldCell(row, fieldName) {
  const safeName = String(fieldName).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return row.locator(`.meta-grid__cell[aria-label="${safeName}"]`).first()
}

function hasSameArrayValues(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value)
}

function apiFieldValueMatches(actual, expected) {
  if (Array.isArray(expected)) return hasSameArrayValues(actual, expected)
  return actual === expected
}

function phoneHrefFor(value) {
  return `tel:${String(value).replace(/[^+\d]/g, '')}`
}

async function assertFieldTypeGridRender(page, titleText, specs) {
  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.waitFor({ state: 'visible', timeout: timeoutMs })
  await search.fill(titleText)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  const row = page.locator('.meta-grid__row').filter({ hasText: titleText }).first()
  await row.waitFor({ state: 'visible', timeout: timeoutMs })

  const details = {}
  for (const spec of specs) {
    const cell = fieldCell(row, spec.field.name)
    await cell.waitFor({ state: 'visible', timeout: timeoutMs })
    const text = (await cell.textContent())?.trim() ?? ''
    details[spec.key] = { text }

    if (spec.key === 'currency' && !text.includes('\u00a51,234.56')) {
      throw new Error(`Currency cell did not render expected value: ${text}`)
    }
    if (spec.key === 'percent' && !text.includes('37.5%')) {
      throw new Error(`Percent cell did not render expected value: ${text}`)
    }
    if (spec.key === 'rating' && !text.includes('\u2605\u2605\u2605\u2605\u2606')) {
      throw new Error(`Rating cell did not render expected value: ${text}`)
    }
    if (spec.key === 'longText' && (!text.includes('Line one field smoke') || !text.includes('Line two field smoke'))) {
      throw new Error(`Long text cell did not render both lines: ${text}`)
    }
    if (spec.key === 'multiSelect') {
      const tags = (await cell.locator('.meta-cell-renderer__tag').allTextContents()).map((item) => item.trim()).filter(Boolean)
      details[spec.key].tags = tags
      if (!hasSameArrayValues(tags, spec.value)) {
        throw new Error(`Multi-select cell tags mismatch: ${JSON.stringify(tags)}`)
      }
    }
    if (spec.key === 'url') {
      const href = await cell.locator('a.meta-cell-renderer__url').getAttribute('href')
      details[spec.key].href = href
      if (href !== spec.value || !text.includes(spec.value)) {
        throw new Error(`URL cell anchor mismatch: ${href}`)
      }
    }
    if (spec.key === 'email') {
      const href = await cell.locator('a.meta-cell-renderer__email').getAttribute('href')
      details[spec.key].href = href
      if (href !== `mailto:${spec.value}` || !text.includes(spec.value)) {
        throw new Error(`Email cell anchor mismatch: ${href}`)
      }
    }
    if (spec.key === 'phone') {
      const href = await cell.locator('a.meta-cell-renderer__phone').getAttribute('href')
      details[spec.key].href = href
      if (href !== phoneHrefFor(spec.value) || !text.includes(spec.value)) {
        throw new Error(`Phone cell anchor mismatch: ${href}`)
      }
    }
  }

  return details
}

async function verifyFieldTypesReloadReplay(page, {
  token,
  baseId,
  sheetId,
  viewId,
  recordId,
  titleText,
  specs,
}) {
  const persistedRecord = await fetchRecord(token, sheetId, recordId)
  const data = persistedRecord.record?.data ?? {}
  const apiMismatches = specs
    .filter((spec) => !apiFieldValueMatches(data[spec.field.id], spec.value))
    .map((spec) => ({
      key: spec.key,
      fieldId: spec.field.id,
      actual: data[spec.field.id],
      expected: spec.value,
    }))
  const apiOk = apiMismatches.length === 0
  record('api.field-types.value-normalization', apiOk, {
    recordId,
    fieldIds: specs.map((spec) => spec.field.id),
    apiMismatches,
  })
  if (!apiOk) {
    throw new Error(`Field type API value mismatch: ${JSON.stringify(apiMismatches)}`)
  }

  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const initialRender = await assertFieldTypeGridRender(page, titleText, specs)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const reloadedRender = await assertFieldTypeGridRender(page, titleText, specs)
  await page.screenshot({ path: path.join(outputDir, 'field-types-reloaded.png'), fullPage: true })
  record('ui.field-types.reload-replay', true, {
    recordId,
    fields: specs.map((spec) => ({ key: spec.key, fieldId: spec.field.id, type: spec.type })),
    initialRender,
    reloadedRender,
  })
}

async function fetchViewById(token, sheetId, viewId) {
  const views = await fetchViews(token, sheetId)
  const view = views.find((item) => item.id === viewId)
  if (!view) throw new Error(`View not found while verifying smoke replay: ${viewId}`)
  return view
}

async function openFilterPanel(page) {
  const filterButton = page.locator('button.meta-toolbar__btn').filter({ hasText: /Filter/ }).first()
  await filterButton.click()
  const panel = page.locator('.meta-toolbar__panel--filter')
  await panel.waitFor({ state: 'visible', timeout: timeoutMs })
  return panel
}

async function addFilterRule(panel, index, { fieldId, operator, value }) {
  await panel.getByRole('button', { name: '+ Add filter' }).click()
  const rule = panel.locator('.meta-toolbar__filter-rule').nth(index)
  await rule.locator('select[aria-label="Filter field"]').selectOption(fieldId)
  if (operator) {
    await rule.locator('select[aria-label="Filter operator"]').selectOption(operator)
  }
  const valueControl = rule.locator('[aria-label="Filter value"]')
  await valueControl.waitFor({ state: 'visible', timeout: timeoutMs })
  const tagName = await valueControl.evaluate((element) => element.tagName.toLowerCase())
  const inputType = await valueControl.evaluate((element) => element.getAttribute('type') ?? '')
  if (tagName === 'select') {
    await valueControl.selectOption(String(value))
  } else {
    await valueControl.fill(String(value))
    await valueControl.dispatchEvent('change')
  }
  return {
    tagName,
    type: inputType,
    value: await valueControl.inputValue(),
  }
}

async function verifyFilterBuilderTypedControlsReplay(page, {
  token,
  baseId,
  sheetId,
  viewId,
  statusFieldId,
  startFieldId,
  scoreFieldId,
  includedTitle,
  excludedTitle,
  startValue,
  scoreThreshold,
}) {
  const originalView = await fetchViewById(token, sheetId, viewId)
  const originalFilterInfo = originalView.filterInfo ?? {}
  try {
    await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
    const panel = await openFilterPanel(page)
    const controlTypes = [
      await addFilterRule(panel, 0, { fieldId: statusFieldId, operator: 'is', value: 'Todo' }),
      await addFilterRule(panel, 1, { fieldId: startFieldId, operator: 'is', value: startValue }),
      await addFilterRule(panel, 2, { fieldId: scoreFieldId, operator: 'greater', value: scoreThreshold }),
    ]
    await Promise.all([
      waitForViewPatch(page, viewId),
      panel.getByRole('button', { name: /Apply filter changes|Apply filters/ }).click(),
    ])
    await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('.meta-grid__row').filter({ hasText: includedTitle }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    const excludedVisibleAfterApply = await page.locator('.meta-grid__row').filter({ hasText: excludedTitle }).count()

    const persisted = await waitForPredicate(async () => {
      const view = await fetchViewById(token, sheetId, viewId)
      const conditions = Array.isArray(view.filterInfo?.conditions) ? view.filterInfo.conditions : []
      const byField = new Map(conditions.map((condition) => [condition.fieldId, condition]))
      return {
        ok: conditions.length === 3
          && byField.get(statusFieldId)?.operator === 'is'
          && byField.get(statusFieldId)?.value === 'Todo'
          && byField.get(startFieldId)?.operator === 'is'
          && byField.get(startFieldId)?.value === startValue
          && byField.get(scoreFieldId)?.operator === 'greater'
          && Number(byField.get(scoreFieldId)?.value) === Number(scoreThreshold),
        conditions,
      }
    }, 'filter builder persisted conditions')

    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('.meta-grid__row').filter({ hasText: includedTitle }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    const excludedVisibleAfterReload = await page.locator('.meta-grid__row').filter({ hasText: excludedTitle }).count()
    const reloadedPanel = await openFilterPanel(page)
    const reloadedRules = await reloadedPanel.locator('.meta-toolbar__filter-rule').count()
    const reloadedStatusValue = await reloadedPanel.locator('.meta-toolbar__filter-rule').nth(0).locator('[aria-label="Filter value"]').inputValue()
    const reloadedStartValue = await reloadedPanel.locator('.meta-toolbar__filter-rule').nth(1).locator('[aria-label="Filter value"]').inputValue()
    const reloadedScoreValue = await reloadedPanel.locator('.meta-toolbar__filter-rule').nth(2).locator('[aria-label="Filter value"]').inputValue()
    const ok = excludedVisibleAfterApply === 0
      && excludedVisibleAfterReload === 0
      && reloadedRules === 3
      && reloadedStatusValue === 'Todo'
      && reloadedStartValue === startValue
      && Number(reloadedScoreValue) === Number(scoreThreshold)
    record('ui.filter-builder.typed-controls-replay', ok, {
      viewId,
      includedTitle,
      excludedTitle,
      controlTypes,
      persistedConditions: persisted.conditions,
      excludedVisibleAfterApply,
      excludedVisibleAfterReload,
      reloadedRules,
      reloadedStatusValue,
      reloadedStartValue,
      reloadedScoreValue,
    })
    if (!ok) {
      throw new Error('Filter builder typed controls did not persist and replay correctly')
    }
  } finally {
    await updateView(token, viewId, { filterInfo: originalFilterInfo })
  }
}

async function verifyConditionalFormattingReloadReplay(page, {
  token,
  baseId,
  sheetId,
  viewId,
  viewName,
  scoreFieldId,
  includedTitle,
  scoreThreshold,
}) {
  const originalView = await fetchViewById(token, sheetId, viewId)
  const originalConfig = originalView.config ?? {}
  const expectedBackground = 'rgb(214, 235, 255)'
  try {
    await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('button.mt-workbench__mgr-btn').filter({ hasText: /Views/ }).click()
    const manager = page.locator('.meta-view-mgr')
    await manager.waitFor({ state: 'visible', timeout: timeoutMs })
    const viewRow = manager.locator('.meta-view-mgr__row').filter({ hasText: viewName }).first()
    await viewRow.locator('button[title="Conditional formatting"]').click()
    const dialog = page.getByRole('dialog', { name: 'Conditional formatting rules' })
    await dialog.waitFor({ state: 'visible', timeout: timeoutMs })
    await dialog.getByRole('button', { name: '+ Add rule' }).click()
    const rule = dialog.locator('.cf-dlg__rule').first()
    await rule.locator('.cf-dlg__select').nth(0).selectOption(scoreFieldId)
    await rule.locator('.cf-dlg__select').nth(1).selectOption('gt')
    await rule.locator('.cf-dlg__input[type="number"]').fill(String(scoreThreshold))
    await rule.locator('.cf-dlg__hex').fill('#d6ebff')
    await rule.locator('label').filter({ hasText: 'Apply to whole row' }).locator('input').check()
    await Promise.all([
      waitForViewPatch(page, viewId),
      dialog.getByRole('button', { name: 'Save rules' }).click(),
    ])

    const persisted = await waitForPredicate(async () => {
      const view = await fetchViewById(token, sheetId, viewId)
      const rules = Array.isArray(view.config?.conditionalFormattingRules)
        ? view.config.conditionalFormattingRules
        : []
      const saved = rules[0] ?? {}
      return {
        ok: rules.length === 1
          && saved.fieldId === scoreFieldId
          && saved.operator === 'gt'
          && Number(saved.value) === Number(scoreThreshold)
          && saved.style?.backgroundColor === '#d6ebff'
          && saved.style?.applyToRow === true,
        rules,
      }
    }, 'conditional formatting persisted rule')

    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const search = page.getByRole('searchbox', { name: 'Search records' })
    await search.waitFor({ state: 'visible', timeout: timeoutMs })
    await search.fill(includedTitle)
    await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
    const highlightedRow = page.locator('.meta-grid__row').filter({ hasText: includedTitle }).first()
    await highlightedRow.waitFor({ state: 'visible', timeout: timeoutMs })
    const rowBackground = await waitForPredicate(async () => {
      const backgroundColor = await highlightedRow.evaluate((element) => window.getComputedStyle(element).backgroundColor)
      return {
        ok: backgroundColor === expectedBackground,
        backgroundColor,
      }
    }, 'conditional formatting row background')

    await page.locator('button.mt-workbench__mgr-btn').filter({ hasText: /Views/ }).click()
    const reloadedManager = page.locator('.meta-view-mgr')
    await reloadedManager.waitFor({ state: 'visible', timeout: timeoutMs })
    const reloadedViewRow = reloadedManager.locator('.meta-view-mgr__row').filter({ hasText: viewName }).first()
    await reloadedViewRow.locator('button[title="Conditional formatting"]').click()
    const reloadedDialog = page.getByRole('dialog', { name: 'Conditional formatting rules' })
    await reloadedDialog.waitFor({ state: 'visible', timeout: timeoutMs })
    const reloadedRule = reloadedDialog.locator('.cf-dlg__rule').first()
    const reloadedFieldId = await reloadedRule.locator('.cf-dlg__select').nth(0).inputValue()
    const reloadedOperator = await reloadedRule.locator('.cf-dlg__select').nth(1).inputValue()
    const reloadedValue = await reloadedRule.locator('.cf-dlg__input[type="number"]').inputValue()
    const reloadedApplyToRow = await reloadedRule.locator('label').filter({ hasText: 'Apply to whole row' }).locator('input').isChecked()
    const ok = reloadedFieldId === scoreFieldId
      && reloadedOperator === 'gt'
      && Number(reloadedValue) === Number(scoreThreshold)
      && reloadedApplyToRow
      && rowBackground.backgroundColor === expectedBackground
    record('ui.conditional-formatting.reload-replay', ok, {
      viewId,
      scoreFieldId,
      scoreThreshold,
      rowBackground: rowBackground.backgroundColor,
      persistedRules: persisted.rules,
      reloadedFieldId,
      reloadedOperator,
      reloadedValue,
      reloadedApplyToRow,
    })
    if (!ok) {
      throw new Error('Conditional formatting rule did not persist, reload, and render correctly')
    }
  } finally {
    await updateView(token, viewId, { config: originalConfig })
  }
}

async function verifyConflictRecovery(page, { token, baseId, sheetId, viewId, recordId, titleFieldId, searchValue, originalTitle }) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  const row = page.locator('.meta-grid__row').filter({ hasText: originalTitle }).first()
  await row.waitFor({ state: 'visible', timeout: timeoutMs })
  await row.click()
  await page.locator('.meta-record-drawer').waitFor({ state: 'visible', timeout: timeoutMs })

  const latest = await fetchRecord(token, sheetId, recordId)
  const serverTitle = `${searchValue} server`
  const retryTitle = `${searchValue} retry`
  await patchRecord(token, {
    sheetId,
    viewId,
    recordId,
    fieldId: titleFieldId,
    value: serverTitle,
    expectedVersion: latest.record.version,
  })

  const titleInput = page.locator(`#drawer_field_${titleFieldId}`)
  await titleInput.fill(retryTitle)
  await titleInput.press('Tab')
  await page.getByText('Update conflict').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Retry change' }).click()
  await page.getByText('Change reapplied').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: retryTitle }).first().waitFor({ state: 'visible', timeout: timeoutMs })

  const after = await fetchRecord(token, sheetId, recordId)
  const titleValue = after.record?.data?.[titleFieldId]
  const ok = titleValue === retryTitle
  record('ui.conflict.retry', ok, { recordId, titleValue, retryTitle })
  if (!ok) {
    throw new Error(`Conflict retry did not persist the browser value: ${titleValue}`)
  }
}

function waitForViewPatch(page, viewId) {
  return page.waitForResponse((response) => {
    return response.request().method() === 'PATCH'
      && response.url().includes(`/api/multitable/views/${encodeURIComponent(viewId)}`)
      && response.ok()
  }, { timeout: timeoutMs })
}

async function dismissDialogAfterClick(page, trigger) {
  let message = ''
  const dialogPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dialog did not appear in time')), timeoutMs)
    page.once('dialog', async (dialog) => {
      clearTimeout(timer)
      message = dialog.message()
      try {
        await dialog.dismiss()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  await trigger()
  await dialogPromise
  return message
}

async function forceOpenDetails(locator) {
  await locator.waitFor({ state: 'attached', timeout: timeoutMs })
  await locator.evaluate((element) => {
    if (element instanceof HTMLDetailsElement) {
      element.open = true
    }
  })
}

async function verifyGalleryConfigReplay(page, {
  baseId,
  sheetId,
  viewId,
  expectedColumns,
  expectedCardSize,
  expectedCoverFieldId,
  expectedVisibleFieldName,
  expectedHiddenFieldName,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const configSelects = page.locator('.meta-gallery__toolbar-select')
  await Promise.all([
    waitForViewPatch(page, viewId),
    configSelects.nth(1).selectOption(expectedCoverFieldId ?? ''),
  ])
  await Promise.all([
    waitForViewPatch(page, viewId),
    configSelects.nth(2).selectOption(String(expectedColumns)),
  ])
  await Promise.all([
    waitForViewPatch(page, viewId),
    configSelects.nth(3).selectOption(expectedCardSize),
  ])
  const fieldPicker = page.locator('.meta-gallery__field-picker')
  await forceOpenDetails(fieldPicker)
  const hiddenFieldCheckbox = fieldPicker
    .locator('.meta-gallery__field-picker-item')
    .filter({ hasText: exactTextRegex(expectedHiddenFieldName) })
    .locator('input')
  if (await hiddenFieldCheckbox.isChecked()) {
    await Promise.all([
      waitForViewPatch(page, viewId),
      hiddenFieldCheckbox.uncheck(),
    ])
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await configSelects.nth(2).waitFor({ state: 'visible', timeout: timeoutMs })
  await forceOpenDetails(fieldPicker)
  const coverValue = await configSelects.nth(1).inputValue()
  const columnsValue = await configSelects.nth(2).inputValue()
  const cardSizeValue = await configSelects.nth(3).inputValue()
  const visibleFieldChecked = await fieldPicker
    .locator('.meta-gallery__field-picker-item')
    .filter({ hasText: exactTextRegex(expectedVisibleFieldName) })
    .locator('input')
    .isChecked()
  const hiddenFieldChecked = await hiddenFieldCheckbox.isChecked()
  const coverCount = await page.locator('.meta-gallery__cover').count()
  const gridInlineStyle = await page.locator('.meta-gallery__grid').getAttribute('style')
  const cardClasses = await page.locator('.meta-gallery__card').first().evaluate((el) => Array.from(el.classList))
  const cardBodyText = await page.locator('.meta-gallery__card-body').first().textContent()
  const ok = coverValue === (expectedCoverFieldId ?? '')
    && columnsValue === String(expectedColumns)
    && cardSizeValue === expectedCardSize
    && visibleFieldChecked
    && !hiddenFieldChecked
    && coverCount === 0
    && (gridInlineStyle ?? '').includes(`repeat(${expectedColumns}`)
    && cardClasses.includes(`meta-gallery__card--${expectedCardSize}`)
    && (cardBodyText ?? '').includes(expectedVisibleFieldName)
    && !(cardBodyText ?? '').includes(expectedHiddenFieldName)
  record('ui.gallery.config-replay', ok, {
    baseId,
    sheetId,
    viewId,
    coverValue,
    columnsValue,
    cardSizeValue,
    visibleFieldChecked,
    hiddenFieldChecked,
    coverCount,
    gridInlineStyle,
    cardClasses,
    cardBodyText,
  })
  if (!ok) {
    throw new Error(`Gallery config replay failed for ${viewId}`)
  }
}

async function verifyCalendarConfigReplay(page, {
  baseId,
  sheetId,
  viewId,
  expectedMode,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const modeSelect = page.locator('.meta-calendar__mode-select')
  await Promise.all([
    waitForViewPatch(page, viewId),
    modeSelect.selectOption(expectedMode),
  ])
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await modeSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  const modeValue = await modeSelect.inputValue()
  const hasDayView = await page.locator('.meta-calendar__day-view').count().then((count) => count > 0)
  const hasWeekGrid = await page.locator('.meta-calendar__grid--week').count().then((count) => count > 0)
  const ok = modeValue === expectedMode && (expectedMode === 'day' ? hasDayView : true) && (expectedMode === 'week' ? hasWeekGrid : true)
  record('ui.calendar.config-replay', ok, {
    baseId,
    sheetId,
    viewId,
    modeValue,
    hasDayView,
    hasWeekGrid,
  })
  if (!ok) {
    throw new Error(`Calendar config replay failed for ${viewId}`)
  }
}

async function verifyTimelineConfigReplay(page, {
  baseId,
  sheetId,
  viewId,
  expectedLabelFieldId,
  expectedLabelFieldName,
  expectedZoom,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const configSelects = page.locator('.meta-timeline__config-select')
  await Promise.all([
    waitForViewPatch(page, viewId),
    configSelects.nth(2).selectOption(expectedLabelFieldId),
  ])
  await Promise.all([
    waitForViewPatch(page, viewId),
    configSelects.nth(3).selectOption(expectedZoom),
  ])
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await configSelects.nth(2).waitFor({ state: 'visible', timeout: timeoutMs })
  const labelValue = await configSelects.nth(2).inputValue()
  const zoomValue = await configSelects.nth(3).inputValue()
  const headerMeta = await page.locator('.meta-timeline__header-meta').textContent()
  const zoomBadge = await page.locator('.meta-timeline__zoom-badge').textContent()
  const ok = labelValue === expectedLabelFieldId
    && zoomValue === expectedZoom
    && (headerMeta ?? '').includes(`Label: ${expectedLabelFieldName}`)
    && (zoomBadge ?? '').includes(`Zoom: ${expectedZoom === 'day' ? 'Day' : expectedZoom === 'month' ? 'Month' : 'Week'}`)
  record('ui.timeline.config-replay', ok, {
    baseId,
    sheetId,
    viewId,
    labelValue,
    zoomValue,
    headerMeta,
    zoomBadge,
  })
  if (!ok) {
    throw new Error(`Timeline config replay failed for ${viewId}`)
  }
}

async function verifyKanbanConfigReplay(page, {
  baseId,
  sheetId,
  viewId,
  expectedGroupFieldId,
  expectedGroupFieldName,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const groupSelect = page.locator('.meta-kanban__header .meta-kanban__field-select')
  await Promise.all([
    waitForViewPatch(page, viewId),
    groupSelect.selectOption(expectedGroupFieldId),
  ])
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await groupSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  const groupValue = await groupSelect.inputValue()
  const groupLabel = await page.locator('.meta-kanban__group-label').textContent()
  const columnHeaders = await page.locator('.meta-kanban__column-header').allTextContents()
  const ok = groupValue === expectedGroupFieldId
    && (groupLabel ?? '').includes(`Grouped by: ${expectedGroupFieldName}`)
    && columnHeaders.length > 0
  record('ui.kanban.config-replay', ok, {
    baseId,
    sheetId,
    viewId,
    groupValue,
    groupLabel,
    columnHeaders,
  })
  if (!ok) {
    throw new Error(`Kanban config replay failed for ${viewId}`)
  }
}

async function verifyKanbanEmptyCardFieldsReplay(page, {
  baseId,
  sheetId,
  viewId,
  expectedGroupFieldId,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const groupSelect = page.locator('.meta-kanban__header .meta-kanban__field-select')
  await groupSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  if ((await groupSelect.inputValue()) !== expectedGroupFieldId) {
    await Promise.all([
      waitForViewPatch(page, viewId),
      groupSelect.selectOption(expectedGroupFieldId),
    ])
  }
  const fieldPicker = page.locator('.meta-kanban__field-picker')
  await forceOpenDetails(fieldPicker)
  const checkedCardFields = fieldPicker.locator('.meta-kanban__field-picker-item input:checked')
  while ((await checkedCardFields.count()) > 0) {
    await Promise.all([
      waitForViewPatch(page, viewId),
      checkedCardFields.first().uncheck(),
    ])
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await groupSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  await forceOpenDetails(fieldPicker)
  const groupValue = await groupSelect.inputValue()
  const checkedCardFieldCount = await fieldPicker.locator('.meta-kanban__field-picker-item input:checked').count()
  const cardFieldTexts = await page.locator('.meta-kanban__card-fields').allTextContents()
  const ok = groupValue === expectedGroupFieldId
    && checkedCardFieldCount === 0
    && cardFieldTexts.length > 0
    && cardFieldTexts.some((text) => text.includes(':'))
  record('ui.kanban.empty-card-fields-replay', ok, {
    baseId,
    sheetId,
    viewId,
    groupValue,
    checkedCardFieldCount,
    cardFieldTexts,
  })
  if (!ok) {
    throw new Error(`Kanban empty card field replay failed for ${viewId}`)
  }
}

async function verifyKanbanClearGroupReplay(page, {
  baseId,
  sheetId,
  viewId,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const groupSelect = page.locator('.meta-kanban__header .meta-kanban__field-select')
  await groupSelect.waitFor({ state: 'visible', timeout: timeoutMs })
  await Promise.all([
    waitForViewPatch(page, viewId),
    groupSelect.selectOption(''),
  ])
  const emptyState = page.locator('.meta-kanban__empty')
  await emptyState.waitFor({ state: 'visible', timeout: timeoutMs })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await emptyState.waitFor({ state: 'visible', timeout: timeoutMs })
  const emptySelectValue = await page.locator('.meta-kanban__empty .meta-kanban__field-select').inputValue()
  const headerCount = await page.locator('.meta-kanban__header').count()
  const emptyText = await emptyState.textContent()
  const ok = emptySelectValue === ''
    && headerCount === 0
    && (emptyText ?? '').includes('Select a')
  record('ui.kanban.clear-group-replay', ok, {
    baseId,
    sheetId,
    viewId,
    emptySelectValue,
    headerCount,
    emptyText,
  })
  if (!ok) {
    throw new Error(`Kanban clear group replay failed for ${viewId}`)
  }
}

async function verifyFieldManagerPropReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
  fieldId,
  fieldName,
  expectedMaxFiles,
  expectedMimeType,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.mt-workbench__mgr-btn').filter({ hasText: 'Fields' }).click()
  const fieldRow = page.locator('.meta-field-mgr__row').filter({ hasText: fieldName }).first()
  await fieldRow.locator('button[title="Configure"]').click()

  const maxFilesInput = page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).locator('input')
  await maxFilesInput.fill(String(Math.max(1, expectedMaxFiles - 1)))
  await waitForLocatorInputValue(maxFilesInput, String(Math.max(1, expectedMaxFiles - 1)))

  await updateField(token, fieldId, {
    property: {
      maxFiles: expectedMaxFiles,
      acceptedMimeTypes: [expectedMimeType],
    },
  })

  const warning = page.locator('.meta-field-mgr__warning')
  const refresh = page.locator('.meta-field-mgr__refresh')
  const reconcileState = await waitForPredicate(async () => {
    const maxFilesValue = await maxFilesInput.inputValue()
    const acceptedMimeTypesValue = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Accepted mime types' }).locator('input').inputValue()
    const warningVisible = await warning.isVisible().catch(() => false)
    const refreshVisible = !warningVisible && await refresh.isVisible().catch(() => false)
    return {
      ok: warningVisible
        || refreshVisible
        || (maxFilesValue === String(expectedMaxFiles) && acceptedMimeTypesValue === expectedMimeType),
      warningVisible,
      refreshVisible,
      maxFilesValue,
      acceptedMimeTypesValue,
    }
  }, 'field manager prop reconcile signal')
  const warningVisible = reconcileState.warningVisible
  const refreshVisible = !warningVisible && reconcileState.refreshVisible
  const closeDialogMessage = warningVisible
    ? await dismissDialogAfterClick(page, async () => {
      await page.locator('.meta-field-mgr__close').click()
    })
    : null
  if (warningVisible) {
    await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  }
  await page.screenshot({ path: path.join(outputDir, 'field-manager-prop-reconcile.png'), fullPage: true })
  if (warningVisible) {
    await warning.getByRole('button', { name: 'Reload latest' }).click()
    await warning.waitFor({ state: 'hidden', timeout: timeoutMs })
  }

  const maxFilesValue = await maxFilesInput.inputValue()
  const acceptedMimeTypesValue = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Accepted mime types' }).locator('input').inputValue()
  const warningPathOk = warningVisible
    && closeDialogMessage === 'Discard unsaved field manager changes?'
    && maxFilesValue === String(expectedMaxFiles)
    && acceptedMimeTypesValue === expectedMimeType
  const liveRefreshPathOk = refreshVisible
    && maxFilesValue === String(expectedMaxFiles)
    && acceptedMimeTypesValue === expectedMimeType
  const directSyncPathOk = !warningVisible
    && !refreshVisible
    && maxFilesValue === String(expectedMaxFiles)
    && acceptedMimeTypesValue === expectedMimeType
  const ok = warningPathOk || liveRefreshPathOk || directSyncPathOk
  record('ui.field-manager.prop-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
    reconcilePath: warningVisible ? 'warning' : refreshVisible ? 'refresh' : directSyncPathOk ? 'direct' : 'none',
    closeDialogMessage,
    maxFilesValue,
    acceptedMimeTypesValue,
  })
  if (!ok) {
    throw new Error(`Field manager prop reconcile failed for ${fieldId}`)
  }
  await page.locator('.meta-field-mgr__close').click()
}

async function verifyViewManagerPropReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
  managedViewId,
  managedViewName,
  expectedColumns,
  expectedCardSize,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.mt-workbench__mgr-btn').filter({ hasText: 'Views' }).click()
  const viewRow = page.locator('.meta-view-mgr__row').filter({ hasText: managedViewName }).first()
  await viewRow.locator('button[title="Configure"]').click()

  const columnsInput = page.locator('.meta-view-mgr__field').filter({ hasText: 'Columns' }).locator('input')
  const dirtyColumns = expectedColumns >= 4 ? 2 : expectedColumns + 1
  await columnsInput.fill(String(dirtyColumns))

  await updateView(token, managedViewId, {
    config: {
      titleFieldId: 'fld_pilot_title',
      coverFieldId: 'fld_pilot_files',
      fieldIds: ['fld_pilot_status', 'fld_pilot_owner'],
      columns: expectedColumns,
      cardSize: expectedCardSize,
    },
  })

  const warning = page.locator('.meta-view-mgr__warning')
  const refresh = page.locator('.meta-view-mgr__refresh')
  const reconcileState = await waitForPredicate(async () => {
    const warningVisible = await warning.isVisible().catch(() => false)
    const refreshVisible = !warningVisible && await refresh.isVisible().catch(() => false)
    const columnsValue = await columnsInput.inputValue()
    const cardSizeValue = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Card size' }).locator('select').inputValue()
    return {
      ok: warningVisible
        || refreshVisible
        || (columnsValue === String(expectedColumns) && cardSizeValue === expectedCardSize),
      warningVisible,
      refreshVisible,
      columnsValue,
      cardSizeValue,
    }
  }, 'view manager prop reconcile signal')
  const warningVisible = reconcileState.warningVisible
  const refreshVisible = !warningVisible && reconcileState.refreshVisible
  const warningText = warningVisible ? ((await warning.textContent())?.trim() ?? '') : ''
  const refreshText = refreshVisible ? ((await refresh.textContent())?.trim() ?? '') : ''
  const closeDialogMessage = warningVisible
    ? await dismissDialogAfterClick(page, async () => {
      await page.locator('.meta-view-mgr__close').click()
    })
    : null
  if (warningVisible) {
    await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  } else if (refreshVisible) {
    await refresh.waitFor({ state: 'visible', timeout: timeoutMs })
  }
  await page.screenshot({ path: path.join(outputDir, 'view-manager-prop-reconcile.png'), fullPage: true })
  if (warningVisible) {
    await warning.getByRole('button', { name: 'Reload latest' }).click()
    await warning.waitFor({ state: 'hidden', timeout: timeoutMs })
  }

  const settledValues = await waitForPredicate(async () => {
    const columnsValue = await columnsInput.inputValue()
    const cardSizeValue = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Card size' }).locator('select').inputValue()
    return {
      ok: columnsValue === String(expectedColumns) && cardSizeValue === expectedCardSize,
      columnsValue,
      cardSizeValue,
    }
  }, 'view manager prop reconcile values')
  const columnsValue = settledValues.columnsValue
  const cardSizeValue = settledValues.cardSizeValue
  const warningPathOk = warningVisible
    && warningText.includes('This view changed in the background')
    && closeDialogMessage === 'Discard unsaved view manager changes?'
    && columnsValue === String(expectedColumns)
    && cardSizeValue === expectedCardSize
  const liveRefreshPathOk = refreshVisible
    && refreshText.includes('Latest view metadata loaded from the sheet context.')
    && columnsValue === String(expectedColumns)
    && cardSizeValue === expectedCardSize
  const directSyncPathOk = !warningVisible
    && !refreshVisible
    && columnsValue === String(expectedColumns)
    && cardSizeValue === expectedCardSize
  const ok = warningPathOk || liveRefreshPathOk || directSyncPathOk
  record('ui.view-manager.prop-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    managedViewId,
    reconcilePath: warningVisible ? 'warning' : refreshVisible ? 'refresh' : directSyncPathOk ? 'direct' : 'none',
    closeDialogMessage,
    warningText,
    refreshText,
    columnsValue,
    cardSizeValue,
  })
  if (!ok) {
    throw new Error(`View manager prop reconcile failed for ${managedViewId}`)
  }
  await page.locator('.meta-view-mgr__close').click()
}

async function verifyFieldManagerTypeReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
  fieldId,
  fieldName,
  renamedFieldName,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.mt-workbench__mgr-btn').filter({ hasText: 'Fields' }).click()
  const fieldRow = page.locator('.meta-field-mgr__row').filter({ hasText: fieldName }).first()
  await fieldRow.locator('button[title="Configure"]').click()

  const maxFilesInput = page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).locator('input')
  await maxFilesInput.fill('5')
  await waitForLocatorInputValue(maxFilesInput, '5')

  await updateField(token, fieldId, {
    name: renamedFieldName,
    type: 'link',
    property: {
      refKind: 'user',
      limitSingleRecord: false,
    },
  })

  const warning = page.locator('.meta-field-mgr__warning')
  await page.screenshot({ path: path.join(outputDir, 'field-manager-type-reconcile.png'), fullPage: true })

  const headerTextBeforeReload = (await page.locator('.meta-field-mgr__config-header strong').textContent())?.trim() ?? ''
  const configTypeBeforeReload = (await page.locator('.meta-field-mgr__config-header span').textContent())?.trim() ?? ''
  const saveButton = page.locator('.meta-field-mgr__config-actions .meta-field-mgr__btn-add').filter({ hasText: 'Save field settings' })
  const maxFilesVisibleBeforeReload = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).count()
  const refresh = page.locator('.meta-field-mgr__refresh')
  const reconcileState = await waitForPredicate(async () => {
    const warningVisible = await warning.isVisible().catch(() => false)
    const refreshVisible = !warningVisible && await refresh.isVisible().catch(() => false)
    const configTypeAfterReload = (await page.locator('.meta-field-mgr__config-header span').textContent())?.trim() ?? ''
    const maxFilesVisibleAfterReload = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).count()
    return {
      ok: warningVisible || refreshVisible || (configTypeAfterReload === 'person' && maxFilesVisibleAfterReload === 0),
      warningVisible,
      refreshVisible,
      configTypeAfterReload,
      maxFilesVisibleAfterReload,
    }
  }, 'field manager type reconcile signal')
  const warningVisible = reconcileState.warningVisible
  const refreshVisible = !warningVisible && reconcileState.refreshVisible
  const warningText = warningVisible ? ((await warning.textContent())?.trim() ?? '') : ''
  const refreshText = refreshVisible ? ((await refresh.textContent())?.trim() ?? '') : ''
  const saveDisabledBeforeReload = await saveButton.isDisabled()

  if (warningVisible) {
    await warning.getByRole('button', { name: 'Reload latest' }).click()
    await warning.waitFor({ state: 'hidden', timeout: timeoutMs })
  }

  const configTypeAfterReload = (await page.locator('.meta-field-mgr__config-header span').textContent())?.trim() ?? ''
  const headerTextAfterReload = (await page.locator('.meta-field-mgr__config-header strong').textContent())?.trim() ?? ''
  const personHintVisible = await page.locator('.meta-field-mgr__hint').filter({ hasText: 'People fields use the system people sheet preset' }).count()
  const maxFilesVisibleAfterReload = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).count()
  const saveDisabledAfterReload = await saveButton.isDisabled()
  const warningPathOk = warningVisible
    && warningText.includes('changed type in the background')
    && saveDisabledBeforeReload
    && configTypeAfterReload === 'person'
    && personHintVisible === 1
    && maxFilesVisibleAfterReload === 0
    && !saveDisabledAfterReload
  const liveRefreshPathOk = refreshVisible
    && refreshText.includes('Latest field metadata loaded from the sheet context.')
    && configTypeAfterReload === 'person'
    && personHintVisible === 1
    && maxFilesVisibleAfterReload === 0
    && !saveDisabledAfterReload
  const directSyncPathOk = !warningVisible
    && !refreshVisible
    && configTypeAfterReload === 'person'
    && personHintVisible === 1
    && maxFilesVisibleAfterReload === 0
    && !saveDisabledAfterReload
  const ok = headerTextAfterReload.includes(renamedFieldName)
    && configTypeBeforeReload === 'attachment'
    && maxFilesVisibleBeforeReload === 1
    && (warningPathOk || liveRefreshPathOk || directSyncPathOk)
  record('ui.field-manager.type-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
    fieldName: renamedFieldName,
    reconcilePath: warningVisible ? 'warning' : refreshVisible ? 'refresh' : directSyncPathOk ? 'direct' : 'none',
    headerTextBeforeReload,
    headerTextAfterReload,
    configTypeBeforeReload,
    configTypeAfterReload,
    warningText,
    refreshText,
    saveDisabledBeforeReload,
    saveDisabledAfterReload,
  })
  if (!ok) {
    throw new Error(`Field manager type reconcile failed for ${fieldId}`)
  }
  await page.locator('.meta-field-mgr__close').click()
}

async function verifyViewManagerFieldSchemaReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
  managedViewId,
  managedViewName,
  titleFieldId,
  originalTitleFieldName,
  renamedTitleFieldName,
  coverFieldId,
  coverFieldRestoreName,
  coverFieldRestoreProperty,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.mt-workbench__mgr-btn').filter({ hasText: 'Views' }).click()
  const viewRow = page.locator('.meta-view-mgr__row').filter({ hasText: managedViewName }).first()
  await viewRow.locator('button[title="Configure"]').click()

  const columnsInput = page.locator('.meta-view-mgr__field').filter({ hasText: 'Columns' }).locator('input')
  await columnsInput.fill('4')

  await updateField(token, titleFieldId, {
    name: renamedTitleFieldName,
  })

  const warning = page.locator('.meta-view-mgr__warning')
  await waitForPredicate(async () => {
    const warningVisible = await warning.isVisible().catch(() => false)
    const titleOptions = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Title field' }).locator('option').allTextContents()
    return {
      ok: warningVisible || titleOptions.includes(renamedTitleFieldName),
      warningVisible,
      titleOptions,
    }
  }, 'view manager title-field reconcile signal')
  if (await warning.isVisible().catch(() => false)) {
    await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  }

  await updateField(token, coverFieldId, {
    name: `${coverFieldRestoreName} (Archived)`,
    type: 'string',
    property: {},
  })

  const typedWarning = page.locator('.meta-view-mgr__warning').filter({
    hasText: 'cover field is no longer an attachment field',
  })
  await waitForPredicate(async () => {
    const warningVisible = await typedWarning.isVisible().catch(() => false)
    const coverFieldValue = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Cover field' }).locator('select').inputValue()
    return {
      ok: warningVisible || coverFieldValue === '',
      warningVisible,
      coverFieldValue,
    }
  }, 'view manager cover-field reconcile signal')
  if (await typedWarning.isVisible().catch(() => false)) {
    await typedWarning.waitFor({ state: 'visible', timeout: timeoutMs })
  }

  await page.screenshot({ path: path.join(outputDir, 'view-manager-field-schema-reconcile.png'), fullPage: true })

  const saveButton = page.locator('.meta-view-mgr__config-actions .meta-view-mgr__btn-add').filter({ hasText: 'Save view settings' })
  const warningText = (await warning.textContent())?.trim() ?? ''
  const saveDisabledBeforeReload = await saveButton.isDisabled()

  await warning.getByRole('button', { name: 'Reload latest' }).click()
  await warning.waitFor({ state: 'hidden', timeout: timeoutMs })

  const titleOptionsAfterReload = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Title field' }).locator('option').allTextContents()
  const coverFieldValueAfterReload = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Cover field' }).locator('select').inputValue()
  const saveDisabledAfterReload = await saveButton.isDisabled()

  await page.locator('.meta-view-mgr__close').click()

  await updateField(token, titleFieldId, {
    name: originalTitleFieldName,
  })
  await updateField(token, coverFieldId, {
    name: coverFieldRestoreName,
    type: 'attachment',
    property: coverFieldRestoreProperty,
  })

  const ok = titleOptionsAfterReload.includes(renamedTitleFieldName)
    && warningText.includes('cover field is no longer an attachment field')
    && saveDisabledBeforeReload
    && coverFieldValueAfterReload === ''
    && !saveDisabledAfterReload
  record('ui.view-manager.field-schema-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    managedViewId,
    managedViewName,
    titleFieldId,
    renamedTitleFieldName,
    coverFieldId,
    warningText,
    titleOptionsAfterReload,
    saveDisabledBeforeReload,
    saveDisabledAfterReload,
    coverFieldValueAfterReload,
  })
  if (!ok) {
    throw new Error(`View manager field schema reconcile failed for ${managedViewId}`)
  }
}

async function verifyFieldManagerTargetRemoval(page, {
  token,
  baseId,
  sheetId,
  viewId,
  fieldId,
  fieldName,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.mt-workbench__mgr-btn').filter({ hasText: 'Fields' }).click()
  const fieldRow = page.locator('.meta-field-mgr__row').filter({ hasText: fieldName }).first()
  await fieldRow.locator('button[title="Configure"]').click()
  await page.locator('.meta-field-mgr__config-header').filter({ hasText: `Configure ${fieldName}` }).waitFor({ state: 'visible', timeout: timeoutMs })

  await deleteField(token, fieldId)

  await page.locator('.meta-field-mgr__config').waitFor({ state: 'hidden', timeout: timeoutMs })
  await fieldRow.waitFor({ state: 'hidden', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'field-manager-target-removal.png'), fullPage: true })

  const warningCount = await page.locator('.meta-field-mgr__warning').count()
  const ok = warningCount === 0
  record('ui.field-manager.target-removal', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
    fieldName,
    warningCount,
  })
  if (!ok) {
    throw new Error(`Field manager target removal failed for ${fieldId}`)
  }
  await page.locator('.meta-field-mgr__close').click()
}

async function verifyViewManagerTargetRemoval(page, {
  token,
  baseId,
  sheetId,
  viewId,
  managedViewId,
  managedViewName,
}) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.mt-workbench__mgr-btn').filter({ hasText: 'Views' }).click()
  const viewRow = page.locator('.meta-view-mgr__row').filter({ hasText: managedViewName }).first()
  await viewRow.locator('button[title="Configure"]').click()
  await page.locator('.meta-view-mgr__config-header').filter({ hasText: `Configure ${managedViewName}` }).waitFor({ state: 'visible', timeout: timeoutMs })

  await deleteView(token, managedViewId)

  await page.locator('.meta-view-mgr__config').waitFor({ state: 'hidden', timeout: timeoutMs })
  await viewRow.waitFor({ state: 'hidden', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'view-manager-target-removal.png'), fullPage: true })

  const warningCount = await page.locator('.meta-view-mgr__warning').count()
  const ok = warningCount === 0
  record('ui.view-manager.target-removal', ok, {
    baseId,
    sheetId,
    viewId,
    managedViewId,
    managedViewName,
    warningCount,
  })
  if (!ok) {
    throw new Error(`View manager target removal failed for ${managedViewId}`)
  }
  await page.locator('.meta-view-mgr__close').click()
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true })

  let token = ''
  const cleanupRecords = new Map()
  const cleanupFieldIds = new Set()
  const attachmentIds = new Set()

  try {
    await fetchHealth()
    token = await getAuthToken()

    const bases = await fetchBases(token)
    let base = bases.find((item) => item.id === 'base_legacy') || bases[0]
    if (!base) {
      const createdSheet = await createSheet(token, {
        id: 'sheet_multitable_pilot_bootstrap',
        name: 'Pilot Bootstrap',
        description: 'Bootstrap sheet for multitable pilot smoke',
        seed: false,
      })
      base = { id: createdSheet.baseId, name: 'Migrated Base' }
    }

    const sheet = await ensurePilotSheet(token, base.id)
    const { titleField, attachmentField, personField } = await ensurePilotFields(token, sheet.id)
    const { statusField, priorityField, startField, endField } = await ensureReplayFields(token, sheet.id)
    const { gridView, formView, galleryView, calendarView, timelineView, kanbanView } = await ensurePilotViews(token, sheet.id, {
      titleFieldId: titleField.id,
      attachmentFieldId: attachmentField.id,
      personFieldId: personField.id,
      statusFieldId: statusField.id,
      priorityFieldId: priorityField.id,
      startFieldId: startField.id,
      endFieldId: endField.id,
    })
    const personChoice = await ensureSelectablePersonOption(token, sheet.id, personField.id)

    const titlePrefix = `PilotFlow-${Date.now()}`
    const importedTitle = `${titlePrefix} imported`
    const retryTitle = `${titlePrefix} retry`
    const peopleRepairReconcileTitle = `${titlePrefix} people repair reconcile`
    const manualFixTitle = `${titlePrefix} manual fix`
    const xlsxImportTitle = `${titlePrefix} xlsx import`
    const viewSubmitTitle = `${titlePrefix} view submit`
    const importDriftField = await createField(token, {
      id: `fld_pilot_import_drift_${Date.now()}`,
      sheetId: sheet.id,
      name: `Import Drift ${titlePrefix}`,
      type: 'string',
    })
    cleanupFieldIds.add(importDriftField.id)
    const tempPeopleRepairField = await createField(token, {
      id: `fld_pilot_people_repair_${Date.now()}`,
      sheetId: sheet.id,
      name: `Owner Repair ${titlePrefix}`,
      type: 'link',
      property: personField.property,
    })
    cleanupFieldIds.add(tempPeopleRepairField.id)
    const scoreField = await createField(token, {
      id: `fld_pilot_score_${Date.now()}`,
      sheetId: sheet.id,
      name: `Score ${titlePrefix}`,
      type: 'number',
    })
    cleanupFieldIds.add(scoreField.id)
    const fieldTypeSmokeFields = await createFieldTypeSmokeFields(token, sheet.id, titlePrefix)
    for (const spec of fieldTypeSmokeFields) cleanupFieldIds.add(spec.field.id)
    const tempField = await createField(token, {
      id: `fld_pilot_temp_attach_${Date.now()}`,
      sheetId: sheet.id,
      name: `Temp Files ${titlePrefix}`,
      type: 'attachment',
      property: {
        maxFiles: 2,
      },
    })
    const tempView = await createView(token, {
      id: `view_pilot_temp_gallery_${Date.now()}`,
      sheetId: sheet.id,
      type: 'gallery',
      name: `Temp Gallery ${titlePrefix}`,
      config: {
        titleFieldId: titleField.id,
        coverFieldId: attachmentField.id,
        fieldIds: [statusField.id],
        columns: 2,
        cardSize: 'medium',
      },
    })
    const csvPath = path.join(outputDir, 'pilot-import.csv')
    fs.writeFileSync(csvPath, `Title\n${importedTitle}\n${retryTitle}\n`)
    const manualFixCsvPath = path.join(outputDir, 'pilot-import-people-manual-fix.csv')
    fs.writeFileSync(manualFixCsvPath, `Title,${personField.name}\n${manualFixTitle},__needs_fix__\n`)
    const attachmentNames = [
      `pilot-attachment-a-${Date.now()}.txt`,
      `pilot-attachment-b-${Date.now()}.txt`,
    ]

    const browser = await chromium.launch({ headless })
    const browserContext = await browser.newContext()
    await browserContext.addInitScript((authToken) => {
      localStorage.setItem('auth_token', authToken)
      localStorage.setItem('jwt', authToken)
    }, token)
    const page = await browserContext.newPage()

    try {
      await importRecordsViaGridWithRetry(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        csvPath,
        titleFieldId: titleField.id,
        retryRowTitle: retryTitle,
        importedRowTitle: importedTitle,
      })

      await verifyImportMappingReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        fieldId: importDriftField.id,
        fieldName: importDriftField.name,
        renamedFieldName: `${importDriftField.name} Renamed`,
        formulaFieldName: `${importDriftField.name} Formula`,
      })

      await verifyPeopleRepairReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        titleFieldId: titleField.id,
        fieldId: tempPeopleRepairField.id,
        fieldName: tempPeopleRepairField.name,
        renamedFieldName: `${tempPeopleRepairField.name} Text`,
        importedRowTitle: peopleRepairReconcileTitle,
        personDisplay: personChoice.display || personChoice.id,
      })

      await importRecordViaGridWithPeopleManualFix(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        csvPath: manualFixCsvPath,
        titleFieldId: titleField.id,
        personFieldId: personField.id,
        personFieldName: personField.name,
        importedRowTitle: manualFixTitle,
        personDisplay: personChoice.display || personChoice.id,
      })

      const imported = await findRecordBySearch(token, sheet.id, gridView.id, importedTitle)
      const retried = await findRecordBySearch(token, sheet.id, gridView.id, retryTitle)
      const peopleRepairReconcile = await findRecordBySearch(token, sheet.id, gridView.id, peopleRepairReconcileTitle)
      const manualFixed = await findRecordBySearch(token, sheet.id, gridView.id, manualFixTitle)
      if (!imported.row?.id || !retried.row?.id) {
        throw new Error('Imported records not found via API search after retry')
      }
      if (!peopleRepairReconcile.row?.id) {
        throw new Error('People-repair reconcile imported record not found via API search')
      }
      if (!manualFixed.row?.id) {
        throw new Error('Manual-fix imported record not found via API search')
      }
      cleanupRecords.set(imported.row.id, imported.row.version)
      cleanupRecords.set(retried.row.id, retried.row.version)
      cleanupRecords.set(peopleRepairReconcile.row.id, peopleRepairReconcile.row.version)
      cleanupRecords.set(manualFixed.row.id, manualFixed.row.version)
      const recordId = imported.row.id
      const trackRecord = (record) => {
        if (record?.id) cleanupRecords.set(record.id, record.version)
      }
      const manualFixRecord = await fetchRecord(token, sheet.id, manualFixed.row.id)
      const manualFixPeople = manualFixRecord.linkSummaries?.[personField.id] ?? []
      const manualFixOk = manualFixPeople.some((item) => item.id === personChoice.id)
      record('api.import.people-manual-fix-hydration', manualFixOk, {
        recordId: manualFixed.row.id,
        fieldId: personField.id,
        personId: personChoice.id,
      })
      if (!manualFixOk) {
        throw new Error('Manual-fix people import did not persist selected person link')
      }

      const xlsxImported = await verifyXlsxImportExport(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        titleFieldId: titleField.id,
        importedRowTitle: xlsxImportTitle,
        onImportedRecord: trackRecord,
      })

      await assignPersonViaDrawer(page, {
        searchValue: importedTitle,
        personFieldName: personField.name,
        personDisplay: personChoice.display || personChoice.id,
      })

      const afterPerson = await fetchRecord(token, sheet.id, recordId)
      trackRecord(afterPerson.record)
      const linkedUserNames = afterPerson.linkSummaries?.[personField.id] ?? []
      const personOk = linkedUserNames.some((item) => item.id === personChoice.id)
      record('api.person-link-hydration', personOk, {
        recordId,
        fieldId: personField.id,
        personId: personChoice.id,
      })
      if (!personOk) {
        throw new Error('Person preset link was not persisted on the record')
      }

      await verifyFormAttachmentLifecycle(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: formView.id,
        recordId,
        attachmentFieldName: attachmentField.name,
        attachmentFieldId: attachmentField.id,
        attachmentNames,
        cleanupAttachmentIds: attachmentIds,
        onPersistedRecord: trackRecord,
      })

      const afterAttachment = await fetchRecord(token, sheet.id, recordId)
      trackRecord(afterAttachment.record)
      const hydratedAttachments = afterAttachment.attachmentSummaries?.[attachmentField.id] ?? []
      const attachmentNamesPresent = new Set(hydratedAttachments.map((item) => item.filename))
      const attachmentUploadOk = attachmentNames.every((name) => attachmentNamesPresent.has(name))
      if (!attachmentUploadOk) {
        record('api.multitable.attachment-hydration', false, {
          recordId,
          fieldId: attachmentField.id,
          attachmentNames,
          present: [...attachmentNamesPresent],
        })
        throw new Error('Attachment hydration missing from record response after UI upload')
      }
      record('api.multitable.attachment-hydration', true, {
        recordId,
        fieldId: attachmentField.id,
        attachmentNames,
      })

      await patchFields(token, {
        sheetId: sheet.id,
        viewId: gridView.id,
        recordId: imported.row.id,
        expectedVersion: afterAttachment.record.version,
        values: {
          [statusField.id]: 'Todo',
          [priorityField.id]: 'P1',
          [startField.id]: '2026-03-10',
          [endField.id]: '2026-03-11',
          [scoreField.id]: 95,
          ...fieldTypeSmokePatchValues(fieldTypeSmokeFields),
        },
      })
      await patchFields(token, {
        sheetId: sheet.id,
        viewId: gridView.id,
        recordId: retried.row.id,
        expectedVersion: retried.row.version,
        values: {
          [statusField.id]: 'Doing',
          [priorityField.id]: 'P2',
          [startField.id]: '2026-03-12',
          [endField.id]: '2026-03-13',
          [scoreField.id]: 10,
        },
      })
      trackRecord(await fetchRecord(token, sheet.id, imported.row.id).then((res) => res.record))
      trackRecord(await fetchRecord(token, sheet.id, retried.row.id).then((res) => res.record))

      await verifyGridHydration(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        searchValue: importedTitle,
        titleText: importedTitle,
        attachmentName: attachmentNames[0],
        personDisplay: personChoice.display || personChoice.id,
      })

      await verifyFieldTypesReloadReplay(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        recordId,
        titleText: importedTitle,
        specs: fieldTypeSmokeFields,
      })

      await verifyFilterBuilderTypedControlsReplay(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        statusFieldId: statusField.id,
        startFieldId: startField.id,
        scoreFieldId: scoreField.id,
        includedTitle: importedTitle,
        excludedTitle: retryTitle,
        startValue: '2026-03-10',
        scoreThreshold: 90,
      })

      await verifyConditionalFormattingReloadReplay(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        viewName: gridView.name,
        scoreFieldId: scoreField.id,
        includedTitle: importedTitle,
        scoreThreshold: 90,
      })

      await verifyFieldManagerPropReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        fieldId: attachmentField.id,
        fieldName: attachmentField.name,
        expectedMaxFiles: 8,
        expectedMimeType: 'text/plain',
      })

      const renamedTempFieldName = `Temp People ${titlePrefix}`
      await verifyFieldManagerTypeReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        fieldId: tempField.id,
        fieldName: tempField.name,
        renamedFieldName: renamedTempFieldName,
      })

      await verifyViewManagerPropReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        managedViewId: galleryView.id,
        managedViewName: galleryView.name,
        expectedColumns: 3,
        expectedCardSize: 'large',
      })

      await verifyViewManagerFieldSchemaReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        managedViewId: tempView.id,
        managedViewName: tempView.name,
        titleFieldId: titleField.id,
        originalTitleFieldName: titleField.name,
        renamedTitleFieldName: `Title Renamed ${titlePrefix}`,
        coverFieldId: attachmentField.id,
        coverFieldRestoreName: attachmentField.name,
        coverFieldRestoreProperty: {
          maxFiles: 7,
          acceptedMimeTypes: ['text/plain'],
        },
      })

      await verifyFieldManagerTargetRemoval(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        fieldId: tempField.id,
        fieldName: renamedTempFieldName,
      })

      await verifyViewManagerTargetRemoval(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        managedViewId: tempView.id,
        managedViewName: tempView.name,
      })

      await verifyGalleryConfigReplay(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: galleryView.id,
        expectedColumns: 4,
        expectedCardSize: 'small',
        expectedCoverFieldId: null,
        expectedVisibleFieldName: statusField.name,
        expectedHiddenFieldName: personField.name,
      })

      await verifyCalendarConfigReplay(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: calendarView.id,
        expectedMode: 'day',
      })

      await verifyTimelineConfigReplay(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: timelineView.id,
        expectedLabelFieldId: personField.id,
        expectedLabelFieldName: personField.name,
        expectedZoom: 'month',
      })

      await verifyKanbanConfigReplay(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: kanbanView.id,
        expectedGroupFieldId: priorityField.id,
        expectedGroupFieldName: priorityField.name,
      })
      await verifyKanbanEmptyCardFieldsReplay(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: kanbanView.id,
        expectedGroupFieldId: priorityField.id,
      })
      await verifyKanbanClearGroupReplay(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: kanbanView.id,
      })

      const embedHost = await verifyEmbedHostProtocol(page, {
        baseId: base.id,
        sheetId: sheet.id,
        initialViewId: gridView.id,
        targetViewId: galleryView.id,
      })
      const embedHostDirtyNavigation = await verifyEmbedHostDirtyFormNavigation(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        formViewId: formView.id,
        targetViewId: galleryView.id,
        recordId,
        titleFieldId: titleField.id,
        originalTitle: importedTitle,
      })
      const embedHostBusyDeferredNavigation = await verifyEmbedHostBusyDeferredNavigation(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        formViewId: formView.id,
        currentViewId: formView.id,
        deferredViewId: gridView.id,
        supersedingViewId: galleryView.id,
        recordId,
        titleFieldId: titleField.id,
        originalTitle: importedTitle,
      })

      await verifyAttachmentDeleteClear(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: formView.id,
        recordId,
        attachmentFieldName: attachmentField.name,
        attachmentFieldId: attachmentField.id,
        cleanupAttachmentIds: attachmentIds,
      })

      const afterClear = await fetchRecord(token, sheet.id, recordId)
      trackRecord(afterClear.record)
      const clearedAttachments = afterClear.attachmentSummaries?.[attachmentField.id] ?? []
      const clearedFieldValue = afterClear.record?.data?.[attachmentField.id] ?? []
      const clearedOk = clearedAttachments.length === 0 && (!Array.isArray(clearedFieldValue) || clearedFieldValue.length === 0)
      record('api.form.attachment-delete-clear', clearedOk, {
        recordId,
        fieldId: attachmentField.id,
        clearedAttachments: clearedAttachments.length,
      })
      if (!clearedOk) {
        throw new Error('Attachment clear did not persist after form lifecycle check')
      }

      await verifyConflictRecovery(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        recordId,
        titleFieldId: titleField.id,
        searchValue: importedTitle,
        originalTitle: importedTitle,
      })

      const finalRecord = await fetchRecord(token, sheet.id, recordId)
      trackRecord(finalRecord.record)

      const viewSubmit = await submitViewForm(token, formView.id, {
        [titleField.id]: viewSubmitTitle,
      })
      if (!viewSubmit?.record?.id) {
        throw new Error('View submit did not return a record')
      }
      cleanupRecords.set(viewSubmit.record.id, viewSubmit.record.version)
      record('api.multitable.view-submit', true, {
        viewId: formView.id,
        recordId: viewSubmit.record.id,
      })

      // ── Smoke: Attachment upload via API ──
      {
        let attachmentApiOk = false
        try {
          const uploadResult = await uploadAttachmentApi(token, {
            sheetId: sheet.id,
            recordId,
            fieldId: attachmentField.id,
          })
          attachmentApiOk = uploadResult.res?.ok && !!uploadResult.json?.data?.attachment?.id
          if (attachmentApiOk) {
            const uploadedId = uploadResult.json.data.attachment.id
            attachmentIds.add(uploadedId)
            record('smoke.attachment.upload-api', true, {
              recordId,
              attachmentId: uploadedId,
              filename: uploadResult.json.data.attachment.filename,
            })
          } else {
            record('smoke.attachment.upload-api', false, {
              recordId,
              status: uploadResult.res?.status,
              body: uploadResult.json,
            })
          }
        } catch (err) {
          record('smoke.attachment.upload-api', false, {
            recordId,
            error: err?.message || String(err),
          })
        }
      }

      // ── Smoke: Comment lifecycle ──
      {
        const commentContent = `smoke-comment-${Date.now()}`
        let commentCreated = false
        let commentId = null
        try {
          const createResult = await createCommentApi(token, {
            spreadsheetId: sheet.id,
            rowId: recordId,
            content: commentContent,
          })
          commentCreated = createResult.res?.ok && !!createResult.json?.data?.comment?.id
          record('smoke.comment.create', commentCreated, {
            recordId,
            content: commentContent,
            status: createResult.res?.status,
          })

          if (commentCreated) {
            commentId = createResult.json.data.comment.id

            const listResult = await listCommentsApi(token, sheet.id, recordId)
            const listed = listResult.json?.data?.items ?? []
            const found = listed.some((c) => c.id === commentId)
            record('smoke.comment.list', found, { commentId, total: listed.length })

            const resolveResult = await resolveCommentApi(token, commentId)
            const resolveOk = resolveResult.res?.status === 204 || resolveResult.res?.ok
            record('smoke.comment.resolve', !!resolveOk, { commentId, status: resolveResult.res?.status })
          }
        } catch (err) {
          record('smoke.comment.lifecycle', false, {
            recordId,
            error: err?.message || String(err),
          })
        } finally {
          if (commentId) {
            try {
              await deleteCommentApi(token, commentId)
            } catch (_) {
              // best-effort cleanup
            }
          }
        }
      }

      report.metadata = {
        baseId: base.id,
        sheetId: sheet.id,
        gridViewId: gridView.id,
        formViewId: formView.id,
        titleFieldId: titleField.id,
        attachmentFieldId: attachmentField.id,
        personFieldId: personField.id,
        personChoiceId: personChoice.id,
        primaryRecordId: recordId,
        retryRecordId: retried.row.id,
        manualFixRecordId: manualFixed.row.id,
        xlsxImportRecordId: xlsxImported.id,
        viewSubmitRecordId: viewSubmit.record.id,
        embedHostGeneratedRequestId: embedHost.generatedRequestId,
        embedHostExplicitRequestId: embedHost.explicitRequestId,
        embedHostBlockedRequestId: embedHostDirtyNavigation.blockedRequestId,
        embedHostConfirmedRequestId: embedHostDirtyNavigation.confirmRequestId,
        embedHostDeferredRequestId: embedHostBusyDeferredNavigation.deferredRequestId,
        embedHostSupersedingRequestId: embedHostBusyDeferredNavigation.supersedingRequestId,
      }
    } finally {
      await browser.close()
    }
  } finally {
    if (token) {
      for (const [recordId, expectedVersion] of cleanupRecords.entries()) {
        try {
          await deleteRecord(token, recordId, expectedVersion)
        } catch (err) {
          record('cleanup.record', false, { recordId, message: err?.message || String(err) })
        }
      }
      for (const attachmentId of attachmentIds) {
        try {
          await deleteAttachment(token, attachmentId)
        } catch (err) {
          record('cleanup.attachment', false, { attachmentId, message: err?.message || String(err) })
        }
      }
      for (const fieldId of cleanupFieldIds) {
        try {
          await deleteField(token, fieldId)
        } catch (err) {
          record('cleanup.field', false, { fieldId, message: err?.message || String(err) })
        }
      }
    }
  }
}

async function main() {
  try {
    await run()
    report.finishedAt = new Date().toISOString()
    writeSmokeArtifacts(report)
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
  } catch (err) {
    report.ok = false
    report.finishedAt = new Date().toISOString()
    report.error = err?.message || String(err)
    writeSmokeArtifacts(report)
    console.error(report.error)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
