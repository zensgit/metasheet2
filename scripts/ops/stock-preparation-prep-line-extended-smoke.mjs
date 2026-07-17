#!/usr/bin/env node
'use strict'

// Stock-preparation T4 (#3751, closeout §5b) — NON-EMPTY prep-line extended smoke over the deployed
// HTTP surface.
//
// The W6 postdeploy smoke (stock-preparation-mvp-postdeploy-smoke.mjs) deliberately pins the EMPTY
// branch: its fixture has no erp_material_master row matching a BOM drawing, so generation stays
// 'blocked' and prep-lines stay 0 — an honesty boundary it documents in its own header ("a full
// generation ready:true flip needs a matching erp_material_master row, and this module deliberately
// exposes NO HTTP write surface for that table"). T2 (#4206) landed that write surface
// (POST /mvp/erp-materials/sync, internal cache only). T4 is the follow-through: drive the SAME
// deployed chain to a NON-EMPTY prep-line and the full ready:true flip, proving the closeout §5b
// Wave-3 checklist over real HTTP:
//   project endpoint PASS · ERP cache rows>0 · auto-match consumed the cache · prepLineRows>0 ·
//   audit 8/8 · externalWrite=false (internal tables only — nothing here can reach PLM/K3/ERP).
//
// Chain (per-run-salted, self-contained fixture; 3 BOM lines A/B/C):
//   provisioning : mvp/readiness -> mvp/ensure -> mvp/options/sync (closed vocabulary fixture)
//   approved-src : (T4-final, opt-in --approved-source-config-id; T3b OD-6) approved PLM read ->
//                  SAME-REQUEST internal persist (201 internal_persist, batch/lines/run non-empty)
//                  -> exact replay (200 internal_noop) — requires the service-side T3b flag ON
//   snapshot     : sync/plan -> sync/persist (201, 3 lines) -> persist replay (200 skipped_existing)
//   projects     : GET /projects carries the populated project row, values-free (T1 #4190 endpoint)
//   cache        : POST /mvp/erp-materials/sync (T2 #4206) caches material MA with
//                  erpMaterialCode === drawing A — the join key auto-match will use
//   auto-match   : candidates/sync -> among the 3 created rows EXACTLY ONE is an
//                  exact_code_candidate with an ERP target (the cache DROVE the match) and the other
//                  two are not_found; confirm the cache-driven candidate BY mappingId (matchMethod
//                  stays exact_code_candidate — the cache row was confirmed, not replaced)
//   unit         : candidates (values-stripped) -> confirm ONE generic-scope manual rule (salted
//                  plmUnit -> erpIssueUnit x2) covering all three lines
//   generation 1 : run -> 201 'partial': created.lines === 1 (THE NON-EMPTY PROOF), 2 blocking
//                  missing_mapping exceptions (B, C), ready invariant holds
//   prep lines   : GET /prep-lines -> rowCount 1; closed values-free row projection
//   exceptions   : cache MB+MC -> candidates re-sync creates 2 NEW exact_code candidates (the
//                  refreshed cache flows into candidates; A re-emits historical + is skipped) ->
//                  confirm B and C by mappingId -> resolve B single + C bulk (mapping_confirmed)
//   generation 2 : run -> 201 'ready': READY === TRUE, unresolved blocking 2 -> 0, 3/3 lines
//   audit        : all 8 closed-vocabulary actions left a values-free row for THIS project
//   probes       : confirm-by-id on a no-ERP-identity candidate -> 409 CONFIRM_MAPPING_TARGET_INCOMPLETE
//                  erp-materials/sync body tenantId -> 400 (anti-steering closed allowlist)
//   cleanup      : retire all 5 mapping rows + the unit rule; re-sync all 3 cached materials to
//                  materialStatus 'inactive' (mode 'refreshed' — the T2 upsert-patch proof); the
//                  project-scoped batch/lines/prep-lines/exceptions stay (immutable audit substrate,
//                  same posture as the W6 smoke)
//   leak scan    : every non-exempt response body scanned against the fixture + engine-message
//                  sentinels; the ONLY exempt response is /mvp/sync/plan (same-origin echo), counted
//                  and asserted to stay at exactly 1.
//
// HARD BOUNDARY (closeout §5b): every write above lands in the 9 INTERNAL MVP tables through the
// same admin-gated HTTP surface the views use. externalWrite stays false — no K3 Save/Submit/Audit,
// no apply-writer, no external system call of any kind exists on any route this smoke touches.
//
// Pattern parity: arg parsing, requestJson, values-free-by-construction output (P2-2 sanitizing
// registries), summary block, PASS/FAIL exit, and the leak-scan discipline are IMPORTED from the W6
// postdeploy smoke rather than re-implemented, so the two harnesses cannot drift apart.
//
// Serial-run assumption (same as W6): candidate-id attribution diffs the TENANT-level candidate list
// before/after; dispatch this smoke serially and never concurrently with the W6 postdeploy smoke
// (they share the tenant-level mapping/rule/material tables).
//
// Run:
//   METASHEET_AUTH_TOKEN=... node scripts/ops/stock-preparation-prep-line-extended-smoke.mjs \
//     --base-url http://HOST:PORT [--tenant-id t] [--workspace-id w] \
//     [--project-prefix stockprep-t4] [--timeout-ms 15000] [--out-dir output/dir] \
//     [--approved-source-config-id cfg_ref]   # T4-final OD-6 prelude (service T3b flag must be ON)

import fs from 'node:fs'
import path from 'node:path'

import {
  ALLOWED_ERROR_CODES,
  ALLOWED_MODES,
  AUDIT_ACTIONS,
  ENGINE_MESSAGE_SENTINELS,
  buildOptionSetsFixture,
  buildRequestHeaders,
  leakScan,
  newIds,
  projectCounts,
  readyInvariantHolds,
  registeredValue,
  safeCount,
  safeField,
  safeHandle,
  safeMode,
  safeStatus,
} from './stock-preparation-mvp-postdeploy-smoke.mjs'

export { buildOptionSetsFixture }

const RESULT = { checks: [], summary: {} }
const COLLECTED = []
let SELF_SCAN_SENTINELS = []

const API = '/api/integration/stock-preparation'

export const SUMMARY_HEADER = 'STOCK_PREPARATION_PREP_LINE_EXTENDED_SMOKE'

// T4 additionally asserts on the T2 route's error/mode vocabulary, which postdates the W6 registry.
// The merged registry stays CLOSED — an unknown code still prints '<unregistered>'.
export const T4_ALLOWED_ERROR_CODES = Object.freeze(new Set([
  ...ALLOWED_ERROR_CODES,
  'STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_INVALID',
  'ERP_MATERIAL_SYNC_CONFIG_INVALID', 'ERP_MATERIAL_SYNC_PERMISSION_DENIED',
  'ERP_MATERIAL_SYNC_PROVISIONING_API_UNAVAILABLE', 'ERP_MATERIAL_SYNC_RECORDS_API_INVALID',
  'ERP_MATERIAL_SYNC_TARGET_NOT_PROVISIONED', 'ERP_MATERIAL_SYNC_KEY_AMBIGUOUS',
]))

export function safeCode(value) { return registeredValue(value, T4_ALLOWED_ERROR_CODES) }

// T4-final additionally asserts on the T3b source-run response modes, which postdate the W6 registry.
// Same closed-merge pattern as T4_ALLOWED_ERROR_CODES — an unknown mode still prints '<unregistered>'.
export const T4_ALLOWED_MODES = Object.freeze(new Set([
  ...ALLOWED_MODES,
  'dry_run', 'internal_persist', 'internal_noop',
]))

export function safeT4Mode(value) { return registeredValue(value, T4_ALLOWED_MODES) }

// The closed values-free per-row projection of GET /prep-lines (shape-lock against the W5 read
// contract in stock-preparation-confirm-reads.cjs listStockPreparationPrepLines). Optional handles
// (snapshotBatchId / snapshotLineId / createdFromRunId) may be absent; NO other key may appear —
// in particular never a drawing number, quantity, or unit symbol (OD-W3-1 stays closed).
export const PREP_LINE_ROW_KEYS = Object.freeze([
  'stockPrepLineId',
  'snapshotBatchId',
  'snapshotLineId',
  'prepStatus',
  'mappingStatus',
  'unitStatus',
  'exceptionCount',
  'hasIssueQty',
  'hasErpTarget',
  'createdFromRunId',
])

export function prepLineRowProjectionValid(rows) {
  if (!Array.isArray(rows)) return false
  const allowed = new Set(PREP_LINE_ROW_KEYS)
  return rows.every((row) => row && typeof row === 'object' && Object.keys(row).every((key) => allowed.has(key)))
}

// A fully-resolved prep-line summary row: draft/matched/converted, an issue quantity and ERP target
// PRESENT (booleans only — the values themselves never cross), zero exceptions.
export function prepLineRowResolved(row) {
  return Boolean(
    row && typeof row === 'object' &&
    row.prepStatus === 'draft' && row.mappingStatus === 'matched' && row.unitStatus === 'converted' &&
    row.exceptionCount === 0 && row.hasIssueQty === true && row.hasErpTarget === true,
  )
}

// Per-run salted, self-contained fixture. Three BOM lines (A root; B and C children of A) and three
// ERP materials whose erpMaterialCode EQUALS the line's drawing number — the exact-code join the
// auto-match ladder uses. Every value-bearing token doubles as a leak-scan sentinel.
export function buildExtendedSmokeFixture(salt, projectPrefix = 'stockprep-t4') {
  const projectId = `${projectPrefix}-${salt}`
  const snapshotBatchId = `smoke_t4_batch_${salt}`
  const syncRunId = `smoke_t4_syncrun_${salt}`
  const drawingA = `T4DWG-A-${salt}`
  const drawingB = `T4DWG-B-${salt}`
  const drawingC = `T4DWG-C-${salt}`
  const pathA = `t4path/${salt}/a`
  const pathB = `t4path/${salt}/a/b`
  const pathC = `t4path/${salt}/a/c`
  const unitPlm = `t4u${salt}`
  const unitErp = `t4e${salt}`
  const erpItemA = `T4ITM-A-${salt}`
  const erpItemB = `T4ITM-B-${salt}`
  const erpItemC = `T4ITM-C-${salt}`
  const materialNameA = `T4_MATERIAL_NAME_A_${salt}`
  const materialNameB = `T4_MATERIAL_NAME_B_${salt}`
  const materialNameC = `T4_MATERIAL_NAME_C_${salt}`
  const sourceProjectNo = `T4PRJNO-${salt}`
  const projectName = `T4 Smoke Project ${salt}`
  // 5-decimal quantities: can never collide with an ISO timestamp's 3-digit millisecond field or any
  // count/confidence a values-free read legitimately emits (same rationale as the W6 fixture).
  const qtyA = 7.03125
  const qtyB = 3.40625
  const qtyC = 1.15625
  const material = (erpMaterialId, code, internalId, name) => ({
    erpMaterialId,
    erpMaterialCode: code,
    erpMaterialInternalId: internalId,
    erpMaterialName: name,
    baseUnit: unitPlm,
    inventoryUnit: unitErp,
    issueUnit: unitErp,
    unitGroup: 'default',
    materialStatus: 'active',
  })
  return {
    projectId,
    snapshotBatchId,
    syncRunId,
    drawingA,
    drawingB,
    drawingC,
    unitPlm,
    unitErp,
    erpItemA,
    erpItemB,
    erpItemC,
    sourceProjectNo,
    projectName,
    defaultDesignUnit: unitPlm,
    expansionResult: {
      rows: [
        { componentSourceId: `T4OBJ_A_${salt}`, componentCode: drawingA, sourceVersion: 'V1', path: pathA, rawQuantity: qtyA, depth: 1 },
        { componentSourceId: `T4OBJ_B_${salt}`, parentSourceId: `T4OBJ_A_${salt}`, componentCode: drawingB, sourceVersion: 'V1', path: pathB, rawQuantity: qtyB, depth: 2 },
        { componentSourceId: `T4OBJ_C_${salt}`, parentSourceId: `T4OBJ_A_${salt}`, componentCode: drawingC, sourceVersion: 'V1', path: pathC, rawQuantity: qtyC, depth: 2 },
      ],
      rowErrors: [],
    },
    materialA: material(`smk_t4_erpa_${salt}`, drawingA, erpItemA, materialNameA),
    materialB: material(`smk_t4_erpb_${salt}`, drawingB, erpItemB, materialNameB),
    materialC: material(`smk_t4_erpc_${salt}`, drawingC, erpItemC, materialNameC),
    sentinels: [
      drawingA, drawingB, drawingC, pathA, pathB, pathC, unitPlm, unitErp,
      erpItemA, erpItemB, erpItemC, materialNameA, materialNameB, materialNameC,
      String(qtyA), String(qtyB), String(qtyC), sourceProjectNo, projectName,
    ],
  }
}

// T4-final (T3b design-lock OD-6): the approved-source prelude request. A per-run salted business
// scope for a SEPARATE internal project/batch/run id space, so the prelude can never collide with
// the synthetic chain's fixture. The config REFERENCE is operator-provided (an approved read-source
// config; the smoke never carries source credentials or raw payload controls).
export function buildApprovedSourcePrelude(salt, { projectPrefix = 'stockprep-t4', approvedSourceConfigId, workspaceId = '' } = {}) {
  if (!approvedSourceConfigId) throw new Error('approvedSourceConfigId is required for the approved-source prelude')
  const sourceProjectNo = `T4APRJNO-${salt}`
  const projectName = `T4 Approved Source Project ${salt}`
  const body = {
    projectId: `${projectPrefix}-approved-${salt}`,
    sourceProjectNo,
    projectName,
    readSourceConfigId: approvedSourceConfigId,
    syncRunId: `smoke_t4_approved_syncrun_${salt}`,
    snapshotBatchId: `smoke_t4_approved_batch_${salt}`,
    snapshotVersion: 1,
  }
  if (workspaceId) body.workspaceId = workspaceId
  return {
    body,
    // The values-free source-run response must never echo the config reference or the request's
    // value-bearing tokens. projectId is deliberately NOT a sentinel: it is an opaque business
    // handle that read surfaces (GET /projects) legitimately list.
    sentinels: [approvedSourceConfigId, sourceProjectNo, projectName],
  }
}

// T4-final prelude execution (OD-6 items 1-3 + 5 over real HTTP): approved PLM read -> SAME-REQUEST
// internal persist -> exact replay noop. Injectable `req`/`must`/`summary` so the stage's PASS/FAIL
// discipline is unit-testable without a server (corrective-5 fetchImpl precedent). NOTE the prelude
// deliberately sends NO tenantId/projectId query carriers: with the T3b flag ON those are steering
// vectors the route fail-closes on — the tenant rides the AUTHENTICATED token only (OD-2).
export async function runApprovedSourcePrelude({ salt, args, req, must, summary, registerSentinels }) {
  if (typeof registerSentinels !== 'function') {
    throw new Error('runApprovedSourcePrelude requires a registerSentinels callback — the prelude sentinels MUST join the run-level leak scan')
  }
  const prelude = buildApprovedSourcePrelude(salt, {
    projectPrefix: args.projectPrefix,
    approvedSourceConfigId: args.approvedSourceConfigId,
    workspaceId: args.workspaceId,
  })
  registerSentinels(prelude.sentinels)
  const sourceRun = await req(`${API}/mvp/source-runs/plm-bom`, {
    method: 'POST', body: prelude.body, accept: [201], label: 'approved-source-run',
  })
  const data = (sourceRun.body && sourceRun.body.data) || {}
  const auto = data.autoPersist || {}
  summary.approvedSourceHttp = sourceRun.status
  summary.approvedSourceMode = safeT4Mode(data.mode)
  summary.approvedSourceCreated = projectCounts(auto.created, ['batch', 'lines', 'run'])
  // A 200 dry_run here means the T3b flag is OFF on the service — the prelude REQUIRES the flag and
  // must fail loudly rather than "pass" as a read-only run (OD-6 item 1).
  const createdOk =
    sourceRun.ok && data.mode === 'internal_persist' &&
    data.evidence?.internalWriteExecuted === true &&
    auto.persisted === true && auto.mode === 'created' &&
    auto.created?.batch === 1 && safeCount(auto.created?.lines) >= 1 && auto.created?.run === 1
  must('approved-source run -> 201 internal_persist with non-empty batch/lines/run (T3b flag ON)',
    createdOk,
    `http=${sourceRun.status} mode=${summary.approvedSourceMode} created=${summary.approvedSourceCreated}`)
  // Owner review P3: a failed first call already fails the run — do NOT keep reading the external
  // source or risk creating internal rows with a second call.
  if (!createdOk) return prelude
  must('approved-source run keeps every external-write invariant false',
    data.evidence?.externalWriteExecuted === false && data.evidence?.productionWrite === false &&
    data.evidence?.k3SaveSubmitAudit === false && data.evidence?.plmExternalWrite === false,
    `http=${sourceRun.status}`)
  const replay = await req(`${API}/mvp/source-runs/plm-bom`, {
    method: 'POST', body: prelude.body, accept: [200], label: 'approved-source-run-replay',
  })
  const replayData = (replay.body && replay.body.data) || {}
  summary.approvedSourceReplayHttp = replay.status
  summary.approvedSourceReplayMode = safeT4Mode(replayData.mode)
  must('approved-source exact replay -> 200 internal_noop skipped_existing with zero new rows',
    replay.ok && replayData.mode === 'internal_noop' &&
    replayData.evidence?.internalWriteExecuted === false &&
    replayData.autoPersist?.persisted === false && replayData.autoPersist?.mode === 'skipped_existing' &&
    replayData.autoPersist?.created?.batch === 0,
    `http=${replay.status} mode=${summary.approvedSourceReplayMode}`)
  return prelude
}

export function formatSummaryBlock(summary) {
  const lines = [SUMMARY_HEADER]
  for (const [key, value] of Object.entries(summary)) lines.push(`${key}=${value}`)
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    tenantId: '',
    workspaceId: '',
    projectPrefix: 'stockprep-t4',
    timeoutMs: 15000,
    outDir: '',
    approvedSourceConfigId: '',
  }
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--base-url') args.baseUrl = next()
    else if (flag === '--tenant-id') args.tenantId = next()
    else if (flag === '--workspace-id') args.workspaceId = next()
    else if (flag === '--project-prefix') args.projectPrefix = next()
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next())
    else if (flag === '--out-dir') args.outDir = next()
    else if (flag === '--approved-source-config-id') args.approvedSourceConfigId = next()
    else throw new Error(`unknown flag: ${flag}`)
  }
  if (!args.baseUrl) throw new Error('--base-url is required')
  return args
}

function check(name, ok, detail = '') {
  RESULT.checks.push({ name, ok: ok === true, detail })
  const mark = ok === true ? 'ok' : 'FAIL'
  process.stderr.write(`[t4-smoke] ${name}: ${mark}${detail ? ` (${detail})` : ''}\n`)
  return ok === true
}

// T4 corrective P3-1 (reviewer): the per-request defaults main() feeds into EVERY requestJson call,
// extracted pure so the tenant passthrough is unit-pinnable — deleting tenantId here reds a test
// instead of silently reverting the entity run to the corrective-5 N/8 failure class.
export function buildRequestDefaults(args, token) {
  return { token, timeoutMs: args.timeoutMs, tenantId: args.tenantId }
}

// T4 corrective (owner review, 2026-07-16): headers come from the SAME builder the W6 smoke uses —
// x-tenant-id rides on EVERY request when --tenant-id is given. The jwt middleware backfills the
// authenticated principal's tenant from that header, and the T3b/T2 write routes resolve the tenant
// from the principal only (resolveAuthUserTenantId) — without the header a tenant-scoped token-less
// deployment 400s TENANT_REQUIRED, the exact corrective-5 N/8 root cause. fetchImpl is injectable so
// the REAL header assembly is test-pinned (never a scripted stand-in).
export async function requestJson(baseUrl, pathname, { token, timeoutMs, tenantId, method = 'GET', body, accept = [200], label = '', leakExempt = false, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = buildRequestHeaders({ token, tenantId, hasBody: body !== undefined })
    const init = { method, headers, signal: controller.signal }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    const response = await doFetch(`${baseUrl}${pathname}`, init)
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    if (leakExempt) {
      COLLECTED.push({ label: label || pathname, exempt: true })
    } else {
      COLLECTED.push({ label: label || pathname, exempt: false, body: parsed })
    }
    return { status: response.status, body: parsed, ok: accept.includes(response.status) }
  } finally {
    clearTimeout(timer)
  }
}

function scopeQuery(args, extra = {}) {
  const params = new URLSearchParams()
  if (args.tenantId) params.set('tenantId', args.tenantId)
  if (args.workspaceId) params.set('workspaceId', args.workspaceId)
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

async function main() {
  const args = parseArgs(process.argv)
  const token = process.env.METASHEET_AUTH_TOKEN || ''
  const salt = `t${Math.floor(Date.now() / 1000)}`
  const fixture = buildExtendedSmokeFixture(salt, args.projectPrefix)
  const S = RESULT.summary
  let failed = false
  const must = (name, ok, detail) => { if (!check(name, ok, detail)) failed = true }
  const req = (pathname, options) => requestJson(args.baseUrl, pathname, { ...buildRequestDefaults(args, token), ...options })
  const scope = (extra) => scopeQuery(args, extra)
  SELF_SCAN_SENTINELS = [...fixture.sentinels, ...ENGINE_MESSAGE_SENTINELS]
  S.salt = salt

  // ── 0. auth round-trip ────────────────────────────────────────────────────────────────────────
  const status = await req(`/api/integration/status${scope()}`, { label: 'status' })
  S.statusHttp = status.status
  must('status auth round-trip', status.ok, `http=${status.status}`)
  if (!status.ok) return finish(failed, args)

  // ── 1. provisioning: readiness -> ensure -> options/sync ─────────────────────────────────────
  const readiness = await req(`${API}/mvp/readiness${scope()}`, { label: 'mvp-readiness' })
  S.readinessHttp = readiness.status
  S.readinessTableCount = safeCount(readiness.body?.data?.evidence?.tableCount)
  must('mvp readiness http 200 + 9 frozen tables', readiness.ok && S.readinessTableCount === 9,
    `http=${readiness.status} tables=${S.readinessTableCount}`)

  const ensure = await req(`${API}/mvp/ensure${scope()}`, { method: 'POST', body: {}, accept: [200, 201], label: 'mvp-ensure' })
  S.ensureHttp = ensure.status
  S.ensureReady = ensure.body?.data?.ready === true
  must('mvp ensure http 200/201 + ready', ensure.ok && S.ensureReady, `http=${ensure.status}`)
  if (!ensure.ok || !S.ensureReady) return finish(true, args)

  const optionsSync = await req(`${API}/mvp/options/sync${scope()}`, {
    method: 'POST', body: { optionSets: buildOptionSetsFixture() }, label: 'mvp-options-sync',
  })
  S.optionsSyncHttp = optionsSync.status
  S.optionsSyncedFieldCount = safeCount(optionsSync.body?.data?.evidence?.syncedFieldCount)
  S.optionsSkippedFieldCount = safeCount(optionsSync.body?.data?.evidence?.skippedFieldCount)
  must('options sync http 200 + covered every option field',
    optionsSync.ok && S.optionsSyncedFieldCount > 0 && S.optionsSkippedFieldCount === 0,
    `http=${optionsSync.status} synced=${S.optionsSyncedFieldCount} skipped=${S.optionsSkippedFieldCount}`)

  // ── 1b. T4-final approved-source prelude (T3b OD-6): approved PLM read -> internal persist ───
  // Opt-in via --approved-source-config-id; absent, this run is byte-for-byte the pre-T4-final
  // smoke (no new request, no new summary key). The prelude proves the approved source -> project/
  // batch/line/run front-end in ITS OWN salted id space; the synthetic chain below stays the
  // unchanged non-empty prep-line proof (OD-6: extend, don't rewrite).
  if (args.approvedSourceConfigId) {
    await runApprovedSourcePrelude({
      salt, args, req, must, summary: S,
      registerSentinels: (sentinels) => { SELF_SCAN_SENTINELS = [...SELF_SCAN_SENTINELS, ...sentinels] },
    })
  }

  // ── 2. snapshot: plan -> persist (201, 3 lines) -> replay (200 skipped_existing) ─────────────
  const planBody = {
    projectId: fixture.projectId,
    syncRunId: fixture.syncRunId,
    snapshotBatchId: fixture.snapshotBatchId,
    snapshotVersion: 1,
    sourceSystem: 'plm_smoke',
    sourceProjectNo: fixture.sourceProjectNo,
    projectName: fixture.projectName,
    expansionResult: fixture.expansionResult,
    defaultDesignUnit: fixture.defaultDesignUnit,
  }
  // leakExempt: the plan response is a preview that echoes the caller's OWN fixture input (same
  // documented exemption as the W6 smoke; counted + asserted to stay at exactly 1 below).
  const plan = await req(`${API}/mvp/sync/plan${scope()}`, { method: 'POST', body: planBody, label: 'sync-plan', leakExempt: true })
  const planData = plan.body?.data || {}
  S.planHttp = plan.status
  S.planLineCount = safeCount(planData.evidence?.mapping?.result?.lines)
  must('sync plan http 200 + 3 lines + no flags',
    plan.ok && S.planLineCount === 3 && planData.flags?.hasFlags !== true,
    `http=${plan.status} lines=${S.planLineCount}`)
  if (!plan.ok) return finish(true, args)

  const persist = await req(`${API}/mvp/sync/persist${scope()}`, { method: 'POST', body: planBody, accept: [201], label: 'sync-persist' })
  const persistData = persist.body?.data || {}
  S.persistHttp = persist.status
  S.persistMode = safeMode(persistData.mode)
  S.persistCreated = projectCounts(persistData.created, ['batch', 'lines', 'run'])
  must('sync persist -> 201 created {batch:1,lines:3,run:1}',
    persist.ok && persistData.persisted === true && persistData.mode === 'created' &&
    persistData.created?.batch === 1 && persistData.created?.lines === 3 && persistData.created?.run === 1,
    `http=${persist.status} mode=${S.persistMode} created=${S.persistCreated}`)
  if (!persist.ok) return finish(true, args)

  const replay = await req(`${API}/mvp/sync/persist${scope()}`, { method: 'POST', body: planBody, accept: [200], label: 'sync-persist-replay' })
  const replayData = replay.body?.data || {}
  S.persistReplayMode = safeMode(replayData.mode)
  must('persist replay -> 200 skipped_existing (idempotency + immutability)',
    replay.ok && replayData.persisted === false && replayData.mode === 'skipped_existing' && replayData.created?.batch === 0,
    `http=${replay.status} mode=${S.persistReplayMode}`)

  // ── 2b. closeout Wave-3 item: project endpoint PASS, values-free ─────────────────────────────
  const projectList = await req(`${API}/projects${scope()}`, { label: 'project-list' })
  const ourProject = (projectList.body?.data?.projects || []).find((entry) => entry.projectId === fixture.projectId) || null
  S.projectListHttp = projectList.status
  S.projectStatus = safeStatus(ourProject ? ourProject.projectStatus : null)
  must('project endpoint PASS: the persisted project is listed, values-free (no name/projectNo keys)',
    projectList.ok && ourProject !== null && ourProject.projectStatus === 'active' &&
    ourProject.snapshotBatchCount >= 1 && !('projectName' in ourProject) && !('sourceProjectNo' in ourProject),
    `http=${projectList.status} status=${S.projectStatus}`)

  // ── 3. T2 cache seed: material A only (code === drawing A) ───────────────────────────────────
  const erpSyncA = await req(`${API}/mvp/erp-materials/sync${scope()}`, {
    method: 'POST',
    body: { syncRunId: `smoke_t4_erprun_a_${salt}`, erpMaterials: [fixture.materialA] },
    accept: [201], label: 'erp-materials-sync-a',
  })
  const erpSyncAData = erpSyncA.body?.data || {}
  S.erpSyncAHttp = erpSyncA.status
  S.erpSyncAMode = safeMode(erpSyncAData.mode)
  S.erpSyncACreated = projectCounts(erpSyncAData.created, ['materials', 'run'])
  must('ERP cache rows>0: sync material A -> 201 created {materials:1,run:1} succeeded',
    erpSyncA.ok && erpSyncAData.persisted === true && erpSyncAData.mode === 'created' &&
    erpSyncAData.created?.materials === 1 && erpSyncAData.created?.run === 1 && erpSyncAData.runStatus === 'succeeded',
    `http=${erpSyncA.status} mode=${S.erpSyncAMode} created=${S.erpSyncACreated}`)
  must('ERP cache sync evidence is values-free by declaration', erpSyncAData.evidence?.valuesFree === true)

  // PROBE: the T2 route's closed allowlist refuses a body tenantId (anti-steering; the tenant is
  // derived from the AUTHENTICATED principal only).
  const erpSteer = await req(`${API}/mvp/erp-materials/sync${scope()}`, {
    method: 'POST',
    body: { tenantId: 'steered-tenant', syncRunId: `smoke_t4_erprun_x_${salt}`, erpMaterials: [] },
    accept: [400], label: 'probe-erp-sync-tenantid',
  })
  S.probeErpSteerHttp = erpSteer.status
  S.probeErpSteerCode = safeCode(erpSteer.body?.error?.code)
  S.probeErpSteerField = safeField(erpSteer.body?.error?.details?.field)
  must('PROBE body tenantId on erp-materials/sync -> 400 closed-allowlist rejection',
    erpSteer.ok && S.probeErpSteerCode === 'STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_INVALID' && S.probeErpSteerField === 'tenantId',
    `http=${erpSteer.status} code=${S.probeErpSteerCode} field=${S.probeErpSteerField}`)

  // ── 4. auto-match: the cache drives EXACTLY ONE exact_code candidate ─────────────────────────
  const candidateRows = async (label) => {
    const list = await req(`${API}/material-mappings/candidates${scope({ projectId: fixture.projectId })}`, { label })
    const rows = Array.isArray(list.body?.data?.rows) ? list.body.data.rows : []
    return { response: list, ids: rows.map((row) => row.mappingId).filter(Boolean), rows }
  }

  const pre = await candidateRows('mapping-candidates-pre')
  must('mapping candidates pre-sync http 200', pre.response.ok, `http=${pre.response.status}`)

  const candidatesSyncBody = { projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId, defaultVersionPolicy: 'drawing_only' }
  const sync1 = await req(`${API}/material-mappings/candidates/sync${scope()}`, { method: 'POST', body: candidatesSyncBody, accept: [201], label: 'mapping-candidates-sync-1' })
  const sync1Data = sync1.body?.data || {}
  S.candidatesSync1Created = safeCount(sync1Data.created?.mappings)
  must('candidates sync 1 -> 201 created 3 rows (one per drawing)',
    sync1.ok && sync1Data.mode === 'created' && S.candidatesSync1Created === 3,
    `http=${sync1.status} created=${S.candidatesSync1Created}`)

  const post1 = await candidateRows('mapping-candidates-post-sync-1')
  const sync1Ids = newIds(pre.ids, post1.ids)
  const sync1Rows = post1.rows.filter((row) => sync1Ids.includes(row.mappingId))
  const cacheDriven = sync1Rows.filter((row) => row.matchMethod === 'exact_code_candidate' && row.matchStatus === 'pending_confirm' && row.hasErpTarget === true)
  const notFound = sync1Rows.filter((row) => row.matchStatus === 'not_found' && row.hasErpTarget === false)
  S.capturedSync1Ids = sync1Ids.length
  S.cacheDrivenCandidates = cacheDriven.length
  S.notFoundCandidates = notFound.length
  must('captured the 3 sync-created candidate ids (serial-run assumption)', sync1Ids.length === 3, `captured=${S.capturedSync1Ids}`)
  must('auto-match consumed the cache: EXACTLY ONE exact_code_candidate with an ERP target',
    cacheDriven.length === 1, `cacheDriven=${S.cacheDrivenCandidates}`)
  must('the two uncached drawings are not_found without an ERP target', notFound.length === 2, `notFound=${S.notFoundCandidates}`)
  if (cacheDriven.length !== 1 || notFound.length !== 2) return finish(true, args)
  const candidateA = cacheDriven[0]

  // PROBE: confirming a candidate WITHOUT a full ERP identity is refused (the poisoned-matched-row
  // guard) — it must be re-created via create-mode with explicit identifiers instead.
  const incompleteConfirm = await req(`${API}/material-mappings/confirm${scope()}`, {
    method: 'POST', body: { projectId: fixture.projectId, mappingId: notFound[0].mappingId },
    accept: [409], label: 'probe-confirm-target-incomplete',
  })
  S.probeIncompleteHttp = incompleteConfirm.status
  S.probeIncompleteCode = safeCode(incompleteConfirm.body?.error?.code)
  must('PROBE confirm-by-id on a no-ERP-identity candidate -> 409 CONFIRM_MAPPING_TARGET_INCOMPLETE',
    incompleteConfirm.ok && S.probeIncompleteCode === 'CONFIRM_MAPPING_TARGET_INCOMPLETE',
    `http=${incompleteConfirm.status} code=${S.probeIncompleteCode}`)

  // Confirm the cache-driven candidate BY id: the SAME row flips to matched; matchMethod stays
  // exact_code_candidate (the cache row was confirmed, not replaced by a manual row).
  const confirmA = await req(`${API}/material-mappings/confirm${scope()}`, {
    method: 'POST', body: { projectId: fixture.projectId, mappingId: candidateA.mappingId },
    accept: [200], label: 'mapping-confirm-a',
  })
  S.mappingConfirmAMode = safeMode(confirmA.body?.data?.mode)
  S.mappingConfirmAHandle = safeHandle(candidateA.mappingId)
  must('confirm cache-driven candidate by mappingId -> 200 confirmed',
    confirmA.ok && confirmA.body?.data?.mode === 'confirmed' && confirmA.body?.data?.mappingId === candidateA.mappingId,
    `http=${confirmA.status} mode=${S.mappingConfirmAMode}`)

  const confirmAReplay = await req(`${API}/material-mappings/confirm${scope()}`, {
    method: 'POST', body: { projectId: fixture.projectId, mappingId: candidateA.mappingId },
    accept: [200], label: 'mapping-confirm-a-replay',
  })
  S.mappingConfirmAReplayMode = safeMode(confirmAReplay.body?.data?.mode)
  must('confirm replay -> 200 skipped_already_confirmed',
    confirmAReplay.ok && S.mappingConfirmAReplayMode === 'skipped_already_confirmed',
    `http=${confirmAReplay.status} mode=${S.mappingConfirmAReplayMode}`)

  const postConfirm = await candidateRows('mapping-candidates-post-confirm')
  const confirmedRowA = postConfirm.rows.find((row) => row.mappingId === candidateA.mappingId) || null
  must('confirmed row: matched + confirmed + matchMethod STILL exact_code_candidate (cache provenance kept)',
    confirmedRowA !== null && confirmedRowA.matchStatus === 'matched' && confirmedRowA.confirmed === true &&
    confirmedRowA.matchMethod === 'exact_code_candidate' && confirmedRowA.hasErpTarget === true)

  // ── 5. unit conversion: values-stripped candidates -> ONE generic-scope manual rule ──────────
  const unitCandidates = await req(`${API}/unit-conversions/candidates${scope({ projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId })}`, { label: 'unit-candidates' })
  const unitRows = Array.isArray(unitCandidates.body?.data?.rows) ? unitCandidates.body.data.rows : []
  S.unitCandidatesHttp = unitCandidates.status
  S.unitCandidateRowCount = safeCount(unitCandidates.body?.data?.rowCount)
  must('unit candidates http 200 + values-stripped rows (hasCandidate boolean, no candidateRule)',
    unitCandidates.ok && S.unitCandidateRowCount >= 1 &&
    unitRows.every((row) => typeof row.hasCandidate === 'boolean' && !('candidateRule' in row)),
    `http=${unitCandidates.status} rows=${S.unitCandidateRowCount}`)

  const unitConfirm = await req(`${API}/unit-conversions/confirm${scope()}`, {
    method: 'POST',
    body: {
      projectId: fixture.projectId,
      rule: { plmUnit: fixture.unitPlm, erpIssueUnit: fixture.unitErp, conversionFactor: 2, scopeType: 'generic', roundingRule: 'none' },
    },
    accept: [201], label: 'unit-confirm',
  })
  const conversionRuleId = unitConfirm.body?.data?.conversionRuleId || ''
  S.unitConfirmMode = safeMode(unitConfirm.body?.data?.mode)
  S.unitConfirmHandle = safeHandle(conversionRuleId)
  must('unit confirm (generic-scope manual rule) -> 201 created',
    unitConfirm.ok && unitConfirm.body?.data?.mode === 'created' && Boolean(conversionRuleId),
    `http=${unitConfirm.status} mode=${S.unitConfirmMode}`)

  // ── 6. generation run 1: NON-EMPTY on first run — 1 line + 2 blocking exceptions ─────────────
  const generationBody = { projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId }
  const run1 = await req(`${API}/generation/run${scope()}`, { method: 'POST', body: generationBody, accept: [201], label: 'generation-run-1' })
  const run1Data = run1.body?.data || {}
  S.run1Http = run1.status
  S.run1Status = safeStatus(run1Data.status)
  S.run1UnresolvedBlocking = safeCount(run1Data.unresolvedBlockingExceptionCount)
  S.run1Created = projectCounts(run1Data.created, ['lines', 'exceptions', 'run'])
  S.run1InvariantHolds = readyInvariantHolds(run1Data)
  must('generation run 1 -> 201 partial: created.lines === 1 (NON-EMPTY prep line) + 2 blocking exceptions',
    run1.ok && run1Data.status === 'partial' && run1Data.ready === false && S.run1UnresolvedBlocking === 2 &&
    run1Data.created?.lines === 1 && run1Data.created?.exceptions === 2 && run1Data.created?.run === 1,
    `http=${run1.status} status=${S.run1Status} created=${S.run1Created} unresolved=${S.run1UnresolvedBlocking}`)
  must('generation run 1 ready/unresolvedBlocking INVARIANT holds', S.run1InvariantHolds, `invariant=${S.run1InvariantHolds}`)
  if (!run1.ok) return finish(true, args)

  const prepLines1 = await req(`${API}/prep-lines${scope({ projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId })}`, { label: 'prep-lines-1' })
  const prepRows1 = Array.isArray(prepLines1.body?.data?.rows) ? prepLines1.body.data.rows : []
  S.prepLines1Http = prepLines1.status
  S.prepLines1RowCount = safeCount(prepLines1.body?.data?.rowCount)
  S.prepLines1ProjectionValid = prepLineRowProjectionValid(prepRows1)
  must('prepLineRows>0: prep-line list rowCount 1 after the first run',
    prepLines1.ok && S.prepLines1RowCount === 1 && prepRows1.length === 1,
    `http=${prepLines1.status} rows=${S.prepLines1RowCount}`)
  must('prep-line rows use the closed values-free projection', S.prepLines1ProjectionValid, `keysValid=${S.prepLines1ProjectionValid}`)
  must('the generated prep line is fully resolved (draft/matched/converted, qty + ERP target present)',
    prepRows1.length === 1 && prepLineRowResolved(prepRows1[0]))

  // ── 7. exception lane: both uncached drawings raised missing_mapping ─────────────────────────
  const exceptionsQuery = scope({ projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId })
  const excList1 = await req(`${API}/exceptions${exceptionsQuery}`, { label: 'exceptions-1' })
  const excData1 = excList1.body?.data || {}
  const excRows1 = Array.isArray(excData1.rows) ? excData1.rows : []
  const openMissingMapping = excRows1.filter((row) => row.exceptionType === 'missing_mapping' && row.status === 'open')
  S.exceptions1RowCount = safeCount(excData1.rowCount)
  S.exceptions1UnresolvedBlocking = safeCount(excData1.unresolvedBlockingCount)
  must('exception queue: 2 open blocking missing_mapping rows',
    excList1.ok && S.exceptions1RowCount === 2 && S.exceptions1UnresolvedBlocking === 2 && openMissingMapping.length === 2,
    `http=${excList1.status} rows=${S.exceptions1RowCount} missingMapping=${openMissingMapping.length}`)
  must('exception rows never carry the message cell', excRows1.every((row) => !('message' in row)))
  if (openMissingMapping.length !== 2) return finish(true, args)

  // ── 8. close the gap through the cache: sync MB+MC -> re-sync candidates -> confirm -> resolve ─
  const erpSyncBC = await req(`${API}/mvp/erp-materials/sync${scope()}`, {
    method: 'POST',
    body: { syncRunId: `smoke_t4_erprun_bc_${salt}`, erpMaterials: [fixture.materialB, fixture.materialC] },
    accept: [201], label: 'erp-materials-sync-bc',
  })
  const erpSyncBCData = erpSyncBC.body?.data || {}
  S.erpSyncBCCreated = projectCounts(erpSyncBCData.created, ['materials', 'run'])
  must('ERP cache sync B+C -> 201 created {materials:2}',
    erpSyncBC.ok && erpSyncBCData.mode === 'created' && erpSyncBCData.created?.materials === 2,
    `http=${erpSyncBC.status} created=${S.erpSyncBCCreated}`)

  const sync2 = await req(`${API}/material-mappings/candidates/sync${scope()}`, { method: 'POST', body: candidatesSyncBody, accept: [201], label: 'mapping-candidates-sync-2' })
  const sync2Data = sync2.body?.data || {}
  S.candidatesSync2Created = safeCount(sync2Data.created?.mappings)
  S.candidatesSync2SkippedExisting = safeCount(sync2Data.skipped?.existing)
  must('candidates re-sync after cache refresh -> 201 created 2 NEW exact-code candidates (A re-emits skipped)',
    sync2.ok && sync2Data.mode === 'created' && S.candidatesSync2Created === 2 && S.candidatesSync2SkippedExisting === 1,
    `http=${sync2.status} created=${S.candidatesSync2Created} skippedExisting=${S.candidatesSync2SkippedExisting}`)

  const post2 = await candidateRows('mapping-candidates-post-sync-2')
  const sync2Ids = newIds(post1.ids, post2.ids)
  const sync2Rows = post2.rows.filter((row) => sync2Ids.includes(row.mappingId))
  const cacheDrivenBC = sync2Rows.filter((row) => row.matchMethod === 'exact_code_candidate' && row.matchStatus === 'pending_confirm' && row.hasErpTarget === true)
  S.cacheDrivenBC = cacheDrivenBC.length
  must('the refreshed cache drove BOTH new candidates (exact_code_candidate with ERP target)',
    sync2Ids.length === 2 && cacheDrivenBC.length === 2, `captured=${sync2Ids.length} cacheDriven=${S.cacheDrivenBC}`)
  if (cacheDrivenBC.length !== 2) return finish(true, args)

  let confirmedBC = 0
  for (const row of cacheDrivenBC) {
    const confirm = await req(`${API}/material-mappings/confirm${scope()}`, {
      method: 'POST', body: { projectId: fixture.projectId, mappingId: row.mappingId },
      accept: [200], label: 'mapping-confirm-bc',
    })
    if (confirm.ok && confirm.body?.data?.mode === 'confirmed') confirmedBC += 1
    must('confirm cache-driven candidate (B/C) by mappingId -> 200 confirmed',
      confirm.ok && confirm.body?.data?.mode === 'confirmed', `http=${confirm.status} mode=${safeMode(confirm.body?.data?.mode)}`)
  }
  S.confirmedBC = confirmedBC

  // Resolve the two exceptions through BOTH resolve surfaces (single + bulk), same-reason
  // mapping_confirmed — the human statement matching what actually closed the gap.
  const resolveSingle = await req(`${API}/exceptions/resolve${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, exceptionId: openMissingMapping[0].exceptionId, resolutionAction: 'mapping_confirmed' },
    label: 'exception-resolve',
  })
  S.resolveSingleMode = safeMode(resolveSingle.body?.data?.mode)
  must('single exception resolve (mapping_confirmed) -> 200 resolved',
    resolveSingle.ok && S.resolveSingleMode === 'resolved', `http=${resolveSingle.status} mode=${S.resolveSingleMode}`)

  const resolveBulk = await req(`${API}/exceptions/bulk-resolve${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, exceptionIds: [openMissingMapping[1].exceptionId], resolutionAction: 'mapping_confirmed' },
    label: 'exception-bulk-resolve',
  })
  const resolveBulkData = resolveBulk.body?.data || {}
  S.resolveBulkResolved = safeCount(resolveBulkData.resolved)
  must('bulk exception resolve (same-reason mapping_confirmed) -> 200 resolved 1',
    resolveBulk.ok && resolveBulkData.mode === 'resolved' && resolveBulkData.resolved === 1 && resolveBulkData.exceptionType === 'missing_mapping',
    `http=${resolveBulk.status} resolved=${S.resolveBulkResolved}`)

  // ── 9. generation run 2: the FULL ready flip — 3/3 lines, zero unresolved blocking ───────────
  const run2 = await req(`${API}/generation/run${scope()}`, { method: 'POST', body: generationBody, accept: [201], label: 'generation-run-2' })
  const run2Data = run2.body?.data || {}
  S.run2Http = run2.status
  S.run2Status = safeStatus(run2Data.status)
  S.run2Ready = run2Data.ready === true
  S.run2UnresolvedBlocking = safeCount(run2Data.unresolvedBlockingExceptionCount)
  S.run2Created = projectCounts(run2Data.created, ['lines', 'exceptions', 'run'])
  S.run2PatchedLines = safeCount(run2Data.patched?.lines)
  S.run2InvariantHolds = readyInvariantHolds(run2Data)
  S.unresolvedBlockingFlipped = S.run1UnresolvedBlocking > 0 && S.run2UnresolvedBlocking === 0
  must('generation run 2 -> 201 READY: engine ready, ready === true, 2 new lines + line A refreshed',
    run2.ok && run2Data.status === 'ready' && run2Data.ready === true && S.run2UnresolvedBlocking === 0 &&
    run2Data.created?.lines === 2 && run2Data.created?.exceptions === 0 && run2Data.patched?.lines === 1,
    `http=${run2.status} status=${S.run2Status} created=${S.run2Created} patchedLines=${S.run2PatchedLines}`)
  must('unresolved-blocking count FLIPPED >0 -> 0 across cache+confirm+resolve+re-run',
    S.unresolvedBlockingFlipped, `flip=${S.unresolvedBlockingFlipped}`)
  must('generation run 2 ready/unresolvedBlocking INVARIANT holds', S.run2InvariantHolds, `invariant=${S.run2InvariantHolds}`)

  const prepLines2 = await req(`${API}/prep-lines${scope({ projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId })}`, { label: 'prep-lines-2' })
  const prepData2 = prepLines2.body?.data || {}
  const prepRows2 = Array.isArray(prepData2.rows) ? prepData2.rows : []
  S.prepLines2RowCount = safeCount(prepData2.rowCount)
  S.prepLines2Matched = safeCount(prepData2.byMappingStatus?.matched)
  S.prepLines2Converted = safeCount(prepData2.byUnitStatus?.converted)
  S.prepLines2ProjectionValid = prepLineRowProjectionValid(prepRows2)
  must('prep-line list after the ready run: 3/3 rows, all matched + converted, closed projection',
    prepLines2.ok && S.prepLines2RowCount === 3 && prepRows2.length === 3 &&
    S.prepLines2Matched === 3 && S.prepLines2Converted === 3 && S.prepLines2ProjectionValid &&
    prepRows2.every((row) => prepLineRowResolved(row)),
    `http=${prepLines2.status} rows=${S.prepLines2RowCount} matched=${S.prepLines2Matched} converted=${S.prepLines2Converted}`)

  const excList2 = await req(`${API}/exceptions${exceptionsQuery}`, { label: 'exceptions-2' })
  const excData2 = excList2.body?.data || {}
  S.exceptions2ResolvedCount = safeCount(excData2.byStatus?.resolved)
  S.exceptions2UnresolvedBlocking = safeCount(excData2.unresolvedBlockingCount)
  must('exception queue after the ready run: both rows resolved (human resolution preserved by the create-only re-run)',
    excList2.ok && S.exceptions2ResolvedCount === 2 && S.exceptions2UnresolvedBlocking === 0,
    `http=${excList2.status} resolved=${S.exceptions2ResolvedCount} unresolvedBlocking=${S.exceptions2UnresolvedBlocking}`)

  // ── 10. cleanup retires (also the mapping_retire / unit_retire audit actions) ─────────────────
  let retiredMappings = 0
  for (const mappingId of [...sync1Ids, ...sync2Ids]) {
    const retire = await req(`${API}/material-mappings/retire${scope()}`, {
      method: 'POST', body: { projectId: fixture.projectId, mappingId }, label: 'mapping-retire',
    })
    if (retire.ok && retire.body?.data?.mode === 'retired') retiredMappings += 1
    must('mapping retire -> 200 retired', retire.ok && retire.body?.data?.mode === 'retired',
      `http=${retire.status} mode=${safeMode(retire.body?.data?.mode)}`)
  }
  S.retiredMappings = retiredMappings

  const unitRetire = await req(`${API}/unit-conversions/retire${scope()}`, {
    method: 'POST', body: { projectId: fixture.projectId, conversionRuleId }, label: 'unit-retire',
  })
  S.unitRetireMode = safeMode(unitRetire.body?.data?.mode)
  must('unit rule retire -> 200 retired', unitRetire.ok && S.unitRetireMode === 'retired',
    `http=${unitRetire.status} mode=${S.unitRetireMode}`)

  // Cache hygiene: re-sync all 3 materials to materialStatus 'inactive' — ALSO the T2 upsert-patch
  // proof over HTTP (patched {materials:3}, zero creates, mode 'refreshed').
  const inactive = (material) => ({ ...material, materialStatus: 'inactive' })
  const erpRetire = await req(`${API}/mvp/erp-materials/sync${scope()}`, {
    method: 'POST',
    body: { syncRunId: `smoke_t4_erprun_retire_${salt}`, erpMaterials: [inactive(fixture.materialA), inactive(fixture.materialB), inactive(fixture.materialC)] },
    accept: [201], label: 'erp-materials-retire',
  })
  const erpRetireData = erpRetire.body?.data || {}
  S.erpRetireMode = safeMode(erpRetireData.mode)
  S.erpRetirePatched = projectCounts(erpRetireData.patched, ['materials', 'run'])
  must('cache hygiene re-sync -> refreshed (patched {materials:3}, no duplicate create)',
    erpRetire.ok && erpRetireData.mode === 'refreshed' && erpRetireData.patched?.materials === 3 && erpRetireData.created?.materials === 0,
    `http=${erpRetire.status} mode=${S.erpRetireMode} patched=${S.erpRetirePatched}`)

  // ── 11. audit: every one of the 8 closed-vocabulary actions left a scoped values-free row ─────
  let auditActionsCovered = 0
  for (const action of AUDIT_ACTIONS) {
    const audit = await req(`${API}/audit${scope({ projectId: fixture.projectId, action, limit: 100 })}`, { label: `audit-${action}` })
    const entries = Array.isArray(audit.body?.data?.entries) ? audit.body.data.entries : []
    const covered = audit.ok && entries.length >= 1 && entries.every((entry) => entry.action === action && entry.projectId === fixture.projectId)
    if (covered) auditActionsCovered += 1
    must(`audit trail: ${action} left >=1 scoped row`, covered, `http=${audit.status} rows=${entries.length}`)
  }
  S.auditActionsCovered = `${auditActionsCovered}/${AUDIT_ACTIONS.length}`

  // ── 12. global leak scan over every collected (non-exempt) response body ─────────────────────
  const scanned = COLLECTED.filter((entry) => !entry.exempt)
  const exempted = COLLECTED.filter((entry) => entry.exempt)
  const leakingLabels = scanned.filter((entry) => !leakScan(entry.body ?? {}, SELF_SCAN_SENTINELS)).map((entry) => entry.label)
  S.leakScanResponses = scanned.length
  S.leakScanExempted = exempted.length
  S.leakScanClean = leakingLabels.length === 0
  must('global leak scan: no fixture/engine-message sentinel in any response', leakingLabels.length === 0,
    leakingLabels.length ? `leaking=${leakingLabels.join(',')}` : `scanned=${scanned.length}`)
  must('exactly one leak-exempt response (the /plan same-origin echo)',
    exempted.length === 1 && exempted[0].label === 'sync-plan', `exempted=${exempted.length}`)

  return finish(failed, args)
}

function finish(failed, args) {
  const S = RESULT.summary
  // P2-2 backstop (same as W6): the OUTPUT itself is scanned against the run's sentinels before it
  // is emitted; a hit means the sanitizing layer was bypassed and the run must FAIL.
  S.selfScanClean = leakScan({ summary: S, checks: RESULT.checks }, SELF_SCAN_SENTINELS)
  S.externalWrite = false // structural: no route this smoke touches can reach an external system
  S.pass = !failed && RESULT.checks.every((c) => c.ok) && S.selfScanClean === true
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
    process.stderr.write(`[t4-smoke] fatal: ${error && error.name ? error.name : 'Error'}\n`)
    RESULT.summary.pass = false
    RESULT.summary.fatal = true
    process.stdout.write(`${formatSummaryBlock(RESULT.summary)}\n`)
    process.exitCode = 1
  })
}
