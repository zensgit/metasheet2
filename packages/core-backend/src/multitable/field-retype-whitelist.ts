/**
 * 改字段类型的无损白名单 —— 服务端权威版（F8A 第一刀，裁决 b：边界放后端）。
 *
 * 背景：`PATCH /api/multitable/fields/:fieldId` 接受 `type`，落库是一条裸 `UPDATE meta_fields`，
 * 单元格值一个都不迁移（multitable/lossy-retype-oracle.ts 开头就写明了这一点）。在此之前，
 * (currentType → nextType) 这一对**除 link/formula/lookup/rollup 目标与层级父字段外零配对校验**：
 * 前端 `apps/web/src/multitable/utils/field-retype.ts` 的表只是下拉框里提供什么，任何过得了
 * `capabilities.canManageFields`（管理员角色或 `multitable:manage-schema`；univer-meta.ts:4480/:4511，
 * 本路由的门在 :12937 —— 没有 `fields:write` 这个权限名）的 API 调用方绕开 UI 就能做任意有损改类型。
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
 *     （types/plugin.ts:506，文档自称 "destructive-reconcile mode for this ONE call"）。
 *     转发点是**两个** hook，都原样转发：`packages/core-backend/src/index.ts:2099` 的
 *     `ensureObjectInScope`（scoped 路径，转发前先 `assertPluginOwnsObject`），以及 :825 的裸
 *     `ensureObject`（**没有** assertPluginOwnsObject；plugin-scope.ts:403-416 在宿主未注册
 *     scoped hook 时回退到它）。shipped 宿主注册了 scoped hook。
 *   - 所以 'overwrite' / 'observe' 既能由 env 全局开，**也能由插件自己一行调用参数打开**，不需要任何
 *     运维动作；插件传 'overwrite' 就直接走 provisioning.ts 那条
 *     `ON CONFLICT (id) DO UPDATE SET ... type = EXCLUDED.type` 把 type 改成任意值，连 per-field 预读都跳过。
 *     **这不是假想**：`plugins/plugin-attendance/index.cjs:3053-3057` 与 `:4391-4395` 两处生产代码
 *     今天就在传 `overwriteMode: 'overwrite'`（考勤报表的派生值列，按目录重算 order），也就能把这些
 *     字段的 type 改成描述符所写的任意值（含 longText → string），不过本表。
 *   - 默认的 'refuse'（抛 MultitableEnsureFieldsRefusedError）只在**调用方没有显式传 overwriteMode**
 *     时成立 —— 范围要说准：今天已经有 plugin-attendance 两处自选了 overwrite，所以这条 fail-closed
 *     只对「其余未自选的调用方」成立。这条写口上剩下的真实约束不是本表，是插件作用域门
 *     `assertPluginOwnsObject`（index.ts:2099 那个 scoped hook 里；:825 的回退路径上没有它）：在当前
 *     接线下，自选 overwrite 的插件只能这样动**自己拥有的对象**的字段。
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
 *   - **目标端**（nextType ∈ 排除集）：11 个目标里只有 4 个真有既有校验接手 —— link（跨 base 墙 /
 *     assertLinkFieldForeignSheetPresent，univer-meta.ts:13025/:13088）、formula（表达式校验 + 反向
 *     引用门 + 批量重算上限，:13054/:13060/:13115）、lookup 与 rollup（validateLookupRollupConfig，
 *     :12989；注意它对非 lookup/rollup 的 nextType 直接 `return null`）。
 *     **其余 5 个目标 —— attachment / createdTime /
 *     modifiedTime / createdBy / modifiedBy —— 零守卫**：PATCH 体里根本没有对应的 `nextType === …`
 *     分支，所以 `text → attachment` 一类请求今天仍然 200。
 *     **`autoNumber` 作目标不是校验，是破坏性副作用**：白名单因目标属排除集直接放行，主
 *     `UPDATE meta_fields` 落库之后，univer-meta.ts:13163-13165 调
 *     `backfillAutoNumberField(..., { overwrite: true })`，其 SQL（auto-number-service.ts:112-131）是
 *     `UPDATE meta_records ... SET data = jsonb_set(...) WHERE sheet_id = $3 AND ($4::boolean OR NOT (data ? $1))`，
 *     `$4 = true` ⇒ **该列所有既有单元格值被序号覆写**。这与「本刀零后端数据改写」并存的前提是：
 *     这条覆写是改动前就有的既有行为，本刀一字不动它，但它必须被如实写出来，不能算进「有校验接手」。
 *     两条 characterization 用例（`text → attachment`、`text → autoNumber`）在
 *     tests/integration/multitable-context.api.test.ts 里钉着这两个事实。
 *     「对已有数据的列拒绝 → autoNumber」（照 assertRichLongTextToggleAllowed 的「已有数据则拒」形状）
 *     是产品行为收紧，列进 owner 待办，不在本刀。
 *   - **源端**（currentType ∈ 排除集）：路由里**没有**任何 `currentType === 'attachment' | 'lookup' |
 *     'rollup' | 'button' | 'createdTime' | …` 的对应校验（唯二沾边的是 validateHierarchyParentFieldMutation
 *     ——只管同表单值层级父 link，和 autoNumber 的清序列，后者排在 `UPDATE meta_fields` **之后**，是
 *     副作用不是守卫）。所以 `attachment → string`、`lookup → string`、`button → string` 这类请求
 *     **今天仍然 200 且无人把关**。本刀对源端**不表态、维持既有行为**，不是「交给了谁」。这条缝在
 *     tests/integration/multitable-context.api.test.ts 里有一条 characterization 用例钉着现状，后来人
 *     看得见；要不要把源端也收进白名单（会把 attachment/link → string 变成 400，是产品行为再收紧）
 *     需要 owner 拍板，不在本刀范围。
 *   - 前端是另一套口径：apps/web 的 losslessRetypeTargets 对排除集里的**源**一律返回 []（下拉框里
 *     一个目标都不给），排除集里的**目标**也从不出现在下拉框里（RETYPE_EXCLUDED_TARGET_TYPES 过滤）。
 *     所以两端的缝 UI 都走不到，只有直接调 API 的调用方走得到 —— 但「缝」是两端都有，不只源端。
 */
import { isRichLongTextProperty } from './field-codecs'

/** 拒绝码（稳定）。前端 meta-api-error-labels 按这个码给人话。 */
export const FIELD_RETYPE_NOT_LOSSLESS_CODE = 'FIELD_RETYPE_NOT_LOSSLESS'

/**
 * 带副作用/计算语义的类型：白名单对任一端落在此集合的配对**不表态**（不等于「有人接手」——
 * 逐个目标的真实情况见本文件头「作用域」：只有 link/formula/lookup/rollup 有既有校验，
 * attachment 与 4 个系统戳零守卫，autoNumber 是主 UPDATE 之后的整列覆写）。
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
 * `property` **必传**，且必须是**源字段当前的 property**（路由里取自 DB 行，不是请求体）：富文本长文本
 * （`property.rich === true`，判定与 field-codecs 的 isRichLongTextProperty 同源）改成单行文本时，
 * 原始 HTML 会以裸文本暴露给用户 —— 那不是"仍然可读"，所以富文本长文本一个目标都不给。
 *
 * 「不是对象 / rich 不是 true ⇒ 按非富文本处理」这句只在**传进来的确实是该字段在库里的 property**
 * 这个前提下与存储形状一致（rich 字段一定带 rich:true）；一旦调用方漏传、或者传的是请求体里那份
 * "改完之后"的 property，这个缺省就是 fail-open（rich 长文本会被判成非 rich 从而放行）。所以本函数
 * 不再接受"不传"：漏传直接抛（下方 arity 检查），由 TypeScript 与运行时**两道**挡住。
 * 注意这条缺省**挡不住两步绕过**：先 `PATCH {property:{}}` 把 rich 关掉（`assertRichLongTextToggleAllowed`
 * 只判 turning ON，`sanitizeFieldPropertyByType` 没有 longText 分支），再 `PATCH {type:'string'}` —— 第二次
 * 请求读到的库内 property 已经是 `{}`，两步都 200，HTML 原样留在单元格里。要不要给 rich ON→OFF 加
 * 「已有数据则拒」的门是 owner 决策，本刀不加，只用 characterization 用例把这条路径钉住。
 */
export function losslessRetypeTargets(
  sourceType: string | null | undefined,
  property: unknown,
): string[] {
  // fail-closed：`property` 是必传参数。测试文件不在 tsconfig 的 include 里（**/*.test.ts 被 exclude），
  // 光靠类型签名挡不住测试与 JS 调用方，所以这里补一条运行时 arity 检查 —— 漏传是编程错误，抛在
  // 任何写语句之前，不会退化成"按非富文本放行"。
  if (arguments.length < 2) {
    throw new Error('losslessRetypeTargets：property 必传（源字段在库里的 property）；漏传会把富文本长文本判成非富文本 = fail-open')
  }
  if (!sourceType) return []
  if (sourceType === 'longText' && isRichLongTextProperty(property)) return []
  const targets = LOSSLESS_FIELD_RETYPE[sourceType]
  if (!targets) return []
  return targets.filter((target) => target !== sourceType && !FIELD_RETYPE_EXCLUDED_TYPES.has(target))
}

/**
 * 这一对是不是无损（纯代数，与在哪儿强制无关）。同类型 → 同类型不是"改类型"，返回 false。
 * `property` 与 losslessRetypeTargets 同义、同样**必传**（见那里的 fail-open 说明）。
 */
export function isLosslessFieldRetype(
  sourceType: string | null | undefined,
  targetType: string | null | undefined,
  property: unknown,
): boolean {
  // fail-closed：同 losslessRetypeTargets —— 否则漏传的调用方换一个函数名就能拿回那个静默缺省。
  if (arguments.length < 3) {
    throw new Error('isLosslessFieldRetype：property 必传（源字段在库里的 property）；漏传会把富文本长文本判成非富文本 = fail-open')
  }
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
 *   2. 任一端属于 FIELD_RETYPE_EXCLUDED_TYPES。**两端都是"本门不表态"，不是"有人接手"**，逐个目标的
 *      真实情况见本文件头的「作用域」：只有 link / formula / lookup / rollup 作目标时真有既有校验
 *      （本门不改它们的结论）；attachment / createdTime / modifiedTime / createdBy / modifiedBy 作目标
 *      零守卫、仍是 200；autoNumber 作目标是主 UPDATE 之后 `backfillAutoNumberField(overwrite:true)`
 *      的整列覆写（破坏性副作用，不是校验）。**源端**同样是不表态 —— 路由里没有对应校验，
 *      `attachment → string` 一类请求维持既有的 200。三条缝都有 characterization 用例钉着。
 *   3. 在白名单里。
 * `currentProperty` **必传**（源字段在库里的 property，不是请求体里那份）；见 losslessRetypeTargets。
 * 调用点必须排在那些专门校验**之后**（它们对同一个请求给的是更具体的原因，保持优先级）、
 * 且在任何写语句**之前** —— 与本路由既有的 assertLinkFieldForeignSheetPresent 同一个位置惯例。
 */
export function assertLosslessFieldRetype(
  currentType: string,
  nextType: string,
  currentProperty: unknown,
): void {
  // fail-closed：同 losslessRetypeTargets 的 arity 检查，且刻意排在"同类型直接放行"之前 ——
  // 漏传 property 的调用方在任何分支上都拿不到静默放行。
  if (arguments.length < 3) {
    throw new Error('assertLosslessFieldRetype：currentProperty 必传（源字段在库里的 property）；漏传会把富文本长文本判成非富文本 = fail-open')
  }
  if (currentType === nextType) return
  if (FIELD_RETYPE_EXCLUDED_TYPES.has(currentType) || FIELD_RETYPE_EXCLUDED_TYPES.has(nextType)) return
  if (!isLosslessFieldRetype(currentType, nextType, currentProperty)) {
    throw new FieldRetypeNotLosslessError(currentType, nextType)
  }
}
