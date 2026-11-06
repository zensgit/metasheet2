'use strict'

// ---------------------------------------------------------------------------------------------------
// 发料确认日期回写 (issue-confirm date write-back) — CORE ONLY, NOT WIRED.
//
// Design baseline v2.3 §7.3 and the frozen ⑦.4 plan §2.2 / §3 (R-71 ④ Q5). Slice Y9a: the decision, the
// executor with injected dependencies, the trace store and the two switches. Nothing in the send port,
// the runtime factory, the plugin index, the host route or the host runtime calls this module yet; that
// wiring (and its real-PG cases) is slice Y9.
//
// TWO INDEPENDENT STATE MACHINES (§7.3).
//   * The delivery ledger (prepared → dispatching → acknowledged / outcome_unknown; prepared → not_sent)
//     is written only by lib/yida-delivery-store.cjs. This module never receives a ledger WRITER: it is
//     handed a reader, and it never constructs a runner, a form transport or a token client (pinned by
//     the unit suite's import scan), so a write-back can never cause a second form submission.
//   * The write-back keeps at most ONE trace row per ledger row (integration_yida_issue_confirm_writeback,
//     PRIMARY KEY (ledger_id), append-only; migration zzzz20261106093100). Every outcome in
//     ISSUE_CONFIRM_WRITEBACK_OUTCOMES is terminal and recorded; the send path never reads the trace.
//
// THE SELECTOR (all four, §7.3 / D7). A ledger row is written back only when
//   (1) status = 'acknowledged'  (2) intent = 'create'  (3) target_ref is in the switch-listed issue-confirm
//   targets  (4) source_record_digest IS NOT NULL.
// (1)–(3) failing = NOT SELECTED: no trace, no further read. (4) failing on a row the caller named
// explicitly = the terminal outcome `source_unbound` (a pasted rowsText draft never reaches production
// write-back; SR5) — the bounded batch reader excludes such rows in SQL, the decision re-checks anyway.
// prepared / dispatching / not_sent / outcome_unknown (incl. receipt_unparsed) are never written (D6).
//
// THE DATE (D15). The calendar day, in MULTITABLE_BUSINESS_TIMEZONE (default Asia/Shanghai; the same rule
// as the host's resolveMultitableBusinessTimezone, pinned by a host-equivalence test), of the ledger row's
// `acknowledgement` AUDIT row's created_at (the database clock). Never "now": a recovery run days later
// writes the same date, which is what makes a retry idempotent.
//
// ONE ROW, IN ORDER (each step is the pure decision below; the executor only gathers the next fact):
//   selector → row values (bound sheet + the payload's idempotencyKey / projectNo through the mapping's
//   direct entries; missing → payload_unmapped) → project registry by (tenant, projectNo) (absent →
//   project_absent, archived → project_archived, registered sheet ≠ bound sheet → sheet_mismatch) →
//   UNDER THE SHEET WRITE LEASE (purpose issue_confirm_writeback): live authority re-check (revoked →
//   permission_revoked) → the row by idempotencyKey, limit 2 (0 → row_absent, 2 → duplicate_key, its
//   projectNo ≠ the payload's → project_mismatch) → the cell: empty → ONE version-conditional, host-fenced
//   patch of `issueConfirmDate` only (written); equal → already_set; any other value → kept_existing (D8:
//   the first confirmation wins, never overwritten) → release → generation bump (reason
//   issue_confirm_writeback, best effort, only after a write) → trace INSERT … ON CONFLICT (ledger_id)
//   DO NOTHING.
//
// RETRYABLE = NO TRACE (§7.3). Lease busy / lost / superseded, a host refusal of the fence, a version
// conflict, a host or store failure while gathering facts, the switch turned off mid-run: the row is
// reported `retryable` with a fixed code and nothing is recorded; the next recovery run decides it again.
// A failure of the TRACE INSERT itself is not swallowed: it fails the run (fail closed — evidence that
// could not be written is never reported as written). A crash between the patch and the trace converges
// on the next run: the cell now holds the date → already_set; two concurrent runs that both decided the
// same row converge on the primary key: the second INSERT does nothing and that run completes normally.
//
// SWITCHES (exact literal 'true' only, read on EVERY call, default OFF; registered in
// scripts/ops/global-history-flag-manifest.mjs):
//   INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED — off: run() returns before ANY dependency call.
//   INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS       — comma-separated target_ref UUIDs (D7); empty →
//                                                     nothing is selected, zero reads.
// Turning the switch on writes the customer's production sheets: an O-level owner decision.
//
// VALUES-FREE. Results, errors and the trace carry ids, outcomes, the written date and the zone only —
// never a project number, a key value or any other business value.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const ISSUE_CONFIRM_WRITEBACK_ENABLED_ENV = 'INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED'
const ISSUE_CONFIRM_TARGET_REFS_ENV = 'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS'
const BUSINESS_TIMEZONE_ENV_KEY = 'MULTITABLE_BUSINESS_TIMEZONE'
const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Shanghai'

const ISSUE_CONFIRM_TRACE_TABLE = 'integration_yida_issue_confirm_writeback'
const ISSUE_CONFIRM_DATE_FIELD_ID = 'issueConfirmDate'
const ISSUE_CONFIRM_KEY_FIELD_ID = 'idempotencyKey'
const ISSUE_CONFIRM_PROJECT_FIELD_ID = 'projectNo'
// The sheet write lease purpose and the post-write generation reason (stock-preparation-project-write-lock.cjs).
const ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE = 'issue_confirm_writeback'
const ISSUE_CONFIRM_WRITEBACK_GENERATION_REASON = 'issue_confirm_writeback'
const ISSUE_CONFIRM_WRITEBACK_MAX_BATCH = 100

// Terminal outcomes: each is recorded once per ledger row. The migration's CHECK lists exactly these.
const ISSUE_CONFIRM_WRITEBACK_OUTCOMES = Object.freeze([
  'written',
  'already_set',
  'kept_existing',
  'row_absent',
  'duplicate_key',
  'project_absent',
  'project_archived',
  'project_mismatch',
  'payload_unmapped',
  'sheet_mismatch',
  'permission_revoked',
  'source_unbound',
])
// The outcomes whose trace carries the date (and its zone); every other outcome carries neither.
const ISSUE_CONFIRM_DATED_OUTCOMES = Object.freeze(['written', 'already_set'])
// Not selected (no trace, no further read): the first three selector conditions and a missing ack audit.
const ISSUE_CONFIRM_SKIP_REASONS = Object.freeze(['not_acknowledged', 'not_create', 'target_not_listed', 'acknowledgement_missing'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CODE_RE = /^[A-Z][A-Z0-9_]{0,95}$/
const ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u

class YidaIssueConfirmWritebackError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'YidaIssueConfirmWritebackError'
    this.code = code
  }
}

function fail(code, message) {
  throw new YidaIssueConfirmWritebackError(code, message)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function opaqueId(value) {
  return typeof value === 'string' && value === value.trim() && ID_RE.test(value) ? value : null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// ── switches ───────────────────────────────────────────────────────────────────────────────────────

function issueConfirmWritebackEnabled(env = process.env) {
  return Boolean(env) && env[ISSUE_CONFIRM_WRITEBACK_ENABLED_ENV] === 'true'
}

// Comma-separated target_ref UUIDs, trimmed, de-duplicated. An entry that is not a lowercase UUID (the
// shape yida-approved-target-store.mjs mints) is dropped: it could never equal a ledger target_ref.
function parseIssueConfirmTargetRefs(env = process.env) {
  const raw = env ? env[ISSUE_CONFIRM_TARGET_REFS_ENV] : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return Object.freeze([])
  const refs = []
  for (const part of raw.split(',')) {
    const ref = part.trim()
    if (UUID_RE.test(ref) && !refs.includes(ref)) refs.push(ref)
  }
  return Object.freeze(refs)
}

// ── the business day ───────────────────────────────────────────────────────────────────────────────

// Mirror of packages/core-backend/src/multitable/automation-timezone.ts isValidIanaTimeZone.
function isValidIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

// Mirror of packages/core-backend/src/multitable/business-timezone.ts resolveMultitableBusinessTimezone
// (trim; unset / blank / rejected by Intl → Asia/Shanghai). Equivalence is pinned by
// packages/core-backend/tests/unit/yida-issue-confirm-writeback-migration.test.ts.
function resolveIssueConfirmBusinessTimeZone(env = process.env) {
  const raw = env ? env[BUSINESS_TIMEZONE_ENV_KEY] : undefined
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return DEFAULT_BUSINESS_TIMEZONE
  if (isValidIanaTimeZone(trimmed)) return trimmed
  return DEFAULT_BUSINESS_TIMEZONE
}

function instantOf(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }
  return null
}

// The floating 'YYYY-MM-DD' calendar day of `instant` in `timeZone`.
function issueConfirmBusinessDay(instant, timeZone) {
  const at = instantOf(instant)
  if (!at) fail('YIDA_ISSUE_CONFIRM_INPUT', 'acknowledgement time is not a valid instant')
  if (!isValidIanaTimeZone(timeZone)) fail('YIDA_ISSUE_CONFIRM_INPUT', 'time zone is not a valid IANA zone')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const pick = (type) => {
    const part = parts.find((entry) => entry.type === type)
    return part ? part.value : ''
  }
  const day = `${pick('year')}-${pick('month')}-${pick('day')}`
  if (!DATE_RE.test(day)) fail('YIDA_ISSUE_CONFIRM_INPUT', 'business day could not be formatted')
  return day
}

// ── pure decision ──────────────────────────────────────────────────────────────────────────────────

// The selector (§7.3). Pure; `targetRefs` is the parsed switch list.
function selectIssueConfirmCandidate(ledger, targetRefs) {
  if (!isPlainObject(ledger) || ledger.status !== 'acknowledged') return { selected: false, reason: 'not_acknowledged' }
  if (ledger.intent !== 'create') return { selected: false, reason: 'not_create' }
  if (!Array.isArray(targetRefs) || typeof ledger.targetRef !== 'string' || !targetRefs.includes(ledger.targetRef)) {
    return { selected: false, reason: 'target_not_listed' }
  }
  if (typeof ledger.sourceRecordDigest !== 'string' || !DIGEST_RE.test(ledger.sourceRecordDigest)) {
    return { selected: false, outcome: 'source_unbound' }
  }
  if (!instantOf(ledger.acknowledgedAt)) return { selected: false, reason: 'acknowledgement_missing' }
  return { selected: true }
}

// The payload's idempotencyKey / projectNo, through the mapping's DIRECT entries only (`transform`
// absent = v2, or 'direct'): the value the form received for that source column. Two direct entries of
// one source that disagree, a missing entry or a non-string / empty value → null (payload_unmapped).
function extractIssueConfirmRowKey(config, payload) {
  if (!isPlainObject(config) || !Array.isArray(config.fieldMap) || !isPlainObject(payload)) return null
  const valueOf = (source) => {
    let found = null
    for (const entry of config.fieldMap) {
      if (!isPlainObject(entry) || entry.source !== source) continue
      if (entry.transform !== undefined && entry.transform !== 'direct') continue
      if (typeof entry.target !== 'string' || !Object.prototype.hasOwnProperty.call(payload, entry.target)) continue
      const value = payload[entry.target]
      if (typeof value !== 'string' || value.length === 0) return null
      if (found !== null && found !== value) return null
      found = value
    }
    return found
  }
  const idempotencyKey = valueOf(ISSUE_CONFIRM_KEY_FIELD_ID)
  const projectNo = valueOf(ISSUE_CONFIRM_PROJECT_FIELD_ID)
  return idempotencyKey && projectNo ? { idempotencyKey, projectNo } : null
}

// The cell (D8). Only an absent / null / '' cell is written; the target date → already_set; ANY other
// value (another date, a malformed value) → kept_existing. Never an overwrite.
function decideIssueConfirmCell(cellValue, date) {
  if (cellValue === undefined || cellValue === null || cellValue === '') return 'patch'
  if (cellValue === date) return 'already_set'
  return 'kept_existing'
}

/**
 * THE decision, pure. `facts` grows as the executor gathers them; each call returns either the next fact
 * it needs, a terminal outcome (recorded), a skip (not selected, not recorded) or a patch. Fields:
 *   ledger        { id, tenantId, ownerId, targetRef, status, intent, sourceRecordDigest, acknowledgedAt }
 *   targetRefs    parsed switch list
 *   timeZone      resolved business zone
 *   rowValues     null (unreadable) | { boundSheetId, config, payload }
 *   project       null (unregistered) | { sheetId, objectId, status: 'active' | 'archived' }
 *   authority     true | false — the LIVE re-check, under the lease
 *   records       array of { id, version, data } matched by idempotencyKey (limit 2), under the lease
 */
function decideIssueConfirmWriteback(facts) {
  const ledger = facts && facts.ledger
  const selection = selectIssueConfirmCandidate(ledger, facts && facts.targetRefs)
  if (!selection.selected) {
    return selection.outcome ? { kind: 'record', outcome: selection.outcome, sheetId: null } : { kind: 'skip', reason: selection.reason }
  }
  const date = issueConfirmBusinessDay(ledger.acknowledgedAt, facts.timeZone)

  if (!Object.prototype.hasOwnProperty.call(facts, 'rowValues')) return { kind: 'need', need: 'rowValues' }
  const rowValues = facts.rowValues
  const boundSheetId = isPlainObject(rowValues) ? opaqueId(rowValues.boundSheetId) : null
  if (!boundSheetId) return { kind: 'record', outcome: 'source_unbound', sheetId: null }
  const key = extractIssueConfirmRowKey(rowValues.config, rowValues.payload)
  if (!key) return { kind: 'record', outcome: 'payload_unmapped', sheetId: null }

  if (!Object.prototype.hasOwnProperty.call(facts, 'project')) return { kind: 'need', need: 'project', projectNo: key.projectNo }
  const project = facts.project
  if (!isPlainObject(project)) return { kind: 'record', outcome: 'project_absent', sheetId: null }
  const sheetId = opaqueId(project.sheetId)
  if (!sheetId) fail('YIDA_ISSUE_CONFIRM_REGISTRY_INVALID', 'project registry entry has no sheet id')
  if (project.status === 'archived') return { kind: 'record', outcome: 'project_archived', sheetId }
  if (project.status !== 'active') fail('YIDA_ISSUE_CONFIRM_REGISTRY_INVALID', 'project registry entry has an unknown status')
  if (sheetId !== boundSheetId) return { kind: 'record', outcome: 'sheet_mismatch', sheetId }

  if (!Object.prototype.hasOwnProperty.call(facts, 'authority')) return { kind: 'need', need: 'authority', sheetId }
  if (facts.authority !== true) return { kind: 'record', outcome: 'permission_revoked', sheetId }

  if (!Object.prototype.hasOwnProperty.call(facts, 'records')) {
    return { kind: 'need', need: 'records', sheetId, idempotencyKey: key.idempotencyKey }
  }
  const records = facts.records
  if (!Array.isArray(records)) fail('YIDA_ISSUE_CONFIRM_RECORDS_INVALID', 'records read did not return an array')
  if (records.length === 0) return { kind: 'record', outcome: 'row_absent', sheetId }
  if (records.length > 1) return { kind: 'record', outcome: 'duplicate_key', sheetId }
  const record = records[0]
  if (!isPlainObject(record) || !opaqueId(record.id) || !isPlainObject(record.data)) {
    fail('YIDA_ISSUE_CONFIRM_RECORDS_INVALID', 'records read returned a malformed record')
  }
  if (record.data[ISSUE_CONFIRM_PROJECT_FIELD_ID] !== key.projectNo) return { kind: 'record', outcome: 'project_mismatch', sheetId }
  const cell = decideIssueConfirmCell(record.data[ISSUE_CONFIRM_DATE_FIELD_ID], date)
  if (cell === 'patch') {
    return {
      kind: 'patch',
      sheetId,
      recordId: record.id,
      expectedVersion: record.version,
      changes: Object.freeze({ [ISSUE_CONFIRM_DATE_FIELD_ID]: date }),
      date,
    }
  }
  return { kind: 'record', outcome: cell, sheetId, date }
}

// ── trace store ────────────────────────────────────────────────────────────────────────────────────

// The trace row (values-free): ids, the outcome, and the date + zone for written / already_set only.
function issueConfirmTraceRow({ ledger, outcome, sheetId, date, timeZone }) {
  if (!ISSUE_CONFIRM_WRITEBACK_OUTCOMES.includes(outcome)) fail('YIDA_ISSUE_CONFIRM_INPUT', 'unknown outcome')
  const dated = ISSUE_CONFIRM_DATED_OUTCOMES.includes(outcome)
  if (dated && !(typeof date === 'string' && DATE_RE.test(date))) fail('YIDA_ISSUE_CONFIRM_INPUT', 'a dated outcome needs its date')
  return {
    ledger_id: ledger.id,
    tenant_id: ledger.tenantId,
    owner_id: ledger.ownerId,
    target_ref: ledger.targetRef,
    sheet_id: sheetId || null,
    outcome,
    written_date: dated ? date : null,
    time_zone: dated ? timeZone : null,
  }
}

// INSERT … ON CONFLICT (ledger_id) DO NOTHING through the scoped plugin db (lib/db.cjs insertOneIfAbsent).
// The primary key keeps one row per ledger row; DO NOTHING lets the loser of a race (or a retry whose
// first INSERT did commit) complete normally instead of failing with 23505.
function createIssueConfirmTraceStore({ db } = {}) {
  if (!db || typeof db.insertOneIfAbsent !== 'function') fail('YIDA_ISSUE_CONFIRM_UNAVAILABLE', 'trace store needs db.insertOneIfAbsent')
  async function record(row) {
    const result = await db.insertOneIfAbsent(ISSUE_CONFIRM_TRACE_TABLE, row, { conflictColumns: ['ledger_id'] })
    const rows = Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : [])
    return { recorded: rows.length === 1 }
  }
  return Object.freeze({ record })
}

// ── executor ───────────────────────────────────────────────────────────────────────────────────────

const RETRYABLE_LOCK_CODES = Object.freeze([
  'STOCK_PREP_PROJECT_WRITE_LOCKED',
  'STOCK_PREP_PROJECT_PLAN_SUPERSEDED',
  'STOCK_PREP_PROJECT_WRITE_LEASE_LOST',
  'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED',
  'STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE',
])

function isRecordVersionConflict(error) {
  return Boolean(error) && (error.code === 'VERSION_CONFLICT' || error.name === 'MultitableRecordVersionConflictError')
}

// A fixed, values-free code for a retryable row. Never the error message.
function retryableCode(error) {
  if (isRecordVersionConflict(error)) return 'VERSION_CONFLICT'
  const code = error && typeof error.code === 'string' ? error.code : null
  if (code && RETRYABLE_LOCK_CODES.includes(code)) return code
  if (code && CODE_RE.test(code)) return code
  return 'UNAVAILABLE'
}

// Thrown out of the lease callback when the switch is found off right before the patch.
const SWITCH_OFF = Object.freeze({ code: 'SWITCH_OFF' })

function requireFunction(holder, name, label) {
  if (!holder || typeof holder[name] !== 'function') fail('YIDA_ISSUE_CONFIRM_UNAVAILABLE', `${label}.${name} is required`)
}

/**
 * Dependencies (all injected; this module does no IO of its own):
 *   ledgerReader.list({ tenantId, ownerId, targetRefs, ledgerIds, limit }) → ledger rows of exactly this
 *       tenant + owner (see decideIssueConfirmWriteback), at most `limit`, none already traced.
 *   rowSource.read({ tenantId, ownerId, ledger }) → null | { boundSheetId, config, payload }
 *   projectRegistry.resolve({ tenantId, projectNo }) → null | { sheetId, objectId, status }
 *   sheets.open({ tenantId, project }) → a records api bound to that one sheet:
 *       { queryRecords({ filters, limit, offset }), patchRecord({ recordId, changes, expectedVersion, writeFence }) }
 *   authority.recheck({ tenantId, ownerId, sheetId, objectId }) → true | false (live, under the lease)
 *   writeLock — createStockPreparationProjectWriteLock(): scopeKeyFor, withProjectWriteLease, bumpGeneration
 *   traceStore — createIssueConfirmTraceStore({ db })
 *   env (default process.env), runId (default crypto.randomUUID), logger (optional, values-free)
 */
function createIssueConfirmWritebackExecutor(deps = {}) {
  const { ledgerReader, rowSource, projectRegistry, sheets, authority, writeLock, traceStore, logger } = deps
  const env = deps.env || process.env
  const runId = typeof deps.runId === 'function' ? deps.runId : () => crypto.randomUUID()
  requireFunction(ledgerReader, 'list', 'ledgerReader')
  requireFunction(rowSource, 'read', 'rowSource')
  requireFunction(projectRegistry, 'resolve', 'projectRegistry')
  requireFunction(sheets, 'open', 'sheets')
  requireFunction(authority, 'recheck', 'authority')
  requireFunction(writeLock, 'scopeKeyFor', 'writeLock')
  requireFunction(writeLock, 'withProjectWriteLease', 'writeLock')
  requireFunction(writeLock, 'bumpGeneration', 'writeLock')
  requireFunction(traceStore, 'record', 'traceStore')

  async function bumpAfterWrite(scopeKey, tenantId) {
    try {
      await writeLock.bumpGeneration(scopeKey, { reason: ISSUE_CONFIRM_WRITEBACK_GENERATION_REASON, tenantId })
      return true
    } catch (error) {
      // The write already landed; a refused bump never masks it (the carry-confirm precedent).
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[plugin-integration-core] yida issue-confirm write-back: generation bump after release was refused', {
          code: retryableCode(error),
        })
      }
      return false
    }
  }

  // Decide one row. Returns { kind: 'skip' | 'record' | 'retryable' | 'stopped', ... }. Facts are gathered
  // only when the pure decision asks for them; the lease is held only around authority, records and patch.
  async function decideRow(scope, ledger, targetRefs, timeZone) {
    const facts = { ledger, targetRefs, timeZone }
    let decision = decideIssueConfirmWriteback(facts)
    if (decision.kind === 'need' && decision.need === 'rowValues') {
      facts.rowValues = await rowSource.read({ tenantId: scope.tenantId, ownerId: scope.ownerId, ledger })
      decision = decideIssueConfirmWriteback(facts)
    }
    if (decision.kind === 'need' && decision.need === 'project') {
      facts.project = await projectRegistry.resolve({ tenantId: scope.tenantId, projectNo: decision.projectNo })
      decision = decideIssueConfirmWriteback(facts)
    }
    if (decision.kind !== 'need') return decision
    if (decision.need !== 'authority') fail('YIDA_ISSUE_CONFIRM_STATE', 'unexpected decision step')

    const project = facts.project
    const scopeKey = writeLock.scopeKeyFor(project.sheetId)
    let wrote = false
    const leased = await writeLock.withProjectWriteLease(scopeKey, {
      purpose: ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE,
      runId: runId(),
      tenantId: scope.tenantId,
    }, async (guard) => {
      const allowed = await authority.recheck({
        tenantId: scope.tenantId, ownerId: scope.ownerId, sheetId: project.sheetId, objectId: project.objectId,
      })
      if (allowed !== true && allowed !== false) fail('YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE', 'authority re-check did not answer')
      facts.authority = allowed
      let inner = decideIssueConfirmWriteback(facts)
      if (inner.kind !== 'need') return inner
      const records = await sheets.open({ tenantId: scope.tenantId, project })
      const rows = await records.queryRecords({ filters: { [ISSUE_CONFIRM_KEY_FIELD_ID]: inner.idempotencyKey }, limit: 2, offset: 0 })
      facts.records = rows
      inner = decideIssueConfirmWriteback(facts)
      if (inner.kind !== 'patch') return inner
      // The switch is read once more right before the only write (a switch turned off mid-run stops here).
      if (!issueConfirmWritebackEnabled(env)) throw SWITCH_OFF
      await guard.beforeWrite({ operation: 'patchRecord', subject: 'issue_confirm_writeback' })
      try {
        await guard.withHostWrite(() => records.patchRecord({
          recordId: inner.recordId,
          changes: inner.changes,
          expectedVersion: inner.expectedVersion,
          writeFence: guard.hostWriteFence(),
        }))
      } catch (error) {
        if (error && typeof error.code === 'string' && error.code.startsWith('PLUGIN_WRITE_FENCE_')) {
          throw await guard.hostFenceRefused(error)
        }
        throw error
      }
      wrote = true
      return { kind: 'record', outcome: 'written', sheetId: inner.sheetId, date: inner.date }
    })
    if (wrote) await bumpAfterWrite(scopeKey, scope.tenantId)
    return leased
  }

  async function run(input = {}) {
    // The switch FIRST: off → no dependency is called at all.
    if (!issueConfirmWritebackEnabled(env)) return { enabled: false, results: [] }
    if (!isPlainObject(input)) fail('YIDA_ISSUE_CONFIRM_INPUT', 'input must be a plain object')
    const tenantId = opaqueId(input.tenantId)
    const ownerId = opaqueId(input.ownerId)
    if (!tenantId || !ownerId) fail('YIDA_ISSUE_CONFIRM_INPUT', 'tenantId and ownerId are required')
    let ledgerIds = null
    if (input.ledgerIds !== undefined) {
      if (!Array.isArray(input.ledgerIds) || input.ledgerIds.length === 0 || input.ledgerIds.length > ISSUE_CONFIRM_WRITEBACK_MAX_BATCH
        || !input.ledgerIds.every((id) => opaqueId(id))) fail('YIDA_ISSUE_CONFIRM_INPUT', 'ledgerIds must be 1..100 ids')
      ledgerIds = Object.freeze([...new Set(input.ledgerIds)])
    }
    let limit = ISSUE_CONFIRM_WRITEBACK_MAX_BATCH
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > ISSUE_CONFIRM_WRITEBACK_MAX_BATCH) {
        fail('YIDA_ISSUE_CONFIRM_INPUT', 'limit must be an integer 1..100')
      }
      limit = input.limit
    }
    const targetRefs = parseIssueConfirmTargetRefs(env)
    // An empty list selects nothing: zero reads, zero writes (attack point 9).
    if (targetRefs.length === 0) return { enabled: true, results: [] }
    const timeZone = resolveIssueConfirmBusinessTimeZone(env)
    const scope = Object.freeze({ tenantId, ownerId })

    const ledgerRows = await ledgerReader.list({ tenantId, ownerId, targetRefs, ledgerIds, limit })
    if (!Array.isArray(ledgerRows)) fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader did not return an array')
    if (ledgerRows.length > limit) fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader exceeded the bound')
    // Server-side scope only (§2.2 step 1): one row of another tenant or owner fails the WHOLE run closed,
    // before anything of the batch is read or written.
    for (const ledger of ledgerRows) {
      if (!isPlainObject(ledger) || !opaqueId(ledger.id) || ledger.tenantId !== tenantId || ledger.ownerId !== ownerId) {
        fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader returned a row outside the caller scope')
      }
    }

    const results = []
    let stopped = null
    for (const ledger of ledgerRows) {
      if (stopped) {
        results.push({ ledgerId: ledger.id, kind: 'retryable', code: stopped })
        continue
      }
      // The switch between rows: turned off mid-run → the rest stays for a later run, nothing recorded.
      if (!issueConfirmWritebackEnabled(env)) {
        stopped = 'SWITCH_OFF'
        results.push({ ledgerId: ledger.id, kind: 'retryable', code: stopped })
        continue
      }
      let decision
      try {
        decision = await decideRow(scope, ledger, targetRefs, timeZone)
      } catch (error) {
        if (error === SWITCH_OFF) {
          stopped = 'SWITCH_OFF'
          results.push({ ledgerId: ledger.id, kind: 'retryable', code: stopped })
          continue
        }
        results.push({ ledgerId: ledger.id, kind: 'retryable', code: retryableCode(error) })
        continue
      }
      if (decision.kind === 'skip') {
        results.push({ ledgerId: ledger.id, kind: 'skip', reason: decision.reason })
        continue
      }
      if (decision.kind !== 'record') fail('YIDA_ISSUE_CONFIRM_STATE', 'unexpected decision')
      // The trace. Not caught: a trace that cannot be written fails the run (fail closed).
      const row = issueConfirmTraceRow({ ledger, outcome: decision.outcome, sheetId: decision.sheetId, date: decision.date, timeZone })
      const { recorded } = await traceStore.record(row)
      results.push({
        ledgerId: ledger.id,
        kind: 'outcome',
        outcome: decision.outcome,
        recorded,
        ...(row.written_date ? { date: row.written_date, timeZone } : {}),
      })
    }
    return { enabled: true, results, ...(stopped ? { stopped } : {}) }
  }

  return Object.freeze({ run })
}

module.exports = {
  BUSINESS_TIMEZONE_ENV_KEY,
  DEFAULT_BUSINESS_TIMEZONE,
  ISSUE_CONFIRM_DATED_OUTCOMES,
  ISSUE_CONFIRM_DATE_FIELD_ID,
  ISSUE_CONFIRM_SKIP_REASONS,
  ISSUE_CONFIRM_TARGET_REFS_ENV,
  ISSUE_CONFIRM_TRACE_TABLE,
  ISSUE_CONFIRM_WRITEBACK_ENABLED_ENV,
  ISSUE_CONFIRM_WRITEBACK_GENERATION_REASON,
  ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE,
  ISSUE_CONFIRM_WRITEBACK_MAX_BATCH,
  ISSUE_CONFIRM_WRITEBACK_OUTCOMES,
  YidaIssueConfirmWritebackError,
  createIssueConfirmTraceStore,
  createIssueConfirmWritebackExecutor,
  decideIssueConfirmCell,
  decideIssueConfirmWriteback,
  extractIssueConfirmRowKey,
  issueConfirmBusinessDay,
  issueConfirmTraceRow,
  issueConfirmWritebackEnabled,
  parseIssueConfirmTargetRefs,
  resolveIssueConfirmBusinessTimeZone,
  selectIssueConfirmCandidate,
}
