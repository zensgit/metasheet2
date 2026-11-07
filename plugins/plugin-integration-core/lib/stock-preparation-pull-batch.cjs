'use strict'

// ---------------------------------------------------------------------------------------------------
// 批次标识 (pull batch) — THE PORTABLE PURE CORE (batch-identifier design BI-1a; owner decisions 2026-10-27
// and 2026-11-07). PURE AND NOT WIRED: nothing in the plugin requires this file yet. It holds the label
// grammar, both 首次批次 rules, the history plan, the attested count, the content-only digest and the batch
// CONFIGURATION VOCABULARY. The ledger, store, lanes, routes, template band and web come in later PRs.
//
// WHAT A 批次 IS (design §3.1). The set of rows of ONE project on ONE sheet whose CREATION was carried out by
// one logical pull: one or more executions that share a content digest (`pullBatchSourceDigest`), up to the
// first one that finishes `succeeded`. Numbered per (tenant, sheet, project) in opening order. It is NOT
// `snapshotBatchId` / stock-preparation-batch-identity.cjs (the mvp archive's batch): nothing here reads,
// writes or renames those. Identifiers say `pullBatch`, never a bare `batch`.
//
// THE TWO COLUMNS (design §4). 首次批次 (`firstPullBatch`) = the first batch in which this material appeared
// in the project; 本次拉取 (`pullBatch`) = the batch of the pull that CREATED this row. The owner's approved
// example: S-01 有效=否 首次=第1批 本次=第1批; S-01 有效=是 首次=第1批 本次=第2批; P-07 有效=是 首次=第2批
// 本次=第2批 — so UPDATE and INACTIVE never restamp a band cell.
//
// THE CONFIGURATION (owner 2026-11-07: 「能否也做个页面配置项，默认就按我们10-27的方案…」). Batch behaviour is a
// page-level admin configuration with a CLOSED key set (`normalizePullBatchConfig`, fail-closed). Its defaults
// (`DEFAULT_PULL_BATCH_CONFIG`) are exactly the 10-27 design. The keys that CHANGE WHAT A LABEL MEANS
// (`PULL_BATCH_MEANING_LOCKED_KEYS`) are captured per sheet and LOCKED once the sheet has stamped: labels are
// never rewritten (design §8.4), so a change after the first stamp would mix two meanings on one sheet.
// `refusedPullBatchConfigEdits` answers which edits the later store / route must refuse.
//
// THE LABEL GRAMMAR (design §3.2 + the configurable format). Twelve strings, N = the batch number, D = the
// process-local calendar day YYYY-MM-DD of the batch's opening:
//
//   labelFormat     kind       zh-CN                  en
//   ordinal_date    live       第N批（D）              Batch N (D)
//   ordinal_date    inferred   第N批（推定，D）         Batch N (inferred, D)
//   ordinal         live       第N批                   Batch N
//   ordinal         inferred   第N批（推定）            Batch N (inferred)
//   date            live       D                       D
//   date            inferred   D（推定）               D (inferred)
//   (any)           unknown    历史批次未知             Unknown historical batch
//   (any)           manual     人工补充                 Manual row
//   (any)           blank      '' / absent
//
// `parsePullBatchLabel` accepts EVERY format in BOTH locales whatever the sheet is configured with; anything
// else parses `unknown` (fail-safe: garbage can never become an earlier batch). THE 'date' LIMIT: two batches
// opened on one day carry the SAME label and cannot be told apart in the cell; the parse recovers the kind and
// the day, never a number. The carry rule then orders known labels by day (one sheet holds one format, the
// format being meaning-locked), and when two ledger batches share one label it reads the LATEST opening of
// them, so an ambiguous open row decides 历史批次未知 rather than vanishing (fail-safe).
//
// PORTABLE (design §12.2, S6 C-1). This file is meant to be copied byte-identical onto the R maintenance line.
// It requires NOTHING but node:crypto (a scan test pins it). The planner's created-by Symbol is read by its
// `Symbol.for` key (equal by construction; the unit suite asserts the equality), and the canonical row order of
// the digest is injected by the caller.
//
// VALUES. A label is an ordinal, a server calendar day and a closed marker. Nothing here puts a material id,
// key, path or quantity into any answer meant to leave the server: the history plan carries record ids, times,
// counts and labels only; the carry map is keyed by idempotency keys and stays SERVER-HELD.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

// ── the existing-row Symbol (design §4.4, D-BI-6) ─────────────────────────────────────────────────────
// The project-scoped reader (later PR) strips BOTH band cells off every row onto this Symbol, so
// stableStringify / JSON.stringify / Object.keys never see them. Value (frozen):
//   { pullBatch, firstPullBatch }  two strings, '' when the cell is absent
//   createdAt                      ISO string from the record ENVELOPE, or null
//   locked                         boolean from the record ENVELOPE (a locked record is read-only to plugins)
const EXISTING_ROW_PULL_BATCH = Symbol.for('metasheet.stock-preparation.existingRow.pullBatch')
// The planner's created-by key (stock-preparation-conflict-planner.cjs EXISTING_ROW_CREATED_BY): present only
// when the host surfaced a non-blank `created_by` (a person / REST / import create). A plugin INSERT leaves it
// absent. Spelled by its registry key here so this file requires no planner.
const EXISTING_ROW_CREATED_BY_KEY = Symbol.for('metasheet.stock-preparation.existingRow.createdBy')

// ── the band's logical field ids (design §4.1; the template-side descriptors come with the band PR) ───
const PULL_BATCH_BAND_FIELD_IDS = Object.freeze({ firstPullBatch: 'firstPullBatch', pullBatch: 'pullBatch' })

// ── vocabularies (closed; pinned by the unit suite) ──────────────────────────────────────────────────
const PULL_BATCH_LABEL_KINDS = Object.freeze(['live', 'inferred', 'unknown', 'manual', 'blank'])
const PULL_BATCH_LOCALES = Object.freeze(['en', 'zh-CN'])
const PULL_BATCH_UNKNOWN_LABELS = Object.freeze({ en: 'Unknown historical batch', 'zh-CN': '历史批次未知' })
// 人工补充 (owner ruling 2026-10-27, manual rows): the manual-row series writes exactly the literal the band
// property carries into both cells of a new manual row. It parses as `manual`, never `unknown` (R3).
const PULL_BATCH_MANUAL_LABELS = Object.freeze({ en: 'Manual row', 'zh-CN': '人工补充' })
const PULL_BATCH_EVIDENCE_CLASSES = Object.freeze(['plan_time', 'created_at'])
const PULL_BATCH_HISTORY_MODES = Object.freeze(['inferred', 'unknown'])
// Batch `closed_reason` (design §15; S6 C-3 adds `recovery_verified`).
const PULL_BATCH_CLOSED_REASONS = Object.freeze([
  'execution_succeeded',
  'completed_by_later_execution',
  'superseded_by_new_source',
  'void_no_rows',
  'backfill',
  'recovery_verified',
])
// Why a pull did not stamp (design §15 "pull response reasons").
const PULL_BATCH_RESPONSE_REASONS = Object.freeze([
  'disabled',
  'not_installed',
  'columns_unproven',
  'columns_partial',
  'history_pending',
  'history_gap',
  'no_creates',
])

const MANUAL_ROW_KEY_PREFIX = 'manual:v1:'
const DUPLICATE_RESOLVED_SEPARATOR = '::duplicate:'

// ── error codes (design §15 + the configuration family; exported for the web's RS-COPY tripwire) ──────
// The existing STOCK_PREP_PROJECT_WRITE_LEASE_LOST (§15) belongs to the write-lock module and is not repeated.
const PULL_BATCH_ERROR_CODES = Object.freeze({
  STORE_FAILED: 'STOCK_PREP_PULL_BATCH_STORE_FAILED',
  CONFLICT: 'STOCK_PREP_PULL_BATCH_CONFLICT',
  NOT_READY: 'STOCK_PREP_PULL_BATCH_NOT_READY',
  INSTALL_IN_PROGRESS: 'STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS',
  EXECUTION_CLOSED: 'STOCK_PREP_PULL_BATCH_EXECUTION_CLOSED',
  JOB_REPLAN_REQUIRED: 'STOCK_PREP_PULL_BATCH_JOB_REPLAN_REQUIRED',
  STAMP_INVALID: 'STOCK_PREP_PULL_BATCH_STAMP_INVALID',
  DISABLED: 'STOCK_PREP_PULL_BATCH_DISABLED',
  INSTALL_REQUEST_INVALID: 'STOCK_PREP_PULL_BATCH_INSTALL_REQUEST_INVALID',
  INSTALL_CONFIRM_MISMATCH: 'STOCK_PREP_PULL_BATCH_INSTALL_CONFIRM_MISMATCH',
  INSTALL_OBJECT_REFUSED: 'STOCK_PREP_PULL_BATCH_INSTALL_OBJECT_REFUSED',
  INSTALL_ROWS_TOO_LARGE: 'STOCK_PREP_PULL_BATCH_INSTALL_ROWS_TOO_LARGE',
  PLM_LOCK_REQUIRED: 'STOCK_PREP_PULL_BATCH_PLM_LOCK_REQUIRED',
  PLAN_CHANGED: 'STOCK_PREP_PULL_BATCH_PLAN_CHANGED',
  PLAN_CONFLICT: 'STOCK_PREP_PULL_BATCH_PLAN_CONFLICT',
  HISTORY_COUNT_MISMATCH: 'STOCK_PREP_PULL_BATCH_HISTORY_COUNT_MISMATCH',
  PLACEMENT_REQUIRED: 'STOCK_PREP_PULL_BATCH_PLACEMENT_REQUIRED',
  CONFIG_INVALID: 'STOCK_PREP_PULL_BATCH_CONFIG_INVALID',
  CONFIG_LOCKED: 'STOCK_PREP_PULL_BATCH_CONFIG_LOCKED',
})

const PULL_BATCH_ERROR_HTTP_STATUS = Object.freeze({
  [PULL_BATCH_ERROR_CODES.STORE_FAILED]: 503,
  [PULL_BATCH_ERROR_CODES.CONFLICT]: 409,
  [PULL_BATCH_ERROR_CODES.NOT_READY]: 409,
  [PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS]: 409,
  [PULL_BATCH_ERROR_CODES.EXECUTION_CLOSED]: 409,
  [PULL_BATCH_ERROR_CODES.JOB_REPLAN_REQUIRED]: 409,
  [PULL_BATCH_ERROR_CODES.STAMP_INVALID]: 500,
  [PULL_BATCH_ERROR_CODES.DISABLED]: 409,
  [PULL_BATCH_ERROR_CODES.INSTALL_REQUEST_INVALID]: 400,
  [PULL_BATCH_ERROR_CODES.INSTALL_CONFIRM_MISMATCH]: 409,
  [PULL_BATCH_ERROR_CODES.INSTALL_OBJECT_REFUSED]: 409,
  [PULL_BATCH_ERROR_CODES.INSTALL_ROWS_TOO_LARGE]: 422,
  [PULL_BATCH_ERROR_CODES.PLM_LOCK_REQUIRED]: 409,
  [PULL_BATCH_ERROR_CODES.PLAN_CHANGED]: 409,
  [PULL_BATCH_ERROR_CODES.PLAN_CONFLICT]: 409,
  [PULL_BATCH_ERROR_CODES.HISTORY_COUNT_MISMATCH]: 409,
  [PULL_BATCH_ERROR_CODES.PLACEMENT_REQUIRED]: 409,
  [PULL_BATCH_ERROR_CODES.CONFIG_INVALID]: 400,
  [PULL_BATCH_ERROR_CODES.CONFIG_LOCKED]: 409,
})

class StockPreparationPullBatchError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationPullBatchError'
    this.status = PULL_BATCH_ERROR_HTTP_STATUS[code] || 500
    this.code = code
    this.details = details
  }
}

// ── the configuration vocabulary (owner 2026-11-07) ──────────────────────────────────────────────────
// CLOSED key set; every value is matched by strict equality (no trim, no case folding, booleans are booleans).
//   firstPullBatchRule      'material' (§5.2, default) | 'predecessor_suffix' (§5.3) | 'off' (no 首次 computed)
//   pullBatchMeaning        'created' ONLY in v1 — 本次拉取 = the batch that CREATED the row. A 'latest pull'
//                           meaning is deferred pending design costing; anything else is refused.
//   labelFormat             'ordinal_date' (default, 第N批（YYYY-MM-DD）) | 'ordinal' (第N批) | 'date' (YYYY-MM-DD)
//   landing                 'promote_prep_fill' (default, §10: 备料填写视图 becomes views[0]) | 'keep_current'
//   formalExport            'excluded' (default, D-BI-17 / O-BI-6) | 'included'
//   placement               'left' (default, order -2/-1) | 'right' (after the last column)
//   trashedRowsAreEvidence  false (default, Q-BI-16 / O-BI-10) | true
const PULL_BATCH_CONFIG_VALUES = Object.freeze({
  firstPullBatchRule: Object.freeze(['material', 'predecessor_suffix', 'off']),
  pullBatchMeaning: Object.freeze(['created']),
  labelFormat: Object.freeze(['ordinal_date', 'ordinal', 'date']),
  landing: Object.freeze(['promote_prep_fill', 'keep_current']),
  formalExport: Object.freeze(['excluded', 'included']),
  placement: Object.freeze(['left', 'right']),
  trashedRowsAreEvidence: Object.freeze([false, true]),
})
const PULL_BATCH_CONFIG_KEYS = Object.freeze(Object.keys(PULL_BATCH_CONFIG_VALUES))
const FIRST_PULL_BATCH_RULES = PULL_BATCH_CONFIG_VALUES.firstPullBatchRule
const PULL_BATCH_LABEL_FORMATS = PULL_BATCH_CONFIG_VALUES.labelFormat

// The 10-27 design, exactly.
const DEFAULT_PULL_BATCH_CONFIG = Object.freeze({
  firstPullBatchRule: 'material',
  pullBatchMeaning: 'created',
  labelFormat: 'ordinal_date',
  landing: 'promote_prep_fill',
  formalExport: 'excluded',
  placement: 'left',
  trashedRowsAreEvidence: false,
})

// The keys whose value decides what a label already written on the sheet MEANS. Captured per sheet and locked
// once the sheet has stamped. landing / formalExport / placement change presentation only and stay editable.
const PULL_BATCH_MEANING_LOCKED_KEYS = Object.freeze(['firstPullBatchRule', 'pullBatchMeaning', 'labelFormat', 'trashedRowsAreEvidence'])

function configInvalid(field, message) {
  return new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.CONFIG_INVALID, message, { field })
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

/** Validate a (partial) config object against the closed vocabulary; answers its own keys only. */
function validateConfigEntries(input, label) {
  if (!isPlainObject(input)) throw configInvalid(label, 'a pull-batch configuration must be a plain object')
  const out = {}
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(PULL_BATCH_CONFIG_VALUES, key)) {
      throw configInvalid(key, 'unknown pull-batch configuration key')
    }
    const value = input[key]
    if (!PULL_BATCH_CONFIG_VALUES[key].includes(value)) {
      throw configInvalid(key, 'unsupported pull-batch configuration value')
    }
    out[key] = value
  }
  return out
}

/**
 * The one reader of a pull-batch configuration. `undefined` / `null` => the defaults. A partial object is
 * merged over the defaults. Any unknown key, or any value outside the closed vocabulary, is refused
 * (400 STOCK_PREP_PULL_BATCH_CONFIG_INVALID, `details.field` names it). Answers a frozen object with every key.
 */
function normalizePullBatchConfig(input) {
  if (input === undefined || input === null) return DEFAULT_PULL_BATCH_CONFIG
  const entries = validateConfigEntries(input, 'config')
  const out = {}
  for (const key of PULL_BATCH_CONFIG_KEYS) out[key] = Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : DEFAULT_PULL_BATCH_CONFIG[key]
  return Object.freeze(out)
}

/**
 * Which keys of a proposed edit are REFUSED because the sheet has stamped (pure; the later store / route answers
 * 409 STOCK_PREP_PULL_BATCH_CONFIG_LOCKED with this list).
 *   captured  the sheet's captured configuration (null => the defaults: a sheet that stamped before any capture
 *             stamped under the 10-27 design)
 *   edit      a partial configuration; validated like `normalizePullBatchConfig` (unknown key / value => 400)
 *   stamped   true once any band cell of the sheet carries a label (strict boolean)
 * Answers the meaning-locked keys whose proposed value differs from the captured one, in
 * `PULL_BATCH_MEANING_LOCKED_KEYS` order; [] when the sheet has not stamped or nothing locked changes.
 */
function refusedPullBatchConfigEdits({ captured, edit, stamped } = {}) {
  const base = normalizePullBatchConfig(captured)
  const proposed = validateConfigEntries(edit, 'edit')
  if (typeof stamped !== 'boolean') throw configInvalid('stamped', 'whether the sheet has stamped must be a boolean')
  if (!stamped) return Object.freeze([])
  return Object.freeze(PULL_BATCH_MEANING_LOCKED_KEYS.filter((key) => (
    Object.prototype.hasOwnProperty.call(proposed, key) && proposed[key] !== base[key]
  )))
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function timeMsOf(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function isoOf(ms) {
  return new Date(ms).toISOString()
}

// Canonical JSON (sorted keys) for the digests: two lanes that hold the same rows in a different key order
// must hash alike.
function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function stampInvalid(field, message) {
  return new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.STAMP_INVALID, message, { field })
}

function assertLocale(value) {
  if (!PULL_BATCH_LOCALES.includes(value)) throw stampInvalid('locale', 'a pull-batch label locale must be en or zh-CN')
  return value
}

// ── the label day (design §3.2, Q-BI-5) ──────────────────────────────────────────────────────────────
// The PROCESS-LOCAL calendar day of an instant, from its local components (the registry's convention,
// stock-preparation-project-target-store.cjs `dayOrNull`) — never `toISOString().slice(0, 10)`, which hands
// back the previous day east of UTC.
function pullBatchLabelDay(value) {
  const ms = timeMsOf(value)
  if (ms === null) return null
  const date = new Date(ms)
  const year = date.getFullYear()
  if (year < 1 || year > 9999) return null
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isCalendarDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
}

// ── the label grammar (design §3.2 + labelFormat; the table is in the header) ─────────────────────────
/**
 * Format one cell. `kind` live | inferred need a positive integer `n` AND a valid `day` whatever the format (a
 * batch always has both; the format decides what the cell shows). unknown | manual need only the locale.
 * `labelFormat` defaults to the 10-27 'ordinal_date'. Malformed input => 500 STAMP_INVALID.
 */
function formatPullBatchLabel({ kind, n, day, locale, labelFormat } = {}) {
  const lang = assertLocale(locale)
  if (kind === 'unknown') return PULL_BATCH_UNKNOWN_LABELS[lang]
  if (kind === 'manual') return PULL_BATCH_MANUAL_LABELS[lang]
  if (kind !== 'live' && kind !== 'inferred') throw stampInvalid('kind', 'a pull-batch label kind must be live, inferred, unknown or manual')
  const format = labelFormat === undefined ? DEFAULT_PULL_BATCH_CONFIG.labelFormat : labelFormat
  if (!PULL_BATCH_LABEL_FORMATS.includes(format)) throw stampInvalid('labelFormat', 'unknown pull-batch label format')
  if (!Number.isSafeInteger(n) || n < 1) throw stampInvalid('n', 'a pull-batch number must be a positive integer')
  if (typeof day !== 'string' || !isCalendarDay(day)) throw stampInvalid('day', 'a pull-batch label day must be YYYY-MM-DD')
  const inferred = kind === 'inferred'
  if (format === 'ordinal_date') {
    if (lang === 'zh-CN') return inferred ? `第${n}批（推定，${day}）` : `第${n}批（${day}）`
    return inferred ? `Batch ${n} (inferred, ${day})` : `Batch ${n} (${day})`
  }
  if (format === 'ordinal') {
    if (lang === 'zh-CN') return inferred ? `第${n}批（推定）` : `第${n}批`
    return inferred ? `Batch ${n} (inferred)` : `Batch ${n}`
  }
  if (lang === 'zh-CN') return inferred ? `${day}（推定）` : day
  return inferred ? `${day} (inferred)` : day
}

const N = '([1-9][0-9]*)'
const D = '([0-9]{4}-[0-9]{2}-[0-9]{2})'
// [kind, format, regex, which groups are n / day]
const LABEL_PATTERNS = Object.freeze([
  { kind: 'live', format: 'ordinal_date', re: new RegExp(`^第${N}批（${D}）$`), n: 1, day: 2 },
  { kind: 'inferred', format: 'ordinal_date', re: new RegExp(`^第${N}批（推定，${D}）$`), n: 1, day: 2 },
  { kind: 'live', format: 'ordinal_date', re: new RegExp(`^Batch ${N} \\(${D}\\)$`), n: 1, day: 2 },
  { kind: 'inferred', format: 'ordinal_date', re: new RegExp(`^Batch ${N} \\(inferred, ${D}\\)$`), n: 1, day: 2 },
  { kind: 'live', format: 'ordinal', re: new RegExp(`^第${N}批$`), n: 1, day: 0 },
  { kind: 'inferred', format: 'ordinal', re: new RegExp(`^第${N}批（推定）$`), n: 1, day: 0 },
  { kind: 'live', format: 'ordinal', re: new RegExp(`^Batch ${N}$`), n: 1, day: 0 },
  { kind: 'inferred', format: 'ordinal', re: new RegExp(`^Batch ${N} \\(inferred\\)$`), n: 1, day: 0 },
  { kind: 'live', format: 'date', re: new RegExp(`^${D}$`), n: 0, day: 1 },
  { kind: 'inferred', format: 'date', re: new RegExp(`^${D}（推定）$`), n: 0, day: 1 },
  { kind: 'inferred', format: 'date', re: new RegExp(`^${D} \\(inferred\\)$`), n: 0, day: 1 },
])

const BLANK = Object.freeze({ kind: 'blank' })
const UNKNOWN = Object.freeze({ kind: 'unknown' })
const MANUAL = Object.freeze({ kind: 'manual' })

/**
 * Parse one cell, whatever the configured format or locale. Answers a frozen object:
 *   { kind: 'blank' } | { kind: 'unknown' } | { kind: 'manual' }
 *   { kind: 'live' | 'inferred', format, n: number | null, day: 'YYYY-MM-DD' | null }
 * ('ordinal' carries no day; 'date' carries no n). Anything that is not exactly one of the grammar's strings
 * (surrounding whitespace aside) parses `unknown`.
 */
function parsePullBatchLabel(value) {
  if (value === undefined || value === null) return BLANK
  if (typeof value !== 'string') return UNKNOWN
  const text = value.trim()
  if (text === '') return BLANK
  if (text === PULL_BATCH_UNKNOWN_LABELS.en || text === PULL_BATCH_UNKNOWN_LABELS['zh-CN']) return UNKNOWN
  if (text === PULL_BATCH_MANUAL_LABELS.en || text === PULL_BATCH_MANUAL_LABELS['zh-CN']) return MANUAL
  for (const pattern of LABEL_PATTERNS) {
    const match = pattern.re.exec(text)
    if (!match) continue
    const n = pattern.n ? Number(match[pattern.n]) : null
    const day = pattern.day ? match[pattern.day] : null
    if (n !== null && !Number.isSafeInteger(n)) return UNKNOWN
    if (day !== null && !isCalendarDay(day)) return UNKNOWN
    return Object.freeze({ kind: pattern.kind, format: pattern.format, n, day })
  }
  return UNKNOWN
}

function isKnownPullBatchLabel(parsed) {
  return Boolean(parsed) && (parsed.kind === 'live' || parsed.kind === 'inferred')
}

// ── the evidence set E (design §5.1) ─────────────────────────────────────────────────────────────────

/** The normalized part id (design §5.1): String(componentSourceId).trim(); a blank never matches. */
function normalizePartId(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isManualRowKey(key) {
  return typeof key === 'string' && key.startsWith(MANUAL_ROW_KEY_PREFIX)
}

function cellText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/** The band cells, createdAt and locked of a reader row (absent band => blanks). */
function rowPullBatchFacts(row) {
  const band = row && isPlainObject(row[EXISTING_ROW_PULL_BATCH]) ? row[EXISTING_ROW_PULL_BATCH] : null
  return {
    pullBatch: band ? cellText(band.pullBatch) : '',
    firstPullBatch: band ? cellText(band.firstPullBatch) : '',
    createdAt: band && typeof band.createdAt === 'string' ? band.createdAt : null,
    locked: Boolean(band && band.locked === true),
  }
}

/** A row people created (新建记录, imports, right-click duplicates): the envelope named a creator. */
function isPersonCreatedRow(row) {
  return Boolean(row) && typeof row[EXISTING_ROW_CREATED_BY_KEY] === 'string' && row[EXISTING_ROW_CREATED_BY_KEY].trim() !== ''
}

/**
 * E (design §5.1): machine-created (no creator on the envelope), not a `manual:v1:` row, with a non-blank
 * normalized part id. Rows people made are never evidence, whatever their cells say (R3; the 10-27 right-click
 * duplicates copy part ids and even band cells).
 */
function isPullBatchEvidenceRow(row) {
  if (!isPlainObject(row)) return false
  if (isPersonCreatedRow(row)) return false
  if (isManualRowKey(row.idempotencyKey)) return false
  return normalizePartId(row.componentSourceId) !== ''
}

/**
 * A gap row (design §6.2): a row of E that is not locked and has a blank band cell. Under
 * `firstPullBatchRule: 'off'` no 首次 value is ever written, so only a blank 本次 cell makes a gap row.
 */
function isPullBatchGapRow(row, { config } = {}) {
  const cfg = normalizePullBatchConfig(config)
  if (!isPullBatchEvidenceRow(row)) return false
  const facts = rowPullBatchFacts(row)
  if (facts.locked) return false
  if (facts.pullBatch.trim() === '') return true
  return cfg.firstPullBatchRule !== 'off' && facts.firstPullBatch.trim() === ''
}

function countPullBatchGapRows(rows, { config } = {}) {
  const cfg = normalizePullBatchConfig(config)
  let count = 0
  for (const row of Array.isArray(rows) ? rows : []) if (isPullBatchGapRow(row, { config: cfg })) count += 1
  return count
}

// ── path tokens for rule F (carry-policy precedent: `::duplicate:` stripped, blanks refused) ─────────
function pathTokensOf(value) {
  let tokens = value
  if (typeof tokens === 'string') {
    try {
      tokens = JSON.parse(tokens)
    } catch {
      return null
    }
  }
  if (!Array.isArray(tokens) || tokens.length === 0) return null
  const out = []
  for (const token of tokens) {
    if (typeof token !== 'string') return null
    const base = token.split(DUPLICATE_RESOLVED_SEPARATOR)[0].trim()
    if (base === '') return null
    out.push(base)
  }
  return out
}

function isProperSuffix(candidate, tokens) {
  if (!Array.isArray(candidate) || !Array.isArray(tokens) || candidate.length >= tokens.length) return false
  const offset = tokens.length - candidate.length
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== tokens[offset + index]) return false
  }
  return true
}

// ── 首次批次: the carry rules (design §5.2 / §5.3) ───────────────────────────────────────────────────

/**
 * The opened_at (ms) of a label's ledger batch. Void batches are ignored. When several non-void batches carry
 * the SAME label (the 'date' format, two batches on one day) the LATEST opening is answered: an open row
 * between the two could predate the material's first appearance, so it must decide 历史批次未知 (fail-safe).
 */
function openedAtIndex(ledgerBatches) {
  const byLabel = new Map()
  for (const batch of Array.isArray(ledgerBatches) ? ledgerBatches : []) {
    if (!batch || batch.status === 'void' || !nonBlankString(batch.label)) continue
    const ms = timeMsOf(batch.openedAt)
    if (ms === null) continue
    const label = batch.label.trim()
    if (!byLabel.has(label) || byLabel.get(label) < ms) byLabel.set(label, ms)
  }
  return byLabel
}

/** L* (design §5.2 step 3): the earliest known label — by n when every known label has one, else by day. */
function earliestKnownLabel(known) {
  const byN = known.every((entry) => entry.parsed.n !== null)
  const byDay = known.every((entry) => entry.parsed.day !== null)
  if (!byN && !byDay) return null
  let best = null
  for (const entry of known) {
    if (best === null) {
      best = entry
      continue
    }
    const a = byN ? entry.parsed.n : entry.parsed.day
    const b = byN ? best.parsed.n : best.parsed.day
    if (a < b || (a === b && entry.label < best.label)) best = entry
  }
  return best
}

/**
 * Steps 2-6 of §5.2 over a matched set M (the rule decides how M is chosen).
 *   M empty                            => null ("this batch")
 *   no known row                       => 历史批次未知
 *   known labels not comparable        => 历史批次未知   (mixed formats on one sheet; fail-safe)
 *   an open row could predate L*       => 历史批次未知   (R6: createdAt missing, no ledger opened_at for L*, or
 *                                                        created earlier than L*'s batch opened_at)
 *   otherwise                          => L*'s label string, verbatim (a 推定 marker and the date travel with it)
 */
function decideFirstPullBatch(matched, { locale, openedAtByLabel }) {
  if (!Array.isArray(matched) || matched.length === 0) return null
  const known = []
  const open = []
  for (const entry of matched) {
    const parsed = parsePullBatchLabel(entry.firstPullBatch)
    if (isKnownPullBatchLabel(parsed)) known.push({ parsed, label: entry.firstPullBatch.trim() })
    else open.push(entry)
  }
  const unknown = PULL_BATCH_UNKNOWN_LABELS[locale]
  if (known.length === 0) return unknown
  const best = earliestKnownLabel(known)
  if (best === null) return unknown
  if (open.length > 0) {
    const openedAtMs = openedAtByLabel.has(best.label) ? openedAtByLabel.get(best.label) : null
    for (const entry of open) {
      const createdMs = timeMsOf(entry.createdAt)
      if (createdMs === null || openedAtMs === null || createdMs < openedAtMs) return unknown
    }
  }
  return best.label
}

/** One evidence entry of a reader row (or a trashed row). */
function evidenceEntryOf(row, { trashed = false } = {}) {
  const facts = rowPullBatchFacts(row)
  return {
    partId: normalizePartId(row.componentSourceId),
    key: nonBlankString(row.idempotencyKey) ? row.idempotencyKey.trim() : null,
    active: trashed ? false : row.active,
    trashed,
    path: pathTokensOf(row.path),
    firstPullBatch: facts.firstPullBatch,
    createdAt: facts.createdAt,
  }
}

/**
 * The carry map of one plan: idempotency key of every ADD decision -> 首次批次 label, or null ("this batch").
 *
 *   'material' (A, default):    M = rows of E whose normalized part id equals the new row's, active AND inactive.
 *   'predecessor_suffix' (F):   M = rows of E that are predecessors (active === false, swept INACTIVE by this
 *                               plan, or trashed) whose path is a PROPER suffix of the new row's path.
 *   'off':                      nothing is computed — the answer is an EMPTY Map and the writer leaves every
 *                               首次 cell blank (the gap predicate then reads the 本次 cell only).
 *
 * `existingRows`: the reader rows of the in-lease read (the plan's own ADD records are not among them, so rows
 * ADDed by the same run never feed M). `trashedRows`: rows of the sheet's trash in the reader's shape; read ONLY
 * when `config.trashedRowsAreEvidence === true`, otherwise ignored. `ledgerBatches`: the project's ledger rows
 * ({ label, openedAt, status }) for the R6 rule. `locale`: the sheet's captured label locale.
 * Server-held: the map is keyed by idempotency keys (values-bearing) and is never answered, logged or hashed.
 */
function buildFirstPullBatchByKey({ decisions, existingRows, trashedRows, ledgerBatches, locale, config } = {}) {
  const cfg = normalizePullBatchConfig(config)
  const lang = assertLocale(locale)
  const out = new Map()
  if (cfg.firstPullBatchRule === 'off') return out
  const openedAtByLabel = openedAtIndex(ledgerBatches)
  const list = Array.isArray(decisions) ? decisions : []
  const swept = new Set()
  for (const decision of list) {
    if (decision && decision.decision === 'inactive' && nonBlankString(decision.idempotencyKey)) swept.add(decision.idempotencyKey.trim())
  }
  const evidence = []
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    if (isPullBatchEvidenceRow(row)) evidence.push(evidenceEntryOf(row))
  }
  if (cfg.trashedRowsAreEvidence === true) {
    for (const row of Array.isArray(trashedRows) ? trashedRows : []) {
      if (isPullBatchEvidenceRow(row)) evidence.push(evidenceEntryOf(row, { trashed: true }))
    }
  }
  const byPart = new Map()
  const predecessorsByPath = new Map()
  for (const entry of evidence) {
    if (!byPart.has(entry.partId)) byPart.set(entry.partId, [])
    byPart.get(entry.partId).push(entry)
    const predecessor = entry.active === false || (entry.key !== null && swept.has(entry.key))
    if (predecessor && entry.path) {
      const pathKey = JSON.stringify(entry.path)
      if (!predecessorsByPath.has(pathKey)) predecessorsByPath.set(pathKey, [])
      predecessorsByPath.get(pathKey).push(entry)
    }
  }
  for (const decision of list) {
    if (!decision || decision.decision !== 'add') continue
    const record = isPlainObject(decision.record) ? decision.record : {}
    const key = nonBlankString(decision.idempotencyKey)
      ? decision.idempotencyKey.trim()
      : (nonBlankString(record.idempotencyKey) ? record.idempotencyKey.trim() : null)
    if (!key) continue
    let matched = []
    if (cfg.firstPullBatchRule === 'material') {
      const partId = normalizePartId(record.componentSourceId)
      matched = partId === '' ? [] : (byPart.get(partId) || [])
    } else {
      const tokens = pathTokensOf(record.path)
      if (tokens) {
        for (let start = 1; start < tokens.length; start += 1) {
          const candidates = predecessorsByPath.get(JSON.stringify(tokens.slice(start)))
          if (candidates) matched = matched.concat(candidates)
        }
      }
    }
    out.set(key, decideFirstPullBatch(matched, { locale: lang, openedAtByLabel }))
  }
  return out
}

// ── one content-only digest (design §3.7, R10) ─────────────────────────────────────────────────────────
// sha256(['stock-preparation/pull-batch-source/v1', actionId, canonicalRows(rows without tenant ext_ keys)]),
// first 32 hex. NO lane prefix: the same BOM content is the same logical pull on either lane (a small retry of a
// failed large job joins its open batch). `canonicalRows` is injected (table-actions' canonical hash order) so
// this file requires nothing; the serialization sorts object keys, so key order never moves the digest. Nothing
// but the action id and the rows enters: parameters, read plan, principal, lane and run ids change nothing.
const PULL_BATCH_SOURCE_DIGEST_SCHEME = 'stock-preparation/pull-batch-source/v1'
const PULL_BATCH_SOURCE_DIGEST_PATTERN = /^[0-9a-f]{32}$/

function withoutTenantExtKeys(row) {
  if (!isPlainObject(row)) return row
  const out = {}
  for (const key of Object.keys(row)) if (!key.startsWith('ext_')) out[key] = row[key]
  return out
}

function pullBatchSourceDigest({ actionId, rows, canonicalRows } = {}) {
  if (!nonBlankString(actionId)) throw stampInvalid('actionId', 'the pull-batch digest needs the action id')
  if (!Array.isArray(rows)) throw stampInvalid('rows', 'the pull-batch digest needs the expansion rows')
  if (typeof canonicalRows !== 'function') throw stampInvalid('canonicalRows', 'the pull-batch digest needs the canonical row order')
  const ordered = canonicalRows(rows.map(withoutTenantExtKeys))
  if (!Array.isArray(ordered)) throw stampInvalid('canonicalRows', 'the canonical row order must answer an array')
  return sha256Hex(canonicalJson([PULL_BATCH_SOURCE_DIGEST_SCHEME, actionId, ordered])).slice(0, 32)
}

// ── the history plan (design §8.3; pure, persisted by the install in a later PR) ───────────────────────
//
// Input rows: the rows of E the run is to label, each { recordId, createdAt, decision, plannedAt, active,
// partId, path } (createdAt from the envelope; decision / plannedAt are the RUN stamps lastPlmRefreshDecision /
// lastPlmRefreshAt, read ONCE here and never again: membership afterwards is decided from the persisted cuts,
// exceptions and coveredUntil only).
const PULL_BATCH_HISTORY_SCHEME = 'pull-batch-history/v1'
const HISTORY_CLOCK_SLACK_MS = 5000
const HISTORY_DEGENERATE_SPREAD_MS = 2000
const HISTORY_DEFAULT_GAP_MINUTES = 30

function historyInvalid(field) {
  return stampInvalid(field, 'the pull-batch history input is malformed')
}

function normalizeHistoryRows(rows) {
  if (!Array.isArray(rows)) throw historyInvalid('rows')
  const seen = new Set()
  return rows.map((row, index) => {
    if (!isPlainObject(row) || !nonBlankString(row.recordId)) throw historyInvalid(`rows[${index}].recordId`)
    const recordId = row.recordId.trim()
    if (seen.has(recordId)) throw historyInvalid(`rows[${index}].recordId`)
    seen.add(recordId)
    return {
      recordId,
      createdMs: timeMsOf(row.createdAt),
      decision: typeof row.decision === 'string' ? row.decision : null,
      plannedMs: timeMsOf(row.plannedAt),
      active: row.active,
      partId: normalizePartId(row.partId),
      path: pathTokensOf(row.path),
    }
  })
}

/** The anchors (distinct add plan times, each one execution — F24′) and the degenerate test (steps 1-2). */
function historyAnchors(rows) {
  const anchors = new Set()
  let lateAddStamps = 0
  for (const row of rows) {
    if (row.decision !== 'add' || row.plannedMs === null) continue
    if (row.createdMs !== null && row.plannedMs <= row.createdMs + HISTORY_CLOCK_SLACK_MS) anchors.add(row.plannedMs)
    else if (row.createdMs !== null) lateAddStamps += 1
  }
  const created = rows.map((row) => row.createdMs).filter((ms) => ms !== null)
  const spread = created.length > 0 ? Math.max(...created) - Math.min(...created) : 0
  const degenerate = (anchors.size > 1 && spread < HISTORY_DEGENERATE_SPREAD_MS) || lateAddStamps > 1
  return { anchors: Array.from(anchors).sort((a, b) => a - b), degenerate }
}

function anchorOfRow(row, anchorSet) {
  if (row.decision !== 'add' || row.plannedMs === null || row.createdMs === null) return null
  if (row.plannedMs > row.createdMs + HISTORY_CLOCK_SLACK_MS) return null
  return anchorSet.has(row.plannedMs) ? row.plannedMs : null
}

/**
 * Plan the history of `rows` (design §8.3).
 *   base          0 at the first install; the ledger's max(batch_no, history_batch_count) in a gap pass
 *   coveredUntil  the DATABASE clock of the read that produced the rows (a row is covered iff created_at ≤ it)
 *   priorRows     rows already labelled (a gap pass) — they only feed 首次 ({ partId, path, active,
 *                 firstPullBatch, createdAt })
 *   trashedRows   the same shape; read ONLY when config.trashedRowsAreEvidence === true (always predecessors)
 *   gapMinutes    G, default 30, persisted with the plan
 *   locale        the sheet's label locale; config: the sheet's captured configuration
 * Answers { plan, assignments }: the persisted plan (values-free; its digest covers every input that moves a
 * label, the meaning-locked configuration included) and the per-row assignment Map recordId ->
 * { k, pullBatch, firstPullBatch } (recomputable from the plan; never persisted). Under rule 'off' every
 * assigned firstPullBatch is '' (left blank).
 */
function planPullBatchHistory({ rows, priorRows, trashedRows, gapMinutes, base, coveredUntil, locale, config, ledgerBatches } = {}) {
  const cfg = normalizePullBatchConfig(config)
  const lang = assertLocale(locale)
  const input = normalizeHistoryRows(rows)
  const gap = gapMinutes === undefined || gapMinutes === null ? HISTORY_DEFAULT_GAP_MINUTES : gapMinutes
  if (!Number.isSafeInteger(gap) || gap < 1 || gap > 24 * 60) throw historyInvalid('gapMinutes')
  const startBase = base === undefined || base === null ? 0 : base
  if (!Number.isSafeInteger(startBase) || startBase < 0) throw historyInvalid('base')
  const coveredMs = timeMsOf(coveredUntil)
  if (coveredMs === null) throw historyInvalid('coveredUntil')
  const gapMs = gap * 60 * 1000
  const { anchors, degenerate } = historyAnchors(input)
  const anchorSet = new Set(anchors)

  // Steps 3-4: intervals on the createdAt axis. Each anchor time is a cut point (S0 = (−∞, a1), Si = [ai, ai+1));
  // inside a segment a createdAt gap longer than G splits it, UNLESS a later row of the segment is add-stamped with
  // the segment's own anchor (a paused large job stays one execution). S0 splits at every gap. Degenerate createdAt
  // (R2): no createdAt inference at all — the clusters are the anchors only, ordered by plan time.
  const clusters = []
  if (degenerate) {
    for (const anchor of anchors) clusters.push({ anchorMs: anchor, segmentAnchorMs: anchor, startMs: anchor, endMs: anchor, members: [] })
  } else {
    const placed = input
      .filter((row) => row.createdMs !== null)
      .sort((a, b) => a.createdMs - b.createdMs || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
    const bounds = [-Infinity, ...anchors, Infinity]
    for (let segmentIndex = 0; segmentIndex + 1 < bounds.length; segmentIndex += 1) {
      const fromMs = bounds[segmentIndex]
      const toMs = bounds[segmentIndex + 1]
      const segmentAnchorMs = segmentIndex === 0 ? null : fromMs
      const inside = placed.filter((row) => row.createdMs >= fromMs && row.createdMs < toMs)
      let current = null
      for (let index = 0; index < inside.length; index += 1) {
        const row = inside[index]
        let split = current === null
        if (!split && row.createdMs - inside[index - 1].createdMs > gapMs) {
          const continued = segmentAnchorMs !== null
            && inside.slice(index).some((later) => anchorOfRow(later, anchorSet) === segmentAnchorMs)
          split = !continued
        }
        if (split) {
          // The first interval of an anchored segment carries its anchor; a later gap split inside it carries none.
          current = { anchorMs: current === null ? segmentAnchorMs : null, segmentAnchorMs, startMs: row.createdMs, endMs: row.createdMs, members: [] }
          clusters.push(current)
        }
        current.endMs = row.createdMs
        current.members.push(row)
      }
    }
  }

  // Step 6: membership. A row belongs to the interval holding its createdAt; the ONE exception is an add-stamped
  // row whose createdAt falls in ANOTHER anchor's segment (concurrent pulls on the R-line, or clock skew): it joins
  // its own anchor's cluster and is listed in `exceptions`. An anchor whose segment holds none of its rows gets its
  // cluster here, so every exception has one.
  const anchorCluster = (anchorMs, row) => {
    let cluster = clusters.find((entry) => entry.anchorMs === anchorMs)
    if (!cluster) {
      cluster = { anchorMs, segmentAnchorMs: anchorMs, startMs: row.createdMs, endMs: row.createdMs, members: [] }
      clusters.push(cluster)
    }
    return cluster
  }
  const assignment = new Map()
  const exceptionRows = []
  let unplacedRows = 0
  for (const row of input) {
    if (degenerate) {
      const own = anchorOfRow(row, anchorSet)
      const cluster = own === null ? null : clusters.find((entry) => entry.anchorMs === own)
      if (cluster) {
        cluster.members.push(row)
        assignment.set(row.recordId, cluster)
      } else {
        assignment.set(row.recordId, null)
        unplacedRows += 1
      }
      continue
    }
    if (row.createdMs === null) {
      assignment.set(row.recordId, null)
      unplacedRows += 1
      continue
    }
    const byTime = clusters.find((cluster) => cluster.members.includes(row))
    const own = anchorOfRow(row, anchorSet)
    if (own !== null && byTime && byTime.segmentAnchorMs !== own) {
      byTime.members = byTime.members.filter((member) => member !== row)
      const target = anchorCluster(own, row)
      target.members.push(row)
      exceptionRows.push(row)
      assignment.set(row.recordId, target)
      continue
    }
    assignment.set(row.recordId, byTime || null)
  }
  // The persisted bounds of a cluster are those of its TIME members only (an exception is found by its record id
  // first, so it must not widen an interval — the intervals stay disjoint and membership stays unambiguous). A
  // cluster that holds only exceptions takes its bounds from them.
  if (!degenerate) {
    const exceptionSet = new Set(exceptionRows)
    for (const cluster of clusters) {
      const timeMembers = cluster.members.filter((member) => !exceptionSet.has(member))
      const span = timeMembers.length > 0 ? timeMembers : cluster.members
      if (span.length === 0) continue
      cluster.startMs = Math.min(...span.map((member) => member.createdMs))
      cluster.endMs = Math.max(...span.map((member) => member.createdMs))
    }
  }
  // Step 5: a time interval whose only rows became exceptions holds nothing and is no cluster. Number the rest in
  // time order, base + 1 …; evidence = plan_time when the interval holds add rows of its anchor, else created_at.
  const kept = clusters
    .filter((cluster) => cluster.members.length > 0)
    .sort((a, b) => a.startMs - b.startMs || (a.anchorMs === null ? 1 : 0) - (b.anchorMs === null ? 1 : 0))
  kept.forEach((cluster, index) => {
    cluster.k = startBase + index + 1
    cluster.label = formatPullBatchLabel({ kind: 'inferred', n: cluster.k, day: pullBatchLabelDay(cluster.startMs), locale: lang, labelFormat: cfg.labelFormat })
    cluster.evidence = cluster.anchorMs !== null && cluster.members.some((row) => anchorOfRow(row, anchorSet) === cluster.anchorMs)
      ? 'plan_time'
      : 'created_at'
  })

  // Step 7: labels. 本次 = the cluster's inferred label; 首次 by the configured rule, in cluster order, over the rows
  // already labelled (a gap pass's priorRows, trashed rows when they are evidence) and the rows of EARLIER clusters
  // (rows of the same cluster are "this batch").
  const unknown = PULL_BATCH_UNKNOWN_LABELS[lang]
  const rule = cfg.firstPullBatchRule
  const openedAtByLabel = openedAtIndex(ledgerBatches)
  for (const cluster of kept) {
    if (!openedAtByLabel.has(cluster.label) || openedAtByLabel.get(cluster.label) < cluster.startMs) openedAtByLabel.set(cluster.label, cluster.startMs)
  }
  const labelled = []
  const poolEntry = (entry, trashed) => ({
    partId: normalizePartId(entry.partId),
    path: pathTokensOf(entry.path),
    active: trashed ? false : entry.active,
    firstPullBatch: cellText(entry.firstPullBatch),
    createdAt: entry.createdAt === undefined ? null : entry.createdAt,
  })
  for (const prior of Array.isArray(priorRows) ? priorRows : []) if (isPlainObject(prior)) labelled.push(poolEntry(prior, false))
  if (cfg.trashedRowsAreEvidence === true) {
    for (const trashed of Array.isArray(trashedRows) ? trashedRows : []) if (isPlainObject(trashed)) labelled.push(poolEntry(trashed, true))
  }
  const matchFor = (row, pool) => {
    if (rule === 'material') return row.partId === '' ? [] : pool.filter((entry) => entry.partId === row.partId)
    if (!row.path) return []
    return pool.filter((entry) => entry.active === false && entry.path && isProperSuffix(entry.path, row.path))
  }
  const firstFor = (row, fallback) => {
    if (rule === 'off') return ''
    const first = decideFirstPullBatch(matchFor(row, labelled), { locale: lang, openedAtByLabel })
    return first === null ? fallback : first
  }
  const assignments = new Map()
  for (const cluster of kept) {
    const decided = []
    for (const row of cluster.members) {
      const firstPullBatch = firstFor(row, cluster.label)
      assignments.set(row.recordId, { k: cluster.k, pullBatch: cluster.label, firstPullBatch })
      decided.push({ partId: row.partId, path: row.path, active: row.active, firstPullBatch, createdAt: row.createdMs === null ? null : isoOf(row.createdMs) })
    }
    labelled.push(...decided)
  }
  for (const row of input) {
    if (assignments.has(row.recordId)) continue
    assignments.set(row.recordId, { k: null, pullBatch: unknown, firstPullBatch: firstFor(row, unknown) })
  }

  const plan = {
    scheme: PULL_BATCH_HISTORY_SCHEME,
    locale: lang,
    firstPullBatchRule: cfg.firstPullBatchRule,
    labelFormat: cfg.labelFormat,
    trashedRowsAreEvidence: cfg.trashedRowsAreEvidence,
    gapMinutes: gap,
    degenerate,
    base: startBase,
    coveredUntil: isoOf(coveredMs),
    cuts: anchors.map(isoOf),
    clusters: kept.map((cluster) => ({
      k: cluster.k,
      evidence: cluster.evidence,
      anchorAt: cluster.anchorMs === null ? null : isoOf(cluster.anchorMs),
      startAt: isoOf(cluster.startMs),
      endAt: isoOf(cluster.endMs),
      rows: cluster.members.length,
      active: cluster.members.filter((row) => row.active !== false).length,
      inactive: cluster.members.filter((row) => row.active === false).length,
      label: cluster.label,
    })),
    exceptions: exceptionRows
      .map((row) => ({ recordId: row.recordId, k: assignment.get(row.recordId).k }))
      .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)),
    unplacedRows,
    interleavedRows: exceptionRows.length,
    K: kept.length,
  }
  plan.digest = pullBatchHistoryPlanDigest(plan)
  return { plan: Object.freeze(plan), assignments }
}

function pullBatchHistoryPlanDigest(plan) {
  const { digest: _digest, ...rest } = isPlainObject(plan) ? plan : {}
  return sha256Hex(canonicalJson(rest))
}

/**
 * Which cluster of a PERSISTED plan a row belongs to (design §8.3 step 6, §8.2 I3): the persisted exceptions
 * first, then the persisted interval that contains its createdAt — never a RUN stamp. A row created after
 * `coveredUntil` is not covered (answers 'uncovered'); a row the plan could not place answers null.
 */
function pullBatchHistoryMembership(plan, { recordId, createdAt } = {}) {
  if (!isPlainObject(plan) || plan.scheme !== PULL_BATCH_HISTORY_SCHEME) throw historyInvalid('plan')
  const exception = (plan.exceptions || []).find((entry) => entry.recordId === recordId)
  if (exception) return exception.k
  const createdMs = timeMsOf(createdAt)
  if (createdMs === null) return null
  if (createdMs > timeMsOf(plan.coveredUntil)) return 'uncovered'
  if (plan.degenerate) return null
  for (const cluster of plan.clusters || []) {
    const startMs = timeMsOf(cluster.startAt)
    const endMs = timeMsOf(cluster.endAt)
    if (createdMs >= startMs && createdMs <= endMs) return cluster.k
  }
  return null
}

// ── the attested historical count (design §8.5; R7, G8(a)) ───────────────────────────────────────────
/**
 * The count rule of an install / gap pass, pure.
 *   historyMode 'inferred' (default): `confirmHistoricalBatchCount` must EQUAL the plan's K (degenerate plans
 *     too), else 409 HISTORY_COUNT_MISMATCH with K. The plan's inferred batches are written.
 *   historyMode 'unknown': any integer ≥ 0. Every covered machine row gets 历史批次未知 in both cells and no
 *     inferred batch is written.
 * In either mode `historyBatchCount` = plan.base + the confirmed count (= K, or the confirmed count, at a first
 * install where base is 0), and live numbering continues after max(batch_no, historyBatchCount).
 * A malformed mode or count => 400 INSTALL_REQUEST_INVALID.
 */
function resolvePullBatchHistoryCount({ plan, historyMode, confirmHistoricalBatchCount } = {}) {
  if (!isPlainObject(plan) || plan.scheme !== PULL_BATCH_HISTORY_SCHEME || !Number.isSafeInteger(plan.K) || !Number.isSafeInteger(plan.base)) {
    throw historyInvalid('plan')
  }
  const mode = historyMode === undefined ? 'inferred' : historyMode
  if (!PULL_BATCH_HISTORY_MODES.includes(mode)) {
    throw new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.INSTALL_REQUEST_INVALID, 'historyMode must be inferred or unknown', { field: 'historyMode' })
  }
  const count = confirmHistoricalBatchCount
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.INSTALL_REQUEST_INVALID, 'confirmHistoricalBatchCount must be an integer of at least 0', { field: 'confirmHistoricalBatchCount' })
  }
  if (mode === 'inferred' && count !== plan.K) {
    throw new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.HISTORY_COUNT_MISMATCH, 'the attested historical pull count differs from the plan; re-plan with another gap or use unknown mode', { K: plan.K, degenerate: plan.degenerate === true })
  }
  const historyBatchCount = plan.base + count
  return Object.freeze({
    historyMode: mode,
    historyBatchCount,
    writesInferredBatches: mode === 'inferred',
    firstLiveBatchNo: historyBatchCount + 1,
  })
}

/** Live numbering (design §3.5 step 4, Q-BI-11): max(max non-void batch_no, history_batch_count) + 1. */
function nextLivePullBatchNo({ maxBatchNo, historyBatchCount } = {}) {
  const max = maxBatchNo === undefined || maxBatchNo === null ? 0 : maxBatchNo
  const floor = historyBatchCount === undefined || historyBatchCount === null ? 0 : historyBatchCount
  if (!Number.isSafeInteger(max) || max < 0) throw stampInvalid('maxBatchNo', 'maxBatchNo must be an integer of at least 0')
  if (!Number.isSafeInteger(floor) || floor < 0) throw stampInvalid('historyBatchCount', 'historyBatchCount must be an integer of at least 0')
  return Math.max(max, floor) + 1
}

module.exports = {
  DEFAULT_PULL_BATCH_CONFIG,
  EXISTING_ROW_PULL_BATCH,
  FIRST_PULL_BATCH_RULES,
  MANUAL_ROW_KEY_PREFIX,
  PULL_BATCH_BAND_FIELD_IDS,
  PULL_BATCH_CLOSED_REASONS,
  PULL_BATCH_CONFIG_KEYS,
  PULL_BATCH_CONFIG_VALUES,
  PULL_BATCH_ERROR_CODES,
  PULL_BATCH_ERROR_HTTP_STATUS,
  PULL_BATCH_EVIDENCE_CLASSES,
  PULL_BATCH_HISTORY_MODES,
  PULL_BATCH_HISTORY_SCHEME,
  PULL_BATCH_LABEL_FORMATS,
  PULL_BATCH_LABEL_KINDS,
  PULL_BATCH_LOCALES,
  PULL_BATCH_MANUAL_LABELS,
  PULL_BATCH_MEANING_LOCKED_KEYS,
  PULL_BATCH_RESPONSE_REASONS,
  PULL_BATCH_SOURCE_DIGEST_PATTERN,
  PULL_BATCH_SOURCE_DIGEST_SCHEME,
  PULL_BATCH_UNKNOWN_LABELS,
  StockPreparationPullBatchError,
  buildFirstPullBatchByKey,
  countPullBatchGapRows,
  formatPullBatchLabel,
  isPullBatchEvidenceRow,
  isPullBatchGapRow,
  nextLivePullBatchNo,
  normalizePartId,
  normalizePullBatchConfig,
  parsePullBatchLabel,
  planPullBatchHistory,
  pullBatchHistoryMembership,
  pullBatchHistoryPlanDigest,
  pullBatchLabelDay,
  pullBatchSourceDigest,
  refusedPullBatchConfigEdits,
  resolvePullBatchHistoryCount,
  rowPullBatchFacts,
  __internals: {
    EXISTING_ROW_CREATED_BY_KEY,
    canonicalJson,
    decideFirstPullBatch,
    isCalendarDay,
    isManualRowKey,
    isPersonCreatedRow,
    isProperSuffix,
    pathTokensOf,
    timeMsOf,
  },
}
