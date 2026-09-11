/**
 * 改字段类型的无损白名单 —— 服务端权威版（F8A 第一刀，裁决 b：边界放后端）。
 *
 * 背景：`PATCH /api/multitable/fields/:fieldId` 接受 `type`，落库是一条裸 `UPDATE meta_fields`，
 * 单元格值一个都不迁移（multitable/lossy-retype-oracle.ts 开头就写明了这一点）。在此之前，
 * (currentType → nextType) 这一对**零校验**：前端 `apps/web/src/multitable/utils/field-retype.ts`
 * 的表只是下拉框里提供什么，任何拿得到 fields:write 的 API 调用方绕开 UI 就能做任意有损改类型。
 * 本模块把那张表搬成服务端的强制边界；前端表降级为它的镜像，两侧同源于
 * `packages/core-backend/tests/fixtures/field-retype-truth-table.json`（双侧镜像测试）。
 *
 * 「无损」在这里只有一个意思：**已有单元格的值在新类型下仍然可读**。不做任何值转换、不碰
 * `meta_records.data`（那是第三刀），也不做有损预检（第二刀 —— 注意 `classifyCellLoss` /
 * `coerceBatch1Value` 对 string/number/select/date/longText 是恒等函数，拿它做预检会给
 * `text → number` 的 "abc" 盖零损失章，所以这里一个字都不复用它）。
 *
 * 作用域（务必与真值表 JSON 的 SCOPE 段一致）：本模块只回答「这一对算不算无损」。有一整类
 * 类型（formula/lookup/rollup/link/attachment/button/autoNumber + 系统戳）在改类型时要跑自己的
 * 副作用处理（autoNumber 序列、公式依赖、link 连接表、跨 base 墙……），它们由路由里既有的那几道
 * 校验各自负责；本白名单对**任一端落在该集合里**的配对一律不表态（见 assertLosslessFieldRetype），
 * 从而 link/formula/autoNumber 的既有路径一字不变。
 */
import { isRichLongTextProperty } from './field-codecs'

/** 拒绝码（稳定）。前端 meta-api-error-labels 按这个码给人话。 */
export const FIELD_RETYPE_NOT_LOSSLESS_CODE = 'FIELD_RETYPE_NOT_LOSSLESS'

/**
 * 带副作用/计算语义的类型：改类型时由路由里各自的专门校验负责，白名单不表态。
 * 与 multitable/config-restore.ts:78-81 的 FIELD_RETYPE_EXCLUDED_TYPES、以及前端
 * field-retype.ts 的 RETYPE_EXCLUDED_TARGET_TYPES 是同一个 11 元集合。
 */
export const FIELD_RETYPE_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
])

/**
 * 源类型 → 允许的目标类型。每一条都必须能说清"为什么无损"：
 *   number/currency/percent/rating → number|string：存的是数字，文本下原样可读；
 *   select/url/email/phone/barcode → string：存的就是字符串；
 *   string → longText：长文本是文本的超集；
 *   longText → string：**仅限非富文本**（见 losslessRetypeTargets 的 rich 分支）。
 * 故意不收的方向（第一刀的刹车，改这里必须同时改真值表 JSON 并让两侧镜像测试通过）：
 *   boolean → string（存的是布尔，落文本是 true/false 不是"是/否"）；
 *   date/dateTime → string（ISO 原文是静默劣化）；
 *   person/multiSelect/attachment → string（对象/数组会把 JSON 喷给用户）；
 *   string → select（select 写路径硬校验，旧值再也存不回去）；
 *   duration/qrcode（存储形状未核）。
 */
export const LOSSLESS_FIELD_RETYPE: Record<string, readonly string[]> = {
  number: ['string'],
  currency: ['number', 'string'],
  percent: ['number', 'string'],
  rating: ['number', 'string'],
  select: ['string'],
  url: ['string'],
  email: ['string'],
  phone: ['string'],
  barcode: ['string'],
  string: ['longText'],
  longText: ['string'],
}

/**
 * `sourceType` 的无损目标集合，去掉自身、去掉 FIELD_RETYPE_EXCLUDED_TYPES。
 *
 * `property` 是**源字段当前的 property**（路由里取自 DB 行，不是请求体）：富文本长文本
 * （`property.rich === true`，判定与 field-codecs 的 isRichLongTextProperty 同源）改成单行文本时，
 * 原始 HTML 会以裸文本暴露给用户 —— 那不是"仍然可读"，所以富文本长文本一个目标都不给。
 * 缺省（property 未提供/不是对象）按非富文本处理：这与存储形状一致（rich 字段一定带 rich:true），
 * 而且服务端这一侧永远是拿 DB 里的 property 来判的。
 */
export function losslessRetypeTargets(
  sourceType: string | null | undefined,
  property?: unknown,
): string[] {
  if (!sourceType) return []
  if (sourceType === 'longText' && isRichLongTextProperty(property)) return []
  const targets = LOSSLESS_FIELD_RETYPE[sourceType]
  if (!targets) return []
  return targets.filter((target) => target !== sourceType && !FIELD_RETYPE_EXCLUDED_TYPES.has(target))
}

/** 这一对是不是无损（纯代数，与在哪儿强制无关）。同类型 → 同类型不是"改类型"，返回 false。 */
export function isLosslessFieldRetype(
  sourceType: string | null | undefined,
  targetType: string | null | undefined,
  property?: unknown,
): boolean {
  if (!sourceType || !targetType) return false
  return losslessRetypeTargets(sourceType, property).includes(targetType)
}

/** 400 FIELD_RETYPE_NOT_LOSSLESS —— message 中文、values-free（不含 fieldId / 表 id / 单元格值）。 */
export class FieldRetypeNotLosslessError extends Error {
  constructor(public readonly currentType: string, public readonly nextType: string) {
    super(`不支持这样改字段类型：${currentType} → ${nextType} 会让已有数据在新类型下不可读。改类型不会转换已有数据，因此只允许无损的方向。`)
    this.name = 'FieldRetypeNotLosslessError'
  }
}

/**
 * 写口守卫：不在白名单里的改类型 ⇒ 抛（路由映射成 400 + 稳定码）。三种情况直接放行：
 *   1. 同类型 → 同类型（根本不是改类型，照旧放行，纯改名/调序/改 property 不受影响）；
 *   2. 任一端属于 FIELD_RETYPE_EXCLUDED_TYPES：这些配对归路由里既有的专门校验管
 *      （link 跨 base 墙 / 公式引用反向门 / autoNumber 序列 / 层级父字段……），本门不改它们的结论；
 *   3. 在白名单里。
 * 调用点必须排在那些专门校验**之后**（它们对同一个请求给的是更具体的原因，保持优先级）、
 * 且在任何写语句**之前** —— 与本路由既有的 assertLinkFieldForeignSheetPresent 同一个位置惯例。
 */
export function assertLosslessFieldRetype(
  currentType: string,
  nextType: string,
  currentProperty?: unknown,
): void {
  if (currentType === nextType) return
  if (FIELD_RETYPE_EXCLUDED_TYPES.has(currentType) || FIELD_RETYPE_EXCLUDED_TYPES.has(nextType)) return
  if (!isLosslessFieldRetype(currentType, nextType, currentProperty)) {
    throw new FieldRetypeNotLosslessError(currentType, nextType)
  }
}
