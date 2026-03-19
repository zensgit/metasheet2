import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputDir = process.env.OUTPUT_DIR || 'artifacts/multitable-live-smoke'
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

async function createSheet(token, name) {
  const result = await fetchJson(`${apiBase}/api/multitable/sheets`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, description: 'Multitable smoke sheet' }),
  })
  const json = await ensureOk('api.multitable.create-sheet', result, { name })
  return json.data.sheet
}

async function fetchContext(token, query) {
  const result = await fetchJson(`${apiBase}/api/multitable/context?${new URLSearchParams(query).toString()}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.context', result, query)
  return json.data
}

async function fetchFields(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.fields', result, { sheetId })
  return Array.isArray(json?.data?.fields) ? json.data.fields : []
}

async function fetchViews(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/views?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.views', result, { sheetId })
  return Array.isArray(json?.data?.views) ? json.data.views : []
}

async function ensureAttachmentField(token, sheetId) {
  const fields = await fetchFields(token, sheetId)
  const existing = fields.find((field) => field.type === 'attachment')
  if (existing) return existing

  const result = await fetchJson(`${apiBase}/api/multitable/fields`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: 'fld_multitable_smoke_files',
      sheetId,
      name: 'Smoke Files',
      type: 'attachment',
    }),
  })
  const json = await ensureOk('api.multitable.create-attachment-field', result, { sheetId })
  return json.data.field
}

async function ensureFormView(token, sheetId) {
  const views = await fetchViews(token, sheetId)
  const existing = views.find((view) => view.type === 'form')
  if (existing) return existing

  const result = await fetchJson(`${apiBase}/api/multitable/views`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: 'view_multitable_smoke_form',
      sheetId,
      name: 'Smoke Form',
      type: 'form',
    }),
  })
  const json = await ensureOk('api.multitable.create-form-view', result, { sheetId })
  return json.data.view
}

async function fetchGridView(token, sheetId) {
  const views = await fetchViews(token, sheetId)
  const grid = views.find((view) => view.type === 'grid') || views[0]
  if (!grid) {
    throw new Error(`No view found for sheet ${sheetId}`)
  }
  return grid
}

async function createSmokeRecord(token, sheetId, fields) {
  const textField = fields.find((field) => field.type === 'string')
  if (!textField) throw new Error(`No string field found for sheet ${sheetId}`)

  const selectField = fields.find((field) => field.type === 'select' && Array.isArray(field.options) && field.options.length > 0)
  const nameValue = `Smoke ${Date.now()}`
  const data = {
    [textField.id]: nameValue,
  }
  if (selectField) {
    data[selectField.id] = selectField.options[0].value
  }

  const result = await fetchJson(`${apiBase}/api/multitable/records`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sheetId, data }),
  })
  const json = await ensureOk('api.multitable.create-record', result, { sheetId })
  return {
    recordId: json.data.record.id,
    version: json.data.record.version,
    nameValue,
    textFieldId: textField.id,
  }
}

async function fetchRecord(token, sheetId, recordId) {
  const result = await fetchJson(`${apiBase}/api/multitable/records/${encodeURIComponent(recordId)}?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.record', result, { sheetId, recordId })
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

async function openAndWait(page, url, markerText) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByText(markerText).first().waitFor({ state: 'visible', timeout: timeoutMs })
}

async function verifyGrid(page, baseId, sheetId, viewId, searchValue, attachmentName) {
  const url = `${webBase}/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}?baseId=${encodeURIComponent(baseId)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.fill(searchValue)
  await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByText(searchValue).first().waitFor({ state: 'visible', timeout: timeoutMs })
  await page.getByText(attachmentName).first().waitFor({ state: 'visible', timeout: timeoutMs })

  await page.screenshot({ path: path.join(outputDir, 'grid.png'), fullPage: true })
  record('ui.grid.search', true, { searchValue, attachmentName })
}

async function verifyFormUploadAndComments(page, baseId, sheetId, viewId, recordId, attachmentFieldName, attachmentName) {
  const url = `${webBase}/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}?baseId=${encodeURIComponent(baseId)}&mode=form&recordId=${encodeURIComponent(recordId)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
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

async function run() {
  fs.mkdirSync(outputDir, { recursive: true })

  let token = ''
  let createdRecordId = ''
  let createdRecordVersion
  let attachmentId = ''

  try {
    await fetchHealth()
    token = await getDevToken()

    const bases = await fetchBases(token)
    let base = bases.find((item) => item.id === 'base_legacy') || bases[0]

    if (!base) {
      const sheet = await createSheet(token, 'Smoke Sheet')
      base = { id: sheet.baseId, name: 'Migrated Base' }
    }

    const context = await fetchContext(token, { baseId: base.id })
    const sheetId = context.sheet.id
    const attachmentField = await ensureAttachmentField(token, sheetId)
    const formView = await ensureFormView(token, sheetId)
    const gridView = await fetchGridView(token, sheetId)
    const fields = await fetchFields(token, sheetId)

    const created = await createSmokeRecord(token, sheetId, fields)
    createdRecordId = created.recordId
    createdRecordVersion = created.version

    const attachmentName = `multitable-smoke-${Date.now()}.txt`

    const browser = await chromium.launch({ headless })
    const browserContext = await browser.newContext()
    await browserContext.addInitScript((authToken) => {
      localStorage.setItem('auth_token', authToken)
      localStorage.setItem('jwt', authToken)
    }, token)
    const page = await browserContext.newPage()

    try {
      await verifyFormUploadAndComments(
        page,
        base.id,
        sheetId,
        formView.id,
        created.recordId,
        attachmentField.name,
        attachmentName,
      )
      const recordData = await fetchRecord(token, sheetId, created.recordId)
      createdRecordVersion = recordData.record.version
      const hydrated = recordData.attachmentSummaries?.[attachmentField.id] ?? []
      attachmentId = hydrated[0]?.id || ''
      const hydratedOk = Array.isArray(hydrated) && hydrated.some((item) => item.filename === attachmentName)
      record('api.multitable.attachment-hydration', hydratedOk, {
        recordId: created.recordId,
        fieldId: attachmentField.id,
        attachmentId,
      })
      if (!hydratedOk || !attachmentId) {
        throw new Error('Attachment hydration missing from record response after UI upload')
      }
      await verifyGrid(page, base.id, sheetId, gridView.id, created.nameValue, attachmentName)
    } finally {
      await browser.close()
    }

    report.metadata = {
      baseId: base.id,
      sheetId,
      gridViewId: gridView.id,
      formViewId: formView.id,
      attachmentFieldId: attachmentField.id,
    }
  } finally {
    if (token && createdRecordId) {
      try {
        await deleteRecord(token, createdRecordId, createdRecordVersion)
      } catch (err) {
        record('cleanup.record', false, { recordId: createdRecordId, message: err?.message || String(err) })
      }
    }
    if (token && attachmentId) {
      try {
        await deleteAttachment(token, attachmentId)
      } catch (err) {
        record('cleanup.attachment', false, { attachmentId, message: err?.message || String(err) })
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
