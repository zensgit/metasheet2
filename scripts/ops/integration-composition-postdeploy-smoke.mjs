#!/usr/bin/env node
'use strict'

// Read-source resolver composition — post-deploy E2E smoke (#1709 composition line).
//
// Exercises the read-only material→FItemID→FBOMNumber two-hop chain against a DEPLOYED environment
// over HTTP: save read config #1 (draft)→approve → save read config #2 (draft)→approve → save
// composition (draft) → NEGATIVE run before approve (409) → approve composition → run (200, evidence
// + coarse chain outcome) → NEGATIVE config-override run (400) → retire → NEGATIVE post-retire run (409).
//
// Mirrors scripts/ops/integration-read-selfservice-postdeploy-smoke.mjs idiom-for-idiom (arg parsing,
// requestJson helper, values-free evidence collection, summary JSON, PASS/FAIL exit).
//
// Values-free output discipline: this script prints ONLY statuses, booleans, counts, and coarse enum
// codes. It never prints the sample key, resolved values, row content, read paths, hostnames, or tokens.
// A chain that fail-closes with a coarse code (e.g. NO_MATCH on the sample key) is still a PASS of the
// PLATFORM chain — only HTTP/contract failures are smoke FAIL (recorded separately as `runChainOutcome`).

import fs from 'node:fs'
import path from 'node:path'

const RESULT = { checks: [], summary: {} }

// Fixed handoff wiring (matches the design-lock fixture — plugins/plugin-integration-core/__tests__/
// read-source-composition-runtime.test.cjs): step 1 resolves the intermediate scalar under this exact
// target name, step 2 consumes it as `key` and resolves the final scalar under this exact target name.
// These are NOT salted — the composition's step-to-step handoff wiring is fixed platform structure, not
// per-run smoke scratch data.
const INTERMEDIATE_TARGET = 'internal_id'
const FINAL_TARGET = 'bom_number'
const SYSTEM_KIND = 'erp:k3-wise-webapi'

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    tenantId: '',
    workspaceId: '',
    systemId: '',
    sampleKey: process.env.METASHEET_COMPOSITION_SMOKE_SAMPLE_KEY || '',
    step1ReadPath: '/K3API/Material/GetList',
    step1KeyField: 'FNumber',
    step1Source: 'FItemID',
    step1Object: 'material',
    step2ReadPath: '/K3API/BOM/GetList',
    step2KeyField: 'FItemId',
    step2Source: 'FBOMNumber',
    step2Object: 'bom',
    containerPaths: 'Data.Rows',
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
    else if (flag === '--sample-key') args.sampleKey = next()
    else if (flag === '--step1-read-path') args.step1ReadPath = next()
    else if (flag === '--step1-key-field') args.step1KeyField = next()
    else if (flag === '--step1-source') args.step1Source = next()
    else if (flag === '--step1-object') args.step1Object = next()
    else if (flag === '--step2-read-path') args.step2ReadPath = next()
    else if (flag === '--step2-key-field') args.step2KeyField = next()
    else if (flag === '--step2-source') args.step2Source = next()
    else if (flag === '--step2-object') args.step2Object = next()
    else if (flag === '--container-paths') args.containerPaths = next()
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next())
    else if (flag === '--out-dir') args.outDir = next()
    else throw new Error(`unknown flag: ${flag}`)
  }
  if (!args.baseUrl) throw new Error('--base-url is required')
  if (!args.systemId) throw new Error('--system-id is required')
  // Every step of this lifecycle (including the before-approve negative run) submits { inputs: { key } },
  // so the sample key is required unconditionally, not only for the final positive-run step.
  if (!args.sampleKey) throw new Error('--sample-key is required')
  return args
}

// Build the S1-shaped resolver_lookup read config for one hop.
export function buildStepReadConfig({ systemId, object, readPath, keyField, containerPaths, source, target }) {
  return {
    version: 1,
    systemId,
    requiredKind: SYSTEM_KIND,
    object,
    mode: 'resolver_lookup',
    readPath,
    readMethod: 'POST',
    operations: ['read'],
    keyField,
    containerPaths: containerPaths.split(',').map((p) => p.trim()).filter(Boolean),
    resolverRule: 'exactly_one',
    fieldMap: [{ source, target }],
  }
}

// Build the C-R1-shaped composition config. `name` is salted per run so a fresh draft→approved→retired
// lifecycle is exercised every run (a stable name would collide with a PRIOR run's retired content —
// re-saving retired content is a 409 CONFLICT, not a fresh 201 — see read-source-composition-config-
// store.cjs reuseExisting()). The handoff target names stay fixed (see header comment).
export function buildCompositionConfig({ step1ConfigId, step2ConfigId, salt }) {
  return {
    version: 1,
    name: `composition-smoke-${salt}`,
    operations: ['read'],
    steps: [
      { id: 'resolve-item', readSourceConfigId: step1ConfigId },
      { id: 'resolve-bom', readSourceConfigId: step2ConfigId, input: { fromStep: 'resolve-item', sourceTarget: INTERMEDIATE_TARGET, toInput: 'key' } },
    ],
  }
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

export function formatSummaryBlock(summary) {
  const lines = ['READ_SOURCE_COMPOSITION_POSTDEPLOY_SMOKE']
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

// Save a hop's read config and ensure it is approved. Tolerant of idempotent reuse: since the hop
// configs are NOT salted (their K3 defaults are stable, real business wiring, not scratch data), a
// re-run of this smoke against the same system will legitimately reuse an ALREADY-APPROVED row (200,
// not 201) — approving an already-approved row would 409 CONFLICT, so approve is only attempted when
// the returned status is 'draft'.
async function saveAndApproveReadConfig(baseUrl, scope, token, timeoutMs, config, label, S, must) {
  const save = await requestJson(baseUrl, `/api/integration/read-source-configs${scope}`, {
    token, timeoutMs, method: 'POST', body: { config }, accept: [200, 201],
  })
  const row = save.body?.data || {}
  S[`${label}SaveHttp`] = save.status
  S[`${label}SaveStatusName`] = row.status || ''
  must(`${label} save http 200/201`, save.ok && Boolean(row.id), `http=${save.status}`)
  if (!row.id) return null
  const configId = row.id
  if (row.status === 'draft') {
    const approve = await requestJson(baseUrl, `/api/integration/read-source-configs/${configId}/approve${scope}`, {
      token, timeoutMs, method: 'POST', body: {},
    })
    S[`${label}ApproveHttp`] = approve.status
    S[`${label}ApprovedStatusName`] = approve.body?.data?.status || ''
    must(`${label} approve → 200 approved`, approve.ok && S[`${label}ApprovedStatusName`] === 'approved', `http=${approve.status}`)
  } else {
    S[`${label}ApproveHttp`] = 'skipped_already_approved'
    S[`${label}ApprovedStatusName`] = row.status
    must(`${label} reused config already approved`, row.status === 'approved', `status=${row.status}`)
  }
  return configId
}

async function main() {
  const args = parseArgs(process.argv)
  const token = process.env.METASHEET_AUTH_TOKEN || ''
  const salt = `t${Math.floor(Date.now() / 1000)}`
  const scope = scopeQuery(args)
  const S = RESULT.summary
  let failed = false
  const must = (name, ok, detail) => { if (!check(name, ok, detail)) failed = true }
  const evidenceSentinels = [args.sampleKey, args.step1ReadPath, args.step2ReadPath]

  // 0. auth round-trip (deploy SOP: silent 401 usually = schema/token gap) — mirrors the read
  // self-service smoke's preliminary gate.
  const status = await requestJson(args.baseUrl, '/api/integration/status', { token, timeoutMs: args.timeoutMs })
  S.statusHttp = status.status
  must('status auth round-trip', status.ok, `http=${status.status}`)
  if (!status.ok) return finish(failed, args)

  // 1. hop 1 read config: material → FItemID (resolver output target: internal_id)
  const step1Config = buildStepReadConfig({
    systemId: args.systemId, object: args.step1Object, readPath: args.step1ReadPath,
    keyField: args.step1KeyField, containerPaths: args.containerPaths,
    source: args.step1Source, target: INTERMEDIATE_TARGET,
  })
  const step1ConfigId = await saveAndApproveReadConfig(args.baseUrl, scope, token, args.timeoutMs, step1Config, 'step1', S, must)
  if (!step1ConfigId) return finish(true, args)

  // 2. hop 2 read config: bom (keyed by the hop-1 output) → FBOMNumber (resolver output target: bom_number)
  const step2Config = buildStepReadConfig({
    systemId: args.systemId, object: args.step2Object, readPath: args.step2ReadPath,
    keyField: args.step2KeyField, containerPaths: args.containerPaths,
    source: args.step2Source, target: FINAL_TARGET,
  })
  const step2ConfigId = await saveAndApproveReadConfig(args.baseUrl, scope, token, args.timeoutMs, step2Config, 'step2', S, must)
  if (!step2ConfigId) return finish(true, args)

  // 3. composition config referencing both approved hops (draft; fresh every run via salted name)
  const compositionConfig = buildCompositionConfig({ step1ConfigId, step2ConfigId, salt })
  const saveComp = await requestJson(args.baseUrl, `/api/integration/read-source-compositions${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: { config: compositionConfig }, accept: [200, 201],
  })
  const compRow = saveComp.body?.data || {}
  S.compositionSaveHttp = saveComp.status
  S.compositionSaveStatusName = compRow.status || ''
  must('composition save http 200/201', saveComp.ok && Boolean(compRow.id), `http=${saveComp.status}`)
  must('composition save status draft', compRow.status === 'draft', `status=${compRow.status || '-'}`)
  if (!compRow.id) return finish(true, args)
  const compositionId = compRow.id

  // 4. NEGATIVE: run before approve → 409 NOT_APPROVED
  const preApproveRun = await requestJson(args.baseUrl, `/api/integration/read-source-compositions/${compositionId}/run${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: { inputs: { key: args.sampleKey } }, accept: [409],
  })
  S.preApproveRunHttp = preApproveRun.status
  S.preApproveRunCode = preApproveRun.body?.error?.code || ''
  must('pre-approve run → 409 not approved', preApproveRun.ok && S.preApproveRunCode === 'READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', `http=${preApproveRun.status} code=${S.preApproveRunCode || '-'}`)
  must('pre-approve run response values-free', leakScan(preApproveRun.body || {}, evidenceSentinels))

  // 5. approve composition
  const approveComp = await requestJson(args.baseUrl, `/api/integration/read-source-compositions/${compositionId}/approve${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: {},
  })
  S.compositionApproveHttp = approveComp.status
  S.compositionApprovedStatusName = approveComp.body?.data?.status || ''
  must('composition approve → 200 approved', approveComp.ok && S.compositionApprovedStatusName === 'approved', `http=${approveComp.status}`)

  // 6. runtime run — HTTP 200 is the only hard bar; a coarse fail-closed chain outcome (e.g. NO_MATCH on
  // the sample key) is a legitimate PLATFORM pass, recorded separately as chainOutcome, never asserted.
  const run = await requestJson(args.baseUrl, `/api/integration/read-source-compositions/${compositionId}/run${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: { inputs: { key: args.sampleKey } },
  })
  const runData = run.body?.data || {}
  const evidence = runData.evidence || {}
  const dataPlane = runData.data || null
  S.runHttp = run.status
  must('run http 200', run.ok, `http=${run.status}`)
  const evidenceShapeValid = typeof evidence.ok === 'boolean' && Array.isArray(evidence.steps)
  must('run evidence shape valid', evidenceShapeValid, `keys=${Object.keys(evidence).length}`)
  S.runEvidenceOk = evidence.ok === true
  S.runFailedStep = (evidence.failedStep === undefined || evidence.failedStep === null) ? 'null' : evidence.failedStep
  S.runStepsVector = evidenceShapeValid
    ? JSON.stringify(evidence.steps.map((s) => ({ step: s.step, ok: s.ok === true, rule: s.rule || '', errorCode: s.errorCode || '' })))
    : '[]'
  S.runErrorCode = typeof evidence.errorCode === 'string' ? evidence.errorCode : ''
  S.runDataResolved = dataPlane !== null && dataPlane !== undefined
  S.runDataTarget = (dataPlane && dataPlane.resolver && typeof dataPlane.resolver.target === 'string') ? dataPlane.resolver.target : ''
  S.runChainOutcome = S.runEvidenceOk ? 'resolved' : 'fail_closed'
  const resolvedValueSentinel = (dataPlane && dataPlane.resolver && typeof dataPlane.resolver.value === 'string') ? [dataPlane.resolver.value] : []
  must('run evidence values-free', leakScan(evidence, [...evidenceSentinels, ...resolvedValueSentinel]))

  // 7. NEGATIVE: config-override body → 400 RUN_CONTRACT_INVALID
  const overrideRun = await requestJson(args.baseUrl, `/api/integration/read-source-compositions/${compositionId}/run${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST',
    body: { inputs: { key: args.sampleKey }, config: {} }, accept: [400],
  })
  S.overrideRunHttp = overrideRun.status
  S.overrideRunCode = overrideRun.body?.error?.code || ''
  must('override run → 400 contract invalid', overrideRun.ok && S.overrideRunCode === 'READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID', `http=${overrideRun.status} code=${S.overrideRunCode || '-'}`)
  must('override run response values-free', leakScan(overrideRun.body || {}, evidenceSentinels))

  // 8. retire, then post-retire run fail-closes
  const retire = await requestJson(args.baseUrl, `/api/integration/read-source-compositions/${compositionId}/retire${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: {},
  })
  S.retireHttp = retire.status
  S.retiredStatusName = retire.body?.data?.status || ''
  must('retire → 200 retired', retire.ok && S.retiredStatusName === 'retired', `http=${retire.status}`)

  const postRetireRun = await requestJson(args.baseUrl, `/api/integration/read-source-compositions/${compositionId}/run${scope}`, {
    token, timeoutMs: args.timeoutMs, method: 'POST', body: { inputs: { key: args.sampleKey } }, accept: [409],
  })
  S.postRetireRunHttp = postRetireRun.status
  S.postRetireRunCode = postRetireRun.body?.error?.code || ''
  must('post-retire run → 409 not approved', postRetireRun.ok && S.postRetireRunCode === 'READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', `http=${postRetireRun.status} code=${S.postRetireRunCode || '-'}`)
  must('post-retire run response values-free', leakScan(postRetireRun.body || {}, evidenceSentinels))

  return finish(failed, args)
}

function finish(failed, args) {
  const S = RESULT.summary
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
