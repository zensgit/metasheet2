// 首页本机记忆 (P0-2, D1=A / D8) — the local half of "目录 + 本机记忆两路并集".
//
// WHY THIS EXISTS. F1 (设计稿 §0.2): the operator directory reads the MVP project table, which is
// written by mvp-persist — a platform-admin surface. A project a one-line operator pulled themselves
// through the operator-scoped `/operator/projects` directory therefore NEVER lands in that directory
// if it has never been archived. Left alone, the task-oriented home page would be systematically blind
// to the exact projects it exists to serve. D1's ruling is "ship P0 on the union of the directory and
// this browser's own memory of what it opened" rather than wait on a backend change (N1).
//
// WHAT IS STORED, AND WHAT IS NOT (R9 / D8 / the values-free guardrail). Only THREE fields per project,
// per §9 X12's explicit rejection of storing missing-component detail: the project number (needed to
// find the row again — the same string already sitting in the URL's own `?projectNo=`, not a new
// disclosure), an ISO timestamp, and ONE closed enum key from `StockPrepPostureKey`
// (projectPosture.ts) — never a row count, a part number, or anything a person typed. The badge text a
// remembered entry renders is looked up FROM the key at render time (see `StockPreparationOperatorHome
// .vue`), never stored pre-rendered, so a wording change to `projectPosture.ts` cannot leave a stale
// sentence sitting in a browser's localStorage.
//
// PER-BROWSER, NEVER SHARED. This is `window.localStorage` — private to this browser profile, gone in
// a private window, absent on a different machine. The home card for a memory-only project therefore
// always carries the "这台电脑上最近开过的" caption; nothing here is presented as anything else.
//
// FAILS SILENT. Every read and write is wrapped: a private-browsing profile, a full quota, or a
// disabled storage API must degrade to "no memory", never throw into the page that called this.
import type { StockPrepPostureKey } from './projectPosture'

const STORAGE_KEY = 'metasheet.stockPrep.operatorHomeMemory.v1'
/** Bounded so a browser that opens hundreds of projects over months does not grow this without limit. */
const MAX_ENTRIES = 30

export interface StockPrepRecentProjectEntry {
  projectNo: string
  /** ISO 8601. When this browser last had a live read of this project's posture. */
  updatedAt: string
  /** A closed `StockPrepPostureKey` — see the module comment for why nothing richer is stored. */
  postureKey: StockPrepPostureKey
}

function readRawStorage(): unknown {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const POSTURE_KEYS: ReadonlySet<string> = new Set<StockPrepPostureKey>([
  'pending_decision',
  'blocked',
  'running',
  'ready',
  'not_pulled',
  'not_yours',
])

function isValidEntry(value: unknown): value is StockPrepRecentProjectEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.projectNo === 'string' && candidate.projectNo.length > 0
    && typeof candidate.updatedAt === 'string'
    && typeof candidate.postureKey === 'string' && POSTURE_KEYS.has(candidate.postureKey)
}

/**
 * Every remembered project this browser knows about, newest first. Malformed/partial storage (a
 * future format change, a hand-edited value, storage shared with an older build) degrades to an empty
 * list rather than throwing — the same "predread failures are silent" rule (G3) the rest of the home
 * page follows.
 */
export function readStockPrepRecentProjects(): StockPrepRecentProjectEntry[] {
  const raw = readRawStorage()
  if (!Array.isArray(raw)) return []
  return raw.filter(isValidEntry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Record (or refresh) this browser's memory of ONE project's posture. Called whenever the workspace
 * has a fresh, live posture for the project it is currently showing (see StockPreparationProjectBoard
 * View.vue) — never speculatively, and never with anything beyond the closed enum key.
 */
export function recordStockPrepProjectVisit(projectNo: string, postureKey: StockPrepPostureKey): void {
  const trimmed = projectNo.trim()
  if (!trimmed) return
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const existing = readStockPrepRecentProjects().filter((entry) => entry.projectNo !== trimmed)
    const next: StockPrepRecentProjectEntry[] = [
      { projectNo: trimmed, updatedAt: new Date().toISOString(), postureKey },
      ...existing,
    ].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Quota exceeded, storage disabled, private browsing — the memory is a convenience, not a
    // record; losing a write here must never surface as a page error.
  }
}
