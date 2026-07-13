#!/usr/bin/env node
'use strict'

// Stock-preparation MVP (#3751) — post-deploy E2E smoke over the W2..W5b HTTP surface.
//
// Exercises the whole internal MVP chain against a DEPLOYED environment over real HTTP with a
// self-contained, per-run-salted fixture (no external PLM/K3/ERP dependency):
//   provisioning  : mvp/readiness -> mvp/ensure (idempotent) -> mvp/options/sync (fixture vocabulary)
//   snapshot      : sync/plan (fixture expansionResult) -> sync/persist (201) -> persist replay
//                   (200 skipped_existing = idempotency + immutability proof)
//   reads         : snapshot-batches list (incomplete=false) -> diff (count-shaped) -> diff/rows
//                   (closed 11-key projection)
//   mappings      : candidates/sync (explicit defaultVersionPolicy) -> candidates list -> confirm
//                   (create mode, BOTH ERP identifiers) -> re-sync -> human_preserved survival proof
//                   (confirmed row untouched: matchStatus/confirmed unchanged, no duplicate row)
//   units         : candidates (COMPUTED, values stripped) -> confirm (manual rule mode)
//   generation    : run -> ready/unresolvedBlockingExceptionCount INVARIANT -> exceptions list ->
//                   single resolve + bulk resolve (explicit actions) -> re-run: unresolved-blocking
//                   flips >0 -> 0 while the human resolution SURVIVES the create-only re-run
//   audit         : all 8 closed-vocabulary actions each leave a values-free trail row
//   fail-closed   : 6 probes with exact status+code (bad defaultVersionPolicy 400 · body confirmedBy
//                   400 · ghost base 404 · ghost current + explicit base 404 · mixed-type
//                   bulk-resolve 409 · unknown resolutionAction 400)
//   leak scan     : every response body is collected and scanned for the fixture sentinels (drawing
//                   numbers / units / quantities / paths / ERP identifiers) plus the engine's stored
//                   exception-message texts — any hit is a FAIL. Evidence KEY NAMES (field-key lists)
//                   are allowed; sentinel VALUES are not. The ONLY exempt response is /mvp/sync/plan:
//                   its body is a preview that legitimately echoes the caller's OWN fixture input
//                   (same-origin echo, not stored-data egress); the exemption is counted and asserted
//                   to stay at exactly 1.
//
// Mirrors scripts/ops/integration-composition-postdeploy-smoke.mjs idiom-for-idiom (arg parsing,
// requestJson helper, values-free evidence collection, summary block, PASS/FAIL exit; #3600 leak-scan
// discipline).
//
// Values-free output discipline — BY CONSTRUCTION (P2-2, #4038 review): a response-sourced string
// never reaches the summary / check details verbatim. Every one passes a precise registration set
// (error codes / modes / statuses / field names) and prints '<unregistered>' when foreign; count
// objects are projected key-by-key through Number(); handles print only when they match the platform
// handle shapes; and finish() self-scans the composed summary + checks against the run's sentinels
// before emitting anything. So even a server that echoed a drawing number into `mode` or `code`
// (the owner's demonstrated path) cannot get that value into this script's output.
//
// Honesty note (documented deviation, not a gap): a full generation ready:true flip needs a matching
// erp_material_master row, and this module deliberately exposes NO HTTP write surface for that table
// (readonly-MVP boundary). So the generation proof pinned here is the server-side INVARIANT
// (ready === engine-ready AND zero unresolved blocking) plus the unresolved-blocking >0 -> 0 flip
// across resolve + re-run with the human resolution preserved. The engine status itself stays
// 'blocked' by design of the fixture.
//
// Serial-run assumption: candidate-row cleanup attributes new mapping ids via a before/after diff of
// the candidates list; dispatch this smoke serially (it is a manual workflow_dispatch lane). Each
// COMPLETED run retires every row it created (mapping candidates + confirmed mapping + unit rule), so
// tenant-level tables do not accumulate active smoke rows.

import fs from 'node:fs'
import path from 'node:path'

const RESULT = { checks: [], summary: {} }
// Every response body (except the counted /plan exemption) lands here for the final leak scan.
const COLLECTED = []
// Set by main() once the fixture exists; finish() self-scans the composed summary + checks against
// these before writing anything (P2-2 backstop on top of the sanitizing output layer).
let SELF_SCAN_SENTINELS = []

const API = '/api/integration/stock-preparation'

// The closed per-row projection of GET .../diff/rows (shape-lock against the W3 route contract).
export const DIFF_ROW_KEYS = Object.freeze([
  'diffId',
  'diffType',
  'reviewStatus',
  'changeTypes',
  'reason',
  'rowCount',
  'previousSnapshotLineId',
  'currentSnapshotLineId',
  'keyFingerprint',
  'previousPathKeyFingerprint',
  'currentPathKeyFingerprint',
])

// The closed W5b audit action vocabulary — all 8 are triggered by this chain and each must leave a row.
export const AUDIT_ACTIONS = Object.freeze([
  'mapping_candidates_sync',
  'mapping_confirm',
  'mapping_retire',
  'unit_confirm',
  'unit_retire',
  'generation_run',
  'exception_resolve',
  'exception_bulk_resolve',
])

// The generation engine's STORED exception-message texts (platform constants). They live in the
// exception table's `message` cell and must NEVER cross any read surface of this chain.
export const ENGINE_MESSAGE_SENTINELS = Object.freeze([
  'BOM line is marked as missing child BOM',
  'BOM line design quantity is missing or invalid',
  'BOM line does not have a unique confirmed material mapping',
  'Confirmed material mapping does not resolve to an ERP/K3 material master row',
  'BOM line does not have a unique confirmed unit conversion rule',
  'BOM line quantity or conversion factor is invalid',
])

// ── P2-2 (#4038 review): values-free-by-construction OUTPUT layer ─────────────────────────────────
// A response-sourced string NEVER flows to the summary / check details verbatim. Every one passes a
// PRECISE registration set first (error codes / modes / statuses / field names); anything outside its
// registry is replaced by the '<unregistered>' placeholder — the assertion still fails, but the
// output cannot carry the foreign value. Count objects are projected key-by-key through Number()
// (unknown keys dropped; a response fragment is never stringified wholesale), and handles print only
// when they match the platform handle shapes. As a final backstop, finish() self-scans the composed
// summary + checks output against the run's sentinels before writing it.
// Equivalence note: for a literal L inside a registry, safeX(v) === L  <=>  v === L (safeX returns v
// only when v is registered), so asserting on the sanitized value is exactly as strict as on the raw.

export const UNREGISTERED = '<unregistered>'
export const MISSING = '<missing>'

// Every error code of the module families this smoke can touch, enumerated from the plugin sources
// (STOCK_PREPARATION_* / CONFIRM_* / GENERATION_* / EXCEPTION_* / SNAPSHOT_* / SYNC_RUN_PLAN_* /
// PERSIST_* / MVP_* / OPTION_SYNC_* / AUDIT_* / TENANT_*) plus the generic auth/route codes. An
// unknown code prints as '<unregistered>'.
export const ALLOWED_ERROR_CODES = Object.freeze(new Set([
  'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL_ERROR',
  'TENANT_REQUIRED', 'TENANT_MISMATCH', 'TENANT_CONTEXT_REQUIRED',
  'AUDIT_ACTION_INVALID', 'AUDIT_CONFIG_INVALID', 'AUDIT_DETAIL_INVALID', 'AUDIT_STORE_UNAVAILABLE',
  'CONFIRM_BATCH_INCOMPLETE', 'CONFIRM_BATCH_NOT_FOUND', 'CONFIRM_CONFIG_INVALID', 'CONFIRM_KEY_AMBIGUOUS',
  'CONFIRM_MAPPING_FIELDS_INVALID', 'CONFIRM_MAPPING_INACTIVE', 'CONFIRM_MAPPING_NOT_FOUND',
  'CONFIRM_MAPPING_TARGET_INCOMPLETE', 'CONFIRM_MODE_AMBIGUOUS', 'CONFIRM_PERMISSION_DENIED',
  'CONFIRM_PROVISIONING_API_UNAVAILABLE', 'CONFIRM_READS_BATCH_NOT_FOUND', 'CONFIRM_READS_CONFIG_INVALID',
  'CONFIRM_READS_OBJECT_ID_NOT_MVP', 'CONFIRM_READS_PERMISSION_DENIED',
  'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'CONFIRM_READS_RECORDS_API_INVALID',
  'CONFIRM_READS_RECORDS_API_UNAVAILABLE', 'CONFIRM_READS_RESULT_TOO_LARGE', 'CONFIRM_READS_ROWS_TOO_LARGE',
  'CONFIRM_READS_TEMPLATE_MISSING', 'CONFIRM_RECORDS_API_INVALID', 'CONFIRM_TARGET_NOT_PROVISIONED',
  'CONFIRM_TARGET_OBJECT_ID_INVALID', 'CONFIRM_TEMPLATE_MISSING', 'CONFIRM_UNIT_CANDIDATE_NOT_FOUND',
  'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'CONFIRM_UNIT_RULE_INACTIVE', 'CONFIRM_UNIT_RULE_NOT_FOUND',
  'CONFIRM_UNIT_RULE_SOURCE_UNCONFIRMABLE', 'CONFIRM_VERSION_POLICY_INVALID',
  'EXCEPTION_BULK_IDS_INVALID', 'EXCEPTION_BULK_MIXED_TYPES', 'EXCEPTION_BULK_TOO_LARGE',
  'EXCEPTION_NOT_FOUND', 'EXCEPTION_RESOLUTION_ACTION_INVALID',
  'GENERATION_BATCH_INCOMPLETE', 'GENERATION_BATCH_NOT_FOUND', 'GENERATION_CONFIG_INVALID',
  'GENERATION_KEY_AMBIGUOUS', 'GENERATION_PERMISSION_DENIED', 'GENERATION_PROVISIONING_API_UNAVAILABLE',
  'GENERATION_READS_RESULT_TOO_LARGE', 'GENERATION_RECORDS_API_INVALID', 'GENERATION_TARGET_NOT_PROVISIONED',
  'GENERATION_TARGET_OBJECT_ID_INVALID', 'GENERATION_TEMPLATE_MISSING',
  'MVP_OPTION_SYNC_API_UNAVAILABLE', 'MVP_TARGET_CONFIG_INVALID', 'MVP_TARGET_OBJECT_ID_INVALID',
  'MVP_TARGET_SCHEMA_INCOMPLETE',
  'OPTION_SYNC_AMBIGUOUS_OPTION', 'OPTION_SYNC_API_UNAVAILABLE', 'OPTION_SYNC_CONFIG_INVALID',
  'OPTION_SYNC_EXECUTABLE_REJECTED', 'OPTION_SYNC_FIELD_PATCH_FAILED', 'OPTION_SYNC_NO_FIELDS',
  'OPTION_SYNC_PERMISSION_DENIED', 'OPTION_SYNC_TARGET_NOT_READY', 'OPTION_SYNC_UNKNOWN_SOURCE',
  'PERSIST_CONFIG_INVALID', 'PERSIST_PERMISSION_DENIED', 'PERSIST_PROVISIONING_API_UNAVAILABLE',
  'PERSIST_RECORDS_API_INVALID', 'PERSIST_TARGET_NOT_PROVISIONED', 'PERSIST_TARGET_OBJECT_ID_INVALID',
  // #4163 T1: GET /projects (values-free project list) error vocabulary.
  'PROJECT_READS_CONFIG_INVALID', 'PROJECT_READS_OBJECT_ID_NOT_MVP', 'PROJECT_READS_PERMISSION_DENIED',
  'PROJECT_READS_PROVISIONING_API_UNAVAILABLE', 'PROJECT_READS_RECORDS_API_INVALID',
  'PROJECT_READS_RECORDS_API_UNAVAILABLE', 'PROJECT_READS_ROWS_TOO_LARGE', 'PROJECT_READS_TEMPLATE_MISSING',
  'STOCK_PREPARATION_PROJECT_LIST_REQUEST_INVALID',
  'SNAPSHOT_DIFF_BASE_INVALID', 'SNAPSHOT_DIFF_BASE_NOT_FOUND', 'SNAPSHOT_DIFF_BASE_PROJECT_MISMATCH',
  'SNAPSHOT_READS_CONFIG_INVALID', 'SNAPSHOT_READS_OBJECT_ID_NOT_MVP',
  'SNAPSHOT_READS_PROVISIONING_API_UNAVAILABLE', 'SNAPSHOT_READS_RECORDS_API_INVALID',
  'SNAPSHOT_READS_RECORDS_API_UNAVAILABLE', 'SNAPSHOT_READS_RESULT_TOO_LARGE',
  'SNAPSHOT_READS_ROWS_TOO_LARGE', 'SNAPSHOT_READS_TEMPLATE_MISSING',
  'STOCK_PREPARATION_AUDIT_LIST_REQUEST_INVALID', 'STOCK_PREPARATION_EXCEPTION_BULK_RESOLVE_REQUEST_INVALID',
  'STOCK_PREPARATION_EXCEPTION_LIST_REQUEST_INVALID', 'STOCK_PREPARATION_EXCEPTION_RESOLVE_REQUEST_INVALID',
  'STOCK_PREPARATION_GENERATION_RUN_REQUEST_INVALID', 'STOCK_PREPARATION_MAPPING_CANDIDATES_REQUEST_INVALID',
  'STOCK_PREPARATION_MAPPING_CANDIDATES_SYNC_REQUEST_INVALID', 'STOCK_PREPARATION_MAPPING_CONFIRM_REQUEST_INVALID',
  'STOCK_PREPARATION_MAPPING_RETIRE_REQUEST_INVALID', 'STOCK_PREPARATION_MAPPING_SUMMARY_REQUEST_INVALID',
  'STOCK_PREPARATION_MVP_OPTION_SYNC_REQUEST_INVALID', 'STOCK_PREPARATION_MVP_PROVISIONING_API_UNAVAILABLE',
  'STOCK_PREPARATION_MVP_SYNC_PERSIST_REQUEST_INVALID', 'STOCK_PREPARATION_MVP_SYNC_PLAN_REQUEST_INVALID',
  'STOCK_PREPARATION_MVP_TARGET_REQUEST_INVALID', 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID',
  'STOCK_PREPARATION_PREP_LINE_LIST_REQUEST_INVALID', 'STOCK_PREPARATION_SNAPSHOT_BATCH_LIST_REQUEST_INVALID',
  'STOCK_PREPARATION_SNAPSHOT_DIFF_REQUEST_INVALID', 'STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_REQUEST_INVALID',
  'STOCK_PREPARATION_UNIT_CANDIDATES_REQUEST_INVALID', 'STOCK_PREPARATION_UNIT_CONFIRM_REQUEST_INVALID',
  'STOCK_PREPARATION_UNIT_RETIRE_REQUEST_INVALID', 'STOCK_PREPARATION_UNIT_SUMMARY_REQUEST_INVALID',
  'SYNC_RUN_PLAN_CONFIG_INVALID', 'SYNC_RUN_PLAN_FIELD_NOT_GROUNDED', 'SYNC_RUN_PLAN_PERMISSION_DENIED',
  'SYNC_RUN_PLAN_TEMPLATE_MISSING',
  'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'TABLE_ACTION_TARGET_SCOPE_VIOLATION',
]))

// The closed mode vocabulary of the write modules (persist / confirm-writes / generation-runtime).
export const ALLOWED_MODES = Object.freeze(new Set([
  'created', 'skipped_existing', 'confirmed', 'skipped_already_confirmed',
  'retired', 'skipped_inactive', 'resolved', 'skipped_already_resolved', 'refreshed',
]))

// The closed status vocabulary the asserted response fields draw from (design-doc closed sets).
export const ALLOWED_STATUS_VALUES = Object.freeze(new Set([
  'draft', 'active', 'superseded', 'rejected',
  'ready', 'blocked', 'partial', 'succeeded', 'failed', 'running',
  'open', 'resolved', 'ignored', 'deferred',
  'mapped', 'incomplete',
]))

// The closed request field-name vocabulary of the stock-preparation routes (body/query allowlists +
// create-mode sub-object keys) — the only names an error `details.field` may echo into our output.
export const ALLOWED_FIELD_NAMES = Object.freeze(new Set([
  'tenantId', 'workspaceId', 'projectId', 'baseId', 'objectIds', 'optionSets',
  'snapshotBatchId', 'baseSnapshotBatchId', 'reviewStatus', 'diffType', 'matchStatus',
  'defaultVersionPolicy', 'mappingId', 'mapping', 'notes', 'conversionRuleId', 'contextFingerprint',
  'rule', 'exceptionId', 'exceptionIds', 'resolutionAction', 'status', 'exceptionType', 'severity',
  'prepStatus', 'action', 'limit', 'confirmedBy', 'confirmedAt', 'resolvedBy', 'resolvedAt',
  'plmDrawingNo', 'plmVersion', 'plmMaterialName', 'plmSpec',
  'erpMaterialCode', 'erpMaterialInternalId', 'erpMaterialName', 'erpSpec', 'versionPolicy',
  'plmUnit', 'erpIssueUnit', 'conversionFactor', 'scopeType', 'scopeKey', 'lossRate', 'roundingRule',
  'minimumIssueQty', 'effectiveFrom', 'effectiveTo',
  'syncRunId', 'snapshotVersion', 'sourceSystem', 'expansionResult', 'previousSnapshotBatchId',
  'previousLines', 'readPlan', 'defaultDesignUnit', 'targetProjectId',
  // #4163 T1: the project-row populator's own request field NAMES (never their business VALUES).
  'sourceProjectNo', 'projectName',
]))

export function registeredValue(value, registry) {
  if (value === undefined || value === null || value === '') return MISSING
  return typeof value === 'string' && registry.has(value) ? value : UNREGISTERED
}

export function safeCode(value) { return registeredValue(value, ALLOWED_ERROR_CODES) }
export function safeMode(value) { return registeredValue(value, ALLOWED_MODES) }
export function safeStatus(value) { return registeredValue(value, ALLOWED_STATUS_VALUES) }
export function safeField(value) { return registeredValue(value, ALLOWED_FIELD_NAMES) }

// Numbers only: a non-numeric response value (including any poison string) collapses to -1.
export function safeCount(value) {
  if (value === undefined || value === null || typeof value === 'boolean') return -1
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : -1
}

// Key-by-key projection of a count object: KNOWN keys -> Number(); everything else dropped. A
// response fragment is never stringified wholesale.
export function projectCounts(object, keys) {
  const source = object && typeof object === 'object' && !Array.isArray(object) ? object : {}
  return keys.map((key) => `${key}:${safeCount(source[key])}`).join('|')
}

// A handle prints only when it matches the platform handle shapes: the smoke's own salted handles
// (smoke_*), the module's content-hash handles (stockprep_*), or a bare sha16.
export function safeHandle(value) {
  if (value === undefined || value === null || value === '') return MISSING
  if (typeof value !== 'string') return UNREGISTERED
  if (/^(?:stockprep|smoke)_[a-z0-9_]{1,80}$/.test(value)) return value
  if (/^[0-9a-f]{16}$/.test(value)) return value
  return UNREGISTERED
}

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    tenantId: '',
    workspaceId: '',
    projectPrefix: 'stockprep-smoke',
    timeoutMs: 15000,
    outDir: '',
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
    else throw new Error(`unknown flag: ${flag}`)
  }
  if (!args.baseUrl) throw new Error('--base-url is required')
  return args
}

// Per-run salted, self-contained fixture. Everything value-bearing is salted so it can never collide
// with real business data, and every value doubles as a leak-scan sentinel.
export function buildSmokeFixture(salt, projectPrefix = 'stockprep-smoke') {
  const projectId = `${projectPrefix}-${salt}`
  const snapshotBatchId = `smoke_batch_${salt}`
  const syncRunId = `smoke_syncrun_${salt}`
  const drawingA = `SMKDWG-A-${salt}`
  const drawingB = `SMKDWG-B-${salt}`
  const pathA = `smkpath/${salt}/a`
  const pathB = `smkpath/${salt}/a/b`
  const unitPlm = `smku${salt}`
  const unitErp = `smke${salt}`
  const erpCodeA = `SMKERP-A-${salt}`
  const erpItemA = `SMKITM-A-${salt}`
  // #4163 T1: the project-row populator's own required/optional inputs. Both are business VALUES (a
  // human-readable PLM project number / name) that GET /projects must NEVER echo back — sentinels below.
  const sourceProjectNo = `SMKPRJNO-${salt}`
  const projectName = `Smoke Project ${salt}`
  // Quantities are leak-scan sentinels: 5-decimal values can never collide with an ISO timestamp's
  // 3-digit millisecond field (e.g. "…:53.512Z") or any count/confidence the reads legitimately emit.
  const qtyA = 7.03125
  const qtyB = 3.40625
  const expansionResult = {
    rows: [
      { componentSourceId: `OBJ_A_${salt}`, componentCode: drawingA, sourceVersion: 'V1', path: pathA, rawQuantity: qtyA, depth: 1 },
      { componentSourceId: `OBJ_B_${salt}`, parentSourceId: `OBJ_A_${salt}`, componentCode: drawingB, sourceVersion: 'V1', path: pathB, rawQuantity: qtyB, depth: 2 },
    ],
    rowErrors: [],
  }
  return {
    projectId,
    snapshotBatchId,
    syncRunId,
    drawingA,
    drawingB,
    unitPlm,
    unitErp,
    erpCodeA,
    erpItemA,
    sourceProjectNo,
    projectName,
    expansionResult,
    defaultDesignUnit: unitPlm,
    // Fixture sentinels: business VALUES that must never appear in any (non-exempt) response.
    sentinels: [
      drawingA, drawingB, pathA, pathB, unitPlm, unitErp, erpCodeA, erpItemA, String(qtyA), String(qtyB),
      sourceProjectNo, projectName,
    ],
  }
}

// Governance-vocabulary fixture for POST /mvp/options/sync — the full closed enum sets the design doc
// declares for every contract-sourced select field of the 9 frozen MVP tables. These are platform
// enum literals (design constants), not business values.
export function buildOptionSetsFixture() {
  const set = (values) => values.map((value) => ({ value }))
  return {
    stock_preparation_project_status_v1: set(['active', 'completed', 'archived']),
    stock_preparation_snapshot_status_v1: set(['draft', 'active', 'superseded', 'rejected']),
    stock_preparation_bom_line_status_v1: set(['active', 'inactive', 'incomplete']),
    stock_preparation_material_status_v1: set(['active', 'inactive', 'disabled']),
    stock_preparation_version_policy_v1: set(['drawing_and_version', 'drawing_only', 'category_rule', 'manual']),
    stock_preparation_match_status_v1: set(['matched', 'pending_confirm', 'multi_candidate', 'not_found', 'version_conflict']),
    stock_preparation_match_method_v1: set(['historical_confirmed', 'exact_code_candidate', 'normalized_code_candidate', 'name_spec_candidate', 'none', 'manual_confirm']),
    stock_preparation_unit_scope_type_v1: set(['material', 'category', 'generic']),
    stock_preparation_rounding_rule_v1: set(['none', 'ceil', 'floor', 'nearest', 'pack_size']),
    stock_preparation_unit_rule_source_v1: set(['manual', 'system_candidate']),
    stock_preparation_unit_status_v1: set(['converted', 'missing_rule', 'conflict']),
    stock_preparation_prep_status_v1: set(['draft', 'held']),
    stock_preparation_exception_type_v1: set(['missing_mapping', 'multi_candidate', 'version_conflict', 'erp_item_missing', 'unit_missing', 'unit_conflict', 'invalid_qty', 'missing_child_bom']),
    stock_preparation_exception_severity_v1: set(['info', 'warning', 'blocking']),
    stock_preparation_exception_status_v1: set(['open', 'resolved', 'ignored', 'deferred']),
    stock_preparation_resolution_action_v1: set(['mapping_confirmed', 'unit_rule_confirmed', 'accepted_change', 'manual_hold']),
    stock_preparation_run_type_v1: set(['plm_sync', 'erp_material_sync', 'mapping_match', 'unit_match', 'prep_generate']),
    stock_preparation_run_status_v1: set(['running', 'succeeded', 'failed', 'partial']),
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

// Shape-lock: every diff row must project ONLY the closed 11-key set.
export function diffRowProjectionValid(rows) {
  if (!Array.isArray(rows)) return false
  const allowed = new Set(DIFF_ROW_KEYS)
  return rows.every((row) => row && typeof row === 'object' && Object.keys(row).every((key) => allowed.has(key)))
}

// The W4a server-side invariant: ready === (engine status 'ready' AND zero unresolved blocking).
export function readyInvariantHolds(result) {
  if (!result || typeof result !== 'object') return false
  const unresolved = result.unresolvedBlockingExceptionCount
  if (typeof result.ready !== 'boolean' || typeof unresolved !== 'number') return false
  return result.ready === (result.status === 'ready' && unresolved === 0)
}

// Set difference helper (candidate-id attribution for cleanup): ids in `after` not present in `before`.
export function newIds(before, after) {
  const seen = new Set(before)
  return after.filter((id) => typeof id === 'string' && id.length > 0 && !seen.has(id))
}

export function formatSummaryBlock(summary) {
  const lines = ['STOCK_PREPARATION_MVP_POSTDEPLOY_SMOKE']
  for (const [key, value] of Object.entries(summary)) lines.push(`${key}=${value}`)
  return lines.join('\n')
}

function check(name, ok, detail = '') {
  RESULT.checks.push({ name, ok: ok === true, detail })
  const mark = ok === true ? 'ok' : 'FAIL'
  process.stderr.write(`[smoke] ${name}: ${mark}${detail ? ` (${detail})` : ''}\n`)
  return ok === true
}

async function requestJson(baseUrl, pathname, { token, timeoutMs, method = 'GET', body, accept = [200], label = '', leakExempt = false } = {}) {
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
  const fixture = buildSmokeFixture(salt, args.projectPrefix)
  const S = RESULT.summary
  let failed = false
  const must = (name, ok, detail) => { if (!check(name, ok, detail)) failed = true }
  const req = (pathname, options) => requestJson(args.baseUrl, pathname, { token, timeoutMs: args.timeoutMs, ...options })
  const scope = (extra) => scopeQuery(args, extra)
  SELF_SCAN_SENTINELS = [...fixture.sentinels, ...ENGINE_MESSAGE_SENTINELS]
  S.salt = salt

  // ── 0. auth round-trip (deploy SOP: a silent 401 usually means schema/token gap) ────────────────
  const status = await req(`/api/integration/status${scope()}`, { label: 'status' })
  S.statusHttp = status.status
  must('status auth round-trip', status.ok, `http=${status.status}`)
  if (!status.ok) return finish(failed, args)

  // ── 1. MVP provisioning: readiness -> ensure (idempotent) -> options/sync ────────────────────────
  const readiness1 = await req(`${API}/mvp/readiness${scope()}`, { label: 'mvp-readiness-pre' })
  S.readinessPreHttp = readiness1.status
  S.readinessPreReady = readiness1.body?.data?.ready === true
  S.readinessTableCount = safeCount(readiness1.body?.data?.evidence?.tableCount)
  must('mvp readiness pre http 200', readiness1.ok, `http=${readiness1.status}`)
  must('mvp readiness covers 9 frozen tables', S.readinessTableCount === 9, `tables=${S.readinessTableCount}`)

  const ensure = await req(`${API}/mvp/ensure${scope()}`, { method: 'POST', body: {}, accept: [200, 201], label: 'mvp-ensure' })
  S.ensureHttp = ensure.status
  S.ensureReady = ensure.body?.data?.ready === true
  S.ensureCreatedCount = safeCount(ensure.body?.data?.evidence?.createdCount)
  must('mvp ensure http 200/201 + ready', ensure.ok && S.ensureReady, `http=${ensure.status} created=${S.ensureCreatedCount}`)
  if (!ensure.ok || !S.ensureReady) return finish(true, args)

  const readiness2 = await req(`${API}/mvp/readiness${scope()}`, { label: 'mvp-readiness-post' })
  S.readinessPostHttp = readiness2.status
  S.readinessPostReady = readiness2.body?.data?.ready === true
  must('mvp readiness post-ensure ready', readiness2.ok && S.readinessPostReady, `http=${readiness2.status}`)

  const optionsSync = await req(`${API}/mvp/options/sync${scope()}`, {
    method: 'POST', body: { optionSets: buildOptionSetsFixture() }, label: 'mvp-options-sync',
  })
  S.optionsSyncHttp = optionsSync.status
  S.optionsSyncedFieldCount = safeCount(optionsSync.body?.data?.evidence?.syncedFieldCount)
  S.optionsSkippedFieldCount = safeCount(optionsSync.body?.data?.evidence?.skippedFieldCount)
  must('options sync http 200', optionsSync.ok, `http=${optionsSync.status}`)
  must('options sync covered every option field', S.optionsSyncedFieldCount > 0 && S.optionsSkippedFieldCount === 0,
    `synced=${S.optionsSyncedFieldCount} skipped=${S.optionsSkippedFieldCount}`)

  // ── 2. sync/plan -> sync/persist (201) -> persist replay (200 skipped_existing) ─────────────────
  const planBody = {
    projectId: fixture.projectId,
    syncRunId: fixture.syncRunId,
    snapshotBatchId: fixture.snapshotBatchId,
    snapshotVersion: 1,
    sourceSystem: 'plm_smoke',
    // #4163 T1: the project-row populator's own inputs. /plan ignores both (no project-row concept);
    // /persist (replaying the SAME body) upserts the project row from them.
    sourceProjectNo: fixture.sourceProjectNo,
    projectName: fixture.projectName,
    expansionResult: fixture.expansionResult,
    defaultDesignUnit: fixture.defaultDesignUnit,
  }
  // leakExempt: the plan response is a preview that echoes the caller's OWN fixture input (see header).
  const plan = await req(`${API}/mvp/sync/plan${scope()}`, { method: 'POST', body: planBody, label: 'sync-plan', leakExempt: true })
  const planData = plan.body?.data || {}
  S.planHttp = plan.status
  S.planSnapshotStatus = safeStatus(planData.snapshotBatch?.snapshotStatus)
  S.planRunStatus = safeStatus(planData.syncRun?.status)
  S.planLineCount = safeCount(planData.evidence?.mapping?.result?.lines)
  S.planHasFlags = planData.flags?.hasFlags === true
  must('sync plan http 200', plan.ok, `http=${plan.status}`)
  must('sync plan batch draft + run succeeded + 2 lines + no flags',
    S.planSnapshotStatus === 'draft' && S.planRunStatus === 'succeeded' && S.planLineCount === 2 && !S.planHasFlags,
    `status=${S.planSnapshotStatus} run=${S.planRunStatus} lines=${S.planLineCount} flags=${S.planHasFlags}`)
  if (!plan.ok) return finish(true, args)

  const persist = await req(`${API}/mvp/sync/persist${scope()}`, { method: 'POST', body: planBody, accept: [201], label: 'sync-persist' })
  const persistData = persist.body?.data || {}
  S.persistHttp = persist.status
  S.persistMode = safeMode(persistData.mode)
  // P2-2: key-by-key projection of the count object — never a wholesale stringify of the fragment.
  S.persistCreated = projectCounts(persistData.created, ['batch', 'lines', 'run'])
  must('sync persist -> 201 created {batch:1,lines:2,run:1}',
    persist.ok && persistData.persisted === true && persistData.mode === 'created' &&
    persistData.created?.batch === 1 && persistData.created?.lines === 2 && persistData.created?.run === 1,
    `http=${persist.status} mode=${S.persistMode} created=${S.persistCreated}`)
  if (!persist.ok) return finish(true, args)

  const replay = await req(`${API}/mvp/sync/persist${scope()}`, { method: 'POST', body: planBody, accept: [200], label: 'sync-persist-replay' })
  const replayData = replay.body?.data || {}
  S.persistReplayHttp = replay.status
  S.persistReplayMode = safeMode(replayData.mode)
  must('persist replay -> 200 skipped_existing (idempotency + immutability)',
    replay.ok && replayData.persisted === false && replayData.mode === 'skipped_existing' &&
    replayData.created?.batch === 0 && replayData.evidence?.existingBatchMatched === true,
    `http=${replay.status} mode=${S.persistReplayMode}`)

  // ── 2b. #4163 T1: GET /projects — the populator's project row landed, values-free ────────────────
  // Proves the FULL gap end-to-end against a real Postgres: the FE project-selector's endpoint (which
  // had NO server route before this) now returns the project the persist call above just populated,
  // and — the values-free hard boundary — never echoes fixture.sourceProjectNo / fixture.projectName
  // (both are registered sentinels; the global leak scan in step 10 re-proves this over EVERY response).
  const projectList = await req(`${API}/projects${scope()}`, { label: 'project-list' })
  const projectListData = projectList.body?.data || {}
  const ourProject = (projectListData.projects || []).find((entry) => entry.projectId === fixture.projectId) || null
  S.projectListHttp = projectList.status
  S.projectListCount = safeCount(projectListData.projectCount)
  S.projectStatus = safeStatus(ourProject ? ourProject.projectStatus : null)
  S.projectSnapshotBatchCount = ourProject ? safeCount(ourProject.snapshotBatchCount) : -1
  must('project list http 200 + the just-persisted project is present',
    projectList.ok && Boolean(ourProject), `http=${projectList.status} count=${S.projectListCount}`)
  must('project entry is values-free: active status + >=1 synced batch + a run handle, no business value keys',
    ourProject !== null && ourProject.projectStatus === 'active' && ourProject.snapshotBatchCount >= 1 &&
    typeof ourProject.lastSyncRunId === 'string' &&
    !('projectName' in ourProject) && !('sourceProjectNo' in ourProject),
    `status=${S.projectStatus} batches=${S.projectSnapshotBatchCount}`)

  // ── 3. snapshot-batches list -> diff (counts) -> diff/rows (11-key projection) ───────────────────
  const batchList = await req(`${API}/snapshot-batches${scope({ projectId: fixture.projectId })}`, { label: 'batch-list' })
  const batchData = batchList.body?.data || {}
  const ourBatch = (batchData.batches || []).find((entry) => entry.snapshotBatchId === fixture.snapshotBatchId) || null
  S.batchListHttp = batchList.status
  S.batchCount = safeCount(batchData.batchCount)
  S.batchIncomplete = ourBatch ? ourBatch.incomplete === true : null
  S.batchLineCount = ourBatch ? safeCount(ourBatch.lineCount) : -1
  // Response-sourced handle: printed only through the handle-shape gate (P2-2).
  S.batchHandle = safeHandle(ourBatch ? ourBatch.snapshotBatchId : null)
  must('batch list http 200 + fresh project has exactly this batch',
    batchList.ok && S.batchCount === 1 && Boolean(ourBatch),
    `http=${batchList.status} count=${S.batchCount}`)
  must('batch complete (run row + 2 lines)', ourBatch !== null && ourBatch.incomplete === false && ourBatch.lineCount === 2,
    `incomplete=${S.batchIncomplete} lines=${S.batchLineCount}`)

  const diff = await req(`${API}/snapshot-batches/${fixture.snapshotBatchId}/diff${scope()}`, { label: 'diff' })
  const diffData = diff.body?.data || {}
  S.diffHttp = diff.status
  S.diffBase = diffData.baseSnapshotBatchId === null ? 'null' : 'set'
  S.diffAdded = safeCount(diffData.changeCounts?.added)
  S.diffBlockingExceptions = safeCount(diffData.blockingExceptionCount)
  must('diff http 200: no predecessor, 2 added, 0 blocking exceptions',
    diff.ok && diffData.baseSnapshotBatchId === null && S.diffAdded === 2 && S.diffBlockingExceptions === 0,
    `http=${diff.status} base=${S.diffBase} added=${S.diffAdded} blocking=${S.diffBlockingExceptions}`)

  const diffRows = await req(`${API}/snapshot-batches/${fixture.snapshotBatchId}/diff/rows${scope()}`, { label: 'diff-rows' })
  const diffRowsData = diffRows.body?.data || {}
  const rows = Array.isArray(diffRowsData.rows) ? diffRowsData.rows : []
  S.diffRowsHttp = diffRows.status
  S.diffRowCount = safeCount(diffRowsData.rowCount)
  S.diffRowsProjectionValid = diffRowProjectionValid(rows)
  must('diff rows http 200 + rowCount 2', diffRows.ok && S.diffRowCount === 2 && rows.length === 2, `http=${diffRows.status} rows=${S.diffRowCount}`)
  must('diff rows closed 11-key projection', S.diffRowsProjectionValid, `keysValid=${S.diffRowsProjectionValid}`)
  must('diff rows are all added with vocabulary reviewStatus',
    rows.every((row) => row.diffType === 'added' && ['ready', 'held'].includes(row.reviewStatus)))

  // ── 4. material mappings: candidates/sync -> confirm (create) -> human_preserved survival ───────
  const candidateIds = async (label) => {
    const list = await req(`${API}/material-mappings/candidates${scope({ projectId: fixture.projectId })}`, { label })
    const listRows = Array.isArray(list.body?.data?.rows) ? list.body.data.rows : []
    return { response: list, ids: listRows.map((row) => row.mappingId).filter(Boolean), rows: listRows }
  }

  const pre = await candidateIds('mapping-candidates-pre')
  must('mapping candidates pre-sync http 200', pre.response.ok, `http=${pre.response.status}`)

  const candidatesSyncBody = { projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId, defaultVersionPolicy: 'drawing_only' }
  const sync1 = await req(`${API}/material-mappings/candidates/sync${scope()}`, { method: 'POST', body: candidatesSyncBody, accept: [201], label: 'mapping-candidates-sync-1' })
  const sync1Data = sync1.body?.data || {}
  S.candidatesSync1Http = sync1.status
  S.candidatesSync1Created = safeCount(sync1Data.created?.mappings)
  must('candidates sync -> 201 created 2 pending rows',
    sync1.ok && sync1Data.mode === 'created' && S.candidatesSync1Created === 2 && sync1Data.snapshotBatchId === fixture.snapshotBatchId,
    `http=${sync1.status} created=${S.candidatesSync1Created}`)

  const post1 = await candidateIds('mapping-candidates-post-sync')
  const createdCandidateIds = newIds(pre.ids, post1.ids)
  S.capturedCandidateIds = createdCandidateIds.length
  must('captured the 2 sync-created candidate ids (serial-run assumption)', createdCandidateIds.length === 2, `captured=${S.capturedCandidateIds}`)

  const confirmBody = {
    projectId: fixture.projectId,
    mapping: {
      plmDrawingNo: fixture.drawingA,
      plmVersion: 'V1',
      erpMaterialCode: fixture.erpCodeA,
      erpMaterialInternalId: fixture.erpItemA,
      versionPolicy: 'drawing_and_version',
    },
  }
  const confirm = await req(`${API}/material-mappings/confirm${scope()}`, { method: 'POST', body: confirmBody, accept: [201], label: 'mapping-confirm' })
  const confirmData = confirm.body?.data || {}
  const confirmedMappingId = confirmData.mappingId || ''
  S.mappingConfirmHttp = confirm.status
  S.mappingConfirmMode = safeMode(confirmData.mode)
  S.mappingConfirmHandle = safeHandle(confirmedMappingId)
  must('mapping confirm (create mode, both ERP ids) -> 201 created',
    confirm.ok && confirmData.mode === 'created' && Boolean(confirmedMappingId),
    `http=${confirm.status} mode=${S.mappingConfirmMode}`)

  const confirmReplay = await req(`${API}/material-mappings/confirm${scope()}`, { method: 'POST', body: confirmBody, accept: [200], label: 'mapping-confirm-replay' })
  S.mappingConfirmReplayMode = safeMode(confirmReplay.body?.data?.mode)
  must('mapping confirm replay -> 200 skipped_existing',
    confirmReplay.ok && S.mappingConfirmReplayMode === 'skipped_existing' && confirmReplay.body?.data?.mappingId === confirmedMappingId,
    `http=${confirmReplay.status} mode=${S.mappingConfirmReplayMode}`)

  const sync2 = await req(`${API}/material-mappings/candidates/sync${scope()}`, { method: 'POST', body: candidatesSyncBody, accept: [200], label: 'mapping-candidates-sync-2' })
  const sync2Data = sync2.body?.data || {}
  S.candidatesSync2Http = sync2.status
  S.candidatesSync2Mode = safeMode(sync2Data.mode)
  must('re-sync after confirm -> 200 skipped_existing (0 created, 2 skipped)',
    sync2.ok && sync2Data.mode === 'skipped_existing' && sync2Data.created?.mappings === 0 && sync2Data.skipped?.existing === 2,
    `http=${sync2.status} mode=${S.candidatesSync2Mode} skippedExisting=${safeCount(sync2Data.skipped?.existing)}`)

  const post2 = await candidateIds('mapping-candidates-post-resync')
  const confirmedRow = post2.rows.find((row) => row.mappingId === confirmedMappingId) || null
  const idsAfterResync = newIds(post1.ids, post2.ids)
  S.humanPreservedSurvived = Boolean(confirmedRow) && confirmedRow.matchStatus === 'matched' && confirmedRow.confirmed === true &&
    confirmedRow.matchMethod === 'manual_confirm' && confirmedRow.isActive === true && confirmedRow.hasErpTarget === true
  must('human_preserved survival: confirmed row untouched by re-sync (matched + confirmed + manual_confirm)',
    S.humanPreservedSurvived === true, `survived=${S.humanPreservedSurvived}`)
  must('re-sync created no new mapping rows beyond the human confirm',
    idsAfterResync.length === 1 && idsAfterResync[0] === confirmedMappingId, `newIds=${idsAfterResync.length}`)

  // ── 5. unit conversions: COMPUTED candidates -> confirm (manual rule mode) ───────────────────────
  const unitCandidates = await req(`${API}/unit-conversions/candidates${scope({ projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId })}`, { label: 'unit-candidates' })
  const unitData = unitCandidates.body?.data || {}
  const unitRows = Array.isArray(unitData.rows) ? unitData.rows : []
  S.unitCandidatesHttp = unitCandidates.status
  S.unitCandidateRowCount = safeCount(unitData.rowCount)
  must('unit candidates http 200 for this batch (computed)',
    unitCandidates.ok && unitData.snapshotBatchId === fixture.snapshotBatchId && S.unitCandidateRowCount >= 1,
    `http=${unitCandidates.status} rows=${S.unitCandidateRowCount}`)
  must('unit candidate rows are values-stripped (hasCandidate boolean, no candidateRule payload)',
    unitRows.length >= 1 &&
    unitRows.every((row) => typeof row.hasCandidate === 'boolean' && !('candidateRule' in row) && typeof row.outcome === 'string'))

  const unitConfirmBody = {
    projectId: fixture.projectId,
    rule: {
      plmUnit: fixture.unitPlm,
      erpIssueUnit: fixture.unitErp,
      conversionFactor: 2,
      scopeType: 'material',
      scopeKey: fixture.erpCodeA,
      roundingRule: 'none',
    },
  }
  const unitConfirm = await req(`${API}/unit-conversions/confirm${scope()}`, { method: 'POST', body: unitConfirmBody, accept: [201], label: 'unit-confirm' })
  const unitConfirmData = unitConfirm.body?.data || {}
  const conversionRuleId = unitConfirmData.conversionRuleId || ''
  S.unitConfirmHttp = unitConfirm.status
  S.unitConfirmMode = safeMode(unitConfirmData.mode)
  S.unitConfirmHandle = safeHandle(conversionRuleId)
  must('unit confirm (manual rule mode) -> 201 created',
    unitConfirm.ok && unitConfirmData.mode === 'created' && Boolean(conversionRuleId),
    `http=${unitConfirm.status} mode=${S.unitConfirmMode}`)

  const unitConfirmReplay = await req(`${API}/unit-conversions/confirm${scope()}`, { method: 'POST', body: unitConfirmBody, accept: [200], label: 'unit-confirm-replay' })
  S.unitConfirmReplayMode = safeMode(unitConfirmReplay.body?.data?.mode)
  must('unit confirm replay -> 200 skipped_existing',
    unitConfirmReplay.ok && S.unitConfirmReplayMode === 'skipped_existing',
    `http=${unitConfirmReplay.status} mode=${S.unitConfirmReplayMode}`)

  // ── 6. generation run -> invariant -> resolve (single + bulk) -> re-run flip ─────────────────────
  const generationBody = { projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId }
  const run1 = await req(`${API}/generation/run${scope()}`, { method: 'POST', body: generationBody, accept: [201], label: 'generation-run-1' })
  const run1Data = run1.body?.data || {}
  S.run1Http = run1.status
  S.run1Status = safeStatus(run1Data.status)
  S.run1Ready = run1Data.ready === true
  S.run1UnresolvedBlocking = safeCount(run1Data.unresolvedBlockingExceptionCount)
  S.run1InvariantHolds = readyInvariantHolds(run1Data)
  must('generation run 1 -> 201: engine blocked, 2 blocking exceptions, not ready',
    run1.ok && run1Data.status === 'blocked' && run1Data.ready === false && S.run1UnresolvedBlocking === 2 &&
    run1Data.created?.exceptions === 2 && run1Data.created?.lines === 0 && run1Data.created?.run === 1,
    `http=${run1.status} status=${S.run1Status} unresolved=${S.run1UnresolvedBlocking}`)
  must('generation run 1 ready/unresolvedBlocking INVARIANT holds', S.run1InvariantHolds, `invariant=${S.run1InvariantHolds}`)
  if (!run1.ok) return finish(true, args)

  const exceptionsQuery = scope({ projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId })
  const excList1 = await req(`${API}/exceptions${exceptionsQuery}`, { label: 'exceptions-1' })
  const excData1 = excList1.body?.data || {}
  const excRows1 = Array.isArray(excData1.rows) ? excData1.rows : []
  const missingMappingIds = excRows1.filter((row) => row.exceptionType === 'missing_mapping').map((row) => row.exceptionId)
  const erpItemMissingIds = excRows1.filter((row) => row.exceptionType === 'erp_item_missing').map((row) => row.exceptionId)
  S.exceptions1Http = excList1.status
  S.exceptions1RowCount = safeCount(excData1.rowCount)
  S.exceptions1UnresolvedBlocking = safeCount(excData1.unresolvedBlockingCount)
  must('exception queue: 2 open blocking rows, one per type',
    excList1.ok && S.exceptions1RowCount === 2 && S.exceptions1UnresolvedBlocking === 2 &&
    missingMappingIds.length === 1 && erpItemMissingIds.length === 1,
    `http=${excList1.status} rows=${S.exceptions1RowCount} missingMapping=${missingMappingIds.length} erpItemMissing=${erpItemMissingIds.length}`)
  must('exception rows never carry the message cell', excRows1.every((row) => !('message' in row)))
  if (missingMappingIds.length !== 1 || erpItemMissingIds.length !== 1) return finish(true, args)

  // PROBE: mixed-type bulk resolve refused fail-closed BEFORE any patch.
  const mixedBulk = await req(`${API}/exceptions/bulk-resolve${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, exceptionIds: [missingMappingIds[0], erpItemMissingIds[0]], resolutionAction: 'manual_hold' },
    accept: [409], label: 'probe-mixed-bulk-resolve',
  })
  S.probeMixedBulkHttp = mixedBulk.status
  S.probeMixedBulkCode = safeCode(mixedBulk.body?.error?.code)
  must('PROBE mixed-type bulk resolve -> 409 EXCEPTION_BULK_MIXED_TYPES',
    mixedBulk.ok && S.probeMixedBulkCode === 'EXCEPTION_BULK_MIXED_TYPES',
    `http=${mixedBulk.status} code=${S.probeMixedBulkCode}`)

  // PROBE: unknown resolutionAction refused by the closed vocabulary.
  const badAction = await req(`${API}/exceptions/resolve${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, exceptionId: missingMappingIds[0], resolutionAction: 'bogus_action' },
    accept: [400], label: 'probe-bad-resolution-action',
  })
  S.probeBadActionHttp = badAction.status
  S.probeBadActionCode = safeCode(badAction.body?.error?.code)
  must('PROBE unknown resolutionAction -> 400 EXCEPTION_RESOLUTION_ACTION_INVALID',
    badAction.ok && S.probeBadActionCode === 'EXCEPTION_RESOLUTION_ACTION_INVALID',
    `http=${badAction.status} code=${S.probeBadActionCode}`)

  const resolveSingle = await req(`${API}/exceptions/resolve${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, exceptionId: missingMappingIds[0], resolutionAction: 'manual_hold' },
    label: 'exception-resolve',
  })
  S.resolveSingleHttp = resolveSingle.status
  S.resolveSingleMode = safeMode(resolveSingle.body?.data?.mode)
  must('single resolve (explicit manual_hold) -> 200 resolved',
    resolveSingle.ok && S.resolveSingleMode === 'resolved',
    `http=${resolveSingle.status} mode=${S.resolveSingleMode}`)

  const resolveBulk = await req(`${API}/exceptions/bulk-resolve${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, exceptionIds: erpItemMissingIds, resolutionAction: 'accepted_change' },
    label: 'exception-bulk-resolve',
  })
  const resolveBulkData = resolveBulk.body?.data || {}
  S.resolveBulkHttp = resolveBulk.status
  S.resolveBulkResolved = safeCount(resolveBulkData.resolved)
  must('bulk resolve (same-reason, explicit accepted_change) -> 200 resolved 1',
    resolveBulk.ok && resolveBulkData.mode === 'resolved' && resolveBulkData.resolved === 1 && resolveBulkData.exceptionType === 'erp_item_missing',
    `http=${resolveBulk.status} resolved=${S.resolveBulkResolved}`)

  const run2 = await req(`${API}/generation/run${scope()}`, { method: 'POST', body: generationBody, accept: [200], label: 'generation-run-2' })
  const run2Data = run2.body?.data || {}
  S.run2Http = run2.status
  S.run2Status = safeStatus(run2Data.status)
  S.run2Ready = run2Data.ready === true
  S.run2UnresolvedBlocking = safeCount(run2Data.unresolvedBlockingExceptionCount)
  S.run2InvariantHolds = readyInvariantHolds(run2Data)
  S.unresolvedBlockingFlipped = S.run1UnresolvedBlocking > 0 && S.run2UnresolvedBlocking === 0
  must('generation re-run -> 200: resolutions survive create-only re-run (0 unresolved, 2 skipped)',
    run2.ok && S.run2UnresolvedBlocking === 0 && run2Data.created?.exceptions === 0 && run2Data.skipped?.exceptions === 2,
    `http=${run2.status} unresolved=${S.run2UnresolvedBlocking} skipped=${safeCount(run2Data.skipped?.exceptions)}`)
  must('unresolved-blocking count FLIPPED >0 -> 0 across resolve + re-run', S.unresolvedBlockingFlipped, `flip=${S.unresolvedBlockingFlipped}`)
  must('generation re-run ready/unresolvedBlocking INVARIANT holds', S.run2InvariantHolds, `invariant=${S.run2InvariantHolds}`)
  // Documented boundary: engine status stays 'blocked' (no erp_material_master write surface exists in
  // this module), so ready stays false BY THE INVARIANT — asserted, not glossed over.
  must('generation re-run engine verdict still blocked (no ERP master write surface); ready false by invariant',
    run2Data.status === 'blocked' && run2Data.ready === false,
    `status=${S.run2Status} ready=${S.run2Ready}`)

  const excList2 = await req(`${API}/exceptions${exceptionsQuery}`, { label: 'exceptions-2' })
  const excData2 = excList2.body?.data || {}
  S.exceptions2ResolvedCount = safeCount(excData2.byStatus?.resolved)
  S.exceptions2UnresolvedBlocking = safeCount(excData2.unresolvedBlockingCount)
  must('exception queue after re-run: both rows still resolved (human resolution preserved)',
    excList2.ok && S.exceptions2ResolvedCount === 2 && S.exceptions2UnresolvedBlocking === 0,
    `http=${excList2.status} resolved=${S.exceptions2ResolvedCount} unresolvedBlocking=${S.exceptions2UnresolvedBlocking}`)

  const prepLines = await req(`${API}/prep-lines${scope({ projectId: fixture.projectId })}`, { label: 'prep-lines' })
  S.prepLinesHttp = prepLines.status
  S.prepLineRowCount = safeCount(prepLines.body?.data?.rowCount)
  must('prep-line summary http 200 (blocked run created zero lines)',
    prepLines.ok && S.prepLineRowCount === 0, `http=${prepLines.status} rows=${S.prepLineRowCount}`)

  // ── 7. remaining fail-closed probes (exact status + code each) ───────────────────────────────────
  const badPolicy = await req(`${API}/material-mappings/candidates/sync${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, snapshotBatchId: fixture.snapshotBatchId, defaultVersionPolicy: 'bogus_policy' },
    accept: [400], label: 'probe-bad-version-policy',
  })
  S.probeBadPolicyHttp = badPolicy.status
  S.probeBadPolicyCode = safeCode(badPolicy.body?.error?.code)
  must('PROBE bad defaultVersionPolicy -> 400 CONFIRM_VERSION_POLICY_INVALID',
    badPolicy.ok && S.probeBadPolicyCode === 'CONFIRM_VERSION_POLICY_INVALID',
    `http=${badPolicy.status} code=${S.probeBadPolicyCode}`)

  const bodyConfirmedBy = await req(`${API}/material-mappings/confirm${scope()}`, {
    method: 'POST',
    body: { projectId: fixture.projectId, mappingId: `ghost_${salt}`, confirmedBy: 'smoke-operator' },
    accept: [400], label: 'probe-body-confirmedby',
  })
  S.probeConfirmedByHttp = bodyConfirmedBy.status
  S.probeConfirmedByCode = safeCode(bodyConfirmedBy.body?.error?.code)
  S.probeConfirmedByField = safeField(bodyConfirmedBy.body?.error?.details?.field)
  must('PROBE body-supplied confirmedBy -> 400 closed allowlist rejection',
    bodyConfirmedBy.ok && S.probeConfirmedByCode === 'STOCK_PREPARATION_MAPPING_CONFIRM_REQUEST_INVALID' && S.probeConfirmedByField === 'confirmedBy',
    `http=${bodyConfirmedBy.status} code=${S.probeConfirmedByCode} field=${S.probeConfirmedByField}`)

  const ghostBase = await req(`${API}/snapshot-batches/${fixture.snapshotBatchId}/diff${scope({ baseSnapshotBatchId: `ghost_${salt}` })}`, {
    accept: [404], label: 'probe-ghost-base',
  })
  S.probeGhostBaseHttp = ghostBase.status
  S.probeGhostBaseCode = safeCode(ghostBase.body?.error?.code)
  must('PROBE explicit ghost base id -> 404 SNAPSHOT_DIFF_BASE_NOT_FOUND',
    ghostBase.ok && S.probeGhostBaseCode === 'SNAPSHOT_DIFF_BASE_NOT_FOUND',
    `http=${ghostBase.status} code=${S.probeGhostBaseCode}`)

  const ghostCurrent = await req(`${API}/snapshot-batches/ghost_${salt}/diff${scope({ baseSnapshotBatchId: fixture.snapshotBatchId })}`, {
    accept: [404], label: 'probe-ghost-current',
  })
  S.probeGhostCurrentHttp = ghostCurrent.status
  S.probeGhostCurrentCode = safeCode(ghostCurrent.body?.error?.code)
  must('PROBE ghost current + explicit base -> 404 SNAPSHOT_DIFF_BASE_NOT_FOUND',
    ghostCurrent.ok && S.probeGhostCurrentCode === 'SNAPSHOT_DIFF_BASE_NOT_FOUND',
    `http=${ghostCurrent.status} code=${S.probeGhostCurrentCode}`)

  // ── 7z. T2: ERP material-master cache sync (POST /mvp/erp-materials/sync) ────────────────────────
  // Deployed-lane coverage of the T2 route: persist an ALREADY-NORMALIZED ERP material into the internal
  // erp_material_master cache, then re-sync to prove the idempotent upsert (patch, not a duplicate).
  // NON-PERTURBING by construction: erpCodeA (SMKERP-A-…) is a DIFFERENT value from the BOM drawings
  // (SMKDWG-A/B-…), so it matches no snapshot line and cannot change the mapping/generation steps above;
  // it runs AFTER them regardless. The response is values-free (counts/modes/objectId constants only),
  // so the step-10 global leak scan re-proves erpCodeA / erpItemA never cross. (The deep downstream proof
  // — confirm-writes reading the cache + the meta_fields physical-fieldId cross-check — lives in the
  // real-Postgres harness scripts/ops/stock-preparation-erp-material-sync-realdb-smoke.mjs.)
  const erpMaterialId = `smk_erpid_${salt}`
  const erpSyncBody = {
    syncRunId: `smk_erprun_${salt}`,
    erpMaterials: [{
      erpMaterialId,
      erpMaterialCode: fixture.erpCodeA,
      erpMaterialInternalId: fixture.erpItemA,
      materialStatus: 'active',
    }],
  }
  const erpSync = await req(`${API}/mvp/erp-materials/sync${scope()}`, { method: 'POST', body: erpSyncBody, accept: [201], label: 'erp-materials-sync' })
  const erpSyncData = erpSync.body?.data || {}
  S.erpSyncHttp = erpSync.status
  S.erpSyncMode = safeMode(erpSyncData.mode)
  S.erpSyncRunStatus = safeStatus(erpSyncData.runStatus)
  S.erpSyncCreated = projectCounts(erpSyncData.created, ['materials', 'run'])
  must('erp-materials sync -> 201 created {materials:1} runType succeeded',
    erpSync.ok && erpSyncData.persisted === true && erpSyncData.mode === 'created' &&
    erpSyncData.created?.materials === 1 && erpSyncData.runStatus === 'succeeded',
    `http=${erpSync.status} mode=${S.erpSyncMode} created=${S.erpSyncCreated}`)

  const erpResync = await req(`${API}/mvp/erp-materials/sync${scope()}`, { method: 'POST', body: erpSyncBody, accept: [201], label: 'erp-materials-resync' })
  const erpResyncData = erpResync.body?.data || {}
  S.erpResyncHttp = erpResync.status
  S.erpResyncMode = safeMode(erpResyncData.mode)
  S.erpResyncPatched = projectCounts(erpResyncData.patched, ['materials', 'run'])
  must('erp-materials re-sync -> refreshed (patched materials:1, no duplicate create)',
    erpResync.ok && erpResyncData.mode === 'refreshed' &&
    erpResyncData.patched?.materials === 1 && erpResyncData.created?.materials === 0,
    `http=${erpResync.status} mode=${S.erpResyncMode} patched=${S.erpResyncPatched}`)

  // ── 8. cleanup retires (also the mapping_retire / unit_retire audit actions) ─────────────────────
  let retiredMappings = 0
  for (const mappingId of [confirmedMappingId, ...createdCandidateIds]) {
    const retire = await req(`${API}/material-mappings/retire${scope()}`, {
      method: 'POST', body: { projectId: fixture.projectId, mappingId }, label: 'mapping-retire',
    })
    if (retire.ok && retire.body?.data?.mode === 'retired') retiredMappings += 1
    must('mapping retire -> 200 retired', retire.ok && retire.body?.data?.mode === 'retired', `http=${retire.status} mode=${safeMode(retire.body?.data?.mode)}`)
  }
  S.retiredMappings = retiredMappings

  const unitRetire = await req(`${API}/unit-conversions/retire${scope()}`, {
    method: 'POST', body: { projectId: fixture.projectId, conversionRuleId }, label: 'unit-retire',
  })
  S.unitRetireHttp = unitRetire.status
  S.unitRetireMode = safeMode(unitRetire.body?.data?.mode)
  must('unit rule retire -> 200 retired', unitRetire.ok && S.unitRetireMode === 'retired', `http=${unitRetire.status} mode=${S.unitRetireMode}`)

  // ── 9. audit trail: every triggered action left a values-free row for THIS run's project ────────
  let auditActionsCovered = 0
  for (const action of AUDIT_ACTIONS) {
    const audit = await req(`${API}/audit${scope({ projectId: fixture.projectId, action, limit: 100 })}`, { label: `audit-${action}` })
    const entries = Array.isArray(audit.body?.data?.entries) ? audit.body.data.entries : []
    const covered = audit.ok && entries.length >= 1 && entries.every((entry) => entry.action === action && entry.projectId === fixture.projectId)
    if (covered) auditActionsCovered += 1
    must(`audit trail: ${action} left >=1 scoped row`, covered, `http=${audit.status} rows=${entries.length}`)
  }
  S.auditActionsCovered = `${auditActionsCovered}/${AUDIT_ACTIONS.length}`

  // ── 10. global leak scan over every collected (non-exempt) response body ─────────────────────────
  const sentinels = SELF_SCAN_SENTINELS
  const scanned = COLLECTED.filter((entry) => !entry.exempt)
  const exempted = COLLECTED.filter((entry) => entry.exempt)
  const leakingLabels = scanned.filter((entry) => !leakScan(entry.body ?? {}, sentinels)).map((entry) => entry.label)
  S.leakScanResponses = scanned.length
  S.leakScanExempted = exempted.length
  S.leakScanClean = leakingLabels.length === 0
  must('global leak scan: no fixture/engine-message sentinel in any response', leakingLabels.length === 0,
    leakingLabels.length ? `leaking=${leakingLabels.join(',')}` : `scanned=${scanned.length}`)
  must('exactly one leak-exempt response (the /plan same-origin echo)', exempted.length === 1 && exempted[0].label === 'sync-plan',
    `exempted=${exempted.length}`)

  return finish(failed, args)
}

function finish(failed, args) {
  const S = RESULT.summary
  // P2-2 backstop: the OUTPUT itself (summary + checks, i.e. everything this run prints or writes)
  // is scanned against the run's sentinels BEFORE it is emitted. The sanitizing accessors make a hit
  // structurally impossible; a hit here means the output layer was bypassed and the run must FAIL.
  S.selfScanClean = leakScan({ summary: S, checks: RESULT.checks }, SELF_SCAN_SENTINELS)
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
    process.stderr.write(`[smoke] fatal: ${error && error.name ? error.name : 'Error'}\n`)
    RESULT.summary.pass = false
    RESULT.summary.fatal = true
    process.stdout.write(`${formatSummaryBlock(RESULT.summary)}\n`)
    process.exitCode = 1
  })
}
