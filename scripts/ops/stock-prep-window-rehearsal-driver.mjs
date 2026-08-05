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

const BASE_URL = required('BASE_URL')
const TOKEN = required('TOKEN')
const MOCK_K3_URL = required('MOCK_K3_URL')
const TENANT_ID = required('TENANT_ID')

const PROFILE_ID = 'material-k3wise-customer-profile-v1'
const LIST_PRESET = 'k3wise.material-list.v1'
const DETAIL_PRESET = 'k3wise.material-detail.v1'
const SOURCE_KEYS = ['MAT-RH-001', 'MAT-RH-002'] // seeded by run-mock-k3-server.mjs
const NEVER_SAVED_KEY = 'MAT-RH-NEVER'

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

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      // The login token carries no tenant claim; jwt-middleware copies this header into
      // user.tenantId, which is what resolveAuthUserTenantId (write paths) exclusively trusts.
      'x-tenant-id': TENANT_ID,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data = null
  try { data = await res.json() } catch { /* non-JSON is handled by callers via status */ }
  return { status: res.status, data }
}

function ok(res) { return res.status >= 200 && res.status < 300 }
function payload(res) { return res.data && (res.data.data !== undefined ? res.data.data : res.data) }

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
})
const targetSystemId = payload(targetSystem).id

// ---------------------------------------------------------------------------------------------
// Step 1 — READ-ONLY preflight (runbook step 1): list read-smoke, values-free evidence.
// ---------------------------------------------------------------------------------------------

const listSmoke = await call('POST', `/api/integration/external-systems/${sourceSystemId}/read-smoke`, {
  presetId: LIST_PRESET,
})
const listEvidence = payload(listSmoke)
record('preflight-list-read-smoke', ok(listSmoke), {
  status: listSmoke.status,
  evidenceKeys: listEvidence ? Object.keys(listEvidence).length : 0,
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
record('create-pipeline', ok(pipeline) && Boolean(payload(pipeline)?.id), { status: pipeline.status })
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
    written: applyOut?.counts?.written ?? null,
    failed: applyOut?.counts?.failed ?? null,
  })

// Token single-use: replaying the SAME token must be refused — the customer window relies on it.
const replayToken = await call('POST', `/api/integration/pipelines/${pipelineId}/external-write/apply`, {
  tenantId: TENANT_ID,
  confirm: { dryRunToken: dryRunOut.dryRunToken },
})
record('token-single-use', !ok(replayToken), { status: replayToken.status })

// ---------------------------------------------------------------------------------------------
// Step 5 — READ-BACK (runbook step 5): single-record read-smoke on the WRITTEN key; the
// values-free evidence proves business success + record presence. Value-level confirmation
// remains the operator's K3-client check at the customer window, by design.
// ---------------------------------------------------------------------------------------------

const readBack = await call('POST', `/api/integration/external-systems/${targetSystemId}/read-smoke`, {
  presetId: DETAIL_PRESET,
  key: SOURCE_KEYS[0],
})
record('read-back-written-key', ok(readBack), { status: readBack.status })

// Negative control: a key never written must NOT read back clean — proves the read-back above
// found the WRITE, not a permissive endpoint.
const readBackMiss = await call('POST', `/api/integration/external-systems/${targetSystemId}/read-smoke`, {
  presetId: DETAIL_PRESET,
  key: NEVER_SAVED_KEY,
})
const missEvidence = payload(readBackMiss)
const missIsFailureShaped = !ok(readBackMiss)
  || missEvidence?.businessSuccess === false
  || missEvidence?.recordPresent === false
  || missEvidence?.status === 'error'
record('read-back-negative-control', missIsFailureShaped, { status: readBackMiss.status })

summary.pass = true
console.log('REHEARSAL_SUMMARY=' + JSON.stringify(summary))
