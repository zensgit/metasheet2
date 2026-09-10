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
// PER-PRINCIPAL, NOT MERELY PER-BROWSER. The project number is VALUE-BEARING on this deployment —
// `workbenchAccess.ts` puts `confirmationQueue.projectDirectory` on the OPERATE tier for exactly that
// reason — and stock preparation's deployment shape is a SHARED shop-floor workstation on a
// multi-tenant platform. A single global key would therefore hand tenant T1's operator's project
// numbers to tenant T2's operator on the next sign-in, captioned as their own recent history. So the
// key carries the tenant AND the signed-in principal, the same discipline `recentTemplates.ts`
// (storageKey(userId)) and `useAttendanceAdminRail.ts` (resolveAdminNavStorageKey(KEY, scope)) already
// follow, and `onAuthPrincipalChange` wipes every one of them when the session changes — belt AND
// braces, because a principal swap performed by ANOTHER TAB fires no notification here (see
// authPrincipal.ts's own note), and keying is what covers that case.
//
// FAILS SILENT. Every read and write is wrapped: a private-browsing profile, a full quota, or a
// disabled storage API must degrade to "no memory", never throw into the page that called this.
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../../../composables/authPrincipal'
import type { StockPrepPostureKey } from './projectPosture'

/**
 * `v2` because v1 was a single global key with no principal in it; a browser upgrading past this
 * build must not adopt whatever that key holds as the current operator's history. Nothing reads v1
 * any more, and `clearStockPrepOperatorHomeMemory` deletes it on the next auth transition.
 */
const STORAGE_KEY_PREFIX = 'metasheet.stockPrep.operatorHomeMemory.v2'
const LEGACY_UNSCOPED_KEY = 'metasheet.stockPrep.operatorHomeMemory.v1'
/** Bounded so a browser that opens hundreds of projects over months does not grow this without limit. */
const MAX_ENTRIES = 30

/** The tenant half of the storage scope. Same shape as `IntegrationScope`, structurally. */
export interface StockPrepMemoryScope {
  tenantId?: string | null
}

export interface StockPrepRecentProjectEntry {
  projectNo: string
  /** ISO 8601. When this browser last had a live read of this project's posture. */
  updatedAt: string
  /** A closed `StockPrepPostureKey` — see the module comment for why nothing richer is stored. */
  postureKey: StockPrepPostureKey
}

/**
 * `<prefix>:<tenant>:<principal>`. Both halves fall back to an explicit literal rather than being
 * omitted, so "signed out" and "no tenant" are their OWN buckets and can never collide with a real
 * one by string concatenation.
 */
function resolveStorageKey(scope?: StockPrepMemoryScope): string {
  const tenant = (scope?.tenantId ?? '').trim() || 'no-tenant'
  const principal = getAuthPrincipalKey() ?? 'anonymous'
  return `${STORAGE_KEY_PREFIX}:${tenant}:${principal}`
}

function readRawStorage(scope?: StockPrepMemoryScope): unknown {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(resolveStorageKey(scope))
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
  'unknown',
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
 * Every remembered project this browser knows about FOR THIS PRINCIPAL, newest first.
 * Malformed/partial storage (a future format change, a hand-edited value, storage shared with an
 * older build) degrades to an empty list rather than throwing — the same "predread failures are
 * silent" rule (G3) the rest of the home page follows.
 */
export function readStockPrepRecentProjects(scope?: StockPrepMemoryScope): StockPrepRecentProjectEntry[] {
  const raw = readRawStorage(scope)
  if (!Array.isArray(raw)) return []
  return raw.filter(isValidEntry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Record (or refresh) this browser's memory of ONE project's posture. Called whenever the workspace
 * has a fresh, live posture for the project it is currently showing (see StockPreparationProjectBoard
 * View.vue) — never speculatively, and never with anything beyond the closed enum key.
 *
 * `running` IS DELIBERATELY NOT PERSISTED. It is a transient about a request in flight, not a fact
 * about the project: a tab closed mid-sync would otherwise leave a card claiming 「正在跑」 forever,
 * for a run that ended (or died) minutes ago. Returning early leaves the PREVIOUS conclusion in
 * place, which is the last thing this browser actually knew.
 */
export function recordStockPrepProjectVisit(
  projectNo: string,
  postureKey: StockPrepPostureKey,
  scope?: StockPrepMemoryScope,
): void {
  const trimmed = projectNo.trim()
  if (!trimmed) return
  if (postureKey === 'running') return
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const existing = readStockPrepRecentProjects(scope).filter((entry) => entry.projectNo !== trimmed)
    const next: StockPrepRecentProjectEntry[] = [
      { projectNo: trimmed, updatedAt: new Date().toISOString(), postureKey },
      ...existing,
    ].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(resolveStorageKey(scope), JSON.stringify(next))
  } catch {
    // Quota exceeded, storage disabled, private browsing — the memory is a convenience, not a
    // record; losing a write here must never surface as a page error.
  }
}

/** The remembered posture for ONE project, or null. Read BEFORE the current mount overwrites it. */
export function readStockPrepRememberedPosture(
  projectNo: string,
  scope?: StockPrepMemoryScope,
): StockPrepPostureKey | null {
  const trimmed = projectNo.trim()
  if (!trimmed) return null
  const found = readStockPrepRecentProjects(scope).find((entry) => entry.projectNo === trimmed)
  return found ? found.postureKey : null
}

/**
 * Drop EVERY principal's memory in this browser profile, including the unscoped v1 key.
 *
 * Called on every auth transition this process performs. Deliberately not "drop the outgoing
 * principal's bucket": at the moment `useAuth` notifies, the token has already been swapped, so this
 * process can no longer name the principal that is leaving. Wiping the lot is the only version of
 * this that cannot leave the wrong bucket behind, and the cost is one operator re-opening a project
 * to re-learn a card they could always reach by number anyway.
 */
export function clearStockPrepOperatorHomeMemory(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const doomed: string[] = [LEGACY_UNSCOPED_KEY]
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key && key.startsWith(STORAGE_KEY_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) window.localStorage.removeItem(key)
  } catch {
    // Same failure posture as every other access here.
  }
}

// Subscribed at module load, like `approvals/adminCapability.ts` does for its own per-principal
// cache. `authPrincipal.ts` has no dependencies of its own, so importing it here adds nothing to the
// 55 specs that hand-stub `useAuth`.
onAuthPrincipalChange(() => {
  clearStockPrepOperatorHomeMemory()
})
