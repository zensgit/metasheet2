import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/multitable-live-smoke'
const reportPath = process.env.REPORT_JSON || path.join(outputDir, 'report.json')
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.TIMEOUT_MS || 30000)

const report = {
  ok: true,
  apiBase,
  webBase,
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

async function getDevToken() {
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
  const url = `${apiBase}/api/auth/dev-token?userId=dev-admin&roles=admin&perms=${encodeURIComponent(perms)}`
  const result = await fetchJson(url)
  const token = result.json?.token || ''
  record('api.dev-token', Boolean(result.res.ok && token), { status: result.res.status })
  if (!result.res.ok || !token) {
    throw new Error('Dev token unavailable')
  }
  return token
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

async function ensurePilotFields(token, sheetId) {
  const titleField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_title' || (field.name === 'Title' && field.type === 'string'),
    { id: 'fld_pilot_title', sheetId, name: 'Title', type: 'string' },
  )

  const attachmentField = await ensureField(
    token,
    sheetId,
    (field) => field.id === 'fld_pilot_files' || (field.name === 'Files' && field.type === 'attachment'),
    { id: 'fld_pilot_files', sheetId, name: 'Files', type: 'attachment' },
  )

  const fields = await fetchFields(token, sheetId)
  const existingPersonField = fields.find((field) =>
    field.id === 'fld_pilot_owner' ||
    (field.name === 'Owner' && field.type === 'link' && field.property?.refKind === 'user'),
  )
  if (existingPersonField) {
    return { titleField, attachmentField, personField: existingPersonField }
  }

  const preset = await preparePersonField(token, sheetId)
  const personField = await createField(token, {
    id: 'fld_pilot_owner',
    sheetId,
    name: 'Owner',
    type: 'link',
    property: preset.fieldProperty,
  })

  return { titleField, attachmentField, personField }
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

function multitableUrl(baseId, sheetId, viewId, extra = {}) {
  const query = new URLSearchParams({ baseId, ...extra })
  return `${webBase}/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}?${query.toString()}`
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
  await page.getByRole('button', { name: /Import 1 record\(s\)/ }).click()
  await page.getByText('1 record(s) imported').waitFor({ state: 'visible', timeout: timeoutMs })

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: searchValue }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'grid-import.png'), fullPage: true })
  record('ui.grid.import', true, { searchValue })
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
  let failedRetryRowOnce = false
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
    if (shouldFailRetryRow && !failedRetryRowOnce) {
      failedRetryRowOnce = true
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
    await page.getByRole('button', { name: /Import 2 record\(s\)/ }).click()
    await page.getByRole('button', { name: 'Retry failed rows' }).waitFor({ state: 'visible', timeout: timeoutMs })
    if (!failedRetryRowOnce) {
      throw new Error(`Import retry interception did not trigger. Observed titles: ${JSON.stringify(Array.from(observedImportTitles))}`)
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
  })
}

async function importRecordViaGridWithPeopleManualFix(page, {
  baseId,
  sheetId,
  viewId,
  csvPath,
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
  await page.getByRole('button', { name: /Import 1 record\(s\)/ }).click()
  await page.locator('.meta-import__fixes').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: /Select person|Select people/ }).click()
  await page.locator('.meta-link-picker').waitFor({ state: 'visible', timeout: timeoutMs })

  const pickerSearch = page.locator('.meta-link-picker__input')
  await pickerSearch.fill(personDisplay)
  await page.waitForTimeout(400)
  await page.locator('.meta-link-picker__item').filter({ hasText: personDisplay }).first().click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.locator('.meta-import__fix-selected').getByText(personDisplay).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Apply fixes and retry' }).click()
  await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(importedRowTitle)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: importedRowTitle }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'grid-import-people-manual-fix.png'), fullPage: true })
  record('ui.import.people-manual-fix', true, {
    baseId,
    sheetId,
    viewId,
    importedRowTitle,
    personDisplay,
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
  await page.waitForFunction(({ selector, targetValue }) => {
    const element = document.querySelector(selector)
    return element instanceof HTMLSelectElement && element.value === targetValue
  }, { selector: '.meta-import__field-select', targetValue: fieldId }, { timeout: timeoutMs })

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

  await page.locator('.meta-import__close').click()
  await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })
}

async function verifyPeopleRepairReconcile(page, {
  token,
  baseId,
  sheetId,
  viewId,
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
  await page.getByRole('button', { name: /Import 1 record\(s\)/ }).click()
  await page.locator('.meta-import__fixes').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: /Select person|Select people/ }).click()
  await page.locator('.meta-link-picker').waitFor({ state: 'visible', timeout: timeoutMs })

  const pickerSearch = page.locator('.meta-link-picker__input')
  await pickerSearch.fill(personDisplay)
  await page.waitForTimeout(400)
  await page.locator('.meta-link-picker__item').filter({ hasText: personDisplay }).first().click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.locator('.meta-import__fix-selected').getByText(personDisplay).waitFor({ state: 'visible', timeout: timeoutMs })

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

  const pickerButtonsAfterReconcile = await page.getByRole('button', { name: /Select person|Select people/ }).count()
  const applyDisabledAfterReconcile = await applyButton.isDisabled()
  await applyButton.click()
  await page.locator('.meta-import-overlay').waitFor({ state: 'hidden', timeout: timeoutMs })

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(importedRowTitle)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: importedRowTitle }).first().waitFor({ state: 'visible', timeout: timeoutMs })

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
  const pickerSearch = page.locator('.meta-link-picker__input')
  await pickerSearch.fill(personDisplay)
  await page.waitForTimeout(400)
  await page.locator('.meta-link-picker__item').filter({ hasText: personDisplay }).first().click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.locator('.meta-record-drawer__link-summary').getByText(personDisplay).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByText('Linked records updated').waitFor({ state: 'visible', timeout: timeoutMs })
  record('ui.person.assign', true, { personDisplay })
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
  const attachmentField = page.locator('.meta-form-view__field').filter({ hasText: attachmentFieldName }).first()
  await attachmentField.locator('input[type="file"]').setInputFiles(uploadPath)
  await attachmentField.getByText('Uploading...').waitFor({ state: 'visible', timeout: timeoutMs })
  await attachmentField.getByText('Uploading...').waitFor({ state: 'hidden', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('Changes saved').first().waitFor({ state: 'visible', timeout: timeoutMs })

  const commentsButton = page.getByRole('button', { name: '💬' })
  await commentsButton.click()
  await page.getByRole('heading', { name: 'Comments' }).waitFor({ state: 'visible', timeout: timeoutMs })
  const commentText = `smoke comment ${Date.now()}`
  const commentBox = page.getByRole('textbox', { name: 'Add a comment...' })
  await commentBox.fill(commentText)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText(commentText).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Resolve' }).click()
  await page.locator('.meta-comments-drawer__badge').getByText('Resolved', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })

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

  const attachmentField = page.locator('.meta-form-view__field').filter({ hasText: attachmentFieldName }).first()
  await attachmentField.locator('input[type="file"]').setInputFiles(uploads)
  await attachmentField.getByText('Uploading...').waitFor({ state: 'visible', timeout: timeoutMs })
  await attachmentField.getByText('Uploading...').waitFor({ state: 'hidden', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('Changes saved').first().waitFor({ state: 'visible', timeout: timeoutMs })

  const afterUpload = await fetchRecord(token, sheetId, recordId)
  const uploadedAttachments = afterUpload.attachmentSummaries?.[attachmentFieldId] ?? []
  if (uploadedAttachments.length !== attachmentNames.length) {
    record('api.form.attachment-upload', false, {
      recordId,
      fieldId: attachmentFieldId,
      expected: attachmentNames.length,
      actual: uploadedAttachments.length,
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

  const commentsButton = page.getByRole('button', { name: '💬' })
  await commentsButton.click()
  await page.getByRole('heading', { name: 'Comments' }).waitFor({ state: 'visible', timeout: timeoutMs })
  const commentText = `smoke comment ${Date.now()}`
  const commentBox = page.getByRole('textbox', { name: 'Add a comment...' })
  await commentBox.fill(commentText)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText(commentText).waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByRole('button', { name: 'Resolve' }).click()
  await page.locator('.meta-comments-drawer__badge').getByText('Resolved', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })

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

  const attachmentField = page.locator('.meta-form-view__field').filter({ hasText: attachmentFieldName }).first()
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

  await updateField(token, fieldId, {
    property: {
      maxFiles: expectedMaxFiles,
      acceptedMimeTypes: [expectedMimeType],
    },
  })

  const warning = page.locator('.meta-field-mgr__warning')
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  const closeDialogMessage = await dismissDialogAfterClick(page, async () => {
    await page.locator('.meta-field-mgr__close').click()
  })
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'field-manager-prop-reconcile.png'), fullPage: true })
  await warning.getByRole('button', { name: 'Reload latest' }).click()
  await warning.waitFor({ state: 'hidden', timeout: timeoutMs })

  const maxFilesValue = await maxFilesInput.inputValue()
  const acceptedMimeTypesValue = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Accepted mime types' }).locator('input').inputValue()
  const ok = closeDialogMessage === 'Discard unsaved field manager changes?'
    && maxFilesValue === String(expectedMaxFiles)
    && acceptedMimeTypesValue === expectedMimeType
  record('ui.field-manager.prop-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
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
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  const closeDialogMessage = await dismissDialogAfterClick(page, async () => {
    await page.locator('.meta-view-mgr__close').click()
  })
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'view-manager-prop-reconcile.png'), fullPage: true })
  await warning.getByRole('button', { name: 'Reload latest' }).click()
  await warning.waitFor({ state: 'hidden', timeout: timeoutMs })

  const columnsValue = await columnsInput.inputValue()
  const cardSizeValue = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Card size' }).locator('select').inputValue()
  const ok = closeDialogMessage === 'Discard unsaved view manager changes?'
    && columnsValue === String(expectedColumns)
    && cardSizeValue === expectedCardSize
  record('ui.view-manager.prop-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    managedViewId,
    closeDialogMessage,
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

  await updateField(token, fieldId, {
    name: renamedFieldName,
    type: 'link',
    property: {
      refKind: 'user',
      limitSingleRecord: false,
    },
  })

  const warning = page.locator('.meta-field-mgr__warning')
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, 'field-manager-type-reconcile.png'), fullPage: true })

  const headerText = (await page.locator('.meta-field-mgr__config-header strong').textContent())?.trim() ?? ''
  const configTypeBeforeReload = (await page.locator('.meta-field-mgr__config-header span').textContent())?.trim() ?? ''
  const warningText = (await warning.textContent())?.trim() ?? ''
  const saveButton = page.locator('.meta-field-mgr__config-actions .meta-field-mgr__btn-add').filter({ hasText: 'Save field settings' })
  const saveDisabledBeforeReload = await saveButton.isDisabled()
  const maxFilesVisibleBeforeReload = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).count()

  await warning.getByRole('button', { name: 'Reload latest' }).click()
  await warning.waitFor({ state: 'hidden', timeout: timeoutMs })

  const configTypeAfterReload = (await page.locator('.meta-field-mgr__config-header span').textContent())?.trim() ?? ''
  const personHintVisible = await page.locator('.meta-field-mgr__hint').filter({ hasText: 'People fields use the system people sheet preset' }).count()
  const maxFilesVisibleAfterReload = await page.locator('.meta-field-mgr__field').filter({ hasText: 'Max files' }).count()
  const saveDisabledAfterReload = await saveButton.isDisabled()
  const ok = headerText.includes(renamedFieldName)
    && configTypeBeforeReload === 'attachment'
    && warningText.includes('changed type in the background')
    && saveDisabledBeforeReload
    && maxFilesVisibleBeforeReload === 1
    && configTypeAfterReload === 'person'
    && personHintVisible === 1
    && maxFilesVisibleAfterReload === 0
    && !saveDisabledAfterReload
  record('ui.field-manager.type-reconcile', ok, {
    baseId,
    sheetId,
    viewId,
    fieldId,
    fieldName: renamedFieldName,
    configTypeBeforeReload,
    configTypeAfterReload,
    warningText,
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
  await warning.waitFor({ state: 'visible', timeout: timeoutMs })
  const titleOptions = await page.locator('.meta-view-mgr__field').filter({ hasText: 'Title field' }).locator('option').allTextContents()

  await updateField(token, coverFieldId, {
    name: `${coverFieldRestoreName} (Archived)`,
    type: 'string',
    property: {},
  })

  const typedWarning = page.locator('.meta-view-mgr__warning').filter({
    hasText: 'cover field is no longer an attachment field',
  })
  await typedWarning.waitFor({ state: 'visible', timeout: timeoutMs })

  await page.screenshot({ path: path.join(outputDir, 'view-manager-field-schema-reconcile.png'), fullPage: true })

  const saveButton = page.locator('.meta-view-mgr__config-actions .meta-view-mgr__btn-add').filter({ hasText: 'Save view settings' })
  const warningText = (await warning.textContent())?.trim() ?? ''
  const saveDisabledBeforeReload = await saveButton.isDisabled()

  await warning.getByRole('button', { name: 'Reload latest' }).click()
  await warning.waitFor({ state: 'hidden', timeout: timeoutMs })

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

  const ok = titleOptions.includes(renamedTitleFieldName)
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
    token = await getDevToken()

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
    const peopleOptions = await fetchLinkOptions(token, personField.id, { limit: 20 })
    const personChoice = Array.isArray(peopleOptions?.records) ? peopleOptions.records[0] : null
    if (!personChoice?.id) {
      throw new Error('No selectable person record available for person preset smoke')
    }

    const titlePrefix = `PilotFlow-${Date.now()}`
    const importedTitle = `${titlePrefix} imported`
    const retryTitle = `${titlePrefix} retry`
    const peopleRepairReconcileTitle = `${titlePrefix} people repair reconcile`
    const manualFixTitle = `${titlePrefix} manual fix`
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
        fieldId: tempPeopleRepairField.id,
        fieldName: tempPeopleRepairField.name,
        renamedFieldName: `${tempPeopleRepairField.name} Text`,
        importedRowTitle: peopleRepairReconcileTitle,
        personDisplay: personChoice.display || personChoice.id,
      })

      await importRecordViaGridWithPeopleManualFix(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        csvPath: manualFixCsvPath,
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
      let recordId = imported.row.id
      const trackRecord = (record) => {
        if (record?.id) cleanupRecords.set(record.id, record.version)
      }

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

      await verifyFieldManagerPropReconcile(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        fieldId: attachmentField.id,
        fieldName: attachmentField.name,
        expectedMaxFiles: 7,
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
        viewSubmitRecordId: viewSubmit.record.id,
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

run()
  .then(() => {
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exit(1)
  })
  .catch((err) => {
    report.ok = false
    report.finishedAt = new Date().toISOString()
    report.error = err?.message || String(err)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.error(report.error)
    process.exit(1)
  })
