#!/usr/bin/env node

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:7778'
const now = new Date().toISOString().replace(/[-:.TZ]/g, '')
const foreignSheetId = `lookup_foreign_${now}`
const sourceSheetId = `lookup_source_${now}`
const result = {
  apiBase: API_BASE,
  foreignSheetId,
  sourceSheetId,
  foreignFields: {},
  sourceFields: {},
  foreignRecords: [],
  sourceRecordId: null,
  checks: [],
}

let authToken = ''

const request = async (method, path, body) => {
  const url = `${API_BASE}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  const options = { method, headers }
  if (body) options.body = JSON.stringify(body)
  const res = await fetch(url, options)
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json?.ok === false) {
    const msg = json?.error?.message || `HTTP ${res.status}`
    const err = new Error(`${method} ${path} failed: ${msg}`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

const post = (path, body) => request('POST', path, body)
const get = (path) => request('GET', path)

const assert = (condition, message, extra) => {
  if (!condition) {
    const err = new Error(message)
    err.extra = extra
    throw err
  }
  result.checks.push({ ok: true, message })
}

const findRecord = (view, recordId) => view?.data?.rows?.find((r) => r.id === recordId)

const run = async () => {
  const tokenRes = await fetch(`${API_BASE}/api/auth/dev-token`)
  const tokenJson = await tokenRes.json().catch(() => ({}))
  if (!tokenRes.ok || !tokenJson?.token) {
    throw new Error(`Failed to fetch dev token: ${tokenJson?.error ?? tokenRes.status}`)
  }
  authToken = tokenJson.token

  await post('/api/univer-meta/sheets', {
    id: foreignSheetId,
    name: 'Lookup Foreign Demo',
    seed: false,
  })
  await post('/api/univer-meta/sheets', {
    id: sourceSheetId,
    name: 'Lookup Source Demo',
    seed: false,
  })

  const foreignNameFieldId = `fld_foreign_name_${now}`
  const foreignAmountFieldId = `fld_foreign_amount_${now}`

  await post('/api/univer-meta/fields', {
    id: foreignNameFieldId,
    sheetId: foreignSheetId,
    name: '名称',
    type: 'string',
  })
  await post('/api/univer-meta/fields', {
    id: foreignAmountFieldId,
    sheetId: foreignSheetId,
    name: '金额',
    type: 'number',
  })

  result.foreignFields = {
    name: foreignNameFieldId,
    amount: foreignAmountFieldId,
  }

  const foreignRecordA = await post('/api/univer-meta/records', {
    sheetId: foreignSheetId,
    data: {
      [foreignNameFieldId]: '部件A',
      [foreignAmountFieldId]: 100,
    },
  })
  const foreignRecordB = await post('/api/univer-meta/records', {
    sheetId: foreignSheetId,
    data: {
      [foreignNameFieldId]: '部件B',
      [foreignAmountFieldId]: 200,
    },
  })

  const foreignIdA = foreignRecordA.data.record.id
  const foreignIdB = foreignRecordB.data.record.id
  result.foreignRecords = [foreignIdA, foreignIdB]

  const sourceNameFieldId = `fld_source_name_${now}`
  const sourceLinkFieldId = `fld_source_link_${now}`
  const sourceLookupFieldId = `fld_source_lookup_${now}`
  const sourceRollupFieldId = `fld_source_rollup_${now}`

  await post('/api/univer-meta/fields', {
    id: sourceNameFieldId,
    sheetId: sourceSheetId,
    name: '订单',
    type: 'string',
  })
  await post('/api/univer-meta/fields', {
    id: sourceLinkFieldId,
    sheetId: sourceSheetId,
    name: '关联部件',
    type: 'link',
    property: {
      foreignSheetId,
      limitSingleRecord: false,
    },
  })
  await post('/api/univer-meta/fields', {
    id: sourceLookupFieldId,
    sheetId: sourceSheetId,
    name: '部件名称',
    type: 'lookup',
    property: {
      relatedLinkFieldId: sourceLinkFieldId,
      lookupTargetFieldId: foreignNameFieldId,
    },
  })
  await post('/api/univer-meta/fields', {
    id: sourceRollupFieldId,
    sheetId: sourceSheetId,
    name: '金额合计',
    type: 'rollup',
    property: {
      linkedFieldId: sourceLinkFieldId,
      targetFieldId: foreignAmountFieldId,
      aggregation: 'sum',
    },
  })

  result.sourceFields = {
    name: sourceNameFieldId,
    link: sourceLinkFieldId,
    lookup: sourceLookupFieldId,
    rollup: sourceRollupFieldId,
  }

  const sourceRecord = await post('/api/univer-meta/records', {
    sheetId: sourceSheetId,
    data: {
      [sourceNameFieldId]: '订单-001',
      [sourceLinkFieldId]: [foreignIdA, foreignIdB],
    },
  })
  result.sourceRecordId = sourceRecord.data.record.id

  const viewBefore = await get(`/api/univer-meta/view?sheetId=${sourceSheetId}`)
  const rowBefore = findRecord(viewBefore, result.sourceRecordId)
  assert(rowBefore, 'source record exists after creation')
  const lookupBefore = rowBefore.data[sourceLookupFieldId]
  const rollupBefore = rowBefore.data[sourceRollupFieldId]
  assert(Array.isArray(lookupBefore), 'lookup field returns array', { lookupBefore })
  assert(
    lookupBefore.includes('部件A') && lookupBefore.includes('部件B'),
    'lookup values include foreign names',
    { lookupBefore },
  )
  assert(Number(rollupBefore) === 300, 'rollup sum equals 300 before update', { rollupBefore })

  const patchRes = await post('/api/univer-meta/patch', {
    sheetId: foreignSheetId,
    changes: [
      {
        recordId: foreignIdA,
        fieldId: foreignAmountFieldId,
        value: 300,
        expectedVersion: foreignRecordA.data.record.version,
      },
    ],
  })

  const related = patchRes?.data?.relatedRecords || []
  const relatedForSource = related.find((r) => r.sheetId === sourceSheetId)
  assert(relatedForSource, 'patch returns relatedRecords for source sheet', { related })
  const relatedRollup = relatedForSource?.data?.[sourceRollupFieldId]
  assert(Number(relatedRollup) === 500, 'related rollup equals 500 after update', { relatedRollup })

  const viewAfter = await get(`/api/univer-meta/view?sheetId=${sourceSheetId}`)
  const rowAfter = findRecord(viewAfter, result.sourceRecordId)
  assert(rowAfter, 'source record exists after foreign update')
  const rollupAfter = rowAfter.data[sourceRollupFieldId]
  assert(Number(rollupAfter) === 500, 'rollup sum equals 500 after update', { rollupAfter })

  return result
}

run()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2))
  })
  .catch((err) => {
    console.error(err)
    if (err.extra) {
      console.error('Extra:', JSON.stringify(err.extra, null, 2))
    }
    process.exit(1)
  })
