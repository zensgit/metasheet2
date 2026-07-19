/**
 * createApproval bind error mapping — values-free 400 vs 503; no raw host/port/user text.
 * Uses the same catch classification as ApprovalProductService.createApproval.
 */
import { describe, expect, test, vi } from 'vitest'

import { ServiceError } from '../../src/services/ApprovalBridgeService'

/** Mirror of createApproval bind catch — kept local so the unit test pins the contract without DB. */
function mapBindError(bindErr: unknown): ServiceError {
  if (bindErr instanceof RangeError) {
    return new ServiceError('Approval attachment bind rejected', 400, 'APPROVAL_ATTACHMENT_BIND_FAILED')
  }
  return new ServiceError('Approval attachment bind unavailable', 503, 'APPROVAL_ATTACHMENT_BIND_UNAVAILABLE')
}

describe('createApproval attachment bind error mapping (values-free)', () => {
  test('RangeError (validation: foreign/infected/cap) → 400 BIND_FAILED, no raw message in body', () => {
    const err = mapBindError(new RangeError('field fld: only 0/1 attachments bindable — submission rejected'))
    expect(err).toBeInstanceOf(ServiceError)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('APPROVAL_ATTACHMENT_BIND_FAILED')
    expect(err.message).not.toMatch(/bindable|submission rejected/)
    expect(JSON.stringify(err)).not.toMatch(/field fld/)
  })

  test('unknown/DB-like Error → 503 BIND_UNAVAILABLE; raw host/port/user absent', () => {
    const err = mapBindError(new Error('connect ECONNREFUSED 127.0.0.1:5432 user=postgres password=secret'))
    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('APPROVAL_ATTACHMENT_BIND_UNAVAILABLE')
    expect(err.message).toBe('Approval attachment bind unavailable')
    expect(err.message).not.toMatch(/5432|postgres|password|ECONNREFUSED|127\.0\.0\.1/)
    expect(JSON.stringify({ code: err.code, message: err.message })).not.toMatch(/5432|postgres|secret/)
  })

  test('source createApproval catch uses RangeError discrimination (mutation: swap would RED)', async () => {
    // Load the service source and pin the classification tokens exist (load-bearing guard).
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/ApprovalProductService.ts'),
      'utf8',
    )
    expect(src).toMatch(/bindErr instanceof RangeError/)
    expect(src).toMatch(/APPROVAL_ATTACHMENT_BIND_FAILED/)
    expect(src).toMatch(/APPROVAL_ATTACHMENT_BIND_UNAVAILABLE/)
    expect(src).toMatch(/statusCode:\s*503|503,\s*\n\s*'APPROVAL_ATTACHMENT_BIND_UNAVAILABLE'/)
    // Must NOT re-embed bindErr.message into ServiceError details
    expect(src).not.toMatch(/reason:\s*bindErr\.message/)
    expect(src).not.toMatch(/bindErr\.message\.replace/)
  })
})
