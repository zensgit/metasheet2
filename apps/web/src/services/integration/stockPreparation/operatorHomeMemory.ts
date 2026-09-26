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
//
// 从列表移除 (客户反馈 2026-09-24 #1a / A8). The cards this file's memory feeds were previously
// permanent and unlabelled — no way to remove one, and no line explaining that a card is only a
// shortcut, not the operator's only route to a project. `removeStockPrepRecentProject` below adds a
// SIBLING hidden list (project numbers only, nothing richer) that `operatorHomeCards.ts` consults to
// skip a card on the home page ONLY — the project's actual data, and 项目查询's own complete list,
// are untouched. `recordStockPrepProjectVisit` clears an entry back out of that list on the next visit,
// and `clearStockPrepOperatorHomeMemory` sweeps it on every auth transition, same as everything else
// here.
//
// [B1, adversarial review 2026-09-26] An earlier revision of `removeStockPrepRecentProject` ALSO
// deleted the memory entry, on the theory that the hidden list alone left it "resurrectable". That was
// wrong: this memory is not private to the home page. 项目查询 (`projectQuery.ts` →
// `buildStockPrepProjectQueryRows`) reads the exact same per-tenant+principal list, and so does
// `StockPreparationProjectBoardView.vue`'s rule-4 "刚确认完" nudge
// (`readStockPrepRememberedPosture`). Deleting the entry took the remembered posture away from BOTH of
// those, silently, for a click made on a page that knows about neither. Hiding is now a pure VIEW-LAYER
// decision that lives entirely in the hidden list; `removeStockPrepRecentProject` no longer touches
// `readStockPrepRecentProjects`/its storage key at all. See its own doc comment for the corrected
// rationale.
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

/**
 * [S1, adversarial review 2026-09-26] The hidden list's OWN cap, deliberately separate from
 * `MAX_ENTRIES` above: the review's own directory can hold up to ~2,000 rows, so re-using the
 * 30-entry memory cap here meant the 31st hide silently evicted the 1st — a card an operator had
 * asked to stop seeing would quietly come back with no warning. `removeStockPrepRecentProject` checks
 * this BEFORE writing and REFUSES a hide past the cap (`'limit_reached'`) rather than ever truncating
 * a list that already reached it.
 */
export const HIDDEN_MAX_ENTRIES = 500

/**
 * A SIBLING key, deliberately built by extending `STORAGE_KEY_PREFIX` rather than starting a second
 * prefix of its own (客户反馈 2026-09-24 #1a / A8): `clearStockPrepOperatorHomeMemory`'s sweep below
 * matches every key with `key.startsWith(STORAGE_KEY_PREFIX)`, and a key built as
 * `${STORAGE_KEY_PREFIX}.hidden.v1:...` still starts with `STORAGE_KEY_PREFIX` byte-for-byte — so that
 * loop wipes this list too, with no separate case to keep in sync. Holds project numbers ONLY (no
 * posture, no timestamp): a project a person asked to stop seeing on the home page, not a fact this
 * browser is trying to remember about it.
 */
const HIDDEN_STORAGE_KEY_PREFIX = `${STORAGE_KEY_PREFIX}.hidden.v1`

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

/** Same tenant+principal scheme as `resolveStorageKey`, on the hidden-list's own sibling prefix. */
function resolveHiddenStorageKey(scope?: StockPrepMemoryScope): string {
  const tenant = (scope?.tenantId ?? '').trim() || 'no-tenant'
  const principal = getAuthPrincipalKey() ?? 'anonymous'
  return `${HIDDEN_STORAGE_KEY_PREFIX}:${tenant}:${principal}`
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
 * Every project number this principal asked the home page to stop showing (客户反馈 2026-09-24 #1a /
 * A8) — see `removeStockPrepRecentProject`. Malformed storage degrades to "nothing hidden", the same
 * posture every other read on this page takes.
 */
export function readStockPrepHiddenProjects(scope?: StockPrepMemoryScope): string[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(resolveHiddenStorageKey(scope))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * [S1] The `.slice` here is a DEFENSIVE backstop only — `removeStockPrepRecentProject` (the only
 * caller) already refuses to call this once `readStockPrepHiddenProjects(scope).length` reaches
 * `HIDDEN_MAX_ENTRIES`, so under normal use this never trims anything a person actually asked to
 * hide. It exists so a future caller, or hand-edited storage carrying more than the cap, cannot grow
 * this list without bound — never the mechanism by which a legitimate hide is silently dropped.
 */
function writeStockPrepHiddenProjects(projectNos: readonly string[], scope?: StockPrepMemoryScope): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(resolveHiddenStorageKey(scope), JSON.stringify(projectNos.slice(0, HIDDEN_MAX_ENTRIES)))
  } catch {
    // Same fail-silent posture as every other write here.
  }
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
 *
 * UNHIDES UNCONDITIONALLY, even for `running` (客户反馈 2026-09-24 #1a / A8): a person REOPENING a
 * project — the only way this function is ever called — is what brings its card back, regardless of
 * which posture that reopen happens to settle on. Doing this ahead of the `running` early-return, in
 * its own try, means a project opened mid-sync unhides even though its posture write below is skipped.
 */
export function recordStockPrepProjectVisit(
  projectNo: string,
  postureKey: StockPrepPostureKey,
  scope?: StockPrepMemoryScope,
): void {
  const trimmed = projectNo.trim()
  if (!trimmed) return
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const hidden = readStockPrepHiddenProjects(scope)
      if (hidden.includes(trimmed)) {
        writeStockPrepHiddenProjects(hidden.filter((no) => no !== trimmed), scope)
      }
    }
  } catch {
    // Same fail-silent posture as every other access here.
  }
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

/**
 * `removeStockPrepRecentProject`'s outcome, so the UI can tell the three cases apart rather than
 * guessing from a `void` return:
 *   - `'hidden'` — newly added to the hidden list; the home page may now skip this card.
 *   - `'already_hidden'` — a no-op; this project number was hidden already (idempotent, not an error).
 *   - `'limit_reached'` — refused. [S1] The hidden list is at `HIDDEN_MAX_ENTRIES` and this call did
 *     NOT evict anything to make room; the caller must tell the operator the hide did not happen.
 */
export type StockPrepRemoveRecentProjectResult = 'hidden' | 'already_hidden' | 'limit_reached'

/**
 * 从列表移除 (客户反馈 2026-09-24 #1a / A8). Adds this project to the hidden list. THAT IS ALL —
 * [B1, adversarial review 2026-09-26] an earlier revision ALSO deleted the matching entry out of the
 * remembered-posture list above, on the theory that a card the home page still had a reason to show
 * (see `buildOperatorHomeCards`'s live-`pendingDecisionCount` guard) should not silently regain its
 * remembered posture from a stale write. That reasoning only considered the home page. The remembered
 * list is READ BY OTHER THINGS: 项目查询 (`projectQuery.ts`) folds it into a row that is supposed to
 * stay the COMPLETE list regardless of what is hidden here, and the board's rule-4 "刚确认完，再同步
 * 一次" nudge (`StockPreparationProjectBoardView.vue`, `readStockPrepRememberedPosture`) depends on it
 * surviving between mounts. Deleting the entry made a memory-only project vanish from 项目查询
 * entirely, dropped a directory project out of the 可以导出 filter there (its remembered `ready`
 * became the honest-but-wrong `看不到`), and erased rule 4's memory of "this was just held pending" —
 * all from a click on a screen that knows about none of those three consumers. Hiding is therefore
 * ENTIRELY a view-layer decision inside the hidden list; nothing this browser remembers changes. This
 * is also why it is still not a data delete in the OTHER sense either: the project's rows stay exactly
 * where they are in the 备料表. Reopening the project (`recordStockPrepProjectVisit`, above) undoes it.
 */
export function removeStockPrepRecentProject(
  projectNo: string,
  scope?: StockPrepMemoryScope,
): StockPrepRemoveRecentProjectResult {
  const trimmed = projectNo.trim()
  if (!trimmed) return 'already_hidden'
  const hidden = readStockPrepHiddenProjects(scope)
  if (hidden.includes(trimmed)) return 'already_hidden'
  if (hidden.length >= HIDDEN_MAX_ENTRIES) return 'limit_reached'
  writeStockPrepHiddenProjects([trimmed, ...hidden], scope)
  return 'hidden'
}

/**
 * 全部恢复 (S2, adversarial review 2026-09-26). Clears every project THIS scope hid — never every
 * principal's, unlike `clearStockPrepOperatorHomeMemory`: that one runs on an auth transition, where
 * "whose bucket is this" can no longer be named (see its own comment); this one is a direct click from
 * a signed-in operator restoring their OWN list, so it stays scoped to `resolveHiddenStorageKey`.
 * Touches only the hidden list — the remembered postures underneath are untouched either way, per
 * `removeStockPrepRecentProject`'s own doc above.
 */
export function clearStockPrepHiddenProjects(scope?: StockPrepMemoryScope): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.removeItem(resolveHiddenStorageKey(scope))
  } catch {
    // Same fail-silent posture as every other write here.
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
 *
 * ALSO WIPES THE HIDDEN LIST (客户反馈 2026-09-24 #1a / A8), with no separate case needed: the loop
 * below matches by `startsWith(STORAGE_KEY_PREFIX)`, and `HIDDEN_STORAGE_KEY_PREFIX` is built by
 * EXTENDING `STORAGE_KEY_PREFIX` rather than starting a prefix of its own, so every hidden-list key
 * already satisfies that check. Confirmed by the "auth transition wipes every principal's memory"
 * spec, extended to also assert the hidden list is gone.
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
