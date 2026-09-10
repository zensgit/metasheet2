/**
 * 自定义模板(「把这张 Base 存为模板」)路由级测试。
 *
 * 覆盖矩阵:
 *   C1 建 → 列 → 装:POST /templates 抽结构,GET /templates 把自定义模板与内置模板合并,
 *      POST /templates/:id/install 用自定义模板真的建出 base/sheet/field/view。
 *   C2 VALUES-FREE:整轮 SQL 一次都不碰 meta_records;落库的 definition 里没有任何记录值、
 *      没有任何源库 sheet/field/view id;link/公式字段降级成文本并给 warnings。
 *   C3 租户隔离:租户 A 建的模板,租户 B 既列不到、也装不了(404)、也删不掉(404)。
 *   C4 授权:只有 multitable:write 的用户建/删都 403;带 multitable:manage-schema 才 201。
 *   C5 可读性:源 Base 里读不到的表不会被抽进模板;一张都读不到按 Base 不存在回 404。
 *   C6 未迁移(SQLSTATE 42P01):GET /templates 退化成只有内置模板 + customTemplatesUnavailable。
 *   C7 x-tenant-id 兼容头:租户只认 req.authenticatedTenantId。
 *   C8 可见性:模板默认 private —— 同租户另一个 manage-schema 用户列不到/装不了/删不掉;
 *      显式 visibility:'tenant' 才全租户可见。
 *   C9 选项形状:生产落库形状是 {value,color}(见 C1),老的 {id,name} 脏数据仍兼容。
 *
 * Harness 沿用 multitable-template-dryrun-routes.test.ts 的 mock-pool 路由precedent:
 * 真 express + 真 univerMetaRouter,poolManager.get() 打桩成内存 store。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

import { usePinnedServer } from '../utils/pinned-server'

type QueryResult = { rows: any[]; rowCount?: number }

type SeedSheet = {
  id: string
  name: string
  description?: string | null
  fields: Array<{ id: string; name: string; type: string; property?: Record<string, unknown>; order: number }>
  views?: Array<{
    id: string
    name: string
    type: string
    group_info?: Record<string, unknown>
    hidden_field_ids?: string[]
    config?: Record<string, unknown>
  }>
}

type StoreOptions = {
  baseSheets?: SeedSheet[]
  /** spreadsheet_permissions 行(subject_type=user),用来构造「这张表你读不到」。 */
  sheetPermissions?: Array<{ sheet_id: string; perm_code: string }>
  /** true → 自定义模板表报 42P01(未迁移)。 */
  customTemplateTableMissing?: boolean
}

const SOURCE_BASE_ID = 'base_source'

function createStore(opts: StoreOptions = {}) {
  const seedSheets = opts.baseSheets ?? []
  const customTemplates: Array<Record<string, unknown>> = []
  const bases: Array<Record<string, unknown>> = [
    { id: SOURCE_BASE_ID, name: 'Ops Base', icon: 'table', color: '#0f766e', owner_id: null, workspace_id: null },
  ]
  const sheets: Array<Record<string, unknown>> = seedSheets.map((sheet) => ({
    id: sheet.id, base_id: SOURCE_BASE_ID, name: sheet.name, description: sheet.description ?? null,
  }))
  const fields: Array<Record<string, unknown>> = seedSheets.flatMap((sheet) =>
    sheet.fields.map((field) => ({
      id: field.id, sheet_id: sheet.id, name: field.name, type: field.type,
      property: field.property ?? {}, order: field.order,
    })),
  )
  const views: Array<Record<string, unknown>> = seedSheets.flatMap((sheet) =>
    (sheet.views ?? []).map((view) => ({
      id: view.id, sheet_id: sheet.id, name: view.name, type: view.type,
      filter_info: {}, sort_info: {}, group_info: view.group_info ?? {},
      hidden_field_ids: view.hidden_field_ids ?? [], config: view.config ?? {},
    })),
  )

  const sqlLog: Array<{ sql: string; params: unknown[] }> = []

  const undefinedTable = (table: string): never => {
    const err = new Error(`relation "${table}" does not exist`) as Error & { code?: string }
    err.code = '42P01'
    throw err
  }

  const handler = (sql: string, params: unknown[] = []): QueryResult => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    sqlLog.push({ sql: normalized, params })

    // ── 自定义模板表 ────────────────────────────────────────────────────
    if (normalized.includes('meta_multitable_custom_templates')) {
      if (opts.customTemplateTableMissing) undefinedTable('meta_multitable_custom_templates')
      if (normalized.startsWith('INSERT INTO meta_multitable_custom_templates')) {
        const [id, tenantId, workspaceId, name, description, category, icon, color, definition, createdBy, visibility] =
          params as [string, string | null, string | null, string, string, string, string, string, string, string | null, string]
        const row = {
          id, tenant_id: tenantId, workspace_id: workspaceId, name, description, category, icon, color,
          definition: JSON.parse(definition), created_by: createdBy, visibility,
          created_at: new Date().toISOString(), deleted_at: null,
        }
        customTemplates.push(row)
        return { rows: [row], rowCount: 1 }
      }
      // wire-vs-fixture:租户/软删这两道过滤由**被测 SQL 自己**决定要不要生效 ——
      // fake 只在语句里真的写了 `tenant_id IS NOT DISTINCT FROM` / `deleted_at IS NULL`
      // 时才照做。把守卫从 SQL 里删掉,这些用例就会红,而不是被 fake 兜住。
      const scopedByTenant = normalized.includes('tenant_id IS NOT DISTINCT FROM')
      const scopedByLive = normalized.includes('deleted_at IS NULL')
      // 可见性谓词同样 wire-vs-fixture:被测 SQL 里真写了
      // `(visibility = 'tenant' OR created_by = $n)` 时 fake 才照做。把谓词从 SQL 删掉,
      // C8 就会红 —— 而不是被 fake 兜住。
      const scopedByVisibility = normalized.includes("(visibility = 'tenant' OR created_by =")
      const matches = (item: Record<string, unknown>, tenantId: string | null, viewerId?: string | null): boolean =>
        (!scopedByLive || item.deleted_at === null)
        && (!scopedByTenant || (item.tenant_id ?? null) === (tenantId ?? null))
        && (!scopedByVisibility || item.visibility === 'tenant' || item.created_by === viewerId)

      if (normalized.startsWith('UPDATE meta_multitable_custom_templates')) {
        const [id, tenantId, viewerId] = params as [string, string | null, string | undefined]
        const row = customTemplates.find((item) => item.id === id && matches(item, tenantId, viewerId))
        if (!row) return { rows: [], rowCount: 0 }
        row.deleted_at = new Date().toISOString()
        return { rows: [], rowCount: 1 }
      }
      if (normalized.includes('WHERE id = $1')) {
        const [id, tenantId, viewerId] = params as [string, string | null, string | undefined]
        return { rows: customTemplates.filter((item) => item.id === id && matches(item, tenantId, viewerId)) }
      }
      const [tenantId, viewerId] = params as [string | null, string | undefined]
      return { rows: customTemplates.filter((item) => matches(item, tenantId, viewerId)) }
    }

    // ── 源 Base 结构表 ─────────────────────────────────────────────────
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: bases.filter((base) => base.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_bases')) {
      const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
      if (bases.some((base) => base.id === id)) return { rows: [], rowCount: 0 }
      const base = { id, name, icon, color, owner_id: ownerId, workspace_id: workspaceId }
      bases.push(base)
      return { rows: [base], rowCount: 1 }
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_sheets') && normalized.includes('WHERE base_id = $1')) {
      const [baseId] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.base_id === baseId) }
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description] = params as [string, string, string, string | null]
      if (sheets.some((sheet) => sheet.id === id)) return { rows: [], rowCount: 0 }
      sheets.push({ id, base_id: baseId, name, description })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('FROM meta_fields') && normalized.includes('sheet_id = ANY($1::text[])')) {
      const [sheetIds] = params as [string[]]
      const idSet = new Set(sheetIds)
      return {
        rows: fields
          .filter((field) => idSet.has(field.sheet_id as string))
          .sort((a, b) => (a.order as number) - (b.order as number)),
      }
    }
    if (normalized.includes('FROM meta_fields') && normalized.includes('WHERE id = $1 AND sheet_id = $2')) {
      const [fieldId, sheetId] = params as [string, string]
      return { rows: fields.filter((field) => field.id === fieldId && field.sheet_id === sheetId) }
    }
    if (normalized.includes('FROM meta_fields') && normalized.includes('id = ANY($2::text[])')) {
      const [sheetId, ids] = params as [string, string[]]
      const idSet = new Set(ids)
      return {
        rows: fields
          .filter((field) => field.sheet_id === sheetId && idSet.has(field.id as string))
          .sort((a, b) => (a.order as number) - (b.order as number)),
      }
    }
    if (normalized.startsWith('INSERT INTO meta_fields')) {
      const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      fields.push({ id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('FROM meta_views') && normalized.includes('sheet_id = ANY($1::text[])')) {
      const [sheetIds] = params as [string[]]
      const idSet = new Set(sheetIds)
      return { rows: views.filter((view) => idSet.has(view.sheet_id as string)) }
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: views.filter((view) => view.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_views')) {
      const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson] =
        params as [string, string, string, string, string, string, string, string, string]
      if (views.some((view) => view.id === id)) return { rows: [], rowCount: 0 }
      views.push({
        id, sheet_id: sheetId, name, type,
        filter_info: JSON.parse(filterInfoJson), sort_info: JSON.parse(sortInfoJson),
        group_info: JSON.parse(groupInfoJson), hidden_field_ids: JSON.parse(hiddenFieldIdsJson),
        config: JSON.parse(configJson),
      })
      return { rows: [], rowCount: 1 }
    }

    // ── 表级授权(非管理员走这条) ─────────────────────────────────────
    if (normalized.includes('FROM spreadsheet_permissions')) {
      const [, sheetIds] = params as [string, string[]]
      const idSet = new Set(sheetIds)
      return {
        rows: (opts.sheetPermissions ?? [])
          .filter((row) => idSet.has(row.sheet_id))
          .map((row) => ({ sheet_id: row.sheet_id, perm_code: row.perm_code, subject_type: 'user' })),
      }
    }

    // 其它只读查询(审批/e-learning 投影探针等)一律「没有」。写操作没有兜底 —— 未预期的
    // 写会炸出来,这正是 values-free 断言想看到的行为。
    if (normalized.startsWith('SELECT') || normalized.startsWith('WITH')) return { rows: [] }
    throw new Error(`Unhandled SQL in test: ${normalized}`)
  }

  return { handler, sqlLog, customTemplates, bases, sheets, fields, views }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params))
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const MANAGER_PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']
const WRITER_PERMS = ['multitable:read', 'multitable:write']

async function createApp(
  handler: (sql: string, params?: unknown[]) => QueryResult,
  opts: { perms?: string[]; tenantId?: string; userId?: string; userTenantId?: string } = {},
) {
  const perms = opts.perms ?? MANAGER_PERMS
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(perms),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: opts.userId ?? 'user_tpl',
      roles: [],
      permissions: perms,
      perms,
      // 只有 userTenantId 用例会填 —— 它模拟 x-tenant-id 兼容头把租户塞进 req.user 的情形。
      ...(opts.userTenantId ? { tenantId: opts.userTenantId } : {}),
    } as Express.Request['user']
    if (opts.tenantId) req.authenticatedTenantId = opts.tenantId
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

const OPS_SHEETS: SeedSheet[] = [
  {
    id: 'sheet_orders',
    name: '订单',
    fields: [
      { id: 'fld_title', name: '订单号', type: 'string', order: 0 },
      {
        // 生产形状:所有写入口都过 sanitizeFieldProperty → extractSelectOptions,
        // 落库的 option 只有 {value,color} —— name/label 在入库那一刻就被丢掉了。
        // 用假形状写 fixture 会给一个「选项存下来了」的假绿。
        id: 'fld_status', name: '状态', type: 'select', order: 1,
        property: {
          options: [{ value: '待处理', color: '#f97316' }, { value: '已完成' }],
          defaultValue: '待处理',
        },
      },
      { id: 'fld_amount', name: '金额', type: 'number', order: 2, property: { precision: 2, defaultValue: 8888 } },
      {
        id: 'fld_link', name: '关联客户', type: 'link', order: 3,
        property: { foreignSheetId: 'sheet_customers_in_source_db', limitSingleRecord: true },
      },
      // 模板系统装不下的生产类型(27 种字段里有 11 种进不了 16 种白名单)。必须出声。
      { id: 'fld_owner', name: '负责人', type: 'person', order: 4, property: { multiple: false } },
      { id: 'fld_score', name: '评分', type: 'rating', order: 5, property: { max: 5 } },
    ],
    views: [
      {
        id: 'viw_grid', name: '全部订单', type: 'grid',
        hidden_field_ids: ['fld_amount'], config: { titleFieldId: 'fld_title' },
      },
      { id: 'viw_board', name: '状态看板', type: 'kanban', group_info: { fieldId: 'fld_status' } },
    ],
  },
  {
    id: 'sheet_secret',
    name: '内部成本',
    fields: [{ id: 'fld_cost', name: '成本', type: 'number', order: 0 }],
    views: [{ id: 'viw_secret', name: '成本表', type: 'grid' }],
  },
]

const pinned = usePinnedServer()

describe('自定义模板路由 —— 把 Base 存为模板', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('C1/C2: 建 → 列 → 装,且抽取只碰结构表(零 meta_records、零源 id、零记录值)', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '订单模板', description: '从订单库存下来的结构', category: '运营' })

    expect(created.status).toBe(201)
    const template = created.body.data.template
    expect(template.id.startsWith('mtpl_')).toBe(true)
    expect(template.custom).toBe(true)
    expect(template.name).toBe('订单模板')
    // link 字段依赖源库另一张表 → 降级成文本并给人话说明
    expect(created.body.data.warnings.join('\n')).toContain('关联客户')
    const orders = template.sheets.find((sheet: any) => sheet.name === '订单')
    expect(orders.fields.map((f: any) => f.name)).toEqual(['订单号', '状态', '金额', '关联客户', '负责人', '评分'])
    expect(orders.fields.find((f: any) => f.name === '关联客户').type).toBe('string')
    // 生产形状 {value,color} 的下拉选项必须原样存下来(值是结构,不是记录值),颜色也保住
    expect(orders.fields.find((f: any) => f.name === '状态').options).toEqual(['待处理', '已完成'])
    expect(orders.fields.find((f: any) => f.name === '状态').property.options).toEqual([
      { value: '待处理', color: '#f97316' },
      { value: '已完成' },
    ])
    // 白名单外的类型(person/rating)降级成文本,并且**出声**
    expect(orders.fields.find((f: any) => f.name === '负责人').type).toBe('string')
    expect(orders.fields.find((f: any) => f.name === '评分').type).toBe('string')
    const warningText = created.body.data.warnings.join('\n')
    expect(warningText).toContain('负责人')
    expect(warningText).toContain('person')
    expect(warningText).toContain('评分')
    expect(warningText).toContain('rating')
    // 视图结构位按局部 id 重挂
    const board = orders.views.find((v: any) => v.name === '状态看板')
    expect(board.groupByFieldId).toBe(orders.fields[1].id)

    // VALUES-FREE 1:整轮 SQL 没有一条碰 meta_records
    expect(store.sqlLog.filter((entry) => entry.sql.includes('meta_records'))).toEqual([])
    // VALUES-FREE 2:落库 JSON 里没有源库 id、没有 defaultValue 这类值、没有外表指针
    const persisted = JSON.stringify(store.customTemplates[0].definition)
    for (const leak of ['sheet_orders', 'fld_title', 'fld_status', 'viw_grid', 'sheet_customers_in_source_db', '8888', 'defaultValue', 'foreignSheetId', 'multiple']) {
      expect(persisted).not.toContain(leak)
    }
    // 白名单保留了真正的结构位
    expect(persisted).toContain('precision')

    // GET 合并:自定义在前,内置仍在
    const listed = await request(pinned.url()).get('/api/multitable/templates')
    expect(listed.status).toBe(200)
    expect(listed.body.data.templates[0].id).toBe(template.id)
    expect(listed.body.data.templates.some((tpl: any) => tpl.id === 'project-tracker')).toBe(true)
    expect(listed.body.data.customTemplatesUnavailable).toBeUndefined()

    // 装:自定义模板真的建出 base/sheet/field/view
    const installed = await request(pinned.url())
      .post(`/api/multitable/templates/${template.id}/install`)
      .send({ baseName: '九月订单' })
    expect(installed.status).toBe(201)
    expect(installed.body.data.base.name).toBe('九月订单')
    expect(installed.body.data.fields.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(['订单号', '状态', '金额', '关联客户', '负责人', '评分']),
    )
    // 装出来的表:下拉选项 + 颜色都在(provisioning 按 value 把颜色对回去)
    const statusField = store.fields.find((f: any) => f.name === '状态' && f.sheet_id !== 'sheet_orders') as any
    expect(statusField.property.options).toEqual([
      { value: '待处理', color: '#f97316' },
      { value: '已完成' },
    ])
    expect(installed.body.data.views.map((v: any) => v.name)).toEqual(
      expect.arrayContaining(['全部订单', '状态看板']),
    )
    // 装出来的 base 与源 base 不是同一个,源结构一行没改
    expect(installed.body.data.base.id).not.toBe(SOURCE_BASE_ID)
  })

  it('C3: 租户隔离 —— B 租户既列不到、也装不了、也删不掉 A 租户的模板', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const appA = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appA.app)
    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: 'A 租户模板' })
    expect(created.status).toBe(201)
    const templateId = created.body.data.template.id

    const appB = await createApp(store.handler, { tenantId: 'tenant_b', userId: 'user_b' })
    pinned.setApp(appB.app)

    const listedB = await request(pinned.url()).get('/api/multitable/templates')
    expect(listedB.body.data.templates.some((tpl: any) => tpl.id === templateId)).toBe(false)

    const installB = await request(pinned.url()).post(`/api/multitable/templates/${templateId}/install`).send({})
    expect(installB.status).toBe(404)

    const dryRunB = await request(pinned.url()).post(`/api/multitable/templates/${templateId}/dry-run`).send({})
    expect(dryRunB.status).toBe(404)

    const deleteB = await request(pinned.url()).delete(`/api/multitable/templates/${templateId}`)
    expect(deleteB.status).toBe(404)
    expect(store.customTemplates[0].deleted_at).toBeNull()

    // 无租户声明的会话同样看不到 tenant_a 的模板(NULL 只匹 NULL)
    const appNull = await createApp(store.handler)
    pinned.setApp(appNull.app)
    const listedNull = await request(pinned.url()).get('/api/multitable/templates')
    expect(listedNull.body.data.templates.some((tpl: any) => tpl.id === templateId)).toBe(false)

    // A 自己删得掉,删完列表里就没了
    const appA2 = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appA2.app)
    const deleteA = await request(pinned.url()).delete(`/api/multitable/templates/${templateId}`)
    expect(deleteA.status).toBe(200)
    const listedA = await request(pinned.url()).get('/api/multitable/templates')
    expect(listedA.body.data.templates.some((tpl: any) => tpl.id === templateId)).toBe(false)
  })

  it('C4: 只有 multitable:write 的用户建/删都 403;内置模板永远删不掉', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const writer = await createApp(store.handler, { perms: WRITER_PERMS, tenantId: 'tenant_a' })
    pinned.setApp(writer.app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '越权模板' })
    expect(created.status).toBe(403)
    expect(created.body.error.code).toBe('FORBIDDEN')
    expect(store.customTemplates).toHaveLength(0)

    const removed = await request(pinned.url()).delete('/api/multitable/templates/mtpl_whatever')
    expect(removed.status).toBe(403)

    const manager = await createApp(store.handler, { perms: MANAGER_PERMS, tenantId: 'tenant_a' })
    pinned.setApp(manager.app)
    const builtin = await request(pinned.url()).delete('/api/multitable/templates/project-tracker')
    expect(builtin.status).toBe(403)
    expect(builtin.body.error.message).toContain('Built-in')
  })

  it('C5: 读不到的表不进模板;一张都读不到按 Base 不存在回 404', async () => {
    const partial = createStore({
      baseSheets: OPS_SHEETS,
      sheetPermissions: [{ sheet_id: 'sheet_secret', perm_code: 'sheet:no-access' }],
    })
    const appPartial = await createApp(partial.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appPartial.app)
    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '只含可读表' })
    expect(created.status).toBe(201)
    expect(created.body.data.template.sheets.map((s: any) => s.name)).toEqual(['订单'])

    const blocked = createStore({
      baseSheets: OPS_SHEETS,
      sheetPermissions: [
        { sheet_id: 'sheet_orders', perm_code: 'sheet:no-access' },
        { sheet_id: 'sheet_secret', perm_code: 'sheet:no-access' },
      ],
    })
    const appBlocked = await createApp(blocked.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appBlocked.app)
    const refused = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '全不可读' })
    expect(refused.status).toBe(404)
    expect(blocked.customTemplates).toHaveLength(0)

    // 不存在的 Base 同样 404
    const missing = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: 'base_nope', name: 'x' })
    expect(missing.status).toBe(404)
  })

  it('C7: 无租户声明的会话即使 req.user.tenantId=tenant_a(x-tenant-id 兼容头)也拿不到 A 的模板', async () => {
    // 复现 x-tenant-id 请求头洞的形状:token 里没有租户声明,但 req.user.tenantId 被兼容头
    // 填成了别人的租户。租户只认 req.authenticatedTenantId,所以这个会话的租户是 NULL,
    // 只能看到同样 NULL 的行 —— 看不到、装不了、删不掉 tenant_a 的模板。
    const store = createStore({ baseSheets: OPS_SHEETS })
    const appA = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appA.app)
    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: 'A 租户模板' })
    expect(created.status).toBe(201)
    const templateId = created.body.data.template.id

    const spoofed = await createApp(store.handler, { userTenantId: 'tenant_a', userId: 'user_spoof' })
    pinned.setApp(spoofed.app)

    const listed = await request(pinned.url()).get('/api/multitable/templates')
    expect(listed.status).toBe(200)
    expect(listed.body.data.templates.some((tpl: any) => tpl.id === templateId)).toBe(false)

    const install = await request(pinned.url()).post(`/api/multitable/templates/${templateId}/install`).send({})
    expect(install.status).toBe(404)

    const removed = await request(pinned.url()).delete(`/api/multitable/templates/${templateId}`)
    expect(removed.status).toBe(404)
    expect(store.customTemplates[0].deleted_at).toBeNull()

    // 反过来也一样:这个会话自己建的模板落在 NULL 租户,tenant_a 看不到。
    const mine = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '无租户模板' })
    expect(mine.status).toBe(201)
    const appA2 = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appA2.app)
    const listedA = await request(pinned.url()).get('/api/multitable/templates')
    expect(listedA.body.data.templates.some((tpl: any) => tpl.id === mine.body.data.template.id)).toBe(false)
  })

  it('C6: 自定义模板表还没迁移(42P01)时,模板中心退化成只有内置模板;写入口照样 503 不装死', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS, customTemplateTableMissing: true })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const listed = await request(pinned.url()).get('/api/multitable/templates')
    expect(listed.status).toBe(200)
    expect(listed.body.data.customTemplatesUnavailable).toBe(true)
    expect(listed.body.data.templates.some((tpl: any) => tpl.id === 'project-tracker')).toBe(true)
    expect(listed.body.data.templates.some((tpl: any) => String(tpl.id).startsWith('mtpl_'))).toBe(false)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '未迁移' })
    expect(created.status).toBe(503)
    expect(created.body.error.code).toBe('DB_NOT_READY')

    // 内置模板的安装路径不受影响
    const installed = await request(pinned.url())
      .post('/api/multitable/templates/project-tracker/install')
      .send({ baseName: '内置仍可用' })
    expect(installed.status).toBe(201)
  })

  it('C8: 模板默认只有建它的人可见 —— 同租户另一个 manage-schema 用户列不到/装不了/删不掉;勾了共享才全租户可见', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const author = await createApp(store.handler, { tenantId: 'tenant_a', userId: 'user_author' })
    pinned.setApp(author.app)

    // 不传 visibility → private(服务端默认收紧,不靠前端)
    const priv = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '私有模板' })
    expect(priv.status).toBe(201)
    expect(priv.body.data.template.visibility).toBe('private')
    const privateId = priv.body.data.template.id

    const shared = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '共享模板', visibility: 'tenant' })
    expect(shared.status).toBe(201)
    expect(shared.body.data.template.visibility).toBe('tenant')
    const sharedId = shared.body.data.template.id

    // 作者自己两张都看得见
    const listedAuthor = await request(pinned.url()).get('/api/multitable/templates')
    const authorIds = listedAuthor.body.data.templates.map((tpl: any) => tpl.id)
    expect(authorIds).toContain(privateId)
    expect(authorIds).toContain(sharedId)

    // 同租户的另一个人(同样有 manage-schema):只看得见共享的那张
    const colleague = await createApp(store.handler, { tenantId: 'tenant_a', userId: 'user_colleague' })
    pinned.setApp(colleague.app)
    const listedColleague = await request(pinned.url()).get('/api/multitable/templates')
    const colleagueIds = listedColleague.body.data.templates.map((tpl: any) => tpl.id)
    expect(colleagueIds).toContain(sharedId)
    expect(colleagueIds).not.toContain(privateId)
    // 表名/字段名也没有从别的渠道漏出去
    expect(JSON.stringify(listedColleague.body.data.templates)).not.toContain('私有模板')

    // 猜到 id 也装不了、dry-run 不了、删不掉(一律 404,不区分「不存在」和「不是你的」)
    expect((await request(pinned.url()).post(`/api/multitable/templates/${privateId}/install`).send({})).status).toBe(404)
    expect((await request(pinned.url()).post(`/api/multitable/templates/${privateId}/dry-run`).send({})).status).toBe(404)
    expect((await request(pinned.url()).delete(`/api/multitable/templates/${privateId}`)).status).toBe(404)
    expect(store.customTemplates.find((row) => row.id === privateId)?.deleted_at).toBeNull()

    // 共享的那张同事装得了
    const installShared = await request(pinned.url())
      .post(`/api/multitable/templates/${sharedId}/install`)
      .send({ baseName: '同事的库' })
    expect(installShared.status).toBe(201)
  })

  it('C9: 历史脏数据里的 {id,name} 老形状仍能兼容读出选项(生产形状是 {value,color})', async () => {
    const store = createStore({
      baseSheets: [{
        id: 'sheet_legacy',
        name: '老表',
        fields: [
          {
            id: 'fld_legacy', name: '状态', type: 'select', order: 0,
            property: { options: [{ id: 'opt_1', name: '待处理' }, { id: 'opt_2', label: '已完成' }, '直接是字符串'] },
          },
        ],
        views: [{ id: 'viw_legacy', name: '表格', type: 'grid' }],
      }],
    })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '老形状' })
    expect(created.status).toBe(201)
    const field = created.body.data.template.sheets[0].fields[0]
    expect(field.options).toEqual(['待处理', '已完成', '直接是字符串'])
    // 老形状里的源库 option id 不进模板
    expect(JSON.stringify(store.customTemplates[0].definition)).not.toContain('opt_1')
  })
})
