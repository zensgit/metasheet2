# 通用对接 S1b(keystone)设计锁定 — 2026-06-18

> 状态:**DESIGN-LOCK 草案(待 owner 评审)**。不授权任何 runtime;首笔真实外部写仍是独立 owner gate。
> 上游:`generic-integration-design-lock-20260618.md`(总设计锁,S1a→S5 切片序);S1a 合同层已落地(能力面 #2872 + values-free 加固 #2882)。
> 目的:把总设计锁 §6 的 **S1b**(让自有 `metasheet:multitable` target 走 C6 `dry-run→apply` 安全生命周期,证明"安全写能脱离 `data-source:sql-write-gated` 泛化",零外部写)从"一刀"细化为**可评审的设计 + 可机械执行的实现计划**。
>
> **更新(2026-06-19)**:§2-§4 的"高度问题"已由 owner 裁定为 **A(双接口)**,并在实现后进一步 **退役了 `targetWriteLifecycle` lookup/apply method surface**(orphaned;S1a-retire PR)。最终形态:planner 经 **target write profile + 注入式 raw write-source**(非 adapter 级 lookup/apply)驱动安全写;values-free 证据由 planner 自身 evidence 产出,**不**再有"adapter 级 evidence 投影"这一层。下方 §3-A/§4 中 `targetWriteLifecycle`/"evidence 投影"措辞以此为准。已落地:S1b-1 seam(#2887)+ S1b-2 multitable raw 写源 + profile(#2892);S1b-3(route/wire smoke)在 retire 后进行。

## 0. 为什么 S1b 需要先设计锁(不是直接实现)

总设计锁把 S1b 写成一刀 keystone。盘点 C6 planner(`external-write-dry-run.cjs`,914 行,**全系统风险最高的写路径**)后发现:它与 `data-source:sql-write-gated` 焊死在**三处**,且与 S1a 合同存在一个**高度(altitude)层级的冲突**,必须由 owner 先裁决,才能动这段安全代码。**本刀的核心交付就是把这个高度问题摆明、给出推荐解、并把实现拆成可逐刀 opt-in 的计划。**

## 1. C6 planner 的三处焊死点(盘点结论)

`plugins/plugin-integration-core/lib/external-write-dry-run.cjs`:

1. **kind 硬门**:`normalizeTargetConfig(system)`(~L199)在 `system.kind !== 'data-source:sql-write-gated'` 时抛 `C6_WRITE_TARGET_REQUIRED`。
2. **写原语来自 host facade**:`computeExternalWritePlan`(~L516)所有写原语走注入的 `input.dataSourceWrites`(`test/lookupByKey/insertRows/updateRows`,~L296 `requireDataSourceWritesApi`),**不来自 adapter**。
3. **能力态是 SQL 专属**:`assertSafeTargetCapabilityState`(~L327)要求 `{readOnly:false, c6WriteTarget:true, genericQueryDisabled:true}`——这是 SQL 写目标的形态。

好消息:`dataSourceWrites` 已是**注入依赖**(planner 不自己 new 它),所以"换写原语来源"在结构上是可行的 seam,不需要重写 planner 主体。

## 2. 核心:一个高度问题(altitude question)

> **`targetWriteLifecycle.lookup/apply`(S1a 合同)到底是 planner 的*内部数据通路*,还是坐落在另一套*原始内向接口*之上的*证据投影*?**

这不是三个独立选项,而是一个高度问题——A/B 都从它推出。它**同时决定 S1a 刚合并的 values-free 加固是否落在对的方法上**:

- S1a 总设计锁的措辞是"把 C6 planner 硬编码的 `dataSourceWrites.lookupByKey/insertRows/updateRows` **抽象成合同方法**"——读起来像要 `lookup/apply` **替换**内部原语。
- 但 planner 的判定逻辑 `classifyExisting`(~L376)靠**原始既有行的字段值比较**决定 add/update/skip:`writableFields.every(f => valuesEqual(target[f], existing[f]))`,1 行且全等=`skip`,否则=`update`,0 行=`add`,>1 行=`held`。
- 而 S1a 加固后 `createLookupResult` 刻意 **values-free**:只带 `keyHash`/`exists`/`revisionHash`,**不带任何字段值**。

**结论:values-free 的 `lookup` 结果无法喂给 value-diff 的 `classifyExisting`。** 所以"capability 即内部通路"与"加固后的 values-free 合同"**直接矛盾**。本设计锁必须显式裁掉这个 conflation——这是它的核心职责。

## 3. 三个解 + 推荐(owner 裁决项)

| 解 | 高度定位 | 对 planner | 对 S1a 加固 | 风险 |
|---|---|---|---|---|
| **A(推荐)双接口拆分** | `lookup/apply` = **证据投影**;另有一套**原始内向写原语接口**(沿用 `dataSourceWrites` 形态)供 planner | 主体/判定/安全逻辑**不动**;只把写原语**来源**做成可插拔(adapter-backed 取代 host-facade-backed) | **保持正确**——values-free 正是证据形态 | 低 |
| B 修判定为 revision 制 | `lookup`(values-free)即内部通路,用 `revisionHash` diff 取代字段值 diff 决定 update/skip | 改 `classifyExisting` 语义 | 正确,但语义变了 | 中(幂等语义变更,需独立验证) |
| C 另起 capability 生命周期 | 自成一套,绕开 SQL planner | 不动 planner,但复制 token/fence/per-row/dead-letter | 正确 | 中-大(**违反总锁 §4"复用不重造"**) |

**推荐 A——双接口拆分**:planner 已验证的判定 + 安全逻辑原样保留,只让写原语**来源**可插拔(adapter 提供原始内向 `lookupByKey/insertRows/updateRows`,而非 host `data-source:sql-write-gated` facade);S1a 的 `targetWriteLifecycle.lookup/apply`(values-free)定位为 **evidence 投影**,run/issue evidence 用它,planner 内部判定用原始内向接口。这样 **S1a 加固保持正确**(它就是 evidence 形态),且最贴合"复用不重造"。

> **裁决请求**:请 owner 对**高度问题**签字(`lookup/apply` = evidence 投影,A 双接口),而不仅是选 A 这个字母。签字后,下方 S1b-1/2/3 即可机械执行。

## 4. S1a 加固的归位说明(本锁顺带锁死)

`targetWriteLifecycle.lookup/apply`(#2872 形态 + #2882 values-free)= **evidence 投影**,**不是** planner 内部数据通路。planner 内部继续用原始内向写原语接口(A)。故 #2882 把 result builder 做成 values-free(opaque keyHash/revisionHash、drop free-text error、metadata number\|boolean\|null、errorCode code-only)是**正确且就位**的——它服务于 evidence,不服务于 value-diff 判定。

## 5. 实现计划(每刀:独立 opt-in + 独立 PR + 子智能体审阅;contracts/seam-first)

> 前置:本设计锁经 owner 签字(§3 高度问题 + A)。S1a 已在 main。

- **S1b-1(planner seam,最关键)**:把 `computeExternalWritePlan` / apply 的写原语**来源**从"硬绑 host `dataSourceWrites` facade + kind===sql-write-gated"泛化为**可插拔原始内向写源**。
  - `normalizeTargetConfig` 的 kind 门:从"只接受 `data-source:sql-write-gated`"放宽为"接受 sql-write-gated **或** 一个声明了原始内向写能力的 target";SQL 路径**形态/行为零变更**。
  - `assertSafeTargetCapabilityState`:抽象成"目标自报安全写态"的断言,SQL 目标仍返回原 `{readOnly,c6WriteTarget,genericQueryDisabled}`。
  - 触点文件:`lib/external-write-dry-run.cjs`(seam)、可能新增 `lib/target-write-source.cjs`(把"原始内向写源"normalize 成 planner 期望形态)。
  - **不变式**:既有 `data-source:sql-write-gated` 全部测试**原样绿**(零行为漂移),`external-write-dry-run.test.cjs` 不改判定;新增"capability 写源"路径用一个 **fake/in-memory 写源**单测覆盖 add/update/skip/held + token/fence/per-row/dead-letter,证明安全生命周期脱离 sql-write-gated 仍成立。
  - 风险:中(动安全代码,但**加法式**——新增可插拔来源,不重写判定)。
- **S1b-2(multitable 写源)**:让自有 `metasheet:multitable` target 提供 §3-A 的**原始内向写源**(对自有 sheet/record 的 lookup-by-key + insert + update),并实现 `targetWriteLifecycle.lookup/apply`(values-free)作为 evidence 投影。
  - 触点:`lib/adapters/metasheet-multitable-target-adapter.cjs`(现仅 5-method;新增写源 + 能力面)、其单测。
  - **不变式**:写仅落自有 sheet(零外部系统写);凭据/边界不变。
- **S1b-3(sandbox pipeline + route + smoke)**:配一条 sandbox pipeline(source→multitable target),走 C6 `dry-run→apply` 走通用写源路径;wire-vs-fixture 集成测试断言真实 route body/response 的 per-row 结果与 evidence values-free。
  - 触点:routes(`POST .../external-write/dry-run|apply` 已存在,确认其 kind/能力门同步放宽)、`http-routes*.test.cjs`、pipeline 装配。
  - **零外部写**:multitable 写自有 sheet;首笔**外部**写仍是总锁 §6 的独立 owner gate(本刀不碰)。

## 6. 红线 / 不变式(继承总锁 §5,逐字保留)

- 凭据仍只经 credential store;UI 只引用 system / dataSourceId,**不复制凭据**。
- **首笔真实外部写 = 独立 owner 授权**;sandbox-first 序列不变。S1b 全程**零外部写**(multitable 写自有 sheet)。
- 两阶段 dry-run → apply;per-row 隔离,**不 batch-abort**;**无自动重试打爆**;dead-letter 收口。
- **K3 Submit/Audit/BOM 红线不开**(S1b 不碰 K3;K3 是 S2)。
- issue / evidence 上 **values-free**。
- **SQL `data-source:sql-write-gated` 路径在 S1b-1 后行为零漂移**(既有测试原样绿是硬验收)。

## 7. 验收(S1b 各刀必过)

- S1b-1:既有 sql-write-gated 测试全绿(零漂移)+ fake 写源新路径覆盖 add/update/skip/held/token/fence/per-row/dead-letter。
- S1b-2:multitable 写源单测 + `targetWriteLifecycle` evidence values-free(逐 vector canary,沿用 S1a §6.1 验收 #3)。
- S1b-3:sandbox dry-run→apply→re-pull 幂等的 wire-vs-fixture 集成测试,断言真实 route body/response;evidence values-free;零外部写。

## 8. 切片不做什么(防 scope 漂移)

- 不改 `REQUIRED_ADAPTER_METHODS`(总锁 §6.1 逐字锁)。
- 不动 K3(S2)、不动 template 对象(S3)、不动 adapter 自描述元数据(S4)、不吸收 PLM stock-prep(S5)。
- 不开首笔生产外部写(owner gate)。
