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
 * 已知边界 —— 本刀只覆盖 HTTP 写口 `PATCH /api/multitable/fields/:fieldId`（univer-meta.ts 里
 * 调 assertLosslessFieldRetype 的那一处）。meta_fields.type 还有第二条写口：插件 SDK 的
 * `ensureFields`（multitable/provisioning.ts，`ON CONFLICT (id) DO UPDATE SET ... type = EXCLUDED.type`，
 * 由 index.ts 的 `ensureObjectInScope` 转发 overwriteMode）。它**不过这道门**；它的 fail-closed
 * 到底有多硬，下面这几行 2026-09-11 订正过一次（旧版写「'overwrite' 要显式的环境变量字面量」，
 * 是**假陈述**）：
 *   - 生效值是 `input.overwriteMode ?? resolveEnsureFieldsOverwriteMode()`（provisioning.ts:397）——
 *     **逐次调用的参数优先于环境变量**；`overwriteMode` 是插件 SDK 的公开 per-call 参数
 *     （types/plugin.ts:506，文档自称 "destructive-reconcile mode for this ONE call"），
 *     index.ts:2099 的 `ensureObjectInScope` 原样转发。
 *   - 所以 'overwrite' / 'observe' 既能由 env 全局开，**也能由插件自己一行调用参数打开**，不需要任何
 *     运维动作；插件传 'overwrite' 就直接走 provisioning.ts 那条
 *     `ON CONFLICT (id) DO UPDATE SET ... type = EXCLUDED.type` 把 type 改成任意值，连 per-field 预读都跳过。
 *   - 默认的 'refuse'（抛 MultitableEnsureFieldsRefusedError）只在**调用方没有显式传 overwriteMode**
 *     时成立。这条写口上剩下的真实约束不是本表，是插件作用域门 `assertPluginOwnsObject`（index.ts
 *     的同一个 hook 里）：插件只能这样动**自己拥有的对象**的字段。
 * 也就是说「服务端权威」这句话在本 PR 的范围里等于「HTTP PATCH 这个写口权威 + ensureFields 在
 * **调用方未自选 overwrite/observe** 时 fail-closed」，不等于「任何路径都不可能改类型」。把白名单接进
 * ensureFields 的 type-diff 分支是另一刀（会改插件升级语义：插件自己声明的字段演进也要受这张表
 * 约束，需要先过插件侧的回归）。
 * 反例侧的事实澄清：provisioning.ts 里只有 `patchObjectFieldProperty`（`UPDATE meta_fields SET
 * property = $3::jsonb`）是纯改 property 的，ensureFields 不是。
 * 第三条写口是配置回滚 `applyConfigRevert`（multitable/config-restore.ts，按 changed_keys 拼
 * `UPDATE meta_fields SET type = $1 ...`）。它走的是 T9-W 设计锁那套自己的判据
 * （isSupportedFieldRetypeRevert + 执行侧的 FIELD_TYPE_ERA_MISMATCH 时代守卫），只把字段改回它
 * 曾经的类型，方向与本表相反；本刀一字不动它。
 *
 * 作用域（务必与真值表 JSON 的 SCOPE 段一致）：本模块只回答「这一对算不算无损」。有一整类
 * 类型（formula/lookup/rollup/link/attachment/button/autoNumber + 系统戳）在改类型时要跑自己的
 * 副作用处理（autoNumber 序列、公式依赖、link 连接表、跨 base 墙……）；本白名单对**任一端落在该
 * 集合里**的配对一律不表态（见 assertLosslessFieldRetype），从而 link/formula/autoNumber 的既有路径
 * 一字不变。
 *
 * 这个「不表态」在两端的含义**不一样**，别把它说成一句话（2026-09-11 订正，旧版注释与 PR 正文
 * 都笼统写成「让给既有专门校验」，在源端不成立）：
 *   - **目标端**（nextType ∈ 排除集）：确实有既有校验接手 —— link 的跨 base 墙 /
 *     assertLinkFieldForeignSheetPresent、formula 的反向引用门、lookup/rollup 的 validateLookupRollupConfig、
 *     autoNumber 的 backfill……路由里逐条可见。
 *   - **源端**（currentType ∈ 排除集）：路由里**没有**任何 `currentType === 'attachment' | 'lookup' |
 *     'rollup' | 'button' | 'createdTime' | …` 的对应校验（唯二沾边的是 validateHierarchyParentFieldMutation
 *     ——只管同表单值层级父 link，和 autoNumber 的清序列，后者排在 `UPDATE meta_fields` **之后**，是
 *     副作用不是守卫）。所以 `attachment → string`、`lookup → string`、`button → string` 这类请求
 *     **今天仍然 200 且无人把关**。本刀对源端**不表态、维持既有行为**，不是「交给了谁」。这条缝在
 *     tests/integration/multitable-context.api.test.ts 里有一条 characterization 用例钉着现状，后来人
 *     看得见；要不要把源端也收进白名单（会把 attachment/link → string 变成 400，是产品行为再收紧）
 *     需要 owner 拍板，不在本刀范围。
 *   - 前端是另一套口径：apps/web 的 losslessRetypeTargets 对排除集里的**源**一律返回 []（下拉框里
 *     一个目标都不给）。所以 UI 走不到这条缝，只有直接调 API 的调用方走得到。
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
 *   2. 任一端属于 FIELD_RETYPE_EXCLUDED_TYPES。两端的理由不同，见本文件头的「作用域」：
 *      **目标端**是让给路由里既有的专门校验（link 跨 base 墙 / 公式引用反向门 / lookup-rollup 配置……），
 *      本门不改它们的结论；**源端**则是本刀不表态 —— 路由里没有对应校验，`attachment → string`
 *      一类请求维持既有的 200（已知缝，有 characterization 用例钉着）；
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
