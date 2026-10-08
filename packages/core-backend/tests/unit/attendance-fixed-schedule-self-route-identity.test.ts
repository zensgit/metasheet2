import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  resolveAttendanceFixedScheduleSelfRouteIdentity,
} = require('../../../../plugins/plugin-attendance/lib/attendance-fixed-schedule-self-route-identity.cjs') as {
  resolveAttendanceFixedScheduleSelfRouteIdentity: (input: Record<string, unknown>) => Record<string, unknown>
}

const authenticated = { authenticatedUserId: 'user-a', authenticatedOrgId: 'org-a' }

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveAttendanceFixedScheduleSelfRouteIdentity({
    ...authenticated,
    body: {},
    query: {},
    headers: {},
    ...overrides,
  })
}

describe('attendance fixed-schedule self route identity (#4709 FSER-4 prerequisite, §2)', () => {
  it('accepts an authenticated principal with no selectors at all', () => {
    expect(resolve()).toEqual({ ok: true, userId: 'user-a', orgId: 'org-a' })
  })

  it('401s when no authenticated user id is present, before any org/selector check', () => {
    expect(resolve({ authenticatedUserId: null, authenticatedOrgId: null, body: { userId: 'x' } }))
      .toEqual({ ok: false, status: 401, code: 'UNAUTHORIZED', message: 'User ID not found' })
  })

  it('403s values-free when the authenticated user has no organization', () => {
    const result = resolve({ authenticatedOrgId: null })
    expect(result).toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Authenticated organization not found' })
    expect(JSON.stringify(result)).not.toContain('user-a')
  })

  it.each([
    ['body.userId', { body: { userId: 'user-b' } }],
    ['body.orgId', { body: { orgId: 'org-b' } }],
    ['query.userId', { query: { userId: 'user-b' } }],
    ['query.orgId', { query: { orgId: 'org-b' } }],
    ['body.userId byte-equal to the authenticated subject (still rejected — no selector is accepted, matching or not)', { body: { userId: 'user-a' } }],
    ['query.orgId as an array', { query: { orgId: ['org-b'] } }],
    ['body.userId as an empty string (presence, not truthiness, triggers 400)', { body: { userId: '' } }],
  ])('400s a %s selector before any SQL', (_name, overrides) => {
    const result = resolve(overrides)
    expect(result).toMatchObject({ ok: false, status: 400, code: 'VALIDATION_ERROR' })
  })

  it('tolerates a byte-equal x-user-id/x-org-id header pair (legacy clients that always echo it)', () => {
    expect(resolve({ headers: { 'x-user-id': 'user-a', 'x-org-id': 'org-a' } }))
      .toEqual({ ok: true, userId: 'user-a', orgId: 'org-a' })
  })

  it('403s a mismatched x-user-id header', () => {
    expect(resolve({ headers: { 'x-user-id': 'user-b' } }))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Insufficient permissions' })
  })

  it('403s a mismatched x-org-id header', () => {
    expect(resolve({ headers: { 'x-org-id': 'org-b' } }))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Insufficient permissions' })
  })

  it('403s when any array value in a repeated x-user-id header mismatches', () => {
    expect(resolve({ headers: { 'x-user-id': ['user-a', 'user-b'] } }))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Insufficient permissions' })
  })

  it('never returns the header value as identity even when it happens to be tolerated', () => {
    // Header is byte-equal to the authenticated principal; returned identity must be the
    // authenticated principal object identity's value, not a header-derived copy — this test
    // pins the VALUE, which is the only thing distinguishable at this boundary.
    const result = resolve({ headers: { 'x-user-id': 'user-a' } })
    expect(result).toEqual({ ok: true, userId: 'user-a', orgId: 'org-a' })
  })

  it('mutation proof: removing the header-mismatch check would let a forged x-user-id through as ok:true', () => {
    // This test's OWN job is to fail loudly if resolve({headers:{'x-user-id':'user-b'}}) ever
    // returns ok:true — i.e. it is the negative leg for the header-mismatch predicate.
    const result = resolve({ headers: { 'x-user-id': 'attacker' } })
    expect(result.ok).toBe(false)
  })

  it('does not disclose the rejected body/query value in its message (values-free)', () => {
    const result = resolve({ body: { userId: 'super-secret-user-id' } })
    expect(JSON.stringify(result)).not.toContain('super-secret-user-id')
  })
})
