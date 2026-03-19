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

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) report.ok = false
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

async function ensureView(token, sheetId, { id, type, name }) {
  const views = await fetchViews(token, sheetId)
  const existing = views.find((view) => view.id === id || (view.type === type && view.name === name))
  if (existing) return existing
  return createView(token, { id, sheetId, type, name })
}

async function ensurePilotViews(token, sheetId) {
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
  return { gridView, formView }
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

async function importRecordViaGrid(page, { baseId, sheetId, viewId, csvPath, searchValue }) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
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

async function verifyGridHydration(page, { baseId, sheetId, viewId, searchValue, titleText, attachmentName, personDisplay }) {
  await page.goto(multitableUrl(baseId, sheetId, viewId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator('.meta-grid__row').filter({ hasText: titleText }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByText(attachmentName).first().waitFor({ state: 'visible', timeout: timeoutMs })
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

async function run() {
  fs.mkdirSync(outputDir, { recursive: true })

  let token = ''
  let recordId = ''
  let recordVersion
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
    const { gridView, formView } = await ensurePilotViews(token, sheet.id)
    const peopleOptions = await fetchLinkOptions(token, personField.id, { limit: 20 })
    const personChoice = Array.isArray(peopleOptions?.records) ? peopleOptions.records[0] : null
    if (!personChoice?.id) {
      throw new Error('No selectable person record available for person preset smoke')
    }

    const titlePrefix = `PilotFlow-${Date.now()}`
    const importedTitle = `${titlePrefix} imported`
    const csvPath = path.join(outputDir, 'pilot-import.csv')
    fs.writeFileSync(csvPath, `Title\n${importedTitle}\n`)
    const attachmentName = `pilot-attachment-${Date.now()}.txt`

    const browser = await chromium.launch({ headless })
    const browserContext = await browser.newContext()
    await browserContext.addInitScript((authToken) => {
      localStorage.setItem('auth_token', authToken)
      localStorage.setItem('jwt', authToken)
    }, token)
    const page = await browserContext.newPage()

    try {
      await importRecordViaGrid(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        csvPath,
        searchValue: titlePrefix,
      })

      const imported = await findRecordBySearch(token, sheet.id, gridView.id, titlePrefix)
      if (!imported.row?.id) {
        throw new Error('Imported record not found via API search')
      }
      recordId = imported.row.id
      recordVersion = imported.row.version

      await assignPersonViaDrawer(page, {
        searchValue: titlePrefix,
        personFieldName: personField.name,
        personDisplay: personChoice.display || personChoice.id,
      })

      const afterPerson = await fetchRecord(token, sheet.id, recordId)
      recordVersion = afterPerson.record.version
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

      await verifyFormUploadAndComments(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: formView.id,
        recordId,
        attachmentFieldName: attachmentField.name,
        attachmentName,
      })

      const afterAttachment = await fetchRecord(token, sheet.id, recordId)
      recordVersion = afterAttachment.record.version
      const hydratedAttachments = afterAttachment.attachmentSummaries?.[attachmentField.id] ?? []
      const attachment = hydratedAttachments.find((item) => item.filename === attachmentName)
      if (!attachment?.id) {
        record('api.multitable.attachment-hydration', false, {
          recordId,
          fieldId: attachmentField.id,
          attachmentName,
        })
        throw new Error('Attachment hydration missing from record response after UI upload')
      }
      attachmentIds.add(attachment.id)
      record('api.multitable.attachment-hydration', true, {
        recordId,
        fieldId: attachmentField.id,
        attachmentId: attachment.id,
      })

      await verifyGridHydration(page, {
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        searchValue: titlePrefix,
        titleText: importedTitle,
        attachmentName,
        personDisplay: personChoice.display || personChoice.id,
      })

      await verifyConflictRecovery(page, {
        token,
        baseId: base.id,
        sheetId: sheet.id,
        viewId: gridView.id,
        recordId,
        titleFieldId: titleField.id,
        searchValue: titlePrefix,
        originalTitle: importedTitle,
      })

      const finalRecord = await fetchRecord(token, sheet.id, recordId)
      recordVersion = finalRecord.record.version

      report.metadata = {
        baseId: base.id,
        sheetId: sheet.id,
        gridViewId: gridView.id,
        formViewId: formView.id,
        titleFieldId: titleField.id,
        attachmentFieldId: attachmentField.id,
        personFieldId: personField.id,
        personChoiceId: personChoice.id,
        recordId,
      }
    } finally {
      await browser.close()
    }
  } finally {
    if (token && recordId) {
      try {
        await deleteRecord(token, recordId, recordVersion)
      } catch (err) {
        record('cleanup.record', false, { recordId, message: err?.message || String(err) })
      }
    }
    if (token) {
      for (const attachmentId of attachmentIds) {
        try {
          await deleteAttachment(token, attachmentId)
        } catch (err) {
          record('cleanup.attachment', false, { attachmentId, message: err?.message || String(err) })
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
