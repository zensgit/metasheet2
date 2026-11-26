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
//      a records surface that does not declare supportsWriteFence is refused before any read (retryable); the flag is
//      copied onto the scoped api, and the core checks it again before its records read.
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
  ISSUE_CONFIRM_TRACE_TABLE, ISSUE_CONFIRM_WRITEBACK_MAX_BATCH, YidaIssueConfirmWritebackError,
  createIssueConfirmTraceStore, createIssueConfirmWritebackExecutor, issueConfirmWritebackEnabled,
} = writebackModule
const { createTargetScopedRecordsApi } = tableActionsModule

export const ISSUE_CONFIRM_LEDGER_TABLE = 'integration_yida_delivery_ledger'
export const ISSUE_CONFIRM_LEDGER_AUDIT_TABLE = 'integration_yida_delivery_audit'
// THE SWEEP PAGE (batch mode; the sweep itself is described in the core header). Bounded rows and statements; one pass
// over ledger and trace per target: per listed target, from the cursor's target onward in the listed order, ONE ledger
// statement (db.selectUnmatched with the keyset), asking for what is still missing of `limit` (1..100,
// ISSUE_CONFIRM_WRITEBACK_MAX_BATCH) plus ONE look-ahead row, then one acknowledgement-audit read per admitted row.
// Traced rows (the NOT EXISTS anti-join on the trace table) and unbound rows (source_record_digest IS NOT NULL) are
// excluded IN THE QUERY, before ORDER BY / LIMIT, so they never take a slot. Inside a target the page is keyset-ordered
// on (created_at, id) and starts strictly after the cursor's (created_at, id) — compared in SQL against the exact
// microsecond value the database itself rendered (keyset_at), never a JS Date — so equal timestamps are neither
// repeated nor skipped, and a row that stays untraced (retryable, or skipped as acknowledgement_missing) is behind the
// cursor: it no longer holds a slot of the pages after it; the next sweep from the start decides it again.
// Database work per statement still grows with the target's ledger and trace history (no index serves this order).
//
// A FUTURE DURABLE "DEFERRED" MARKER (a row known retryable, to be left out or ordered last) must be its own table with
// its own validated db method and its own pluginDb provenance re-pin — never a row of the trace table: the anti-join here,
// the named path's probe and the core's re-check under the sheet lease (right before the patch) all treat a trace row as
// final. The named path, the lease re-check, and the host transaction all honor the same ledger key.
const TRACE_ANTI_JOIN = Object.freeze({ table: ISSUE_CONFIRM_TRACE_TABLE, on: Object.freeze({ ledger_id: 'id' }) })
const LEDGER_KEYSET = Object.freeze({ at: 'created_at', id: 'id' })
const ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u

function unavailable(message) {
  return new YidaIssueConfirmWritebackError('YIDA_ISSUE_CONFIRM_UNAVAILABLE', message)
}
function rowsOf(result) { return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [] }
function opaque(value) { return typeof value === 'string' && value === value.trim() && ID_RE.test(value) ? value : null }
function plainFunction(holder, name) {
  return Boolean(holder) && typeof holder[name] === 'function' && !types.isProxy(holder[name])
}
// The reader's own bound, whatever the caller: an integer 1..100, or the fixed UNAVAILABLE refusal (fail closed).
function boundedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > ISSUE_CONFIRM_WRITEBACK_MAX_BATCH) throw unavailable('limit must be an integer 1..100')
  return limit
}
function iso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString()
  return null
}

/**
 * The ledger reader (§2.2 step 1): rows of exactly this (tenant, owner, workspace NULL), none already traced.
 *   list({ ledgerIds })  → those rows (any state: the decision skips what is not selected and records source_unbound
 *                          for a named unbound row); at most `limit`.
 *   sweep({ after })     → one sweep page: per listed target in the listed order (from the cursor's target on),
 *                          (created_at, id) ascending and strictly after the cursor: acknowledged CREATE rows with a
 *                          bound source_record_digest (an unbound row is never in the batch, SR5) and no traced row —
 *                          both excluded in the ledger query itself (db.selectUnmatched), so neither takes a slot — at
 *                          most `limit` in all; next = { targetRef, at, id } of the last row when the page is full and
 *                          the sweep may go on (the look-ahead row of its target exists, or later targets remain),
 *                          null when the sweep is exhausted.
 * `acknowledgedAt` is the created_at of the row's ONE `acknowledgement` AUDIT row (the database clock), read only
 * for a row the first three selector conditions admit; never the ledger's updated_at, never "now".
 */
export function createIssueConfirmLedgerReader({ db }) {
  if (!plainFunction(db, 'selectUnmatched') || !plainFunction(db, 'selectOne')) {
    throw unavailable('ledger reader needs db.selectUnmatched/selectOne')
  }
  async function traced(ledgerId) {
    return Boolean(await db.selectOne(ISSUE_CONFIRM_TRACE_TABLE, { ledger_id: ledgerId }))
  }
  async function project(row, targetRefs) {
    const admitted = row.status === 'acknowledged' && row.intent === 'create' && targetRefs.includes(row.target_ref)
    let acknowledgedAt = null
    let acknowledgedTimeZone = null
    if (admitted) {
      const audit = await db.selectOne(ISSUE_CONFIRM_LEDGER_AUDIT_TABLE, { ledger_id: row.id, event: 'acknowledgement' })
      acknowledgedAt = audit ? iso(audit.created_at) : null
      acknowledgedTimeZone = audit?.ack_time_zone ?? null
    }
    return Object.freeze({
      id: row.id, tenantId: row.tenant_id, ownerId: row.owner_id, targetRef: row.target_ref, status: row.status,
      intent: row.intent, sourceRecordDigest: row.source_record_digest ?? null, acknowledgedAt, acknowledgedTimeZone,
      operationId: row.operation_id, rowKey: row.row_key,
    })
  }
  async function list({ tenantId, ownerId, targetRefs, ledgerIds, limit }) {
    const bound = boundedLimit(limit)
    if (!Array.isArray(ledgerIds)) throw unavailable('list reads named ledger rows; a batch is a sweep page')
    const scope = { tenant_id: tenantId, workspace_id: null, owner_id: ownerId }
    const out = []
    for (const id of ledgerIds) {
      if (out.length >= bound) break
      const row = await db.selectOne(ISSUE_CONFIRM_LEDGER_TABLE, { id, ...scope })
      if (!row || await traced(row.id)) continue
      out.push(await project(row, targetRefs))
    }
    return out
  }
  async function sweep({ tenantId, ownerId, targetRefs, after, limit }) {
    const bound = boundedLimit(limit)
    if (!Array.isArray(targetRefs)) throw unavailable('sweep needs the listed targets')
    let start = 0
    if (after !== null && after !== undefined) {
      if (!after || typeof after !== 'object' || typeof after.at !== 'string' || typeof after.id !== 'string') {
        throw unavailable('sweep cursor of the wrong shape')
      }
      // The cursor only says where to start: its target must be one of the LISTED ones (the scope never comes from it).
      start = targetRefs.indexOf(after.targetRef)
      if (start < 0) throw unavailable('sweep cursor names a target that is not listed')
    }
    const scope = { tenant_id: tenantId, workspace_id: null, owner_id: ownerId }
    const rows = []
    let last = null
    for (let position = start; position < targetRefs.length; position += 1) {
      const targetRef = targetRefs[position]
      const missing = bound - rows.length
      // Candidates only (see TRACE_ANTI_JOIN above): bound, untraced, (created_at, id) ascending, strictly after the
      // cursor on the cursor's own target, at most what is still missing plus the one look-ahead row.
      const keyset = position === start && after ? { ...LEDGER_KEYSET, after: { at: after.at, id: after.id } } : { ...LEDGER_KEYSET }
      const page = rowsOf(await db.selectUnmatched(ISSUE_CONFIRM_LEDGER_TABLE, {
        where: { ...scope, target_ref: targetRef, status: 'acknowledged', intent: 'create' },
        notNull: ['source_record_digest'], unmatched: TRACE_ANTI_JOIN, keyset, limit: missing + 1,
      }))
      if (page.length > missing + 1) throw unavailable('the ledger page exceeded its bound')
      for (const row of page.slice(0, missing)) {
        // The query excludes an unbound row; one that came back anyway means the query is not what this reader asked.
        if (row.source_record_digest === null || row.source_record_digest === undefined) throw unavailable('the ledger page returned an unbound row')
        if (typeof row.keyset_at !== 'string') throw unavailable('the ledger page carries no keyset value')
        rows.push(await project(row, targetRefs))
        last = Object.freeze({ targetRef, at: row.keyset_at, id: row.id })
      }
      // The look-ahead row exists: this target goes on after the last row.
      if (page.length > missing) return Object.freeze({ rows, next: last })
      // Full exactly where this target ends: a cursor while later targets remain (no look-ahead into them, so a page
      // costs one ledger statement per target), none after the last target.
      if (rows.length === bound) return Object.freeze({ rows, next: position < targetRefs.length - 1 ? last : null })
    }
    return Object.freeze({ rows, next: null })
  }
  return Object.freeze({ list, sweep })
}

/**
 * The row values (§2.2 step 2): the ledger's (operation_id, row_key) unsealed and RE-COMPILED by the draft store's own
 * verified transaction reader (owner + scope lock, digest checks), then the planned row's payload, the compiled config
 * and the bound sheet and record IDs. A row whose recompiled source_record_digest is not the ledger's,
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
      return {
        boundSheetId: spec.sourceBinding.sheetId,
        boundRecordId: spec.sourceBinding.recordId,
        config: compiled.source.config,
        payload: planned.payload,
      }
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
    // The flag travels with the scoped api: the core checks it again before its records read.
    return Object.freeze({
      supportsWriteFence: true,
      queryRecords: (input) => scoped.queryRecords(input),
      patchRecord: (input) => scoped.patchRecord(input),
    })
  }
  return Object.freeze({ open })
}

/**
 * THE CAPABILITY handed to the host runtime (frozen, closed). `create({ context, recheck, writeCondition })` binds one
 * owner scope, the host's live re-check and its write-condition minter to a fresh executor; `enabled()` is the core's exact-literal switch predicate.
 */
export function createIssueConfirmWritebackCapability(options = {}) {
  const { db, security, projectTargetStore, projectWriteLock, multitable } = options
  const env = options.env || process.env
  const ledgerReader = createIssueConfirmLedgerReader({ db })
  const rowSource = createIssueConfirmRowSource({ db, security })
  const projectRegistry = createIssueConfirmProjectRegistry({ projectTargetStore })
  const sheets = createIssueConfirmSheets({ multitable })
  const baseTraceStore = createIssueConfirmTraceStore({ db })
  if (!plainFunction(projectWriteLock, 'assertHolderWithin')) throw unavailable('the trace lease assertion is required')
  const traceStore = Object.freeze({
    traced: baseTraceStore.traced,
    async record(row, guard) {
      if (!guard) return baseTraceStore.record(row)
      const fence = guard.hostWriteFence()
      return guard.withHostWrite(() => db.transaction(async (trx) => {
        await trx.setTransactionIsolationLevel('read committed')
        await projectWriteLock.assertHolderWithin(trx, fence.scopeKey, fence)
        return createIssueConfirmTraceStore({ db: trx }).record(row)
      }))
    },
  })
  // The lease only (register R-96, Plan A): the write-back never bumps the generation, so bumpGeneration is neither
  // required nor handed on (the executor is built per run, below: a lock without it must build).
  if (!plainFunction(projectWriteLock, 'withProjectWriteLease') || !plainFunction(projectWriteLock, 'scopeKeyFor')) {
    throw unavailable('the sheet write lease is required')
  }
  const writeLock = Object.freeze({
    scopeKeyFor: (sheetId) => projectWriteLock.scopeKeyFor(sheetId),
    withProjectWriteLease: (scopeKey, lease, fn) => projectWriteLock.withProjectWriteLease(scopeKey, lease, fn),
  })
  function enabled() { return issueConfirmWritebackEnabled(env) }
  function create(input) {
    if (!input || typeof input !== 'object' || types.isProxy(input)) throw unavailable('create needs { context, recheck, writeCondition }')
    const { context, recheck, writeCondition, testTargetRefs = [] } = input
    const tenantId = opaque(context && context.tenantId)
    const ownerId = opaque(context && context.ownerId)
    if (!tenantId || !ownerId || !Array.isArray(testTargetRefs) || typeof recheck !== 'function' || types.isProxy(recheck)
      || typeof writeCondition !== 'function' || types.isProxy(writeCondition)) throw unavailable('create needs { context, recheck, writeCondition }')
    const executor = createIssueConfirmWritebackExecutor({
      env, ledgerReader, rowSource, projectRegistry, sheets, writeLock, traceStore,
      async validateTargets({ tenantId, ownerId, targetRefs }) {
        const slotOne = await db.selectOne('integration_yida_approved_target', {
          tenant_id: tenantId, owner_id: ownerId, workspace_id: null, slot: 1,
        })
        if (targetRefs.includes(slotOne?.target_ref) || targetRefs.some(ref => testTargetRefs.includes(ref))) {
          throw new YidaIssueConfirmWritebackError('YIDA_ISSUE_CONFIRM_TEST_TARGET_LISTED', 'write-back list contains a test target')
        }
      },
      // The host's live re-check (owner live integration admin, role-granted stock-prep code, sheet read) — the
      // executor calls it under the sheet write lease, right before the records read and the patch.
      // #6812 review P2: and the host's write-condition minter — the opaque condition the one patch carries, which the
      // host re-decides (project registry row + the same live verdict) INSIDE the record write's own transaction.
      authority: Object.freeze({
        recheck: (scope) => recheck(Object.freeze({ ...scope })),
        writeCondition: (scope) => writeCondition(Object.freeze({ ...scope })),
      }),
    })
    // The scope is the host's authenticated owner, never the caller's: a run names only ledger ids, a limit and (batch
    // mode) the sweep cursor `after`, which the core decodes against the listed targets: a tampered cursor, or one that
    // carries the current set's digest but names an unlisted target, is refused (400); one issued under another target
    // set is STALE (409), including one whose own target was removed from the list; a well-formed cursor on a listed
    // target only moves the start.
    async function run(request = {}) {
      const ledgerIds = request.ledgerIds
      const limit = request.limit
      const after = request.after
      return executor.run({ tenantId, ownerId, ...(ledgerIds === undefined ? {} : { ledgerIds }),
        ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) })
    }
    return Object.freeze({ run })
  }
  return Object.freeze({ enabled, create })
}
