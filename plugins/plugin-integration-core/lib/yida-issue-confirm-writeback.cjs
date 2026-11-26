'use strict'

// ---------------------------------------------------------------------------------------------------
// 发料确认日期回写 (issue-confirm date write-back) — the CORE: decision, executor, trace store, switches.
//
// Design baseline v2.3 §7.3 and the frozen ⑦.4 plan §2.2 / §3 (R-71 ④ Q5). Slice Y9a: the decision, the
// executor with injected dependencies, the trace store and the two switches. Slice Y9 wires it: the real
// ports are lib/yida-issue-confirm-writeback-ports.mjs (assembled in index.cjs), the runtime factory hands
// the capability to the host runtime, the host owner runtime runs it as a tracked run of its own AFTER an
// acknowledged CREATE's submit has returned (D5 a; stop() drains it), and the owner recovery entry is
// POST /api/integration/yida-owner-send/issue-confirm-writeback.
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
// `source_unbound` comes from the NULL digest ONLY: a bound row whose row values cannot be read is
// retryable (YIDA_ISSUE_CONFIRM_ROW_SOURCE_UNAVAILABLE), never a terminal trace.
// prepared / dispatching / not_sent / outcome_unknown (incl. receipt_unparsed) are never written (D6).
//
// D14 (only registered project sheets are written; switch off → skip and count). The per-project sheets
// switch MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED (exact 'true', read per row and again right before
// the patch) is checked before the project registry is asked: off → skip `project_sheets_disabled`, no
// trace, no registry read, so the row is decided again once the switch is on.
//
// THE DATE (D15). The calendar day of the acknowledgement audit's created_at in the business time zone
// captured when the ACK committed. Older ACKs with no recorded zone use Asia/Shanghai.
// A later recovery uses the same audit fields even if the process configuration has changed.
//
// After the selector and bound-draft checks, acquire the bound sheet's lease before reading the project registry.
// Under the lease: check for an existing trace, resolve the project, recheck authority and read the bound record.
// The host atomically commits the one version-conditional, fenced date patch and its success trace. Every terminal
// project-dependent outcome is recorded while the current lease holder is locked in the trace transaction.
//   NO GENERATION BUMP (register R-96, Plan A): the lease is the guard. A row that finds the sheet's lease
//   held is refused STOCK_PREP_PROJECT_WRITE_LOCKED: contention, nothing written, no trace, decided again by
//   a later run. A token minted before the write is already refused without a bump (small lane: the
//   existing-row revision; expansions and the export gate: the acquire epoch), and a bump would orphan an
//   approved large job (PLAN_SUPERSEDED).
//
// THE SWEEP (owner recovery entry, batch mode = no ledgerIds). One batch run is ONE PAGE of a sweep: start
// without `after`, then pass each answer's `next` back as `after` until `next` is null. Page order is fixed:
// the listed targets in their listed order, inside a target (created_at, id) ascending, candidates only (the
// four selector conditions and "not traced" are in the ledger query itself). A row a page reported retryable
// or skipped (no trace) is BEHIND the cursor: it is decided again only by a later sweep that starts from the
// beginning, so a stuck front (rows that stay retryable or acknowledgement_missing) never stops a sweep from
// reaching the rows behind it, in its own target or in later ones. The cursor is described at
// encodeIssueConfirmSweepCursor below; it only moves the start point, never the scope. It carries a digest of the
// ORDERED listed target set it was issued under: once that set changes (a target added, removed or reordered), the
// cursor is STALE (the host's 409) and the caller restarts the sweep without `after`.
//
// RETRYABLE = NO TRACE (§7.3). Lease busy / lost / superseded, a host refusal of the fence, a version
// conflict, a host or store failure while gathering facts (ANY port that throws: row source, project
// registry, authority, sheet open / query / patch), a bound row whose row values come back null, the switch
// turned off mid-run: the row is reported `retryable` with a fixed code and nothing is recorded; the next
// recovery run decides it again.
// A failure recording a standalone terminal outcome fails the run. A failure appending the success trace
// rolls back the record transaction and leaves the ledger row eligible for recovery.
// THE WRITE CONDITION binds the owner, project, sheet and record. Inside the record transaction, the host
// rechecks the active project and the live authority before writing, then appends the success trace.
// If a trace already exists, its unique ledger key makes the pending date patch roll back.
//
// A run that read the ledger before the winner committed checks the trace again after acquiring the lease.
// Committed date writes always have their original outcome, including written_inactive. Before commit, a crash
// rolls back both writes. A retry after commit finds the trace and skips the row.
//
// D3-1 (owner ruling, register R-96 ⑦, 2026-11-17: 「按建议」 relayed by the stock-prep line, owner 「agree」). The row the
// idempotencyKey finds may be INACTIVE (`active === false`: a BOM re-key or a sheet-repair retire left the predecessor
// in place under the old key and added a successor under a NEW key). The write-back still writes the date there under
// the same D8 rule (empty cell only) and traces `written_inactive` — a written date the fill view does not show. The
// records read never filters on `active` (the successor has another key: a filter would make this a silent
// row_absent). Moving the date to the successor is the stock-prep carry's job, never this module's. The run's answer
// carries the inactive row's record id (`recordId`, an opaque id) on a written_inactive row; the trace does not. Only a
// patch can be written_inactive: an inactive row whose cell already holds the date is already_set, any other value
// kept_existing, as for an active row.
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
const {
  BUSINESS_TIMEZONE_ENV_KEY, DEFAULT_BUSINESS_TIMEZONE, isValidIanaTimeZone, resolveIssueConfirmBusinessTimeZone,
} = require('./yida-business-timezone.cjs')

const ISSUE_CONFIRM_WRITEBACK_ENABLED_ENV = 'INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED'
const ISSUE_CONFIRM_TARGET_REFS_ENV = 'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS'

const ISSUE_CONFIRM_TRACE_TABLE = 'integration_yida_issue_confirm_writeback'
const ISSUE_CONFIRM_DATE_FIELD_ID = 'issueConfirmDate'
const ISSUE_CONFIRM_KEY_FIELD_ID = 'idempotencyKey'
const ISSUE_CONFIRM_PROJECT_FIELD_ID = 'projectNo'
// The sheet write lease purpose (stock-preparation-project-write-lock.cjs). No generation reason: the
// write-back never bumps the generation (register R-96, Plan A).
const ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE = 'issue_confirm_writeback'
const ISSUE_CONFIRM_WRITEBACK_MAX_BATCH = 100
// The sweep cursor (see encodeIssueConfirmSweepCursor): its fixed version, its text bound, and the two closed refusals a
// run answers for an `after` it cannot accept: AFTER (malformed, tampered, or an unlisted target under the CURRENT set's
// digest — the host maps it to its fixed INPUT code, HTTP 400) and STALE (the listed target set changed since the
// cursor was issued, including the removal of the cursor's own target — the host maps
// it to its own fixed wire code YIDA_ISSUE_CONFIRM_CURSOR_STALE, HTTP 409: restart the sweep without `after`; the host
// never imports this module, so that text lives in the host alone, pinned by its owner runtime unit test).
const ISSUE_CONFIRM_SWEEP_CURSOR_VERSION = 2
const ISSUE_CONFIRM_SWEEP_CURSOR_MAX_LENGTH = 2048
const ISSUE_CONFIRM_SWEEP_REFUSED = 'AFTER'
const ISSUE_CONFIRM_SWEEP_STALE = 'STALE'

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
  // Owner ruling D3-1 (register R-96 ⑦, 2026-11-17): the date was written (same D8 rule: empty cell only) onto the row
  // the idempotencyKey found, and that row is INACTIVE (`active === false`: a re-keyed or retired predecessor the fill
  // view hides). Appended last (migration zzzz20261117090000 widens the CHECK).
  'written_inactive',
])
// The outcomes whose trace carries the date (and its zone); every other outcome carries neither.
const ISSUE_CONFIRM_DATED_OUTCOMES = Object.freeze(['written', 'already_set', 'written_inactive'])
// The project-sheet row's lifecycle column (stock-preparation-templates.cjs: field `active`, boolean; a refresh marks a
// row inactive instead of deleting it). Only the BOOLEAN false is inactive — the stock-prep census rule
// (stock-preparation-sheet-census.cjs); absent, null, true or any other value is active. The same literal as the
// templates' STOCK_PREPARATION_FILL_VIEW_ACTIVE_FILTER_FIELD_ID (pinned by the unit suite; not required here so the
// module stays IO-free). It is READ only: the records read never filters on it — a re-keyed successor carries another
// key, so an `active: true` filter would turn this case into a silent row_absent.
const ISSUE_CONFIRM_ACTIVE_FIELD_ID = 'active'
// Not selected (no trace, no further read): the first three selector conditions, a missing ack audit and
// (D14) the per-project sheets switch being off.
// `already_traced`: the trace re-check under the lease, right before the patch, found a trace row for this ledger row
// (another run traced it after this run read the row): no patch, no trace.
const ISSUE_CONFIRM_SKIP_REASONS = Object.freeze([
  'not_acknowledged', 'not_create', 'target_not_listed', 'acknowledgement_missing', 'project_sheets_disabled', 'already_traced',
])
// The per-project sheets switch (D14). The same literal as stock-preparation-project-targets.cjs
// PROJECT_SHEETS_ENABLED_ENV (pinned by the unit suite; not required here so the module stays IO-free).
const PROJECT_SHEETS_ENABLED_ENV = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const ROW_SOURCE_UNAVAILABLE_CODE = 'YIDA_ISSUE_CONFIRM_ROW_SOURCE_UNAVAILABLE'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CODE_RE = /^[A-Z][A-Z0-9_]{0,95}$/
const ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u
const CURSOR_TEXT_RE = /^[A-Za-z0-9_-]{1,2048}$/
const CURSOR_KEYS = Object.freeze(['v', 's', 't', 'c', 'i'])
const SWEEP_SET_RE = /^[0-9a-f]{32}$/
// The database's exact created_at as fixed UTC text with microseconds (db.cjs selectUnmatched keyset_at).
const SWEEP_AT_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/

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

// D14: exact literal 'true' only, read per call (the project-targets predicate's rule).
function issueConfirmProjectSheetsEnabled(env = process.env) {
  return Boolean(env) && env[PROJECT_SHEETS_ENABLED_ENV] === 'true'
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

// ── the sweep cursor ───────────────────────────────────────────────────────────────────────────────
//
// `next` / `after` is the base64url text (no padding) of the UTF-8 JSON of the fixed shape
//   {"v":2,"s":<target set digest>,"t":<target_ref>,"c":<created_at>,"i":<ledger id>}
// of a page's LAST row: s the digest of the ORDERED listed target set the page was read under
// (issueConfirmSweepTargetSetDigest), t its listed target (a target_ref UUID), c its created_at as the database's exact
// UTC microsecond text (a JS Date keeps milliseconds only, so a Date round trip would repeat or skip rows of one
// millisecond), i its ledger id (the tie-break of equal created_at). The ledger id is TEXT (migration 090); the cursor
// admits exactly the opaque id rule this module applies to every ledger row (opaqueId).
// Decoding is strict and fails closed. Refused (null → AFTER, the host's 400): anything but base64url of at most 2048
// characters, a text that is not the canonical one (re-encoding the decoded shape must give the same text, so no
// padding, whitespace, key order or escape variant passes), any key set but exactly v, s, t, c, i in that order, v ≠ 2
// (the v1 shape, which carried no s, is refused), s not 32 lowercase hex digits, t not a target_ref UUID, c not the
// fixed text of a real instant PostgreSQL accepts (year 0001..9999), i not an opaque id. Then, in this order: s ≠ the
// digest of the CURRENT list → STALE (the target set changed since the cursor was issued; the host's 409, restart
// without `after`) — this is also the answer when the cursor's own target was removed from the list; t not in the
// current list → null (AFTER): with the current set's digest, a cursor naming an unlisted target is tampered. The digest
// is not a secret (anyone who knows the list can compute it): it detects a changed set, it authenticates nothing. The
// decoded cursor carries no scope: tenant, owner and workspace are the authenticated owner's, the target list is the
// switch's; a well-formed cursor on a listed target only moves the start point inside them.
// Year 0000 passes a JS Date round trip, but PostgreSQL's timestamptz has no year 0 (22008): it is refused here, so
// such a cursor is the closed 400 before any write-back read, never a database error.
function sweepAt(value) {
  if (typeof value !== 'string' || !SWEEP_AT_RE.test(value) || value.startsWith('0000-')) return false
  const instant = new Date(`${value.slice(0, 23)}Z`)
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 23) === value.slice(0, 23)
}

// sha256 over the listed target_refs in their LISTED order (one per line, after a fixed label), first 32 hex digits.
// Any change of the set (an added, removed or reordered target) changes it; null for anything but a list of UUIDs.
function issueConfirmSweepTargetSetDigest(targetRefs) {
  if (!Array.isArray(targetRefs) || !targetRefs.every((ref) => typeof ref === 'string' && UUID_RE.test(ref))) return null
  return crypto.createHash('sha256').update(`yida-issue-confirm-sweep-targets\n${targetRefs.join('\n')}`, 'utf8')
    .digest('hex').slice(0, 32)
}

function sweepCursorText(set, position) {
  if (typeof set !== 'string' || !SWEEP_SET_RE.test(set) || !isPlainObject(position) || typeof position.targetRef !== 'string'
    || !UUID_RE.test(position.targetRef) || !sweepAt(position.at) || !opaqueId(position.id)) return null
  const json = JSON.stringify({ v: ISSUE_CONFIRM_SWEEP_CURSOR_VERSION, s: set, t: position.targetRef, c: position.at, i: position.id })
  const text = Buffer.from(json, 'utf8').toString('base64url')
  return text.length <= ISSUE_CONFIRM_SWEEP_CURSOR_MAX_LENGTH ? text : null
}

// The cursor of `position` under the listed `targetRefs` (its target must be one of them); null when it cannot be encoded.
function encodeIssueConfirmSweepCursor(position, targetRefs) {
  const set = issueConfirmSweepTargetSetDigest(targetRefs)
  if (!set || !isPlainObject(position) || !targetRefs.includes(position.targetRef)) return null
  return sweepCursorText(set, position)
}

// The answer for a well-formed cursor issued under another target set (the frozen marker, never a position).
const ISSUE_CONFIRM_SWEEP_CURSOR_STALE = Object.freeze({ stale: true })

// → the frozen position { targetRef, at, id } | ISSUE_CONFIRM_SWEEP_CURSOR_STALE | null (refused).
function decodeIssueConfirmSweepCursor(text, targetRefs) {
  if (typeof text !== 'string' || !CURSOR_TEXT_RE.test(text)) return null
  const current = issueConfirmSweepTargetSetDigest(targetRefs)
  if (!current) return null
  let shape
  try {
    shape = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'base64url')))
  } catch {
    return null
  }
  if (!isPlainObject(shape)) return null
  const keys = Object.keys(shape)
  if (keys.length !== CURSOR_KEYS.length || keys.some((key, index) => key !== CURSOR_KEYS[index])) return null
  if (shape.v !== ISSUE_CONFIRM_SWEEP_CURSOR_VERSION) return null
  if (typeof shape.s !== 'string' || !SWEEP_SET_RE.test(shape.s)) return null
  if (typeof shape.t !== 'string' || !UUID_RE.test(shape.t)) return null
  if (!sweepAt(shape.c) || !opaqueId(shape.i)) return null
  const position = Object.freeze({ targetRef: shape.t, at: shape.c, id: shape.i })
  // Canonical against the cursor's OWN digest first, so a stale cursor is told apart from a tampered one.
  if (sweepCursorText(shape.s, position) !== text) return null
  if (shape.s !== current) return ISSUE_CONFIRM_SWEEP_CURSOR_STALE
  return targetRefs.includes(shape.t) ? position : null
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
 *   projectSheetsEnabled  true only when MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED is 'true' (D14)
 *   rowValues     { boundSheetId, boundRecordId, config, payload } — null or missing bound IDs throws ROW_SOURCE_UNAVAILABLE
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
  // The digest is bound (the selector proved it), so an unreadable or malformed row-values answer is a
  // fact-gathering failure, never `source_unbound` (SR5 defines that by the NULL digest): retryable.
  if (rowValues === null || rowValues === undefined) fail(ROW_SOURCE_UNAVAILABLE_CODE, 'bound row values could not be read')
  const boundSheetId = isPlainObject(rowValues) ? opaqueId(rowValues.boundSheetId) : null
  const boundRecordId = isPlainObject(rowValues) ? opaqueId(rowValues.boundRecordId) : null
  if (!boundSheetId || !boundRecordId) fail(ROW_SOURCE_UNAVAILABLE_CODE, 'bound row values lack sheet or record identity')
  const key = extractIssueConfirmRowKey(rowValues.config, rowValues.payload)
  if (!key) return { kind: 'record', outcome: 'payload_unmapped', sheetId: null }

  // D14: the per-project sheets switch off → skip and count (no trace, the registry is not asked).
  if (facts.projectSheetsEnabled !== true) return { kind: 'skip', reason: 'project_sheets_disabled' }
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
  // A different record can now carry the sent key. The date belongs to the record that was bound at send time.
  if (record.id !== boundRecordId) return { kind: 'record', outcome: 'row_absent', sheetId }
  // ONE VERSION-CONDITIONAL PATCH (Y9a review r2 MEDIUM, slice Y9): the host's patchRecord treats an absent
  // expectedVersion as an UNCONDITIONAL write (packages/core-backend/src/multitable/records.ts patchRecord), so a
  // records row without a positive safe-integer `version` would turn the only write into a blind overwrite of
  // whatever a human typed after this read. Refused here, before the cell is even looked at: retryable, no trace.
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    fail('YIDA_ISSUE_CONFIRM_RECORDS_INVALID', 'records read returned a record without a version')
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
      // D3-1: the same patch either way; the outcome it is traced under is written_inactive for an inactive row.
      inactive: record.data[ISSUE_CONFIRM_ACTIVE_FIELD_ID] === false,
    }
  }
  return { kind: 'record', outcome: cell, sheetId, date }
}

// ── trace store ────────────────────────────────────────────────────────────────────────────────────

// The trace row (values-free): ids, the outcome, and the date + zone for the dated outcomes only (written, already_set,
// written_inactive: ISSUE_CONFIRM_DATED_OUTCOMES).
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

// record: INSERT … ON CONFLICT (ledger_id) DO NOTHING through the scoped plugin db (lib/db.cjs insertOneIfAbsent).
// The primary key keeps one row per ledger row; DO NOTHING lets the loser of a race (or a retry whose
// first INSERT did commit) complete normally instead of failing with 23505.
// traced: the re-check under the lease, right before the patch (db.selectOne on the primary key) → true | false.
function createIssueConfirmTraceStore({ db } = {}) {
  if (!db || typeof db.insertOneIfAbsent !== 'function' || typeof db.selectOne !== 'function') {
    fail('YIDA_ISSUE_CONFIRM_UNAVAILABLE', 'trace store needs db.insertOneIfAbsent and db.selectOne')
  }
  async function record(row) {
    const result = await db.insertOneIfAbsent(ISSUE_CONFIRM_TRACE_TABLE, row, { conflictColumns: ['ledger_id'] })
    const rows = Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : [])
    return { recorded: rows.length === 1 }
  }
  async function traced(ledgerId) {
    return Boolean(await db.selectOne(ISSUE_CONFIRM_TRACE_TABLE, { ledger_id: ledgerId }))
  }
  return Object.freeze({ record, traced })
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
// Wraps a failure of the trace INSERT (now under the lease, inside decideRow): the run rethrows the original error,
// so a trace that could not be written still fails the run closed and is never turned into a retryable row.
class TraceWriteFailed {
  constructor(error) { this.error = error }
}

function requireFunction(holder, name, label) {
  if (!holder || typeof holder[name] !== 'function') fail('YIDA_ISSUE_CONFIRM_UNAVAILABLE', `${label}.${name} is required`)
}

/**
 * Dependencies (all injected; this module does no IO of its own):
 *   ledgerReader.list({ tenantId, ownerId, targetRefs, ledgerIds, limit }) → the NAMED ledger rows of exactly this
 *       tenant + owner (see decideIssueConfirmWriteback), at most `limit`, none already traced.
 *   ledgerReader.sweep({ tenantId, ownerId, targetRefs, after, limit }) → { rows, next }: one sweep page (batch mode):
 *       at most `limit` candidate rows of this tenant + owner strictly after `after` ({ targetRef, at, id } | null) in
 *       the sweep order; next = { targetRef, at, id } of the LAST row when the page is full and the sweep may go on,
 *       null when it is exhausted.
 *   rowSource.read({ tenantId, ownerId, ledger }) → { boundSheetId, boundRecordId, config, payload }; THROWS on any
 *       failure (a null answer is retryable too, never a trace)
 *   projectRegistry.resolve({ tenantId, projectNo }) → null (no registration) | { sheetId, objectId, status };
 *       THROWS on any failure; never called while the project-sheets switch is off (D14)
 *   sheets.open({ tenantId, project }) → a records api bound to that one sheet:
 *       { supportsWriteFence: true, queryRecords({ filters, limit, offset }),
 *         patchRecord({ recordId, changes, expectedVersion, writeFence }) }
 *       The api must DECLARE the host write fence (supportsWriteFence === true, copied from the host surface by the
 *       adapter): one that does not is refused with YIDA_ISSUE_CONFIRM_WRITE_FENCE_UNAVAILABLE before any read
 *       (retryable), so the patch can never run unfenced.
 *   authority.recheck({ tenantId, ownerId, sheetId, objectId }) → true | false (live, under the lease)
 *   authority.writeCondition({ tenantId, ownerId, sheetId, projectNo }) → the host's opaque write condition, handed
 *       unchanged to the one patchRecord (including the success trace, committed with the patch)
 *   writeLock — createStockPreparationProjectWriteLock(): scopeKeyFor, withProjectWriteLease (never a
 *       generation bump: register R-96, Plan A)
 *   traceStore — record(row, guard) → { recorded } and traced(ledgerId) → true | false
 *   validateTargets({ tenantId, ownerId, targetRefs }) throws if the write-back list contains a test target
 *   env (default process.env), runId (default crypto.randomUUID)
 */
function createIssueConfirmWritebackExecutor(deps = {}) {
  const { ledgerReader, rowSource, projectRegistry, sheets, authority, writeLock, traceStore, validateTargets } = deps
  const env = deps.env || process.env
  const runId = typeof deps.runId === 'function' ? deps.runId : () => crypto.randomUUID()
  if (typeof validateTargets !== 'function') fail('YIDA_ISSUE_CONFIRM_UNAVAILABLE', 'target validation is required')
  requireFunction(ledgerReader, 'list', 'ledgerReader')
  requireFunction(ledgerReader, 'sweep', 'ledgerReader')
  requireFunction(rowSource, 'read', 'rowSource')
  requireFunction(projectRegistry, 'resolve', 'projectRegistry')
  requireFunction(sheets, 'open', 'sheets')
  requireFunction(authority, 'recheck', 'authority')
  requireFunction(authority, 'writeCondition', 'authority')
  requireFunction(writeLock, 'scopeKeyFor', 'writeLock')
  requireFunction(writeLock, 'withProjectWriteLease', 'writeLock')
  requireFunction(traceStore, 'record', 'traceStore')
  requireFunction(traceStore, 'traced', 'traceStore')

  // The trace row of one terminal decision. Any failure (the row's own validation or the INSERT) is TraceWriteFailed,
  // which the run rethrows: fail closed.
  async function writeTrace(ledger, decision, timeZone, guard) {
    try {
      const row = issueConfirmTraceRow({ ledger, outcome: decision.outcome, sheetId: decision.sheetId, date: decision.date, timeZone })
      const { recorded } = await traceStore.record(row, guard)
      // written_inactive carries the handle of the inactive row it wrote (its record id, an opaque id) to the run's
      // answer only; the trace keeps its values-free columns.
      return { kind: 'traced', outcome: decision.outcome, recorded, date: row.written_date,
        ...(decision.outcome === 'written_inactive' ? { recordId: decision.recordId } : {}) }
    } catch (error) {
      if (RETRYABLE_LOCK_CODES.includes(error?.code)) throw error
      throw new TraceWriteFailed(error)
    }
  }

  // Decide one row. Returns { kind: 'skip' | 'traced', ... } or throws (retryable / SWITCH_OFF / TraceWriteFailed).
  // Facts are gathered only when the pure decision asks for them; the lease is held around authority, records, the
  // trace re-check, the patch and the trace INSERT of every outcome decided under it.
  async function decideRow(scope, ledger, targetRefs) {
    const timeZone = ledger.acknowledgedTimeZone ?? DEFAULT_BUSINESS_TIMEZONE
    const facts = { ledger, targetRefs, timeZone, projectSheetsEnabled: issueConfirmProjectSheetsEnabled(env) }
    let decision = decideIssueConfirmWriteback(facts)
    if (decision.kind === 'need' && decision.need === 'rowValues') {
      facts.rowValues = await rowSource.read({ tenantId: scope.tenantId, ownerId: scope.ownerId, ledger })
      decision = decideIssueConfirmWriteback(facts)
    }
    // These outcomes depend only on the immutable send, so they need no sheet lease.
    if (decision.kind === 'record') return writeTrace(ledger, decision, timeZone)
    if (decision.kind !== 'need') return decision
    if (decision.need !== 'project') fail('YIDA_ISSUE_CONFIRM_STATE', 'unexpected decision step')

    // Scope the lease to the bound sheet even if the project is archived, absent or registered elsewhere.
    const projectNo = decision.projectNo
    const scopeKey = writeLock.scopeKeyFor(facts.rowValues.boundSheetId)
    return writeLock.withProjectWriteLease(scopeKey, {
      purpose: ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE,
      runId: runId(),
      tenantId: scope.tenantId,
    }, async (guard) => {
      const already = await traceStore.traced(ledger.id)
      if (already !== true && already !== false) fail('YIDA_ISSUE_CONFIRM_UNAVAILABLE', 'trace re-check did not answer')
      if (already) return { kind: 'skip', reason: 'already_traced' }

      facts.project = await projectRegistry.resolve({ tenantId: scope.tenantId, projectNo })
      let inner = decideIssueConfirmWriteback(facts)
      if (inner.kind === 'record') return writeTrace(ledger, inner, timeZone, guard)
      if (inner.kind !== 'need' || inner.need !== 'authority') fail('YIDA_ISSUE_CONFIRM_STATE', 'unexpected project decision')

      const project = facts.project
      const allowed = await authority.recheck({
        tenantId: scope.tenantId, ownerId: scope.ownerId, sheetId: project.sheetId, objectId: project.objectId,
      })
      if (allowed !== true && allowed !== false) fail('YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE', 'authority re-check did not answer')
      facts.authority = allowed
      inner = decideIssueConfirmWriteback(facts)
      // Every outcome decided under the lease is traced before the lease is released.
      if (inner.kind === 'record') return writeTrace(ledger, inner, timeZone, guard)
      if (inner.kind !== 'need') return inner
      const records = await sheets.open({ tenantId: scope.tenantId, project })
      // The host write fence, checked here as well as in the adapter: an api that does not declare it is refused before
      // the records read (retryable, no trace), so the only patch can never run unfenced.
      if (!records || records.supportsWriteFence !== true) {
        fail('YIDA_ISSUE_CONFIRM_WRITE_FENCE_UNAVAILABLE', 'the records api does not declare the host write fence')
      }
      const rows = await records.queryRecords({ filters: { [ISSUE_CONFIRM_KEY_FIELD_ID]: inner.idempotencyKey }, limit: 2, offset: 0 })
      facts.records = rows
      inner = decideIssueConfirmWriteback(facts)
      if (inner.kind === 'record') return writeTrace(ledger, inner, timeZone, guard)
      if (inner.kind !== 'patch') return inner
      // The switch is read once more right before the only write (a switch turned off mid-run stops here).
      if (!issueConfirmWritebackEnabled(env)) throw SWITCH_OFF
      // D14 once more as well: the project-sheets switch turned off mid-row → skip and count, no patch.
      if (!issueConfirmProjectSheetsEnabled(env)) return { kind: 'skip', reason: 'project_sheets_disabled' }
      // THE WRITE CONDITION (#6812 review P2): minted by the host for this owner, sheet and project; the host decides the
      // registry row and the live verdict once more inside the patch's own transaction, before the UPDATE.
      const outcome = inner.inactive ? 'written_inactive' : 'written'
      const writeCondition = await authority.writeCondition({
        tenantId: scope.tenantId, ownerId: scope.ownerId, sheetId: project.sheetId, projectNo,
        recordId: inner.recordId, targetRef: ledger.targetRef, ledgerId: ledger.id, outcome, date: inner.date, timeZone,
      })
      if (!writeCondition || typeof writeCondition !== 'object') {
        fail('YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE', 'the host did not mint a write condition')
      }
      await guard.beforeWrite({ operation: 'patchRecord', subject: 'issue_confirm_writeback' })
      try {
        await guard.withHostWrite(() => records.patchRecord({
          recordId: inner.recordId,
          changes: inner.changes,
          expectedVersion: inner.expectedVersion,
          writeFence: guard.hostWriteFence(),
          writeCondition,
        }))
      } catch (error) {
        if (error && typeof error.code === 'string' && error.code.startsWith('PLUGIN_WRITE_FENCE_')) {
          throw await guard.hostFenceRefused(error)
        }
        throw error
      }
      // The host commits the patch and its success trace together.
      return { kind: 'traced', outcome, recorded: true, date: inner.date,
        ...(inner.inactive ? { recordId: inner.recordId } : {}) }
    })
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
    // `after` (a sweep cursor) is batch mode only: together with ledgerIds it is refused, like any cursor this run
    // cannot accept. The refusal is a closed answer, not a throw, because only this module reads the target list a
    // cursor is checked against; the host turns AFTER into its fixed INPUT code (HTTP 400) and STALE into
    // YIDA_ISSUE_CONFIRM_CURSOR_STALE (HTTP 409). The write-back ports read nothing before it (the host's live-owner
    // proof has already run).
    const refused = (reason = ISSUE_CONFIRM_SWEEP_REFUSED) => ({ enabled: true, results: [], refused: reason })
    if (input.after !== undefined && ledgerIds) return refused()
    const targetRefs = parseIssueConfirmTargetRefs(env)
    let after = null
    if (input.after !== undefined) {
      const decoded = decodeIssueConfirmSweepCursor(input.after, targetRefs)
      if (decoded === ISSUE_CONFIRM_SWEEP_CURSOR_STALE) return refused(ISSUE_CONFIRM_SWEEP_STALE)
      if (!decoded) return refused()
      after = decoded
    }
    // An empty list selects nothing: zero reads, zero writes (attack point 9). A sweep over nothing is exhausted.
    if (targetRefs.length === 0) return ledgerIds ? { enabled: true, results: [] } : { enabled: true, results: [], next: null }
    const scope = Object.freeze({ tenantId, ownerId })
    await validateTargets({ ...scope, targetRefs })

    let ledgerRows
    let next = null
    if (ledgerIds) {
      ledgerRows = await ledgerReader.list({ tenantId, ownerId, targetRefs, ledgerIds, limit })
      if (!Array.isArray(ledgerRows)) fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader did not return an array')
    } else {
      const page = await ledgerReader.sweep({ tenantId, ownerId, targetRefs, after, limit })
      if (!isPlainObject(page) || !Array.isArray(page.rows) || page.next === undefined) {
        fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader did not return a sweep page')
      }
      ledgerRows = page.rows
      if (page.next !== null) {
        // Progress, checked here and not trusted: a cursor only on a full page, and it names that page's last row on a
        // listed target, so following it can never answer the same page again.
        const last = ledgerRows[ledgerRows.length - 1]
        if (ledgerRows.length !== limit || !isPlainObject(page.next) || !isPlainObject(last) || page.next.id !== last.id
          || page.next.targetRef !== last.targetRef || !targetRefs.includes(page.next.targetRef)) {
          fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader returned a cursor that is not its last row')
        }
        next = encodeIssueConfirmSweepCursor(page.next, targetRefs)
        if (!next) fail('YIDA_ISSUE_CONFIRM_LEDGER_INVALID', 'ledger reader returned a cursor of the wrong shape')
      }
    }
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
        decision = await decideRow(scope, ledger, targetRefs)
      } catch (error) {
        // The trace could not be written: not a retryable row — the run fails closed with the original error.
        if (error instanceof TraceWriteFailed) throw error.error
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
      if (decision.kind !== 'traced') fail('YIDA_ISSUE_CONFIRM_STATE', 'unexpected decision')
      results.push({
        ledgerId: ledger.id,
        kind: 'outcome',
        outcome: decision.outcome,
        recorded: decision.recorded,
        ...(decision.date ? { date: decision.date, timeZone: ledger.acknowledgedTimeZone ?? DEFAULT_BUSINESS_TIMEZONE } : {}),
        ...(decision.outcome === 'written_inactive' ? { recordId: decision.recordId } : {}),
      })
    }
    // Batch mode answers the sweep's `next` (null = exhausted); the named mode is not a sweep and answers none.
    return { enabled: true, results, ...(ledgerIds ? {} : { next }), ...(stopped ? { stopped } : {}) }
  }

  return Object.freeze({ run })
}

module.exports = {
  BUSINESS_TIMEZONE_ENV_KEY,
  DEFAULT_BUSINESS_TIMEZONE,
  ISSUE_CONFIRM_DATED_OUTCOMES,
  ISSUE_CONFIRM_ACTIVE_FIELD_ID,
  ISSUE_CONFIRM_DATE_FIELD_ID,
  ISSUE_CONFIRM_SKIP_REASONS,
  ISSUE_CONFIRM_TARGET_REFS_ENV,
  ISSUE_CONFIRM_TRACE_TABLE,
  ISSUE_CONFIRM_WRITEBACK_ENABLED_ENV,
  ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE,
  ISSUE_CONFIRM_WRITEBACK_MAX_BATCH,
  ISSUE_CONFIRM_WRITEBACK_OUTCOMES,
  ISSUE_CONFIRM_SWEEP_CURSOR_MAX_LENGTH,
  ISSUE_CONFIRM_SWEEP_CURSOR_STALE,
  ISSUE_CONFIRM_SWEEP_CURSOR_VERSION,
  ISSUE_CONFIRM_SWEEP_REFUSED,
  ISSUE_CONFIRM_SWEEP_STALE,
  PROJECT_SHEETS_ENABLED_ENV,
  ROW_SOURCE_UNAVAILABLE_CODE,
  YidaIssueConfirmWritebackError,
  createIssueConfirmTraceStore,
  createIssueConfirmWritebackExecutor,
  decideIssueConfirmCell,
  decodeIssueConfirmSweepCursor,
  encodeIssueConfirmSweepCursor,
  decideIssueConfirmWriteback,
  extractIssueConfirmRowKey,
  issueConfirmBusinessDay,
  issueConfirmProjectSheetsEnabled,
  issueConfirmSweepTargetSetDigest,
  issueConfirmTraceRow,
  issueConfirmWritebackEnabled,
  parseIssueConfirmTargetRefs,
  resolveIssueConfirmBusinessTimeZone,
  selectIssueConfirmCandidate,
}
