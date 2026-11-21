import { reactive } from 'vue'
import type { ApprovalAssignmentDTO } from '../types/approval'
import { apiFetch as defaultApiFetch, type ApiFetchOptions } from '../utils/api'

/**
 * Current-seat display for the approval detail page (当前处理人) and the approval-center pane
 * (待处理人) — customer issue 2026-10-27 item 6a-1.
 *
 * A 「指定角色」 node writes ONE `type === 'role'` seat per role, whose `assigneeId` is the ROLE id
 * (backend `ApprovalAssigneeResolver`, `static_role`). Both surfaces used to hand that role id to the
 * users-only name resolver (`directoryResolve.ts`), which can never answer it, so a role seat read as
 * the generic 「审批人」 placeholder (detail page) or 「成员 1」 (pane) — as if it were one person.
 *
 * This module splits the seats by type:
 *   - `user` seats stay one line each and keep the existing users-only resolver path;
 *   - `role` seats at the same node collapse into ONE line, 「指定角色（N 个）」, N = that node's role
 *     seat count — the same values-free count wording TemplateDetailView already uses for a role
 *     (zh and en). In zh it also matches `requesterFacingSourceSummary` (assigneeSource.ts); that
 *     summary's en side reads "Specified roles (N)" and is left unchanged here;
 *   - any other seat type (`source_queue`, …) is not a user id either; callers render their
 *     generic placeholder for it and never send its id to the user resolver.
 *
 * ROLE NAME (template admins only): a viewer who already holds the template-admin capability can
 * read role names through the EXISTING authoring endpoint `GET /api/approval-templates/directory/roles`
 * (the static_role picker's source). For that viewer only, the role line shows the role name(s)
 * instead of the count. Everyone else keeps the count — no new endpoint, no widened guard, and never
 * the role's MEMBERS. The fetch is gated on the client-side capability, so an ordinary member never
 * issues it; a 401/403 (stale token) is cached as denied for the session and the line keeps the count.
 *
 * TEST HYGIENE: the role-name cache is a module singleton — a spec that can populate it must call
 * `__resetRoleSeatNamesForTests` in `beforeEach` (it also clears any injected fetch).
 */

type ApiFetchFn = (path: string, options?: ApiFetchOptions) => Promise<Response>

type RoleNameLoadStatus = 'idle' | 'loading' | 'ready' | 'denied'

const roleNameState = reactive<{ status: RoleNameLoadStatus; names: Record<string, string> }>({
  status: 'idle',
  names: {},
})

let injectedFetch: ApiFetchFn | null = null
let loadGeneration = 0

function readRoleNames(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!payload || typeof payload !== 'object') return out
  const roles = (payload as { roles?: unknown }).roles
  if (!Array.isArray(roles)) return out
  for (const entry of roles) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const key = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.name === 'string' ? record.name.trim() : ''
    // A role without a non-blank name is simply absent — the caller keeps the count.
    if (!key || !label) continue
    out[key] = label
  }
  return out
}

/**
 * Loads the role-name map once per session. Callers MUST only call this for a viewer who holds the
 * template-admin capability (see `canViewRoleSeatNames`). A transient failure returns the cache to
 * `idle`, so the next trigger may try again; 401/403 is terminal for the session.
 */
export function ensureRoleSeatNamesLoaded(): void {
  if (roleNameState.status !== 'idle') return
  roleNameState.status = 'loading'
  const generation = loadGeneration
  const fetchFn: ApiFetchFn = injectedFetch ?? defaultApiFetch
  void (async () => {
    try {
      const response = await fetchFn('/api/approval-templates/directory/roles', { suppressUnauthorizedRedirect: true })
      if (generation !== loadGeneration) return
      if (response.status === 401 || response.status === 403) {
        roleNameState.status = 'denied'
        return
      }
      if (!response.ok) {
        roleNameState.status = 'idle'
        return
      }
      const payload = await response.json().catch(() => null)
      if (generation !== loadGeneration) return
      roleNameState.names = readRoleNames(payload)
      roleNameState.status = 'ready'
    } catch {
      if (generation === loadGeneration) roleNameState.status = 'idle'
    }
  })()
}

/** The loaded role name, or `null` (not loaded / denied / unnamed). Reactive when read in a computed. */
export function roleSeatName(roleKey: string): string | null {
  if (roleNameState.status !== 'ready') return null
  return roleNameState.names[roleKey] ?? null
}

/**
 * Template-admin capability check, defensive about the permissions object's shape (several specs
 * mock `useApprovalPermissions` with `canAct` only).
 */
export function canViewRoleSeatNames(permissions: { canManageTemplates?: { value: boolean } } | null | undefined): boolean {
  return permissions?.canManageTemplates?.value === true
}

export type CurrentSeatGroup =
  | { kind: 'person'; key: string; assignment: ApprovalAssignmentDTO }
  | { kind: 'role'; key: string; nodeKey: string; roleKeys: string[] }

/**
 * Splits already-filtered ACTIVE current-node seats into display groups, in seat order: every
 * non-role seat is its own group; all role seats of one node become one group, placed where that
 * node's first role seat appears.
 */
export function groupCurrentSeats(active: readonly ApprovalAssignmentDTO[]): CurrentSeatGroup[] {
  const groups: CurrentSeatGroup[] = []
  const roleGroupByNode = new Map<string, { kind: 'role'; key: string; nodeKey: string; roleKeys: string[] }>()
  for (const assignment of active) {
    if (assignment.type !== 'role') {
      groups.push({ kind: 'person', key: assignment.id, assignment })
      continue
    }
    const nodeKey = assignment.nodeKey ?? ''
    let group = roleGroupByNode.get(nodeKey)
    if (!group) {
      group = { kind: 'role', key: `role-seats:${nodeKey}`, nodeKey, roleKeys: [] }
      roleGroupByNode.set(nodeKey, group)
      groups.push(group)
    }
    group.roleKeys.push(assignment.assigneeId)
  }
  return groups
}

/** The user ids among the given seats — the only ids that may go to the users-only resolver. */
export function userSeatIds(assignments: readonly ApprovalAssignmentDTO[] | null | undefined): string[] {
  const out: string[] = []
  for (const assignment of assignments ?? []) {
    if (assignment.type === 'user') out.push(assignment.assigneeId)
  }
  return out
}

/** Whether any of the given seats is a role seat (the trigger for the template-admin name load). */
export function hasRoleSeat(assignments: readonly ApprovalAssignmentDTO[] | null | undefined): boolean {
  return (assignments ?? []).some((assignment) => assignment.type === 'role')
}

/**
 * One role group's label. With `showNames` and EVERY role named: the names; otherwise the count
 * (N = the node's role seat count). Never a role id, never a member.
 */
export function roleSeatGroupLabel(roleKeys: readonly string[], isZh: boolean, showNames: boolean): string {
  const count = roleKeys.length
  if (showNames && count > 0) {
    const names: string[] = []
    const seen = new Set<string>()
    let allNamed = true
    for (const roleKey of roleKeys) {
      if (seen.has(roleKey)) continue
      seen.add(roleKey)
      const label = roleSeatName(roleKey)
      if (!label) {
        allNamed = false
        break
      }
      names.push(label)
    }
    if (allNamed && names.length > 0) {
      return isZh ? `指定角色「${names.join('、')}」` : `Designated role: ${names.join(', ')}`
    }
  }
  return isZh ? `指定角色（${count} 个）` : `Designated role (${count})`
}

export function __setRoleSeatNamesFetchForTests(fn: ApiFetchFn | null): void {
  injectedFetch = fn
}

export function __resetRoleSeatNamesForTests(): void {
  loadGeneration += 1
  roleNameState.status = 'idle'
  roleNameState.names = {}
  injectedFetch = null
}
