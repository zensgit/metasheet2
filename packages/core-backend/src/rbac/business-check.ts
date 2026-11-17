import type { Request, Response } from 'express'
import { z } from 'zod'
import { pool } from '../db/pg'
import { evaluateRequestGuard } from './rbac'
import { findBusinessGuardPolicy, findBusinessResourcePolicy } from './business-policies'
import { hasLiveRbacAdmin, readStrictPrincipal, validateStrictSession } from './strict-principal'
import { strictGuardLookups } from './strict-guard-lookups'
import { checkSheetContext, ResourceCheckUnavailable } from '../multitable/context-check'

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
const bodySchema = z.object({
  subject: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('self') }).strict(),
    z.object({ kind: z.literal('target'), userId: identifier }).strict(),
  ]),
  policyId: identifier,
  mode: z.enum(['single', 'any', 'all']).optional(),
  permissions: z.array(z.string().min(3).max(128).regex(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.*-]+$/)).max(32).optional(),
  resource: z.object({
    kind: z.literal('sheet'), baseId: identifier, sheetId: identifier,
    fieldId: identifier.optional(), viewId: identifier.optional(), recordId: identifier.optional(),
  }).strict().optional(),
}).strict().superRefine((body, ctx) => {
  if ((body.mode === undefined) !== (body.permissions === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mode and permissions must be paired' })
  }
  if (body.mode === 'single' && body.permissions?.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'single requires one permission' })
  }
})

type Decision = 'allow' | 'deny' | 'unknown'
function response(policyId: string, mode: string | undefined, result: Decision) {
  return { policyId, mode, result, layers: [{ layer: 'business_guard', result }], evaluatedAt: new Date().toISOString(), semantics: 'guard_snapshot' }
}

function resourceResponse(policyId: string, visibility: Decision, context: Decision) {
  const result = visibility === 'deny' || context === 'deny' ? 'deny'
    : visibility === 'allow' && context === 'allow' ? 'allow' : 'unknown'
  return { policyId, result, layers: [{ layer: 'resource_visibility', result: visibility }, { layer: 'resource_context', result: context }], evaluatedAt: new Date().toISOString(), semantics: 'guard_snapshot' }
}

/** A read-only snapshot; unsupported policies remain unknown. */
export async function businessCheck(req: Request, res: Response): Promise<void> {
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return }
  const body = parsed.data
  const actorId = req.user?.id?.toString()
  const authorization = req.headers.authorization
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!actorId || !token) { res.status(401).json({ error: 'Authentication required' }); return }
  if (!pool) { res.status(503).json({ error: 'Permission check unavailable' }); return }
  try {
    const client = await pool.connect()
    let status = 200
    const resourcePolicy = findBusinessResourcePolicy(body.policyId)
    let output: unknown = resourcePolicy ? resourceResponse(body.policyId, 'unknown', 'unknown') : response(body.policyId, body.mode, 'unknown')
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout = '2000ms'")
      const query = (sql: string, params?: unknown[]) => client.query(sql, params)
      const valid = await validateStrictSession(query, token, actorId)
      if (!valid) {
        status = 401
        output = { error: 'Authentication required' }
      } else if (body.subject.kind === 'target' && body.subject.userId !== actorId && !await hasLiveRbacAdmin(query, actorId)) {
        status = 403
        output = { error: 'Cannot check permissions for another user' }
      } else {
        const policy = findBusinessGuardPolicy(body.policyId)
        if (resourcePolicy && (body.mode !== undefined || !body.resource
          || (resourcePolicy.resource === 'field' ? !body.resource.fieldId : Boolean(body.resource.fieldId))
          || (resourcePolicy.resource === 'view' ? !body.resource.viewId : Boolean(body.resource.viewId))
          || (resourcePolicy.resource === 'record' || resourcePolicy.resource === 'field' ? !body.resource.recordId : Boolean(body.resource.recordId)))) {
          status = 400
          output = { error: 'Policy does not match request' }
        } else if (policy && (body.mode !== policy.mode || body.permissions?.length !== policy.permissions.length
          || body.permissions?.some((code, index) => code !== policy.permissions[index]))) {
          status = 400
          output = { error: 'Policy does not match request' }
        } else if (req.user?.permissionCheckProfileUnknown === true && (body.subject.kind === 'self' || resourcePolicy)) {
          // Normal authentication may bootstrap attendance grants; this read-only request cannot predict the write.
        } else if (resourcePolicy && body.resource) {
          const subject = body.subject.kind === 'target'
            ? { kind: 'target' as const, userId: body.subject.userId } : { kind: 'self' as const }
          const result = await checkSheetContext(query, req, strictGuardLookups(query), subject, { baseId: body.resource.baseId, sheetId: body.resource.sheetId, ...(body.resource.recordId ? { recordId: body.resource.recordId } : {}), ...(body.resource.viewId ? { viewId: body.resource.viewId } : {}), ...(body.resource.fieldId ? { fieldId: body.resource.fieldId } : {}) })
          output = resourceResponse(body.policyId, result.visibility, result.context)
        } else if (policy && !body.resource) {
          const lookups = strictGuardLookups(query)
          let subjectReq: Request | undefined
          if (body.subject.kind === 'self') {
            subjectReq = req
          } else if (process.env.RBAC_TOKEN_TRUST !== 'true' && process.env.RBAC_TOKEN_TRUST !== '1') {
            const principal = await readStrictPrincipal(query, body.subject.userId)
            if (principal) {
              const admin = await lookups.isAdmin(body.subject.userId)
              const permissions = await lookups.listPermissions(body.subject.userId)
              subjectReq = { user: { id: body.subject.userId, role: admin ? 'admin' : (principal.role || 'user'), permissions } } as Request
            }
          }
          if (subjectReq) {
            const allowed = await evaluateRequestGuard(subjectReq, policy.mode, policy.permissions, lookups)
            output = response(body.policyId, body.mode, allowed ? 'allow' : 'deny')
          }
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    res.status(status).json(output)
  } catch (error) {
    if (error instanceof ResourceCheckUnavailable) {
      res.json(resourceResponse(body.policyId, 'unknown', 'unknown'))
      return
    }
    res.status(503).json({ error: 'Permission check unavailable' })
  }
}
