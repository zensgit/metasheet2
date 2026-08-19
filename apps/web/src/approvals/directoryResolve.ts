import { reactive } from 'vue'
import { resolveApprovalDirectoryUsers, resolveApprovalDirectoryRoles } from './api'

/**
 * member-display-identity (2026-08-19) — a shared, session-lifetime, module-singleton cache of
 * resolved member/role display names, sitting in front of the `/api/approvals/directory/resolve`
 * batch endpoint. Every viewer-facing site that used to render a raw assigneeId/roleId (or a
 * values-free-but-anonymous ordinal like "成员 N") calls `ensureUserNamesResolved`/
 * `ensureRoleNamesResolved` with the ids it has in view, then reads `getResolvedUserName`/
 * `getResolvedRoleName` from a `computed` — Vue's reactivity on a `reactive()` object tracks a
 * property read even before that property exists, so a computed that reads
 * `resolvedUserNames[id]` before resolution completes re-evaluates automatically once the batch
 * fetch lands and sets it.
 *
 * TRI-STATE per id:
 *   - absent from the cache entirely -> never requested (or a fetch is in flight)
 *   - `null`                          -> requested, CONFIRMED unresolved (inactive user / blank
 *                                        name / nonexistent id / role id the caller can't see) —
 *                                        the same value a caller lacking approvals:read|write|act
 *                                        gets, since the resolve endpoint 403s and this module
 *                                        degrades that to "unresolved", never an error.
 *   - a non-empty string              -> the resolved display name
 *
 * Callers MUST treat "absent" and "null" identically for rendering (both are getResolvedXName
 * returning `null`) — never render a name-shaped id ahead of confirmation, and never leave a
 * flow-changing selector option enabled before resolution confirms a real name. This is
 * deliberately conservative: a brief "not yet resolved" window renders the SAME fallback as a
 * permanently-unresolved id, so there is no flash of an enabled-then-disabled option.
 *
 * SCOPE: this cache carries no per-viewer org/tenant partition, because the underlying directory
 * machinery (`searchDirectoryUsers`/`resolveDirectoryUsersByIds`) carries none either (scoped only
 * by `is_active` + the RBAC capability union on the route) — see approval-directory.ts. A name
 * cached under one viewer's session and reused within the SAME browser tab for a different
 * logged-in viewer (without a full page reload, which resets this module) is a theoretical latent
 * concern this PR does not newly introduce or newly widen; every read still passes through the
 * SAME per-request RBAC guard, this cache only avoids repeat network round trips within one
 * session.
 *
 * TEST HYGIENE: `__resetResolvedDirectoryNamesForTests` clears this singleton — every spec that
 * mounts a resolver-consuming component MUST call it in `beforeEach`, or an earlier test's
 * resolved name leaks into a later test's assertions (a no-discriminating-power false green).
 */
export const resolvedUserNames = reactive<Record<string, string | null>>({})
export const resolvedRoleNames = reactive<Record<string, string | null>>({})

const RESOLVE_CHUNK = 50
const pendingUserIds = new Set<string>()
const pendingRoleIds = new Set<string>()
let userFlushScheduled = false
let roleFlushScheduled = false

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function flushUsers(): Promise<void> {
  const ids = Array.from(pendingUserIds)
  pendingUserIds.clear()
  userFlushScheduled = false
  if (ids.length === 0) return
  for (const group of chunk(ids, RESOLVE_CHUNK)) {
    let resolved: Array<{ id: string; name: string }> = []
    try {
      resolved = await resolveApprovalDirectoryUsers(group)
    } catch {
      // Defensive belt-and-suspenders (mirrors ApprovalUserPicker.vue's runSearch): the real
      // resolveApprovalDirectoryUsers never throws, but an incomplete test mock CAN make this
      // call itself throw synchronously (calling `undefined(...)`) — that must degrade to
      // "unresolved for this batch", never crash the caller's render.
      resolved = []
    }
    const found = new Set<string>()
    for (const row of resolved) {
      if (!row || typeof row.id !== 'string' || !row.id) continue
      found.add(row.id)
      resolvedUserNames[row.id] = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
    }
    for (const id of group) if (!found.has(id)) resolvedUserNames[id] = null
  }
}

async function flushRoles(): Promise<void> {
  const ids = Array.from(pendingRoleIds)
  pendingRoleIds.clear()
  roleFlushScheduled = false
  if (ids.length === 0) return
  for (const group of chunk(ids, RESOLVE_CHUNK)) {
    let resolved: Array<{ id: string; name: string }> = []
    try {
      resolved = await resolveApprovalDirectoryRoles(group)
    } catch {
      resolved = []
    }
    const found = new Set<string>()
    for (const row of resolved) {
      if (!row || typeof row.id !== 'string' || !row.id) continue
      found.add(row.id)
      resolvedRoleNames[row.id] = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
    }
    for (const id of group) if (!found.has(id)) resolvedRoleNames[id] = null
  }
}

/**
 * Queues every not-yet-known id in `ids` for a batch resolve (microtask-debounced so multiple
 * `ensure` calls made synchronously in the same reactivity flush collapse into one request), and
 * is a no-op for ids already resolved OR already confirmed-unresolved OR already in flight. Safe
 * to call from a `watch(..., { immediate: true })` on every render of the ids the caller has in
 * view — never call it from inside a `computed` getter (that would mutate a dependency of the
 * computed that reads it).
 */
export function ensureUserNamesResolved(ids: Iterable<string | null | undefined>): void {
  let scheduled = false
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id) continue
    if (Object.prototype.hasOwnProperty.call(resolvedUserNames, id)) continue
    if (pendingUserIds.has(id)) continue
    pendingUserIds.add(id)
    scheduled = true
  }
  if (!scheduled || userFlushScheduled) return
  userFlushScheduled = true
  void Promise.resolve().then(flushUsers)
}

export function ensureRoleNamesResolved(ids: Iterable<string | null | undefined>): void {
  let scheduled = false
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id) continue
    if (Object.prototype.hasOwnProperty.call(resolvedRoleNames, id)) continue
    if (pendingRoleIds.has(id)) continue
    pendingRoleIds.add(id)
    scheduled = true
  }
  if (!scheduled || roleFlushScheduled) return
  roleFlushScheduled = true
  void Promise.resolve().then(flushRoles)
}

/** `null` covers BOTH "not yet resolved" and "confirmed unresolved" — see the tri-state doc above. */
export function getResolvedUserName(id: string | null | undefined): string | null {
  if (!id) return null
  const value = resolvedUserNames[id]
  return typeof value === 'string' ? value : null
}

export function getResolvedRoleName(id: string | null | undefined): string | null {
  if (!id) return null
  const value = resolvedRoleNames[id]
  return typeof value === 'string' ? value : null
}

/**
 * Given a list of ids and a "get resolved name" lookup, returns the joined names ONLY if every id
 * resolved to a real name — otherwise `null` (the caller falls back to a values-free count). This
 * mirrors the existing `cancelledAssigneesLabel` (ApprovalDetailView.vue) all-or-nothing
 * convention: a partial name list padded with placeholders reads as a formatting bug, not a
 * redaction, so a display either shows the full real picture or an honest count.
 */
export function joinIfAllResolved(
  ids: readonly string[],
  getName: (id: string) => string | null,
): string[] | null {
  if (ids.length === 0) return []
  const names: string[] = []
  for (const id of ids) {
    const name = getName(id)
    if (!name) return null
    names.push(name)
  }
  return names
}

/** Test-only: clears the module-singleton cache + any queued-but-not-yet-flushed ids. Every spec
 *  that mounts a component consuming this module MUST call this in `beforeEach` — otherwise an
 *  earlier test's resolved name (or confirmed-unresolved marker) leaks into a later test and makes
 *  a discriminating negative pass for the wrong reason. */
export function __resetResolvedDirectoryNamesForTests(): void {
  for (const key of Object.keys(resolvedUserNames)) delete resolvedUserNames[key]
  for (const key of Object.keys(resolvedRoleNames)) delete resolvedRoleNames[key]
  pendingUserIds.clear()
  pendingRoleIds.clear()
  userFlushScheduled = false
  roleFlushScheduled = false
}
