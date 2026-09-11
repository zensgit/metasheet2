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
 *   F7-1 按表收窄:sheetIds 下推进 SQL 的 WHERE(第 51 张表也存得下),跨 Base 的 id 一张都匹配不到;
 *   F7-2 按字段收窄:fieldIds 在 extractTemplateSheets **之前**做交集,视图里不留悬空引用;
 *   F7-3 上限:sheetIds > 50 / fieldIds > 500 回 400,不静默截断;过滤后零字段回 400;
 *   F7-4 类型保真:13 种自洽类型原样保留(不再有「已转为文本列」),button 仍降级出声。
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
  /** 落在**另一个 Base** 上的表 —— 用来证明跨 Base 的 sheetId 一张都匹配不到。 */
  otherBaseSheets?: SeedSheet[]
}

const OTHER_BASE_ID = 'base_other'

const SOURCE_BASE_ID = 'base_source'

function createStore(opts: StoreOptions = {}) {
  const seedSheets = opts.baseSheets ?? []
  const customTemplates: Array<Record<string, unknown>> = []
  const bases: Array<Record<string, unknown>> = [
    { id: SOURCE_BASE_ID, name: 'Ops Base', icon: 'table', color: '#0f766e', owner_id: null, workspace_id: null },
  ]
  const otherSheets = opts.otherBaseSheets ?? []
  const sheets: Array<Record<string, unknown>> = [
    ...seedSheets.map((sheet) => ({
      id: sheet.id, base_id: SOURCE_BASE_ID, name: sheet.name, description: sheet.description ?? null,
    })),
    ...otherSheets.map((sheet) => ({
      id: sheet.id, base_id: OTHER_BASE_ID, name: sheet.name, description: sheet.description ?? null,
    })),
  ]
  const fields: Array<Record<string, unknown>> = [...seedSheets, ...otherSheets].flatMap((sheet) =>
    sheet.fields.map((field) => ({
      id: field.id, sheet_id: sheet.id, name: field.name, type: field.type,
      property: field.property ?? {}, order: field.order,
    })),
  )
  const views: Array<Record<string, unknown>> = [...seedSheets, ...otherSheets].flatMap((sheet) =>
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
      const [baseId, scopedSheetIds] = params as [string, string[] | null | undefined]
      let rows = sheets.filter((sheet) => sheet.base_id === baseId)
      // wire-vs-fixture:sheetIds 的收窄只在**被测 SQL 自己**写了下推谓词时才生效。
      // 把 `AND ($2::text[] IS NULL OR id = ANY($2::text[]))` 从路由里删掉、改成事后在 JS 里
      // 过滤,F7-1 的两个用例就会红,而不是被 fake 兜住。
      if (normalized.includes('id = ANY($2::text[])') && Array.isArray(scopedSheetIds)) {
        const idSet = new Set(scopedSheetIds)
        rows = rows.filter((sheet) => idSet.has(sheet.id as string))
      }
      // LIMIT 也照做 —— 这正是「过滤必须下推」的那把尺子:过滤若发生在 LIMIT 之后,
      // 排在第 51 位的表在这里就已经被截掉了。
      const limit = /LIMIT (\d+)/.exec(normalized)
      if (limit) rows = rows.slice(0, Number(limit[1]))
      return { rows }
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
      // F7 之后 person / rating 是**保真**类型(自洽:值域由自己的 property 定,不指向外表)。
      // property 仍走白名单:person 只留 limitSingleRecord,fixture 里的 `multiple` 要被丢掉。
      { id: 'fld_owner', name: '负责人', type: 'person', order: 4, property: { multiple: false, limitSingleRecord: true } },
      { id: 'fld_score', name: '评分', type: 'rating', order: 5, property: { max: 5 } },
      // button 仍然装不下:property 里是动作配置(收件人 userId、目标),搬到别的库要么悬空
      // 要么误发 —— 必须继续降级并出声。
      {
        id: 'fld_button', name: '通知', type: 'button', order: 6,
        property: { label: '催一下', actionType: 'send_notification', actionConfig: { userIds: ['user_leak_probe'] } },
      },
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
    expect(orders.fields.map((f: any) => f.name)).toEqual(['订单号', '状态', '金额', '关联客户', '负责人', '评分', '通知'])
    expect(orders.fields.find((f: any) => f.name === '关联客户').type).toBe('string')
    // 生产形状 {value,color} 的下拉选项必须原样存下来(值是结构,不是记录值),颜色也保住
    expect(orders.fields.find((f: any) => f.name === '状态').options).toEqual(['待处理', '已完成'])
    expect(orders.fields.find((f: any) => f.name === '状态').property.options).toEqual([
      { value: '待处理', color: '#f97316' },
      { value: '已完成' },
    ])
    // F7 类型保真:person / rating 是自洽类型 —— 原样保留,且**不再**出现「已转为文本列」
    expect(orders.fields.find((f: any) => f.name === '负责人').type).toBe('person')
    expect(orders.fields.find((f: any) => f.name === '评分').type).toBe('rating')
    expect(orders.fields.find((f: any) => f.name === '评分').property).toEqual({ max: 5 })
    // 白名单外的 property 键照丢:person 只留 limitSingleRecord
    expect(orders.fields.find((f: any) => f.name === '负责人').property).toEqual({ limitSingleRecord: true })
    const warningText = created.body.data.warnings.join('\n')
    expect(warningText).not.toContain('负责人')
    expect(warningText).not.toContain('评分')
    // button 仍然装不下 —— 降级成文本并出声
    expect(orders.fields.find((f: any) => f.name === '通知').type).toBe('string')
    expect(warningText).toContain('通知')
    expect(warningText).toContain('button')
    // 视图结构位按局部 id 重挂
    const board = orders.views.find((v: any) => v.name === '状态看板')
    expect(board.groupByFieldId).toBe(orders.fields[1].id)

    // VALUES-FREE 1:整轮 SQL 没有一条碰 meta_records
    expect(store.sqlLog.filter((entry) => entry.sql.includes('meta_records'))).toEqual([])
    // VALUES-FREE 2:落库 JSON 里没有源库 id、没有 defaultValue 这类值、没有外表指针
    const persisted = JSON.stringify(store.customTemplates[0].definition)
    for (const leak of ['sheet_orders', 'fld_title', 'fld_status', 'viw_grid', 'sheet_customers_in_source_db', '8888', 'defaultValue', 'foreignSheetId', 'multiple', 'user_leak_probe', 'actionConfig']) {
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
      expect.arrayContaining(['订单号', '状态', '金额', '关联客户', '负责人', '评分', '通知']),
    )
    // 装出来的表真的带着保真类型(不是模板 JSON 里写着、落库又变回文本)
    const ownerField = store.fields.find((f: any) => f.name === '负责人' && f.sheet_id !== 'sheet_orders') as any
    expect(ownerField.type).toBe('person')
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

  // ── F7「从表一键存为模板」:sheetIds / fieldIds 两个收窄选择器 ──────────────

  it('F7-1: sheetIds 只留点名的那张数据表 —— 同 Base 的另一张表一个字段都不进模板', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '只存成本表', sheetIds: ['sheet_secret'] })
    expect(created.status).toBe(201)
    const sheets = created.body.data.template.sheets
    expect(sheets.map((sheet: any) => sheet.name)).toEqual(['内部成本'])
    // 没点名的那张表连字段名都不许出现在模板里
    const persisted = JSON.stringify(store.customTemplates[0].definition)
    for (const leak of ['订单', '订单号', '状态', '关联客户']) {
      expect(persisted).not.toContain(leak)
    }
    // 收窄不等于放宽:整轮 SQL 依然一次都不碰 meta_records
    expect(store.sqlLog.filter((entry) => entry.sql.includes('meta_records'))).toEqual([])
    // 且授权闸照跑(非管理员会话会去查 spreadsheet_permissions);这里是管理员,
    // 只断言可见性过滤器没有被 sheetIds 顶掉 —— 见下面 F7-5 的 403 用例。
  })

  it('F7-1b: Base 里有 51 张表时,点名第 51 张也存得下 —— 证明 sheetIds 下推进了 SQL 的 WHERE(不是 LIMIT 50 之后再过滤)', async () => {
    // 51 张表,按 created_at(= 插入顺序)排最后一张是 sheet_51。路由那条 SQL 是
    // `... ORDER BY created_at ASC LIMIT 50`:过滤若发生在 LIMIT 之后,sheet_51 早被截掉,
    // 结果会是「一张可读表都没有」→ 404「Base not found」,把用户点名的表说成不存在。
    const many: SeedSheet[] = Array.from({ length: 51 }, (_, index) => ({
      id: `sheet_${index + 1}`,
      name: `表${index + 1}`,
      fields: [{ id: `fld_${index + 1}`, name: `列${index + 1}`, type: 'string', order: 0 }],
      views: [{ id: `viw_${index + 1}`, name: '表格', type: 'grid' }],
    }))
    const store = createStore({ baseSheets: many })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '第 51 张', sheetIds: ['sheet_51'] })
    expect(created.status).toBe(201)
    expect(created.body.data.template.sheets.map((sheet: any) => sheet.name)).toEqual(['表51'])
    // 下推的证据:发给 meta_sheets 的那条 SQL 自己带着 id = ANY($2::text[]) 与这份参数
    const sheetQuery = store.sqlLog.find((entry) => entry.sql.includes('FROM meta_sheets') && entry.sql.includes('WHERE base_id = $1'))
    expect(sheetQuery?.sql).toContain('id = ANY($2::text[])')
    expect(sheetQuery?.params[1]).toEqual(['sheet_51'])
  })

  it('F7-2: 跨 Base 的 sheetId 一张都匹配不到 —— 回 404 且响应里不泄漏那张表的存在', async () => {
    const store = createStore({
      baseSheets: OPS_SHEETS,
      otherBaseSheets: [{
        id: 'sheet_other_base',
        name: '别人库里的表',
        fields: [{ id: 'fld_other', name: '别人的列', type: 'string', order: 0 }],
        views: [{ id: 'viw_other', name: '表格', type: 'grid' }],
      }],
    })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '越界', sheetIds: ['sheet_other_base'] })
    expect(created.status).toBe(404)
    expect(created.body.error.code).toBe('NOT_FOUND')
    const body = JSON.stringify(created.body)
    expect(body).not.toContain('别人库里的表')
    expect(body).not.toContain('别人的列')
    expect(body).not.toContain('sheet_other_base')
    expect(store.customTemplates).toHaveLength(0)

    // 同一批里混进一个跨 Base 的 id:只会拿到本 Base 的那张,越界那张不会被顺带捎上
    const mixed = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '混合', sheetIds: ['sheet_orders', 'sheet_other_base'] })
    expect(mixed.status).toBe(201)
    expect(mixed.body.data.template.sheets.map((sheet: any) => sheet.name)).toEqual(['订单'])
    expect(JSON.stringify(store.customTemplates[0].definition)).not.toContain('别人的列')
  })

  it('F7-3: fieldIds 在抽取之前做交集 —— 被剔掉的字段不会在模板视图里留下悬空引用,也带不进额外字段', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({
        baseId: SOURCE_BASE_ID,
        name: '只留两列',
        sheetIds: ['sheet_orders'],
        // 勾掉 fld_status(看板的 groupBy)与 fld_amount(网格的 hiddenFieldIds);
        // 再塞一个**别的表**的 fieldId,证明 fieldIds 只做交集、带不进额外字段。
        fieldIds: ['fld_title', 'fld_owner', 'fld_cost'],
      })
    expect(created.status).toBe(201)
    const orders = created.body.data.template.sheets[0]
    expect(orders.name).toBe('订单')
    expect(orders.fields.map((f: any) => f.name)).toEqual(['订单号', '负责人'])
    // 别的表的 fieldId 没有把「成本」带进来(也没有把那张表带进来)
    expect(created.body.data.template.sheets).toHaveLength(1)
    expect(JSON.stringify(created.body.data.template)).not.toContain('成本')

    // 视图里对被剔掉字段的引用整条消失 —— 不是留一个指向已删字段的局部 id
    const board = orders.views.find((v: any) => v.name === '状态看板')
    expect(board.groupByFieldId).toBeUndefined()
    const grid = orders.views.find((v: any) => v.name === '全部订单')
    expect(grid.hiddenFieldIds).toBeUndefined()
    // 留下来的那个 titleFieldId 仍然指向真实存在的局部字段
    expect(grid.titleFieldId).toBe(orders.fields[0].id)
    const localFieldIds = new Set(orders.fields.map((f: any) => f.id))
    for (const view of orders.views) {
      for (const ref of [view.groupByFieldId, view.dateFieldId, view.titleFieldId, ...(view.hiddenFieldIds ?? [])]) {
        if (ref !== undefined) expect(localFieldIds.has(ref)).toBe(true)
      }
    }
  })

  it('F7-4: 过滤后一个字段都不剩 → 400 VALIDATION_ERROR,不落一张空模板;超限也是 400 而不是静默截断', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const empty = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '空模板', sheetIds: ['sheet_orders'], fieldIds: ['fld_不存在'] })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('VALIDATION_ERROR')
    expect(store.customTemplates).toHaveLength(0)

    const tooManySheets = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({
        baseId: SOURCE_BASE_ID, name: '表超限',
        sheetIds: Array.from({ length: 51 }, (_, index) => `sheet_${index}`),
      })
    expect(tooManySheets.status).toBe(400)
    expect(tooManySheets.body.error.code).toBe('VALIDATION_ERROR')

    const tooManyFields = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({
        baseId: SOURCE_BASE_ID, name: '字段超限',
        fieldIds: Array.from({ length: 501 }, (_, index) => `fld_${index}`),
      })
    expect(tooManyFields.status).toBe(400)
    expect(tooManyFields.body.error.code).toBe('VALIDATION_ERROR')
    expect(store.customTemplates).toHaveLength(0)
  })

  it('F7-5: 带 sheetIds/fieldIds 的请求照样过授权与租户闸 —— 只有 multitable:write 仍 403;x-tenant-id 兼容头仍拿不到他租户的东西', async () => {
    const store = createStore({ baseSheets: OPS_SHEETS })
    const writer = await createApp(store.handler, { perms: WRITER_PERMS, tenantId: 'tenant_a' })
    pinned.setApp(writer.app)
    const refused = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '越权', sheetIds: ['sheet_orders'], fieldIds: ['fld_title'] })
    expect(refused.status).toBe(403)
    expect(store.customTemplates).toHaveLength(0)

    // 读不到的表:即使被 sheetIds 明确点名,也不会因为「点了名」就进模板
    const blocked = createStore({
      baseSheets: OPS_SHEETS,
      sheetPermissions: [{ sheet_id: 'sheet_secret', perm_code: 'sheet:no-access' }],
    })
    const appBlocked = await createApp(blocked.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appBlocked.app)
    const named = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '点名读不到的表', sheetIds: ['sheet_secret'] })
    expect(named.status).toBe(404)
    expect(JSON.stringify(named.body)).not.toContain('内部成本')
    expect(blocked.customTemplates).toHaveLength(0)

    // 无租户声明 + req.user.tenantId 被兼容头填成 tenant_a:建出来的模板落在 NULL 租户,
    // tenant_a 看不到(租户只认 req.authenticatedTenantId)。
    const spoofed = await createApp(store.handler, { userTenantId: 'tenant_a', userId: 'user_spoof' })
    pinned.setApp(spoofed.app)
    const mine = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '无租户表模板', sheetIds: ['sheet_orders'] })
    expect(mine.status).toBe(201)
    const appA = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(appA.app)
    const listedA = await request(pinned.url()).get('/api/multitable/templates')
    expect(listedA.body.data.templates.some((tpl: any) => tpl.id === mine.body.data.template.id)).toBe(false)
  })

  it('F7-6: 类型保真 —— 13 种自洽类型原样存进模板且不出「已转为文本列」;property 只留结构键', async () => {
    const store = createStore({
      baseSheets: [{
        id: 'sheet_types',
        name: '类型表',
        fields: [
          { id: 'f_person', name: '负责人', type: 'person', order: 0, property: { limitSingleRecord: true, restrictToMemberGroupIds: ['grp_source_tenant'] } },
          { id: 'f_currency', name: '金额', type: 'currency', order: 1, property: { code: 'CNY', decimals: 2, defaultValue: 99 } },
          { id: 'f_percent', name: '完成度', type: 'percent', order: 2, property: { decimals: 1 } },
          { id: 'f_rating', name: '评分', type: 'rating', order: 3, property: { max: 10 } },
          { id: 'f_duration', name: '工时', type: 'duration', order: 4, property: { durationFormat: 'h:mm' } },
          { id: 'f_url', name: '主页', type: 'url', order: 5 },
          { id: 'f_email', name: '邮箱', type: 'email', order: 6 },
          { id: 'f_phone', name: '电话', type: 'phone', order: 7 },
          { id: 'f_auto', name: '编号', type: 'autoNumber', order: 8, property: { prefix: 'SO-', digits: 4, start: 7, startAt: 7, readOnly: true } },
          { id: 'f_ctime', name: '创建时间', type: 'createdTime', order: 9, property: { dateFormat: 'YYYY-MM-DD', readOnly: true } },
          { id: 'f_mtime', name: '修改时间', type: 'modifiedTime', order: 10, property: { dateFormat: 'YYYY-MM-DD', readOnly: true } },
          { id: 'f_cby', name: '创建人', type: 'createdBy', order: 11, property: { readOnly: true } },
          { id: 'f_mby', name: '修改人', type: 'modifiedBy', order: 12, property: { readOnly: true } },
        ],
        views: [{ id: 'viw_types', name: '表格', type: 'grid' }],
      }],
    })
    const { app } = await createApp(store.handler, { tenantId: 'tenant_a' })
    pinned.setApp(app)

    const created = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: SOURCE_BASE_ID, name: '类型保真' })
    expect(created.status).toBe(201)
    const fields = created.body.data.template.sheets[0].fields
    const typeByName = Object.fromEntries(fields.map((f: any) => [f.name, f.type]))
    expect(typeByName).toEqual({
      负责人: 'person', 金额: 'currency', 完成度: 'percent', 评分: 'rating', 工时: 'duration',
      主页: 'url', 邮箱: 'email', 电话: 'phone', 编号: 'autoNumber',
      创建时间: 'createdTime', 修改时间: 'modifiedTime', 创建人: 'createdBy', 修改人: 'modifiedBy',
    })
    // 一条降级 warning 都不该有
    expect(created.body.data.warnings).toEqual([])

    const propertyByName = Object.fromEntries(fields.map((f: any) => [f.name, f.property]))
    expect(propertyByName['金额']).toEqual({ code: 'CNY', decimals: 2 })
    expect(propertyByName['评分']).toEqual({ max: 10 })
    expect(propertyByName['工时']).toEqual({ durationFormat: 'h:mm' })
    expect(propertyByName['编号']).toEqual({ prefix: 'SO-', digits: 4, start: 7, startAt: 7 })
    // 白名单外一律丢:源租户的成员组 id、默认值、抄来的 readOnly 都不进模板
    expect(propertyByName['负责人']).toEqual({ limitSingleRecord: true })
    const persisted = JSON.stringify(store.customTemplates[0].definition)
    expect(persisted).not.toContain('grp_source_tenant')
    expect(persisted).not.toContain('defaultValue')
    expect(persisted).not.toContain('readOnly')

    // 装出来的表真的是这些类型(autoNumber 的序列行是懒建的,装表这一步不需要它)
    const installed = await request(pinned.url())
      .post(`/api/multitable/templates/${created.body.data.template.id}/install`)
      .send({ baseName: '保真库' })
    expect(installed.status).toBe(201)
    const installedTypes = Object.fromEntries(installed.body.data.fields.map((f: any) => [f.name, f.type]))
    expect(installedTypes['负责人']).toBe('person')
    expect(installedTypes['编号']).toBe('autoNumber')
    expect(installedTypes['评分']).toBe('rating')
    expect(store.sqlLog.filter((entry) => entry.sql.includes('meta_field_auto_number_sequences'))).toEqual([])
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
