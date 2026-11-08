// YiDa 发料确认日期回写 — THE WIRING of the Y9a core (slice Y9; design baseline v2.3 §7.3, frozen ⑦.4 plan §2.2).
//
// The core (yida-issue-confirm-writeback.cjs) takes every dependency as a port. This module builds the REAL ports from
// what the plugin already owns and hands them to the host runtime as ONE frozen capability (index.cjs → the runtime
// factory → the host owner runtime). It never constructs a runner, a form transport or a token client and imports none
// of them (pinned by __tests__/yida-issue-confirm-writeback-wiring.test.cjs), so a write-back can never cause a second
// form submission; it never writes the delivery ledger, its audit, a grant or an admission (it is handed no writer of
// them, and the plugin db it reads them through is append-only on the trace table alone, migration zzzz20261106093100).
//
// THE FIVE 未核实 ITEMS OF §7.3, AS RESOLVED BY READING THE CODE (the PR body carries the path:line evidence):
//   1. Project registry: table integration_stock_prep_project_target (migration 087), one row per (tenant_id,
//      project_no) with sheet_id / object_id / status; read through stockPreparationProjectTargetStore.get, which
//      projects { sheetId, objectId, status } (stock-preparation-project-target-store.cjs). The registered sheet is
//      the sheet the issue-confirm draft was bound to (the D21 re-authorization already requires it, check 1).
//   2. Multitable capability: the plugin's own context.api.multitable.records + .provisioning (the carry-confirm
//      precedent), scoped to the ONE registered sheet by createTargetScopedRecordsApi in logical translation (a
//      project-sheet objectId translates through the frozen main template, which carries issueConfirmDate since Y8).
//      What the plugin db cannot do — read users / user_roles / role_permissions — the HOST does: the live
//      re-check is supplied per call by the host runtime (packages/core-backend/src/integration/
//      yida-issue-confirm-writeback-authority.ts), never built here.
//   3. Host write fence: the patch carries guard.hostWriteFence() ({ lock, scopeKey, leaseId, fencingEpoch,
//      generationToken }, the allow-listed shape of packages/core-backend/src/multitable/plugin-write-fence.ts);
//      a records surface that does not declare supportsWriteFence is refused before any read (retryable).
//   4./5. Not wiring: an unbound generated row stays the compiler's refusal (no new code); the panel DTO is unchanged.
//
// THE TWO SWITCHES are read only by the core's own exact-literal predicates (issueConfirmWritebackEnabled /
// parseIssueConfirmTargetRefs), on every call; `enabled()` below is that same predicate, exposed so the host route
// can answer its generic 404 while OFF without a second reader of the variable.

import { types } from 'node:util'
import writebackModule from './yida-issue-confirm-writeback.cjs'
import tableActionsModule from './stock-preparation-table-actions.cjs'
import { createInternalYidaDraftTransactionReader } from './yida-draft-plan-store.mjs'

const {
  ISSUE_CONFIRM_TRACE_TABLE, YidaIssueConfirmWritebackError,
  createIssueConfirmTraceStore, createIssueConfirmWritebackExecutor, issueConfirmWritebackEnabled,
} = writebackModule
const { createTargetScopedRecordsApi } = tableActionsModule

export const ISSUE_CONFIRM_LEDGER_TABLE = 'integration_yida_delivery_ledger'
export const ISSUE_CONFIRM_LEDGER_AUDIT_TABLE = 'integration_yida_delivery_audit'
// The bounded batch: at most this many ledger rows of ONE listed target are scanned per run (pages of PAGE), so a run
// over a long history stays bounded; rows beyond it are reached by a later run (or named by ledgerIds).
export const ISSUE_CONFIRM_LEDGER_SCAN_CAP = 2000
const PAGE = 200
const ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u

function unavailable(message) {
  return new YidaIssueConfirmWritebackError('YIDA_ISSUE_CONFIRM_UNAVAILABLE', message)
}
function rowsOf(result) { return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [] }
function opaque(value) { return typeof value === 'string' && value === value.trim() && ID_RE.test(value) ? value : null }
function plainFunction(holder, name) {
  return Boolean(holder) && typeof holder[name] === 'function' && !types.isProxy(holder[name])
}
function iso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString()
  return null
}

/**
 * The ledger reader (§2.2 step 1): rows of exactly this (tenant, owner, workspace NULL), none already traced.
 *   ledgerIds given → those rows (any state: the decision skips what is not selected and records source_unbound for
 *                     a named unbound row); at most `limit`.
 *   otherwise       → per listed target, oldest first: acknowledged CREATE rows with a bound source_record_digest
 *                     (an unbound row is never in the batch, SR5), at most `limit`, at most SCAN_CAP scanned.
 * `acknowledgedAt` is the created_at of the row's ONE `acknowledgement` AUDIT row (the database clock), read only
 * for a row the first three selector conditions admit; never the ledger's updated_at, never "now".
 */
export function createIssueConfirmLedgerReader({ db }) {
  if (!plainFunction(db, 'select') || !plainFunction(db, 'selectOne')) throw unavailable('ledger reader needs db.select/selectOne')
  async function traced(ledgerId) {
    return Boolean(await db.selectOne(ISSUE_CONFIRM_TRACE_TABLE, { ledger_id: ledgerId }))
  }
  async function project(row, targetRefs) {
    const admitted = row.status === 'acknowledged' && row.intent === 'create' && targetRefs.includes(row.target_ref)
    let acknowledgedAt = null
    if (admitted) {
      const audit = await db.selectOne(ISSUE_CONFIRM_LEDGER_AUDIT_TABLE, { ledger_id: row.id, event: 'acknowledgement' })
      acknowledgedAt = audit ? iso(audit.created_at) : null
    }
    return Object.freeze({
      id: row.id, tenantId: row.tenant_id, ownerId: row.owner_id, targetRef: row.target_ref, status: row.status,
      intent: row.intent, sourceRecordDigest: row.source_record_digest ?? null, acknowledgedAt,
      operationId: row.operation_id, rowKey: row.row_key,
    })
  }
  async function list({ tenantId, ownerId, targetRefs, ledgerIds, limit }) {
    const scope = { tenant_id: tenantId, workspace_id: null, owner_id: ownerId }
    const out = []
    if (ledgerIds) {
      for (const id of ledgerIds) {
        if (out.length >= limit) break
        const row = await db.selectOne(ISSUE_CONFIRM_LEDGER_TABLE, { id, ...scope })
        if (!row || await traced(row.id)) continue
        out.push(await project(row, targetRefs))
      }
      return out
    }
    for (const targetRef of targetRefs) {
      let offset = 0
      while (out.length < limit && offset < ISSUE_CONFIRM_LEDGER_SCAN_CAP) {
        const page = rowsOf(await db.select(ISSUE_CONFIRM_LEDGER_TABLE, {
          where: { ...scope, target_ref: targetRef, status: 'acknowledged', intent: 'create' },
          orderBy: ['created_at', 'ASC'], limit: Math.min(PAGE, ISSUE_CONFIRM_LEDGER_SCAN_CAP - offset), offset,
        }))
        offset += page.length
        for (const row of page) {
          if (out.length >= limit) break
          if (row.source_record_digest === null || row.source_record_digest === undefined) continue
          if (await traced(row.id)) continue
          out.push(await project(row, targetRefs))
        }
        if (page.length < PAGE) break
      }
      if (out.length >= limit) break
    }
    return out
  }
  return Object.freeze({ list })
}

/**
 * The row values (§2.2 step 2): the ledger's (operation_id, row_key) unsealed and RE-COMPILED by the draft store's own
 * verified transaction reader (owner + scope lock, digest checks), then the planned row's payload, the compiled config
 * and the bound sheet of that row's source binding. A row whose recompiled source_record_digest is not the ledger's,
 * or that the operation no longer holds, answers null — the core treats that as retryable, never as source_unbound.
 */
export function createIssueConfirmRowSource({ db, security }) {
  if (!plainFunction(db, 'transaction')) throw unavailable('row source needs db.transaction')
  if (!plainFunction(security, 'decrypt') || !plainFunction(security, 'encrypt')) throw unavailable('row source needs security')
  async function read({ tenantId, ownerId, ledger }) {
    const reader = createInternalYidaDraftTransactionReader({ security, context: { tenantId, workspaceId: null, ownerId } })
    return db.transaction(async (trx) => {
      await trx.setTransactionIsolationLevel('read committed')
      const { compiled, members } = await reader(trx, { operationId: ledger.operationId })
      const member = members.find((entry) => entry.row_key === ledger.rowKey)
      if (!member) return null
      const spec = compiled.rowSpecs[member.ordinal]
      const planned = compiled.plan.rows[member.ordinal]
      if (!spec || !planned || !spec.sourceBinding || spec.sourceRecordDigest !== ledger.sourceRecordDigest) return null
      return { boundSheetId: spec.sourceBinding.sheetId, config: compiled.source.config, payload: planned.payload }
    })
  }
  return Object.freeze({ read })
}

/** The project registry (§2.2 step 3): null (unregistered) | { sheetId, objectId, status }. Throws on a store fault. */
export function createIssueConfirmProjectRegistry({ projectTargetStore }) {
  if (!plainFunction(projectTargetStore, 'get')) throw unavailable('project registry needs the project target store')
  async function resolve({ tenantId, projectNo }) {
    const row = await projectTargetStore.get({ tenantId, projectNo })
    if (!row) return null
    return Object.freeze({ sheetId: row.sheetId, objectId: row.objectId, status: row.status })
  }
  return Object.freeze({ resolve })
}

/**
 * The sheet (§2.2 step 4/5): the plugin's records API bound to the ONE registered sheet (createTargetScopedRecordsApi
 * refuses a call that names another sheet), logical field ids through the frozen main template, the tenant's
 * integration-core project for the field-id derivation (resolveIntegrationStagingProjectId's default). A surface
 * without the host write fence is refused: the patch must never run unfenced.
 */
export function createIssueConfirmSheets({ multitable }) {
  if (typeof multitable !== 'function') throw unavailable('sheets needs the multitable accessor')
  async function open({ tenantId, project }) {
    const api = multitable()
    const records = api && api.records
    const provisioning = api && api.provisioning
    if (!plainFunction(records, 'queryRecords') || !plainFunction(records, 'patchRecord') || records.supportsWriteFence !== true) {
      throw unavailable('the multitable records API with the host write fence is not available')
    }
    const scoped = await createTargetScopedRecordsApi(records, { sheetId: project.sheetId, objectId: project.objectId },
      { provisioning, projectId: `${tenantId}:integration-core` })
    return Object.freeze({
      queryRecords: (input) => scoped.queryRecords(input),
      patchRecord: (input) => scoped.patchRecord(input),
    })
  }
  return Object.freeze({ open })
}

/**
 * THE CAPABILITY handed to the host runtime (frozen, closed). `create({ context, recheck })` binds one owner scope and
 * the host's live re-check to a fresh executor; `enabled()` is the core's exact-literal switch predicate.
 */
export function createIssueConfirmWritebackCapability(options = {}) {
  const { db, security, projectTargetStore, projectWriteLock, multitable, logger } = options
  const env = options.env || process.env
  const ledgerReader = createIssueConfirmLedgerReader({ db })
  const rowSource = createIssueConfirmRowSource({ db, security })
  const projectRegistry = createIssueConfirmProjectRegistry({ projectTargetStore })
  const sheets = createIssueConfirmSheets({ multitable })
  const traceStore = createIssueConfirmTraceStore({ db })
  if (!plainFunction(projectWriteLock, 'withProjectWriteLease') || !plainFunction(projectWriteLock, 'bumpGeneration')
    || !plainFunction(projectWriteLock, 'scopeKeyFor')) throw unavailable('the sheet write lock is required')
  const writeLock = Object.freeze({
    scopeKeyFor: (sheetId) => projectWriteLock.scopeKeyFor(sheetId),
    withProjectWriteLease: (scopeKey, lease, fn) => projectWriteLock.withProjectWriteLease(scopeKey, lease, fn),
    bumpGeneration: (scopeKey, bump) => projectWriteLock.bumpGeneration(scopeKey, bump),
  })
  function enabled() { return issueConfirmWritebackEnabled(env) }
  function create(input) {
    if (!input || typeof input !== 'object' || types.isProxy(input)) throw unavailable('create needs { context, recheck }')
    const { context, recheck } = input
    const tenantId = opaque(context && context.tenantId)
    const ownerId = opaque(context && context.ownerId)
    if (!tenantId || !ownerId || typeof recheck !== 'function' || types.isProxy(recheck)) throw unavailable('create needs { context, recheck }')
    const executor = createIssueConfirmWritebackExecutor({
      env, logger, ledgerReader, rowSource, projectRegistry, sheets, writeLock, traceStore,
      // The host's live re-check (owner live integration admin, role-granted stock-prep code, sheet read) — the
      // executor calls it under the sheet write lease, right before the records read and the patch.
      authority: Object.freeze({ recheck: (scope) => recheck(Object.freeze({ ...scope })) }),
    })
    // The scope is the host's authenticated owner, never the caller's: a run names only ledger ids and a limit.
    async function run(request = {}) {
      const ledgerIds = request.ledgerIds
      const limit = request.limit
      return executor.run({ tenantId, ownerId, ...(ledgerIds === undefined ? {} : { ledgerIds }), ...(limit === undefined ? {} : { limit }) })
    }
    return Object.freeze({ run })
  }
  return Object.freeze({ enabled, create })
}
