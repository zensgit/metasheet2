/**
 * 字段类型转换（带值迁移）首批 —— 转换矩阵与只读预览的纯函数（第 2 刀）。
 *
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md（§1 范围、§2 预览、§4 往返保真 A、
 * §5 开关、§6 第 2 刀）。本模块只做**纯计算**：给定源字段 property 与本表 live / 回收站单元格，算出预览结论、
 * 选项序列、目标 property 与 planHash 的规范输入。它不读库、不写库、不签凭证（凭证与 HMAC 在
 * restore-preview-identity.ts，扫描与并集判定的 SQL 在 field-retype-convert-preview.ts）。
 *
 * ── 与无损白名单的关系（ADR §1「新旧分离」）────────────────────────────────────────────────────────────
 * `PATCH /fields/:fieldId` 的边界是 field-retype-whitelist.ts 的 `LOSSLESS_FIELD_RETYPE`：只改 schema、从不迁值，
 * `string → select / multiSelect` 在那里**故意**被拒（400 FIELD_RETYPE_NOT_LOSSLESS）。本模块是另一条受控路径
 * （预览 → 带前镜像的执行 → 整列撤销），两者**零 import**（本文件不 import 白名单，白名单也不 import 本文件；
 * 单测按源码断言这一点），首批配对与白名单的交集为空也由单测钉住。排除集在这里有自己的一份
 * （`FIELD_RETYPE_CONVERT_EXCLUDED_TYPES`），与白名单那份的相等性由单测对照，而不是靠 import 共享——
 * 否则「新旧分离」就只剩一句话。
 *
 * ── values-free ─────────────────────────────────────────────────────────────────────────────────────────
 * 预览响应只含计数与 recordId，**永不**含单元格值或选项文本（`toFieldRetypeConvertPreviewResponse` 是唯一的
 * 响应投影；选项文本只进 planHash 的 HMAC 输入，由服务端密钥绑定）。
 */
import { createHash } from 'node:crypto'

/** 开关（ADR §5）：默认 OFF，`=== 'true'` 字节精确（不 trim、不转小写），门控预览 / 执行 / 撤销三个端点。 */
export const FIELD_RETYPE_CONVERT_FLAG_ENV = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'

export function isFieldRetypeConvertEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT === 'true'
}

/** 稳定拒绝码（values-free）。 */
export const FIELD_RETYPE_CONVERT_DISABLED_CODE = 'FIELD_RETYPE_CONVERT_DISABLED'
export const FIELD_RETYPE_TRUST_REQUIRED_CODE = 'FIELD_RETYPE_TRUST_REQUIRED'
export const FIELD_RETYPE_CONVERT_NOT_SUPPORTED_CODE = 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED'
/** 预览凭证与执行确认串（执行在第 3 刀；这里只定契约）。 */
export const FIELD_RETYPE_CONVERT_CONFIRM = 'convert-field-type'

/**
 * 选项上限（ADR §4）：`final > 5000` ⇒ 整次 `rejected`（reason `option_limit_exceeded`），不取前 N、不截断。
 * 与记录上限 `SHEET_REVERT_DEFAULT_MAX_RECORDS` 同值但**分立**——改其一不得牵动另一。
 */
export const FIELD_RETYPE_MAX_OPTIONS = 5000

/** 首批目标（ADR §1）：源**仅** `string`（非 longText，无论 rich 与否）。 */
export type FieldRetypeConvertTargetType = 'select' | 'multiSelect'

/** 首批配对：`string → select`、`string → multiSelect`。其余一律 422 `pair_not_in_first_batch`。 */
export const FIELD_RETYPE_CONVERT_FIRST_BATCH: Readonly<Record<string, readonly FieldRetypeConvertTargetType[]>> = Object.freeze({
  string: Object.freeze(['select', 'multiSelect'] as const),
})

/**
 * 带副作用 / 计算语义的 11 类型（ADR §1「排除集」，与 4c-1 §2.1 同口径）。任一端落在此集合 ⇒ 422 `excluded_type`。
 * 与 field-retype-whitelist.ts / config-restore.ts 的同名集合相等——由单测对照，不 import（见文件头）。
 */
export const FIELD_RETYPE_CONVERT_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
])

/** 422 `FIELD_RETYPE_CONVERT_NOT_SUPPORTED` 的 `details.reason`（ADR §2 范围校验；§1 并集取首个命中）。 */
export type FieldRetypeConvertPairRefusal = 'pair_not_in_first_batch' | 'excluded_type'
export type FieldRetypeConvertManagedSheetReason =
  | 'plugin_managed_sheet'
  | 'system_managed_sheet'
  | 'plugin_tagged_fields'
  | 'pipeline_staging_sheet'
  | 'approval_projection_sheet'
export type FieldRetypeConvertScopeReason = FieldRetypeConvertPairRefusal | FieldRetypeConvertManagedSheetReason

/**
 * 源类型是否为首批源。判的是**库里存的原始 type**（trim + 小写后恰为 `string`），而不是 `mapFieldType` 的映射结果：
 * 路由里的 `mapFieldType` 对任何不认识的类型名都兜底成 `'string'`，拿映射结果判会把未知 / 插件自定义类型当文本放进来。
 * fail-closed：宁可让一个以旧别名存储的文本列 422，也不放一个存储形状未知的列进转换。
 */
export function isFieldRetypeConvertSourceType(rawStoredType: unknown): boolean {
  return typeof rawStoredType === 'string' && rawStoredType.trim().toLowerCase() === 'string'
}

/**
 * 配对判定（纯）。排除集**先于**首批判定：首批两对的两端都不在排除集里，若先判首批，`excluded_type` 就永远不可达，
 * 调用方拿不到「这一端带副作用」这个更具体的原因。两者同为 422、同一个码，先后只影响 `details.reason`。
 * `null` = 首批配对，放行到并集判定。
 */
export function classifyFieldRetypeConvertPair(
  rawStoredSourceType: unknown,
  mappedSourceType: string,
  targetType: string,
): FieldRetypeConvertPairRefusal | null {
  if (FIELD_RETYPE_CONVERT_EXCLUDED_TYPES.has(mappedSourceType) || FIELD_RETYPE_CONVERT_EXCLUDED_TYPES.has(targetType)) {
    return 'excluded_type'
  }
  if (!isFieldRetypeConvertSourceType(rawStoredSourceType)) return 'pair_not_in_first_batch'
  const targets = FIELD_RETYPE_CONVERT_FIRST_BATCH.string
  return (targets as readonly string[]).includes(targetType) ? null : 'pair_not_in_first_batch'
}

/**
 * JS 码元比较器 —— 与 `hashScope`（restore-preview-identity.ts）同一口径：`<` / `>` 比 UTF-16 码元，与 DB 排序规则
 * 无关（演示库的 PG 是中文 locale，`ORDER BY` 的结果与这里不同）。预览、执行、测试三处共用，**不得**改成
 * `localeCompare` 或依赖 SQL `ORDER BY`。
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ── 单元格分类（往返保真 A，ADR §4）──────────────────────────────────────────────────────────────────────

export type FieldRetypeConvertCellRejection = 'leading_trailing_whitespace' | 'whitespace_only' | 'non_string_value'

export type FieldRetypeConvertCellOutcome =
  | { kind: 'empty' }
  | { kind: 'converted'; option: string }
  | { kind: 'rejected'; reason: FieldRetypeConvertCellRejection }

/**
 * 一格的归类（纯）。`hasKey` = `data ? F`；`value` = `data -> F`（缺键时无意义）。
 *   - 缺键 / `null` / `''` ⇒ 空（目标写规范空值：单选 `''`、多选 `[]`，执行在第 3 刀）；
 *   - 非字符串非空（数字 / 布尔 / 对象 / 数组，含 `[]`、`{}`）⇒ `non_string_value`；
 *   - 非空纯空白 ⇒ `whitespace_only`；首尾空白 ⇒ `leading_trailing_whitespace`（`text !== text.trim()`，JS `trim` 口径）；
 *   - 其余 ⇒ 整格文本即一个选项（逗号 / 顿号 / 分号 / 换行一律当普通字符，不切分）。
 */
export function classifyFieldRetypeConvertCell(hasKey: boolean, value: unknown): FieldRetypeConvertCellOutcome {
  if (!hasKey || value === null || value === undefined || value === '') return { kind: 'empty' }
  if (typeof value !== 'string') return { kind: 'rejected', reason: 'non_string_value' }
  const trimmed = value.trim()
  if (trimmed === '') return { kind: 'rejected', reason: 'whitespace_only' }
  if (value !== trimmed) return { kind: 'rejected', reason: 'leading_trailing_whitespace' }
  return { kind: 'converted', option: value }
}

/**
 * 回收站行是否阻断（ADR §2）：恢复时原样 INSERT、无类型校验、无 flag 门，不扫就会把未转换的原值带回选项列。
 * `data ? F` 且 `data->F` 非 JSON null、非 `''` ⇒ 阻断（reason `trashed_rows_with_value`）；空形（缺键 / null / `''`）放行。
 * 注意：这里**不**按 A 规则区分合法 / 非法字符串——首批对回收站行一律「有值即拒」。
 */
export function isFieldRetypeConvertTrashBlocking(hasKey: boolean, value: unknown): boolean {
  return hasKey && value !== null && value !== undefined && value !== ''
}

// ── 目标 property（ADR §4「目标 property」）──────────────────────────────────────────────────────────────

/** 镜像前端 `VALIDATION_RULES_BY_PANEL_TYPE.select`（apps/web/src/multitable/utils/field-retype.ts）。 */
export const FIELD_RETYPE_CONVERT_RETAINED_VALIDATION_RULE_TYPES: ReadonlySet<string> = new Set(['required', 'enum'])

/**
 * `{ ...source, options: <新序列> }`，再把数组形 `validation` 过滤为 `type ∈ {required, enum}`（逐条判定与前端
 * `retainedRetypeValidationRules` 同形：非对象 / 无字符串 type 的条目一律滤掉），滤掉的条数计入
 * `droppedValidationRuleCount`；**其余键原样保留**（含 `stockPreparation` 等命名空间）。选项形状 `{ value }`，不赋 color。
 * 非数组的 `validation` 原样保留、不计数：引擎只认数组（record-service.ts `buildDirectValidationFields`），非数组即惰性；
 * 若改写成 `[]` 反而会以「显式空规则」覆盖选项型的默认 enum 规则。
 */
export function deriveFieldRetypeConvertTargetProperty(
  sourceProperty: Readonly<Record<string, unknown>>,
  optionValues: readonly string[],
): { property: Record<string, unknown>; droppedValidationRuleCount: number } {
  const property: Record<string, unknown> = { ...sourceProperty, options: optionValues.map((value) => ({ value })) }
  let droppedValidationRuleCount = 0
  const rules = sourceProperty.validation
  if (Array.isArray(rules)) {
    const kept = rules.filter((rule) => {
      if (!rule || typeof rule !== 'object') return false
      const ruleType = (rule as { type?: unknown }).type
      return typeof ruleType === 'string' && FIELD_RETYPE_CONVERT_RETAINED_VALIDATION_RULE_TYPES.has(ruleType)
    })
    droppedValidationRuleCount = rules.length - kept.length
    property.validation = kept
  }
  return { property, droppedValidationRuleCount }
}

// ── 预览计划 ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FieldRetypeConvertLiveCell {
  recordId: string
  version: number
  /** `jsonb_typeof(data) = 'object'`. REQUIRED, and only `true` passes: a row that is not a JSON object rejects the run. */
  dataIsObject: boolean
  hasKey: boolean
  value: unknown
}

export interface FieldRetypeConvertTrashCell {
  recordId: string
  /** `jsonb_typeof(data) = 'object'`, as for a live row. */
  dataIsObject: boolean
  hasKey: boolean
  value: unknown
}

export type FieldRetypeConvertRejectionReason =
  | FieldRetypeConvertCellRejection
  | 'trashed_rows_with_value'
  | 'option_limit_exceeded'
  | 'record_data_not_object'

/** 每个原因列出**全部** recordId（按码元比较器升序、去重），`recordCount === recordIds.length`。 */
export interface FieldRetypeConvertRejection {
  reason: FieldRetypeConvertRejectionReason
  recordCount: number
  recordIds: string[]
}

export interface FieldRetypeConvertPlan {
  verdict: 'ok' | 'rejected'
  targetType: FieldRetypeConvertTargetType
  scannedRecordCount: number
  trash: { scanned: number; blocking: number }
  cells: { empty: number; converted: number; rejected: number }
  /** 选项序列（**服务端内部**，只进 planHash，永不进响应）。 */
  optionValues: string[]
  /** 目标 property（**服务端内部**，只进 planHash，永不进响应）。 */
  targetProperty: Record<string, unknown>
  droppedValidationRuleCount: number
  rejections: FieldRetypeConvertRejection[]
  /** 按码元比较器排好序的 live / 回收站行（planHash 的行轴，与响应无关）。 */
  sortedLive: FieldRetypeConvertLiveCell[]
  sortedTrash: FieldRetypeConvertTrashCell[]
}

const REJECTION_ORDER: readonly FieldRetypeConvertRejectionReason[] = [
  'leading_trailing_whitespace',
  'whitespace_only',
  'non_string_value',
  'trashed_rows_with_value',
  'option_limit_exceeded',
  'record_data_not_object',
]

/**
 * 预览计划（纯）。顺序规则（ADR §4）：live 行先按 recordId 的码元比较器排序，再扫描；选项取**首次出现序**，
 * 去重按精确码点相等（大小写敏感、不做 Unicode 归一 —— JS 字符串相等）。不依赖输入顺序：同一行集合的任意排列
 * 得到同一计划。
 *
 * 非对象行（ADR 增补 B）：live 行或本表回收站行的 `data` 不是 JSON 对象（数组 / 标量 / JSON null）⇒ 整次 `rejected`，
 * reason `record_data_not_object`，列出全部 recordId。**不**把它当空格读：对非对象的 jsonb，`data ? F` 问的是「数组里有没有
 * 这个字符串元素」、`data -> F` 恒为 NULL，读出来的「缺键」是假的；而执行的 `jsonb_set` 在非对象上要么报错要么静默不写。
 */
export function planFieldRetypeConvert(input: {
  sourceProperty: Readonly<Record<string, unknown>>
  targetType: FieldRetypeConvertTargetType
  live: readonly FieldRetypeConvertLiveCell[]
  trash: readonly FieldRetypeConvertTrashCell[]
}): FieldRetypeConvertPlan {
  const sortedLive = [...input.live].sort((a, b) => compareCodeUnits(a.recordId, b.recordId))
  const sortedTrash = [...input.trash]
    .map((row) => ({ row, cellHash: hashFieldRetypeConvertCell(row.hasKey, row.value) }))
    .sort((a, b) => compareCodeUnits(a.row.recordId, b.row.recordId) || compareCodeUnits(a.cellHash, b.cellHash))
    .map(({ row }) => row)

  const rejected = new Map<FieldRetypeConvertRejectionReason, string[]>()
  const addRejection = (reason: FieldRetypeConvertRejectionReason, recordId: string): void => {
    const list = rejected.get(reason)
    if (list) {
      if (list[list.length - 1] !== recordId) list.push(recordId)
    } else {
      rejected.set(reason, [recordId])
    }
  }

  const seen = new Set<string>()
  const optionValues: string[] = []
  let empty = 0
  let converted = 0
  let rejectedCells = 0
  for (const cell of sortedLive) {
    if (cell.dataIsObject !== true) {
      rejectedCells += 1
      addRejection('record_data_not_object', cell.recordId)
      continue
    }
    const outcome = classifyFieldRetypeConvertCell(cell.hasKey, cell.value)
    if (outcome.kind === 'empty') {
      empty += 1
    } else if (outcome.kind === 'rejected') {
      rejectedCells += 1
      addRejection(outcome.reason, cell.recordId)
    } else {
      converted += 1
      if (!seen.has(outcome.option)) {
        seen.add(outcome.option)
        optionValues.push(outcome.option)
      }
    }
  }

  let trashBlocking = 0
  for (const row of sortedTrash) {
    if (row.dataIsObject !== true) {
      trashBlocking += 1
      addRejection('record_data_not_object', row.recordId)
      continue
    }
    if (!isFieldRetypeConvertTrashBlocking(row.hasKey, row.value)) continue
    trashBlocking += 1
    addRejection('trashed_rows_with_value', row.recordId)
  }

  const { property: targetProperty, droppedValidationRuleCount } = deriveFieldRetypeConvertTargetProperty(input.sourceProperty, optionValues)
  const optionLimitExceeded = optionValues.length > FIELD_RETYPE_MAX_OPTIONS
  // Plan-level, not per-record: no single record "causes" the overflow. Listed with an empty id set; the counts
  // are in `options.final` / `options.limit`.
  if (optionLimitExceeded) rejected.set('option_limit_exceeded', [])

  const rejections: FieldRetypeConvertRejection[] = []
  for (const reason of REJECTION_ORDER) {
    const collected = rejected.get(reason)
    if (!collected) continue
    // one reason can now collect ids from BOTH scans (live, then recycle bin): sort and de-duplicate the union
    const ids = [...new Set(collected)].sort(compareCodeUnits)
    rejections.push({ reason, recordCount: ids.length, recordIds: ids })
  }

  const verdict: 'ok' | 'rejected' = rejectedCells === 0 && trashBlocking === 0 && !optionLimitExceeded ? 'ok' : 'rejected'
  return {
    verdict,
    targetType: input.targetType,
    scannedRecordCount: sortedLive.length,
    trash: { scanned: sortedTrash.length, blocking: trashBlocking },
    cells: { empty, converted, rejected: rejectedCells },
    optionValues,
    targetProperty,
    droppedValidationRuleCount,
    rejections,
    sortedLive,
    sortedTrash,
  }
}

// ── planHash 的规范输入（HMAC 在 restore-preview-identity.ts 的 hashFieldRetypeConvertPlan）───────────────

/** 深排序对象键（码元序）后 JSON 化；数组保序（顺序即语义）。 */
export function canonicalFieldRetypeConvertJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(obj)
          .sort(compareCodeUnits)
          .map((k) => [k, walk(obj[k])]),
      )
    }
    return v === undefined ? null : v
  }
  return JSON.stringify(walk(value ?? null))
}

/**
 * 单格哈希：区分四态（缺键 / JSON null / `''` / 其它值），值按规范 JSON。只作为 planHash 的行轴分量，
 * 整体再经服务端密钥 HMAC，永不单独外露。
 */
export function hashFieldRetypeConvertCell(hasKey: boolean, value: unknown): string {
  const state = hasKey ? [1, value === undefined ? null : value] : [0, null]
  return createHash('sha256').update(canonicalFieldRetypeConvertJson(state)).digest('hex')
}

/**
 * planHash 的规范输入串（ADR §2「凭证」）。折入：源 type + 规范化 property；目标 type + **完整新选项序列** +
 * 目标 property 键集（连同完整目标 property）；live 行 `[recordId, cellHash, version]` 与回收站行
 * `[record_id, cellHash]` 两组序列，均按码元比较器排序。缺任一轴即「计数相同、集合互换」反例成立。
 * `kind` / `v` 做域分离：同一把密钥下不会与其它 HMAC（uncreate / undelete / loss）撞输入。
 */
export function canonicalFieldRetypeConvertPlanInput(input: {
  sheetId: string
  fieldId: string
  sourceType: 'string'
  sourceProperty: Readonly<Record<string, unknown>>
  plan: FieldRetypeConvertPlan
}): string {
  const { plan } = input
  return canonicalFieldRetypeConvertJson({
    kind: 'field-retype-convert-plan',
    v: 1,
    sheetId: input.sheetId,
    fieldId: input.fieldId,
    source: { type: input.sourceType, property: input.sourceProperty },
    target: {
      type: plan.targetType,
      options: plan.optionValues,
      propertyKeys: Object.keys(plan.targetProperty).sort(compareCodeUnits),
      property: plan.targetProperty,
    },
    live: plan.sortedLive.map((cell) => [cell.recordId, hashFieldRetypeConvertCell(cell.hasKey, cell.value), cell.version]),
    trash: plan.sortedTrash.map((row) => [row.recordId, hashFieldRetypeConvertCell(row.hasKey, row.value)]),
  })
}

// ── 响应投影（values-free 的唯一出口）──────────────────────────────────────────────────────────────────────

export interface FieldRetypeConvertPreviewResponse {
  verdict: 'ok' | 'rejected'
  sourceType: 'string'
  targetType: FieldRetypeConvertTargetType
  scannedRecordCount: number
  trash: { scanned: number; blocking: number }
  recordCap: number
  cells: { empty: number; converted: number; rejected: number }
  options: { new: number; final: number; limit: number; droppedValidationRuleCount: number }
  rejections: FieldRetypeConvertRejection[]
  previewToken?: string
  confirm?: typeof FIELD_RETYPE_CONVERT_CONFIRM
}

/**
 * 只有计数与 recordId。选项文本、单元格值、目标 property 一概不出。`verdict:'rejected'` 是报告不是错误（路由仍 200），
 * 且不带凭证与确认串。`options.new` = 由单元格推导出的去重选项数；`options.final` = 目标 property 的选项数——首批目标
 * property 的 `options` 整体替换为新序列（ADR §4），两者相等。
 */
export function toFieldRetypeConvertPreviewResponse(
  plan: FieldRetypeConvertPlan,
  opts: { recordCap: number; previewToken?: string },
): FieldRetypeConvertPreviewResponse {
  const finalOptions = Array.isArray(plan.targetProperty.options) ? plan.targetProperty.options.length : 0
  const response: FieldRetypeConvertPreviewResponse = {
    verdict: plan.verdict,
    sourceType: 'string',
    targetType: plan.targetType,
    scannedRecordCount: plan.scannedRecordCount,
    trash: { scanned: plan.trash.scanned, blocking: plan.trash.blocking },
    recordCap: opts.recordCap,
    cells: { empty: plan.cells.empty, converted: plan.cells.converted, rejected: plan.cells.rejected },
    options: {
      new: plan.optionValues.length,
      final: finalOptions,
      limit: FIELD_RETYPE_MAX_OPTIONS,
      droppedValidationRuleCount: plan.droppedValidationRuleCount,
    },
    rejections: plan.rejections.map((r) => ({ reason: r.reason, recordCount: r.recordCount, recordIds: [...r.recordIds] })),
  }
  if (plan.verdict === 'ok' && typeof opts.previewToken === 'string' && opts.previewToken.length > 0) {
    response.previewToken = opts.previewToken
    response.confirm = FIELD_RETYPE_CONVERT_CONFIRM
  }
  return response
}
