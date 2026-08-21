import { createRequire } from 'node:module'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseAttendanceOrgResolutionShadowModeV1,
  decideShadowOrgResolutionV1,
  recordShadowOrgResolutionV1,
  resetShadowWarnThrottleForTestingV1,
  whenIdleForTestingV1,
  resetShadowInFlightForTestingV1,
  getShadowMetricsSnapshotV1,
  getShadowMetricsSnapshotForTestingV1,
  resetShadowMetricsForTestingV1,
  startShadowMetricsLoggingV1,
  getShadowMetricsLoggingActiveCountForTestingV1,
  logShadowMetricsSnapshotV1,
  WARN_THROTTLE_WINDOW_MS,
  SHADOW_STATEMENT_TIMEOUT_MS,
  RECORD_TIMEOUT_MS,
  IN_FLIGHT_CAP,
} = require('../../../../plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs') as {
  parseAttendanceOrgResolutionShadowModeV1: (rawValue: string | undefined | null) => 'off' | 'shadow'
  decideShadowOrgResolutionV1: (input: Record<string, unknown>) => Record<string, unknown>
  recordShadowOrgResolutionV1: (
    db: { transaction: (cb: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<void>) => Promise<void> },
    req: Record<string, unknown>,
    ctx: Record<string, unknown>,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
  ) => Promise<void>
  resetShadowWarnThrottleForTestingV1: () => void
  whenIdleForTestingV1: () => Promise<void>
  resetShadowInFlightForTestingV1: () => void
  getShadowMetricsSnapshotV1: () => { attempted: number; written: number; abandoned: number; dropped: number; failed: number }
  getShadowMetricsSnapshotForTestingV1: () => { attempted: number; written: number; abandoned: number; dropped: number; failed: number }
  resetShadowMetricsForTestingV1: () => void
  startShadowMetricsLoggingV1: (logger?: { info?: (message: string, meta?: Record<string, unknown>) => void }, intervalMs?: number) => () => void
  getShadowMetricsLoggingActiveCountForTestingV1: () => number
  logShadowMetricsSnapshotV1: (logger?: { info?: (message: string, meta?: Record<string, unknown>) => void }) => void
  WARN_THROTTLE_WINDOW_MS: number
  SHADOW_STATEMENT_TIMEOUT_MS: number
  RECORD_TIMEOUT_MS: number
  IN_FLIGHT_CAP: number
}

// A fake `db` that mirrors the real `DatabaseAPI.transaction` contract
// (packages/core-backend/src/types/plugin.ts / packages/core-backend/src/index.ts's
// `database:` block): `transaction(cb)` hands the callback a `trx` whose `.query` returns rows
// directly (not a `{rows}` wrapper) — exactly like `context.api.database.transaction` does.
// `queryImpl` receives every statement issued inside the transaction, in order, including the
// module's own `SET LOCAL statement_timeout` statement.
function fakeTransactionalDb(queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]>) {
  return {
    transaction: async (cb: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<void>) =>
      cb({ query: queryImpl }),
  }
}

// Pure-logic coverage for the shadow audit of the self-service punch route's org resolution
// (plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs). This file proves ONLY
// the decision core, the env parser, and recordShadowOrgResolutionV1's own orchestration
// (scheduling, timeout, in-flight cap, metrics) against fake db/logger doubles — no Express
// server, no real database. The real-DB route-level assertions (the flag actually gating the
// route, the audit row actually landing, the punch response staying unaffected while the
// recorder's own query is still pending) live in
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
  // earlier test in this file already warned about. Metrics are the same shape of
  // module-level state and get the same treatment.
  beforeEach(() => {
    resetShadowWarnThrottleForTestingV1()
    resetShadowMetricsForTestingV1()
    // Several tests below (the timeout leg, the cap tests) deliberately leave recorder work
    // permanently pending via a never-resolving mock db — without this, inFlightCount would
    // leak an elevated baseline into every later test in this file.
    resetShadowInFlightForTestingV1()
  })

  it('issues SET LOCAL statement_timeout first, then loads active memberships for ctx.userId (same user_orgs predicate as the sibling module), then inserts one row — all inside one transaction', async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const db = fakeTransactionalDb(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (/SELECT org_id FROM user_orgs/.test(sql)) {
        return [{ org_id: 'default' }, { org_id: 'org-x' }]
      }
      return []
    })
    const req = { authenticatedTenantId: 'default', body: {}, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' })

    expect(calls).toHaveLength(3)
    expect(calls[0].sql).toMatch(/^SET LOCAL statement_timeout/)
    expect(calls[0].sql).toContain(`${SHADOW_STATEMENT_TIMEOUT_MS}ms`)

    expect(calls[1].sql).toMatch(/user_orgs/)
    expect(calls[1].sql).toMatch(/is_active\s*=\s*true/)
    expect(calls[1].params).toEqual(['user-1'])

    expect(calls[2].sql).toMatch(/INSERT INTO attendance_org_resolution_shadow/)
    expect(calls[2].params).toEqual([
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

    expect(getShadowMetricsSnapshotForTestingV1()).toEqual({ attempted: 1, written: 1, abandoned: 0, dropped: 0, failed: 0 })
  })

  it('reads org_claim from req.authenticatedTenantId, never req.user.tenantId', () => {
    // (Documented via a direct call: authenticatedTenantId set, user.tenantId set to a
    // DIFFERENT value — the insert must carry the authenticatedTenantId one.)
    return (async () => {
      const calls: Array<unknown[] | undefined> = []
      const db = fakeTransactionalDb(async (sql: string, params?: unknown[]) => {
        calls.push(params)
        if (/SELECT org_id/.test(sql)) return []
        return []
      })
      const req = {
        authenticatedTenantId: 'org-claim-value',
        user: { tenantId: 'org-from-header-backfill' },
        body: {},
        query: {},
        headers: {},
      }
      await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' })
      const insertParams = calls[2] as unknown[]
      expect(insertParams[3]).toBe('org-claim-value')
    })()
  })

  it('request_org_supplied reads the same three sources as the punch route check (body.orgId here)', async () => {
    const calls: Array<unknown[] | undefined> = []
    const db = fakeTransactionalDb(async (sql: string, params?: unknown[]) => {
      calls.push(params)
      if (/SELECT org_id/.test(sql)) return [{ org_id: 'org-x' }]
      return []
    })
    const req = { body: { orgId: 'org-x' }, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'org-x', route: '/api/attendance/punch' })
    const insertParams = calls[2] as unknown[]
    expect(insertParams[4]).toBe(true) // request_org_supplied
    expect(insertParams[9]).toBe('request') // rule
  })

  it('is non-fatal: when the membership query throws, the insert never happens and the function resolves (not rejects); metrics count it as failed', async () => {
    const warn = vi.fn()
    const db = fakeTransactionalDb(async (sql: string) => {
      if (/SELECT org_id/.test(sql)) {
        throw new Error('boom')
      }
      return []
    })
    const req = { body: {}, query: {}, headers: {} }
    await expect(
      recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(getShadowMetricsSnapshotForTestingV1()).toEqual({ attempted: 1, written: 0, abandoned: 0, dropped: 0, failed: 1 })
  })

  it('is non-fatal: when the INSERT throws, the function resolves (not rejects) and logs only a code, never a message or values', async () => {
    const warn = vi.fn()
    const db = fakeTransactionalDb(async (sql: string) => {
      if (/SELECT org_id/.test(sql)) return []
      if (/^SET LOCAL/.test(sql)) return []
      const err = Object.assign(new Error('relation "attendance_org_resolution_shadow" does not exist — secret user value XYZ'), {
        code: '42P01',
      })
      throw err
    })
    const req = { body: {}, query: {}, headers: {} }
    await expect(
      recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(meta).toEqual({ code: '42P01' })
    expect(message).not.toMatch(/secret user value XYZ/)
    expect(JSON.stringify(meta)).not.toMatch(/secret user value XYZ/)
    expect(getShadowMetricsSnapshotForTestingV1().failed).toBe(1)
  })

  it('when ctx.userId is missing (null), SKIPS the transaction entirely (attendance_org_resolution_shadow.user_id is NOT NULL — a doomed INSERT is never attempted) and warns once; counted as failed', async () => {
    const warn = vi.fn()
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const db = fakeTransactionalDb(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return []
    })
    const req = { body: {}, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: null, orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0] as [string]
    expect(message).toMatch(/missing userId/)
    expect(getShadowMetricsSnapshotForTestingV1()).toEqual({ attempted: 1, written: 0, abandoned: 0, dropped: 0, failed: 1 })
  })

  it('when ctx.userId is an empty string, is treated the same as missing (no query, one warn)', async () => {
    const warn = vi.fn()
    const calls: unknown[] = []
    const db = fakeTransactionalDb(async () => { calls.push(1); return [] })
    const req = { body: {}, query: {}, headers: {} }
    await recordShadowOrgResolutionV1(db, req, { userId: '', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('throttles the warn log to at most once per WARN_THROTTLE_WINDOW_MS per process: two failures within the window log once, a third failure after the window elapses logs again', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const db = fakeTransactionalDb(async () => {
        throw Object.assign(new Error('boom'), { code: 'XXTEST' })
      })
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

  it('P3-4 (#5073 round-2 gate): the "dropped" (in-flight cap reached) warn has its OWN 60s throttle clock, separate from the failure warn — a failure and a drop in the SAME window each log once, neither starves the other', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const req = { body: {}, query: {}, headers: {} }

      // First: a FAILURE warns once (consumes the 'default' channel's throttle window).
      const failingDb = fakeTransactionalDb(async () => {
        throw Object.assign(new Error('boom'), { code: 'XXTEST' })
      })
      await recordShadowOrgResolutionV1(failingDb, req, { userId: 'user-fail', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
      expect(warn).toHaveBeenCalledTimes(1)

      // A second failure in the SAME window: throttled on the 'default' channel (unaffected by
      // the drop channel below) — no new call yet.
      await recordShadowOrgResolutionV1(failingDb, req, { userId: 'user-fail-2', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
      expect(warn).toHaveBeenCalledTimes(1)

      // Fill the cap with permanently-pending recorders so the NEXT call is dropped.
      const heldDb = fakeTransactionalDb(() => new Promise(() => {}))
      for (let i = 0; i < IN_FLIGHT_CAP; i += 1) {
        void recordShadowOrgResolutionV1(heldDb, req, { userId: `cap-user-${i}`, orgLegacy: 'default', route: '/api/attendance/punch' }, { warn }).catch(() => {})
      }
      await Promise.resolve()
      await Promise.resolve()

      // The drop, in the SAME window as the two failures above: must warn — the 'dropped'
      // channel has its own clock, so it is NOT throttled by the failure warns that already
      // consumed the 'default' channel's window.
      await recordShadowOrgResolutionV1(heldDb, req, { userId: 'user-dropped', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[1][1]).toEqual({ reason: 'cap_exceeded' })

      // A second drop in the same window: throttled on the 'dropped' channel itself.
      await recordShadowOrgResolutionV1(heldDb, req, { userId: 'user-dropped-2', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('the fire-and-forget scheduling contract', () => {
    it('the call-site pattern (void fn().catch(() => {})) lets code after it run immediately, before the recorder\'s underlying INSERT has happened; whenIdleForTestingV1() deterministically waits for it', async () => {
      // Reproduces the exact call-site shape from plugins/plugin-attendance/index.cjs: the
      // caller never awaits recordShadowOrgResolutionV1 — it only attaches a swallowing catch.
      // NOTE: this tracks the underlying INSERT directly, not recordShadowOrgResolutionV1's own
      // returned promise — that promise settles via Promise.race + an extra `finally` hop
      // AFTER the underlying work (and after whenIdleForTestingV1's own bookkeeping, which is
      // attached to the underlying work directly), so the two are not guaranteed to resolve in
      // the same microtask tick. whenIdleForTestingV1's actual job — see the module doc
      // comment — is to let a test know the DB WORK is done, which is exactly what this test
      // (and the db-suite's row assertions) need.
      let insertHappened = false
      const db = fakeTransactionalDb(async (sql: string) => {
        if (/SELECT org_id/.test(sql)) return []
        if (/^INSERT INTO/.test(sql)) insertHappened = true
        return []
      })
      const req = { body: {}, query: {}, headers: {} }
      void recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }).catch(() => {})

      // "The response" — code that must run without waiting on the recorder.
      const responseSent = true
      expect(responseSent).toBe(true)
      // At this exact synchronous point the INSERT cannot have happened yet — not awaited.
      expect(insertHappened).toBe(false)

      await whenIdleForTestingV1()
      expect(insertHappened).toBe(true)
    })
  })

  describe('the RECORD_TIMEOUT_MS observability backstop (NOT a resource bound — #5073 round-2 gate P2-2)', () => {
    it('a never-resolving db call makes recordShadowOrgResolutionV1 itself resolve at the timeout, warns once with the distinct "abandoned" reason (mentioning RECORD_TIMEOUT_MS\'s own value, not a hardcoded literal), and counts it as abandoned — the underlying work is still pending afterward', async () => {
      vi.useFakeTimers()
      try {
        const warn = vi.fn()
        let selectCalled = false
        const db = fakeTransactionalDb((sql: string) => {
          if (/SELECT org_id/.test(sql)) {
            selectCalled = true
            return new Promise(() => {}) // never resolves
          }
          return Promise.resolve([])
        })
        const req = { body: {}, query: {}, headers: {} }

        const p = recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })

        // Advance past RECORD_TIMEOUT_MS but not so far as to be meaningless; flush the timer
        // callback's own microtasks too.
        await vi.advanceTimersByTimeAsync(RECORD_TIMEOUT_MS)

        await expect(p).resolves.toBeUndefined()
        expect(selectCalled).toBe(true)
        expect(warn).toHaveBeenCalledTimes(1)
        const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>]
        // NIT-2: derive the expected figure from the constant, not a hardcoded literal — a test
        // that hardcodes '5000ms' stays green even if the message drifts from RECORD_TIMEOUT_MS.
        expect(message).toMatch(new RegExp(`${RECORD_TIMEOUT_MS}ms`))
        expect(message).toMatch(/observability signal only/i)
        expect(meta).toEqual({ reason: 'abandoned' })
        expect(getShadowMetricsSnapshotForTestingV1()).toEqual({ attempted: 1, written: 0, abandoned: 1, dropped: 0, failed: 0 })

        // The underlying work is documented to keep running in the background — whenIdle must
        // NOT have resolved yet (the never-resolving SELECT is still "in flight").
        let idleResolved = false
        whenIdleForTestingV1().then(() => { idleResolved = true })
        await Promise.resolve()
        expect(idleResolved).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('LATE SETTLE (P2-1 / #5073 round-2 gate PROBE C): when the raced-away work settles AFTER the "abandoned" bucket was already recorded, it must NOT also increment written/failed — attempted must stay equal to the sum of the four terminal buckets. Mutation: deleting the `if (terminalRecorded) return` guard reds this (the guard is otherwise invisible to the whole suite — every OTHER timeout-leg test uses a permanently-pending mock, so the late-settle interleaving this guard exists for is never constructed without this test).', async () => {
      vi.useFakeTimers()
      try {
        const warn = vi.fn()
        // A CONTROLLABLE deferred, unlike the sibling test's permanently-pending mock: held
        // until released explicitly, AFTER the race has already fired.
        let releaseSelect: (() => void) | undefined
        const selectDeferred = new Promise<unknown[]>((resolve) => { releaseSelect = () => resolve([]) })
        const db = fakeTransactionalDb((sql: string) => {
          if (/SELECT org_id/.test(sql)) return selectDeferred
          return Promise.resolve([])
        })
        const req = { body: {}, query: {}, headers: {} }

        const p = recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })

        // Cross the race boundary: recordShadowOrgResolutionV1's own promise resolves,
        // 'abandoned' is recorded, while the underlying SELECT is STILL held.
        await vi.advanceTimersByTimeAsync(RECORD_TIMEOUT_MS)
        await expect(p).resolves.toBeUndefined()
        expect(getShadowMetricsSnapshotForTestingV1()).toEqual({ attempted: 1, written: 0, abandoned: 1, dropped: 0, failed: 0 })

        // NOW let the raced-away work actually finish — the exact interleaving the exactly-once
        // guard exists for. This must NOT double-count into `written`.
        releaseSelect?.()
        await whenIdleForTestingV1()

        const after = getShadowMetricsSnapshotForTestingV1()
        expect(after).toEqual({ attempted: 1, written: 0, abandoned: 1, dropped: 0, failed: 0 })
        const sumOfTerminalBuckets = after.written + after.abandoned + after.dropped + after.failed
        expect(sumOfTerminalBuckets).toBe(after.attempted)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the in-flight cap (IN_FLIGHT_CAP)', () => {
    it(`at the cap, the next call is DROPPED before any query is attempted, counted in metrics, and does not increment in-flight state`, async () => {
      // Fake timers so the IN_FLIGHT_CAP held recorders' own RECORD_TIMEOUT_MS backstops never
      // actually fire mid-test (or worse, later — during a DIFFERENT test — since these are
      // real 5s timers that would otherwise keep running in the background). vi.useRealTimers()
      // at the end discards any still-pending fake timers without firing them.
      vi.useFakeTimers()
      try {
        const warn = vi.fn()
        const releases: Array<() => void> = []
        const db = fakeTransactionalDb(() => new Promise((resolve) => { releases.push(() => resolve([])) }))
        const req = { body: {}, query: {}, headers: {} }
        const ctx = (n: number) => ({ userId: `user-${n}`, orgLegacy: 'default', route: '/api/attendance/punch' })

        // Fill the cap with in-flight (never-yet-resolved) recorders.
        for (let i = 0; i < IN_FLIGHT_CAP; i += 1) {
          void recordShadowOrgResolutionV1(db, req, ctx(i), { warn }).catch(() => {})
        }
        // Let each one reach its pending DB call before the cap-exceeding attempt.
        await Promise.resolve()
        await Promise.resolve()

        // One more, over the cap: must be dropped immediately (no new pending query registered).
        const releasesBeforeDrop = releases.length
        await recordShadowOrgResolutionV1(db, req, ctx(IN_FLIGHT_CAP), { warn })
        expect(releases.length).toBe(releasesBeforeDrop) // no new query attempted

        const metrics = getShadowMetricsSnapshotForTestingV1()
        expect(metrics.attempted).toBe(IN_FLIGHT_CAP + 1)
        expect(metrics.dropped).toBe(1)
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped/), { reason: 'cap_exceeded' })
      } finally {
        // Discards the IN_FLIGHT_CAP still-pending fake timers without firing them.
        // resetShadowInFlightForTestingV1() in this describe block's beforeEach forcibly
        // zeroes inFlightCount before the NEXT test runs, independent of these now-orphaned
        // promises (each held recorder's mock re-blocks on its own NEXT query in the same
        // transaction — SET LOCAL -> SELECT -> INSERT — so they were never going to settle on
        // their own without draining in a loop; not needed here).
        vi.useRealTimers()
      }
    })

    it('a dropped sample never registers as in-flight: with the cap already full of permanently-pending work, whenIdleForTestingV1() still only waits on the CAP-holders, and the dropped call itself resolves immediately (no query, no transaction)', async () => {
      // Fake timers for the same reason as the previous test: the IN_FLIGHT_CAP holders' own
      // RECORD_TIMEOUT_MS backstops must not fire as real 5s timers that could bleed into a
      // later test. vi.useRealTimers() discards them unfired.
      vi.useFakeTimers()
      try {
        const warn = vi.fn()
        const hold = new Promise(() => {}) // one permanently-pending recorder occupies the cap
        const dbHeld = fakeTransactionalDb(() => hold)
        const req = { body: {}, query: {}, headers: {} }
        for (let i = 0; i < IN_FLIGHT_CAP; i += 1) {
          void recordShadowOrgResolutionV1(dbHeld, req, { userId: `cap-user-${i}`, orgLegacy: 'default', route: '/api/attendance/punch' }, { warn }).catch(() => {})
        }
        await Promise.resolve()
        await Promise.resolve()

        let dbDroppedTouched = false
        const dbDropped = { transaction: async (cb: (trx: unknown) => Promise<void>) => { dbDroppedTouched = true; return cb({}) } }
        // The dropped call itself resolves right away — it never even calls db.transaction.
        await recordShadowOrgResolutionV1(dbDropped as any, req, { userId: 'dropped-user', orgLegacy: 'default', route: '/api/attendance/punch' }, { warn })
        expect(dbDroppedTouched).toBe(false)
        expect(getShadowMetricsSnapshotForTestingV1().dropped).toBe(1)

        // whenIdleForTestingV1() is still governed ONLY by the CAP-holding (never-settling)
        // recorders — the dropped call contributed nothing to in-flight state, so it cannot be
        // what's keeping this pending.
        let idleResolved = false
        whenIdleForTestingV1().then(() => { idleResolved = true })
        await Promise.resolve()
        expect(idleResolved).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('unhandled-rejection guard', () => {
    it('an artificial rejection from the module\'s outermost promise is swallowed by the call-site .catch pattern — zero unhandled rejections', async () => {
      const unhandled: unknown[] = []
      const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandledRejection)
      try {
        // Force recordShadowOrgResolutionV1's own internal Promise.race to reject — simulating
        // "the module's outermost promise rejects" (an unexpected shape performShadowRecordV1's
        // own try/catch was not designed to produce, but the call site must survive anyway).
        const raceSpy = vi.spyOn(Promise, 'race').mockImplementationOnce(() => Promise.reject(new Error('artificial module failure')))
        const db = fakeTransactionalDb(async () => [])
        const req = { body: {}, query: {}, headers: {} }
        // Exact call-site pattern from plugins/plugin-attendance/index.cjs.
        void recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' }).catch(() => {})
        raceSpy.mockRestore()
        // Drain the microtask/macrotask queue so a would-be unhandled rejection would have
        // surfaced by now.
        await new Promise((resolve) => setImmediate(resolve))
        await new Promise((resolve) => setImmediate(resolve))
      } finally {
        process.off('unhandledRejection', onUnhandledRejection)
      }
      expect(unhandled).toHaveLength(0)
    })
  })

  describe('metrics snapshot + periodic logging', () => {
    it('getShadowMetricsSnapshotForTestingV1 returns a copy, not a live reference', async () => {
      const snapshot = getShadowMetricsSnapshotForTestingV1()
      snapshot.attempted = 999
      expect(getShadowMetricsSnapshotForTestingV1().attempted).toBe(0)
    })

    it('NIT-1 (#5073 round-2 gate): getShadowMetricsSnapshotV1 (the production-named entry point) and getShadowMetricsSnapshotForTestingV1 (the test-only alias) are the SAME function, not two implementations that could drift', async () => {
      expect(getShadowMetricsSnapshotForTestingV1).toBe(getShadowMetricsSnapshotV1)
      const db = fakeTransactionalDb(async (sql: string) => (/SELECT org_id/.test(sql) ? [] : []))
      const req = { body: {}, query: {}, headers: {} }
      await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' })
      expect(getShadowMetricsSnapshotV1()).toEqual(getShadowMetricsSnapshotForTestingV1())
    })

    it('logShadowMetricsSnapshotV1 logs the current counters at info, values-free (counts only)', async () => {
      const db = fakeTransactionalDb(async (sql: string) => (/SELECT org_id/.test(sql) ? [] : []))
      const req = { body: {}, query: {}, headers: {} }
      await recordShadowOrgResolutionV1(db, req, { userId: 'user-1', orgLegacy: 'default', route: '/api/attendance/punch' })

      const info = vi.fn()
      logShadowMetricsSnapshotV1({ info })
      expect(info).toHaveBeenCalledTimes(1)
      const [message, meta] = info.mock.calls[0] as [string, Record<string, unknown>]
      expect(message).toMatch(/metrics snapshot/)
      expect(meta).toEqual({ attempted: 1, written: 1, abandoned: 0, dropped: 0, failed: 0 })
    })

    it('startShadowMetricsLoggingV1 logs on the given interval until its stop function is called', async () => {
      vi.useFakeTimers()
      try {
        const info = vi.fn()
        const stop = startShadowMetricsLoggingV1({ info }, 1000)
        expect(info).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1000)
        expect(info).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(1000)
        expect(info).toHaveBeenCalledTimes(2)

        stop()
        await vi.advanceTimersByTimeAsync(5000)
        expect(info).toHaveBeenCalledTimes(2) // no further calls after stop()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
