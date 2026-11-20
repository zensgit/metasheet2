import { describe, expect, it } from 'vitest'
import { isReadOnlyAuthorizationRequest, isReadOnlyPermissionCheckRequest } from '../../src/auth/jwt-middleware'

describe('read-only permission-check global gate selection', () => {
  it('matches only the registered POST route', () => {
    expect(isReadOnlyPermissionCheckRequest('POST', '/api/permissions/v2/business-check')).toBe(true)
    expect(isReadOnlyPermissionCheckRequest('GET', '/api/permissions/v2/business-check')).toBe(false)
    expect(isReadOnlyPermissionCheckRequest('POST', '/api/permissions/v2/business-check/extra')).toBe(false)
    expect(isReadOnlyPermissionCheckRequest('POST', '/api/permissions/check')).toBe(false)
  })
  it('selects the operation POST and every single-segment GET or HEAD receipt path', () => {
    const base = '/api/admin/authorization-operations'
    const id = '12345678-1234-1234-1234-123456789abc'
    expect(isReadOnlyAuthorizationRequest('POST', base)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('POST', `${base}/preview`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('GET', `${base}/${id}`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('GET', `${base}/${id}/`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('GET', `${base}/preview`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('HEAD', `${base}/${id}`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('HEAD', `${base.toUpperCase()}/%31${id.slice(1)}/`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('POST', `${base}/${id}`)).toBe(false)
    expect(isReadOnlyAuthorizationRequest('GET', `${base}/not-a-uuid`)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('GET', `${base}/${id}/extra`)).toBe(false)
    expect(isReadOnlyAuthorizationRequest('HEAD', base)).toBe(false)
    expect(isReadOnlyAuthorizationRequest('POST', `${base}/preview/extra`)).toBe(false)
  })

  it('selects only manual delivery, including Express case and trailing slash variants', () => {
    const base = '/api/admin/invites'
    const path = `${base}/synthetic/manual-delivery`
    expect(isReadOnlyAuthorizationRequest('POST', path)).toBe(true)
    expect(isReadOnlyAuthorizationRequest('POST', path.toUpperCase() + '/')).toBe(true)
    expect(isReadOnlyAuthorizationRequest('GET', path)).toBe(false)
    for (const neighbor of [base, `${base}//manual-delivery`, `${path}/extra`, `${base}/synthetic/resend`, `${base}/synthetic/revoke`]) {
      expect(isReadOnlyAuthorizationRequest('POST', neighbor)).toBe(false)
    }
  })

})
