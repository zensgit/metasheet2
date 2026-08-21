import { createRequire } from 'node:module'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseAttendanceOrgResolutionShadowModeV1,
  decideShadowOrgResolutionV1,
  recordShadowOrgResolutionV1,
  resetShadowWarnThrottleForTestingV1,
  WARN_THROTTLE_WINDOW_MS,
} = require('../../../../plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs') as {
  parseAttendanceOrgResolutionShadowModeV1: (rawValue: string | undefined | null) => 'off' | 'shadow'
  decideShadowOrgResolutionV1: (input: Record<string, unknown>) => Record<string, unknown>
  recordShadowOrgResolutionV1: (
    db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
    req: Record<string, unknown>,
    ctx: Record<string, unknown>,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
  ) => Promise<void>
  resetShadowWarnThrottleForTestingV1: () => void
  WARN_THROTTLE_WINDOW_MS: number
}

// Pure-logic coverage for the shadow audit of the self-service punch route's org resolution
// (plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs). This file proves ONLY
// the decision core, the env parser, and recordShadowOrgResolutionV1's own orchestration
// against fake db/logger doubles — no Express server, no real database. The real-DB route-level
// assertions (the flag actually gating the route, the audit row actually landing, the punch
// response staying unaffected) live in
// packages/core-backend/tests/integration/attendance-org-resolution-shadow.db.test.ts.
describe('attendance org resolution shadow — env tri-state parser', () => {
  it('unset (undefined) resolves to "off"', () => {
    expect(parseAttendanceOrgResolutionShadowModeV1(undefined)).toBe('off')
  })

  it('unset (null) resolves to "off"', () => {
    expect(parseAttendanceOrgResolutionShadowModeV1(null as unknown as undefined)).toBe('off')
  })

  it('blank/whitespace-only resolves to "off"', () => {
    expect(parseAttendanceOrgResolutionShadowModeV1('   ')).toBe('off')
  })

  it('the literal "off" resolves to "off"', () => {
    expect(parseAttendanceOrgResolutionShadowModeV1('off')).toBe('off')
  })

  it('"shadow" resolves to "shadow"', () => {
    expect(parseAttendanceOrgResolutionShadowModeV1('shadow')).toBe('shadow')
  })

  it('"shadow" with surrounding whitespace still resolves to "shadow"', () => {
    expect(parseAttendanceOrgResolutionShadowModeV1('  shadow  ')).toBe('shadow')
  })

  it('"enforce" throws — reserved, not implemented by this build', () => {
    expect(() => parseAttendanceOrgResolutionShadowModeV1('enforce')).toThrow(
      /ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1/,
    )
    expect(() => parseAttendanceOrgResolutionShadowModeV1('enforce')).toThrow(/enforce/)
  })

  it('an unrecognised value throws the same way "enforce" does — enum-strict, no silent fallback to "off"', () => {
    expect(() => parseAttendanceOrgResolutionShadowModeV1('SHADOW')).toThrow(
      /ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1/,
    )
    expect(() => parseAttendanceOrgResolutionShadowModeV1('shadow-mode')).toThrow(
      /ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1/,
    )
    expect(() => parseAttendanceOrgResolutionShadowModeV1('true')).toThrow(
      /ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1/,
    )
  })
})

describe('attendance org resolution shadow — decision core, every rule branch', () => {
  it('rule "request": the request supplied an org — orgChosen is orgLegacy verbatim, regardless of claim/memberships', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: true,
        orgLegacy: 'org-x',
        orgClaim: 'default',
        activeMembershipOrgIds: ['default', 'org-x', 'org-y'],
      }),
    ).toEqual({
      membershipCount: 3,
      nonDefaultMembershipCount: 2,
      orgChosen: 'org-x',
      agree: true,
      rule: 'request',
    })
  })

  it('rule "claim": no request-supplied org, non-default claim — the claim wins even with other memberships present', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'org-x',
        orgClaim: 'org-x',
        activeMembershipOrgIds: ['default', 'org-x', 'org-y'],
      }),
    ).toEqual({
      membershipCount: 3,
      nonDefaultMembershipCount: 2,
      orgChosen: 'org-x',
      agree: true,
      rule: 'claim',
    })
  })

  it('rule "claim": claim is "default" but the caller has NO non-default membership — the claim is trusted (nothing better to prefer)', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: 'default',
        activeMembershipOrgIds: ['default'],
      }),
    ).toEqual({
      membershipCount: 1,
      nonDefaultMembershipCount: 0,
      orgChosen: 'default',
      agree: true,
      rule: 'claim',
    })
  })

  it('THE DISCRIMINATING CASE — claim is "default" but the caller ALSO holds a non-default membership: the claim must NOT win', () => {
    // This is the exact shape the design lock calls out: a pre-existing/backfilled user's
    // token carries the legacy 'default' claim, but the caller has since picked up a real,
    // non-default org membership. Trusting the claim here would silently prefer a placeholder
    // over an actual membership — rule "claim" must be skipped in favour of rule
    // "sole_non_default_membership".
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: 'default',
        activeMembershipOrgIds: ['default', 'org-x'],
      }),
    ).toEqual({
      membershipCount: 2,
      nonDefaultMembershipCount: 1,
      orgChosen: 'org-x',
      agree: false,
      rule: 'sole_non_default_membership',
    })
  })

  it('rule "sole_non_default_membership": no claim at all, exactly one non-default membership', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: null,
        activeMembershipOrgIds: ['default', 'org-x'],
      }),
    ).toEqual({
      membershipCount: 2,
      nonDefaultMembershipCount: 1,
      orgChosen: 'org-x',
      agree: false,
      rule: 'sole_non_default_membership',
    })
  })

  it('rule "legacy_default": no claim, zero memberships at all', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: null,
        activeMembershipOrgIds: [],
      }),
    ).toEqual({
      membershipCount: 0,
      nonDefaultMembershipCount: 0,
      orgChosen: 'default',
      agree: true,
      rule: 'legacy_default',
    })
  })

  it('rule "legacy_default": no claim, sole membership IS the default org itself', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: null,
        activeMembershipOrgIds: ['default'],
      }),
    ).toEqual({
      membershipCount: 1,
      nonDefaultMembershipCount: 0,
      orgChosen: 'default',
      agree: true,
      rule: 'legacy_default',
    })
  })

  it('rule "ambiguous": no claim, two-or-more non-default memberships — refuses to guess (orgChosen is null)', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: null,
        activeMembershipOrgIds: ['org-x', 'org-y'],
      }),
    ).toEqual({
      membershipCount: 2,
      nonDefaultMembershipCount: 2,
      orgChosen: null,
      agree: false,
      rule: 'ambiguous',
    })
  })

  it('rule "ambiguous": claim is "default" AND two-or-more non-default memberships — the claim is refused, and there is no sole membership to fall back to', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'org-x',
        orgClaim: 'default',
        activeMembershipOrgIds: ['default', 'org-x', 'org-y'],
      }),
    ).toEqual({
      membershipCount: 3,
      nonDefaultMembershipCount: 2,
      orgChosen: null,
      agree: false,
      rule: 'ambiguous',
    })
  })

  it('agree computation: agree is a plain equality, not hard-coded per rule — false under rule "claim" when the claim disagrees with orgLegacy', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'org-x',
        orgClaim: 'org-y',
        activeMembershipOrgIds: [],
      }),
    ).toEqual({
      membershipCount: 0,
      nonDefaultMembershipCount: 0,
      orgChosen: 'org-y',
      agree: false,
      rule: 'claim',
    })
  })

  it('agree computation: rule "request" always agrees by construction — orgChosen is orgLegacy verbatim under that rule, never a value that could disagree', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: true,
        orgLegacy: 'org-x',
        orgClaim: 'org-y',
        activeMembershipOrgIds: ['org-x'],
      }),
    ).toEqual({
      membershipCount: 1,
      nonDefaultMembershipCount: 1,
      orgChosen: 'org-x',
      agree: true,
      rule: 'request',
    })
  })

  it('defensive defaults: a non-object/undefined input behaves like all-empty (ambiguous branch through legacy_default, orgLegacy "")', () => {
    expect(decideShadowOrgResolutionV1(undefined as unknown as Record<string, unknown>)).toEqual({
      membershipCount: 0,
      nonDefaultMembershipCount: 0,
      orgChosen: 'default',
      agree: false,
      rule: 'legacy_default',
    })
  })

  it('a non-array activeMembershipOrgIds is treated as empty (defensive default)', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: null,
        activeMembershipOrgIds: undefined,
      }),
    ).toEqual({
      membershipCount: 0,
      nonDefaultMembershipCount: 0,
      orgChosen: 'default',
      agree: true,
      rule: 'legacy_default',
    })
  })

  it('an empty-string orgClaim is treated as no claim (the same "null claim" branches apply)', () => {
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'default',
        orgClaim: '',
        activeMembershipOrgIds: ['default', 'org-x'],
      }),
    ).toEqual({
      membershipCount: 2,
      nonDefaultMembershipCount: 1,
      orgChosen: 'org-x',
      agree: false,
      rule: 'sole_non_default_membership',
    })
  })

  it('orgLegacy is a fully opaque pass-through — this core never re-derives, defaults, or validates it (P2-1: the getOrgId(req)-vs-orgId divergence class can only be introduced at the CALL SITE, never inside this module)', () => {
    // Mirrors the real-DB discriminating shape: whatever the caller passes as orgLegacy is
    // used verbatim, even a value that looks nothing like a real org id (an empty string, the
    // exact shape a getOrgId(req)-style re-derivation bug would wrongly produce when
    // body.orgId="" and an x-org-id header is present — see the module doc comment and
    // tests/integration/attendance-org-resolution-shadow.db.test.ts's dedicated case). This
    // function performs zero validation on it: rule "request" mirrors it verbatim into
    // orgChosen, and `agree` is a plain equality against whatever was passed, correct or not.
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: true,
        orgLegacy: '',
        orgClaim: null,
        activeMembershipOrgIds: ['org-y'],
      }),
    ).toEqual({
      membershipCount: 1,
      nonDefaultMembershipCount: 1,
      orgChosen: '',
      agree: true,
      rule: 'request',
    })

    // Same point, non-request rule: an obviously-wrong orgLegacy does not get "corrected" —
    // agree is computed honestly against it and comes out false.
    expect(
      decideShadowOrgResolutionV1({
        requestOrgSupplied: false,
        orgLegacy: 'not-a-real-org-id',
        orgClaim: null,
        activeMembershipOrgIds: ['org-y'],
      }),
    ).toEqual({
      membershipCount: 1,
      nonDefaultMembershipCount: 1,
      orgChosen: 'org-y',
      agree: false,
      rule: 'sole_non_default_membership',
    })
  })
})

describe('attendance org resolution shadow — recordShadowOrgResolutionV1 orchestration', () => {
  // The module throttles its warn log to at most once per WARN_THROTTLE_WINDOW_MS per
  // process (module-level state) — reset it before every test in this block so each test's
  // own warn-call-count assertions are independent of execution order and of what any
  // earlier test in this file already warned about.
  beforeEach(() => {
    resetShadowWarnThrottleForTestingV1()
  })

  it('loads active memberships for ctx.userId (one query, same user_orgs predicate as the sibling module) and inserts one row', async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        if (/SELECT org_id FROM user_orgs/.test(sql)) {
          return [{ org_id: 'default' }, { org_id: 'org-x' }]
        }
        return []
      },
    }
    const req = { authenticatedTenantId: 'default', body: {}, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' })

    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toMatch(/user_orgs/)
    expect(calls[0].sql).toMatch(/is_active\s*=\s*true/)
    expect(calls[0].params).toEqual(['user-1'])

    expect(calls[1].sql).toMatch(/INSERT INTO attendance_org_resolution_shadow/)
    expect(calls[1].params).toEqual([
      'user-1',
      '/api/attendance/punch',
      'default',
      'default',
      false,
      2,
      1,
      'org-x',
      false,
      'sole_non_default_membership',
    ])
  })

  it('reads org_claim from req.authenticatedTenantId, never req.user.tenantId', () => {
    // (Documented via a direct call: authenticatedTenantId set, user.tenantId set to a
    // DIFFERENT value — the insert must carry the authenticatedTenantId one.)
    return (async () => {
      const calls: Array<unknown[] | undefined> = []
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          calls.push(params)
          if (/SELECT org_id/.test(sql)) return []
          return []
        },
      }
      const req = {
        authenticatedTenantId: 'org-claim-value',
        user: { tenantId: 'org-from-header-backfill' },
        body: {},
        query: {},
        headers: {},
      }
      await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' })
      const insertParams = calls[1] as unknown[]
      expect(insertParams[3]).toBe('org-claim-value')
    })()
  })

  it('request_org_supplied reads the same three sources as the punch route check (body.orgId here)', async () => {
    const calls: Array<unknown[] | undefined> = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push(params)
        if (/SELECT org_id/.test(sql)) return [{ org_id: 'org-x' }]
        return []
      },
    }
    const req = { body: { orgId: 'org-x' }, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'org-x', route: '/api/attendance/punch' })
    const insertParams = calls[1] as unknown[]
    expect(insertParams[4]).toBe(true) // request_org_supplied
    expect(insertParams[9]).toBe('request') // rule
  })

  it('is non-fatal: when the membership query throws, the insert never happens and the function resolves (not rejects)', async () => {
    const warn = vi.fn()
    const db = {
      query: async (sql: string) => {
        if (/SELECT org_id/.test(sql)) {
          throw new Error('boom')
        }
        return []
      },
    }
    const req = { body: {}, query: {}, headers: {} }
    await expect(
      recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('is non-fatal: when the INSERT throws, the function resolves (not rejects) and logs only a code, never a message or values', async () => {
    const warn = vi.fn()
    const db = {
      query: async (sql: string) => {
        if (/SELECT org_id/.test(sql)) return []
        const err = Object.assign(new Error('relation "attendance_org_resolution_shadow" does not exist — secret user value XYZ'), {
          code: '42P01',
        })
        throw err
      },
    }
    const req = { body: {}, query: {}, headers: {} }
    await expect(
      recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(meta).toEqual({ code: '42P01' })
    expect(message).not.toMatch(/secret user value XYZ/)
    expect(JSON.stringify(meta)).not.toMatch(/secret user value XYZ/)
  })

  it('when ctx.userId is missing (null), SKIPS the query entirely (attendance_org_resolution_shadow.user_id is NOT NULL — a doomed INSERT is never attempted) and warns once', async () => {
    const warn = vi.fn()
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return []
      },
    }
    const req = { body: {}, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: null, orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0] as [string]
    expect(message).toMatch(/missing userId/)
  })

  it('when ctx.userId is an empty string, is treated the same as missing (no query, one warn)', async () => {
    const warn = vi.fn()
    const calls: unknown[] = []
    const db = { query: async () => { calls.push(1); return [] } }
    const req = { body: {}, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: '', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('throttles the warn log to at most once per WARN_THROTTLE_WINDOW_MS per process: two failures within the window log once, a third failure after the window elapses logs again', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const db = {
        query: async () => {
          throw Object.assign(new Error('boom'), { code: 'XXTEST' })
        },
      }
      const req = { body: {}, query: {}, headers: {} }
      const ctx = { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }

      await recordShadowOrgResolutionV1(db, req, ctx, { warn })
      expect(warn).toHaveBeenCalledTimes(1)

      // A second failure well within the 60s window: throttled, no second call.
      vi.advanceTimersByTime(1_000)
      await recordShadowOrgResolutionV1(db, req, ctx, { warn })
      expect(warn).toHaveBeenCalledTimes(1)

      // A third failure once the window has fully elapsed: warns again.
      vi.advanceTimersByTime(WARN_THROTTLE_WINDOW_MS)
      await recordShadowOrgResolutionV1(db, req, ctx, { warn })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
