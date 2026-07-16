import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import { ensurePlatformAdmin } from './admin-directory'
import {
  ADD_LOCAL_MEMBERSHIP_FIELD_TYPES,
  ADD_LOCAL_MEMBERSHIP_FIELDS,
  CREATE_LOCAL_ACCOUNT_FIELD_TYPES,
  CREATE_LOCAL_ACCOUNT_FIELDS,
  CREATE_LOCAL_DEPARTMENT_FIELD_TYPES,
  CREATE_LOCAL_DEPARTMENT_FIELDS,
  UPDATE_LOCAL_ACCOUNT_FIELD_TYPES,
  UPDATE_LOCAL_ACCOUNT_FIELDS,
  UPDATE_LOCAL_DEPARTMENT_FIELD_TYPES,
  UPDATE_LOCAL_DEPARTMENT_FIELDS,
  UPDATE_LOCAL_MEMBERSHIP_FIELD_TYPES,
  UPDATE_LOCAL_MEMBERSHIP_FIELDS,
  checkFieldAllowlist,
  checkFieldTypes,
  type LocalDirectoryFieldSpec,
} from '../directory/local-directory-org-request-schema'
import {
  LocalDirectoryConflictError,
  LocalDirectoryNotFoundError,
  LocalDirectoryValidationError,
  addLocalMembership,
  archiveLocalAccount,
  archiveLocalDepartment,
  createLocalAccount,
  createLocalDepartment,
  switchLocalPrimaryDepartment,
  updateLocalAccount,
  updateLocalDepartment,
} from '../directory/local-directory-org'
import { setLocalMembershipManager } from '../directory/directory-sync'
import { jsonError, jsonOk } from '../util/response'

const logger = new Logger('AdminDirectoryLocalRoutes')

// Must match `directory-sync.ts`'s own (unexported) `DEFAULT_ORG_ID`. Not imported/re-exported
// from there on purpose — keeping this file's only coupling to directory-sync.ts limited to the
// `getOrCreateLocalIntegration` import (via local-directory-org.ts) means this route file never
// needs to change if directory-sync.ts's internals move, and vice versa (clean parallel-lane
// rebase with B3, which also touches directory-sync.ts).
const DEFAULT_ORG_ID = 'default'

/**
 * The SOLE origin of org identity for every B2 write below. This codebase's directory subsystem
 * is single-tenant today: `admin-directory.ts`'s routes don't reference an org constant at the
 * route layer at all — they call the directory-sync services with no `orgId` argument and let
 * those services default it (`directory-sync.ts`'s own unexported `DEFAULT_ORG_ID = 'default'`).
 * This route resolves the SAME effective org ('default') explicitly instead, because
 * `local-directory-org.ts`'s functions require `orgId` (no default — see that module's header
 * comment on why). There is no per-request org/tenant context wired into the directory subsystem
 * yet for either style to read. Request bodies are never read for org identity here: this is the
 * actual mechanism that makes `org_id`/`corp_id` unspoofable, independent of (and in addition to)
 * the field allowlists below, which separately reject a request that even TRIES to send them.
 */
function resolveLocalDirectoryOrgId(_req: Request): string {
  return DEFAULT_ORG_ID
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

/**
 * Maps the three typed local-directory-org.ts errors to their HTTP status; anything else is an
 * unexpected 500. Error `.message` on all three thrown types is a static, developer-authored
 * string (never a client-supplied value), so surfacing it stays values-free.
 */
function handleLocalDirectoryError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof LocalDirectoryValidationError) {
    jsonError(res, 400, 'DIRECTORY_LOCAL_INVALID_INPUT', error.message)
    return
  }
  if (error instanceof LocalDirectoryNotFoundError) {
    jsonError(res, 404, 'DIRECTORY_LOCAL_NOT_FOUND', error.message)
    return
  }
  if (error instanceof LocalDirectoryConflictError) {
    jsonError(res, 409, 'DIRECTORY_LOCAL_CONFLICT', error.message)
    return
  }
  logger.warn(fallbackMessage, { error: readErrorMessage(error, 'unknown error') })
  jsonError(res, 500, 'DIRECTORY_LOCAL_INTERNAL_ERROR', fallbackMessage)
}

/**
 * Owner hard requirement: every B2 write endpoint validates its body against a fail-closed field
 * allowlist BEFORE touching any field — `org_id`/`corp_id` (and any other key not in that
 * endpoint's allowlist) make the whole request 400, rather than being silently dropped. Returns
 * true and writes the 400 response if the request should stop here.
 */
function rejectUnlistedFields(req: Request, res: Response, allowedFields: readonly string[]): boolean {
  const allowlist = checkFieldAllowlist(req.body, allowedFields)
  if (allowlist.ok) return false
  jsonError(res, 400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS', 'Request body contains fields not accepted by this endpoint')
  return true
}

/**
 * Owner P2 (review on #4317): a field allowed BY NAME (past `rejectUnlistedFields` above)
 * must still match its declared TYPE, or the whole request 400s here — before ANY field is read
 * out of `req.body` into a service-layer input. This is what stops e.g.
 * `PATCH /departments/:id {parentDepartmentId: 123}` from ever reaching the `typeof x === 'string'
 * ? x : null`-shaped extraction below it, which is what silently coerced a wrong-typed value into
 * the destructive `null` ("clear this field") signal. See `checkFieldTypes`'s doc comment in
 * `local-directory-org-request-schema.ts` for the full nullable-by-design rationale per field.
 */
function rejectInvalidFieldTypes(req: Request, res: Response, specs: readonly LocalDirectoryFieldSpec[]): boolean {
  const result = checkFieldTypes(req.body, specs)
  if (result.ok) return false
  jsonError(res, 400, 'DIRECTORY_LOCAL_INVALID_INPUT', result.message)
  return true
}

function parseMembershipId(raw: string): { accountId: string; departmentId: string } | null {
  const parts = raw.split(':')
  if (parts.length !== 2) return null
  const [accountId, departmentId] = parts
  if (!accountId || !departmentId) return null
  return { accountId, departmentId }
}

export function adminDirectoryLocalRouter(): Router {
  const router = Router()

  // ---- Departments ------------------------------------------------------------------------

  router.post('/departments', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, CREATE_LOCAL_DEPARTMENT_FIELDS)) return
    if (rejectInvalidFieldTypes(req, res, CREATE_LOCAL_DEPARTMENT_FIELD_TYPES)) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name : ''
    const parentDepartmentId = typeof body.parentDepartmentId === 'string' ? body.parentDepartmentId : null
    const orderIndex = typeof body.orderIndex === 'number' ? body.orderIndex : undefined

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      const department = await createLocalDepartment({ orgId, name, parentDepartmentId, orderIndex })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_department.create',
        resourceType: 'directory-department',
        resourceId: department.id,
        meta: {
          integrationId: department.integrationId,
          hasParent: department.parentDepartmentId !== null,
        },
      })
      jsonOk(res, { department })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to create local department')
    }
  })

  router.patch('/departments/:departmentId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, UPDATE_LOCAL_DEPARTMENT_FIELDS)) return
    if (rejectInvalidFieldTypes(req, res, UPDATE_LOCAL_DEPARTMENT_FIELD_TYPES)) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const input: { name?: string; parentDepartmentId?: string | null; orderIndex?: number } = {}
    if (typeof body.name === 'string') input.name = body.name
    if (Object.prototype.hasOwnProperty.call(body, 'parentDepartmentId')) {
      input.parentDepartmentId = body.parentDepartmentId === null ? null : typeof body.parentDepartmentId === 'string' ? body.parentDepartmentId : null
    }
    if (typeof body.orderIndex === 'number') input.orderIndex = body.orderIndex

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      const department = await updateLocalDepartment(orgId, req.params.departmentId, input)
      if (!department) {
        jsonError(res, 404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Local department not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_department.update',
        resourceType: 'directory-department',
        resourceId: department.id,
        meta: {
          integrationId: department.integrationId,
          nameChanged: typeof body.name === 'string',
          parentChanged: Object.prototype.hasOwnProperty.call(body, 'parentDepartmentId'),
          orderChanged: typeof body.orderIndex === 'number',
        },
      })
      jsonOk(res, { department })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to update local department')
    }
  })

  router.post('/departments/:departmentId/archive', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, [])) return

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      const department = await archiveLocalDepartment(orgId, req.params.departmentId)
      if (!department) {
        jsonError(res, 404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Local department not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_department.archive',
        resourceType: 'directory-department',
        resourceId: department.id,
        meta: { integrationId: department.integrationId },
      })
      jsonOk(res, { department })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to archive local department')
    }
  })

  // ---- Accounts -----------------------------------------------------------------------------

  router.post('/accounts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, CREATE_LOCAL_ACCOUNT_FIELDS)) return
    if (rejectInvalidFieldTypes(req, res, CREATE_LOCAL_ACCOUNT_FIELD_TYPES)) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const localUserId = typeof body.localUserId === 'string' ? body.localUserId : ''
    const name = typeof body.name === 'string' ? body.name : undefined
    const email = typeof body.email === 'string' ? body.email : body.email === null ? null : undefined
    const mobile = typeof body.mobile === 'string' ? body.mobile : body.mobile === null ? null : undefined
    const title = typeof body.title === 'string' ? body.title : body.title === null ? null : undefined

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      const account = await createLocalAccount({ orgId, localUserId, name, email, mobile, title })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_account.create',
        resourceType: 'directory-account',
        resourceId: account.id,
        meta: { integrationId: account.integrationId, localUserId: account.localUserId },
      })
      jsonOk(res, { account })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to create local account')
    }
  })

  router.patch('/accounts/:accountId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, UPDATE_LOCAL_ACCOUNT_FIELDS)) return
    if (rejectInvalidFieldTypes(req, res, UPDATE_LOCAL_ACCOUNT_FIELD_TYPES)) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const input: { name?: string; email?: string | null; mobile?: string | null; title?: string | null } = {}
    if (typeof body.name === 'string') input.name = body.name
    if (Object.prototype.hasOwnProperty.call(body, 'email')) input.email = typeof body.email === 'string' ? body.email : null
    if (Object.prototype.hasOwnProperty.call(body, 'mobile')) input.mobile = typeof body.mobile === 'string' ? body.mobile : null
    if (Object.prototype.hasOwnProperty.call(body, 'title')) input.title = typeof body.title === 'string' ? body.title : null

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      const account = await updateLocalAccount(orgId, req.params.accountId, input)
      if (!account) {
        jsonError(res, 404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Local account not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_account.update',
        resourceType: 'directory-account',
        resourceId: account.id,
        meta: {
          integrationId: account.integrationId,
          nameChanged: typeof body.name === 'string',
          emailChanged: Object.prototype.hasOwnProperty.call(body, 'email'),
          mobileChanged: Object.prototype.hasOwnProperty.call(body, 'mobile'),
          titleChanged: Object.prototype.hasOwnProperty.call(body, 'title'),
        },
      })
      jsonOk(res, { account })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to update local account')
    }
  })

  router.post('/accounts/:accountId/archive', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, [])) return

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      const account = await archiveLocalAccount(orgId, req.params.accountId)
      if (!account) {
        jsonError(res, 404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Local account not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_account.archive',
        resourceType: 'directory-account',
        resourceId: account.id,
        meta: { integrationId: account.integrationId },
      })
      jsonOk(res, { account })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to archive local account')
    }
  })

  // ---- Memberships --------------------------------------------------------------------------

  router.post('/memberships', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, ADD_LOCAL_MEMBERSHIP_FIELDS)) return
    if (rejectInvalidFieldTypes(req, res, ADD_LOCAL_MEMBERSHIP_FIELD_TYPES)) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const accountId = typeof body.accountId === 'string' ? body.accountId : ''
    const departmentId = typeof body.departmentId === 'string' ? body.departmentId : ''

    try {
      const orgId = resolveLocalDirectoryOrgId(req)
      if (!accountId || !departmentId) {
        throw new LocalDirectoryValidationError('accountId and departmentId are required')
      }
      const membership = await addLocalMembership({ orgId, accountId, departmentId })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_membership.add',
        resourceType: 'directory-account-department',
        resourceId: `${membership.accountId}:${membership.departmentId}`,
        meta: { accountId: membership.accountId, departmentId: membership.departmentId },
      })
      jsonOk(res, { membership: { id: `${membership.accountId}:${membership.departmentId}`, ...membership } })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to add local membership')
    }
  })

  router.patch('/memberships/:membershipId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, UPDATE_LOCAL_MEMBERSHIP_FIELDS)) return
    if (rejectInvalidFieldTypes(req, res, UPDATE_LOCAL_MEMBERSHIP_FIELD_TYPES)) return

    const parsed = parseMembershipId(req.params.membershipId)
    if (!parsed) {
      jsonError(res, 400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'membershipId must be "<accountId>:<departmentId>"')
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    // This endpoint performs EXACTLY ONE of two mutually-exclusive membership operations per
    // request — the explicit primary-department switch (`isPrimary`) OR the normalized manager-flag
    // set/unset (`isManager`, B3 §5.4). Enforcing the XOR HERE, before any service call, is what
    // makes a combined `{isPrimary, isManager}` (or an empty `{}`) a 400 that can never partially
    // apply: no column is touched on the rejected path.
    const hasPrimary = Object.prototype.hasOwnProperty.call(body, 'isPrimary')
    const hasManager = Object.prototype.hasOwnProperty.call(body, 'isManager')
    if (hasPrimary === hasManager) {
      jsonError(res, 400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'exactly one of isPrimary | isManager is required')
      return
    }

    const orgId = resolveLocalDirectoryOrgId(req)

    if (hasManager) {
      // `isManager` is guaranteed a boolean by rejectInvalidFieldTypes above; both `true` (set the
      // normalized manager flag) and `false` (unset it) are valid operations. The writer is scoped
      // to LOCAL memberships in THIS org — a no-op `{ updated: false }` (missing, non-local,
      // cross-org, or cross-integration membership) becomes a 404, and it emits no cross-scope write.
      const isManager = body.isManager as boolean
      try {
        const result = await setLocalMembershipManager(
          orgId,
          { directoryAccountId: parsed.accountId, directoryDepartmentId: parsed.departmentId },
          isManager,
        )
        if (!result.updated) {
          jsonError(res, 404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Local membership not found')
          return
        }
        await auditLog({
          actorId: adminUserId,
          actorType: 'user',
          action: 'directory.local_membership.set_manager',
          resourceType: 'directory-account-department',
          resourceId: `${parsed.accountId}:${parsed.departmentId}`,
          // Values-free: IDs (references) + the boolean operation flag, no names/PII.
          meta: { accountId: parsed.accountId, departmentId: parsed.departmentId, isManager },
        })
        jsonOk(res, {
          membership: { id: `${parsed.accountId}:${parsed.departmentId}`, accountId: parsed.accountId, departmentId: parsed.departmentId, isManager },
        })
      } catch (error) {
        handleLocalDirectoryError(res, error, 'Failed to set local membership manager flag')
      }
      return
    }

    // Primary-switch branch (unchanged contract): `{isPrimary: true}` is required — `false` or any
    // non-`true` value is rejected rather than guessed at (narrow-endpoint contract, design lock §5.4).
    if (body.isPrimary !== true) {
      jsonError(res, 400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'isPrimary must be true — this endpoint only performs the explicit primary-department switch')
      return
    }

    try {
      const membership = await switchLocalPrimaryDepartment(orgId, parsed.accountId, parsed.departmentId)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.local_membership.switch_primary',
        resourceType: 'directory-account-department',
        resourceId: `${membership.accountId}:${membership.departmentId}`,
        meta: { accountId: membership.accountId, departmentId: membership.departmentId },
      })
      jsonOk(res, { membership: { id: `${membership.accountId}:${membership.departmentId}`, ...membership } })
    } catch (error) {
      handleLocalDirectoryError(res, error, 'Failed to switch local primary department')
    }
  })

  return router
}
