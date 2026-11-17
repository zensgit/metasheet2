import type { Request, Response } from 'express'
import { transaction } from '../db/pg'
import { resolveApprovalRequesterOrgRelations, ApprovalRoutingPolicyError } from '../services/ApprovalDirectoryOrg'
import { jsonError, jsonOk } from '../util/response'

/** Display-only: the same policy resolution as approval creation, never a preview override. */
export function userApprovalRelationsHandler(ensureAdmin: (req: Request, res: Response) => Promise<string | null>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!await ensureAdmin(req, res)) return
    const userId = String(req.params.userId ?? '').trim()
    if (!userId || userId.length > 200 || Object.keys(req.query).length > 0) {
      jsonError(res, 400, 'APPROVAL_RELATIONS_INVALID_INPUT', 'Invalid approval relationship query')
      return
    }
    try {
      const result = await transaction(async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const subject = await client.query('SELECT id FROM users WHERE id = $1', [userId])
        if (!subject.rows.length) return null
        const relations = await resolveApprovalRequesterOrgRelations(userId, client.query.bind(client), {
          includeDepartmentFieldContext: true,
        })
        const anchor = relations.canonicalIntegrationId
        const source = anchor
          ? await client.query(
            `SELECT i.provider, EXISTS (
             SELECT 1 FROM org_directory_routing_policy p
              WHERE p.canonical_integration_id = i.id AND p.org_id = i.org_id
                AND p.purpose = 'approval_routing'
           ) AS policy FROM directory_integrations i WHERE i.id = $1::uuid`, [anchor])
          : { rows: [] }
        const ids = [...new Set([relations.managerId, relations.deptHeadId].filter((id): id is string => !!id))]
        const people = ids.length
          ? await client.query('SELECT id, name FROM users WHERE id = ANY($1::text[])', [ids])
          : { rows: [] }
        const person = (id: string | undefined) => id
          ? { id, name: people.rows.find(row => row.id === id)?.name ?? null }
          : null
        const selected = source.rows[0]
        return {
          userId,
          source: {
            mode: selected ? (selected.policy ? 'policy' : 'legacy-default') : 'unresolved',
            provider: selected?.provider ?? null,
          },
          primaryDepartment: relations.primaryDepartmentName ?? null,
          manager: person(relations.managerId),
          departmentHead: person(relations.deptHeadId),
        }
      })
      if (!result) {
        jsonError(res, 404, 'NOT_FOUND', 'User not found')
        return
      }
      jsonOk(res, result)
    } catch (error) {
      if (error instanceof ApprovalRoutingPolicyError) {
        jsonError(res, 409, 'APPROVAL_RELATIONS_UNRESOLVED', 'Approval relationship source needs review')
        return
      }
      jsonError(res, 500, 'APPROVAL_RELATIONS_UNAVAILABLE', 'Approval relationships unavailable')
    }
  }
}
