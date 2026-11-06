/**
 * POST /api/auth/security-actions/verify: re-verification for one security action. Mounted only
 * when SECURITY_ACTION_PROOF_ENABLED is exactly 'true', behind the session gate. Every response is
 * no-store, including the answer to a body that could not be parsed. The password is never echoed,
 * logged or audited, and the organization comes only from the authenticated session.
 */
import type { ErrorRequestHandler, Request, Response } from 'express'
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

/** Body-parser failure types that mean the request body did not satisfy the contract. */
const BODY_INPUT_FAILURE_TYPES: ReadonlySet<string> = new Set([
  'entity.parse.failed', 'entity.too.large', 'entity.verify.failed', 'request.aborted', 'request.size.invalid',
  'charset.unsupported', 'encoding.unsupported', 'stream.encoding.set', 'stream.not.readable', 'parameters.too.many',
])

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

function bodyFailureType(error: unknown): string | null {
  try {
    if (!error || typeof error !== 'object') return null
    const supplied = Object.getOwnPropertyDescriptor(error, 'type')?.value
    return typeof supplied === 'string' ? supplied : null
  } catch {
    return null
  }
}

/**
 * Answers an error raised before the handler ran (a body that could not be parsed, or one outside the
 * accepted size or encoding) with a fixed code under the same contract as every other refusal:
 * no-store, no echo of the body, nothing logged. Anything else is refused as unavailable.
 */
export const securityActionParseErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    if (!res.writableEnded && !res.destroyed) res.destroy()
    return
  }
  noStore(res)
  const type = bodyFailureType(error)
  if (type !== null && BODY_INPUT_FAILURE_TYPES.has(type)) {
    refuse(res, 422, 'SECURITY_ACTION_INVALID_REQUEST', { fields: ['_unknown'] })
    return
  }
  refuse(res, 503, 'SECURITY_ACTION_UNAVAILABLE')
}

/** Null unless SECURITY_ACTION_PROOF_ENABLED is exactly 'true'; the caller then does not mount it. */
export function securityActionsRouter(): Router | null {
  if (!isSecurityActionProofEnabled()) return null
  const router = Router()
  router.post('/verify', (req, res) => {
    verify(req, res).catch(() => {
      // Every path inside verify answers for itself; this is the last resort for a failure before it
      // did. The headers were set by verify's first statement.
      if (res.headersSent) return
      refuse(res, 503, 'SECURITY_ACTION_UNAVAILABLE')
    })
  })
  return router
}
