import { beforeEach, describe, expect, it, vi } from 'vitest'

// BOM备料 向导第⑤步「谁能用」的真实检测 — the SERVICE half (P1-3).
//
// What this suite pins:
//   R1  合取, not union: BOTH codes on ONE role, or it does not count
//   R2  「看不到」≠「没完成」 (G4): 403 / 500 / network / non-JSON / envelope-not-ok / unrecognised
//       shape ALL collapse to `unknown`, and NEVER to `no_role`
//   R3  成员 0 人 is ⚠, not ✔ — a role nobody is in does not let anyone open the page (设计稿 验收 4)
//   R4  ZERO user identity leaves this module: a payload stuffed with user ids, emails and an
//       `actorId` projects to role names and integers only (REVERSE assertion on the whole result)
//   R5  the route is read literally, as a GET, with no query string and no write method
//   R6  the read never rejects — a caller cannot turn it into a red banner by forgetting a catch
//   R7  THE LADDER IS THE GATE'S LADDER: a role carrying only `stock-prep:admin` QUALIFIES (the
//       plugin gate returns true for it before it looks at read/operate), while `stock-prep:*` and a
//       non-admin role's `*:*` do NOT (that same gate matches literally, so the server refuses them)
//   R8  platform-admin roles (`id === 'admin'`, or holding `integration:admin`) are reported on
//       their own counter and NEVER decide `state` — every deployment has one from day one

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import {
  STOCK_PREP_ADMIN_PERMISSION_CODE,
  STOCK_PREP_OPERATOR_PERMISSION_CODES,
  STOCK_PREP_READINESS_ROLE_NAME_CAP,
  STOCK_PREP_ROLE_CATALOG_ROUTE,
  readStockPrepOnboardingReadiness,
  stockPrepOnboardingReadinessFromPayload,
  stockPrepOnboardingReadinessUnknown,
} from '../src/services/integration/stockPreparation/onboardingReadiness'

const READ = 'stock-prep:read'
const OPERATE = 'stock-prep:operate'

/** Planted identities. NONE of these may survive the projection (R4). */
const PLANTED_USER_ID = 'u-8f3c19'
const PLANTED_EMAIL = 'zhang.wei@factory-a.example.com'
const PLANTED_DISPLAY_NAME = '张伟'

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function role(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'role-line', name: '备料一线', permissions: [READ, OPERATE], memberCount: 6, ...overrides }
}

describe('BOM备料 第⑤步授权检测 — 纯投影 (stockPrepOnboardingReadinessFromPayload)', () => {
  // R1 -----------------------------------------------------------------------
  it('counts a role that holds BOTH codes', () => {
    const result = stockPrepOnboardingReadinessFromPayload({ items: [role()] })
    expect(result.state).toBe('ready')
    expect(result.roleCount).toBe(1)
    expect(result.memberTotal).toBe(6)
    expect(result.roles).toEqual([{ name: '备料一线', memberCount: 6 }])
  })

  it('does NOT count two roles that split the two codes between them (合取, not union)', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [
        role({ id: 'r-read', name: '只看', permissions: [READ], memberCount: 12 }),
        role({ id: 'r-operate', name: '只做', permissions: [OPERATE], memberCount: 9 }),
      ],
    })
    expect(result.state).toBe('no_role')
    expect(result.roleCount).toBe(0)
    expect(result.memberTotal).toBe(0)
    expect(result.roles).toEqual([])
  })

  it('a role carrying extra unrelated codes still counts, as long as both are on it', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ permissions: ['multitable:read', OPERATE, 'approvals:read', READ] })],
    })
    expect(result.state).toBe('ready')
  })

  // R3 -----------------------------------------------------------------------
  it('a qualifying role with ZERO members is ⚠ (no_members), never ✔', () => {
    const result = stockPrepOnboardingReadinessFromPayload({ items: [role({ memberCount: 0 })] })
    expect(result.state).toBe('no_members')
    expect(result.roleCount).toBe(1)
    expect(result.memberTotal).toBe(0)
  })

  it('several qualifying roles that are all empty stay no_members — the sum is what decides', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ id: 'a', name: 'A', memberCount: 0 }), role({ id: 'b', name: 'B', memberCount: 0 })],
    })
    expect(result.state).toBe('no_members')
    expect(result.roleCount).toBe(2)
  })

  it('an EMPTY catalog is a real answer (no_role), not an unrecognised shape', () => {
    expect(stockPrepOnboardingReadinessFromPayload({ items: [] }).state).toBe('no_role')
  })

  // R2 (shape half) ----------------------------------------------------------
  it.each([
    ['no data at all', null],
    ['a primitive instead of an envelope body', 'nope'],
    ['an object with no items key', { total: 3 }],
    ['items that are not an array', { items: { 'role-line': true } }],
  ])('an unrecognised shape (%s) is unknown, NOT 「还没有这样的角色」', (_label, payload) => {
    const result = stockPrepOnboardingReadinessFromPayload(payload)
    expect(result.state).toBe('unknown')
    expect(result.state).not.toBe('no_role')
    expect(result.roleCount).toBe(0)
  })

  it('entries that are not objects are skipped without poisoning the verdict', () => {
    const result = stockPrepOnboardingReadinessFromPayload({ items: [null, 42, 'role-line', role()] })
    expect(result.state).toBe('ready')
    expect(result.roleCount).toBe(1)
  })

  it('a qualifying role with neither name nor id is still COUNTED, with a null name', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [{ permissions: [READ, OPERATE], memberCount: 3 }],
    })
    expect(result.state).toBe('ready')
    expect(result.roleCount).toBe(1)
    expect(result.roles).toEqual([{ name: null, memberCount: 3 }])
  })

  it('falls back to the role id when the catalog carries no name', () => {
    const result = stockPrepOnboardingReadinessFromPayload({ items: [role({ name: '   ', id: 'role-line' })] })
    expect(result.roles[0].name).toBe('role-line')
  })

  it('a nonsense member count degrades to 0 rather than NaN', () => {
    const result = stockPrepOnboardingReadinessFromPayload({ items: [role({ memberCount: 'six' })] })
    expect(result.memberTotal).toBe(0)
    expect(result.state).toBe('no_members')
  })

  it('caps the listed role names but reports the TRUE role count', () => {
    const many = Array.from({ length: STOCK_PREP_READINESS_ROLE_NAME_CAP + 3 }, (_unused, index) => role({
      id: `role-${index}`, name: `角色 ${index}`, memberCount: 1,
    }))
    const result = stockPrepOnboardingReadinessFromPayload({ items: many })
    expect(result.roleCount).toBe(STOCK_PREP_READINESS_ROLE_NAME_CAP + 3)
    expect(result.roles).toHaveLength(STOCK_PREP_READINESS_ROLE_NAME_CAP)
    expect(result.memberTotal).toBe(STOCK_PREP_READINESS_ROLE_NAME_CAP + 3)
  })

  // R7 — the ladder ------------------------------------------------------------
  it('a role carrying ONLY stock-prep:admin QUALIFIES — the gate satisfies read and operate from it', () => {
    // plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs
    // `satisfiesStockPrepAccess`: `if (held.includes(STOCK_PREP_ADMIN)) return true`, checked before
    // the read/operate branches. Answering `no_role` here would tell an administrator to go build a
    // role whose job is already being done by one that exists.
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ id: 'r-admin', name: '备料管理员', permissions: [STOCK_PREP_ADMIN_PERMISSION_CODE], memberCount: 2 })],
    })
    expect(result.state).toBe('ready')
    expect(result.roleCount).toBe(1)
    expect(result.memberTotal).toBe(2)
    // Counted, and flagged as qualifying THROUGH :admin so the view can say what that code confers.
    expect(result.adminRoleCount).toBe(1)
  })

  it('a stock-prep:admin role with nobody in it is no_members, exactly like any other qualifying role', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ permissions: [STOCK_PREP_ADMIN_PERMISSION_CODE], memberCount: 0 })],
    })
    expect(result.state).toBe('no_members')
    expect(result.adminRoleCount).toBe(1)
  })

  it('a NAMESPACE WILDCARD does not qualify — the server matches literally and refuses it', () => {
    // `satisfiesStockPrepAccess` does `held.includes('stock-prep:read')`, not a wildcard expansion.
    // `useAuth().hasPermission` WOULD expand `stock-prep:*` and render the controls, but the routes
    // behind them 403 — counting this role as 能用 would promise access the server then refuses.
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ id: 'r-wild', name: '备料通配', permissions: ['stock-prep:*'], memberCount: 4 })],
    })
    expect(result.state).toBe('no_role')
    expect(result.adminRoleCount).toBe(0)
    expect(result.platformAdminRoleCount).toBe(0)
  })

  it('a role holding *:* but NOT named admin qualifies for nothing — its members get no role:admin', () => {
    // `listUserPermissions` (http-routes.cjs) synthesises `role:<id>` from role IDS, so a role called
    // anything else contributes `*:*` alone, which the stock-prep gate does not match.
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ id: 'superuser', name: '超级用户', permissions: ['*:*'], memberCount: 3 })],
    })
    expect(result.state).toBe('no_role')
    expect(result.platformAdminRoleCount).toBe(0)
  })

  // R8 — platform-admin roles --------------------------------------------------
  it.each([
    ['the platform-admin role id', { id: 'admin', name: '系统管理员', permissions: ['*:*'] }],
    ['the integration:admin code', { id: 'ops', name: '集成管理员', permissions: ['integration:admin'] }],
  ])('a platform-admin role (%s) is counted apart and never decides the verdict', (_label, overrides) => {
    const result = stockPrepOnboardingReadinessFromPayload({ items: [role({ ...overrides, memberCount: 2 })] })
    expect(result.platformAdminRoleCount).toBe(1)
    // They CAN open 备料 — but they are not 一线, and every deployment has one on day one. Counting
    // them would make this step read ✔ on a host where nobody on the floor can open anything.
    expect(result.state).toBe('no_role')
    expect(result.roleCount).toBe(0)
    expect(result.memberTotal).toBe(0)
  })

  it('a platform-admin role that ALSO carries both codes still stays out of the verdict', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [role({ id: 'admin', name: '系统管理员', permissions: [READ, OPERATE], memberCount: 5 })],
    })
    expect(result.platformAdminRoleCount).toBe(1)
    expect(result.state).toBe('no_role')
  })

  it('platform-admin roles never crowd out a real operator role', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      items: [
        role({ id: 'admin', name: '系统管理员', permissions: ['*:*'], memberCount: 2 }),
        role({ id: 'r-line', name: '备料一线', permissions: [READ, OPERATE], memberCount: 6 }),
      ],
    })
    expect(result.state).toBe('ready')
    expect(result.roleCount).toBe(1)
    expect(result.memberTotal).toBe(6)
    expect(result.platformAdminRoleCount).toBe(1)
  })

  // R4 — the REVERSE assertion -----------------------------------------------
  it('projects role names and integers ONLY — no user id, email or display name survives', () => {
    const result = stockPrepOnboardingReadinessFromPayload({
      actorId: PLANTED_USER_ID,
      items: [{
        id: 'role-line',
        name: '备料一线',
        permissions: [READ, OPERATE],
        memberCount: 6,
        // Fields a future server widening could add. The projection must not carry them through.
        members: [{ userId: PLANTED_USER_ID, email: PLANTED_EMAIL, displayName: PLANTED_DISPLAY_NAME }],
        createdBy: PLANTED_USER_ID,
      }],
    })
    const serialized = JSON.stringify(result)
    for (const planted of [PLANTED_USER_ID, PLANTED_EMAIL, PLANTED_DISPLAY_NAME]) {
      expect(serialized, `projection must not carry ${planted}`).not.toContain(planted)
    }
    // And structurally: exactly two keys per role, whatever the server sends.
    expect(Object.keys(result.roles[0]).sort()).toEqual(['memberCount', 'name'])
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  })

  it('the exported unknown shape carries nothing but the status', () => {
    expect(stockPrepOnboardingReadinessUnknown(403)).toEqual({
      state: 'unknown', roles: [], roleCount: 0, memberTotal: 0, adminRoleCount: 0, platformAdminRoleCount: 0, status: 403,
    })
  })

  it('an over-long role name is MARKED as truncated, so it is not hunted for verbatim in 角色管理', () => {
    const long = '备'.repeat(120)
    const result = stockPrepOnboardingReadinessFromPayload({ items: [role({ name: long })] })
    const name = result.roles[0].name ?? ''
    expect(name.endsWith('…')).toBe(true)
    expect(name.length).toBeLessThan(long.length)
  })

  it('the two required codes are the two the wizard names in its copy', () => {
    expect([...STOCK_PREP_OPERATOR_PERMISSION_CODES]).toEqual(['stock-prep:read', 'stock-prep:operate'])
  })
})

describe('BOM备料 第⑤步授权检测 — 读 (readStockPrepOnboardingReadiness)', () => {
  beforeEach(() => {
    h.apiFetch.mockReset()
  })

  // R5 -----------------------------------------------------------------------
  it('GETs the platform role catalog, literally, with no query string and no write method', async () => {
    h.apiFetch.mockResolvedValue(envelope({ items: [role()] }))
    await readStockPrepOnboardingReadiness()
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
    const [url, options] = h.apiFetch.mock.calls[0] as [string, Record<string, unknown> | undefined]
    // Asserted against the literal, not against the constant the code under test also uses.
    expect(url).toBe('/api/admin/roles')
    expect(STOCK_PREP_ROLE_CATALOG_ROUTE).toBe('/api/admin/roles')
    expect(url).not.toContain('?')
    expect(options?.method).toBeUndefined()
    expect(options?.body).toBeUndefined()
    // A background probe of a platform route must not bounce the caller to the sign-in screen (G3).
    expect(options?.suppressUnauthorizedRedirect).toBe(true)
  })

  it('reads the envelope and answers ready', async () => {
    h.apiFetch.mockResolvedValue(envelope({ items: [role({ memberCount: 6 })], total: 1 }))
    const result = await readStockPrepOnboardingReadiness()
    expect(result.state).toBe('ready')
    expect(result.memberTotal).toBe(6)
    expect(result.status).toBeNull()
  })

  // R2 (transport half) ------------------------------------------------------
  it.each([403, 401, 404, 500, 502])('a %s is unknown — never 「还没有这样的角色」', async (status) => {
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), { status }))
    const result = await readStockPrepOnboardingReadiness()
    expect(result.state).toBe('unknown')
    expect(result.status).toBe(status)
    expect(result.roleCount).toBe(0)
  })

  it('a network failure is unknown, and the promise still resolves', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(readStockPrepOnboardingReadiness()).resolves.toMatchObject({ state: 'unknown', status: null })
  })

  it('a client that answers with nothing at all is unknown, not a crash', async () => {
    h.apiFetch.mockResolvedValue(undefined)
    await expect(readStockPrepOnboardingReadiness()).resolves.toMatchObject({ state: 'unknown' })
  })

  it('a 200 carrying an HTML sign-in page is unknown, not a successful read', async () => {
    h.apiFetch.mockResolvedValue(new Response('<!doctype html><title>Sign in</title>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    }))
    const result = await readStockPrepOnboardingReadiness()
    expect(result.state).toBe('unknown')
    expect(result.status).toBe(200)
  })

  it('a 200 whose envelope is not ok is unknown', async () => {
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, data: { items: [role()] } }), { status: 200 }))
    expect((await readStockPrepOnboardingReadiness()).state).toBe('unknown')
  })

  it('a 200 whose data has no items is unknown, not no_role', async () => {
    h.apiFetch.mockResolvedValue(envelope({ total: 0 }))
    const result = await readStockPrepOnboardingReadiness()
    expect(result.state).toBe('unknown')
    expect(result.state).not.toBe('no_role')
  })

  // R4 over the wire ---------------------------------------------------------
  it('an envelope carrying identities projects none of them', async () => {
    h.apiFetch.mockResolvedValue(envelope({
      actorId: PLANTED_USER_ID,
      items: [{ id: 'role-line', name: '备料一线', permissions: [READ, OPERATE], memberCount: 6, ownerEmail: PLANTED_EMAIL }],
    }))
    const serialized = JSON.stringify(await readStockPrepOnboardingReadiness())
    expect(serialized).not.toContain(PLANTED_USER_ID)
    expect(serialized).not.toContain(PLANTED_EMAIL)
  })
})
