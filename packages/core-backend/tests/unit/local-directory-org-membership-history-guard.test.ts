/**
 * Slice C (#6079, plan "切片 C 开工", owner 2026-10-13 「做」) — the membership-history guard of
 * `createLocalAccount({ refuseMembershipHistory: true })`, which `POST /api/admin/directory/local/accounts`
 * sets, and its 409 mapping.
 *
 * WHAT IS PINNED
 *   - With the option, a user who already has ANY `user_orgs` row in the target org (active or
 *     deactivated) or applied deprovision evidence (an event or an effect still 'applied') is refused
 *     with `LocalDirectoryMembershipHistoryError` (a `LocalDirectoryConflictError`), BEFORE the link,
 *     the membership upsert (which would revive a deactivated row) and the evidence supersede run; a
 *     zero-row user without applied evidence proceeds with the full write set.
 *   - The guard reads under the user's access-graph row lock (`users … FOR UPDATE`) in the same
 *     transaction client, and after the account INSERT so an existing local account still answers the
 *     unchanged duplicate 409. The missing-user 404 and inactive-user 409 come first and never read.
 *   - Without the option (service default) nothing changes: the history is never read and the
 *     upsert / supersede run — the designed access-graph override other callers rely on.
 *   - HTTP: the route sets the option; a refusal is 409 `DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY` with a
 *     fixed sentence (no ids) and no audit row; the duplicate / inactive 409s keep
 *     `DIRECTORY_LOCAL_CONFLICT` and their sentences; an untyped failure of the history read is the
 *     route's fixed 500 with the driver text kept out of the body.
 *
 * HOW: db/pg's `transaction` hands the handler ONE fake client that answers each statement of the
 * create path from per-test fixtures and records the order; the history statement is evaluated
 * predicate by predicate (a filter applies only when the statement carries it), so ignoring
 * deactivated rows, dropping the org / user / status filters or turning the evidence OR into AND
 * reds the cases below. HTTP goes through usePinnedServer() + request(pinned.url()) (never
 * request(app), the #4154 tripwire).
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

type OrgRow = { user_id: string; org_id: string; is_active: boolean }
type EvidenceRow = { local_user_id: string; status: string }
type Fixture = {
  user: { id: string; isActive: boolean } | null
  rows: OrgRow[]
  events: EvidenceRow[]
  effects: EvidenceRow[]
  duplicateAccount?: boolean
  historyFailure?: Error
}

const USER_ID = 'user-slice-c-1'
const ACCOUNT_ID = '7a1f0c2e-0000-4000-8000-00000000c001'
const INTEGRATION_ID = '7a1f0c2e-0000-4000-8000-00000000a001'

const state = vi.hoisted(() => ({
  fixture: null as null | Record<string, unknown>,
  statements: [] as Array<{ sql: string; params: unknown[] }>,
}))

const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn() }))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function evaluateHistory(sql: string, params: unknown[], fx: Fixture) {
  const [anySegment = '', afterAny = ''] = sql.split('AS has_any_row')
  const [orgSegment = '', evidenceSegment = ''] = afterAny.split('AS has_org_row')
  const userRows = (segment: string) => fx.rows
    .filter((row) => !/uo\.user_id = \$1/.test(segment) || row.user_id === params[0])
    .filter((row) => !/is_active/.test(segment) || row.is_active)
  const [eventsSegment = '', effectsSegment = ''] = evidenceSegment.split('directory_deprovision_effects')
  const live = (rows: EvidenceRow[], segment: string, alias: 'event' | 'effect') => rows
    .filter((row) => !new RegExp(`${alias}[.]local_user_id = [$]1`).test(segment) || row.local_user_id === params[0])
    .filter((row) => !new RegExp(`${alias}[.]status = 'applied'`).test(segment) || row.status === 'applied')
    .length > 0
  const eventLive = live(fx.events, eventsSegment, 'event')
  const effectLive = live(fx.effects, effectsSegment, 'effect')
  return {
    has_any_row: userRows(anySegment).length > 0,
    has_org_row: userRows(orgSegment)
      .filter((row) => !/uo\.org_id = \$2/.test(orgSegment) || row.org_id === params[1])
      .length > 0,
    deprovision_applied: /[)]\s*OR\s+EXISTS/.test(evidenceSegment) ? eventLive || effectLive : eventLive && effectLive,
  }
}

async function fakeQuery(sql: string, params: unknown[] = []) {
  const fx = state.fixture as unknown as Fixture
  const text = normalize(sql)
  state.statements.push({ sql: text, params })
  if (text.startsWith('SET TRANSACTION')) return { rows: [] }
  if (/FROM users WHERE id = \$1::text FOR UPDATE/.test(text)) {
    if (!fx.user || fx.user.id !== params[0]) return { rows: [] }
    return {
      rows: [{
        id: fx.user.id, name: 'Slice C User', email: null, username: null, mobile: null,
        activation_status: 'activated', is_active: fx.user.isActive, access_generation: '7',
      }],
    }
  }
  if (text.startsWith('INSERT INTO directory_accounts')) {
    if (fx.duplicateAccount) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    return { rows: [{ id: ACCOUNT_ID }] }
  }
  if (text.includes('AS has_any_row')) {
    if (fx.historyFailure) throw fx.historyFailure
    return { rows: [evaluateHistory(sql, params, fx)] }
  }
  if (text.startsWith('INSERT INTO directory_account_links')) return { rows: [] }
  if (text.startsWith('INSERT INTO user_orgs')) return { rows: [{ user_id: params[0] }] }
  if (text.startsWith('UPDATE directory_deprovision_effects')) return { rows: [] }
  if (text.startsWith('UPDATE directory_deprovision_events')) return { rows: [] }
  if (text.startsWith('UPDATE users SET access_generation')) return { rows: [{ access_generation: '8' }] }
  if (text.includes('FROM directory_accounts a LEFT JOIN directory_account_links l')) {
    return {
      rows: [{
        id: ACCOUNT_ID, integration_id: INTEGRATION_ID, external_user_id: USER_ID, external_key: `default:${USER_ID}`,
        name: 'Slice C User', email: null, mobile: null, title: null, is_active: true,
        created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z', local_user_id: USER_ID,
      }],
    }
  }
  throw new Error(`fake client: unexpected statement ${text.slice(0, 80)}`)
}

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(async (handler: (client: { query: typeof fakeQuery }) => Promise<unknown>) =>
    handler({ query: fakeQuery })),
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))

vi.mock('../../src/directory/directory-sync', async (importOriginal) => {
  // REAL membership helpers (their SQL goes to the fake client); only the anchor get-or-create and
  // its post-commit audit are replaced — the anchor has its own real-DB suites.
  const actual = await importOriginal<typeof import('../../src/directory/directory-sync')>()
  return {
    ...actual,
    getOrCreateLocalIntegrationInTransaction: vi.fn(async (_client: unknown, orgId: string) => ({
      integration: { id: INTEGRATION_ID, orgId, provider: 'local' },
      event: null,
    })),
    emitLocalIntegrationAnchorAudit: vi.fn(async () => undefined),
  }
})

import {
  LocalDirectoryConflictError,
  LocalDirectoryMembershipHistoryError,
  LocalDirectoryNotFoundError,
  createLocalAccount,
} from '../../src/directory/local-directory-org'
import { adminDirectoryLocalRouter } from '../../src/routes/admin-directory-local'
import { ORG_MEMBERSHIP_HISTORY_SQL } from '../../src/directory/org-membership-history'

// Spelled out here (not imported) so a silent edit of the shipped sentence reds this file.
const GUARD_SENTENCE =
  'This user already has a membership record in the target organization, or an open deprovision record, '
  + 'so this endpoint cannot add them directly. An active membership needs no action; a deactivated '
  + 'membership or a deprovision record must be handled through the directory management / deprovision '
  + 'evidence process. '
  + '该账号在目标组织已有归属记录，或有未结的离职记录，本接口不能直接加入；活跃归属无需处理，'
  + '停用归属或离职记录请按目录管理 / 离职证据流程处理。'

function useFixture(partial: Partial<Fixture>): void {
  state.fixture = {
    user: { id: USER_ID, isActive: true },
    rows: [],
    events: [],
    effects: [],
    ...partial,
  } as unknown as Record<string, unknown>
}

function indexOf(predicate: (sql: string) => boolean): number {
  return state.statements.findIndex((statement) => predicate(statement.sql))
}

const isUserLock = (sql: string) => /FROM users WHERE id = \$1::text FOR UPDATE/.test(sql)
const isHistory = (sql: string) => sql.includes('AS has_any_row')
const isAccountInsert = (sql: string) => sql.startsWith('INSERT INTO directory_accounts')
const isLinkInsert = (sql: string) => sql.startsWith('INSERT INTO directory_account_links')
const isMembershipUpsert = (sql: string) => sql.startsWith('INSERT INTO user_orgs')
const isEvidenceSupersede = (sql: string) =>
  sql.startsWith('UPDATE directory_deprovision_effects') || sql.startsWith('UPDATE directory_deprovision_events')
const isGenerationBump = (sql: string) => sql.startsWith('UPDATE users SET access_generation')

function expectNoMembershipWrites(): void {
  expect(indexOf(isLinkInsert)).toBe(-1)
  expect(indexOf(isMembershipUpsert)).toBe(-1)
  expect(indexOf(isEvidenceSupersede)).toBe(-1)
  expect(indexOf(isGenerationBump)).toBe(-1)
}

beforeEach(() => {
  state.statements.length = 0
  state.fixture = null
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockResolvedValue(undefined)
})

describe('createLocalAccount — slice C membership-history guard (refuseMembershipHistory: true)', () => {
  it('a user with no user_orgs row and no applied evidence proceeds: lock, then guard, then link / membership / supersede', async () => {
    useFixture({ rows: [{ user_id: 'someone-else', org_id: 'default', is_active: false }] })

    const account = await createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true })

    expect(account.id).toBe(ACCOUNT_ID)
    const lock = indexOf(isUserLock)
    const history = indexOf(isHistory)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(history).toBeGreaterThan(lock)
    expect(history).toBeGreaterThan(indexOf(isAccountInsert))
    expect(indexOf(isLinkInsert)).toBeGreaterThan(history)
    expect(indexOf(isMembershipUpsert)).toBeGreaterThan(history)
    expect(indexOf(isEvidenceSupersede)).toBeGreaterThan(history)
    expect(indexOf(isGenerationBump)).toBeGreaterThan(history)
    expect(state.statements[history]!.params).toEqual([USER_ID, 'default'])
    expect(state.statements[history]!.sql).toBe(normalize(ORG_MEMBERSHIP_HISTORY_SQL))
  })

  it('a DEACTIVATED row in the target org is refused (never revived), before any membership write', async () => {
    useFixture({ rows: [{ user_id: USER_ID, org_id: 'default', is_active: false }] })

    const outcome = createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true })

    await expect(outcome).rejects.toBeInstanceOf(LocalDirectoryMembershipHistoryError)
    await expect(outcome).rejects.toBeInstanceOf(LocalDirectoryConflictError)
    await expect(outcome).rejects.toThrow(GUARD_SENTENCE)
    expect(indexOf(isHistory)).toBeGreaterThan(indexOf(isUserLock))
    expectNoMembershipWrites()
  })

  it('an ACTIVE row in the target org is refused too (any row, active or deactivated)', async () => {
    useFixture({ rows: [{ user_id: USER_ID, org_id: 'default', is_active: true }] })

    await expect(
      createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true }),
    ).rejects.toBeInstanceOf(LocalDirectoryMembershipHistoryError)
    expectNoMembershipWrites()
  })

  it('an applied deprovision EVENT is refused even with no user_orgs row (no silent supersede)', async () => {
    useFixture({
      events: [{ local_user_id: USER_ID, status: 'applied' }],
      effects: [{ local_user_id: USER_ID, status: 'superseded' }],
    })

    await expect(
      createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true }),
    ).rejects.toBeInstanceOf(LocalDirectoryMembershipHistoryError)
    expectNoMembershipWrites()
  })

  it('an applied deprovision EFFECT alone (its event no longer applied) is refused', async () => {
    useFixture({
      events: [{ local_user_id: USER_ID, status: 'fully_resolved' }],
      effects: [{ local_user_id: USER_ID, status: 'applied' }],
    })

    await expect(
      createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true }),
    ).rejects.toBeInstanceOf(LocalDirectoryMembershipHistoryError)
    expectNoMembershipWrites()
  })

  it("only superseded / resolved evidence and another user's applied evidence do not refuse", async () => {
    useFixture({
      events: [{ local_user_id: USER_ID, status: 'superseded' }, { local_user_id: 'someone-else', status: 'applied' }],
      effects: [{ local_user_id: USER_ID, status: 'reversed' }, { local_user_id: 'someone-else', status: 'applied' }],
    })

    await expect(
      createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true }),
    ).resolves.toMatchObject({ id: ACCOUNT_ID })
    expect(indexOf(isMembershipUpsert)).toBeGreaterThan(indexOf(isHistory))
  })

  it('a row in ANOTHER org only does not refuse this org (the row predicate is org-scoped)', async () => {
    useFixture({ rows: [{ user_id: USER_ID, org_id: 'org-other', is_active: false }] })

    await expect(
      createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true }),
    ).resolves.toMatchObject({ id: ACCOUNT_ID })
  })

  it('a missing user stays 404 and an inactive user stays the existing 409 — neither reads the history', async () => {
    useFixture({ user: null })
    await expect(
      createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true }),
    ).rejects.toBeInstanceOf(LocalDirectoryNotFoundError)
    expect(indexOf(isHistory)).toBe(-1)

    state.statements.length = 0
    useFixture({ user: { id: USER_ID, isActive: false }, rows: [{ user_id: USER_ID, org_id: 'default', is_active: false }] })
    const inactive = createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true })
    await expect(inactive).rejects.toThrow('local user is inactive')
    await expect(inactive).rejects.not.toBeInstanceOf(LocalDirectoryMembershipHistoryError)
    expect(indexOf(isHistory)).toBe(-1)
  })

  it('an existing local account still answers the unchanged duplicate 409, not the guard (precedence kept)', async () => {
    useFixture({ duplicateAccount: true, rows: [{ user_id: USER_ID, org_id: 'default', is_active: false }] })

    const outcome = createLocalAccount({ orgId: 'default', localUserId: USER_ID, refuseMembershipHistory: true })

    await expect(outcome).rejects.toThrow('a local directory account already exists for this user in this org')
    await expect(outcome).rejects.not.toBeInstanceOf(LocalDirectoryMembershipHistoryError)
    expect(indexOf(isHistory)).toBe(-1)
  })

  it('without the option (service default) the history is never read and the existing override semantics run', async () => {
    useFixture({
      rows: [{ user_id: USER_ID, org_id: 'default', is_active: false }],
      events: [{ local_user_id: USER_ID, status: 'applied' }],
    })

    await expect(createLocalAccount({ orgId: 'default', localUserId: USER_ID })).resolves.toMatchObject({ id: ACCOUNT_ID })
    expect(indexOf(isHistory)).toBe(-1)
    expect(indexOf(isMembershipUpsert)).toBeGreaterThan(-1)
    expect(indexOf(isEvidenceSupersede)).toBeGreaterThan(-1)
  })
})

describe('POST /api/admin/directory/local/accounts — slice C refusal over HTTP', () => {
  const pinned = usePinnedServer()

  beforeEach(() => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      // The legacy admin claim satisfies ensurePlatformAdmin without an RBAC read.
      ;(req as express.Request & { user?: unknown }).user = { id: 'admin-slice-c', role: 'admin' }
      next()
    })
    app.use('/api/admin/directory/local', adminDirectoryLocalRouter())
    pinned.setApp(app)
  })

  async function post(body: Record<string, unknown>) {
    return request(pinned.url()).post('/api/admin/directory/local/accounts').send(body)
  }

  it('the route sets the option: a deactivated default row answers 409 DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY, values-free, no audit', async () => {
    useFixture({ rows: [{ user_id: USER_ID, org_id: 'default', is_active: false }] })

    const res = await post({ localUserId: USER_ID })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ ok: false, error: { code: 'DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY', message: GUARD_SENTENCE } })
    expect(JSON.stringify(res.body)).not.toContain(USER_ID)
    expect(state.statements.find((statement) => isHistory(statement.sql))?.params).toEqual([USER_ID, 'default'])
    expectNoMembershipWrites()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('applied deprovision evidence answers the same 409 code', async () => {
    useFixture({ effects: [{ local_user_id: USER_ID, status: 'applied' }] })

    const res = await post({ localUserId: USER_ID })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY')
    expectNoMembershipWrites()
  })

  it('a zero-row user without evidence is created (200) and audited once', async () => {
    useFixture({})

    const res = await post({ localUserId: USER_ID })

    expect(res.status).toBe(200)
    expect(res.body.data.account).toMatchObject({ id: ACCOUNT_ID, localUserId: USER_ID, isActive: true })
    expect(indexOf(isMembershipUpsert)).toBeGreaterThan(indexOf(isHistory))
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(1)
    expect(auditMocks.auditLog.mock.calls[0]![0]).toMatchObject({ action: 'directory.local_account.create', resourceId: ACCOUNT_ID })
  })

  it('the existing 409s are unchanged: duplicate account and inactive user keep DIRECTORY_LOCAL_CONFLICT and their sentences', async () => {
    useFixture({ duplicateAccount: true, rows: [{ user_id: USER_ID, org_id: 'default', is_active: true }] })
    const duplicate = await post({ localUserId: USER_ID })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toEqual({
      ok: false,
      error: { code: 'DIRECTORY_LOCAL_CONFLICT', message: 'a local directory account already exists for this user in this org' },
    })

    useFixture({ user: { id: USER_ID, isActive: false } })
    const inactive = await post({ localUserId: USER_ID })
    expect(inactive.status).toBe(409)
    expect(inactive.body).toEqual({ ok: false, error: { code: 'DIRECTORY_LOCAL_CONFLICT', message: 'local user is inactive' } })
  })

  it('an untyped failure of the history read is the fixed 500: driver text stays out of the body (values-free)', async () => {
    const MARKER = 'MARKER_slc_h7 connect ECONNREFUSED 198.51.100.11:5432 role=fixture-role'
    const { Logger } = await import('../../src/core/logger')
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    useFixture({ historyFailure: new Error(MARKER) })

    const res = await post({ localUserId: USER_ID })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'DIRECTORY_LOCAL_INTERNAL_ERROR', message: 'Failed to create local account' } })
    expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toContain('MARKER_slc_h7')
    expect(JSON.stringify(res.body)).not.toContain('198.51.100.11')
    expectNoMembershipWrites()
    warn.mockRestore()
  })
})
