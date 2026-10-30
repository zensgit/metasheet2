import { apiFetch } from '../utils/api'
import { useAuth } from '../composables/useAuth'
import { readAuthSessionSignature } from '../composables/authPrincipal'

export interface LocalDepartment {
  id: string; name: string; parentDepartmentId: string | null
  parentMissing: boolean; orderIndex: number; isActive: boolean
}
export interface LocalMembership {
  id: string; departmentId: string; departmentName: string
  departmentActive: boolean; isPrimary: boolean; isManager: boolean
}
export interface LocalCandidate { id: string; name: string | null; username: string | null }
export interface LocalMember {
  id: string; name: string; title: string | null; isActive: boolean
  localUser: LocalCandidate | null; isEligible: boolean; memberships: LocalMembership[]
}
export interface LocalWorkspace {
  integration: { id: string; name: string; isActive: boolean } | null
  departments: LocalDepartment[]
}
export interface LocalPage<T> { integrationId: string; page: number; pageSize: number; total: number; items: T[] }
export interface LocalPageQuery { integrationId: string; page: number; pageSize: number; q: string }
export interface LocalHead { id: string; accountId: string; departmentId: string; isDepartmentHead: boolean; readOnly: boolean }
export interface DepartmentInput { name: string; parentDepartmentId: string | null; orderIndex: number }

export class LocalOrganizationError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
    this.name = 'LocalOrganizationError'
  }
}
const root = '/api/admin/directory/local'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const nullableText = (v: unknown) => v === null || typeof v === 'string'
const id = (v: unknown): v is string => typeof v === 'string' && uuid.test(v)
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.prototype.hasOwnProperty.call(v, k))
function fail(status = 502, code = 'INVALID_RESPONSE'): never { throw new LocalOrganizationError(status, code) }
function input(valid: boolean): void { if (!valid) fail(400, 'DIRECTORY_LOCAL_INVALID_INPUT') }
function candidate(v: unknown): v is LocalCandidate {
  return object(v) && keys(v, ['id', 'name', 'username']) && text(v.id) && nullableText(v.name) && nullableText(v.username)
}
function department(v: unknown): v is LocalDepartment {
  return object(v) && keys(v, ['id', 'name', 'parentDepartmentId', 'parentMissing', 'orderIndex', 'isActive'])
    && id(v.id) && text(v.name) && (v.parentDepartmentId === null || id(v.parentDepartmentId))
    && typeof v.parentMissing === 'boolean' && Number.isSafeInteger(v.orderIndex) && typeof v.isActive === 'boolean'
}
function membership(v: unknown, accountId: string): v is LocalMembership {
  return object(v) && keys(v, ['id', 'departmentId', 'departmentName', 'departmentActive', 'isPrimary', 'isManager'])
    && id(v.departmentId) && v.id === accountId + ':' + v.departmentId && text(v.departmentName)
    && typeof v.departmentActive === 'boolean' && typeof v.isPrimary === 'boolean' && typeof v.isManager === 'boolean'
}
function member(v: unknown): v is LocalMember {
  return object(v) && keys(v, ['id', 'name', 'title', 'isActive', 'localUser', 'isEligible', 'memberships'])
    && id(v.id) && text(v.name) && nullableText(v.title) && typeof v.isActive === 'boolean'
    && (v.localUser === null || candidate(v.localUser)) && typeof v.isEligible === 'boolean'
    && Array.isArray(v.memberships) && v.memberships.every(m => membership(m, v.id as string))
}
const errorCodes = new Set(['DIRECTORY_LOCAL_INVALID_INPUT', 'DIRECTORY_LOCAL_UNKNOWN_FIELDS', 'FORBIDDEN',
  'DIRECTORY_LOCAL_NOT_FOUND', 'LOCAL_ORG_CONTEXT_CHANGED', 'LOCAL_ORG_ANCHOR_AMBIGUOUS',
  'DIRECTORY_LOCAL_CONFLICT', 'DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY', 'LOCAL_ORG_INTERNAL_ERROR'])
async function request(path: string, method = 'GET', body?: object): Promise<Record<string, unknown>> {
  const signature = readAuthSessionSignature()
  const current = () => signature === readAuthSessionSignature()
  if (!useAuth().hasAdminAccess()) fail(403, 'FORBIDDEN')
  try {
    const response = await apiFetch(root + path, {
      method, suppressUnauthorizedRedirect: true,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!current()) fail(409, 'LOCAL_ORG_CONTEXT_CHANGED')
    if (response.status === 401 || response.status === 403) fail(response.status, 'FORBIDDEN')
    const payload: unknown = await response.json()
    if (!current()) fail(409, 'LOCAL_ORG_CONTEXT_CHANGED')
    if (!response.ok) {
      const code = object(payload) && object(payload.error) && typeof payload.error.code === 'string'
        && errorCodes.has(payload.error.code) ? payload.error.code : 'REQUEST_FAILED'
      fail(response.status, code)
    }
    if (!object(payload) || payload.ok !== true || !object(payload.data)) fail()
    return payload.data
  } catch (error) {
    if (!current()) fail(409, 'LOCAL_ORG_CONTEXT_CHANGED')
    if (error instanceof LocalOrganizationError) throw error
    fail(0, 'REQUEST_FAILED')
  }
}
async function page<T>(path: string, query: LocalPageQuery, check: (v: unknown) => v is T): Promise<LocalPage<T>> {
  input(id(query.integrationId) && integer(query.page, 1) && integer(query.pageSize, 1) && query.pageSize <= 100
    && typeof query.q === 'string' && query.q.trim().length <= 200)
  const params = new URLSearchParams({ integrationId: query.integrationId, page: String(query.page), pageSize: String(query.pageSize), q: query.q.trim() })
  const data = await request(path + '?' + params)
  if (!keys(data, ['integrationId', 'page', 'pageSize', 'total', 'items'])
    || data.integrationId !== query.integrationId || data.page !== query.page || data.pageSize !== query.pageSize
    || !integer(data.total) || !Array.isArray(data.items) || data.items.length > query.pageSize || !data.items.every(check)) fail()
  return data as unknown as LocalPage<T>
}
async function write(path: string, method: string, body: object, result: string): Promise<void> {
  const data = await request(path, method, body)
  if (!object(data[result])) fail()
}
function departmentBody(value: DepartmentInput): DepartmentInput {
  input(text(value.name) && (value.parentDepartmentId === null || id(value.parentDepartmentId)) && Number.isSafeInteger(value.orderIndex))
  return { name: value.name.trim(), parentDepartmentId: value.parentDepartmentId, orderIndex: value.orderIndex }
}
function target(value: string): string { input(id(value)); return encodeURIComponent(value) }
function membershipTarget(value: string): string {
  const parts = value.split(':')
  input(parts.length === 2 && parts.every(id))
  return encodeURIComponent(value)
}
export const localOrganizationClient = {
  async workspace(): Promise<LocalWorkspace> {
    const data = await request('/workspace')
    const anchor = data.integration
    if (!keys(data, ['integration', 'departments']) || !(anchor === null || (object(anchor)
      && keys(anchor, ['id', 'name', 'isActive']) && id(anchor.id) && text(anchor.name) && typeof anchor.isActive === 'boolean'))
      || !Array.isArray(data.departments) || !data.departments.every(department) || (anchor === null && data.departments.length > 0)) fail()
    return data as unknown as LocalWorkspace
  },
  members: (query: LocalPageQuery) => page('/members', query, member),
  candidates: (query: LocalPageQuery) => page('/member-candidates', query, candidate),
  async project(integrationId: string, localUserId: string): Promise<{ accountId: string; created: boolean }> {
    input(id(integrationId) && text(localUserId) && localUserId.length <= 200)
    const data = await request('/member-projections', 'POST', { integrationId, localUserId })
    const v = data.projection
    if (!keys(data, ['projection']) || !object(v) || !keys(v, ['accountId', 'created']) || !id(v.accountId) || typeof v.created !== 'boolean') fail()
    return v as unknown as { accountId: string; created: boolean }
  },
  createDepartment: (v: DepartmentInput) => write('/departments', 'POST', departmentBody(v), 'department'),
  updateDepartment: (departmentId: string, v: DepartmentInput) => write('/departments/' + target(departmentId), 'PATCH', departmentBody(v), 'department'),
  archiveDepartment: (departmentId: string) => write('/departments/' + target(departmentId) + '/archive', 'POST', {}, 'department'),
  updateMember(accountId: string, v: { name: string }) {
    input(text(v.name))
    return write('/accounts/' + target(accountId), 'PATCH', { name: v.name.trim() }, 'account')
  },
  archiveMember: (accountId: string) => write('/accounts/' + target(accountId) + '/archive', 'POST', {}, 'account'),
  addMembership: (accountId: string, departmentId: string) => {
    target(accountId); target(departmentId)
    return write('/memberships', 'POST', { accountId, departmentId }, 'membership')
  },
  primary: (membershipId: string) => write('/memberships/' + membershipTarget(membershipId), 'PATCH', { isPrimary: true }, 'membership'),
  manager: (membershipId: string, isManager: boolean) => {
    input(typeof isManager === 'boolean')
    return write('/memberships/' + membershipTarget(membershipId), 'PATCH', { isManager }, 'membership')
  },
  async head(membershipId: string): Promise<LocalHead> {
    const data = await request('/memberships/' + membershipTarget(membershipId) + '/department-head')
    const v = data.membership
    const [accountId, departmentId] = membershipId.split(':')
    if (!keys(data, ['membership']) || !object(v) || !keys(v, ['id', 'accountId', 'departmentId', 'isDepartmentHead', 'readOnly'])
      || v.id !== membershipId || v.accountId !== accountId || v.departmentId !== departmentId
      || typeof v.isDepartmentHead !== 'boolean' || typeof v.readOnly !== 'boolean') fail()
    return v as unknown as LocalHead
  },
  async setHead(membershipId: string, isDepartmentHead: boolean): Promise<void> {
    input(typeof isDepartmentHead === 'boolean')
    const data = await request('/memberships/' + membershipTarget(membershipId) + '/department-head', 'PATCH', { isDepartmentHead })
    const v = data.membership
    const [accountId, departmentId] = membershipId.split(':')
    if (!keys(data, ['membership']) || !object(v) || !keys(v, ['id', 'accountId', 'departmentId', 'isDepartmentHead'])
      || v.id !== membershipId || v.accountId !== accountId || v.departmentId !== departmentId || v.isDepartmentHead !== isDepartmentHead) fail()
  },
}
export function localOrganizationMessage(error: unknown): string {
  if (!(error instanceof LocalOrganizationError)) return '操作未完成，请手动重试。'
  if (error.status === 401 || error.status === 403) return '当前会话无权管理组织，请重新确认登录与管理员权限。'
  if (error.code === 'LOCAL_ORG_CONTEXT_CHANGED') return '组织上下文已变化，请重新加载后操作。'
  if (error.status === 409) return '当前状态存在冲突，请刷新后重新选择。'
  if (error.status === 400) return '输入无效，请检查表单。'
  if (error.status === 404) return '记录或部门负责人功能暂不可用，请刷新确认。'
  return '操作未完成，请手动重试。'
}
