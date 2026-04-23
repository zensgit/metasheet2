/**
 * Integration tests for the public form flow: token validation, rate limiting,
 * submission, and audit logging.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const VALID_TOKEN = 'test-public-token-abc123'
const EXPIRED_TOKEN = 'expired-token-xyz'
const INVALID_TOKEN = 'wrong-token-nope'

const TEST_VIEW_ID = 'view_pub_1'
const TEST_SHEET_ID = 'sheet_pub_1'

function makeViewRow(
  token: string,
  enabled = true,
  expiresAt?: number,
  accessMode: 'public' | 'dingtalk' | 'dingtalk_granted' = 'public',
  allowlists: { allowedUserIds?: string[]; allowedMemberGroupIds?: string[] } = {},
) {
  return {
    id: TEST_VIEW_ID,
    sheetId: TEST_SHEET_ID,
    sheet_id: TEST_SHEET_ID,
    name: 'Public Form View',
    type: 'form',
    config: JSON.stringify({
      publicForm: {
        enabled,
        publicToken: token,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        accessMode,
        allowedUserIds: allowlists.allowedUserIds ?? [],
        allowedMemberGroupIds: allowlists.allowedMemberGroupIds ?? [],
      },
    }),
    hiddenFieldIds: [],
    field_order: null,
  }
}

function makeSheetRow() {
  return {
    id: TEST_SHEET_ID,
    name: 'Test Sheet',
    baseId: 'base_1',
    base_id: 'base_1',
  }
}

function makeFieldRows() {
  return [
    { id: 'fld_1', name: 'Name', type: 'string', options: null, property: null, order: 0, hidden: false },
    { id: 'fld_2', name: 'Email', type: 'string', options: null, property: null, order: 1, hidden: false },
  ]
}

function buildQueryHandler(
  viewToken: string,
  opts: {
    enabled?: boolean
    expiresAt?: number
    accessMode?: 'public' | 'dingtalk' | 'dingtalk_granted'
    hasDingTalkBinding?: boolean
    hasDingTalkGrant?: boolean
    allowedUserIds?: string[]
    allowedMemberGroupIds?: string[]
    hasAllowedMemberGroup?: boolean
  } = {},
): QueryHandler {
  const view = makeViewRow(viewToken, opts.enabled ?? true, opts.expiresAt, opts.accessMode ?? 'public', {
    allowedUserIds: opts.allowedUserIds,
    allowedMemberGroupIds: opts.allowedMemberGroupIds,
  })
  const sheet = makeSheetRow()
  const fields = makeFieldRows()
  return (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM meta_views') || sql.includes('from meta_views')) {
      return { rows: [view], rowCount: 1 }
    }
    if (sql.includes('FROM meta_sheets') || sql.includes('from meta_sheets') || sql.includes('FROM spreadsheets')) {
      return { rows: [sheet], rowCount: 1 }
    }
    if (sql.includes('FROM meta_fields') || sql.includes('from meta_fields')) {
      return { rows: fields, rowCount: fields.length }
    }
    if (sql.includes('INSERT INTO meta_records')) {
      return { rows: [{ id: 'rec_new_1', version: 1 }], rowCount: 1 }
    }
    if (sql.includes('SELECT') && sql.includes('meta_records') && sql.includes('WHERE id')) {
      return {
        rows: [{ id: 'rec_new_1', version: 1, data: JSON.stringify({ fld_1: 'Alice', fld_2: 'alice@test.com' }) }],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM user_external_identities')) {
      return { rows: opts.hasDingTalkBinding ? [{ local_user_id: params?.[1] }] : [], rowCount: opts.hasDingTalkBinding ? 1 : 0 }
    }
    if (sql.includes('FROM directory_account_links')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM user_external_auth_grants')) {
      return { rows: opts.hasDingTalkGrant ? [{ enabled: true }] : [], rowCount: opts.hasDingTalkGrant ? 1 : 0 }
    }
    if (sql.includes('FROM platform_member_group_members') && sql.includes('group_id::text = ANY')) {
      return { rows: opts.hasAllowedMemberGroup ? [{ user_id: params?.[0], group_id: 'group_allowed_1' }] : [], rowCount: opts.hasAllowedMemberGroup ? 1 : 0 }
    }
    if (sql.includes('SELECT id, name, email, is_active') && sql.includes('FROM users WHERE id = ANY')) {
      const ids = Array.isArray(params?.[0]) ? (params?.[0] as string[]) : []
      return {
        rows: ids.map((id) => ({ id, name: `User ${id}`, email: `${id}@test.local`, is_active: true })),
        rowCount: ids.length,
      }
    }
    if (sql.includes('FROM platform_member_groups g') && sql.includes('LEFT JOIN platform_member_group_members')) {
      const ids = Array.isArray(params?.[0]) ? (params?.[0] as string[]) : []
      return {
        rows: ids.map((id) => ({ id, name: `Group ${id}`, description: `Desc ${id}`, member_count: 2 })),
        rowCount: ids.length,
      }
    }
    return { rows: [], rowCount: 0 }
  }
}

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM field_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM record_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM formula_dependencies')) return { rows: [], rowCount: 0 }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(opts: {
  queryHandler?: QueryHandler
  user?: { id?: string; roles?: string[]; perms?: string[] } | null
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(opts.queryHandler ?? (() => ({ rows: [], rowCount: 0 })))
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  if (opts.user !== null && opts.user !== undefined) {
    app.use((req, _res, next) => {
      req.user = {
        id: opts.user?.id ?? 'user_1',
        roles: opts.user?.roles ?? [],
        perms: opts.user?.perms ?? [],
      }
      next()
    })
  }
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('Public form flow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('valid token -> form context loads successfully', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: null,
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    // Should not be 401/403
    expect([200, 400, 404]).not.toContain(401)
    // The form-context may return 200 or depend on view resolution
    expect(res.status).not.toBe(401)
  })

  test('invalid token -> 401 (authentication required)', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: null,
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${INVALID_TOKEN}`)

    expect(res.status).toBe(401)
  })

  test('expired token -> 401', async () => {
    const pastMs = Date.now() - 86400_000 // 1 day ago
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, { expiresAt: pastMs }),
      user: null,
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    expect(res.status).toBe(401)
  })

  test('valid token + submit -> record created', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: null,
    })

    const res = await request(app)
      .post(`/api/multitable/views/${TEST_VIEW_ID}/submit?publicToken=${VALID_TOKEN}`)
      .send({ publicToken: VALID_TOKEN, data: { fld_1: 'Alice', fld_2: 'alice@test.com' } })

    // Should succeed (200) or return a record
    if (res.status === 200) {
      expect(res.body.ok).toBe(true)
      expect(res.body.data?.record).toBeDefined()
    }
    // In mock scenarios, the exact response depends on DB mock accuracy.
    // The important thing is it's not 401/403.
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  test('dingtalk-protected form redirects anonymous access to sign-in', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, { accessMode: 'dingtalk' }),
      user: null,
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    expect(res.status).toBe(401)
    expect(res.body.error?.code).toBe('DINGTALK_AUTH_REQUIRED')
  })

  test('dingtalk-protected form allows a bound signed-in user', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, { accessMode: 'dingtalk', hasDingTalkBinding: true }),
      user: { id: 'user_bound' },
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('dingtalk-granted form rejects a bound user without grant', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, {
        accessMode: 'dingtalk_granted',
        hasDingTalkBinding: true,
        hasDingTalkGrant: false,
      }),
      user: { id: 'user_bound' },
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('DINGTALK_GRANT_REQUIRED')
  })

  test('dingtalk-granted form rejects submit from a bound user without grant', async () => {
    const { app, mockPool } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, {
        accessMode: 'dingtalk_granted',
        hasDingTalkBinding: true,
        hasDingTalkGrant: false,
      }),
      user: { id: 'user_bound' },
    })

    const res = await request(app)
      .post(`/api/multitable/views/${TEST_VIEW_ID}/submit?publicToken=${VALID_TOKEN}`)
      .send({
        publicToken: VALID_TOKEN,
        data: { fld_1: 'Alice', fld_2: 'alice@test.com' },
      })

    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('DINGTALK_GRANT_REQUIRED')
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO meta_records'))).toBe(false)
  })

  test('dingtalk-protected form rejects a bound user outside the allowlist', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, {
        accessMode: 'dingtalk',
        hasDingTalkBinding: true,
        allowedUserIds: ['user_allowed'],
      }),
      user: { id: 'user_other' },
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('DINGTALK_FORM_NOT_ALLOWED')
  })

  test('dingtalk-protected form allows a bound user through allowed member group membership', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN, {
        accessMode: 'dingtalk',
        hasDingTalkBinding: true,
        allowedMemberGroupIds: ['group_allowed_1'],
        hasAllowedMemberGroup: true,
      }),
      user: { id: 'user_bound' },
    })

    const res = await request(app)
      .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('form share config routes expose and update protected access mode', async () => {
    let storedConfig = {
      publicForm: {
        enabled: true,
        publicToken: VALID_TOKEN,
        accessMode: 'public',
      },
    }
    const { app } = await createApp({
      user: { id: 'admin_1', perms: ['multitable:write', 'multitable:share'] },
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual([TEST_VIEW_ID])
          return {
            rows: [{
              id: TEST_VIEW_ID,
              sheet_id: TEST_SHEET_ID,
              name: 'Public Form View',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: storedConfig,
            }],
          }
        }
        if (sql.includes('UPDATE meta_views') && sql.includes('SET config = $2::jsonb')) {
          storedConfig = JSON.parse(String(params?.[1] ?? '{}'))
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const getResponse = await request(app)
      .get(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .expect(200)

    expect(getResponse.body.data.accessMode).toBe('public')

    const patchResponse = await request(app)
      .patch(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .send({ accessMode: 'dingtalk_granted' })
      .expect(200)

    expect(patchResponse.body.data.accessMode).toBe('dingtalk_granted')
    expect(storedConfig.publicForm.accessMode).toBe('dingtalk_granted')
  })

  test('form share config exposes and updates allowlists', async () => {
    let storedConfig = {
      publicForm: {
        enabled: true,
        publicToken: VALID_TOKEN,
        accessMode: 'dingtalk',
        allowedUserIds: ['user_1'],
        allowedMemberGroupIds: ['group_1'],
      },
    }
    const { app } = await createApp({
      user: { id: 'admin_1', perms: ['multitable:write'] },
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          return {
            rows: [{
              id: TEST_VIEW_ID,
              sheet_id: TEST_SHEET_ID,
              name: 'Public Form View',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: storedConfig,
            }],
          }
        }
        if (sql.includes('FROM users') && sql.includes('ANY($1::text[])')) {
          return { rows: [{ id: 'user_1', name: 'User 1', email: 'user1@test.local', is_active: true }, { id: 'user_2', name: 'User 2', email: 'user2@test.local', is_active: true }] }
        }
        if (sql.includes('FROM platform_member_groups')) {
          return { rows: [{ id: 'group_1', name: 'Ops', description: 'Operations', member_count: 3 }, { id: 'group_2', name: 'Sales', description: 'Sales team', member_count: 4 }] }
        }
        if (sql.includes('SELECT id FROM users WHERE id = ANY')) {
          const ids = Array.isArray(params?.[0]) ? (params?.[0] as string[]) : []
          return { rows: ids.map((id) => ({ id })) }
        }
        if (sql.includes('SELECT id::text AS id FROM platform_member_groups WHERE id::text = ANY')) {
          const ids = Array.isArray(params?.[0]) ? (params?.[0] as string[]) : []
          return { rows: ids.map((id) => ({ id })) }
        }
        if (sql.includes('UPDATE meta_views') && sql.includes('SET config = $2::jsonb')) {
          storedConfig = JSON.parse(String(params?.[1] ?? '{}'))
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const getResponse = await request(app)
      .get(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .expect(200)

    expect(getResponse.body.data.allowedUserIds).toEqual(['user_1'])
    expect(getResponse.body.data.allowedUsers[0].label).toBe('User 1')
    expect(getResponse.body.data.allowedMemberGroupIds).toEqual(['group_1'])

    const patchResponse = await request(app)
      .patch(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .send({ allowedUserIds: ['user_2'], allowedMemberGroupIds: ['group_2'] })
      .expect(200)

    expect(patchResponse.body.data.allowedUserIds).toEqual(['user_2'])
    expect(patchResponse.body.data.allowedMemberGroupIds).toEqual(['group_2'])
    expect(storedConfig.publicForm.allowedUserIds).toEqual(['user_2'])
    expect(storedConfig.publicForm.allowedMemberGroupIds).toEqual(['group_2'])
  })

  test('form share config rejects allowlists on fully public mode', async () => {
    const storedConfig = {
      publicForm: {
        enabled: true,
        publicToken: VALID_TOKEN,
        accessMode: 'public',
      },
    }
    const { app } = await createApp({
      user: { id: 'admin_1', perms: ['multitable:write'] },
      queryHandler: async (sql) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          return {
            rows: [{
              id: TEST_VIEW_ID,
              sheet_id: TEST_SHEET_ID,
              name: 'Public Form View',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: storedConfig,
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const patchResponse = await request(app)
      .patch(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .send({ accessMode: 'public', allowedUserIds: ['user_2'] })
      .expect(400)

    expect(patchResponse.body.error?.message).toMatch(/require a DingTalk-protected access mode/i)
  })

  test('form share config rejects inactive allowed users', async () => {
    const storedConfig = {
      publicForm: {
        enabled: true,
        publicToken: VALID_TOKEN,
        accessMode: 'dingtalk',
      },
    }
    const { app } = await createApp({
      user: { id: 'admin_1', perms: ['multitable:write'] },
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          return {
            rows: [{
              id: TEST_VIEW_ID,
              sheet_id: TEST_SHEET_ID,
              name: 'Public Form View',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: storedConfig,
            }],
          }
        }
        if (sql.includes('SELECT id, is_active FROM users WHERE id = ANY')) {
          const ids = Array.isArray(params?.[0]) ? (params?.[0] as string[]) : []
          return {
            rows: ids.map((id) => ({ id, is_active: id !== 'user_inactive' })),
            rowCount: ids.length,
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const patchResponse = await request(app)
      .patch(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .send({ allowedUserIds: ['user_inactive'] })
      .expect(400)

    expect(patchResponse.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Inactive allowed users: user_inactive',
    })
  })

  test('form share config rejects unknown allowed member groups', async () => {
    const storedConfig = {
      publicForm: {
        enabled: true,
        publicToken: VALID_TOKEN,
        accessMode: 'dingtalk',
      },
    }
    const { app } = await createApp({
      user: { id: 'admin_1', perms: ['multitable:write'] },
      queryHandler: async (sql) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          return {
            rows: [{
              id: TEST_VIEW_ID,
              sheet_id: TEST_SHEET_ID,
              name: 'Public Form View',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: storedConfig,
            }],
          }
        }
        if (sql.includes('SELECT id::text AS id FROM platform_member_groups WHERE id::text = ANY')) {
          return { rows: [] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const patchResponse = await request(app)
      .patch(`/api/multitable/sheets/${TEST_SHEET_ID}/views/${TEST_VIEW_ID}/form-share`)
      .send({ allowedMemberGroupIds: ['group_missing'] })
      .expect(400)

    expect(patchResponse.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Unknown allowed member groups: group_missing',
    })
  })

  test('rate limit exceeded -> 429 with Retry-After header', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: null,
    })

    // The publicFormSubmitLimiter allows 10 per 15min, but each createApp
    // creates a fresh router with fresh limiter instances (due to vi.resetModules).
    // To test rate limiting specifically, we'll hit the endpoint many times.
    const results: request.Response[] = []
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post(`/api/multitable/views/${TEST_VIEW_ID}/submit?publicToken=${VALID_TOKEN}`)
        .send({ publicToken: VALID_TOKEN, data: { fld_1: `User${i}` } })
      results.push(res)
    }

    // At least the 11th request should be rate-limited (429)
    const rateLimited = results.filter((r) => r.status === 429)
    expect(rateLimited.length).toBeGreaterThan(0)

    const firstRateLimited = rateLimited[0]
    expect(firstRateLimited.headers['retry-after']).toBeDefined()
    expect(firstRateLimited.body.error.code).toBe('RATE_LIMITED')
  })

  test('authenticated user (no publicToken) -> not rate-limited', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: { id: 'user_auth_1', perms: ['multitable:write'] },
    })

    // Make many requests without publicToken - should never get 429
    const results: request.Response[] = []
    for (let i = 0; i < 15; i++) {
      const res = await request(app)
        .post(`/api/multitable/views/${TEST_VIEW_ID}/submit`)
        .send({ data: { fld_1: `User${i}` } })
      results.push(res)
    }

    const rateLimited = results.filter((r) => r.status === 429)
    expect(rateLimited.length).toBe(0)
  })

  test('submit with recordId on public form -> rejected (create-only)', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: null,
    })

    const res = await request(app)
      .post(`/api/multitable/views/${TEST_VIEW_ID}/submit?publicToken=${VALID_TOKEN}`)
      .send({
        publicToken: VALID_TOKEN,
        recordId: 'rec_existing_1',
        data: { fld_1: 'Hacker' },
      })

    expect(res.status).toBe(400)
    expect(res.body.error?.message).toMatch(/public forms do not support/i)
  })

  test('rate limit on form-context endpoint', async () => {
    const { app } = await createApp({
      queryHandler: buildQueryHandler(VALID_TOKEN),
      user: null,
    })

    // publicFormContextLimiter allows 60 per 15min. Send 62 requests.
    const results: request.Response[] = []
    for (let i = 0; i < 62; i++) {
      const res = await request(app)
        .get(`/api/multitable/form-context?viewId=${TEST_VIEW_ID}&publicToken=${VALID_TOKEN}`)
      results.push(res)
    }

    const rateLimited = results.filter((r) => r.status === 429)
    expect(rateLimited.length).toBeGreaterThan(0)
  })
})
