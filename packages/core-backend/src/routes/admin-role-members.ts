import { Router } from 'express'
import type { Request, Response } from 'express'
import { query } from '../db/pg'
import { authenticate } from '../middleware/auth'
import { jsonError, jsonOk, parsePagination } from '../util/response'
import { ensurePlatformAdmin } from './admin-users'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/**
 * One statement so role existence, member total, and the ordered page share a snapshot.
 * Membership is every persisted user_roles row, including inactive accounts and rows whose
 * user record has no name. No organization predicate: a platform admin may read across orgs.
 * The SELECT list is id plus display name only.
 */
const ROLE_MEMBERS_SQL = `
WITH target AS (
  SELECT r.id
  FROM roles r
  WHERE r.id = $1
),
members AS (
  SELECT
    ur.user_id AS id,
    COALESCE(NULLIF(BTRIM(u.name), ''), ur.user_id) AS display_name
  FROM target t
  JOIN user_roles ur ON ur.role_id = t.id
  LEFT JOIN users u ON u.id = ur.user_id
)
SELECT
  EXISTS (SELECT 1 FROM target) AS role_exists,
  (SELECT COUNT(*)::int FROM members) AS total,
  COALESCE(
    (
      SELECT json_agg(
        json_build_object('id', page.id, 'displayName', page.display_name)
        ORDER BY page.display_name ASC, page.id ASC
      )
      FROM (
        SELECT members.id, members.display_name
        FROM members
        ORDER BY members.display_name ASC, members.id ASC
        LIMIT $2 OFFSET $3
      ) page
    ),
    '[]'::json
  ) AS items
`

type MemberQueryRow = {
  role_exists: boolean
  total: number | string
  items: unknown
}

type RoleMember = {
  id: string
  displayName: string
}

function boundedPagination(queryParams: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const parsed = parsePagination(queryParams, {
    defaultPage: 1,
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
  })
  const page = Number.isInteger(parsed.page) && parsed.page >= 1 ? parsed.page : 1
  const pageSize = Number.isInteger(parsed.pageSize) && parsed.pageSize >= 1
    ? Math.min(parsed.pageSize, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function readRoleId(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return typeof value === 'string' ? value : ''
}

function readTotal(value: unknown): number | null {
  const total = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isInteger(total) || total < 0) return null
  return total
}

function readMembers(value: unknown): RoleMember[] | null {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  const items: RoleMember[] = []
  for (const row of parsed) {
    if (!row || typeof row !== 'object') return null
    const record = row as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id) return null
    const rawName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
    items.push({ id, displayName: rawName || id })
  }
  return items
}

function sendUnavailable(res: Response): void {
  if (res.headersSent) return
  jsonError(res, 503, 'ROLE_MEMBERS_UNAVAILABLE', 'Role members are temporarily unavailable')
}

export function adminRoleMembersRouter(): Router {
  const router = Router()

  router.get('/api/admin/roles/:roleId/members', authenticate, async (req: Request, res: Response) => {
    try {
      const adminUserId = await ensurePlatformAdmin(req, res)
      if (!adminUserId) return

      const roleId = readRoleId(req.params.roleId)
      if (!roleId) {
        jsonError(res, 400, 'ROLE_ID_REQUIRED', 'roleId is required')
        return
      }

      const { page, pageSize, offset } = boundedPagination(req.query as Record<string, unknown>)
      const result = await query<MemberQueryRow>(ROLE_MEMBERS_SQL, [roleId, pageSize, offset])
      const row = result.rows[0]
      if (!row) {
        sendUnavailable(res)
        return
      }
      if (row.role_exists !== true) {
        jsonError(res, 404, 'ROLE_NOT_FOUND', 'Role not found')
        return
      }

      const total = readTotal(row.total)
      const items = readMembers(row.items)
      if (total === null || items === null || items.length > total) {
        sendUnavailable(res)
        return
      }

      jsonOk(res, { items, page, pageSize, total })
    } catch {
      sendUnavailable(res)
    }
  })

  return router
}
