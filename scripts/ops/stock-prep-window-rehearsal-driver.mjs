#!/usr/bin/env node
// STAGING WINDOW REHEARSAL DRIVER (owner authorization 2026-08-05: 「授权 staging 部署」).
//
// Mechanizes the entity-machine window runbook's six steps against a REAL deployed server over
// HTTP — the same routes, same auth, same C6 token lifecycle the customer window will use. The
// far end of the K3 wire is the in-repo mock server (run-mock-k3-server.mjs); everything between
// the HTTP client and that wire is the deployed package, unmodified.
//
// mock pass != staging rehearsal pass != customer live pass — three layers, each honest.
//
// Env (all required):
//   BASE_URL      deployed server origin (e.g. http://127.0.0.1:<port>)
//   TOKEN         Bearer token of an integration-write principal (obtained via login, never minted)
//   MOCK_K3_URL   the mock K3 base url
//   TENANT_ID     tenant for the rehearsal systems/pipeline
//
// VALUES-FREE OUTPUT: closed tokens, counts, PASS/FAIL per step, one summary JSON. The material
// keys used here are synthetic fixture constants (MAT-RH-*), not customer values.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Owner review fix (point B, 2026-08-05): the read-smoke route (plugins/plugin-integration-core/
// lib/http-routes.cjs externalSystemReadSmoke, ~line 2731/2733) returns HTTP 200 on BOTH business
// success and business failure — the evidence body's own `ok` field is the only real success
// signal, and the row-count field name must be read from the SAME module the route uses, not
// assumed. Requiring it directly (not re-implementing a guess) is what lets this driver derive
// the real LIST success-shape keys at runtime below.
const { getReadSmokePreset, readSmokeSuccessEvidence } = require('../../plugins/plugin-integration-core/lib/read-smoke.cjs')

const { buildK3WiseMaterialListB4Config } = require('../../plugins/plugin-integration-core/lib/read-source-k3-material-list-b4-contract.cjs')

const BASE_URL = required('BASE_URL')
const TOKEN = required('TOKEN')
const MOCK_K3_URL = required('MOCK_K3_URL')
const TENANT_ID = required('TENANT_ID')

const PROFILE_ID = 'material-k3wise-customer-profile-v1'
const LIST_PRESET = 'k3wise.material-list.v1'
const DETAIL_PRESET = 'k3wise.material-detail.v1'
const SOURCE_KEYS = ['MAT-RH-001', 'MAT-RH-002'] // seeded by run-mock-k3-server.mjs
const NEVER_SAVED_KEY = 'MAT-RH-NEVER'
const FETCH_TIMEOUT_MS = 15000

function required(name) {
  const v = process.env[name]
  if (typeof v !== 'string' || v.trim() === '') {
    console.error(`rehearsal driver: env ${name} is required`)
    process.exit(2)
  }
  return v.trim()
}

const summary = { steps: [], pass: false }

function record(step, pass, evidence) {
  summary.steps.push({ step, pass, ...evidence })
  console.log(`${pass ? '✓' : '✗'} ${step} ${JSON.stringify(evidence)}`)
  if (!pass) {
    summary.pass = false
    console.log('REHEARSAL_SUMMARY=' + JSON.stringify(summary))
    process.exit(1)
  }
}

// Point D: every outbound call is bounded — a hung deployed server or mock must FAIL the step,
// never hang the rehearsal indefinitely. AbortSignal.timeout throws a TimeoutError/AbortError,
// which is folded into a synthetic { status: 0, timeout: true, data: null } result. Every
// downstream assertion below is a POSITIVE check on real field values (never a bare `!ok(...)`),
// so a timeout's null data fails those checks the same way a bad response would — no separate
// early-exit branch needed to make a timeout register as FAIL.
async function call(method, path, body) {
  let res
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        // The login token carries no tenant claim; jwt-middleware copies this header into
        // user.tenantId, which is what resolveAuthUserTenantId (write paths) exclusively trusts.
        'x-tenant-id': TENANT_ID,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      status: 0,
      data: null,
      timeout: timedOut,
      networkError: timedOut ? null : String(error && error.message ? error.message : error),
    }
  }
  let data = null
  try { data = await res.json() } catch { /* non-JSON is handled by callers via status */ }
  return { status: res.status, data, timeout: false, networkError: null }
}

function ok(res) { return res.status >= 200 && res.status < 300 }
function payload(res) { return res.data && (res.data.data !== undefined ? res.data.data : res.data) }
function timedOut(res) { return res.timeout === true }

// ---------------------------------------------------------------------------------------------
// Step 0 — the two rehearsal systems (source = K3 list read; target = profile-armed K3 write).
// Both point at the SAME mock K3. Separate systems keep the source read-config and the armed
// write-config independently reviewable, like the customer setup will be.
// ---------------------------------------------------------------------------------------------

const sourceSystem = await call('POST', '/api/integration/external-systems', {
  tenantId: TENANT_ID,
  name: 'Rehearsal K3 source (list read)',
  kind: 'erp:k3-wise-webapi',
  role: 'source',
  status: 'active',
  config: {
    baseUrl: MOCK_K3_URL,
    autoSubmit: false,
    autoAudit: false,
    objects: {
      material: {
        operations: ['read'],
        readPath: '/K3API/Material/GetList',
        readMethod: 'POST',
        readMode: 'list',
        readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
        readListBodyKey: 'Data',
        readListFields: ['FItemID', 'FNumber', 'FName', 'FModel', 'FUnitID'],
        readListOrderBy: 'FNumber',
        topField: 'Top',
        pageIndexField: 'PageIndex',
        pageSizeField: 'PageSize',
        maxListLimit: 10,
      },
    },
  },
  credentials: { username: 'rehearsal', password: 'rehearsal', acctId: 'RH' },
})
record('create-source-system', ok(sourceSystem) && Boolean(payload(sourceSystem)?.id), {
  status: sourceSystem.status,
  timeout: timedOut(sourceSystem),
})
const sourceSystemId = payload(sourceSystem).id

const targetSystem = await call('POST', '/api/integration/external-systems', {
  tenantId: TENANT_ID,
  name: 'Rehearsal K3 target (profile-armed)',
  kind: 'erp:k3-wise-webapi',
  role: 'target',
  status: 'active',
  config: {
    baseUrl: MOCK_K3_URL,
    autoSubmit: false,
    autoAudit: false,
    objects: { material: { profile: PROFILE_ID } },
  },
  credentials: { username: 'rehearsal', password: 'rehearsal', acctId: 'RH' },
})
record('create-target-system', ok(targetSystem) && Boolean(payload(targetSystem)?.id), {
  status: targetSystem.status,
  timeout: timedOut(targetSystem),
})
const targetSystemId = payload(targetSystem).id

// ---------------------------------------------------------------------------------------------
// Step B4 — MINT + APPROVE the read binding via the real routes (the ops runbook's mint step,
// rehearsed end to end; owner review 20260805: the binding must be minted, approved AND
// consumed — the C6 dry-run below now runs with its capability gate fed by THIS approval).
// Content comes from the RATIFIED contract module's builder — single source, no second copy;
// the only degree of freedom is the real source system id, exactly as at the customer window.
// ---------------------------------------------------------------------------------------------

const b4Mint = await call('POST', '/api/integration/read-source-configs', {
  config: buildK3WiseMaterialListB4Config({ systemId: sourceSystemId }),
})
const b4Row = payload(b4Mint)
record('b4-mint', ok(b4Mint) && Boolean(b4Row?.id), {
  status: b4Mint.status,
  mintedVersion: b4Row?.version ?? null,
  contentKeyPresent: typeof b4Row?.contentKey === 'string' && b4Row.contentKey.length > 0,
})

const b4Approve = await call('POST', `/api/integration/read-source-configs/${b4Row.id}/approve`, {})
const b4Approved = payload(b4Approve)
record('b4-approve', ok(b4Approve) && b4Approved?.status === 'approved', {
  status: b4Approve.status,
  bindingStatus: b4Approved?.status ?? null,
})

// ---------------------------------------------------------------------------------------------
// Step 1 — READ-ONLY preflight (runbook step 1): list read-smoke, values-free evidence.
//
// Point A (owner review): list mode requires the { presetId, intent:{ object, mode } } shape —
// a presetId-only body throws intent_required (read-smoke.cjs normalizeReadSmokeContract,
// ~line 529).
//
// Point B (owner review): pre-check FIRST. Feed a synthetic 2-row list result through the ACTUAL
// readSmokeSuccessEvidence the route uses, and read back the real success-shape keys + the
// row-count field — found by VALUE (the one numeric field equal to the synthetic row count), not
// by an assumed field name.
// ---------------------------------------------------------------------------------------------

const listPreset = getReadSmokePreset(LIST_PRESET)
const listProbeRows = [{ FNumber: 'PROBE-RH-001' }, { FNumber: 'PROBE-RH-002' }]
const listProbeEvidence = readSmokeSuccessEvidence(listPreset, { records: listProbeRows }, { object: 'material', mode: 'list' })
const listSuccessKeys = Object.keys(listProbeEvidence)
const listRowCountKey = listSuccessKeys.find(
  (key) => typeof listProbeEvidence[key] === 'number' && listProbeEvidence[key] === listProbeRows.length,
)
record('preflight-list-shape-probe',
  listProbeEvidence.ok === true && typeof listRowCountKey === 'string',
  { listSuccessKeys, listRowCountKey: listRowCountKey ?? null })

const listSmoke = await call('POST', `/api/integration/external-systems/${sourceSystemId}/read-smoke`, {
  presetId: LIST_PRESET,
  intent: { object: 'material', mode: 'list' },
})
const listEvidence = payload(listSmoke)
record('preflight-list-read-smoke',
  listSmoke.status === 200
    && listEvidence?.ok === true
    && listEvidence?.[listRowCountKey] === SOURCE_KEYS.length,
  {
    status: listSmoke.status,
    timeout: timedOut(listSmoke),
    evidenceOk: listEvidence?.ok ?? null,
    rowCountField: listRowCountKey ?? null,
    rowCount: listRowCountKey ? (listEvidence?.[listRowCountKey] ?? null) : null,
  })

// ---------------------------------------------------------------------------------------------
// Step 2 — the window pipeline (runbook step 2).
// ---------------------------------------------------------------------------------------------

const pipeline = await call('POST', '/api/integration/pipelines', {
  tenantId: TENANT_ID,
  name: 'Rehearsal window pipeline',
  sourceSystemId,
  sourceObject: 'material',
  targetSystemId,
  targetObject: 'material',
  status: 'active',
  fieldMappings: [
    { sourceField: 'FNumber', targetField: 'FNumber', validation: [{ type: 'required' }] },
    { sourceField: 'FName', targetField: 'FName', validation: [{ type: 'required' }] },
    { sourceField: 'FModel', targetField: 'FModel' },
  ],
})
record('create-pipeline', ok(pipeline) && Boolean(payload(pipeline)?.id), {
  status: pipeline.status,
  timeout: timedOut(pipeline),
})
const pipelineId = payload(pipeline).id

// ---------------------------------------------------------------------------------------------
// Step 3 — DRY-RUN (runbook step 3; the human-approval preview at the customer window).
// ---------------------------------------------------------------------------------------------

const dryRun = await call('POST', `/api/integration/pipelines/${pipelineId}/external-write/dry-run`, {
  tenantId: TENANT_ID,
})
const dryRunOut = payload(dryRun)
record('dry-run',
  ok(dryRun)
    && dryRunOut?.status === 'ready'
    && typeof dryRunOut?.dryRunToken === 'string'
    && dryRunOut?.counts?.sourceRows === SOURCE_KEYS.length
    && dryRunOut?.counts?.add === SOURCE_KEYS.length,
  {
    status: dryRun.status,
    timeout: timedOut(dryRun),
    planStatus: dryRunOut?.status ?? null,
    sourceRows: dryRunOut?.counts?.sourceRows ?? null,
    add: dryRunOut?.counts?.add ?? null,
    tokenPresent: typeof dryRunOut?.dryRunToken === 'string',
  })

// ---------------------------------------------------------------------------------------------
// Step 4 — APPLY with the token (runbook step 4).
// ---------------------------------------------------------------------------------------------

const apply = await call('POST', `/api/integration/pipelines/${pipelineId}/external-write/apply`, {
  tenantId: TENANT_ID,
  confirm: { dryRunToken: dryRunOut.dryRunToken },
})
const applyOut = payload(apply)
record('apply',
  ok(apply)
    && applyOut?.counts?.written === SOURCE_KEYS.length
    && (applyOut?.counts?.failed ?? 0) === 0,
  {
    status: apply.status,
    timeout: timedOut(apply),
    written: applyOut?.counts?.written ?? null,
    failed: applyOut?.counts?.failed ?? null,
  })

// Token single-use: replaying the SAME token must be refused — the customer window relies on it.
//
// Point C (owner review): assert the PRECISE consumed-token rejection, not just "not 2xx".
// normalizeC6WriteApplyBody (plugins/plugin-integration-core/lib/http-routes.cjs:1034) only
// checks token PRESENCE (400 C6_WRITE_DRY_RUN_TOKEN_REQUIRED). The actual consumed/expired/
// mismatched rejection is thrown by consumeDryRunToken
// (plugins/plugin-integration-core/lib/external-write-dry-run.cjs:151,163,167) as
// `new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_TOKEN_INVALID', ...)`. sendError
// (http-routes.cjs:413-426) serializes any thrown error to `{ ok:false, error:{ code, message,
// details } }` at `error.status` (inferHttpStatus, http-routes.cjs:453, reads
// `error instanceof ExternalWriteDryRunError ? error.status : ...` → 409). payload() returns the
// whole body here (there is no nested `.data` on an error response), so the code lives at
// `body.error.code`.
const replayToken = await call('POST', `/api/integration/pipelines/${pipelineId}/external-write/apply`, {
  tenantId: TENANT_ID,
  confirm: { dryRunToken: dryRunOut.dryRunToken },
})
const replayBody = payload(replayToken)
record('token-single-use',
  replayToken.status === 409 && replayBody?.error?.code === 'C6_WRITE_DRY_RUN_TOKEN_INVALID',
  {
    status: replayToken.status,
    timeout: timedOut(replayToken),
    errorCode: replayBody?.error?.code ?? null,
  })

// ---------------------------------------------------------------------------------------------
// Step 5 — READ-BACK (runbook step 5): single-record read-smoke on the WRITTEN key; the
// values-free evidence proves business success + record presence. Value-level confirmation
// remains the operator's K3-client check at the customer window, by design.
//
// Point B (owner review): read-smoke returns HTTP 200 on BOTH success and failure — assert the
// EVIDENCE shape (readSmokeSuccessEvidence, read-smoke.cjs:365-407: ok, presetId, object, mode,
// recordPresent, recordCount, referenceObjectCount for single_record_detail), not just the HTTP
// status.
// ---------------------------------------------------------------------------------------------

const readBack = await call('POST', `/api/integration/external-systems/${targetSystemId}/read-smoke`, {
  presetId: DETAIL_PRESET,
  key: SOURCE_KEYS[0],
})
const readBackEvidence = payload(readBack)
record('read-back-written-key',
  readBack.status === 200
    && readBackEvidence?.ok === true
    && readBackEvidence?.recordPresent === true
    && readBackEvidence?.recordCount === 1,
  {
    status: readBack.status,
    timeout: timedOut(readBack),
    evidenceOk: readBackEvidence?.ok ?? null,
    recordPresent: readBackEvidence?.recordPresent ?? null,
    recordCount: readBackEvidence?.recordCount ?? null,
  })

// Negative control: a key never written must NOT read back clean — proves the read-back above
// found the WRITE, not a permissive endpoint.
//
// Point B (owner review): precise business-error assertion (readSmokeErrorEvidence,
// read-smoke.cjs:411-452) instead of the previous loose OR across possible failure shapes. The
// K3 adapter's "not found" is a business-level failure surfaced as
// K3WiseWebApiAdapterError.details.code = 'K3_WISE_READ_BUSINESS_ERROR'
// (adapters/k3-wise-webapi-adapter.cjs:1966/1975), which readSmokeErrorEvidence's
// `error.details.code` fallback (read-smoke.cjs:414-415) surfaces as `errorCode` — the SAME code
// run-mock-poc-demo.mjs's ruled-chain negative control already asserts (line 372).
const readBackMiss = await call('POST', `/api/integration/external-systems/${targetSystemId}/read-smoke`, {
  presetId: DETAIL_PRESET,
  key: NEVER_SAVED_KEY,
})
const missEvidence = payload(readBackMiss)
record('read-back-negative-control',
  readBackMiss.status === 200
    && missEvidence?.ok === false
    && missEvidence?.errorCode === 'K3_WISE_READ_BUSINESS_ERROR',
  {
    status: readBackMiss.status,
    timeout: timedOut(readBackMiss),
    evidenceOk: missEvidence?.ok ?? null,
    errorCode: missEvidence?.errorCode ?? null,
  })

summary.pass = true
console.log('REHEARSAL_SUMMARY=' + JSON.stringify(summary))
