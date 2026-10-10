/**
 * R-41 — the batch routes' `failed[].error`, answered at 200.
 *
 * POST /accounts/batch-bind, /accounts/batch-admit-users and /accounts/batch-unbind commit item by item and
 * answer a partial failure at 200 with `failed: [{ accountId, error }]`. Before R-41 `error` was the caught
 * error's message — a driver sentence naming a relation, a host, a port — sent to the admin as it was. Now the
 * batch services (directory-sync.ts) classify it (directory-failure-text.ts): a typed directory sentence as it
 * is, anything else the item's fixed sentence, the original text logged. `failedErrors` (raw, never sent) is
 * unchanged — the route still rethrows `failedErrors[0]` when nothing committed (#6163 S6).
 *
 * Driven through the REAL route handlers (invoked straight off the router stack — never request(app)) and the
 * REAL batch services, with only pg and the audit / invite / bcrypt-rounds seams mocked: item 1 commits, item 2
 * fails with a marker-carrying untyped error, and the 200 body is checked.
 */
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => undefined) }))
vi.mock('../../src/security/auth-runtime-config', () => ({ getBcryptSaltRounds: vi.fn(() => 4) }))
vi.mock('../../src/auth/invite-ledger', () => ({ recordInvite: vi.fn(async () => null) }))
vi.mock('../../src/auth/invite-tokens', () => ({ issueInviteToken: vi.fn(() => 'invite-token-fixed') }))

import { Logger } from '../../src/core/logger'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'

const MARKER = 'MARKER_r41_batch'
const DRIVER_TEXT = `${MARKER} relation "directory_account_links" does not exist at 198.51.100.4:5432`

function driverError(): Error {
  return Object.assign(new Error(DRIVER_TEXT), { code: '42P01', detail: DRIVER_TEXT })
}

const ACCOUNT_ROW = {
  integration_id: 'dir-1',
  provider: 'dingtalk',
  corp_id: 'dingcorp',
  external_user_id: '0447654442691174',
  union_id: 'union-1',
  open_id: 'open-1',
  external_key: 'union-1',
  name: '林岚',
  email: null,
  mobile: '13900001234',
}

function summaryRow(accountId: string, link: Record<string, unknown>): Record<string, unknown> {
  return {
    integration_id: 'dir-1',
    provider: 'dingtalk',
    corp_id: 'dingcorp',
    directory_account_id: accountId,
    external_user_id: '0447654442691174',
    union_id: 'union-1',
    open_id: 'open-1',
    external_key: 'union-1',
    account_name: '林岚',
    account_email: null,
    account_mobile: '13900001234',
    account_is_active: true,
    account_updated_at: '2026-07-08T00:00:00.000Z',
    link_updated_at: '2026-07-08T00:00:00.000Z',
    reviewed_by: null,
    review_note: null,
    department_paths: [],
    ...link,
  }
}

/**
 * Bare queries after the positional `mockResolvedValueOnce` values: anything about account-2 fails with driver
 * text (its first read, whichever statement that is); anything else is an empty result, as in the bind-account
 * harness, so a trailing best-effort read of the committed item cannot shift the sequence.
 */
function failAccountTwoWithDriverText(): void {
  pgMocks.query.mockImplementation(async (_sql: unknown, params?: unknown[]) => {
    if (Array.isArray(params) && params.some((value) => value === 'account-2')) throw driverError()
    return { rows: [] }
  })
}

/** The bind-account harness's transaction client (tests/unit/directory-sync-bind-account.test.ts), trimmed. */
function installTransactionMock(clientQuery: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>): void {
  const aliasOwners = new Map<string, string>()
  pgMocks.transaction.mockImplementation(async (handler: (client: unknown) => Promise<unknown>) => handler({
    query: async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (/INSERT INTO user_login_aliases/i.test(text)) {
        aliasOwners.set(String(params?.[2] ?? ''), String(params?.[0] ?? ''))
        return { rows: [] }
      }
      if (/SELECT user_id FROM user_login_aliases/i.test(text)) {
        const ownerId = aliasOwners.get(String(params?.[0] ?? ''))
        return { rows: ownerId ? [{ user_id: ownerId }] : [] }
      }
      if (/FROM directory_accounts account\s+JOIN directory_integrations integration/.test(text)) {
        return {
          rows: [{
            id: String(params?.[0] ?? 'account-1'),
            ...ACCOUNT_ROW,
            is_active: true,
            integration_provider: 'dingtalk',
            integration_corp_id: 'dingcorp',
          }],
        }
      }
      if (/FROM users[\s\S]*FOR UPDATE/.test(text)) {
        const userId = String(params?.[0] ?? 'user-1')
        return {
          rows: [{
            id: userId,
            name: 'Alpha',
            email: 'alpha@example.com',
            username: null,
            mobile: null,
            activation_status: 'activated',
            is_active: true,
            access_generation: 0,
          }],
        }
      }
      if (/UPDATE users[\s\S]*access_generation/.test(text)) return { rows: [{ access_generation: 1 }] }
      return clientQuery(text, params)
    },
  }))
}

type RouteLayer = {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
  }
}

async function invoke(path: string, body: Record<string, unknown>): Promise<{ statusCode: number; body: unknown; headers: Record<string, string> }> {
  const router = adminDirectoryRouter() as unknown as { stack: RouteLayer[] }
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.post)
  if (!layer?.route) throw new Error(`Route POST ${path} not found`)
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(payload: unknown) { this.body = payload; this.headersSent = true; return this },
    send(payload: unknown) { this.body = payload; this.headersSent = true; return this },
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); return this },
    set(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); return this },
    getHeader(name: string) { return headers[name.toLowerCase()] },
  }
  const req = {
    method: 'POST',
    url: path,
    headers: {},
    params: {},
    query: {},
    body,
    // The legacy admin claim short-circuits ensurePlatformAdmin's RBAC read.
    user: { id: 'admin-1', role: 'admin' },
  } as unknown as Request
  let forwarded: unknown
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res as unknown as Response, (err?: unknown) => {
    forwarded = err
  })
  if (forwarded) throw forwarded
  return res
}

let warnSpy: ReturnType<typeof vi.spyOn>
function loggedTexts(): string {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v)
  }
  walk(warnSpy.mock.calls)
  return out.join('\n')
}

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

function expectNoMarker(res: { body: unknown; headers: Record<string, string> }): void {
  const serialized = JSON.stringify(res.body) + JSON.stringify(res.headers)
  expect(serialized).not.toContain(MARKER)
  expect(serialized).not.toContain('198.51.100')
  expect(serialized).not.toContain('directory_account_links')
}

describe('R-41: a batch route\'s 200 `failed[].error` is a fixed sentence, never the caught text (real handlers, real services)', () => {
  it('POST /accounts/batch-unbind: item 2 fails untyped → failed[0].error is the fixed sentence, the text logged', async () => {
    installTransactionMock(async (sql, params) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) return { rows: [{ org_id: 'default' }] }
      if (/SELECT l\.local_user_id,[\s\S]*FROM directory_account_links l/.test(sql)) {
        if (params?.[0] === 'account-2') throw driverError()
        return { rows: [{ local_user_id: 'user-1', local_user_email: 'alpha@example.com', local_user_name: 'Alpha' }] }
      }
      return { rows: [] }
    })
    // account-1's summary reload after it unbinds.
    pgMocks.query.mockResolvedValueOnce({
      rows: [summaryRow('account-1', {
        link_status: 'unmatched',
        match_strategy: 'manual_unbound',
        local_user_id: null,
        local_user_email: null,
        local_user_name: null,
      })],
    })

    const res = await invoke('/accounts/batch-unbind', { accountIds: ['account-1', 'account-2'] })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        updatedCount: 1,
        failedCount: 1,
        failed: [{ accountId: 'account-2', error: 'Failed to unbind directory account' }],
      },
    })
    expectNoMarker(res)
    expect(loggedTexts()).toContain(DRIVER_TEXT)
  })

  it('POST /accounts/batch-bind: item 2 fails untyped → failed[0].error is the fixed sentence', async () => {
    installTransactionMock(async (sql) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) return { rows: [{ org_id: 'default' }] }
      return { rows: [] }
    })
    pgMocks.query
      // account-1: loads with no previous link, resolves the local user, binds, reloads its summary
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', ...ACCOUNT_ROW }] })
      .mockResolvedValueOnce({ rows: [{ local_user_id: null, local_user_email: null, local_user_name: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] })
      .mockResolvedValueOnce({
        rows: [summaryRow('account-1', {
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
        })],
      })
    // account-2: its first read fails with driver text
    failAccountTwoWithDriverText()

    const res = await invoke('/accounts/batch-bind', {
      bindings: [
        { accountId: 'account-1', localUserRef: 'alpha@example.com' },
        { accountId: 'account-2', localUserRef: 'beta@example.com' },
      ],
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        updatedCount: 1,
        failedCount: 1,
        failed: [{ accountId: 'account-2', error: 'Failed to bind directory account' }],
      },
    })
    expectNoMarker(res)
    expect(loggedTexts()).toContain(DRIVER_TEXT)
  })

  it('POST /accounts/batch-admit-users: item 2 fails untyped → failed[0].error is the fixed sentence', async () => {
    installTransactionMock(async (sql) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) return { rows: [{ org_id: 'default' }] }
      return { rows: [] }
    })
    const admitRow = { id: 'account-bulk-1', ...ACCOUNT_ROW, open_id: null }
    pgMocks.query
      // batch service preloads account-bulk-1
      .mockResolvedValueOnce({ rows: [admitRow] })
      // eligibility gate: no link, no active user with that mobile
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // admitDirectoryAccountUser reloads the account + previous link
      .mockResolvedValueOnce({ rows: [admitRow] })
      .mockResolvedValueOnce({ rows: [{ local_user_id: null, local_user_email: null, local_user_username: null, local_user_name: null }] })
      // summary reload
      .mockResolvedValueOnce({
        rows: [summaryRow('account-bulk-1', {
          open_id: null,
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          local_user_id: 'user-created',
          local_user_email: null,
          local_user_username: 'dt_0447654442691174_accountb',
          local_user_name: '林岚',
        })],
      })
    // account-2: its preload fails with driver text
    failAccountTwoWithDriverText()

    const res = await invoke('/accounts/batch-admit-users', { accountIds: ['account-bulk-1', 'account-2'] })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        updatedCount: 1,
        failedCount: 1,
        failed: [{ accountId: 'account-2', error: 'Failed to create and bind local user for directory account' }],
      },
    })
    expectNoMarker(res)
    expect(loggedTexts()).toContain(DRIVER_TEXT)
  })

  it('a typed directory sentence in a partial batch is still shown as it is (batch-bind, missing account)', async () => {
    installTransactionMock(async (sql) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) return { rows: [{ org_id: 'default' }] }
      return { rows: [] }
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', ...ACCOUNT_ROW }] })
      .mockResolvedValueOnce({ rows: [{ local_user_id: null, local_user_email: null, local_user_name: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] })
      .mockResolvedValueOnce({
        rows: [summaryRow('account-1', {
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
        })],
      })
      // account-2 does not exist → DirectoryNotFoundError('Directory account not found')
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await invoke('/accounts/batch-bind', {
      bindings: [
        { accountId: 'account-1', localUserRef: 'alpha@example.com' },
        { accountId: 'account-2', localUserRef: 'beta@example.com' },
      ],
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: { failed: [{ accountId: 'account-2', error: 'Directory account not found' }] },
    })
    // A sentence is an answer, not an incident: no fallback log line for it.
    expect(warnSpy).not.toHaveBeenCalledWith('Failed to bind directory account', expect.anything())
  })
})
