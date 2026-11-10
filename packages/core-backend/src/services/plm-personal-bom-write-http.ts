import type { Request } from 'express'
import jwt from 'jsonwebtoken'
import type { PlmPersonalBomWriteBindingService } from './PlmPersonalBomWriteBindingService'
import {
  PlmPersonalBomWriteError,
  type PersonalBomWriteActor,
} from './plm-personal-bom-write-wire'

let bound: PlmPersonalBomWriteBindingService | undefined

export function bindPlmPersonalBomWriteService(service: PlmPersonalBomWriteBindingService | undefined): void {
  bound = service
}

export function plmPersonalBomWriteService(): PlmPersonalBomWriteBindingService {
  if (!bound) throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE')
  return bound
}

export function authenticatedOwnerId(req: Request): string | undefined {
  const user = req.user
  const raw = user?.id ?? user?.userId ?? user?.sub
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  return text.length > 0 ? text : undefined
}

function boundTenant(req: Request): string {
  return typeof req.authenticatedTenantId === 'string' ? req.authenticatedTenantId.trim() : ''
}

/**
 * Meta actor for list, bind, management URL, and write.
 * Explicit null is only a genuinely absent verified claim with no authenticated tenant.
 * Rejected, blank, malformed, and missing provenance cannot downgrade to null.
 * `req.user.tenantId`, headers, and the body are not a tenant source.
 */
export function personalBomWriteActor(req: Request): PersonalBomWriteActor {
  const userId = authenticatedOwnerId(req)
  if (!userId || req.apiTokenId) throw new PlmPersonalBomWriteError(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
  const claim = req.verifiedTenantClaim
  if (!claim) throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
  if (claim.kind === 'absent') {
    if (boundTenant(req)) throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
    return { userId, metaTenantId: null }
  }
  if (claim.kind === 'present') {
    const tenant = boundTenant(req)
    if (!tenant || tenant !== claim.value) throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
    return { userId, metaTenantId: tenant }
  }
  throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
}

/** Owner id for unbind and retired-revoke retry. Membership and the enable flag are not consulted. */
export function personalBomWriteOwnerId(req: Request): string {
  const userId = authenticatedOwnerId(req)
  if (!userId || req.apiTokenId) throw new PlmPersonalBomWriteError(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
  return userId
}

const LINE_NATIVE_409 = new Set(['lifecycle_locked', 'idempotency_conflict'])
const ECO_NATIVE_409 = new Set(['not_locked', 'eco_intent_rejected'])
const DEFINITE_STATUS = [400, 401, 403, 404, 422]

export interface PersonalBomWriteRelay {
  status: number
  reason: string
  outcome: 'accepted' | 'refused' | 'unknown' | 'conflict'
  code: string
  /** Set only for a received native 401 or 403. This attempt was refused. */
  attemptOutcome?: 'refused'
  /**
   * Conservative. A native 401 or 403 does not prove the logical operation had no effect:
   * an earlier response may have been lost, or Meta may have crashed after native commit.
   * Local unknown and confirmation markers are not consulted.
   */
  operationMayHaveApplied?: true
  /** Caller repeats the same frozen key, body, and If-Match. Not an immediate server retry. */
  retryPolicy?: 'same-operation'
}

export function relayPersonalBomWriteFailure(
  error: unknown,
  kind: 'line' | 'eco-intent',
): PersonalBomWriteRelay {
  const fallbackCode = kind === 'line' ? 'PLM_BOM_WRITEBACK_FAILED' : 'PLM_ECO_INTENT_FAILED'
  if (!(error instanceof PlmPersonalBomWriteError)) {
    return { status: 503, reason: 'unknown', outcome: 'unknown', code: fallbackCode }
  }
  if (error.received) {
    if (error.status === 401 || error.status === 403) {
      return {
        status: error.status,
        reason: 'provider-rejected',
        outcome: 'refused',
        code: fallbackCode,
        attemptOutcome: 'refused',
        operationMayHaveApplied: true,
        retryPolicy: 'same-operation',
      }
    }
    if (error.status === 412) {
      return { status: 412, reason: 'precondition-failed', outcome: 'refused', code: fallbackCode }
    }
    if (error.status === 409) {
      const allow = kind === 'line' ? LINE_NATIVE_409 : ECO_NATIVE_409
      const nativeCode = error.detail?.code
      if (nativeCode && allow.has(nativeCode)) {
        return { status: 409, reason: nativeCode, outcome: 'refused', code: fallbackCode }
      }
      return { status: 503, reason: 'unknown', outcome: 'unknown', code: fallbackCode }
    }
    if (DEFINITE_STATUS.includes(error.status)) {
      return { status: error.status, reason: 'provider-rejected', outcome: 'refused', code: fallbackCode }
    }
    return { status: 503, reason: 'unknown', outcome: 'unknown', code: fallbackCode }
  }
  if (error.status === 409) {
    return { status: 409, reason: 'frozen-context', outcome: 'conflict', code: error.code }
  }
  if (DEFINITE_STATUS.includes(error.status)) {
    return { status: error.status, reason: error.code, outcome: 'refused', code: error.code }
  }
  return { status: 503, reason: 'unknown', outcome: 'unknown', code: fallbackCode }
}

/** Public line/ECO failure JSON. A native 401 or 403 adds the conservative retry contract and no prior receipt. */
export function personalBomWriteFailureBody(
  message: string,
  dataSourceId: string,
  relayed: PersonalBomWriteRelay,
): {
  error: string
  code: string
  data_source_id: string
  reason: string
  attempt_outcome?: 'refused'
  operation_may_have_applied?: true
  retry_policy?: 'same-operation'
} {
  const body = {
    error: message,
    code: relayed.code,
    data_source_id: dataSourceId,
    reason: relayed.reason,
  }
  if (relayed.attemptOutcome !== 'refused') return body
  return {
    ...body,
    attempt_outcome: 'refused',
    operation_may_have_applied: true,
    retry_policy: 'same-operation',
  }
}

/**
 * Reject API and purpose credentials.
 * jwt.decode is used only to reject a purpose family (type, typ, or aud).
 * The tenant is never read from that decode.
 */
export function rejectPersonalBomWriteCredential(req: Request): boolean {
  const header = req.headers.authorization
  const value = typeof header === 'string' ? header : ''
  const payload = jwt.decode(value.slice(7))
  const purposeBound =
    !payload ||
    typeof payload !== 'object' ||
    ['type', 'typ', 'aud'].some((key) => Object.hasOwn(payload, key))
  return (
    purposeBound ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
    Boolean(req.apiTokenId)
  )
}
