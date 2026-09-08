// 项目查询面板 (P2-1 · 设计稿 §6.3 第一行) — the PURE half.
//
// WHAT THIS FILE IS. Every decision the query panel makes that is not "paint a pixel": which rows the
// union produces, which of them survive the two filters and the search box, which of the four empty
// states applies, how the four URL state bits are read back, and what a missing 「最近导出」 is allowed
// to say. The component (StockPreparationProjectQueryView.vue) holds refs, a router and a template —
// nothing else — so each branch below is a unit test rather than something only a mount can reach.
//
// IT REUSES THE HOME PAGE'S UNION RATHER THAN RESTATING IT. `buildStockPrepProjectQueryRows` calls
// `buildOperatorHomeCards` (operatorHomeCards.ts) and then joins the U2 per-row extras onto its
// output. That is deliberate and it is the whole point of the file existing at all: 「目录 ∪ 本机记忆」
// carries a per-FIELD merge rule (a live `pendingDecisionCount` beats a remembered enum; an archive's
// `readyLineCount` never becomes a posture) whose failure mode is a card silently falling back to
// 「还没拉过」 after a 1,240-row pull. A second copy of that merge in this file would drift from the
// home page's the first time either was touched, and the two screens would then disagree about the
// same project while both looked right on their own.
//
// VALUES-FREE, AND THE ONE THING THAT IS NOT. Project numbers and names cross this module — they are
// the query panel's whole subject and they are already the operator tier's to see (see
// `canOpenStockPrepProjectQuery`). The SEARCH TERM is different in kind: it is something a person
// typed. It lives in this module's arguments and in the component's ref, it is compared in memory,
// and it goes nowhere else — no request carries it (the directory read takes no search parameter and
// the board read takes only a project number), nothing here writes storage, and nothing here logs.
// The URL is the single exception the ruling allows, because that is the reader's own address bar.
import type {
  StockPreparationOperatorDirectory,
  StockPreparationOperatorProject,
} from './confirmationQueue'
import {
  buildOperatorHomeCards,
  sortOperatorHomeCards,
  STOCK_PREP_HOME_FILTER_KEYS,
  type StockPrepHomeCardSource,
  type StockPrepHomeFilterKey,
} from './operatorHomeCards'
import type { StockPrepRecentProjectEntry } from './operatorHomeMemory'
import type { StockPrepPosture } from './projectPosture'

/** U2 / N1's per-row `sources` vocabulary, named once so the filter and the row agree by construction. */
export type StockPrepProjectSource = 'mvp' | 'pull_target'

/**
 * 一级筛选「姿态」 — the SAME five keys the home page's chips use, imported rather than re-listed.
 *
 * 设计稿 §6.3 asks for 待确认 / 缺件 / 可导出 / 未拉取 / 全部, which is exactly
 * `STOCK_PREP_HOME_FILTER_KEYS`. Re-declaring them here would be a second closed vocabulary for one
 * fact, and the first time a posture key was renamed the two screens would filter differently while
 * both compiled.
 */
export const STOCK_PREP_PROJECT_QUERY_STATUS_KEYS = STOCK_PREP_HOME_FILTER_KEYS
export type StockPrepProjectQueryStatusKey = StockPrepHomeFilterKey

/**
 * 二级筛选「来源」 — which store answered for this project.
 *
 * `both` is a SUBSET of `mvp` and of `pull_target`, not a fourth disjoint bucket: a row the archive
 * and the pull target both know satisfies 「归档过」 and 「自助拉取过」 and 「两者都有」. Stated here
 * because the alternative reading (mvp = archive-ONLY) is equally defensible and silently produces a
 * different list; whichever one ships has to be written down where the predicate lives.
 */
export const STOCK_PREP_PROJECT_QUERY_SOURCE_KEYS = ['all', 'mvp', 'pull_target', 'both'] as const
export type StockPrepProjectQuerySourceKey = typeof STOCK_PREP_PROJECT_QUERY_SOURCE_KEYS[number]

export interface StockPrepProjectQueryRow {
  projectNo: string
  projectName: string | null
  /** The shared badge — same function, same words, same tone as the home card and the board title. */
  posture: StockPrepPosture
  /** True when the badge came out of this browser's memory rather than out of data read on screen. */
  postureFromMemory: boolean
  /** Live, from the confirmation ledger. `null` for a row only this browser's memory knows about. */
  pendingDecisionCount: number | null
  /** Which half of the union produced the row — `memory` means the directory has never carried it. */
  origin: StockPrepHomeCardSource
  /**
   * U2 / N1's `sources`, or `null` when the backend did not answer at all (no `includePullTargets`
   * opt-in, or a deployment that predates the contract). `null` is NOT an empty array: 「没有来源」 and
   * 「没人告诉我来源」 are different facts, and the second one disables the filter rather than
   * emptying the list.
   */
  sources: readonly StockPrepProjectSource[] | null
  /** U2 / N6. `null` may mean 「从未导出」 or 「窗口外」 — see `stockPrepLastExportDisplay`. */
  lastExportAt: string | null
}

function normaliseSources(value: unknown): readonly StockPrepProjectSource[] | null {
  if (!Array.isArray(value)) return null
  const out: StockPrepProjectSource[] = []
  for (const entry of value) {
    if (entry === 'mvp' || entry === 'pull_target') {
      if (!out.includes(entry)) out.push(entry)
    }
  }
  // An array that carried ONLY unknown members is still an answer — the server said "these stores",
  // and this build does not recognise them. Reporting `[]` (rather than `null`) keeps that honest:
  // the filter stays enabled and the row matches only 「全部」.
  return out
}

/**
 * 目录 ∪ 本机记忆, with U2's per-row extras joined on.
 *
 * The union, the de-duplication and the posture merge are `buildOperatorHomeCards`' — see this file's
 * header for why they are called rather than copied. The join below adds only what the home page has
 * no use for and the query panel does: `sources` and `lastExportAt`, both of which exist only on a
 * DIRECTORY row (a memory entry stores three fields and none of them is either of these — see
 * operatorHomeMemory.ts), so a memory-only row honestly carries `null` for both.
 *
 * Order is `sortOperatorHomeCards`': highest-priority posture first, then project number. Reused for
 * the same reason the union is — two lists of the same projects that disagree about which one is most
 * urgent are worse than either list alone.
 */
export function buildStockPrepProjectQueryRows(
  directory: StockPreparationOperatorDirectory | null,
  memory: readonly StockPrepRecentProjectEntry[],
): StockPrepProjectQueryRow[] {
  const projects: readonly StockPreparationOperatorProject[] = Array.isArray(directory?.projects)
    ? directory!.projects
    : []
  const byProjectNo = new Map<string, StockPreparationOperatorProject>()
  for (const project of projects) {
    const no = typeof project.projectNo === 'string' ? project.projectNo.trim() : ''
    if (!no || byProjectNo.has(no)) continue
    byProjectNo.set(no, project)
  }
  return sortOperatorHomeCards(buildOperatorHomeCards(projects, memory)).map((card) => {
    const row = byProjectNo.get(card.projectNo) ?? null
    return {
      projectNo: card.projectNo,
      projectName: card.projectName,
      posture: card.posture,
      postureFromMemory: card.postureFromMemory,
      pendingDecisionCount: card.pendingDecisionCount,
      origin: card.source,
      sources: row ? normaliseSources(row.sources) : null,
      lastExportAt: row && typeof row.lastExportAt === 'string' ? row.lastExportAt : null,
    }
  })
}

/**
 * May the 来源 filter be offered at all?
 *
 * TRUE only when at least one DIRECTORY row actually carries a `sources` array. An older backend, or
 * a caller that did not opt into `includePullTargets=1`, omits the field entirely — and a filter over
 * a field nobody answered would silently return an empty list for every choice but 「全部」, which
 * reads as 「这一类一个都没有」 rather than 「这套部署没告诉我来源」. So the control is DISABLED and
 * says why (G4: 看不到 ≠ 没有).
 *
 * A directory with no projects at all answers `false` too. That is not a claim about the backend —
 * there is simply nothing to filter, and the list is already showing `no_projects`.
 */
export function stockPrepProjectQuerySourceAvailable(
  directory: StockPreparationOperatorDirectory | null,
): boolean {
  const projects = Array.isArray(directory?.projects) ? directory!.projects : []
  return projects.some((project) => Array.isArray(project.sources))
}

export interface StockPrepProjectQueryFilter {
  status: StockPrepProjectQueryStatusKey
  source: StockPrepProjectQuerySourceKey
  /** The raw search box contents. Trimmed and case-folded here, never by the caller. */
  search: string
}

function matchesStatus(row: StockPrepProjectQueryRow, status: StockPrepProjectQueryStatusKey): boolean {
  if (status === 'all') return true
  return row.posture.key === status
}

function matchesSource(row: StockPrepProjectQueryRow, source: StockPrepProjectQuerySourceKey): boolean {
  if (source === 'all') return true
  // 「看不到来源」 matches 「全部」 and nothing else. Putting an unanswered row into `mvp` (or into
  // `pull_target`) would be this screen inventing the one fact it was not told.
  if (row.sources === null) return false
  if (source === 'both') return row.sources.includes('mvp') && row.sources.includes('pull_target')
  return row.sources.includes(source)
}

function matchesSearch(row: StockPrepProjectQueryRow, needle: string): boolean {
  if (!needle) return true
  if (row.projectNo.toLowerCase().includes(needle)) return true
  const name = row.projectName
  return typeof name === 'string' && name.toLowerCase().includes(needle)
}

/** The three filters, applied in one pass. Pure over its arguments — no ref, no route, no storage. */
export function filterStockPrepProjectQueryRows(
  rows: readonly StockPrepProjectQueryRow[],
  filter: StockPrepProjectQueryFilter,
): StockPrepProjectQueryRow[] {
  const needle = filter.search.trim().toLowerCase()
  return rows.filter((row) => matchesStatus(row, filter.status)
    && matchesSource(row, filter.source)
    && matchesSearch(row, needle))
}

/** How many rows one 姿态 chip would show — the chip's own count, computed from the SAME predicate. */
export function countStockPrepProjectQueryRowsByStatus(
  rows: readonly StockPrepProjectQueryRow[],
  status: StockPrepProjectQueryStatusKey,
): number {
  return rows.reduce((total, row) => (matchesStatus(row, status) ? total + 1 : total), 0)
}

// ---------------------------------------------------------------------------
// THE URL STATE BITS — `?tab=project-query&q=&status=&source=&sel=`
// ---------------------------------------------------------------------------
//
// Read with clamps, written without defaults. Every reader below takes `unknown` because
// `route.query`'s values are `string | string[] | null | undefined` and a repeated parameter
// (`?status=a&status=b`) is a real shape a shared link can carry: the FIRST value wins and an
// unrecognised one falls back to the default rather than erroring — a stale link should land
// somewhere sensible, which is the same posture the shell takes for an unknown `?tab=`.

function firstQueryValue(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : null
}

export function stockPrepProjectQueryStatusFromQuery(raw: unknown): StockPrepProjectQueryStatusKey {
  const value = firstQueryValue(raw)
  return STOCK_PREP_PROJECT_QUERY_STATUS_KEYS.includes(value as StockPrepProjectQueryStatusKey)
    ? value as StockPrepProjectQueryStatusKey
    : 'all'
}

export function stockPrepProjectQuerySourceFromQuery(raw: unknown): StockPrepProjectQuerySourceKey {
  const value = firstQueryValue(raw)
  return STOCK_PREP_PROJECT_QUERY_SOURCE_KEYS.includes(value as StockPrepProjectQuerySourceKey)
    ? value as StockPrepProjectQuerySourceKey
    : 'all'
}

/** The search box's restored contents. Length-bounded so a hand-built URL cannot paste an essay in. */
export function stockPrepProjectQuerySearchFromQuery(raw: unknown): string {
  const value = firstQueryValue(raw)
  return typeof value === 'string' ? value.slice(0, 120) : ''
}

/** The selected project number. Same bound and the same trim the board's own `?projectNo=` uses. */
export function stockPrepProjectQuerySelectionFromQuery(raw: unknown): string {
  const value = firstQueryValue(raw)
  return typeof value === 'string' ? value.trim().slice(0, 120) : ''
}

export interface StockPrepProjectQueryUrlState {
  status: StockPrepProjectQueryStatusKey
  source: StockPrepProjectQuerySourceKey
  search: string
  selection: string
}

/**
 * The four keys this panel owns, as they should appear in the query — DEFAULTS OMITTED.
 *
 * A URL that spells out `status=all&source=all&q=&sel=` is not a nicer version of a clean one: it is
 * a longer link that says nothing, and it makes every 「回到默认」 leave litter behind in the address
 * bar and in whatever chat window someone pastes it into. Returning `undefined` for a default lets
 * the caller delete the key with one spread rather than branching per key.
 */
export function stockPrepProjectQueryUrlState(
  state: StockPrepProjectQueryUrlState,
): Record<'q' | 'status' | 'source' | 'sel', string | undefined> {
  const search = state.search.trim()
  return {
    q: search.length > 0 ? search : undefined,
    status: state.status === 'all' ? undefined : state.status,
    source: state.source === 'all' ? undefined : state.source,
    sel: state.selection.length > 0 ? state.selection : undefined,
  }
}

// ---------------------------------------------------------------------------
// THE EMPTY STATES (G2 — 每个都有独立 `data-empty-state`,互不共享文案)
// ---------------------------------------------------------------------------

/** The LIST's three states. The detail pane's `no_selection` is its own, one pane over. */
export type StockPrepProjectQueryEmptyState = 'directory_unavailable' | 'no_projects' | 'filter_empty'

/**
 * WHICH list empty state, if any — the same decision order `resolveOperatorHomeEmptyState` uses, for
 * the same reasons, with `filter_empty` where the home page has `nothing_today`:
 *
 *   0. NOT SETTLED YET — nothing at all. While the first directory read is in flight this panel has
 *      not checked anything, and 「这里还没有您的项目」 is a positive claim about the world (G4).
 *   1. directory_unavailable — the read failed. 「读不到」 is not 「没有」, and this is a PREDREAD, so
 *      it degrades to an empty state rather than a red banner (G3).
 *   2. no_projects — the union is empty: neither the directory nor this browser knows a project.
 *   3. filter_empty — there ARE rows, and the current filter/search combination selects none of them.
 *      Its own value and its own words, never a generic 「暂无数据」: the reader needs to know the
 *      list is filtered, not that the system is empty.
 */
export function resolveStockPrepProjectQueryEmptyState(input: {
  directorySettled: boolean
  directoryAvailable: boolean
  rowCount: number
  visibleRowCount: number
}): StockPrepProjectQueryEmptyState | null {
  if (!input.directorySettled) return null
  if (!input.directoryAvailable) return 'directory_unavailable'
  if (input.rowCount === 0) return 'no_projects'
  if (input.visibleRowCount === 0) return 'filter_empty'
  return null
}

// ---------------------------------------------------------------------------
// 最近导出 — 「—」 vs 「从未」
// ---------------------------------------------------------------------------

export type StockPrepLastExportDisplay = 'timestamp' | 'never' | 'unknown'

/**
 * WHAT AN ABSENT `lastExportAt` IS ALLOWED TO SAY.
 *
 * U2 / N6 reads the export stamps out of a BOUNDED window of the values-free audit trail, and
 * `lastExportAtMayBeIncomplete` is the directory's own statement about whether that window could be
 * trusted to be exhaustive. So a `null` on a row means one of two very different things:
 *
 *   * `lastExportAtMayBeIncomplete === false` — the window was read in full and this project is not
 *     in it. 「从未导出过」 is then a fact, and saying it is useful.
 *   * anything else (`true`, or the field absent because nobody opted in / this backend predates the
 *     contract) — the row may have been exported before the window, or the window may not have been
 *     readable at all. The only honest rendering is 「—」. Saying 「从未导出过」 here is how somebody
 *     re-exports a file that already went out, or reports that nobody ever received one.
 *
 * `undefined` is therefore NOT coerced to `false`. That coercion is the exact silent-degrade this
 * whole U2 contract was written to prevent.
 */
export function stockPrepLastExportDisplay(
  lastExportAt: string | null,
  lastExportAtMayBeIncomplete: boolean | undefined,
): StockPrepLastExportDisplay {
  if (typeof lastExportAt === 'string' && lastExportAt.length > 0) return 'timestamp'
  return lastExportAtMayBeIncomplete === false ? 'never' : 'unknown'
}
