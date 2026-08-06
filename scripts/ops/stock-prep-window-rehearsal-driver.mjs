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
async function call(method, path, body, opts = {}) {
  let res
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // `opts.token` exists for ONE caller: seeding the stand-in source sheet needs an OAPI
        // token with records:write, a different credential from the integration token every
        // other step uses. Defaulting to TOKEN keeps all existing call sites unchanged.
        // NO `|| TOKEN` fallback: `requireScope` PASSES when a request carries no apiTokenScopes,
        // so falling back would silently re-run the call as admin and the lane could not tell
        // "the minted token works" from "the fallback saved us".
        Authorization: `Bearer ${Object.prototype.hasOwnProperty.call(opts, 'token') ? opts.token : TOKEN}`,
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
    // OWNER REVIEW 20260806 [P1]: the write target DECLARES its paired K3 read record. Without
    // this the read record is neither pipeline endpoint, so B4 could only bind to the target and
    // the same-instance check degenerated into target-vs-itself — it could never have caught a
    // read/write mismatch. Naming the peer here is what lets B4 bind the REAL read record while
    // still clearing #4769's relation check.
    pairedReadSystemId: sourceSystemId,
  },
  credentials: { username: 'rehearsal', password: 'rehearsal', acctId: 'RH' },
})
record('create-target-system', ok(targetSystem) && Boolean(payload(targetSystem)?.id), {
  status: targetSystem.status,
  timeout: timedOut(targetSystem),
})
const targetSystemId = payload(targetSystem).id

// ---------------------------------------------------------------------------------------------
// Step 0-c — THE PIPELINE SOURCE. Not K3: no K3 configuration can serve as a C6 source, because
// external-write-dry-run's readSourceRows issues a bare read({object, limit, cursor}) and K3
// answers K3_WISE_READ_LIST_ROUTE_UNSUPPORTED / K3_WISE_READ_KEY_REQUIRED with ZERO fetch calls
// (all three readMode variants, reproduced offline). Every ruled precedent uses a non-K3 source.
//
// HONEST LIMIT, stated in the evidence itself: this source leg is a STAND-IN. The rehearsal
// proves the C6 write lifecycle against a real deployed package; it does NOT exercise the
// customer's real source connector. The K3 READ leg is covered separately by step 1's
// read-smoke, which runs against the real K3 read record.
// ---------------------------------------------------------------------------------------------

const stagingInstall = await call('POST', '/api/integration/staging/install', {})
const stagingSheets = payload(stagingInstall)?.sheetIds || {}
const stagingProjectId = payload(stagingInstall)?.projectId || null
const stagingSheetId = stagingSheets.plm_raw_items || null
record('staging-install', ok(stagingInstall) && Boolean(stagingSheetId) && Boolean(stagingProjectId), {
  status: stagingInstall.status,
  sheetCount: Object.keys(stagingSheets).length,
  // projectId is asserted HERE because a null one is invisible downstream: the config still
  // *has* the key, the adapter's alias map comes back empty, and the dry-run reports add:0 —
  // the exact symptom owner review caught by hand.
  projectIdPresent: Boolean(stagingProjectId),
})

const sourceStagingSystem = await call('POST', '/api/integration/external-systems', {
  tenantId: TENANT_ID,
  name: 'Rehearsal staging source (stand-in)',
  kind: 'metasheet:staging',
  role: 'source',
  status: 'active',
  // OWNER REVIEW 20260805: a bare read SUCCEEDED but returned raw `fld_*` physical keys with
  // code/name EMPTY, so the pipeline got rows it could not map. `resolveProvisionedFieldIdMap`
  // returns {} unless BOTH projectId and logical field names are present — without them the
  // adapter has nothing to alias physical ids back to. Supplying both is what makes the rows
  // readable as code/name.
  config: {
    projectId: stagingProjectId,
    objects: {
      // KEY = the PROVISIONED descriptor id. `resolveProvisionedFieldIdMap` looks up
      // (projectId, objectConfig.objectId, fieldIds); keying this 'material' asked provisioning
      // about an object that was never provisioned, so the alias map came back {} and read()
      // returned raw fld_* keys.
      plm_raw_items: {
        sheetId: stagingSheetId,
        name: 'plm_raw_items',
        fields: ['sourceSystemId', 'objectType', 'sourceId', 'code', 'name'],
      },
    },
  },
})
record('create-staging-source', ok(sourceStagingSystem) && Boolean(payload(sourceStagingSystem)?.id), {
  status: sourceStagingSystem.status,
  // REVIEW P2-2: the "source leg is a stand-in" caveat lived only in comments and a system NAME,
  // so REHEARSAL_SUMMARY carried no trace of it. A limitation a reader has to find in a PR thread
  // is not a limitation the evidence states. It now rides the summary itself.
  sourceLeg: 'stand-in',
  sourceLegNote: 'C6 write lifecycle proven; customer source connector NOT exercised',
})
const pipelineSourceSystemId = payload(sourceStagingSystem)?.id || null

// Seed the stand-in source with a bounded synthetic row set. This is the ONE step that needs a
// credential the integration token cannot supply: `staging/install` creates STRUCTURE only
// (sheets/fields/views, zero rows), and the only record-write path is the OAPI surface
// (`POST /records`, apiTokenAuth + requireScope('records:write')). Minting such a token is
// forbidden here (prod tokens come from login, never minted), so it is an INPUT.
//
// Fail loudly and specifically rather than proceeding to a dry-run that would report
// `sourceRows: 0` and look like a clean pass over an empty source — a vacuous green is worse
// than a red in a lane whose entire purpose is buying information.
// OWNER REVIEW 20260805: an external `REHEARSAL_MULTITABLE_RECORDS_TOKEN` secret CANNOT work.
// Every run provisions a FRESH database, so a static token has no corresponding row and is 401
// by construction — I had built an input that could never be satisfied. The scoped token is
// minted IN-RUN from the admin JWT this lane already holds, via the session-authenticated
// token route. No secret, nothing for an operator to pre-place, and the credential dies with
// the database that issued it.
const tokenMint = await call('POST', '/api/multitable/api-tokens', {
  name: 'rehearsal-seed (ephemeral)',
  scopes: ['records:write', 'fields:read'],
})
// `data.token` is the ApiToken METADATA object; the credential is `data.plaintext` ('mst_…').
// Reading `.token` produced a truthy OBJECT, so the mint step reported PASS while every
// subsequent request sent `Bearer [object Object]` and 401'd — a FALSE GREEN followed by a
// deterministic failure four steps later.
const MULTITABLE_TOKEN = payload(tokenMint)?.plaintext || ''
const mintedTokenUsable = typeof MULTITABLE_TOKEN === 'string' && MULTITABLE_TOKEN.startsWith('mst_')
record('mint-seed-token', ok(tokenMint) && mintedTokenUsable, {
  status: tokenMint.status,
  // Assert the SHAPE that makes the credential work, not mere truthiness: `apiTokenAuth` routes
  // on the `mst_` prefix, so anything else silently falls through to the JWT path.
  usableShape: mintedTokenUsable,
})
if (!mintedTokenUsable) {
  console.error('rehearsal driver: minted token is not a usable mst_ credential '
    + '(data.plaintext missing or wrong shape)')
  console.log(`REHEARSAL_SUMMARY=${JSON.stringify({ steps, pass: false })}`)
  process.exit(1)
}

// The seed and the adapter must agree on ONE mapping. Fetch the physical ids from the server
// rather than assuming logical names round-trip — that assumption is exactly what produced empty
// code/name.
const fieldsRes = await call('GET', `/api/multitable/fields?sheetId=${encodeURIComponent(stagingSheetId)}`,
  undefined, { token: MULTITABLE_TOKEN })
const fieldList = payload(fieldsRes)?.fields || payload(fieldsRes) || []
const physicalByName = {}
for (const f of Array.isArray(fieldList) ? fieldList : []) {
  const logical = f && (f.name || f.title)
  const physical = f && (f.id || f.fieldId)
  if (logical && physical) physicalByName[logical] = physical
}
record('resolve-staging-field-map', ok(fieldsRes) && Object.keys(physicalByName).length > 0, {
  status: fieldsRes.status,
  mappedFields: Object.keys(physicalByName).length,
})

const seedRows = [
  { code: 'MAT-RH-001', name: 'Rehearsal material A' },
  { code: 'MAT-RH-002', name: 'Rehearsal material B' },
]
const seeded = []
for (const row of seedRows) {
  const r = await call('POST', '/api/multitable/records', {
    sheetId: stagingSheetId,
    // `data`, not `fields` — the route's zod schema (univer-meta.ts) names it `data` and STRIPS
    // unknown keys, so `fields` would have written empty rows and looked like a clean pass.
    // Keyed by PHYSICAL field id — what the records route stores and what read() returns.
    data: Object.fromEntries(Object.entries({
      // These three are `required: true` on plm_raw_items; omitting them fails the row.
      'Source System': 'rehearsal-stand-in',
      'Object Type': 'material',
      'Source ID': row.code,
      Code: row.code,
      Name: row.name,
    }).map(([label, value]) => [physicalByName[label] || `__UNMAPPED__${label}`, value])),
  }, { token: MULTITABLE_TOKEN })
  seeded.push(ok(r))
}
record('seed-staging-rows', seeded.length === seedRows.length && seeded.every(Boolean), {
  requested: seedRows.length,
  accepted: seeded.filter(Boolean).length,
})


// ---------------------------------------------------------------------------------------------
// Step B4 — MINT + APPROVE the read binding via the real routes (the ops runbook's mint step,
// rehearsed end to end; owner review 20260805: the binding must be minted, approved AND
// consumed — the C6 dry-run below now runs with its capability gate fed by THIS approval).
// Content comes from the RATIFIED contract module's builder — single source, no second copy;
// the only degree of freedom is the real source system id, exactly as at the customer window.
// ---------------------------------------------------------------------------------------------

const b4Mint = await call('POST', '/api/integration/read-source-configs', {
  // OWNER REVIEW 20260806 [P1] — SUPERSEDES the 20260805 「bind B4 to the K3-write record」
  // arrangement. Binding to the target made the same-instance check compare the target against
  // ITSELF: the driver created a separate K3 READ record, minted B4 on the TARGET, and the route
  // then loaded targetBaseUrl from that same target — so sourceSystemId never entered the
  // comparison and two different K3 instances would have passed.
  //
  // B4 now names the REAL K3 read record. The relation check accepts it because the target
  // declares it as its paired read record (config.pairedReadSystemId above), so the guard
  // compares two GENUINELY DIFFERENT records: the K3 read record against the K3 write target.
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
  sourceSystemId: pipelineSourceSystemId,
  sourceObject: 'plm_raw_items',
  targetSystemId,
  targetObject: 'material',
  status: 'active',
  fieldMappings: [
    // sourceField names STAGING columns (plm_raw_items: code/name/…), targetField names K3's.
    // These were both K3 names while the source was K3; after the swap that produced
    // status=not_applyable with sourceRows:2 / add:0 / failed:2 — the source rows exist but no
    // mapping resolves.
    { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
    { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
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
    // ATTRIBUTION. This step is also the discriminator for the owner's reported P1 (staging read
    // returning fld_* with code/name empty): both fieldMappings carry `required`, validateRecord's
    // `required` uses isEmpty() (undefined/null/whitespace), and a validation failure does
    // `counts.failed += 1; continue` — so the row never reaches counts[decision] and canApply
    // requires failed===0 && held===0. An empty column therefore CANNOT produce a green dry-run.
    // But `add` alone says only THAT it failed; these say WHY — validation vs missing target key —
    // which is the attribution a separate bare-read step would have bought. statusCounts()
    // (external-write-dry-run.cjs:369) always emits both, so a null here means the shape changed.
    failed: dryRunOut?.counts?.failed ?? null,
    held: dryRunOut?.counts?.held ?? null,
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
