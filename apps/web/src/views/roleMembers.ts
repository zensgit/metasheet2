import { apiFetch } from '../utils/api'

export const ROLE_MEMBER_PAGE_SIZE = 20

export type RoleMember = {
  id: string
  displayName: string
}

export type RoleMemberPage = {
  items: RoleMember[]
  page: number
  pageSize: number
  total: number
}

export class RoleMembersReadError extends Error {
  constructor() {
    super('Role members are temporarily unavailable')
    this.name = 'RoleMembersReadError'
  }
}

function readMember(row: unknown): RoleMember | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) return null
  const rawName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
  return { id, displayName: rawName || id }
}

export async function fetchRoleMembers(roleId: string, page: number): Promise<RoleMemberPage> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(ROLE_MEMBER_PAGE_SIZE),
  })
  let response: Response
  try {
    response = await apiFetch(`/api/admin/roles/${encodeURIComponent(roleId)}/members?${params.toString()}`)
  } catch {
    throw new RoleMembersReadError()
  }

  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    throw new RoleMembersReadError()
  }
  if (!response.ok || payload.ok !== true || !payload.data || typeof payload.data !== 'object') {
    throw new RoleMembersReadError()
  }

  const data = payload.data as Record<string, unknown>
  const total = typeof data.total === 'number' ? data.total : Number.NaN
  if (!Array.isArray(data.items) || !Number.isInteger(total) || total < 0) {
    throw new RoleMembersReadError()
  }

  const items: RoleMember[] = []
  for (const row of data.items) {
    const member = readMember(row)
    if (!member) throw new RoleMembersReadError()
    items.push(member)
  }
  if (total < items.length) throw new RoleMembersReadError()

  const responsePage = typeof data.page === 'number' && Number.isInteger(data.page) && data.page >= 1
    ? data.page
    : page
  const responsePageSize = typeof data.pageSize === 'number' && Number.isInteger(data.pageSize) && data.pageSize >= 1
    ? data.pageSize
    : ROLE_MEMBER_PAGE_SIZE
  return { items, page: responsePage, pageSize: responsePageSize, total }
}
