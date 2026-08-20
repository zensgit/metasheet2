import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  decidePunchOrgResolutionV1,
  extractRequestedPunchOrgIdV1,
  extractPunchCallerUserIdV1,
  normalizeOrgIdentifierV1,
} = require('../../../../plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs') as {
  decidePunchOrgResolutionV1: (input: Record<string, unknown>) => Record<string, unknown>
  extractRequestedPunchOrgIdV1: (req: Record<string, unknown>) => string | null
  extractPunchCallerUserIdV1: (req: Record<string, unknown>) => string | null
  normalizeOrgIdentifierV1: (value: unknown) => string | null
}

// Pure-logic coverage for the punch route's membership-derived org resolver
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

  it('resolves the sole active membership when no org is requested', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: null, activeMembershipOrgIds: ['org-a'] }),
    ).toEqual({ ok: true, orgId: 'org-a' })
  })

  it('requires disambiguation when no org is requested and more than one membership exists', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: null, activeMembershipOrgIds: ['org-a', 'org-b'] }),
    ).toEqual({ ok: false, status: 400, code: 'ATTENDANCE_PUNCH_ORG_REQUIRED' })
  })

  it('falls back to the legacy resolver signal when no org is requested and zero memberships exist', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: null, activeMembershipOrgIds: [] }),
    ).toEqual({ ok: true, orgId: null, fallbackToLegacy: true })
  })

  it('treats an empty membership array the same as no memberships (defensive default)', () => {
    expect(
      decidePunchOrgResolutionV1({ requestedOrgId: null, activeMembershipOrgIds: undefined }),
    ).toEqual({ ok: true, orgId: null, fallbackToLegacy: true })
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

  it('returns null when nothing is supplied (leaves rule 3 to decide)', () => {
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
