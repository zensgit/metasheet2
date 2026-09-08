// 首页卡片分类 (P0-2) — turning "目录 ∪ 本机记忆" (D1=A) into the cards + filter chips the home page
// renders, and deciding which of the home empty states (§4.3) applies. Pure, so every branch is
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
  /**
   * TRUE when the badge above came out of this browser's own memory rather than out of live data on
   * this screen. Drives both the 「这台电脑上最近开过的」 caption AND the guidance line's refusal to
   * count such a card as "waiting on you today" — a remembered conclusion can be minutes or weeks
   * old, and may have been resolved by a colleague on another machine.
   */
  postureFromMemory: boolean
  /** Only ever real for a `directory` card — F1 means no per-card live read backs a `memory` one. */
  pendingDecisionCount: number | null
}

/**
 * The five home filter chips, matching §3 wireframe A ④ (全部 / 等您拿主意 / 卡住了 / 可以导出 /
 * 还没拉过). `all` is a real chip rather than "press nothing": with `unknown` cards in the grid the
 * other four no longer sum to the card count, so a person who pressed one needs a labelled way back
 * that also tells them how many there are in total.
 */
export const STOCK_PREP_HOME_FILTER_KEYS = ['all', 'pending_decision', 'blocked', 'ready', 'not_pulled'] as const
export type StockPrepHomeFilterKey = typeof STOCK_PREP_HOME_FILTER_KEYS[number]

/**
 * A REMEMBERED posture, rendered without a count this browser does not actually have (R9/D8: memory
 * stores the enum key alone). The fixed-wording keys call straight into `stockPrepPosture` so the
 * word is byte-identical to the live version; the two count-bearing keys (pending_decision/blocked)
 * keep the same key/tone but drop the "N 件/种" clause — inventing a number here would be worse than
 * omitting it. `running` can never be stored (see operatorHomeMemory.ts) but is handled anyway so a
 * value hand-written into storage cannot reach an undefined branch.
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
  if (key === 'unknown') return stockPrepPosture({ progressUnknown: true })
  return stockPrepPosture({})
}

/**
 * Directory ∪ local memory — and, for a project BOTH sources know, a per-field merge rather than a
 * winner.
 *
 * WHY NOT "DIRECTORY WINS". A directory row carries `pendingDecisionCount` (queried live against the
 * confirmation ledger by project number — trustworthy) alongside `readyLineCount`/`heldLineCount`,
 * which come from the platform-admin ARCHIVE (F1) and say nothing whatsoever about the live pull
 * target. Letting the row as a whole win would replace this browser's own live-board conclusion —
 * written by the workspace's `watch(posture)` off a real board read — with an archive guess, so an
 * operator who pulls 1,240 rows and returns to the home page would watch their card fall back to
 * 「还没拉过」. So:
 *
 *   pendingDecisionCount  → always the directory's (live ledger beats a remembered enum)
 *   everything else       → this browser's remembered conclusion when it has one, otherwise
 *                           `unknown` (§4.4's `? 看不到`), NEVER an archive-derived ready/not_pulled.
 */
export function buildOperatorHomeCards(
  directoryProjects: readonly StockPreparationOperatorProject[],
  memory: readonly StockPrepRecentProjectEntry[],
): StockPrepHomeCard[] {
  const remembered = new Map<string, StockPrepPostureKey>()
  for (const entry of memory) {
    if (!remembered.has(entry.projectNo)) remembered.set(entry.projectNo, entry.postureKey)
  }

  const seen = new Set<string>()
  const cards: StockPrepHomeCard[] = []

  for (const project of directoryProjects) {
    const no = typeof project.projectNo === 'string' ? project.projectNo.trim() : ''
    if (!no || seen.has(no)) continue
    seen.add(no)
    const pending = project.pendingDecisionCount
    const memoryKey = remembered.get(no) ?? null
    const live = pending > 0
    cards.push({
      projectNo: no,
      projectName: project.projectName,
      source: 'directory',
      posture: live
        ? stockPrepPosture({ pendingDecisionCount: pending })
        : (memoryKey ? memoryPosture(memoryKey) : stockPrepPosture({ progressUnknown: true })),
      postureFromMemory: !live && memoryKey !== null,
      pendingDecisionCount: pending,
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
      postureFromMemory: true,
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
  unknown: 4,
  not_pulled: 5,
  not_yours: 6,
}

export function sortOperatorHomeCards(cards: readonly StockPrepHomeCard[]): StockPrepHomeCard[] {
  return [...cards].sort((a, b) => {
    const rank = CARD_RANK[a.posture.key] - CARD_RANK[b.posture.key]
    if (rank !== 0) return rank
    return a.projectNo.localeCompare(b.projectNo)
  })
}

export function filterOperatorHomeCards(
  cards: readonly StockPrepHomeCard[],
  filter: StockPrepHomeFilterKey,
): StockPrepHomeCard[] {
  if (filter === 'all') return [...cards]
  return cards.filter((card) => card.posture.key === filter)
}

export function countOperatorHomeCardsByFilter(
  cards: readonly StockPrepHomeCard[],
  filter: StockPrepHomeFilterKey,
): number {
  return filterOperatorHomeCards(cards, filter).length
}

/**
 * How many cards are waiting on this operator.
 *
 * `live` counts ONLY cards whose posture came from data read on this screen — that is the number the
 * guidance line is allowed to put behind 「今天有 N 个项目在等您」, an assertion about right now.
 * `any` additionally counts remembered ones, and is what decides whether 「今天没有等您的事」 may be
 * said at all: claiming nothing is waiting while a card on the same screen wears a 等您拿主意 badge
 * would be the page contradicting itself.
 */
export function countActionableOperatorHomeCards(cards: readonly StockPrepHomeCard[]): { live: number; any: number } {
  let live = 0
  let any = 0
  for (const card of cards) {
    if (card.posture.key !== 'pending_decision' && card.posture.key !== 'blocked') continue
    any += 1
    if (!card.postureFromMemory) live += 1
  }
  return { live, any }
}

export type StockPrepHomeEmptyState = 'no_projects' | 'nothing_today' | 'directory_unavailable'

/**
 * WHICH empty state, if any — decided here rather than inline so the states in §4.3 stay mutually
 * exclusive and the copy cannot drift from the condition it belongs to (same discipline as
 * `stockPrepDirectoryEmptyState` in plainLanguage.ts).
 *
 *   0. NOT SETTLED YET — no empty state at all. G4: while the first directory read is still in
 *      flight the page knows nothing, and 「这里还没有您的项目」 is a positive claim about the world.
 *      An earlier revision returned `no_projects` here to dodge a one-tick flash of
 *      `directory_unavailable`, which traded an honest third state for a confident wrong one.
 *   1. directory_unavailable — the directory read genuinely failed (G3: silently, no red banner —
 *      this IS the silent degradation). Checked first among the settled cases: with no directory in
 *      hand nothing below can be claimed either way, memory-only cards notwithstanding.
 *   2. no_projects — nothing known at all, from either source.
 *   3. nothing_today — there are cards, but none of them are waiting on the operator.
 *
 * Returns null when the card grid should render with no banner above it.
 */
export function resolveOperatorHomeEmptyState(input: {
  directorySettled: boolean
  directoryAvailable: boolean
  cardCount: number
  actionableCount: number
}): StockPrepHomeEmptyState | null {
  if (!input.directorySettled) return null
  if (!input.directoryAvailable) return 'directory_unavailable'
  if (input.cardCount === 0) return 'no_projects'
  if (input.actionableCount === 0) return 'nothing_today'
  return null
}
