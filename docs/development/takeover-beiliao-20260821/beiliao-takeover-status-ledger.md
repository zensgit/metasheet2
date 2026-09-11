# 备料接管线 · 状态账本(阶段快照,2026-08-22)

> **STATUS: INTERIM SNAPSHOT — 不是 closeout。** 本线仍有未合并 PR、未裁定的 owner 决策和未建的执行面。沿用 K3-WISE 线的纪律(`stock-preparation-integration-line-status-ledger-20260818.md`):**closeout 不能在线仍开放时写出**,本文只记录**今天**每一项的状态、退出条件和推动者;任何一行的状态变化应更新本表,而不是另起一份快照。
>
> **本文与既有账本的关系**:2026-08-18 那份账本跟踪的是 **K3-WISE / SQL Server 集成线**,与本线**正交**——它从头到尾不提 V0–V4、Charter 或通用化。本文只管**接管线**。
>
> values-free:无主机名 / IP / 口令 / 凭据。

---

## 0. 一句话结论

**接管处于路线第 1 步(演示)与第 3 步(迁移)之间。真正的关键路径是两件不需要写代码的事——客户只读窗口 / 一次性导出授权(登记册 R-07),和 `/erp/*` 端点封闭与历史访问排查(R-08(i))。**

> **2026-08-23 更正:原文两句均已失效。** (1)"代码侧的使能件已全部建成"——不成立,源→`ext_` 的 mapper 已合入却**未接线**,见 §4;(2)"一份卡了 32 天的设计锁裁定"——该锁已由登记册 **R-03 裁为维持挂起**,**已离开关键路径**,见 §3/O-1。

---

## 1. 接管路线的五步(章程定义)与今日位置

| # | 步骤 | 状态 | 说明 |
|---|---|---|---|
| 1 | 演示(合成数据) | ⚠️ **形式完成,实质有缺口** | 产出是**自包含静态 HTML 模型,不是 MetaSheet 在跑流程**。文档描述的 6 条流程(公式列算需求日期、钉钉待办、23 列 Excel 导入导出)是"将如何复现"的散文,**无一指向代码**。可用于讲解,不可用于"给我点一下试试"。 |
| 2 | 只读窗口授权 | ◐ **部分,且不可复用** | PLM/K3 侧验收**已完成一次**(delivery-plan §0.1 全 PASS,#4628 CLOSED),但 §0.3 明确该授权**不可复用**:每次重跑需重新冻结包 + 新的一次性操作号 + owner 重新授权。**备料 MySQL 库的读授权尚未取得。** |
| 3 | 历史迁移与双轨对账 | ☐ **计划完整,零可执行面** | `mysql-migration-plan.md` 有 24 表清单、三级导入序、7 行对账表与容差、切换判据。**但没有迁移脚本、没有对账运行器、插件里没有 MySQL 源适配器。** |
| 4 | 按项目号切换上线 | ☐ **判据已写,四条均未实现** | 连续 N 日零差异 / 列权限已建立 / 选项映射命中率 100% / provenance 完整。 |
| 5 | 后续需求(CRM/派工/项目) | 🅿️ 章程封存 | 只在客户真实提出时从需求抽取,不预先建设。 |

---

## 2. PR 状态(2026-08-22 更新)

> **本节曾在写下几小时后就自我推翻** —— 原文写着"接管的全部产出目前都不在 main 上",而同日下午 11 条即已合入。一份自称活文档的东西必须先守自己讲的更新纪律,故此处如实记录该失效并改为按状态分组。

### 已合入 main(19,2026-08-23 复核)

| PR | 内容 |
|---|---|
| #5044 | 演示 + AI 协作章程 |
| #5100 | 生产上线门 + 本状态账本 |
| #5102 | 通用化提案 stale 闸门声明更正 |
| #5061 / #5062 / #5066 | 开表请求瘦身 · comments/summary 改 POST 并封顶 · WorkflowDesigner 懒加载 |
| #5068 | 行级溯源面板 |
| #5065 → #5074 → #5079 → #5101 | pack 契约与安装器 → 安装排演 → pack 感知刷新写集 → 安装 ledger + dry-run/install 路由(含 migration 076) |
| #5108 | catalog 接线:宿主填充 `stockPreparationCustomerPacks`(env 指向**文件**,两端 fail-closed);#5101 的安装路由由此才在真实服务器上可达 |
| #5110 / #5111 / #5115 / #5119 | 账本 freshness pass · 单项目竖切 · 首载写入器 ADR · **决策登记册**(编号真源) |
| #5118 | 源→`ext_` 字段 mapper + 权威 `ext_` id 更正 —— **注意:mapper 未接线,见 §4** |
| #5120 | 从已提交 fixture 清除客户字典 + 复发守卫 |
| #5034 | P0-S 安全加固(BPMN 运行时 fail-closed 闸门 + plugin-scope / `ensureFields` reconcile 守卫);**`ensureFields` 默认已翻为 `refuse`** |

### 未合入(2,2026-08-23)

| PR | 状态 | 说明 |
|---|---|---|
| #5067 | OPEN / MERGEABLE / CLEAN | 通用落表适配器所有权写守卫。已在当前 main 上重基、无冲突。登记册 **R-12 已裁"合"** —— main 上适配器零所有权意识且无条件注册,**绕墙是活的**,不合并不是中立选项 |
| #5117 | OPEN / MERGEABLE / CLEAN | 合成 SQL BOM 源 fixture + 计划覆盖守卫(不需要真库) |

**因此"代码侧使能件已建成"需附一句限定:P0-S 加固(#5034)已于 2026-08-23 合入,但通用 C6 所有权守卫(#5067)**仍未进 main**,`lib/adapters/` 下无 ownership guard —— "通用 insertRows/updateRows 已闭环保护人工列"在 main 上**仍不成立**。**

## 3. owner 决策队列(全部无代码依赖)

> **编号真源已迁至同目录 `decision-register.md`(#5119)。** 本表保留为原出处索引;任何裁定**以登记册为准**,本表同步标注。

| # | 决策 | 影响 | 现状 |
|---|---|---|---|
| O-1 | D2 binding 载体设计锁(PR #4520) | ~~一次 ratify 解开三条线~~ —— **该说法已被登记册 R-03 推翻**:"G2 承载迁移的图号↔K3 登记表"不成立(登记表是 K3 API 一次性物化的专用 registry,G2 是图号**语法** profile 且排在 G0 之后),且 #4520 自述 ratify 即开实现刀、违双线上限 | **PARKED**(R-03:不 ratify,维持挂起)—— **已离开关键路径** |
| O-2 | 客户只读窗口授权(备料 MySQL 库) | 迁移与对账的前置 | 未取得 |
| O-3 | 凭据轮换 + `/erp/*` 端点封闭 | 客户现系统已知暴露,**默认视为已泄露** | 未执行 |
| O-4 | `stock-prep:read/operate/admin` 权限词表与迁移 | V4 前置;现状权限过宽(需 `integration:write`) | 仍开放 |
| O-5 | 通用备料线 **G0 ratify** 是否已批 | 该线写着"G0 ratify 前零 arm",**main 上无批准记录** | 无记录 |
| O-6 | 物料字典载体(203 项 > 200 上限) | `ext_materialCode` **在任何 pack 版本都不可能是 select**;推荐字典表 + link,需往冻结类型词表加 `link` → **改冻结模板,独立评审** | 未决 |

---

## 3b. 接管形态已定案:(b) 新建 + 迁移(2026-08-22)

**(a) 认领客户手搭表 —— 已确认不可行,不是"未实现"而是"违反公理"。**
MetaSheet provisioning 用确定性 id(`stableMetaId` = 前缀 + `sha1(parts.join(':'))` 前 24 位,`packages/core-backend/src/multitable/provisioning.ts:130-136`),表与字段 id 均由 `(projectId, objectId[, fieldId])` 推导。客户实例上那张 47 列备料表是 **UUID 形 id 的手搭表**,不是 provisioned 对象,因此 `readObjectFieldsContent` 按逻辑 id 查询时**永远匹配不到**;全仓也**没有任何按名称/标签匹配的机制**。

实际后果**不是**"同一张表里出现重复列":安装器根本看不见那张表。只有两种结局 —— canonical 表不存在则 409 `CUSTOMER_PACK_TARGET_ABSENT` 直接拒绝;canonical 表存在则 21 个 ext_ 列建在**另一张表**上,形成**平行两张表**。

**选 (b) 的理由**(独立复核认可):切换判据量的是"与遗留 MySQL 零差异",那张手搭表在任何方案下都不在上线证据链里;它几乎肯定是遗留数据的手工镜像(22 行且全为合成/脱敏样例),迁移天然取代它;ADOPT 最难的部分——把 10 个已有数据的 all-string 活列转成 number/date/select——**是一次数据迁移藏在元数据安装器里**,位置错误;而**缺失的 MySQL 只读窗口在两种形态下都卡住上线**,用 ADOPT 绕开授权等于放弃切换判据。

手搭表的处置:切换时按项目冻结为只读,不认领。

## 3c. 三处经复核纠正的认知(2026-08-22)

1. **"没有任何测试断言过 ext_ 值到达"—— 说过头了。** `__tests__/stock-preparation-pack-aware-refresh.test.cjs:377-378` 与 ~:600-604 确实把 ext_ 值推过了真实的 planner 与 apply。准确表述:**没有任何生产代码从任何源产出过 ext_ 值** —— planner→记录 这半段是真的且有测试,**源→planner 这半段不存在**。缺的是展开/导入边界上的一个 mapper,不是 planner 的工作。**#5118 已经把这个 mapper 建出来了,但没有接线**(见 §4),所以本条结论到今天为止一字未变。
2. **未映射的 ext_ PLM 列是惰性失效,不是破坏性。** `pickFields` 只挑 `row[field] !== undefined` 的键(`lib/stock-preparation-conflict-planner.cjs:871-877`),所以那些列会静默陈旧,**不会被写 null**。
3. **给安装器加严格类型校验,今天一条都不会触发** —— 手搭列根本读不到、全判 `missing`。该校验只在存在认领机制之后才 materialize;而彼时它会把"假成功"变成"硬拒绝",因此**类型协调策略必须与之同时定案**。

## 4. 已知缺口与债务

| 项 | 说明 |
|---|---|
| **V3 抽取债** | #5079/#5101 建的 pack registry 是 **V3「最小场景注册」本该拥有的东西**;并往 `stock-preparation-conflict-planner.cjs` 加了领域逻辑——正是 V3 要抽取的模块。按章程("以客户能用为验收,不预先建设通用性")发货,**债记在 #5101 正文**。 |
| ~~**`ext_` 守卫接线缺口**~~ **已闭合(2026-09-10 复核)** | 本条原文断言 `assertExtensionFieldIdValid` 只在 repair 路径、不在 ensure 路径,任何"ensure 已被平台守卫覆盖"的假设都是错的——**这条假设本身已经过期**:本条创建于 #5100(`21a24b45a0`,2026-08-22 16:22:08),写于 #5118 落地前约 11 小时;#5118(`30761c7e7`,2026-08-23 03:02:17)把 ensure/绑定面的守卫接上后,本条没有跟着回改(教训:**引用型条目要随其依赖的提交回扫**,不是"写晚了没跟着改"——本条恰恰写在依赖的提交*之前*,回扫窗口是提交落地之后)。逐路径复核(2026-09-10,worktree `a22955f83` 上核对):① repair 路径——`stock-preparation-target-provisioning.cjs:707` 的 `assertRepairableFieldOwnership` 在 `:723` 调 `assertExtensionFieldIdValid`;② `stock-preparation-mvp-provisioning.cjs:453` 同样直接调 `assertExtensionFieldIdValid`;③ pack 安装路径——`stock-preparation-customer-pack.cjs:312` 的归一器对每个字段调同一个 `assertExtensionFieldIdValid`;④ ensure/绑定路径——守卫存在,且被**preflight 实际喂到值**:`stock-preparation-preflight.cjs:264`(canonical 分支)与 `:272`(sandbox 分支)在调用 inspect 时把 `extensionFieldIds: target.extensionFieldIds`(值来自 pack 声明)传入,经 `stock-preparation-target-provisioning.cjs:410` 的 `inspectStockPreparationTarget`(`:419` 调用)里的 `normalizeExtensionFieldIds`(同文件 `:300-320`)对每个字段调 `assertExtensionFieldIdValid`。但**`POST /api/integration/stock-preparation/sandbox-target/ensure` 这条 HTTP 路由本身不传 `extensionFieldIds`**——`lib/http-routes.cjs` 对 `extensionFieldIds` 这个键零引用(路由处理器在 :6730 调 `ensureStockPreparationSandboxTarget` 时只带 `projectId`/`baseId`/`objectId`/`label`/`permission`),守卫在**这条路由**上是空跑。之所以仍不构成写口:ensure 的 CREATE 分支按冻结模板建表、建不出 `ext_` 列(`target-provisioning.cjs:573-578` 注释原话"cannot create a pack's `ext_` columns"),没有值可写,是结构性(冻结模板)覆盖,不是运行时守卫兜底。四处 `ext_` 写口/绑定口因此**均被守卫或冻结模板覆盖**,没有第五个未接线的口子——但"覆盖"要分两种记账:preflight 一条是守卫真被喂上了值在挡;HTTP ensure 路由一条是守卫接线存在却空跑,靠冻结模板兜底,两者论据不能混为一谈(同类教训见下方"提案文档 stale"那一行:更正推翻一条陈述时要回头改它的每一处副本,包括本条自己新引入的时间线陈述)。若 `adr-first-load-writer-human-owned-columns.md` 引用过"ensure 未被守卫覆盖"这条,同步按此更正。 |
| **`ext_` mapper 未接线** | #5118 合入了源→`ext_` 的 mapper(`lib/stock-preparation-ext-field-mapping.cjs`)与 `computeDryRun` 的 `extFieldMapping` 形参,但**两处路由包装器都不传它**,`lib/http-routes.cjs` 对 `extFieldMapping` **零引用**。故 §3c 第 1 条的"没有任何生产代码从任何源产出过 `ext_` 值"**在 main 上仍然成立**。 **2026-09-10 订正**:此断言已过期——`lib/http-routes.cjs` 现有 4 处路由把 `extFieldMapping: stockPreparationExtFieldMapping` 传进 dry-run / confirmation-decisions / apply / 大 BOM 计划(`:5825` / `:5974` / `:6182` / `:6537`,基线 `a22955f83`),mapper 已可达;**其中第 4 处经 2026-09-11 复核实为 `stockPreparationPreflight` 只读诊断路由(基线 `5f4b32122` 的 `:6571`),不是大 BOM 计划——大 BOM 家族对 `extFieldMapping` 至今零引用**(`stock-preparation-large-bom-jobs.cjs` 全文无此标识符)。同日另行接上的是大 BOM 两条路由的 `installedFieldProperties`(计划 + 分片 apply 快照),见下方"大 BOM 路径未接"条;因此大 BOM 上未接的只剩 mapper 本身。这是一周内**第二起"建好但不可达"**(前一起:#5101 的安装路由要等 #5108 填 catalog 才可达)。 |
| ~~**提案文档 stale**~~ **已修** | 通用化提案曾写"V2 runtime 在 Charter ratify 前 NO-GO"(Charter 实际已于 2026-07-21 RATIFIED),**#5102 已就地更正**;但那份更正**自己**又留下"一次 owner ratify 可解开三条线"一句,已由 R-03 推翻并于本次一并更正。教训:**更正块本身也会 stale**,推翻一条陈述时必须回头改它的每一处副本。 |
| ~~**大 BOM 路径未接**~~ **已闭合(2026-09-11)** | 原文:只有小 BOM 的 dry-run/apply 对供给 `installedFieldProperties`(二者必须同步移动,否则 plan revision 失配)。现状:大 BOM 计划路由 `tableActionLargeBomExpansionJobPlan` 按**存储作业的 actionSnapshot** 解析并传入(与小 BOM 同一个 `resolveInstalledFieldProperties`),大 BOM 分片 apply 则在**审批时刻**(`tableActionLargeBomApplyJobStart`)解析一次并**快照进作业**,分片只读快照、`.../run` 路由零账本读——因为一次 checkpoint apply 横跨多个 HTTP 请求,逐片现场读会让同一份被批准的作业前后片用不同写入带。解析失败/无账本/无 pack ⇒ 省略参数 ⇒ 与接线前逐字节一致。大 BOM 家族**仍不传 `extFieldMapping`**,`largeBomJobResponse` 的 `extFieldMappingConfiguredButNotAppliedOnThisPath` 通告按原样保留。 **已知代价(接带的直接后果,owner 需知情)**:带一接通,存量已有 `ext_` `plm_system` 值的行每轮大 BOM 刷新都被判为 `update`(`changedFields` 比的是格,来料无该键 ≠ 相等),`http-routes.cjs` 的 `largeBomCleanRowCount`(add+update)因此按这些行数抬高,**配置了生产策略的部署可能撞上 `maxCleanRows` 被 403 拒**——在 mapper 接通前是每轮常态而非偶发。方向是安全的:fail-closed、发生在任何写之前,丢的是一次刷新不是行(patch 仍不带 `ext_` 键)。已由 `stock-preparation-large-bom-installed-fields-wiring.test.cjs` 的「the widened band is counted by the production clean-row bound」用例连控制组钉住。根治=把 `changedFields` 收窄到来料真正给了值的格,但那会动小 BOM 共用的 planner,另立一次裁决。 |
| **迁移必须先做身份归一** | 源系统字段字典有 10 处不一致,含 `提前周期`(中文字面量)与 Java 属性 `normalLeadDays` 对不上、`taskCode` vs `productCode` 同物异名——**直接按 identity 映射会在 MetaSheet 里生成两个独立字段**。 |
| **本机 pin 重算不可信** | 若干被 pin 的 migration **blob 本身含 CRLF**,而 `.gitattributes` 声明 `eol=lf`:全新 checkout / CI 归一为 LF 与 pin 一致,长期 checkout 保留原字节 → 整份重算多出约 49 处**假**漂移。**只重算真正改动的行,或在全新 worktree 里算。** |

---

## 5. 生产上线门

见同目录 `beiliao-production-go-live-gate.md`(PR #5100)。11 项门(平台 G-1…G-8 + 接管专属 T-1…T-3),**全部默认未达成**。其中 **G-3(凭据轮换)与 T-1(只读窗口)不依赖任何代码**,是当前真实关键路径。

---

## 6. 收尾判据(满足全部才可写 CLOSEOUT)

1. 全部 12 条 PR 合入 `main`,222 完成一次部署并通过验收对照;
2. O-1…O-6 全部有书面裁定;
3. 迁移执行器 + 对账引擎存在并跑通一次(合成数据即可);
4. 生产上线门 11 项全部 PASS 且有 values-free 证据;
5. 至少一个 `product_code` 完成按项目号切换并稳定运行。

---

*本文由 2026-08-22 的仓库盘点与交付波次触发创建。修改本文属技术负责人(T)层决策,走"默认前进 + 24h 异步否决";§3 全部条目属 owner(O)层,先批后动。*
