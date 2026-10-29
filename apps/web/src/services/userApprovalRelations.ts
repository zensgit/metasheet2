import { apiFetch } from '../utils/api'

export interface ApprovalRelationPerson { id: string; name: string | null }
export interface UserApprovalRelations {
  userId: string
  source: { mode: 'policy' | 'legacy-default' | 'unresolved'; provider: string | null }
  primaryDepartment: string | null
  manager: ApprovalRelationPerson | null
  departmentHead: ApprovalRelationPerson | null
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nullableText = (v: unknown) => v === null || typeof v === 'string'
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k))
function person(v: unknown): boolean {
  return v === null || (object(v) && exact(v, ['id', 'name']) && typeof v.id === 'string' && !!v.id.trim() && nullableText(v.name))
}
export async function readUserApprovalRelations(userId: string): Promise<UserApprovalRelations> {
  const response = await apiFetch('/api/admin/users/' + encodeURIComponent(userId) + '/approval-relations', {
    method: 'GET', suppressUnauthorizedRedirect: true,
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('FORBIDDEN')
    if (response.status === 409) {
      const failure: unknown = await response.json().catch(() => null)
      if (object(failure) && object(failure.error) && failure.error.code === 'APPROVAL_RELATIONS_UNRESOLVED') throw new Error('SOURCE_UNRESOLVED')
    }
    throw new Error('UNAVAILABLE')
  }
  const payload: unknown = await response.json()
  const data = object(payload) && payload.ok === true ? payload.data : null
  if (!object(data) || !exact(data, ['userId', 'source', 'primaryDepartment', 'manager', 'departmentHead'])
    || data.userId !== userId || !object(data.source) || !exact(data.source, ['mode', 'provider'])
    || !['policy', 'legacy-default', 'unresolved'].includes(String(data.source.mode))
    || !nullableText(data.source.provider) || !nullableText(data.primaryDepartment)
    || !person(data.manager) || !person(data.departmentHead)) throw new Error('UNAVAILABLE')
  return data as unknown as UserApprovalRelations
}
