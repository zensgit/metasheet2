/**
 * POST /api/auth/security-actions/verify: re-verification for one security action. Mounted only
 * when SECURITY_ACTION_PROOF_ENABLED is exactly 'true', behind the session gate. Every response is
 * no-store. The password is never echoed, logged or audited, and the organization comes only from
 * the authenticated session.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { Logger } from '../core/logger'
import { isSecurityActionProofEnabled } from '../auth/security-action-proof-flag'
import {
  issueSecurityActionProof,
  parseSecurityActionVerifyRequest,
  readAuthenticatedSessionContext,
  SecurityActionProofError,
} from '../auth/security-action-proof'

const logger = new Logger('security-actions')

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
}

function refuse(res: Response, status: number, code: string, details?: unknown): void {
  res.status(status).json({ ok: false, error: { code, message: 'Security action refused', details } })
}

async function verify(req: Request, res: Response): Promise<void> {
  noStore(res)
  const session = readAuthenticatedSessionContext(req)
  if (!session) {
    refuse(res, 401, 'SECURITY_ACTION_SESSION_REQUIRED')
    return
  }
  const parsed = parseSecurityActionVerifyRequest(req.body)
  if (parsed.ok !== true) {
    refuse(res, 422, 'SECURITY_ACTION_INVALID_REQUEST', { fields: parsed.fields })
    return
  }
  try {
    const issued = await issueSecurityActionProof(session, parsed.request)
    res.status(200).json({ ok: true, data: issued })
  } catch (error) {
    if (error instanceof SecurityActionProofError) {
      if (error.code === 'SECURITY_ACTION_RATE_LIMITED' && typeof error.details?.retryAfter === 'number') {
        res.setHeader('Retry-After', String(error.details.retryAfter))
      }
      refuse(res, error.status, error.code, error.details)
      return
    }
    // Only the fixed code is logged; never the error text.
    logger.error('security action verification unavailable (code=SECURITY_ACTION_UNAVAILABLE)')
    refuse(res, 503, 'SECURITY_ACTION_UNAVAILABLE')
  }
}

/** Null unless SECURITY_ACTION_PROOF_ENABLED is exactly 'true'; the caller then does not mount it. */
export function securityActionsRouter(): Router | null {
  if (!isSecurityActionProofEnabled()) return null
  const router = Router()
  router.post('/verify', (req, res) => {
    void verify(req, res)
  })
  return router
}
