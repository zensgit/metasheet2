// BOM备料 错误码对照抽屉 — the pure, side-effect-free reversal that backs
// `StockPreparationCodeHelpPanel.vue` (P1-6, I-22).
//
// WHAT THIS IS. `plainLanguage.ts` is a FORWARD lookup: a view holds a server-returned code and asks
// "what does this mean" one code at a time. This module builds the REVERSE — every code any of the
// chosen tables can answer for, listed and searchable, so an implementer who is staring at a raw
// code from a support thread (rather than a rendering that already looked it up) has a place to type
// it in.
//
// WHICH TABLES, AND ON WHAT BASIS. The design doc names six (design-ops-overview §4.6); this module
// carries those six plus `STOCK_PREP_SYNC_REASON_PLAIN`, and the selection rule is deliberately a
// CHECKABLE one rather than a claim about what codes "can" be looked up:
//
//     a table belongs here if some view renders its key as bare text a reader can copy.
//
// That rule is what a future editor should re-run, and it is why the seventh table is here. An
// earlier draft justified the six as "the rest are enums a view already renders in words, so they
// never appear as a bare code" — which is false in both directions, and the check above catches both:
//   · STOCK_PREP_SYNC_REASON_PLAIN was excluded, yet StockPreparationProjectSyncPanel.vue:284 renders
//     `<code>{{ row.result.reason }}</code>` verbatim in its technical details, and :576 falls back to
//     printing the raw reason when the table has no entry. Design §4.5 names one of its codes
//     (RECONCILE_NOT_PERMITTED) directly. It is now included.
//   · STOCK_PREP_ADMIN_ACTION_PLAIN's three ids are front-end-authored and never rendered as a code
//     at all (StockPreparationWorkspace.vue:174-175 renders only the sentence). By the rule above they
//     do not qualify — they are KEPT anyway, because §4.6 names the table and three extra rows cost a
//     reader nothing, but they are the exception, not the precedent.
// Tables still excluded are the enum vocabularies a control renders in words beside itself (decision
// status, match method, rounding mode — e.g. STOCK_PREP_DECISION_STATUS_PLAIN), and
// STOCK_PREP_SOURCE_CHECK_PLAIN, which §4.6 leaves out. Adding or dropping a table changes what an
// implementer can search, so it belongs in review — hence the explicit list below rather than "every
// Record<string, StockPrepPlain*> this file exports".
//
// ANTI-DROP CONTRACT (the "渲染条目数 = 词表 key 数之和" test in
// StockPreparationCodeHelp.spec.ts): `stockPrepCodeHelpEntries()` returns exactly one row per key
// across the tables below, computed by iterating `Object.keys` — nothing here filters, dedupes or
// skips a key for any reason. A future edit that silently drops rows (a bad filter, an off-by-one in a
// slice, a table forgotten after a rename) fails that count, independent of any table's own key count
// changing over time.
//
// VALUES-FREE BY CONSTRUCTION. Every field on `StockPrepCodeHelpEntry` is copied from a
// `plainLanguage.ts` constant — authored, committed prose — or is the code/id key itself, also
// authored. This module reads no prop, no response, no store: it cannot introduce a customer value
// even by mistake, because it has no input.
import {
  STOCK_PREP_ADMIN_ACTION_PLAIN,
  STOCK_PREP_BLOCKER_PLAIN,
  STOCK_PREP_BOARD_ERROR_PLAIN,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_SOURCE_BLOCKER_PLAIN,
  STOCK_PREP_SOURCE_WARNING_PLAIN,
  STOCK_PREP_SYNC_REASON_PLAIN,
  type StockPrepPlainEntry,
} from './plainLanguage'

export interface StockPrepCodeHelpEntry {
  /** The code/id a server response, a preflight blocker or an admin-action route actually carries. */
  code: string
  /** Which source table this row came from — a stable id, never shown untranslated. */
  group: string
  groupZh: string
  groupEn: string
  /** 发生了什么 — always present, every source table's first line. */
  zh: string
  en: string
  /** 该怎么办 — present only where the source table carries one (StockPrepPlainEntry's own contract). */
  zhNext?: string
  enNext?: string
}

interface StockPrepCodeHelpSource {
  id: string
  groupZh: string
  groupEn: string
  table: Record<string, StockPrepPlainEntry>
}

/**
 * THE SOURCE TABLES, in the fixed order they render — grouped by which SURFACE a reader met the code on,
 * not alphabetically, so the drawer's default (unsearched) order groups related codes together.
 * `STOCK_PREP_ADMIN_ACTION_PLAIN` is `Record<string, StockPrepPlainText>` (no `zhNext`/`enNext` — those
 * three rows are outcome sentences, not fixes) and is structurally assignable here unchanged: every
 * field `StockPrepPlainEntry` adds beyond `StockPrepPlainText` is optional.
 */
const STOCK_PREP_CODE_HELP_SOURCES: readonly StockPrepCodeHelpSource[] = Object.freeze([
  { id: 'error', groupZh: '通用报错', groupEn: 'General errors', table: STOCK_PREP_ERROR_PLAIN },
  { id: 'board-error', groupZh: '项目备料页报错', groupEn: 'Project board errors', table: STOCK_PREP_BOARD_ERROR_PLAIN },
  { id: 'blocker', groupZh: '建表 / 装列阻断', groupEn: 'Install blockers', table: STOCK_PREP_BLOCKER_PLAIN },
  { id: 'source-blocker', groupZh: '源预检阻断', groupEn: 'Source-readiness blockers', table: STOCK_PREP_SOURCE_BLOCKER_PLAIN },
  { id: 'source-warning', groupZh: '源预检提醒', groupEn: 'Source-readiness warnings', table: STOCK_PREP_SOURCE_WARNING_PLAIN },
  { id: 'sync-reason', groupZh: '拉取 / 试算结果原因', groupEn: 'Pull & plan outcome reasons', table: STOCK_PREP_SYNC_REASON_PLAIN },
  { id: 'admin-action', groupZh: '管理员动作结果', groupEn: 'Admin action outcomes', table: STOCK_PREP_ADMIN_ACTION_PLAIN },
])

/**
 * Every row the drawer can ever show, in deterministic order (source-table order, then the code
 * alphabetically within it) — one call, nothing filtered. `stockPrepCodeHelpSearch` narrows this list;
 * this function never does.
 */
export function stockPrepCodeHelpEntries(): StockPrepCodeHelpEntry[] {
  const rows: StockPrepCodeHelpEntry[] = []
  for (const source of STOCK_PREP_CODE_HELP_SOURCES) {
    const codes = Object.keys(source.table).sort((a, b) => a.localeCompare(b))
    for (const code of codes) {
      const entry = source.table[code]
      rows.push({
        code,
        group: source.id,
        groupZh: source.groupZh,
        groupEn: source.groupEn,
        zh: entry.zh,
        en: entry.en,
        zhNext: entry.zhNext,
        enNext: entry.enNext,
      })
    }
  }
  return rows
}

/**
 * 「可搜索(按 code 与文案子串)」— case-insensitive substring match against the code AND every prose
 * field (zh/en/zhNext/enNext), so a reader who only remembers a phrase from the sentence (not the
 * code) still finds the row. An empty/whitespace-only query returns every entry unfiltered — the
 * drawer's default state is the full list, not an empty one waiting for input.
 */
export function stockPrepCodeHelpSearch(entries: readonly StockPrepCodeHelpEntry[], query: string): StockPrepCodeHelpEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return entries.slice()
  return entries.filter((entry) => (
    entry.code.toLowerCase().includes(needle)
    || entry.zh.toLowerCase().includes(needle)
    || entry.en.toLowerCase().includes(needle)
    || (entry.zhNext ?? '').toLowerCase().includes(needle)
    || (entry.enNext ?? '').toLowerCase().includes(needle)
  ))
}
