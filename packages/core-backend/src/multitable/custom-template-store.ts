/**
 * 自定义模板(用户模板)存储 —— 「把这张 Base 存为模板」的落点。
 *
 * 现状勘察(2026-09-10):模板中心的 8 张卡片来自 `template-library.ts` 里的常量表
 * `TEMPLATE_LIBRARY`,零 DB、零租户维度、只读。用户无法新增模板,这就是 09-10 测试反馈
 * 第 8 条「缺少新增模板功能」的根因。本模块只负责**用户模板**:内置模板依旧只读,
 * 两者在 `GET /templates` 处合并展示(用户模板带 `custom: true`)。
 *
 * ── VALUES-FREE(按构造证明,不是靠审查) ───────────────────────────────────
 * 抽取只读三张**结构**表:`meta_sheets` / `meta_fields` / `meta_views`。`meta_records`
 * 一次都不查(路由级测试把整轮 SQL 收集起来断言其中没有 meta_records)。此外:
 *   1. 字段 `property` 走**白名单**(见 SAFE_PROPERTY_KEYS_BY_TYPE),白名单外一律丢弃 —
 *      默认值、可见性规则、link/lookup 的外表指针、公式表达式都不会进入模板;
 *   2. 视图只保留 `type` / 分组字段 / 日期字段 / 标题字段 / 隐藏列,`filter_info` 和
 *      `sort_info` 根本不读 —— 过滤条件里会写死记录值(比如某个客户名),那是值不是结构;
 *   3. 所有 id **重编号**成 `s1/f1/v1` 这样的模板内局部 id,源库的 sheet/field/view id
 *      一个都不落进模板 JSON(也就没有任何来源系统标识可泄漏)。
 *
 * ── 租户 ────────────────────────────────────────────────────────────────
 * `tenant_id` 只来自 JWT 校验挂上的 `req.authenticatedTenantId`(data-sources.ts 的
 * `resolveAuthenticatedTenantId` 同款口径),**不认** `req.user.tenantId` —— 后者在无租户
 * 声明的 token 上可能来自调用方可控的 x-tenant-id 兼容头。读写两侧都用
 * `tenant_id IS NOT DISTINCT FROM $n`:有租户的只看得见本租户,无租户的只看得见无租户行,
 * NULL 与具体租户互不可见。
 *
 * ── 可见性(租户内的第二道) ────────────────────────────────────────────
 * 模板携带表名与全部字段名,而多维表既有读面是**按表级权限**的。所以默认 `private`
 * (只有建它的人看得见/装得了/删得掉),要变成组织资产必须由建模板的人显式勾选
 * 「共享给本租户」(visibility='tenant')。list/get/softDelete 三处共用同一个谓词。
 */
import type { MultitableProvisioningFieldType } from './contracts'
import type {
  MultitableTemplate,
  MultitableTemplateField,
  MultitableTemplateSheet,
  MultitableTemplateView,
} from './template-library'

export type CustomTemplateQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** 用户模板 id 前缀。内置模板 id 是 `project-tracker` 这类裸串,前缀保证两个命名空间永不相撞。 */
export const CUSTOM_TEMPLATE_ID_PREFIX = 'mtpl_'

export const CUSTOM_TEMPLATE_TABLE = 'meta_multitable_custom_templates'

export const CUSTOM_TEMPLATE_DEFAULT_CATEGORY = 'Custom'

export function isCustomTemplateId(templateId: string): boolean {
  return templateId.startsWith(CUSTOM_TEMPLATE_ID_PREFIX)
}

/** PG 缺表 SQLSTATE。中文 locale 下 PG 散文被翻译,散文匹配会漏判 —— 只认 code。 */
export function isUndefinedTableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === '42P01'
}

// ── 抽取(纯函数,可单测) ──────────────────────────────────────────────────

export type SourceSheetRow = {
  id: string
  name?: unknown
  description?: unknown
}

export type SourceFieldRow = {
  id: string
  sheet_id?: unknown
  name?: unknown
  type?: unknown
  property?: unknown
  order?: unknown
}

export type SourceViewRow = {
  id: string
  sheet_id?: unknown
  name?: unknown
  type?: unknown
  group_info?: unknown
  hidden_field_ids?: unknown
  config?: unknown
}

export type ExtractTemplateInput = {
  sheets: SourceSheetRow[]
  fields: SourceFieldRow[]
  views: SourceViewRow[]
}

export type ExtractTemplateResult = {
  sheets: MultitableTemplateSheet[]
  /** 人话的降级说明,原样回给前端(哪些字段被转成了文本)。 */
  warnings: string[]
}

/**
 * 跨表引用类字段:link / lookup / rollup 指向**源库里另一张表**,模板装到一个全新的
 * Base 上时那个目标根本不存在;而且它们的 property 里装的就是源库 sheet/field id。
 * 所以模板里把它们降级成文本列(结构保留、指针不保留),并在 warnings 里说清楚。
 * 公式同理:表达式引用的是源表字段 id,搬到新 Base 上必然悬空。
 */
const DOWNGRADED_FIELD_TYPES = new Set(['link', 'lookup', 'rollup', 'formula'])

/**
 * 结构性 property 白名单(按类型)。白名单之外的键一律丢弃 —— 包括默认值
 * (`defaultValue`)、可见性/必填规则(引用别的字段 id)、以及任何插件写进来的自定义键。
 */
const SAFE_PROPERTY_KEYS_BY_TYPE: Record<string, string[]> = {
  number: ['precision', 'format', 'symbol', 'thousands', 'percent'],
  date: ['dateFormat', 'format'],
  dateTime: ['dateFormat', 'timeFormat', 'format', 'timeZone'],
  longText: ['rich'],
  attachment: ['maxCount'],
  select: [],
  multiSelect: [],
  string: [],
  boolean: [],
  barcode: [],
  qrcode: [],
  location: [],
}

const TEMPLATE_FIELD_TYPES = new Set<string>([
  'string', 'number', 'boolean', 'date', 'dateTime', 'formula', 'select', 'multiSelect',
  'link', 'lookup', 'rollup', 'attachment', 'barcode', 'qrcode', 'location', 'longText',
])

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * 下拉可选值是结构(不是记录值),取值 + 颜色,丢掉源库 option id。
 *
 * 形状口径按**生产写侧**来定,不按 fixture:meta_fields.property.options 唯一的落库形状是
 * `{ value, color? }` —— 所有写入口都过 univer-meta.ts 的 sanitizeFieldProperty →
 * extractSelectOptions,那里只认 `item.value`(name/label 键在入库那一刻就被丢掉),
 * provisioning.ts 的 buildFieldProperty 也只写 `{ value }`。所以这里必须先读 `value`;
 * `name`/`label` 只作为历史脏数据/外部导入的兼容回落(读得到就用,读不到不报错)。
 */
export type TemplateSelectOption = { value: string; color?: string }

export function extractSelectOptions(property: Record<string, unknown>): TemplateSelectOption[] {
  const raw = Array.isArray(property.options) ? property.options : []
  const options: TemplateSelectOption[] = []
  const seen = new Set<string>()
  for (const option of raw) {
    if (typeof option === 'string' || typeof option === 'number') {
      const value = String(option).trim()
      if (value && !seen.has(value)) {
        seen.add(value)
        options.push({ value })
      }
      continue
    }
    if (option && typeof option === 'object') {
      const rawValue = (option as Record<string, unknown>).value
      const value = (typeof rawValue === 'number' ? String(rawValue) : asText(rawValue))
        || asText((option as Record<string, unknown>).name)
        || asText((option as Record<string, unknown>).label)
      if (!value || seen.has(value)) continue
      seen.add(value)
      const color = asText((option as Record<string, unknown>).color)
      options.push(color ? { value, color } : { value })
    }
  }
  return options
}

function pickSafeProperty(type: string, property: Record<string, unknown>): Record<string, unknown> {
  const allow = SAFE_PROPERTY_KEYS_BY_TYPE[type] ?? []
  const next: Record<string, unknown> = {}
  for (const key of allow) {
    const value = property[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[key] = value
    }
  }
  return next
}

/**
 * 把一个 Base 的结构行抽成模板 sheets。纯函数:进的是三张结构表的行,出的是模板描述。
 * id 全部重编号成模板内局部 id(s1/f1/v1),源 id 不出现在结果里。
 */
export function extractTemplateSheets(input: ExtractTemplateInput): ExtractTemplateResult {
  const warnings: string[] = []
  const sheets: MultitableTemplateSheet[] = []

  input.sheets.forEach((sheetRow, sheetIndex) => {
    const sourceSheetId = asText(sheetRow.id)
    if (!sourceSheetId) return
    const localSheetId = `s${sheetIndex + 1}`
    const fieldLocalIds = new Map<string, string>()

    const sheetFields = input.fields
      .filter((field) => asText(field.sheet_id) === sourceSheetId)
      .sort((a, b) => (Number(a.order ?? 0) || 0) - (Number(b.order ?? 0) || 0))

    const fields: MultitableTemplateField[] = []
    sheetFields.forEach((fieldRow, fieldIndex) => {
      const sourceFieldId = asText(fieldRow.id)
      const name = asText(fieldRow.name)
      if (!sourceFieldId || !name) return
      const localFieldId = `f${fieldIndex + 1}`
      fieldLocalIds.set(sourceFieldId, localFieldId)

      const rawType = asText(fieldRow.type)
      const property = asObject(fieldRow.property)
      let type: string
      if (!TEMPLATE_FIELD_TYPES.has(rawType)) {
        // 生产字段类型联合有 27 种(univer-meta.ts 的 UniverMetaField['type']),模板系统
        // (= provisioning 的 MultitableProvisioningFieldType)只装得下 16 种。person /
        // rating / autoNumber / phone / currency 这些在真表里很常见 —— 静默降级会让用户
        // 以为「结构存下来了」,所以这里必须出声,和 link/lookup 那条降级一个待遇。
        type = 'string'
        if (rawType) {
          warnings.push(
            `字段「${name}」是 ${rawType} 类型,模板系统目前只支持 ${TEMPLATE_FIELD_TYPES.size} 种字段类型,模板里已转为文本列。`,
          )
        }
      } else if (DOWNGRADED_FIELD_TYPES.has(rawType)) {
        warnings.push(`字段「${name}」是 ${rawType} 类型,依赖当前 Base 的其它表/字段,模板里已转为文本列。`)
        type = 'string'
      } else {
        type = rawType
      }

      const field: MultitableTemplateField = {
        id: localFieldId,
        name,
        type: type as MultitableProvisioningFieldType,
        order: fieldIndex,
        property: pickSafeProperty(type, property),
      }
      if (type === 'select' || type === 'multiSelect') {
        const options = extractSelectOptions(property)
        field.options = options.map((option) => option.value)
        // 色板也是结构。descriptor.options 是 string[](共享契约,不为模板一个人加宽),
        // 所以颜色随 property.options 走 —— provisioning 的 buildFieldProperty 按 value
        // 把颜色对回去;没有颜色就不写这个键,装出来的表与改动前逐字一致。
        if (options.some((option) => option.color)) {
          field.property = { ...field.property, options }
        }
      }
      fields.push(field)
    })

    const views: MultitableTemplateView[] = []
    input.views
      .filter((view) => asText(view.sheet_id) === sourceSheetId)
      .forEach((viewRow, viewIndex) => {
        const name = asText(viewRow.name)
        if (!name) return
        const localViewId = `v${viewIndex + 1}`
        const view: MultitableTemplateView = {
          id: localViewId,
          name,
          type: asText(viewRow.type) || 'grid',
        }
        const groupInfo = asObject(viewRow.group_info)
        const groupFieldId = asText(groupInfo.fieldId)
          || (Array.isArray(groupInfo.fieldIds) ? asText(groupInfo.fieldIds[0]) : '')
        if (groupFieldId && fieldLocalIds.has(groupFieldId)) {
          view.groupByFieldId = fieldLocalIds.get(groupFieldId)
        }
        const config = asObject(viewRow.config)
        const dateFieldId = asText(config.dateFieldId)
        if (dateFieldId && fieldLocalIds.has(dateFieldId)) {
          view.dateFieldId = fieldLocalIds.get(dateFieldId)
        }
        const titleFieldId = asText(config.titleFieldId)
        if (titleFieldId && fieldLocalIds.has(titleFieldId)) {
          view.titleFieldId = fieldLocalIds.get(titleFieldId)
        }
        const hidden = Array.isArray(viewRow.hidden_field_ids) ? viewRow.hidden_field_ids : []
        const hiddenLocal = hidden
          .map((id) => fieldLocalIds.get(asText(id)) ?? '')
          .filter((id) => id.length > 0)
        if (hiddenLocal.length > 0) view.hiddenFieldIds = hiddenLocal
        views.push(view)
      })

    if (fields.length === 0) return
    if (views.length === 0) {
      views.push({ id: 'v1', name: asText(sheetRow.name) || localSheetId, type: 'grid' })
    }

    sheets.push({
      id: localSheetId,
      name: asText(sheetRow.name) || localSheetId,
      description: null,
      fields,
      views,
    })
  })

  return { sheets, warnings }
}

// ── 存储 ────────────────────────────────────────────────────────────────────

/**
 * 可见性。默认 `private` —— 模板里装着表名与全部字段名(比如「内部成本」表的列),
 * 而多维表既有的读面是**按表级权限**的:管理员看得见的表,普通只读用户不一定看得见。
 * 存模板如果一律 tenant 可见,就等于给整租户开了一条绕过表级权限的元数据读面。
 * 所以「共享给本租户」必须由建模板的人显式勾选(收紧优先,放开是一次显式动作)。
 */
export type CustomTemplateVisibility = 'private' | 'tenant'

export const CUSTOM_TEMPLATE_DEFAULT_VISIBILITY: CustomTemplateVisibility = 'private'

export function normalizeCustomTemplateVisibility(value: unknown): CustomTemplateVisibility {
  return value === 'tenant' ? 'tenant' : CUSTOM_TEMPLATE_DEFAULT_VISIBILITY
}

export type CustomTemplateRecord = MultitableTemplate & {
  custom: true
  createdBy: string | null
  createdAt: string | null
  visibility: CustomTemplateVisibility
}

export type CreateCustomTemplateInput = {
  query: CustomTemplateQueryFn
  id: string
  tenantId: string | null
  workspaceId: string | null
  name: string
  description: string
  category: string
  icon: string
  color: string
  sheets: MultitableTemplateSheet[]
  createdBy: string | null
  visibility: CustomTemplateVisibility
}

function normalizeRow(row: Record<string, unknown>): CustomTemplateRecord {
  const definition = asObject(row.definition)
  const sheets = Array.isArray(definition.sheets) ? (definition.sheets as MultitableTemplateSheet[]) : []
  const createdAt = row.created_at
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: typeof row.description === 'string' ? row.description : '',
    category: typeof row.category === 'string' && row.category.trim() ? row.category : CUSTOM_TEMPLATE_DEFAULT_CATEGORY,
    icon: typeof row.icon === 'string' ? row.icon : 'table',
    color: typeof row.color === 'string' ? row.color : '#2563eb',
    sheets,
    custom: true,
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : (typeof createdAt === 'string' ? createdAt : null),
    visibility: normalizeCustomTemplateVisibility(row.visibility),
  }
}

const SELECT_COLUMNS = 'id, name, description, category, icon, color, definition, created_by, created_at, visibility'

/**
 * 可见性谓词。`visibility = 'tenant'` 是共享模板;否则只有建它的人看得见。
 * `created_by = $n` 用普通等值(不是 IS NOT DISTINCT FROM):viewerId 为空串时
 * 不会去匹配 created_by IS NULL 的历史行 —— 匿名/无身份的调用者拿不到任何私有模板。
 */
const VISIBILITY_PREDICATE = `(visibility = 'tenant' OR created_by = $VIEWER)`

function visibilityPredicate(paramIndex: number): string {
  return VISIBILITY_PREDICATE.replace('$VIEWER', `$${paramIndex}`)
}

export async function createCustomTemplate(input: CreateCustomTemplateInput): Promise<CustomTemplateRecord> {
  const result = await input.query(
    `INSERT INTO ${CUSTOM_TEMPLATE_TABLE}
       (id, tenant_id, workspace_id, name, description, category, icon, color, definition, created_by, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.workspaceId,
      input.name,
      input.description,
      input.category,
      input.icon,
      input.color,
      JSON.stringify({ sheets: input.sheets }),
      input.createdBy,
      normalizeCustomTemplateVisibility(input.visibility),
    ],
  )
  const row = (result.rows as Record<string, unknown>[])[0]
  if (!row) throw new Error('Failed to persist custom template')
  return normalizeRow(row)
}

/**
 * 列出**本租户里这个人看得见的**用户模板:共享给租户的 + 他自己建的。租户维度和可见性
 * 维度都写死在 SQL 里,调用方给不出「看全部」的开关 —— 没有跨租户读、也没有跨人读的入口。
 */
export async function listCustomTemplates(
  query: CustomTemplateQueryFn,
  tenantId: string | null,
  viewerId: string,
): Promise<CustomTemplateRecord[]> {
  const result = await query(
    `SELECT ${SELECT_COLUMNS}
     FROM ${CUSTOM_TEMPLATE_TABLE}
     WHERE deleted_at IS NULL
       AND tenant_id IS NOT DISTINCT FROM $1
       AND ${visibilityPredicate(2)}
     ORDER BY created_at DESC
     LIMIT 200`,
    [tenantId, viewerId],
  )
  return (result.rows as Record<string, unknown>[]).map(normalizeRow)
}

export async function getCustomTemplate(
  query: CustomTemplateQueryFn,
  tenantId: string | null,
  templateId: string,
  viewerId: string,
): Promise<CustomTemplateRecord | null> {
  const result = await query(
    `SELECT ${SELECT_COLUMNS}
     FROM ${CUSTOM_TEMPLATE_TABLE}
     WHERE id = $1
       AND deleted_at IS NULL
       AND tenant_id IS NOT DISTINCT FROM $2
       AND ${visibilityPredicate(3)}`,
    [templateId, tenantId, viewerId],
  )
  const row = (result.rows as Record<string, unknown>[])[0]
  return row ? normalizeRow(row) : null
}

/**
 * 软删除。租户维度 + 可见性维度都带上:别的租户即使猜到 id 也删不掉,同租户里
 * 看不见(别人的私有模板)的也删不掉 —— 两种情况都 rowCount = 0 → 路由回 404。
 */
export async function softDeleteCustomTemplate(
  query: CustomTemplateQueryFn,
  tenantId: string | null,
  templateId: string,
  viewerId: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE ${CUSTOM_TEMPLATE_TABLE}
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1
       AND deleted_at IS NULL
       AND tenant_id IS NOT DISTINCT FROM $2
       AND ${visibilityPredicate(3)}`,
    [templateId, tenantId, viewerId],
  )
  return (result.rowCount ?? 0) > 0
}
