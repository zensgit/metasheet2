// 备料「成员与权限」— the web half of slice S5b (ADR adr-stock-prep-project-sheets-20261008 §11.4–11.6;
// register R-39).
//
// TWO FAMILIES OF ROUTES, AND WHY:
//
//   the four S5b plugin routes (WORKBENCH_ADMIN gate, then the host's narrow members port)
//     GET   /api/integration/stock-preparation/members
//     POST  /api/integration/stock-preparation/members/custom-roles
//     PATCH /api/integration/stock-preparation/members/custom-roles/:roleId
//     POST  /api/integration/stock-preparation/members/custom-roles/:roleId/project-targets
//
//   the EXISTING delegation routes (core-backend routes/admin-users.ts), reused rather than copied:
//     GET   /api/admin/role-delegation/users?q=           whom this admin may appoint (scoped)
//     POST  /api/admin/role-delegation/users/:id/roles/assign | unassign   { roleId }
//     PATCH /api/admin/role-delegation/users/:id/namespaces/stock-prep/admission   { enabled }
//
// Appointing a member is TWO calls — the role, then the plugin admission (「开通插件使用」) — because
// a stock-prep code is inert without the admission (namespace-admission.ts). Revoking is one call; the
// server closes the admission itself when the user holds no stock-prep role any more.
//
// THE MAIN ADMINISTRATOR IS NEVER APPOINTED FROM HERE (ADR §11.7, last bullet). The page offers no
// control for it and `appointStockPrepMember` refuses it before any request; the existing delegation
// route would still accept it from a direct API call, which is recorded in the PR as a known limit.
//
// All four S5b routes answer 404 STOCK_PREP_MEMBERS_PAGE_DISABLED while the default-OFF switch is off;
// `readStockPrepMembers` turns that answer into `null`, which is how the shell knows to keep the rail
// item hidden.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationScope } from '../workbench'

export const STOCK_PREP_MEMBERS_NAMESPACE = 'stock-prep'
export const STOCK_PREP_MAIN_ADMIN_ROLE_ID = 'stock-prep_admin'
export const STOCK_PREP_MEMBERS_PAGE_DISABLED_CODE = 'STOCK_PREP_MEMBERS_PAGE_DISABLED'
export const STOCK_PREP_DELEGATION_SCOPE_REQUIRED_CODE = 'ROLE_DELEGATION_SCOPE_REQUIRED'
/** What a custom role may carry — the server's closed list, mirrored for the editor's checkboxes. */
export const STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES = Object.freeze(['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] as const)

export type StockPrepMembersRoleKind = 'builtin' | 'custom' | 'other'

export interface StockPrepMembersMember {
  userId: string
  name: string | null
  email: string | null
  username: string | null
  admitted: boolean
}

export interface StockPrepMembersRole {
  id: string
  kind: StockPrepMembersRoleKind
  installed: boolean
  name: string | null
  permissionCodes: string[]
  otherCodeCount: number
  editable: boolean
  appointable: boolean
  members: StockPrepMembersMember[]
  outOfScopeMemberCount: number
  /** Custom roles only: the project sheets this grantor can read that the role holds write on. */
  sheetIds: string[]
  otherSheetCount: number
}

export interface StockPrepMembersAuditEntry {
  at: string | null
  action: string | null
  resourceType: string | null
  actorId: string | null
  userId: string | null
  roleId: string | null
  namespace: string | null
  sheetId: string | null
  enabled: boolean | null
}

export interface StockPrepMembersView {
  actor: { isPlatformAdmin: boolean; delegated: boolean }
  grantableCodes: string[]
  selectableCodes: string[]
  builtInRoles: StockPrepMembersRole[]
  customRoles: StockPrepMembersRole[]
  otherRoles: StockPrepMembersRole[]
  audit: { available: boolean; entries: StockPrepMembersAuditEntry[] }
}

export interface StockPrepDelegationUser {
  id: string
  name: string | null
  email: string | null
  username: string | null
}

/** What the members read can answer: the page, "switched off", or "not yours" (scope missing). */
export type StockPrepMembersReadOutcome =
  | { kind: 'ready'; view: StockPrepMembersView }
  | { kind: 'disabled' }
  | { kind: 'scope-required' }

// ---------------------------------------------------------------------------
// strict clamps
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function codeList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string' && code.startsWith('stock-prep:')) : []
}

function handleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(id)) : []
}

function clampRole(raw: unknown): StockPrepMembersRole | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id, 128)
  const kind = raw.kind === 'builtin' || raw.kind === 'custom' || raw.kind === 'other' ? raw.kind : null
  if (!id || !kind || !Array.isArray(raw.members)) return null
  const members: StockPrepMembersMember[] = []
  for (const entry of raw.members.slice(0, 1000)) {
    if (!isRecord(entry)) continue
    const userId = str(entry.userId, 128)
    if (!userId) continue
    members.push({ userId, name: str(entry.name), email: str(entry.email), username: str(entry.username), admitted: entry.admitted === true })
  }
  return {
    id,
    kind,
    installed: raw.installed === true,
    name: str(raw.name),
    permissionCodes: codeList(raw.permissionCodes),
    otherCodeCount: count(raw.otherCodeCount),
    editable: raw.editable === true && kind === 'custom',
    // Never trust a server flag to offer the main administrator (§11.7): the page refuses it locally too.
    appointable: raw.appointable === true && id !== STOCK_PREP_MAIN_ADMIN_ROLE_ID,
    members,
    outOfScopeMemberCount: count(raw.outOfScopeMemberCount),
    sheetIds: handleList(raw.sheetIds),
    otherSheetCount: count(raw.otherSheetCount),
  }
}

function clampAuditEntry(raw: unknown): StockPrepMembersAuditEntry | null {
  if (!isRecord(raw)) return null
  return {
    at: str(raw.at, 64),
    action: str(raw.action, 32),
    resourceType: str(raw.resourceType, 64),
    actorId: str(raw.actorId, 128),
    userId: str(raw.userId, 128),
    roleId: str(raw.roleId, 128),
    namespace: str(raw.namespace, 64),
    sheetId: str(raw.sheetId, 128),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
  }
}

/** The members payload, or null when it is not one. `enabled: true` is required — a generic envelope is not the page. */
export function clampStockPrepMembersView(raw: unknown): StockPrepMembersView | null {
  if (!isRecord(raw) || raw.enabled !== true || !isRecord(raw.actor)) return null
  if (!Array.isArray(raw.builtInRoles) || !Array.isArray(raw.customRoles)) return null
  const roles = (list: unknown): StockPrepMembersRole[] => (Array.isArray(list) ? list.map(clampRole).filter((role): role is StockPrepMembersRole => role !== null) : [])
  const audit = isRecord(raw.audit) ? raw.audit : {}
  return {
    actor: { isPlatformAdmin: raw.actor.isPlatformAdmin === true, delegated: raw.actor.delegated === true },
    grantableCodes: codeList(raw.grantableCodes),
    selectableCodes: codeList(raw.selectableCodes),
    builtInRoles: roles(raw.builtInRoles),
    customRoles: roles(raw.customRoles),
    otherRoles: roles(raw.otherRoles),
    audit: {
      available: audit.available === true,
      entries: Array.isArray(audit.entries) ? audit.entries.slice(0, 200).map(clampAuditEntry).filter((entry): entry is StockPrepMembersAuditEntry => entry !== null) : [],
    },
  }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/** HTTP status + clamped error code of a failed call. Never carries a server message. */
export class StockPrepMembersCallError extends Error {
  status: number
  code: string | null

  constructor(status: number, route: string, code: string | null = null) {
    super(`stock-prep members call failed (${route} -> ${status})`)
    this.name = 'StockPrepMembersCallError'
    this.status = status
    this.code = code
  }
}

function clampCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : null
}

async function readPayload(response: Response | undefined, route: string): Promise<unknown> {
  let payload: unknown = null
  try {
    payload = await response?.json()
  } catch {
    payload = null
  }
  const status = typeof response?.status === 'number' ? response.status : 0
  const envelope = isRecord(payload) ? payload : null
  if (!response?.ok || envelope?.ok === false || !envelope) {
    const error = envelope && isRecord(envelope.error) ? envelope.error : null
    throw new StockPrepMembersCallError(status, route, clampCode(error?.code))
  }
  return envelope.data
}

const BASE = '/api/integration/stock-preparation/members'
const DELEGATION = '/api/admin/role-delegation/users'

function jsonBody(method: string, body: Record<string, unknown>): RequestInit {
  return { method, body: JSON.stringify(body) }
}

/**
 * The members read. `disabled` for the switch-off 404 (and for a host without the plugin route), and
 * `scope-required` for a delegated admin nobody has given a department / member-group scope yet —
 * the page renders that one as a notice. Every other refusal throws.
 */
export async function readStockPrepMembers(): Promise<StockPrepMembersReadOutcome> {
  const route = 'GET …/members'
  try {
    const data = await readPayload(await apiFetch(BASE), route)
    const view = clampStockPrepMembersView(data)
    if (!view) throw new StockPrepMembersCallError(200, route, 'MALFORMED')
    return { kind: 'ready', view }
  } catch (error) {
    if (error instanceof StockPrepMembersCallError) {
      if (error.status === 404) return { kind: 'disabled' }
      if (error.status === 403 && error.code === STOCK_PREP_DELEGATION_SCOPE_REQUIRED_CODE) return { kind: 'scope-required' }
    }
    throw error
  }
}

export async function createStockPrepCustomRole(name: string, permissionCodes: string[]): Promise<{ roleId: string }> {
  const route = 'POST …/members/custom-roles'
  const data = await readPayload(await apiFetch(`${BASE}/custom-roles`, jsonBody('POST', { name, permissionCodes })), route)
  const roleId = isRecord(data) ? str(data.roleId, 128) : null
  if (!roleId) throw new StockPrepMembersCallError(200, route, 'MALFORMED')
  return { roleId }
}

export async function updateStockPrepCustomRole(roleId: string, patch: { name?: string; permissionCodes?: string[] }): Promise<void> {
  const route = 'PATCH …/members/custom-roles/:roleId'
  const body: Record<string, unknown> = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.permissionCodes !== undefined) body.permissionCodes = patch.permissionCodes
  await readPayload(await apiFetch(`${BASE}/custom-roles/${encodeURIComponent(roleId)}`, jsonBody('PATCH', body)), route)
}

/** Add project sheets (by project number) to a custom role. Add-only — there is no remove call. */
export async function addStockPrepCustomRoleProjectTargets(roleId: string, projectNos: string[]): Promise<void> {
  const route = 'POST …/members/custom-roles/:roleId/project-targets'
  await readPayload(await apiFetch(`${BASE}/custom-roles/${encodeURIComponent(roleId)}/project-targets`, jsonBody('POST', { projectNos })), route)
}

/** The users this admin may appoint (the delegation route scopes the list for a delegated admin). */
export async function searchStockPrepDelegationUsers(q: string): Promise<StockPrepDelegationUser[]> {
  const route = 'GET /api/admin/role-delegation/users'
  const params = new URLSearchParams({ page: '1', pageSize: '20' })
  if (q.trim()) params.set('q', q.trim())
  const data = await readPayload(await apiFetch(`${DELEGATION}?${params.toString()}`), route)
  const items = isRecord(data) && Array.isArray(data.items) ? data.items : []
  const out: StockPrepDelegationUser[] = []
  for (const item of items.slice(0, 100)) {
    if (!isRecord(item)) continue
    const id = str(item.id, 128)
    if (!id) continue
    out.push({ id, name: str(item.name), email: str(item.email), username: str(item.username) })
  }
  return out
}

/**
 * Appoint: the role, then the plugin admission. The main administrator is refused before any
 * request (ADR §11.7) — the page never renders the control, and this is the second fence.
 */
export async function appointStockPrepMember(userId: string, roleId: string): Promise<{ admitted: boolean }> {
  if (roleId === STOCK_PREP_MAIN_ADMIN_ROLE_ID) {
    throw new StockPrepMembersCallError(0, 'appoint', 'STOCK_PREP_MAIN_ADMIN_NOT_APPOINTABLE_HERE')
  }
  await readPayload(await apiFetch(`${DELEGATION}/${encodeURIComponent(userId)}/roles/assign`, jsonBody('POST', { roleId })), 'POST …/roles/assign')
  try {
    await setStockPrepMemberAdmission(userId, true)
    return { admitted: true }
  } catch {
    // The role landed; the admission did not. The page shows 「未开通」 with its own retry.
    return { admitted: false }
  }
}

export async function revokeStockPrepMember(userId: string, roleId: string): Promise<void> {
  if (roleId === STOCK_PREP_MAIN_ADMIN_ROLE_ID) {
    throw new StockPrepMembersCallError(0, 'revoke', 'STOCK_PREP_MAIN_ADMIN_NOT_APPOINTABLE_HERE')
  }
  await readPayload(await apiFetch(`${DELEGATION}/${encodeURIComponent(userId)}/roles/unassign`, jsonBody('POST', { roleId })), 'POST …/roles/unassign')
}

export async function setStockPrepMemberAdmission(userId: string, enabled: boolean): Promise<void> {
  await readPayload(
    await apiFetch(`${DELEGATION}/${encodeURIComponent(userId)}/namespaces/${STOCK_PREP_MEMBERS_NAMESPACE}/admission`, jsonBody('PATCH', { enabled })),
    'PATCH …/admission',
  )
}

/** The tenant's project sheets (S1 list, OPERATE), for the editor's tick list. Null when unavailable. */
export async function readStockPrepProjectSheetChoices(scope: IntegrationScope): Promise<Array<{ projectNo: string; sheetId: string; status: string }> | null> {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  try {
    const data = await readPayload(await apiFetch(`/api/integration/stock-preparation/project-targets${query ? `?${query}` : ''}`), 'GET …/project-targets')
    if (!isRecord(data) || !Array.isArray(data.items)) return null
    const out: Array<{ projectNo: string; sheetId: string; status: string }> = []
    for (const item of data.items.slice(0, 500)) {
      if (!isRecord(item)) continue
      const projectNo = str(item.projectNo, 128)
      const sheetId = handleList([item.sheetId])[0]
      const status = item.status === 'active' || item.status === 'archived' ? item.status : null
      if (projectNo && sheetId && status) out.push({ projectNo, sheetId, status })
    }
    return out
  } catch {
    return null
  }
}

/** Plain-language rows for the codes this page can meet. Values-free. */
export const STOCK_PREP_MEMBERS_ERROR_PLAIN: Readonly<Record<string, { zh: string; en: string }>> = Object.freeze({
  STOCK_PREP_MEMBERS_FORBIDDEN: { zh: '只有平台管理员或「备料主管理员」能管理本应用的成员。', en: 'Only a platform administrator or the stock-prep main administrator can manage this app\'s members.' },
  ROLE_DELEGATION_SCOPE_REQUIRED: { zh: '还没有给您配置可管理的部门或成员组，请平台管理员先在「角色委派」里配置。', en: 'No department or member group has been delegated to you yet; ask a platform administrator to set one up under role delegation.' },
  ROLE_DELEGATION_USER_OUT_OF_SCOPE: { zh: '这个人不在您可管理的部门或成员组里。', en: 'This person is outside the departments or member groups delegated to you.' },
  STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN: { zh: '自定义角色只能使用备料的权限。', en: 'A custom role may only carry stock-prep permissions.' },
  STOCK_PREP_CUSTOM_ROLE_CODE_NOT_SELECTABLE: { zh: '自定义角色不能包含「备料主管理员」权限。', en: 'A custom role cannot carry the main-administrator permission.' },
  STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR: { zh: '不能给出您自己没有的权限。', en: 'You cannot grant a permission you do not hold yourself.' },
  STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_READABLE: { zh: '只能授权您自己能打开的项目表。', en: 'You can only grant project sheets you can open yourself.' },
  STOCK_PREP_BUILTIN_ROLE_READ_ONLY: { zh: '内置角色在这里只能查看。', en: 'Built-in roles are read-only here.' },
  STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE: { zh: '这个角色里有您管理范围以外的成员，它的权限和项目表只能由平台管理员改。', en: 'This role has members outside your delegated scope; only a platform administrator can change what it grants.' },
  STOCK_PREP_CUSTOM_ROLE_LIMIT: { zh: '自定义角色已经到上限（100 个）。', en: 'The custom role limit (100) has been reached.' },
  STOCK_PREPARATION_PROJECT_ABSENT: { zh: '有项目还没有备料表。', en: 'A project has no stock-prep sheet yet.' },
  STOCK_PREPARATION_PROJECT_ARCHIVED: { zh: '有项目的备料表已归档，请先恢复。', en: 'A project\'s sheet is archived; restore it first.' },
  STOCK_PREPARATION_PROJECT_SHEETS_DISABLED: { zh: '本部署没有开启「一个项目一张备料表」，暂时不能按项目表授权。', en: 'Per-project sheets are off on this deployment, so project sheets cannot be granted yet.' },
  RECOVERY_AUTHORITY_BUSY: { zh: '权限正在恢复中，请稍后重试。', en: 'Permissions are being restored; retry shortly.' },
  STOCK_PREP_MAIN_ADMIN_NOT_APPOINTABLE_HERE: { zh: '主管理员不能在这里任命，请找平台管理员。', en: 'The main administrator cannot be appointed here; ask a platform administrator.' },
})

export function stockPrepMembersErrorPlain(error: unknown): { zh: string; en: string; code: string | null } {
  const code = error instanceof StockPrepMembersCallError ? error.code : null
  const row = code ? STOCK_PREP_MEMBERS_ERROR_PLAIN[code] : undefined
  if (row) return { ...row, code }
  return { zh: '操作没有成功，请稍后重试。', en: 'That did not work; please retry.', code }
}
