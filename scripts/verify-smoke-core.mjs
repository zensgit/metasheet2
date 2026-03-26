import fs from 'fs'
import path from 'path'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputPath = process.env.OUTPUT_PATH || 'artifacts/smoke/smoke-report.json'

const report = {
  ok: true,
  apiBase,
  webBase,
  checks: [],
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) {
    report.ok = false
  }
}

function withTimeout(timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson(url, options = {}) {
  const timeout = withTimeout()
  try {
    const res = await fetch(url, { ...options, signal: timeout.signal })
    const json = await res.json().catch(() => ({}))
    return { res, json }
  } finally {
    timeout.clear()
  }
}

async function fetchJsonWithRetry(url, options = {}, { attempts = 20, delayMs = 1000 } = {}) {
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fetchJson(url, options)
      last = result
      if (result.res.ok && result.json?.ok) return result
      const isDbNotReady = result.res.status === 503 && result.json?.error?.code === 'DB_NOT_READY'
      if (!isDbNotReady) return result
    } catch (err) {
      last = {
        res: { ok: false, status: 0 },
        json: { error: { code: 'FETCH_ERROR', message: err?.message || String(err) } },
      }
    }
    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }
  return last ?? { res: { ok: false, status: 0 }, json: {} }
}

async function fetchText(url) {
  const timeout = withTimeout()
  try {
    const res = await fetch(url, { signal: timeout.signal })
    const text = await res.text().catch(() => '')
    return { res, text }
  } finally {
    timeout.clear()
  }
}

async function run() {
  const health = await fetchJson(`${apiBase}/health`)
  record('api.health', health.res.ok, { status: health.res.status, body: health.json })
  if (!health.res.ok) {
    throw new Error('API health check failed')
  }

  const tokenRes = await fetchJson(`${apiBase}/api/auth/dev-token`)
  const token = tokenRes.json?.token
  record('api.dev-token', Boolean(tokenRes.res.ok && token), { status: tokenRes.res.status })
  if (!tokenRes.res.ok || !token) {
    throw new Error('Dev token unavailable')
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const multitableBases = await fetchJsonWithRetry(`${apiBase}/api/multitable/bases`, { headers })
  const basesOk = Boolean(multitableBases.res.ok && Array.isArray(multitableBases.json?.data?.bases))
  record('api.multitable.bases', basesOk, { status: multitableBases.res.status })
  if (!basesOk) {
    throw new Error('Multitable bases check failed')
  }

  const smokeStamp = Date.now().toString(36)
  const createBase = await fetchJson(`${apiBase}/api/multitable/bases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `Smoke Base ${smokeStamp}` }),
  })
  const smokeBase = createBase.json?.data?.base
  const createBaseOk = Boolean(createBase.res.ok && smokeBase?.id)
  record('api.multitable.create-base', createBaseOk, { status: createBase.res.status })
  if (!createBaseOk) {
    throw new Error('Multitable create base check failed')
  }

  const createSheet = await fetchJson(`${apiBase}/api/multitable/sheets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `Smoke Sheet ${smokeStamp}`,
      baseId: smokeBase.id,
      seed: true,
    }),
  })
  const smokeSheet = createSheet.json?.data?.sheet
  const createSheetOk = Boolean(createSheet.res.ok && smokeSheet?.id)
  record('api.multitable.create-sheet', createSheetOk, { status: createSheet.res.status })
  if (!createSheetOk) {
    throw new Error('Multitable create sheet check failed')
  }

  const smokeSheetId = smokeSheet.id

  const multitableViews = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/views?sheetId=${encodeURIComponent(smokeSheetId)}`,
    { headers },
  )
  const viewsData = multitableViews.json?.data?.views
  const multitableViewsOk = Boolean(multitableViews.res.ok && Array.isArray(viewsData) && viewsData.length > 0)
  record('api.multitable.views', multitableViewsOk, {
    status: multitableViews.res.status,
    viewCount: Array.isArray(viewsData) ? viewsData.length : 0,
  })
  if (!multitableViewsOk) {
    throw new Error('Multitable views check failed')
  }

  const multitableView = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/view?sheetId=${encodeURIComponent(smokeSheetId)}`,
    { headers },
  )
  const viewData = multitableView.json?.data ?? {}
  const viewOk = Boolean(
    multitableView.res.ok
      && Array.isArray(viewData.fields)
      && viewData.fields.length > 0
      && Array.isArray(viewData.rows)
      && viewData.rows.length > 0
      && (!viewData.view || viewData.view.sheetId === smokeSheetId),
  )
  record('api.multitable.view', viewOk, {
    status: multitableView.res.status,
    fieldCount: Array.isArray(viewData.fields) ? viewData.fields.length : 0,
    rowCount: Array.isArray(viewData.rows) ? viewData.rows.length : 0,
  })
  if (!viewOk) {
    throw new Error('Multitable view check failed')
  }

  const multitableFormContext = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/form-context?sheetId=${encodeURIComponent(smokeSheetId)}`,
    { headers },
  )
  const formContextData = multitableFormContext.json?.data ?? {}
  const formContextOk = Boolean(
    multitableFormContext.res.ok
      && formContextData.mode === 'form'
      && formContextData.sheet?.id === smokeSheetId
      && Array.isArray(formContextData.fields)
      && formContextData.fields.length > 0,
  )
  record('api.multitable.form-context', formContextOk, {
    status: multitableFormContext.res.status,
    fieldCount: Array.isArray(formContextData.fields) ? formContextData.fields.length : 0,
  })
  if (!formContextOk) {
    throw new Error('Multitable form context check failed')
  }

  const multitableRecordsSummary = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/records-summary?sheetId=${encodeURIComponent(smokeSheetId)}`,
    { headers },
  )
  const recordsSummaryData = multitableRecordsSummary.json?.data ?? {}
  const recordsSummaryOk = Boolean(
    multitableRecordsSummary.res.ok
      && Array.isArray(recordsSummaryData.records)
      && recordsSummaryData.displayMap
      && typeof recordsSummaryData.displayMap === 'object'
      && recordsSummaryData.page
      && typeof recordsSummaryData.page === 'object',
  )
  record('api.multitable.records-summary', recordsSummaryOk, {
    status: multitableRecordsSummary.res.status,
    recordCount: Array.isArray(recordsSummaryData.records) ? recordsSummaryData.records.length : 0,
  })
  if (!recordsSummaryOk) {
    throw new Error('Multitable records summary check failed')
  }

  const preparePersonFields = await fetchJson(`${apiBase}/api/multitable/person-fields/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sheetId: smokeSheetId }),
  })
  const prepareData = preparePersonFields.json?.data ?? {}
  const prepareOk = Boolean(
    preparePersonFields.res.ok
      && prepareData.targetSheet?.id
      && prepareData.targetSheet?.baseId === smokeBase.id
      && prepareData.fieldProperty
      && prepareData.fieldProperty.foreignSheetId === prepareData.targetSheet.id,
  )
  record('api.multitable.person-fields.prepare', prepareOk, {
    status: preparePersonFields.res.status,
    targetSheetId: prepareData.targetSheet?.id,
  })
  if (!prepareOk) {
    throw new Error('Multitable person fields prepare check failed')
  }

  const multitableContext = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/context?baseId=${encodeURIComponent(smokeBase.id)}&sheetId=${encodeURIComponent(smokeSheet.id)}`,
    { headers },
  )
  const contextData = multitableContext.json?.data ?? {}
  const contextOk = Boolean(
    multitableContext.res.ok
      && contextData.sheet?.id === smokeSheet.id
      && Array.isArray(contextData.sheets)
      && contextData.sheets.some((sheet) => sheet?.id === smokeSheet.id),
  )
  record('api.multitable.context', contextOk, { status: multitableContext.res.status })
  if (!contextOk) {
    throw new Error('Multitable context check failed')
  }

  const multitableFields = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/fields?sheetId=${encodeURIComponent(smokeSheet.id)}`,
    { headers },
  )
  const fieldsData = multitableFields.json?.data?.fields
  const multitableFieldsOk = Boolean(multitableFields.res.ok && Array.isArray(fieldsData) && fieldsData.length > 0)
  record('api.multitable.fields', multitableFieldsOk, { status: multitableFields.res.status, fieldCount: Array.isArray(fieldsData) ? fieldsData.length : 0 })
  if (!multitableFieldsOk) {
    throw new Error('Multitable fields check failed')
  }

  const titleField = Array.isArray(fieldsData)
    ? fieldsData.find((field) => ['string', 'formula', 'lookup'].includes(field?.type))
    : null

  const createView = await fetchJson(`${apiBase}/api/multitable/views`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sheetId: smokeSheet.id,
      name: `Smoke Gallery ${smokeStamp}`,
      type: 'gallery',
    }),
  })
  const smokeView = createView.json?.data?.view
  const createViewOk = Boolean(createView.res.ok && smokeView?.id)
  record('api.multitable.create-view', createViewOk, {
    status: createView.res.status,
    viewId: smokeView?.id,
  })
  if (!createViewOk) {
    throw new Error('Multitable create view check failed')
  }

  const smokeGalleryConfig = {
    titleFieldId: titleField?.id ?? null,
    coverFieldId: null,
    fieldIds: [],
    columns: 4,
    cardSize: 'large',
  }

  const updateView = await fetchJson(`${apiBase}/api/multitable/views/${encodeURIComponent(smokeView.id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      config: smokeGalleryConfig,
    }),
  })
  const updatedView = updateView.json?.data?.view
  const updateViewOk = Boolean(
    updateView.res.ok
      && updatedView?.id === smokeView.id
      && updatedView?.config?.columns === 4
      && updatedView?.config?.cardSize === 'large',
  )
  record('api.multitable.update-view-config', updateViewOk, {
    status: updateView.res.status,
    viewId: updatedView?.id,
  })
  if (!updateViewOk) {
    throw new Error('Multitable update view config check failed')
  }

  const persistedViews = await fetchJsonWithRetry(
    `${apiBase}/api/multitable/views?sheetId=${encodeURIComponent(smokeSheet.id)}`,
    { headers },
  )
  const persistedView = Array.isArray(persistedViews.json?.data?.views)
    ? persistedViews.json.data.views.find((view) => view?.id === smokeView.id)
    : null
  const persistedViewOk = Boolean(
    persistedViews.res.ok
      && persistedView
      && persistedView.config?.columns === 4
      && persistedView.config?.cardSize === 'large'
      && ((titleField?.id && persistedView.config?.titleFieldId === titleField.id) || (!titleField?.id && persistedView.config?.titleFieldId == null)),
  )
  record('api.multitable.view-config-persisted', persistedViewOk, {
    status: persistedViews.res.status,
    viewId: persistedView?.id,
  })
  if (!persistedViewOk) {
    throw new Error('Multitable view config persistence check failed')
  }

  const metaSheets = await fetchJsonWithRetry(`${apiBase}/api/univer-meta/sheets`, { headers })
  const sheetsOk = Boolean(metaSheets.res.ok && metaSheets.json?.ok)
  record('api.univer-meta.sheets', sheetsOk, { status: metaSheets.res.status, body: metaSheets.json })
  if (!sheetsOk) {
    throw new Error('Meta sheets check failed')
  }
  const sheets = Array.isArray(metaSheets.json?.data?.sheets) ? metaSheets.json.data.sheets : []

  const metaFields = await fetchJsonWithRetry(`${apiBase}/api/univer-meta/fields`, { headers })
  const fieldsOk = Boolean(metaFields.res.ok && metaFields.json?.ok)
  record('api.univer-meta.fields', fieldsOk, { status: metaFields.res.status, body: metaFields.json })
  if (!fieldsOk) {
    throw new Error('Meta fields check failed')
  }

  const metaViews = await fetchJsonWithRetry(`${apiBase}/api/univer-meta/views`, { headers })
  const viewsOk = Boolean(metaViews.res.ok && metaViews.json?.ok)
  record('api.univer-meta.views', viewsOk, { status: metaViews.res.status, body: metaViews.json })
  if (!viewsOk) {
    throw new Error('Meta views check failed')
  }

  const sheetId = sheets[0]?.id
  if (sheetId) {
    const metaRecords = await fetchJsonWithRetry(
      `${apiBase}/api/univer-meta/records-summary?sheetId=${encodeURIComponent(sheetId)}`,
      { headers },
    )
    const recordsOk = Boolean(metaRecords.res.ok && metaRecords.json?.ok)
    record('api.univer-meta.records-summary', recordsOk, { status: metaRecords.res.status })
    if (!recordsOk) {
      throw new Error('Meta records summary check failed')
    }
  } else {
    record('api.univer-meta.records-summary', true, { skipped: true })
  }

  record('api.spreadsheets', true, { skipped: true })

  if (process.env.SMOKE_SKIP_WEB === 'true') {
    record('web.home', true, { skipped: true })
  } else {
    const webRes = await fetchText(`${webBase}/`)
    const hasMetaSheet = /metasheet/i.test(webRes.text)
    const hasAppRoot = /id=["']app["']/.test(webRes.text)
    const webOk = webRes.res.ok && (hasMetaSheet || hasAppRoot)
    record('web.home', webOk, { status: webRes.res.status })
    if (!webOk) {
      throw new Error('Web home check failed')
    }
  }

  return report
}

run()
  .then((result) => {
    const dir = path.dirname(outputPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) {
      process.exit(1)
    }
  })
  .catch((err) => {
    const dir = path.dirname(outputPath)
    fs.mkdirSync(dir, { recursive: true })
    const errorReport = { ...report, ok: false, error: err.message || String(err) }
    fs.writeFileSync(outputPath, JSON.stringify(errorReport, null, 2))
    console.error(err.message || err)
    process.exit(1)
  })
