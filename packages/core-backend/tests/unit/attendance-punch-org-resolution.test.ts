import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  resolvePunchOrgIdV1,
  decidePunchOrgResolutionV1,
  extractRequestedPunchOrgIdV1,
  extractPunchCallerUserIdV1,
  normalizeOrgIdentifierV1,
} = require('../../../../plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs') as {
  resolvePunchOrgIdV1: (
    db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
    req: Record<string, unknown>,
    legacyOrgId: string,
  ) => Promise<Record<string, unknown>>
  decidePunchOrgResolutionV1: (input: Record<string, unknown>) => Record<string, unknown>
  extractRequestedPunchOrgIdV1: (req: Record<string, unknown>) => string | null
  extractPunchCallerUserIdV1: (req: Record<string, unknown>) => string | null
  normalizeOrgIdentifierV1: (value: unknown) => string | null
}

// Pure-logic coverage for the punch route's membership-derived org check
// (plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs). This
// file proves ONLY the decision/extraction logic in isolation, no Express
// req/res, no database — the real-DB route-level assertions (membership
// lookup wiring, actual HTTP outcomes, attendance_records writes) live in
// packages/core-backend/tests/integration/attendance-punch-org-resolution.db.test.ts.
describe('attendance punch org resolution — decision core (self-service punch route)', () => {
  it('permits a requested org that is one of the caller memberships', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'org-a', activeMembershipOrgIds: ['org-a', 'org-b'] }),
    ).toEqual({ ok: true, orgId: 'org-a' })
  })

  it('rejects a requested org that is not one of the caller memberships (positive control: same org set, permitted org)', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'org-c', activeMembershipOrgIds: ['org-a', 'org-b'] }),
    ).toEqual({ ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' })
  })

  it('rejects a requested org when the caller has zero memberships at all — no admin waiver on this route', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'org-c', activeMembershipOrgIds: [] }),
    ).toEqual({ ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' })
  })

  it('treats an empty/missing membership array the same as no memberships (defensive default)', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'org-c', activeMembershipOrgIds: undefined }),
    ).toEqual({ ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' })
  })

  it('a null requestedOrgId is refused too, defensively — the route never calls this with null (see resolvePunchOrgIdV1 below)', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: null, activeMembershipOrgIds: ['org-a'] }),
    ).toEqual({ ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' })
  })

  it('the membership comparison is exact-string, not case-insensitive: a case-differing twin of a real membership is refused', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'org-a', activeMembershipOrgIds: ['Org-A'] }),
    ).toEqual({ ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' })
  })

  it('...and the exact-case string is permitted (positive control for the case above)', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'Org-A', activeMembershipOrgIds: ['Org-A'] }),
    ).toEqual({ ok: true, orgId: 'Org-A' })
  })

  it('a whitespace-differing twin of a real membership is refused (normalization happens before this function, not inside it)', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: 'org-a ', activeMembershipOrgIds: ['org-a'] }),
    ).toEqual({ ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' })
  })
})

describe('attendance punch org resolution — requested-org extraction', () => {
  it('reads body.orgId first', () => {
    expect(
      extractRequestedPunchOrgIdV1({ body: { orgId: 'org-a' }, query: { orgId: 'org-b' }, headers: { 'x-org-id': 'org-c' } }),
    ).toBe('org-a')
  })

  it('falls back to query.orgId when body has none', () => {
    expect(
      extractRequestedPunchOrgIdV1({ body: {}, query: { orgId: 'org-b' }, headers: { 'x-org-id': 'org-c' } }),
    ).toBe('org-b')
  })

  it('falls back to the x-org-id header when body/query have none', () => {
    expect(
      extractRequestedPunchOrgIdV1({ body: {}, query: {}, headers: { 'x-org-id': 'org-c' } }),
    ).toBe('org-c')
  })

  it('returns null when nothing is supplied', () => {
    expect(extractRequestedPunchOrgIdV1({ body: {}, query: {}, headers: {} })).toBeNull()
  })

  it('never reads user.orgId / user.workspaceId as a requested selector (session-derived, not caller-supplied)', () => {
    expect(
      extractRequestedPunchOrgIdV1({
        body: {},
        query: {},
        headers: {},
        user: { orgId: 'org-session', workspaceId: 'org-session-2' },
      } as Record<string, unknown>),
    ).toBeNull()
  })

  it('takes the first value of an array-valued x-org-id header', () => {
    expect(
      extractRequestedPunchOrgIdV1({ body: {}, query: {}, headers: { 'x-org-id': ['org-first', 'org-second'] } }),
    ).toBe('org-first')
  })

  it('trims whitespace and ignores a blank string the same as absent', () => {
    expect(extractRequestedPunchOrgIdV1({ body: { orgId: '  org-a  ' }, query: {}, headers: {} })).toBe('org-a')
    expect(extractRequestedPunchOrgIdV1({ body: { orgId: '   ' }, query: { orgId: 'org-b' }, headers: {} })).toBe('org-b')
  })
})

describe('attendance punch org resolution — caller user id extraction', () => {
  it('reads user.id first', () => {
    expect(extractPunchCallerUserIdV1({ user: { id: 'u-1', sub: 'u-2' }, headers: {} })).toBe('u-1')
  })

  it('falls back through sub, userId, then the x-user-id header', () => {
    expect(extractPunchCallerUserIdV1({ user: {}, headers: { 'x-user-id': 'u-header' } })).toBe('u-header')
  })

  it('returns null when nothing identifies the caller', () => {
    expect(extractPunchCallerUserIdV1({ user: {}, headers: {} })).toBeNull()
  })
})

describe('attendance punch org resolution — value normalization', () => {
  it('trims non-empty strings', () => {
    expect(normalizeOrgIdentifierV1(' org-a ')).toBe('org-a')
  })

  it('coerces a finite number to a string', () => {
    expect(normalizeOrgIdentifierV1(42)).toBe('42')
  })

  it('rejects blank strings, non-finite numbers, and other types', () => {
    expect(normalizeOrgIdentifierV1('   ')).toBeNull()
    expect(normalizeOrgIdentifierV1(Number.NaN)).toBeNull()
    expect(normalizeOrgIdentifierV1(null)).toBeNull()
    expect(normalizeOrgIdentifierV1(undefined)).toBeNull()
    expect(normalizeOrgIdentifierV1({})).toBeNull()
  })
})

describe('attendance punch org resolution — resolvePunchOrgIdV1 (the async orchestration the route calls)', () => {
  it('when the request supplies no org, returns legacyOrgId verbatim and issues NO membership query at all', async () => {
    const throwingDb = {
      query: async () => {
        throw new Error('resolvePunchOrgIdV1 must not query the database when no org was supplied')
      },
    }
    const req = { user: { id: 'user-x' }, body: {}, query: {}, headers: {} }
    await expect(resolvePunchOrgIdV1(throwingDb, req, 'legacy-org-value')).resolves.toEqual({
      ok: true,
      orgId: 'legacy-org-value',
    })
  })

  it('when the request supplies an org, queries active memberships for the caller and permits an exact match', async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return [{ org_id: 'org-a' }, { org_id: 'org-b' }]
      },
    }
    const req = { user: { id: 'user-x' }, body: { orgId: 'org-a' }, query: {}, headers: {} }
    await expect(resolvePunchOrgIdV1(db, req, 'legacy-org-value')).resolves.toEqual({ ok: true, orgId: 'org-a' })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/user_orgs/)
    expect(calls[0].sql).toMatch(/is_active\s*=\s*true/)
    expect(calls[0].params).toEqual(['user-x'])
  })

  it('when the request supplies an org that is not a membership, refuses with 403 (one query, then stop — never reaches legacyOrgId)', async () => {
    const db = { query: async () => [{ org_id: 'org-a' }] }
    const req = { user: { id: 'user-x' }, body: { orgId: 'org-c' }, query: {}, headers: {} }
    await expect(resolvePunchOrgIdV1(db, req, 'legacy-org-value')).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED',
    })
  })
})
