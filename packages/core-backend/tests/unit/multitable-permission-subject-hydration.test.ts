/**
 * 路由级(mock pool)守卫契约 —— 必须留在 tests/unit,因为默认 vitest.config.ts 会收集
 * tests/unit,而 tests/integration/multitable-sheet-permissions.api.test.ts 被 exclude
 * 列表显式排除、也没有任何 workflow 跑它(CI 不可见)。本文件把两件事钉进 required 的
 * test (20.x) 门:
 *
 *   A. 权限主体水合:三条列表主查询只跑一次、不含 r.description(roles 表从来没有
 *      description 列)、保留 LEFT JOIN platform_member_groups g,成员组显示组名而非裸 UUID。
 *   B. PG locale 守卫:降级以 SQLSTATE 为主信号(42P01/42703),中文 locale
 *      (222 测试机 lc_messages=Chinese (Simplified)_China.936)下同样命中;
 *      并且降级作用域只覆盖成员组目录 —— 标识符对不上(如 r.name)必须原样抛,
 *      成 500,绝不能静默去跑第二条降级 SQL。
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type QueryResult = { rows: any[]; rowCount?: number }
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const MEMBER_GROUP_ID = '11111111-2222-3333-4444-555555555555'

function undefinedColumn(columnName: string): Error {
  return Object.assign(new Error(`column ${columnName} does not exist`), { code: '42703' })
}

function undefinedColumnZh(columnName: string): Error {
  return Object.assign(new Error(`字段 ${columnName} 不存在`), { code: '42703' })
}

function undefinedTableZh(tableName: string): Error {
  return Object.assign(new Error(`关系 "${tableName}" 不存在`), { code: '42P01' })
}

async function createApp(queryHandler: QueryHandler) {
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

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // Sheet liveness read (soft delete) — every sheet-addressed route asks first.
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ deleted_at: null }], rowCount: 1 }
    }
    return queryHandler(sql, params)
  })
  const pool = { query, transaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = {
      id: 'user_sheet_acl_1',
      roles: [],
      perms: ['multitable:read'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, pool }
}

/** 共享前置:sheet/view/record 行 + sheet 级 admin 授权 + approval 投影读守卫的空查。 */
function sheetScaffold(sql: string, params?: unknown[]): QueryResult | null {
  if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
    expect(params).toEqual(['sheet_ops'])
    return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
  }
  if (sql.includes('SELECT id, sheet_id FROM meta_views WHERE id = $1')) {
    expect(params).toEqual(['view_ops'])
    return { rows: [{ id: 'view_ops', sheet_id: 'sheet_ops' }] }
  }
  if (sql.includes('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
    expect(params).toEqual(['record_1', 'sheet_ops'])
    return { rows: [{ id: 'record_1' }] }
  }
  if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
    return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:admin', subject_type: 'user' }] }
  }
  if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
  if (/^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql)) return { rows: [], rowCount: 0 }
  return null
}

function memberGroupRow(extra: Record<string, unknown>) {
  return {
    subject_type: 'member-group',
    subject_id: MEMBER_GROUP_ID,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    created_by: 'user_sheet_acl_1',
    user_name: null,
    user_email: null,
    user_is_active: null,
    role_name: null,
    role_description: null,
    group_name: '备料组',
    group_description: '备料一线',
    ...extra,
  }
}

const ROUTES = [
  {
    name: 'field permissions',
    url: '/api/multitable/sheets/sheet_ops/field-permissions',
    marker: 'FROM field_permissions fp',
    row: () => memberGroupRow({ id: 'fp_1', sheet_id: 'sheet_ops', field_id: 'fld_amount', visible: true, read_only: false }),
    expectedItem: {
      id: 'fp_1',
      sheetId: 'sheet_ops',
      fieldId: 'fld_amount',
      subjectType: 'member-group',
      subjectId: MEMBER_GROUP_ID,
      subjectLabel: '备料组',
      subjectSubtitle: '备料一线',
      isActive: true,
      visible: true,
      readOnly: false,
    },
  },
  {
    name: 'view permissions',
    url: '/api/multitable/views/view_ops/permissions',
    marker: 'FROM meta_view_permissions vp',
    row: () => memberGroupRow({ id: 'vp_1', view_id: 'view_ops', permission: 'read' }),
    expectedItem: {
      id: 'vp_1',
      viewId: 'view_ops',
      subjectType: 'member-group',
      subjectId: MEMBER_GROUP_ID,
      subjectLabel: '备料组',
      subjectSubtitle: '备料一线',
      isActive: true,
      permission: 'read',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  },
  {
    name: 'record permissions',
    url: '/api/multitable/sheets/sheet_ops/records/record_1/permissions',
    marker: 'FROM record_permissions rp',
    row: () => memberGroupRow({ id: 'rp_1', sheet_id: 'sheet_ops', record_id: 'record_1', access_level: 'read' }),
    expectedItem: {
      id: 'rp_1',
      sheetId: 'sheet_ops',
      recordId: 'record_1',
      subjectType: 'member-group',
      subjectId: MEMBER_GROUP_ID,
      accessLevel: 'read',
      label: '备料组',
      subtitle: '备料一线',
      isActive: true,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  },
] as const

describe('permission-subject hydration + PG locale guards (route level, mock pool)', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('../../src/rbac/service')
  })

  for (const route of ROUTES) {
    test(`${route.name}: 一次查询、不选 r.description、保留成员组 JOIN,成员组显示组名`, async () => {
      const { app, pool } = await createApp(async (sql, params) => {
        const scaffold = sheetScaffold(sql, params)
        if (scaffold) return scaffold
        if (sql.includes(route.marker)) return { rows: [route.row()] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      })

      const response = await request(app).get(route.url).expect(200)

      expect(response.body.data.items).toEqual([route.expectedItem])
      const calls = pool.query.mock.calls.filter(([sql]) => String(sql).includes(route.marker))
      expect(calls).toHaveLength(1)
      expect(String(calls[0]?.[0])).not.toContain('r.description')
      expect(String(calls[0]?.[0])).toContain('LEFT JOIN platform_member_groups g')
    })

    test(`${route.name}: 中文 42703「字段 g.description 不存在」照样降级(丢 g JOIN,保留 r JOIN)`, async () => {
      const { app, pool } = await createApp(async (sql, params) => {
        const scaffold = sheetScaffold(sql, params)
        if (scaffold) return scaffold
        if (sql.includes(route.marker) && sql.includes('LEFT JOIN platform_member_groups g')) {
          throw undefinedColumnZh('g.description')
        }
        if (sql.includes(route.marker)) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      })

      const response = await request(app).get(route.url).expect(200)

      expect(response.body.data.items).toEqual([])
      const calls = pool.query.mock.calls.filter(([sql]) => String(sql).includes(route.marker))
      expect(calls).toHaveLength(2)
      expect(String(calls[1]?.[0])).not.toContain('LEFT JOIN platform_member_groups g')
      // 降级只丢成员组目录:roles JOIN 必须还在,角色主体仍显示角色名。
      expect(String(calls[1]?.[0])).toContain('LEFT JOIN roles r')
    })

    test(`${route.name}: 中文 42P01「关系 platform_member_groups 不存在」照样降级`, async () => {
      const { app, pool } = await createApp(async (sql, params) => {
        const scaffold = sheetScaffold(sql, params)
        if (scaffold) return scaffold
        if (sql.includes(route.marker) && sql.includes('LEFT JOIN platform_member_groups g')) {
          throw undefinedTableZh('platform_member_groups')
        }
        if (sql.includes(route.marker)) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      })

      await request(app).get(route.url).expect(200)
      const calls = pool.query.mock.calls.filter(([sql]) => String(sql).includes(route.marker))
      expect(calls).toHaveLength(2)
    })

    // 边界(负向):降级的作用域是成员组目录,不是「任何 42703」。别的标识符缺列说明
    // 主查询本身写错了/schema 另有问题,必须原样抛成 500,而不是静默跑第二条 SQL。
    // 白名单一旦被放宽成「任何 42703 都降级」,这两条立刻红。
    for (const [label, makeError] of [
      ['英文', () => undefinedColumn('r.name')],
      ['中文', () => undefinedColumnZh('r.name')],
    ] as const) {
      test(`${route.name}: ${label} 42703「r.name」不在降级白名单内 → 500,只查一次`, async () => {
        const { app, pool } = await createApp(async (sql, params) => {
          const scaffold = sheetScaffold(sql, params)
          if (scaffold) return scaffold
          if (sql.includes(route.marker)) throw makeError()
          throw new Error(`Unhandled SQL in test: ${sql}`)
        })

        const response = await request(app).get(route.url).expect(500)

        expect(response.body.error.code).toBe('INTERNAL_ERROR')
        const calls = pool.query.mock.calls.filter(([sql]) => String(sql).includes(route.marker))
        expect(calls).toHaveLength(1)
      })
    }
  }

  // getDbNotReadyMessage 也必须先看 SQLSTATE:中文 locale 下缺表散文是「关系 x 不存在」,
  // 英文整句匹配漏判会把 pre-migration 的 DB 变成 500(而不是可自愈的 503 DB_NOT_READY)。
  test('中文 42P01 缺 meta 表 → 503 DB_NOT_READY(不是 500)', async () => {
    const { app } = await createApp(async (sql) => {
      if (sql.includes('FROM meta_sheets WHERE id = $1')) throw undefinedTableZh('meta_sheets')
      const scaffold = sheetScaffold(sql)
      if (scaffold) return scaffold
      throw new Error(`Unhandled SQL in test: ${sql}`)
    })

    const response = await request(app).get('/api/multitable/sheets/sheet_ops/field-permissions').expect(503)
    expect(response.body.error.code).toBe('DB_NOT_READY')
  })
})
