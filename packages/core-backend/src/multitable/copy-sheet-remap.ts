/**
 * 「复制数据表（含数据）」的 id-remap 层 —— 纯函数、无 IO（设计锁 ADR
 * docs/development/multitable-copy-sheet-with-data-adr-20260926.md CS-9 / CS-10 / CS-12 / §5）。
 *
 * 一切都在 **fail-closed allowlist** 上：
 *   - 字段 property 携带 id 的键必须**显式列举**（`sanitizeFieldProperty` 以 `...obj` 透传任意键，
 *     `field-codecs.ts` 的各类型分支不是闭合 allowlist，所以这里必须自己闭合）；
 *   - 任何未列举的键若值形如 `fld_…`（含数组元素 / 嵌套对象）→ `COPY_UNMAPPED_FIELD_REF`，整次拒绝；
 *   - 视图 config 同理：已知键（`*FieldId` / `*fieldIds` / `publicForm`）之外残留的 `fld_` 引用 → 同码拒绝。
 *
 * 错误只带 `code` 与 `fieldId` / `viewId`（位置），**永不**带单元格值或表达式文本（values-free）。
 */

import type { ConditionalRule } from './permission-rule-evaluator'

export const COPY_UNMAPPED_FIELD_REF = 'COPY_UNMAPPED_FIELD_REF'
export const COPY_SOURCE_RULE_UNBUILDABLE = 'COPY_SOURCE_RULE_UNBUILDABLE'
export const COPY_SOURCE_RULE_ON_RENUMBERED_FIELD = 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD'
export const COPY_UNSUPPORTED_FIELD_TYPE = 'COPY_UNSUPPORTED_FIELD_TYPE'

export class CopySheetRemapError extends Error {
  constructor(
    public readonly code: string,
    public readonly fieldId?: string,
    public readonly viewId?: string,
  ) {
    super(code)
    this.name = 'CopySheetRemapError'
  }
}

/** 披露原因码（ADR §3 dry-run / 结果 toast）。 */
export type CopyDisclosureCode =
  | 'ATTACHMENT_BLANKED'
  | 'SELF_LINK_BLANKED'
  | 'MIRROR_NOT_BUILT'
  | 'DEPENDS_ON_BLANKED_COLUMN'
  | 'BUTTON_DISABLED'
  | 'PROPERTY_HIDDEN_BLANKED'

export interface CopyFieldDisclosure {
  fieldId: string
  code: CopyDisclosureCode
}

/** 一个源字段行（`meta_fields` 原样读出，property 已 normalizeJson）。 */
export interface SourceFieldRow {
  id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

/** 复制路径接受的字段类型（`field-codecs.ts` 的 MultitableFieldType 全集）。未知类型 fail-closed。 */
export const COPYABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'date', 'dateTime', 'formula', 'select', 'multiSelect', 'link', 'person',
  'lookup', 'rollup', 'attachment', 'currency', 'percent', 'rating', 'duration', 'url', 'email', 'phone',
  'barcode', 'qrcode', 'location', 'longText', 'autoNumber', 'createdTime', 'modifiedTime', 'createdBy',
  'modifiedBy', 'button',
])

const DERIVED_FIELD_TYPES: ReadonlySet<string> = new Set(['formula', 'lookup', 'rollup'])
const SYSTEM_FIELD_TYPES: ReadonlySet<string> = new Set(['autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy'])

const FIELD_ID_PATTERN = /^fld_/
/** 与 formula-engine.ts 的 FIELD_REF_PATTERN 同形（`{fld_…}`）。 */
const FORMULA_FIELD_REF_PATTERN = /\{(fld_[a-zA-Z0-9_-]+)\}/g

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeFieldId(value: unknown): boolean {
  return typeof value === 'string' && FIELD_ID_PATTERN.test(value.trim())
}

/** 深扫一个值里是否**残留**任何 `fld_` 形状的字符串（数组元素、嵌套对象都算）。allowlist 之外出现即拒绝。 */
function containsFieldIdLike(value: unknown): boolean {
  if (looksLikeFieldId(value)) return true
  if (Array.isArray(value)) return value.some(containsFieldIdLike)
  if (isPlainObject(value)) return Object.values(value).some(containsFieldIdLike)
  return false
}

export interface FieldRemapContext {
  sourceSheetId: string
  newSheetId: string
  /** 源字段 id → 新字段 id。**每个**源字段（含不建的镜像列）都有条目，所以任何合法源引用都能 remap。 */
  fieldIdMap: ReadonlyMap<string, string>
  /** 源字段 id → 源字段类型（判 autoNumber / 镜像 / 附件 等）。 */
  fieldTypeById: ReadonlyMap<string, string>
  /** 源字段 id → 源 property（判 lookup/rollup 的 link 目标是否自指）。 */
  fieldPropertyById: ReadonlyMap<string, Record<string, unknown>>
  /** 不建的源字段 id（S1 = 镜像列）。 */
  unbuiltFieldIds: ReadonlySet<string>
  /** 值被清空的**输入**列 id（S1 = 附件、自链接、property-hidden 且复制者无 canManageFields）。 */
  blankedFieldIds: ReadonlySet<string>
}

function mapFieldIdOrThrow(ctx: FieldRemapContext, ownerFieldId: string, raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : ''
  const mapped = id ? ctx.fieldIdMap.get(id) : undefined
  if (!mapped) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, ownerFieldId)
  return mapped
}

const LINK_FIELD_ID_ALIASES = ['linkFieldId', 'relatedLinkFieldId', 'linkedFieldId', 'sourceFieldId'] as const
const TARGET_FIELD_ID_ALIASES = ['targetFieldId', 'lookUpTargetFieldId', 'lookupTargetFieldId', 'lookupFieldId'] as const
const FOREIGN_SHEET_ID_ALIASES = ['foreignSheetId', 'foreignDatasheetId', 'datasheetId'] as const

/**
 * property 里**已显式处理**的键。除此之外的键做残留扫描：任何 `fld_` 形状的值 → 拒绝。
 * `aiShortcut.sourceFieldIds` 单独处理（A2 配置携带本表字段 id）。
 */
const HANDLED_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  ...LINK_FIELD_ID_ALIASES,
  ...TARGET_FIELD_ID_ALIASES,
  ...FOREIGN_SHEET_ID_ALIASES,
  'foreignBaseId',
  'mirrorFieldId',
  'mirrorOf',
  'twoWay',
  'visibilityRule',
  'requiredWhen',
  'expression',
  'actionType',
  'actionConfig',
  'aiShortcut',
])

function foreignSheetIdOf(property: Record<string, unknown>): string {
  for (const key of FOREIGN_SHEET_ID_ALIASES) {
    const v = property[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function linkFieldIdOf(property: Record<string, unknown>): string {
  for (const key of LINK_FIELD_ID_ALIASES) {
    const v = property[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function isPropertyHidden(property: Record<string, unknown>): boolean {
  return property.hidden === true || property.visible === false
}

function isMirrorLink(field: Pick<SourceFieldRow, 'type' | 'property'>): boolean {
  return field.type === 'link' && typeof field.property.mirrorOf === 'string' && field.property.mirrorOf.trim().length > 0
}

function remapRuleLike(ctx: FieldRemapContext, ownerFieldId: string, raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw
  const next: Record<string, unknown> = { ...raw }
  if ('fieldId' in raw) next.fieldId = mapFieldIdOrThrow(ctx, ownerFieldId, raw.fieldId)
  // 规则的 value 是字面量，不该带 fld_；带了就是未列举引用。
  if (containsFieldIdLike(raw.value)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, ownerFieldId)
  return next
}

export function remapFormulaExpression(ctx: FieldRemapContext, ownerFieldId: string, expression: unknown): string {
  if (typeof expression !== 'string') return ''
  return expression.replace(FORMULA_FIELD_REF_PATTERN, (_match, fieldId: string) => {
    const mapped = ctx.fieldIdMap.get(fieldId)
    if (!mapped) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, ownerFieldId)
    return `{${mapped}}`
  })
}

/**
 * 字段 property 的 remap（§5.2 allowlist）。输入是源 property（normalizeJson 后），输出是新表要写的
 * property。抛 {@link CopySheetRemapError}（COPY_UNMAPPED_FIELD_REF）表示 allowlist 之外出现了 `fld_` 引用。
 */
export function remapFieldProperty(ctx: FieldRemapContext, field: SourceFieldRow): Record<string, unknown> {
  const src = field.property
  const next: Record<string, unknown> = {}
  const foreignIsSource = foreignSheetIdOf(src) === ctx.sourceSheetId

  for (const [key, value] of Object.entries(src)) {
    if (HANDLED_PROPERTY_KEYS.has(key)) continue
    if (containsFieldIdLike(value)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, field.id)
    next[key] = value
  }

  // link / lookup / rollup 的外表：自指 → 新表；外表不变。`foreignBaseId`（跨 Base 声明）S1 同 Base：原样。
  for (const key of FOREIGN_SHEET_ID_ALIASES) {
    if (typeof src[key] !== 'string') continue
    next[key] = foreignIsSource ? ctx.newSheetId : src[key]
  }
  if (typeof src.foreignBaseId === 'string' && src.foreignBaseId.trim()) next.foreignBaseId = src.foreignBaseId

  // lookup / rollup：linkFieldId 指本表 link → remap；targetFieldId 只在该 link 自指源表时 remap（外表字段不动）。
  for (const key of LINK_FIELD_ID_ALIASES) {
    if (typeof src[key] !== 'string' || !(src[key] as string).trim()) continue
    next[key] = mapFieldIdOrThrow(ctx, field.id, src[key])
  }
  const linkId = linkFieldIdOf(src)
  const linkProperty = linkId ? ctx.fieldPropertyById.get(linkId) : undefined
  const targetIsInSource = (linkProperty ? foreignSheetIdOf(linkProperty) === ctx.sourceSheetId : false)
    || (field.type === 'link' && foreignIsSource)
  for (const key of TARGET_FIELD_ID_ALIASES) {
    if (typeof src[key] !== 'string' || !(src[key] as string).trim()) continue
    next[key] = targetIsInSource ? mapFieldIdOrThrow(ctx, field.id, src[key]) : src[key]
  }

  // 双向 / 镜像配对：`mirrorFieldId` 丢弃、`twoWay` 不带（否则要在外表建镜像列，§5.1）；`mirrorOf` 列本就不建。
  // （不写 next.mirrorFieldId / next.twoWay / next.mirrorOf）

  if ('visibilityRule' in src) next.visibilityRule = remapRuleLike(ctx, field.id, src.visibilityRule)
  if ('requiredWhen' in src) next.requiredWhen = remapRuleLike(ctx, field.id, src.requiredWhen)

  if (field.type === 'formula') {
    next.expression = remapFormulaExpression(ctx, field.id, src.expression)
  } else if ('expression' in src) {
    if (containsFieldIdLike(src.expression)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, field.id)
    next.expression = src.expression
  }

  if (field.type === 'button') {
    // §5.1：actionType → record_click、actionConfig 不复制（源 actionConfig 可含 webhook url / HMAC secret /
    // 按源字段 id 键的 update_record）。label / variant / confirm 已在上面的透传里保留。
    next.actionType = 'record_click'
  } else {
    if (typeof src.actionType === 'string') next.actionType = src.actionType
    if ('actionConfig' in src) {
      if (containsFieldIdLike(src.actionConfig)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, field.id)
      next.actionConfig = src.actionConfig
    }
  }

  if (isPlainObject(src.aiShortcut)) {
    const shortcut = { ...src.aiShortcut }
    if (Array.isArray(shortcut.sourceFieldIds)) {
      shortcut.sourceFieldIds = shortcut.sourceFieldIds.map((id) => mapFieldIdOrThrow(ctx, field.id, id))
    }
    if (containsFieldIdLike(shortcut.params)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, field.id)
    next.aiShortcut = shortcut
  } else if ('aiShortcut' in src && containsFieldIdLike(src.aiShortcut)) {
    throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, field.id)
  }

  return next
}

/** 一个源字段在新表里的建法。 */
export interface FieldCopyPlan {
  sourceFieldId: string
  newFieldId: string
  name: string
  type: string
  /** 已 remap 的 property（不建的列这里也算出来，但调用方不写）。 */
  property: Record<string, unknown>
  order: number
  /** false = S1 不建（镜像列）。 */
  build: boolean
  /** 值是否复制：false = 列建、值空（附件 / 自链接 / property-hidden 无权）。派生 / 系统 / 按钮列恒 false。 */
  copyValues: boolean
  disclosures: CopyFieldDisclosure[]
}

export interface FieldPlanOptions {
  /** 复制者对源表持有 canManageFields → property-hidden 列的值可复制（ADR §4.1 第二层）。 */
  copierCanManageSourceFields: boolean
}

interface Classification {
  build: boolean
  copyValues: boolean
  /** 一个**输入**列的值被清空（附件 / 自链接 / hidden-无权）。派生 / 系统 / 按钮列不算。 */
  blanked: boolean
  disclosures: CopyFieldDisclosure[]
}

function classifyField(field: SourceFieldRow, sourceSheetId: string, opts: FieldPlanOptions): Classification {
  if (!COPYABLE_FIELD_TYPES.has(field.type)) {
    throw new CopySheetRemapError(COPY_UNSUPPORTED_FIELD_TYPE, field.id)
  }
  if (isMirrorLink(field)) {
    return { build: false, copyValues: false, blanked: false, disclosures: [{ fieldId: field.id, code: 'MIRROR_NOT_BUILT' }] }
  }
  // 派生 / 系统列：建，值由服务端算（createRecord 拒绝写这些列）。
  if (DERIVED_FIELD_TYPES.has(field.type) || SYSTEM_FIELD_TYPES.has(field.type)) {
    return { build: true, copyValues: false, blanked: false, disclosures: [] }
  }
  if (field.type === 'button') {
    return { build: true, copyValues: false, blanked: false, disclosures: [{ fieldId: field.id, code: 'BUTTON_DISABLED' }] }
  }
  if (field.type === 'attachment') {
    return { build: true, copyValues: false, blanked: true, disclosures: [{ fieldId: field.id, code: 'ATTACHMENT_BLANKED' }] }
  }
  if (field.type === 'link' && foreignSheetIdOf(field.property) === sourceSheetId) {
    return { build: true, copyValues: false, blanked: true, disclosures: [{ fieldId: field.id, code: 'SELF_LINK_BLANKED' }] }
  }
  if (isPropertyHidden(field.property) && !opts.copierCanManageSourceFields) {
    return { build: true, copyValues: false, blanked: true, disclosures: [{ fieldId: field.id, code: 'PROPERTY_HIDDEN_BLANKED' }] }
  }
  return { build: true, copyValues: true, blanked: false, disclosures: [] }
}

/**
 * 派生列（lookup / rollup / formula）的传递依赖里有没有被清空 / 未建的列。formula 看 `{fld_…}` 引用，
 * lookup / rollup 看 linkFieldId。一层就够：S1 的清空源只有附件 / 自链接 / 镜像 / hidden-无权，
 * 而这些都是叶子列。
 */
function dependsOnBlanked(ctx: FieldRemapContext, field: SourceFieldRow): boolean {
  const blankedOrUnbuilt = (id: string) => ctx.blankedFieldIds.has(id) || ctx.unbuiltFieldIds.has(id)
  if (field.type === 'formula') {
    const expression = typeof field.property.expression === 'string' ? field.property.expression : ''
    const pattern = new RegExp(FORMULA_FIELD_REF_PATTERN.source, 'g')
    let m: RegExpExecArray | null
    while ((m = pattern.exec(expression)) !== null) {
      if (blankedOrUnbuilt(m[1])) return true
    }
    return false
  }
  if (field.type === 'lookup' || field.type === 'rollup') {
    const linkId = linkFieldIdOf(field.property)
    return linkId ? blankedOrUnbuilt(linkId) : false
  }
  return false
}

/**
 * 整张表的字段复制计划。`mintFieldId` 由调用方注入（服务端 mint，保持 `fld_` 前缀，CS-9）。
 * 返回顺序 = 输入顺序（调用方按源 `order ASC, id ASC` 读）。
 */
export function planFieldCopies(
  fields: readonly SourceFieldRow[],
  sourceSheetId: string,
  newSheetId: string,
  mintFieldId: () => string,
  opts: FieldPlanOptions,
): { plans: FieldCopyPlan[]; ctx: FieldRemapContext } {
  const fieldIdMap = new Map<string, string>()
  const fieldTypeById = new Map<string, string>()
  const fieldPropertyById = new Map<string, Record<string, unknown>>()
  const unbuiltFieldIds = new Set<string>()
  const blankedFieldIds = new Set<string>()
  const classified = new Map<string, Classification>()

  for (const field of fields) {
    const newId = mintFieldId()
    if (!FIELD_ID_PATTERN.test(newId)) throw new Error('COPY_FIELD_ID_PREFIX_INVALID')
    fieldIdMap.set(field.id, newId)
    fieldTypeById.set(field.id, field.type)
    fieldPropertyById.set(field.id, field.property)
    const c = classifyField(field, sourceSheetId, opts)
    classified.set(field.id, c)
    if (!c.build) unbuiltFieldIds.add(field.id)
    if (c.blanked) blankedFieldIds.add(field.id)
  }

  const ctx: FieldRemapContext = {
    sourceSheetId,
    newSheetId,
    fieldIdMap,
    fieldTypeById,
    fieldPropertyById,
    unbuiltFieldIds,
    blankedFieldIds,
  }
  const plans: FieldCopyPlan[] = []
  for (const field of fields) {
    const c = classified.get(field.id)!
    const disclosures = [...c.disclosures]
    if (c.build && DERIVED_FIELD_TYPES.has(field.type) && dependsOnBlanked(ctx, field)) {
      disclosures.push({ fieldId: field.id, code: 'DEPENDS_ON_BLANKED_COLUMN' })
    }
    plans.push({
      sourceFieldId: field.id,
      newFieldId: fieldIdMap.get(field.id)!,
      name: field.name,
      type: field.type,
      property: remapFieldProperty(ctx, field),
      order: field.order,
      build: c.build,
      copyValues: c.copyValues,
      disclosures,
    })
  }
  return { plans, ctx }
}

// ── 视图 ────────────────────────────────────────────────────────────────────

export interface SourceViewRow {
  id: string
  name: string
  type: string
  filterInfo: Record<string, unknown>
  sortInfo: Record<string, unknown>
  groupInfo: Record<string, unknown>
  hiddenFieldIds: string[]
  config: Record<string, unknown>
}

export interface ViewCopyPlan {
  sourceViewId: string
  newViewId: string
  name: string
  type: string
  filterInfo: Record<string, unknown>
  sortInfo: Record<string, unknown>
  groupInfo: Record<string, unknown>
  hiddenFieldIds: string[]
  config: Record<string, unknown>
  /** 被整条删除的 filter 叶子数（指向被清空 / 未建 / 未知列）。 */
  droppedFilterLeaves: number
}

/** 叶子 fieldId 可用 = 在映射表里、且不是被清空 / 未建的列。 */
function leafFieldUsable(ctx: FieldRemapContext, fieldId: unknown): string | null {
  const id = typeof fieldId === 'string' ? fieldId.trim() : ''
  if (!id) return null
  if (ctx.blankedFieldIds.has(id) || ctx.unbuiltFieldIds.has(id)) return null
  return ctx.fieldIdMap.get(id) ?? null
}

/**
 * filter 树的 remap：叶子 `fieldId` remap；指向被清空 / 未建 / 未知列的叶子**整条删除**并计数
 * （文字面 redaction 先例 `univer-meta.ts` redactViewConfigFilterLiterals 的同一棵树结构：
 * `{ conjunction, conditions: [leaf | group] }`）。
 */
export function remapFilterInfo(
  ctx: FieldRemapContext,
  filterInfo: Record<string, unknown>,
  counter: { dropped: number },
): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (!isPlainObject(node)) return node
    if (Array.isArray(node.conditions)) {
      const kept: unknown[] = []
      for (const child of node.conditions) {
        const out = walk(child)
        if (out !== null) kept.push(out)
      }
      return { ...node, conditions: kept }
    }
    if ('fieldId' in node) {
      const mapped = leafFieldUsable(ctx, node.fieldId)
      if (!mapped) {
        counter.dropped += 1
        return null
      }
      // 叶子的 value 是字面量，不该带 fld_；带了就是未列举引用（fail-closed）。
      if (containsFieldIdLike(node.value)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF)
      return { ...node, fieldId: mapped }
    }
    return node
  }
  const out = walk(filterInfo)
  return isPlainObject(out) ? out : {}
}

const FIELD_ID_KEY = /(^fieldId$)|(FieldId$)/
const FIELD_IDS_KEY = /(^fieldIds$)|(FieldIds$)/

/**
 * 视图 `config` / `sortInfo` / `groupInfo` 的 remap：
 *   - `publicForm` 整段剥离（分享令牌）；
 *   - 键名为 `fieldId` 或以 `FieldId` 结尾 → remap（指向清空 / 未建 / 未知列 → 删键）；
 *   - 键名为 `fieldIds` 或以 `FieldIds` 结尾且为数组 → 逐个 remap、丢不可用；
 *   - `conditionalFormattingRules[*]`（及嵌套）落在同一规则里（数组递归）；
 *   - 其它位置残留的 `fld_` 形状字符串 → COPY_UNMAPPED_FIELD_REF。
 */
export function remapViewConfig(ctx: FieldRemapContext, config: Record<string, unknown>, viewId: string): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map((child) => walk(child))
    if (!isPlainObject(node)) {
      if (looksLikeFieldId(node)) throw new CopySheetRemapError(COPY_UNMAPPED_FIELD_REF, undefined, viewId)
      return node
    }
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'publicForm') continue
      if (FIELD_ID_KEY.test(key) && (typeof value === 'string' || value === null)) {
        if (value === null) { next[key] = null; continue }
        const mapped = leafFieldUsable(ctx, value)
        if (!mapped) continue // 指向清空 / 未建 / 未知列 → 删键
        next[key] = mapped
        continue
      }
      if (FIELD_IDS_KEY.test(key) && Array.isArray(value)) {
        next[key] = value
          .map((id) => leafFieldUsable(ctx, id))
          .filter((id): id is string => typeof id === 'string')
        continue
      }
      next[key] = walk(value)
    }
    return next
  }
  const out = walk(config)
  return isPlainObject(out) ? out : {}
}

export function planViewCopies(
  ctx: FieldRemapContext,
  views: readonly SourceViewRow[],
  mintViewId: () => string,
): ViewCopyPlan[] {
  return views.map((view) => {
    const counter = { dropped: 0 }
    let filterInfo: Record<string, unknown>
    try {
      filterInfo = remapFilterInfo(ctx, view.filterInfo, counter)
    } catch (err) {
      if (err instanceof CopySheetRemapError) throw new CopySheetRemapError(err.code, err.fieldId, view.id)
      throw err
    }
    // sortInfo.rules[*].fieldId / groupInfo.fieldId / groupInfo.fieldIds 都落在 `*fieldId(s)` 规则里。
    const sortInfo = remapViewConfig(ctx, view.sortInfo, view.id)
    const groupInfo = remapViewConfig(ctx, view.groupInfo, view.id)
    const config = remapViewConfig(ctx, view.config, view.id)
    // 隐藏列：被清空的列仍然建了，照样可以隐藏 → 只要在映射表里就 remap；未建 / 未知列丢弃。
    const hiddenFieldIds = view.hiddenFieldIds
      .map((id) => (ctx.unbuiltFieldIds.has(id) ? null : ctx.fieldIdMap.get(id) ?? null))
      .filter((id): id is string => typeof id === 'string')
    return {
      sourceViewId: view.id,
      newViewId: mintViewId(),
      name: view.name,
      type: view.type,
      filterInfo,
      sortInfo,
      groupInfo,
      hiddenFieldIds,
      config,
      droppedFilterLeaves: counter.dropped,
    }
  })
}

// ── 行级规则 ────────────────────────────────────────────────────────────────

/**
 * `conditional_read_rules` 的 remap（CS-7 / CS-12）：`fieldId` remap；规则**永不丢弃**——
 *   - 引用未建列（镜像）→ COPY_SOURCE_RULE_UNBUILDABLE；
 *   - 引用未知列 → 同码（源表里这条规则已是 fail-closed DENY；复制后仍需可判定，宁可拒绝）；
 *   - 引用 autoNumber 且 `autoNumberRenumbered`（有行会换号）→ COPY_SOURCE_RULE_ON_RENUMBERED_FIELD。
 */
export function remapConditionalRules(
  ctx: FieldRemapContext,
  rules: readonly ConditionalRule[],
  autoNumberRenumbered: boolean,
): ConditionalRule[] {
  return rules.map((rule) => {
    const id = typeof rule.fieldId === 'string' ? rule.fieldId.trim() : ''
    const mapped = id ? ctx.fieldIdMap.get(id) : undefined
    if (!mapped || ctx.unbuiltFieldIds.has(id)) {
      throw new CopySheetRemapError(COPY_SOURCE_RULE_UNBUILDABLE, id || undefined)
    }
    if (ctx.fieldTypeById.get(id) === 'autoNumber' && autoNumberRenumbered) {
      throw new CopySheetRemapError(COPY_SOURCE_RULE_ON_RENUMBERED_FIELD, id)
    }
    return { ...rule, fieldId: mapped }
  })
}

/** 规则里是否有引用 autoNumber 列的（决定要不要算重编号）。 */
export function rulesReferenceAutoNumber(ctx: FieldRemapContext, rules: readonly ConditionalRule[]): boolean {
  return rules.some((rule) => ctx.fieldTypeById.get(typeof rule.fieldId === 'string' ? rule.fieldId.trim() : '') === 'autoNumber')
}
