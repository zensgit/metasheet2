// 批次标识 BI-3 (design §11, §5.5; register R-65, rulings C2 / C6 / C10 / C12 / C13) — THE PULL-BATCH LINES, read on the web.
//
// PURE. No I/O, no clock, no storage, no `plugins/` import: parsers over the three values-free answers the server gives
// while the switch `STOCK_PREP_PULL_BATCH_ENABLED` is exactly 'true', and the customer sentences built from them. Kept out
// of any `api/` directory on purpose (the vite browser harness routes `**/api/**`). Modelled on refreshState.ts.
//
// WHAT THE SERVER SENDS (BI-1b, #6814; S-1 rides with this PR):
//   board stanza  `board.pullBatch` — `readPullBatchBoardStanza` (lib/stock-preparation-pull-batch-status.cjs):
//                   { enabled: true, ready, latest: { label, batchNo } | null, batchCount, paused, gapRows?, firstPullBatchRule? }
//   preview       `plan.pullBatch` — `previewStanzaOf` (lib/stock-preparation-pull-batch-lanes.cjs):
//                   { preview: true, wouldStamp, reason, gapRows? }
//   outcome       `applied.pullBatch` / a large chunk's `job.pullBatch` — the small answer / `largeChunkAnswerOf`:
//                   { stamped: true, label, batchNo, joined, createdRowCount } | { stamped: false, reason, gapRows? }
//
// OFF IS INVISIBLE (C6, the R61 lesson). With the switch off the server sends NO `pullBatch` key anywhere, every parser
// here answers `null`, and every caller renders nothing — the page is the one it was. The design's older
// `{ enabled: false }` shape is read the same way.
//
// FAIL CLOSED. Anything present but malformed never reads as a good state: a malformed `latest` is `unknown` (never
// 「还没有拉取批次」, critic C-9); an unknown token is `unknown` / `other`; an absent or unrecognised captured rule renders
// ONLY the rule-independent 本次拉取 sentence — never the 按物料 sentence (brief §2: a rule-F sheet must never read rule-A
// copy).
//
// LABELS VERBATIM. `latest.label` / `label` is the ledger's own label, already formatted by the sheet's captured
// `labelFormat` and locale (第N批（D）, 第N批（推定，D）, 第N批, Batch N (D)). It is rendered as given and never recomposed
// from `batchNo` plus a date.
//
// VALUES-FREE. The answers carry tokens, counts, booleans and the ledger's own label; this module keeps exactly those
// (clamped) and nothing else. A reason token outside the closed lists is clamped to `other` and the raw value is never
// carried (the projectSync.ts rule for `STOCK_PREPARATION_UNKNOWN_TOKEN`).
//
// BI-6b (delivery guide) reuses the §5.5 sentences below verbatim. BI-7's settings page (pullBatchSettings.ts) keeps
// its own `STOCK_PREP_PULL_BATCH_SETTING_VALUES.firstPullBatchRule`; both lists are pinned live against the plugin's
// `PULL_BATCH_CONFIG_VALUES.firstPullBatchRule` (PBL-XSIDE here, PBS-VOCAB there), and whichever lands second may
// import the other's.
import { stockPrepErrorPlain, type StockPrepPlainEntry, type StockPrepPlainText } from './plainLanguage'

/** The two captured 首次批次 rules (C2) — equal to the plugin's `PULL_BATCH_CONFIG_VALUES.firstPullBatchRule` (PBL-XSIDE). */
export const STOCK_PREP_PULL_BATCH_RULES = Object.freeze(['material', 'predecessor_suffix'] as const)
export type StockPrepPullBatchRule = typeof STOCK_PREP_PULL_BATCH_RULES[number]

/** The board stanza's closed `paused` list — deep-equal to `PULL_BATCH_BOARD_PAUSED_REASONS` (PBL-XSIDE). */
export const STOCK_PREP_PULL_BATCH_BOARD_PAUSED = Object.freeze([
  'not_installed',
  'columns_unproven',
  'columns_partial',
  'history_pending',
  'installing',
  'ledger_unreadable',
  'history_gap',
] as const)
export type StockPrepPullBatchBoardPaused = typeof STOCK_PREP_PULL_BATCH_BOARD_PAUSED[number]

/** Every reason a preview or an outcome can answer — set-equal to `PULL_BATCH_RESPONSE_REASONS ∪ PULL_BATCH_PREVIEW_REASONS`. */
export const STOCK_PREP_PULL_BATCH_REASONS = Object.freeze([
  'disabled',
  'not_installed',
  'columns_unproven',
  'columns_partial',
  'history_pending',
  'history_gap',
  'no_creates',
  'installing',
  'ledger_unreadable',
] as const)
export type StockPrepPullBatchReason = typeof STOCK_PREP_PULL_BATCH_REASONS[number]

/** The error-code family whose run stops this module reads (BI-1b's `PULL_BATCH_ERROR_CODES`). */
export const STOCK_PREP_PULL_BATCH_ERROR_PREFIX = 'STOCK_PREP_PULL_BATCH_'

export type StockPrepPullBatchBoardState = 'ready' | 'not_installed' | 'installing' | 'gap' | 'pending' | 'partial' | 'unknown'

export interface StockPrepPullBatchLabel {
  label: string
  batchNo: number
}

export interface StockPrepPullBatchBoard {
  state: StockPrepPullBatchBoardState
  latest: StockPrepPullBatchLabel | null
  batchCount: number | null
  gapRows: number | null
  rule: StockPrepPullBatchRule | null
}

export interface StockPrepPullBatchPreview {
  wouldStamp: boolean
  reason: StockPrepPullBatchReason | 'other' | null
  gapRows: number | null
}

export type StockPrepPullBatchOutcome =
  | { kind: 'stamped'; label: string; batchNo: number; joined: boolean; createdRowCount: number }
  | { kind: 'no_creates' }
  | { kind: 'unstamped'; reason: StockPrepPullBatchReason | 'other'; gapRows: number | null }
  | { kind: 'disabled' }

/** The longest label the ledger can write (pure module grammar); a longer string is not a label. */
export const STOCK_PREP_PULL_BATCH_LABEL_MAX = 64

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function labelOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= STOCK_PREP_PULL_BATCH_LABEL_MAX ? value : null
}

function batchNoOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

function ruleOf(value: unknown): StockPrepPullBatchRule | null {
  return typeof value === 'string' && (STOCK_PREP_PULL_BATCH_RULES as readonly string[]).includes(value) ? value as StockPrepPullBatchRule : null
}

function reasonOf(value: unknown): StockPrepPullBatchReason | 'other' {
  return typeof value === 'string' && (STOCK_PREP_PULL_BATCH_REASONS as readonly string[]).includes(value) ? value as StockPrepPullBatchReason : 'other'
}

const PAUSED_TO_STATE: Readonly<Record<StockPrepPullBatchBoardPaused, StockPrepPullBatchBoardState>> = Object.freeze({
  not_installed: 'not_installed',
  installing: 'installing',
  history_gap: 'gap',
  history_pending: 'pending',
  columns_partial: 'partial',
  // No claim about pulls on purpose: `ledger_unreadable` on a band-present sheet is a 503 at apply, while
  // `columns_unproven` is unstamped (brief §4.1 truth checks).
  columns_unproven: 'unknown',
  ledger_unreadable: 'unknown',
})

/**
 * Parse the board's `pullBatch` key. `null` for absent, non-object, or `enabled !== true` (C6). Otherwise a state and
 * the clamped numbers. A `latest` that is present but malformed, and a ready sheet that says neither a latest batch
 * nor zero batches, are `unknown` (fail closed, critic C-9).
 */
export function parseStockPrepPullBatchBoardStanza(value: unknown): StockPrepPullBatchBoard | null {
  if (!isPlainObject(value) || value.enabled !== true) return null
  const rule = ruleOf(value.firstPullBatchRule)
  const batchCount = countOf(value.batchCount)
  let latest: StockPrepPullBatchLabel | null = null
  let malformed = false
  if (value.latest !== null && value.latest !== undefined) {
    const raw = isPlainObject(value.latest) ? value.latest : null
    const label = raw ? labelOf(raw.label) : null
    const batchNo = raw ? batchNoOf(raw.batchNo) : null
    if (label !== null && batchNo !== null) latest = Object.freeze({ label, batchNo })
    else malformed = true
  }
  let state: StockPrepPullBatchBoardState
  if (value.paused === null || value.paused === undefined) {
    state = value.ready === true ? 'ready' : 'unknown'
  } else if (typeof value.paused === 'string' && Object.prototype.hasOwnProperty.call(PAUSED_TO_STATE, value.paused)) {
    state = PAUSED_TO_STATE[value.paused as StockPrepPullBatchBoardPaused]
  } else {
    state = 'unknown'
  }
  if (malformed) state = 'unknown'
  if (state === 'ready' && latest === null && batchCount !== 0) state = 'unknown'
  const gapRows = value.paused === 'history_gap' ? countOf(value.gapRows) : null
  return Object.freeze({ state, latest: state === 'unknown' ? null : latest, batchCount, gapRows, rule })
}

/** Parse a dry run's `pullBatch` preview (§1.3). Requires `preview === true`; anything else is `null`. */
export function parseStockPrepPullBatchPreview(value: unknown): StockPrepPullBatchPreview | null {
  if (!isPlainObject(value) || value.preview !== true) return null
  if (value.wouldStamp === true) return Object.freeze({ wouldStamp: true, reason: null, gapRows: null })
  const reason = reasonOf(value.reason)
  return Object.freeze({ wouldStamp: false, reason, gapRows: reason === 'history_gap' ? countOf(value.gapRows) : null })
}

/** Parse an apply's / a large chunk's `pullBatch` answer (§1.4, §1.5). Absent or malformed is `null`. */
export function parseStockPrepPullBatchOutcome(value: unknown): StockPrepPullBatchOutcome | null {
  if (!isPlainObject(value)) return null
  if (value.stamped === true) {
    const label = labelOf(value.label)
    const batchNo = batchNoOf(value.batchNo)
    const createdRowCount = countOf(value.createdRowCount)
    if (label === null || batchNo === null || createdRowCount === null) return null
    return Object.freeze({ kind: 'stamped' as const, label, batchNo, joined: value.joined === true, createdRowCount })
  }
  if (value.stamped !== false) return null
  if (value.reason === 'no_creates') return Object.freeze({ kind: 'no_creates' as const })
  if (value.reason === 'disabled') return Object.freeze({ kind: 'disabled' as const })
  const reason = reasonOf(value.reason)
  return Object.freeze({ kind: 'unstamped' as const, reason, gapRows: reason === 'history_gap' ? countOf(value.gapRows) : null })
}

// ---------------------------------------------------------------------------
// the customer copy (brief §4; every placeholder is a server-given number or the ledger's own label)
// ---------------------------------------------------------------------------

/** §4.1 — the board line, one per state. */
export function stockPrepPullBatchBoardLine(board: StockPrepPullBatchBoard): StockPrepPlainEntry {
  switch (board.state) {
    case 'ready': {
      if (board.latest) {
        // 「共 K 批」 only when it cannot undercount: batch numbers of an unknown-history sheet start above its
        // history count while batchCount counts ledger rows only (critic C-7).
        const k = board.batchCount !== null && board.batchCount === board.latest.batchNo ? board.batchCount : null
        return {
          zh: `最近拉取批次：${board.latest.label}${k !== null ? ` · 共 ${k} 批` : ''}`,
          en: `Latest pull batch: ${board.latest.label}${k !== null ? ` · ${k} in all` : ''}`,
        }
      }
      return {
        zh: '批次标识已启用，还没有拉取批次；下一次有新增物料的拉取会记为一个新批次。',
        en: 'Pull batches are on; no batch yet. The next pull that adds materials becomes a new batch.',
      }
    }
    case 'not_installed':
      return {
        zh: '批次标识：未启用',
        en: 'Pull batches: not enabled',
        zhNext: '这张表还没有安装批次列；如需使用，请联系备料主管理员。',
        enNext: 'This sheet has no batch columns yet; ask the stock-prep admin if you need them.',
      }
    case 'installing':
      return {
        zh: '批次标识安装中，暂停拉取',
        en: 'Pull batches are being installed; pulls are paused',
        zhNext: '安装完成后即可拉取；如果长时间未完成，请联系备料主管理员。',
        enNext: 'Pull once the install finishes; if it takes long, ask the stock-prep admin.',
      }
    case 'gap':
      return {
        zh: board.gapRows !== null
          ? `批次标识暂停：有 ${board.gapRows} 行未登记批次，请联系管理员补登记`
          : '批次标识暂停：有未登记批次的行，请联系管理员补登记',
        en: board.gapRows !== null
          ? `Pull batches paused: ${board.gapRows} rows have no batch recorded; ask the administrator to backfill them`
          : 'Pull batches paused: some rows have no batch recorded; ask the administrator to backfill them',
        zhNext: '补登记之前，拉取照常进行，但新增的行不记批次。',
        enNext: 'Until then pulls run as usual, but new rows get no batch.',
      }
    case 'pending':
      return {
        zh: '批次标识尚未就绪：历史批次还没有登记完成',
        en: 'Pull batches not ready: the batch history is not recorded yet',
        zhNext: '在此之前，拉取照常进行，但新增的行不记批次；请联系备料主管理员完成安装。',
        enNext: 'Until then pulls run as usual, but new rows get no batch; ask the stock-prep admin to finish the install.',
      }
    case 'partial':
      return {
        zh: '批次标识异常：批次列不完整',
        en: 'Pull batches: the batch columns are incomplete',
        zhNext: '拉取暂不记批次；请联系备料主管理员检查。',
        enNext: 'Pulls record no batch for now; ask the stock-prep admin to check.',
      }
    default:
      return {
        zh: '批次标识状态暂时读不到',
        en: 'The pull-batch status cannot be read right now',
        zhNext: '请稍后刷新本页；如果一直如此，请联系管理员。',
        enNext: 'Refresh this page shortly; if it persists, ask the administrator.',
      }
  }
}

/** §5.5 rule A (`material`), verbatim. */
export const STOCK_PREP_PULL_BATCH_MEANING_MATERIAL: StockPrepPlainText = Object.freeze({
  zh: '首次批次：这个物料在本项目第几批拉取时第一次出现；不表示这一行已经备过料。',
  en: '首次批次 (first batch): the pull batch in which this material first appeared in this project; it does not mean this row has been prepared.',
})

/** §5.5 rule F (`predecessor_suffix`), completed in parallel with rule A (planner decision P-3). */
export const STOCK_PREP_PULL_BATCH_MEANING_POSITION: StockPrepPlainText = Object.freeze({
  zh: '首次批次：这一位置的需求在本项目第几批拉取时第一次出现；不表示这一行已经备过料。',
  en: '首次批次 (first batch): the pull batch in which the demand at this position first appeared in this project; it does not mean this row has been prepared.',
})

/** §5.5 — the rule-independent sentence; the ONLY one when the captured rule is absent or unrecognised. */
export const STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL: StockPrepPlainText = Object.freeze({
  zh: '本次拉取：这一行是在第几批拉取时建立的。',
  en: '本次拉取 (this pull): the pull batch that created this row.',
})

/**
 * Ruling C10 — rule F only: history backfill evaluates predecessors over TODAY's 有效 state. The same fact as the
 * plugin's `PULL_BATCH_SETTINGS_HELP.firstPullBatchRule.predecessor_suffix` (PBL-XSIDE pins the shared phrase).
 */
export const STOCK_PREP_PULL_BATCH_MEANING_POSITION_CAVEAT: StockPrepPlainText = Object.freeze({
  zh: '按位置判定时，带「推定」的首次批次是按今天的「有效」状态推算的，可能与当时实时拉取会写入的不同。',
  en: 'Under the by-position rule, a first batch marked inferred was worked out from today’s active rows and can differ from what a live pull would have written at the time.',
})

const MEANING_STATES: readonly StockPrepPullBatchBoardState[] = Object.freeze(['ready', 'gap', 'installing', 'pending'])

/**
 * §4.2 — what 首次批次 / 本次拉取 mean on THIS sheet, following its CAPTURED rule. Empty for the states where the columns
 * are not there (not_installed, partial, unknown); only the 本次拉取 sentence when the rule is absent or unrecognised.
 */
export function stockPrepPullBatchMeaning(rule: StockPrepPullBatchRule | null, state: StockPrepPullBatchBoardState): StockPrepPlainText[] {
  if (!MEANING_STATES.includes(state)) return []
  if (rule === 'material') return [STOCK_PREP_PULL_BATCH_MEANING_MATERIAL, STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL]
  if (rule === 'predecessor_suffix') {
    return [STOCK_PREP_PULL_BATCH_MEANING_POSITION, STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL, STOCK_PREP_PULL_BATCH_MEANING_POSITION_CAVEAT]
  }
  return [STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL]
}

/** §4.3 — the reason fragment inside 「本次未标记批次：…」 / 「这次不记批次：…」. */
export function stockPrepPullBatchReasonFragment(reason: StockPrepPullBatchReason | 'other', gapRows: number | null): StockPrepPlainText {
  switch (reason) {
    case 'columns_unproven':
      return { zh: '暂时无法确认批次列是否存在', en: 'the batch columns could not be confirmed' }
    case 'columns_partial':
      return { zh: '批次列不完整', en: 'the batch columns are incomplete' }
    case 'history_pending':
      return { zh: '历史批次还没有登记完成', en: 'the batch history is not recorded yet' }
    case 'history_gap':
      return gapRows !== null
        ? { zh: `有 ${gapRows} 行未登记批次，需要管理员补登记`, en: `${gapRows} rows have no batch recorded and need a backfill` }
        : { zh: '有未登记批次的行，需要管理员补登记', en: 'some rows have no batch recorded and need a backfill' }
    case 'installing':
      return { zh: '批次列正在安装', en: 'the batch columns are being installed' }
    case 'ledger_unreadable':
      return { zh: '批次记录暂时读不到', en: 'the batch record cannot be read right now' }
    default:
      return { zh: '其他原因', en: 'another reason' }
  }
}

/**
 * §4.3 / §4.5 — how a write was recorded. `null` (no element) for not_installed and disabled (planner decision P-2: the
 * board already says 未启用), and for an absent or malformed answer.
 *
 * THE LARGE LANE NEVER SAYS 「并入」 (critic C-3): from its second chunk on, a large job re-allocates through its own
 * link and the store answers `joined: true`, so a fresh multi-chunk pull ends `joined` without being a retry.
 */
export function stockPrepPullBatchOutcomeLine(
  outcome: StockPrepPullBatchOutcome | null,
  options: { lane?: 'small' | 'large' } = {},
): StockPrepPlainText | null {
  if (!outcome) return null
  if (outcome.kind === 'stamped') {
    if (outcome.joined && options.lane !== 'large') {
      return {
        zh: `本次新增 ${outcome.createdRowCount} 行，并入 ${outcome.label}（同一次拉取的重试）`,
        en: `${outcome.createdRowCount} rows added this time, joined to ${outcome.label} (a retry of the same pull)`,
      }
    }
    return {
      zh: `本次新增 ${outcome.createdRowCount} 行，记为 ${outcome.label}`,
      en: `${outcome.createdRowCount} rows added this time, recorded as ${outcome.label}`,
    }
  }
  if (outcome.kind === 'no_creates') {
    return { zh: '本次没有新增物料，不产生新的拉取批次', en: 'No materials were added this time, so no new pull batch was created' }
  }
  if (outcome.kind === 'disabled' || outcome.reason === 'not_installed') return null
  const fragment = stockPrepPullBatchReasonFragment(outcome.reason, outcome.gapRows)
  return { zh: `本次未标记批次：${fragment.zh}`, en: `No batch was recorded this time: ${fragment.en}` }
}

/**
 * §4.4 — the create path's write prompt, before an apply. `null` when nothing is added, the preview is absent, or the
 * sheet has no band (not_installed / disabled). A reason under which the APPLY refuses (installing; ledger_unreadable,
 * a 503 before any create — critic C-4) says the write will be refused; every other reason says the rows land unbatched.
 */
export function stockPrepPullBatchPreviewLine(preview: StockPrepPullBatchPreview | null, plannedAdd: number): StockPrepPlainText | null {
  if (!preview || !(typeof plannedAdd === 'number' && Number.isSafeInteger(plannedAdd) && plannedAdd > 0)) return null
  const n = plannedAdd
  if (preview.wouldStamp) return { zh: `将新增 ${n} 行（记入新的拉取批次）`, en: `${n} rows will be added (recorded as a new pull batch)` }
  if (preview.reason === null || preview.reason === 'not_installed' || preview.reason === 'disabled') return null
  if (preview.reason === 'installing') {
    return {
      zh: `将新增 ${n} 行；但这张表正在安装批次列，现在写入会被拒绝，请等安装完成。`,
      en: `${n} rows would be added, but this sheet’s batch columns are being installed; a write now is refused, so wait for the install to finish.`,
    }
  }
  if (preview.reason === 'ledger_unreadable') {
    return {
      zh: `将新增 ${n} 行；但批次记录暂时读不到，现在写入会被拒绝，请稍后再试。`,
      en: `${n} rows would be added, but the batch record cannot be read right now; a write now is refused, so try again shortly.`,
    }
  }
  const fragment = stockPrepPullBatchReasonFragment(preview.reason, preview.gapRows)
  return { zh: `将新增 ${n} 行（这次不记批次：${fragment.zh}）`, en: `${n} rows will be added (no batch this time: ${fragment.en})` }
}

/** A write that stopped part-way on a pull-batch code: never a sentence that claims nothing was written (critic C-5). */
export const STOCK_PREP_PULL_BATCH_RUN_STOP_PARTIAL: StockPrepPlainText = Object.freeze({
  zh: '写入中途因批次标识停了下来，可能已写进一部分行（已写入的行不会重复写）。',
  en: 'Writing stopped part-way because of the pull batches; some rows may already have landed (they will not be written twice).',
})

/** The same stop when the server did not say whether a write was attempted. */
export const STOCK_PREP_PULL_BATCH_RUN_STOP_UNCONFIRMED: StockPrepPlainText = Object.freeze({
  zh: '写入因批次标识停了下来，无法确认是否已写进部分行。',
  en: 'Writing stopped because of the pull batches; it is not known whether any rows landed.',
})

/**
 * Step ③'s sentence when the write FAILED on a `STOCK_PREP_PULL_BATCH_*` code (a refusal or a run stop): the code's own
 * plain entry (with its `details.reason`, e.g. `CONFLICT/settings_changed`) in place of WRITE_FAILED's generic
 * 「这一步没有写成,数据没有变化」. With `partial` 1 (a host write was attempted) or unreported, the headline says rows may
 * have landed / it is not known, and only the code's next step is kept — never a sentence claiming nothing was written.
 * `null` for every other step.
 */
export function stockPrepPullBatchStepPlain(result: {
  id: string
  status: string
  reason: string
  detail?: Record<string, string | number> | null
} | null | undefined): StockPrepPlainEntry | null {
  if (!result || result.id !== 'apply' || result.status !== 'fail' || result.reason !== 'WRITE_FAILED') return null
  const detail = result.detail || {}
  const code = typeof detail.code === 'string' ? detail.code : null
  if (!code || !code.startsWith(STOCK_PREP_PULL_BATCH_ERROR_PREFIX)) return null
  const entry = stockPrepErrorPlain(code, typeof detail.reason === 'string' ? detail.reason : null)
  if (detail.partial === 0) return entry
  const headline = detail.partial === 1 ? STOCK_PREP_PULL_BATCH_RUN_STOP_PARTIAL : STOCK_PREP_PULL_BATCH_RUN_STOP_UNCONFIRMED
  return {
    zh: headline.zh,
    en: headline.en,
    ...(entry.zhNext ? { zhNext: entry.zhNext } : {}),
    ...(entry.enNext ? { enNext: entry.enNext } : {}),
  }
}
