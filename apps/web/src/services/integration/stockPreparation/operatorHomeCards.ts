// 首页卡片分类 (P0-2) — turning "目录 ∪ 本机记忆" (D1=A) into the cards + filter chips the home page
// renders, and deciding which of the three home empty states (§4.3) applies. Pure, so every branch is
// a unit test rather than something only visible by mounting the component.
import type { StockPreparationOperatorProject } from './confirmationQueue'
import { stockPrepPosture, type StockPrepPosture, type StockPrepPostureKey } from './projectPosture'
import type { StockPrepRecentProjectEntry } from './operatorHomeMemory'

export type StockPrepHomeCardSource = 'directory' | 'memory'

export interface StockPrepHomeCard {
  projectNo: string
  projectName: string | null
  source: StockPrepHomeCardSource
  posture: StockPrepPosture
  /** Only ever real for a `directory` card — F1 means no per-card live read backs a `memory` one. */
  pendingDecisionCount: number | null
}

/**
 * The four home filter chips. THIS SET IS A DELIBERATE, DOCUMENTED CHOICE, not the wireframe's own
 * five (全部/等您拿主意/卡住了/可以导出/还没拉过): dropping 全部 (a chip is not needed to show
 * everything — no chip pressed already does that) leaves exactly the four states this module can
 * classify HONESTLY from data actually in hand. See the PR description's "采用的假设" for the record.
 */
export const STOCK_PREP_HOME_FILTER_KEYS = ['pending_decision', 'blocked', 'ready', 'not_pulled'] as const
export type StockPrepHomeFilterKey = typeof STOCK_PREP_HOME_FILTER_KEYS[number]

/**
 * A REMEMBERED posture, rendered without a count this browser does not actually have (R9/D8: memory
 * stores the enum key alone). The three fixed-wording keys (ready/not_pulled/not_yours/running) call
 * straight into `stockPrepPosture` so the word is byte-identical to the live version; the two
 * count-bearing keys (pending_decision/blocked) keep the same key/tone but drop the "N 件/种" clause —
 * inventing a number here would be worse than omitting it.
 */
function memoryPosture(key: StockPrepPostureKey): StockPrepPosture {
  if (key === 'pending_decision') {
    return { key, zh: '等您拿主意', en: 'Waiting on your decision', tone: 'warning' }
  }
  if (key === 'blocked') {
    return { key, zh: '卡住了:缺件', en: 'Blocked: missing part(s)', tone: 'danger' }
  }
  if (key === 'running') return stockPrepPosture({ busy: true })
  if (key === 'not_yours') return stockPrepPosture({ notYours: true })
  if (key === 'ready') return stockPrepPosture({ pulledRowCount: 1 })
  return stockPrepPosture({})
}

/**
 * Directory ∪ local memory. A directory row wins over a memory entry for the SAME project number
 * (live data beats a remembered guess); a memory-only entry — the F1 case, an operator's own unarchived
 * pull — still gets a card.
 */
export function buildOperatorHomeCards(
  directoryProjects: readonly StockPreparationOperatorProject[],
  memory: readonly StockPrepRecentProjectEntry[],
): StockPrepHomeCard[] {
  const seen = new Set<string>()
  const cards: StockPrepHomeCard[] = []

  for (const project of directoryProjects) {
    const no = typeof project.projectNo === 'string' ? project.projectNo.trim() : ''
    if (!no || seen.has(no)) continue
    seen.add(no)
    cards.push({
      projectNo: no,
      projectName: project.projectName,
      source: 'directory',
      // `readyLineCount`/`heldLineCount` are the ONE pulled-or-not signal a directory row carries
      // (F1: they come from the administrator's archive, but a positive value there is real evidence
      // rows exist — never fabricated). `missingComponentsCount` is left at 0: the directory has no
      // signal for it at all, so `blocked` is honestly never reached from this branch alone.
      posture: stockPrepPosture({
        pendingDecisionCount: project.pendingDecisionCount,
        pulledRowCount: project.readyLineCount + project.heldLineCount,
      }),
      pendingDecisionCount: project.pendingDecisionCount,
    })
  }

  for (const entry of memory) {
    if (seen.has(entry.projectNo)) continue
    seen.add(entry.projectNo)
    cards.push({
      projectNo: entry.projectNo,
      projectName: null,
      source: 'memory',
      posture: memoryPosture(entry.postureKey),
      pendingDecisionCount: null,
    })
  }

  return cards
}

/** Highest-priority-first: pending_decision, then blocked, then ready, then everything else. */
const CARD_RANK: Record<StockPrepPostureKey, number> = {
  pending_decision: 0,
  blocked: 1,
  running: 2,
  ready: 3,
  not_pulled: 4,
  not_yours: 5,
}

export function sortOperatorHomeCards(cards: readonly StockPrepHomeCard[]): StockPrepHomeCard[] {
  return [...cards].sort((a, b) => {
    const rank = CARD_RANK[a.posture.key] - CARD_RANK[b.posture.key]
    if (rank !== 0) return rank
    return a.projectNo.localeCompare(b.projectNo)
  })
}

export function countOperatorHomeCardsByFilter(
  cards: readonly StockPrepHomeCard[],
  filter: StockPrepHomeFilterKey,
): number {
  return cards.filter((card) => card.posture.key === filter).length
}

export type StockPrepHomeEmptyState = 'no_projects' | 'nothing_today' | 'directory_unavailable'

/**
 * WHICH empty state, if any — decided here rather than inline so the three states in §4.3 stay
 * mutually exclusive and the copy cannot drift from the condition it belongs to (same discipline as
 * `stockPrepDirectoryEmptyState` in plainLanguage.ts).
 *
 *   0. directory_unavailable — the directory read genuinely failed (G3: silently, no red banner —
 *      this IS the silent degradation). Checked first: with no directory in hand nothing below can be
 *      claimed either way, memory-only cards notwithstanding.
 *   1. no_projects — nothing known at all, from either source.
 *   2. nothing_today — there are cards, but none of them are waiting on the operator.
 *
 * Returns null when the card grid should render with no banner above it.
 */
export function resolveOperatorHomeEmptyState(input: {
  directoryAvailable: boolean
  cardCount: number
  actionableCount: number
}): StockPrepHomeEmptyState | null {
  if (!input.directoryAvailable) return 'directory_unavailable'
  if (input.cardCount === 0) return 'no_projects'
  if (input.actionableCount === 0) return 'nothing_today'
  return null
}
