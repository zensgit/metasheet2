#!/usr/bin/env node
'use strict'

// External-API read self-service — post-deploy E2E smoke (#1709).
//
// Executes the runbook chain (docs/development/integration-core-external-api-read-self-service-
// entity-e2e-runbook-20260702.md) against a DEPLOYED environment over HTTP:
//   status → resolve system → probe (bounded) → save(201) → save-again(200 reused) → audit →
//   approve → runtime read (data/evidence split) → smuggle negative (400) → retire → post-retire read (409).
//
// Values-free output discipline: this script prints ONLY statuses, booleans, counts, and coarse enum
// codes. It never prints the sample key, row values, field values, hostnames, readPath text, tokens,
// or raw response payloads. Default mode is list_page (key-less, fully automated); single_record
// requires --sample-key. Each run salts the fieldMap targets with a timestamp so the full
// draft→approved→retired lifecycle is exercised every run (S2-c fail-closes identical-content saves
// against retired rows by design).

import fs from 'node:fs'
import path from 'node:path'

const RESULT = { checks: [], summary: {} }

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    tenantId: '',
    workspaceId: '',
    systemId: '',
    systemKind: 'erp:k3-wise-webapi',
    mode: 'list_page',
    sampleKey: process.env.METASHEET_READ_SELFSERVICE_SAMPLE_KEY || '',
    readPath: '',
    object: 'material',
    containerPaths: 'Data.Data,Data.DATA',
    keyField: 'FNumber',
    timeoutMs: 15000,
    outDir: '',
  }
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--base-url') args.baseUrl = next()
    else if (flag === '--tenant-id') args.tenantId = next()
    else if (flag === '--workspace-id') args.workspaceId = next()
    else if (flag === '--system-id') args.systemId = next()
    else if (flag === '--system-kind') args.systemKind = next()
    else if (flag === '--mode') args.mode = next()
    else if (flag === '--sample-key') args.sampleKey = next()
    else if (flag === '--read-path') args.readPath = next()
    else if (flag === '--object') args.object = next()
    else if (flag === '--container-paths') args.containerPaths = next()
    else if (flag === '--key-field') args.keyField = next()
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next())
    else if (flag === '--out-dir') args.outDir = next()
    else throw new Error(`unknown flag: ${flag}`)
  }
  if (!args.baseUrl) throw new Error('--base-url is required')
  if (!['list_page', 'single_record'].includes(args.mode)) throw new Error('--mode must be list_page or single_record')
  if (args.mode === 'single_record' && !args.sampleKey) throw new Error('--sample-key is required for single_record mode')
  if (!args.readPath) {
    args.readPath = args.mode === 'list_page' ? '/K3API/Material/GetList' : '/K3API/Material/GetDetail'
  }
  return args
}

// Build the S1-shaped config for this run. Targets are salted per run so content-key differs run to run.
export function buildSmokeConfig({ systemId, systemKind, object, mode, readPath, keyField, containerPaths, salt }) {
  const config = {
    version: 1,
    systemId,
    requiredKind: systemKind,
    object,
    mode,
    readPath,
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: containerPaths.split(',').map((p) => p.trim()).filter(Boolean),
    fieldMap: [
      { source: 'FNumber', target: `smoke_a_${salt}` },
      { source: 'FName', target: `smoke_b_${salt}` },
    ],
  }
  if (mode === 'single_record') config.keyField = keyField
  return config
}

// Values-free leak scan: none of the given sentinel strings may appear in the serialized subject.
export function leakScan(subject, sentinels) {
  const text = JSON.stringify(subject)
  const leaks = []
  for (const sentinel of sentinels) {
    if (typeof sentinel === 'string' && sentinel.length > 0 && text.includes(sentinel)) leaks.push(true)
  }
  return leaks.length === 0
}

// Every data-plane record may carry ONLY the salted fieldMap targets.
export function recordsOnlyTargets(records, salt) {
  const allowed = new Set([`smoke_a_${salt}`, `smoke_b_${salt}`])
  return records.every((record) => record && typeof record === 'object'
    && Object.keys(record).every((key) => allowed.has(key)))
}

export function formatSummaryBlock(summary) {
  const lines = ['EXTERNAL_API_READ_SELF_SERVICE_POSTDEPLOY_SMOKE']
  for (const [key, value] of Object.entries(summary)) lines.push(`${key}=${value}`)
  return lines.join('\n')
}

function check(name, ok, detail = '') {
  RESULT.checks.push({ name, ok: ok === true, detail })
  const mark = ok === true ? 'ok' : 'FAIL'
  process.stderr.write(`[smoke] ${name}: ${mark}${detail ? ` (${detail})` : ''}\n`)
  return ok === true
}

async function requestJson(baseUrl, pathname, { token, timeoutMs, method = 'GET', body, accept = [200] } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const init = { method, headers, signal: controller.signal }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const response = await fetch(`${baseUrl}${pathname}`, init)
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: response.status, body: parsed, ok: accept.includes(response.status) }
  } finally {
    clearTimeout(timer)
  }
}

function scopeQuery(args) {
  const params = new URLSearchParams()
  if (args.tenantId) params.set('tenantId', args.tenantId)
  if (args.workspaceId) params.set('workspaceId', args.workspaceId)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

async function main() {
  const args = parseArgs(process.argv)
  const token = process.env.METASHEET_AUTH_TOKEN || ''
  const salt = `t${Math.floor(Date.now() / 1000)}`
  const scope = scopeQuery(args)
  const S = RESULT.summary
  S.mode = args.mode
  let failed = false
  const must = (name, ok, detail) => { if (!check(name, ok, detail)) failed = true }

  // 0. auth round-trip (deploy SOP: silent 401 usually = schema/token gap)
  const status = await requestJson(args.baseUrl, '/api/integration/status', { token, timeoutMs: args.timeoutMs })
  S.statusHttp = status.status
  must('status auth round-trip', status.ok, `http=${status.status}`)
  if (!status.ok) return finish(failed, args)

  // 1. resolve registered external system
  let systemId = args.systemId
  let systemKind = args.systemKind
  if (!systemId) {
    const list = await requestJson(args.baseUrl, `/api/integration/external-systems${scope}${scope ? '&' : '?'}kind=${encodeURIComponent(args.systemKind)}`, { token, timeoutMs: args.timeoutMs })
    const rows = Array.isArray(list.body?.data) ? list.body.data : (Array.isArray(list.body?.data?.items) ? list.body.data.items : [])
    const candidate = rows.find((row) => row && row.kind === args.systemKind) || rows[0]
    must('resolve external system', list.ok && Boolean(candidate && candidate.id), `http=${list.status} candidates=${rows.length}`)
    if (!candidate || !candidate.id) return finish(true, args)
    systemId = candidate.id
    systemKind = candidate.kind || args.systemKind
  }
  S.systemResolved = true
  S.systemKindMatched = systemKind === args.systemKind

  // Differential control: the SHIPPED C3 read-smoke preset against the same system rides the exact
  // same adapter outbound path (login/token + list read). If it fails alongside the self-service
  // probe, the failure is environment/K3-side, not this line.
  const control = await requestJson(args.baseUrl, `/api/integration/external-systems/${systemId}/read-smoke${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST',
    body: { presetId: 'k3wise.material-list.v1', intent: { object: 'material', mode: 'list' } },
  })
  const controlData = control.body?.data || {}
  S.readSmokeControlHttp = control.status
  S.readSmokeControlOk = controlData.ok === true
  S.readSmokeControlErrorCode = typeof controlData.errorCode === 'string' ? controlData.errorCode : ''
  S.readSmokeControlErrorType = typeof controlData.errorType === 'string' ? controlData.errorType : ''
  check('read-smoke differential control', S.readSmokeControlOk, `http=${control.status} errorCode=${S.readSmokeControlErrorCode || '-'}`)

  const config = buildSmokeConfig({
    systemId,
    systemKind,
    object: args.object,
    mode: args.mode,
    readPath: args.readPath,
    keyField: args.keyField,
    containerPaths: args.containerPaths,
    salt,
  })
  const inputs = args.mode === 'single_record' ? { key: args.sampleKey } : undefined
  const evidenceSentinels = [args.sampleKey, `smoke_a_${salt}`, `smoke_b_${salt}`, args.readPath]

  // 2. locate-container probe (bounded smoke ON — evidence must stay values-free)
  const probe = await requestJson(args.baseUrl, `/api/integration/external-systems/${systemId}/read-source-probe${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST',
    body: inputs ? { config, boundedSmoke: true, inputs } : { config, boundedSmoke: true },
  })
  const probeData = probe.body?.data || {}
  S.probeHttp = probe.status
  S.probeOk = probeData.ok === true
  S.containerLocated = probeData.containerLocated === true
  S.boundedSmokeExecuted = probeData.boundedSmokeExecuted === true
  S.probeRecordCount = Number.isInteger(probeData.recordCount) ? probeData.recordCount : 'absent'
  S.probeErrorCode = typeof probeData.errorCode === 'string' ? probeData.errorCode : ''
  S.probeErrorType = typeof probeData.errorType === 'string' ? probeData.errorType : ''
  S.probeEvidenceValuesFree = leakScan(probeData, evidenceSentinels)
  must('probe http 200', probe.ok, `http=${probe.status}`)
  must('probe ok + container located', S.probeOk && S.containerLocated, `errorCode=${S.probeErrorCode || '-'}`)
  must('probe bounded smoke executed', S.boundedSmokeExecuted)
  must('probe evidence values-free', S.probeEvidenceValuesFree)

  // 3. save version twice (content-keyed idempotency)
  const save1 = await requestJson(args.baseUrl, `/api/integration/read-source-configs${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: { config }, accept: [201],
  })
  const row1 = save1.body?.data || {}
  S.saveFirstHttp = save1.status
  S.saveFirstStatusName = row1.status || ''
  must('save #1 → 201 draft', save1.ok && row1.status === 'draft' && Boolean(row1.id), `http=${save1.status}`)
  if (!row1.id) return finish(true, args)
  const configId = row1.id

  const save2 = await requestJson(args.baseUrl, `/api/integration/read-source-configs${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: { config }, accept: [200],
  })
  const row2 = save2.body?.data || {}
  S.saveSecondHttp = save2.status
  S.saveSecondReused = row2.reused === true
  S.versionStable = row2.version === row1.version && row2.id === row1.id
  must('save #2 → 200 reused, version stable', save2.ok && S.saveSecondReused && S.versionStable, `http=${save2.status}`)

  // 4. audit trail is values-free and carries both actions
  const audit = await requestJson(args.baseUrl, `/api/integration/read-source-configs/${configId}/audit${scope}`, { token, timeoutMs: args.timeoutMs })
  const auditRows = Array.isArray(audit.body?.data) ? audit.body.data : (Array.isArray(audit.body?.data?.items) ? audit.body.data.items : [])
  const actions = new Set(auditRows.map((row) => row && row.action))
  S.auditActionsPresent = actions.has('save_version') && actions.has('reuse_version')
  S.auditValuesFree = leakScan(auditRows, evidenceSentinels)
  must('audit actions save_version+reuse_version', audit.ok && S.auditActionsPresent, `http=${audit.status} rows=${auditRows.length}`)
  must('audit values-free', S.auditValuesFree)

  // 5. approve
  const approve = await requestJson(args.baseUrl, `/api/integration/read-source-configs/${configId}/approve${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: {},
  })
  S.approveHttp = approve.status
  S.approvedStatusName = approve.body?.data?.status || ''
  must('approve → 200 approved', approve.ok && S.approvedStatusName === 'approved', `http=${approve.status}`)

  // 6. runtime read (data plane = salted targets only; evidence values-free)
  const read = await requestJson(args.baseUrl, `/api/integration/read-source-configs/${configId}/read${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: inputs ? { inputs } : {},
  })
  const readData = read.body?.data || {}
  const evidence = readData.evidence || {}
  const dataPlane = readData.data || null
  const records = dataPlane?.containers?.primary?.records || []
  S.runtimeHttp = read.status
  S.runtimeEvidenceOk = evidence.ok === true
  S.runtimeErrorCode = typeof evidence.errorCode === 'string' ? evidence.errorCode : ''
  S.runtimeErrorType = typeof evidence.errorType === 'string' ? evidence.errorType : ''
  S.runtimeDataPresent = dataPlane !== null
  S.runtimeRecordCount = Number.isInteger(dataPlane?.recordCount) ? dataPlane.recordCount : 'absent'
  S.runtimeDataOnlyFieldMapTargets = recordsOnlyTargets(records, salt)
  // evidence must not carry the key, target names, readPath, or any actual data-plane value
  const valueSentinels = records.length > 0 ? Object.values(records[0]).filter((v) => typeof v === 'string' && v.length > 2) : []
  S.runtimeEvidenceValuesFree = leakScan(evidence, [...evidenceSentinels, ...valueSentinels])
  must('runtime read http 200', read.ok, `http=${read.status}`)
  must('runtime evidence ok', S.runtimeEvidenceOk, `errorCode=${S.runtimeErrorCode || '-'}`)
  must('runtime data plane present', S.runtimeDataPresent)
  must('runtime data only fieldMap targets', S.runtimeDataOnlyFieldMapTargets)
  must('runtime evidence values-free (incl. actual values)', S.runtimeEvidenceValuesFree)

  // 7. smuggle negative control: extra config key can never ride in
  const smuggle = await requestJson(args.baseUrl, `/api/integration/read-source-configs/${configId}/read${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST',
    body: { ...(inputs ? { inputs } : {}), config: { readPath: 'https://evil.example.invalid/path' } },
    accept: [400],
  })
  S.smuggleHttp = smuggle.status
  S.smuggleCode = smuggle.body?.error?.code || ''
  S.smuggleEchoFree = leakScan(smuggle.body || {}, ['evil.example.invalid'])
  must('smuggle → 400 contract invalid', smuggle.ok && S.smuggleCode === 'READ_SOURCE_READ_CONTRACT_INVALID', `http=${smuggle.status} code=${S.smuggleCode || '-'}`)
  must('smuggle response echo-free', S.smuggleEchoFree)

  // 8. retire, then post-retire runtime read fail-closes
  const retire = await requestJson(args.baseUrl, `/api/integration/read-source-configs/${configId}/retire${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: {},
  })
  S.retireHttp = retire.status
  must('retire → 200 retired', retire.ok && retire.body?.data?.status === 'retired', `http=${retire.status}`)

  const postRetire = await requestJson(args.baseUrl, `/api/integration/read-source-configs/${configId}/read${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: inputs ? { inputs } : {}, accept: [409],
  })
  S.postRetireHttp = postRetire.status
  S.postRetireCode = postRetire.body?.error?.code || ''
  must('post-retire read → 409 not approved', postRetire.ok && S.postRetireCode === 'READ_SOURCE_CONFIG_NOT_APPROVED', `http=${postRetire.status} code=${S.postRetireCode || '-'}`)

  return finish(failed, args)
}

function finish(failed, args) {
  const S = RESULT.summary
  S.writeExecuted = false
  S.resolverLookupExecuted = false
  S.pass = !failed && RESULT.checks.every((c) => c.ok)
  const block = formatSummaryBlock(S)
  process.stdout.write(`${block}\n`)
  if (args.outDir) {
    fs.mkdirSync(args.outDir, { recursive: true })
    fs.writeFileSync(path.join(args.outDir, 'summary.txt'), `${block}\n`)
    fs.writeFileSync(path.join(args.outDir, 'checks.json'), JSON.stringify(RESULT.checks, null, 2))
  }
  process.exitCode = S.pass ? 0 : 1
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[smoke] fatal: ${error && error.name ? error.name : 'Error'}\n`)
    RESULT.summary.pass = false
    RESULT.summary.fatal = true
    process.stdout.write(`${formatSummaryBlock(RESULT.summary)}\n`)
    process.exitCode = 1
  })
}
