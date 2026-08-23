# 备料接管线 · 状态账本(阶段快照,2026-08-22)

> **STATUS: INTERIM SNAPSHOT — 不是 closeout。** 本线仍有未合并 PR、未裁定的 owner 决策和未建的执行面。沿用 K3-WISE 线的纪律(`stock-preparation-integration-line-status-ledger-20260818.md`):**closeout 不能在线仍开放时写出**,本文只记录**今天**每一项的状态、退出条件和推动者;任何一行的状态变化应更新本表,而不是另起一份快照。
>
> **本文与既有账本的关系**:2026-08-18 那份账本跟踪的是 **K3-WISE / SQL Server 集成线**,与本线**正交**——它从头到尾不提 V0–V4、Charter 或通用化。本文只管**接管线**。
>
> values-free:无主机名 / IP / 口令 / 凭据。

---

## 0. 一句话结论

**接管处于路线第 1 步(演示)与第 3 步(迁移)之间:代码侧的使能件已全部建成但一条未合并;真正的关键路径是两件不需要写代码的事——客户只读窗口授权,和一份卡了 32 天的设计锁裁定。**

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

### 已合入 main(11)

| PR | 内容 |
|---|---|
| #5044 | 演示 + AI 协作章程 |
| #5100 | 生产上线门 + 本状态账本 |
| #5102 | 通用化提案 stale 闸门声明更正 |
| #5061 / #5062 / #5066 | 开表请求瘦身 · comments/summary 改 POST 并封顶 · WorkflowDesigner 懒加载 |
| #5068 | 行级溯源面板 |
| #5065 → #5074 → #5079 → #5101 | pack 契约与安装器 → 安装排演 → pack 感知刷新写集 → 安装 ledger + dry-run/install 路由(含 migration 076) |

### 未合入(3)

| PR | 状态 | 说明 |
|---|---|---|
| #5034 | OPEN | P0-S 安全加固。改 `ensureFields` 默认为拒绝,爆炸半径是全仓每个 provisioning 调用方,**建议单独合并、独享一次 CI** |
| #5067 | OPEN / 冲突 | 通用落表适配器所有权写守卫。CI 曾全绿;复核方要求阻止合并,两条理由的修复证据已附在 PR 上,待在最新 main 上重跑复核 |
| #5108 | OPEN | **catalog 接线修复**:宿主从未填充 `stockPreparationCustomerPacks`,导致 #5101 的安装路由在真实服务器上不可达(任何 packId 均被拒)。env 指向文件,两端 fail-closed |

**因此 §0 的"代码侧使能件已建成"需附一句限定:通用 C6 所有权守卫(#5067)与 P0-S 加固(#5034)尚未进入 main,`lib/adapters/` 下无 ownership guard —— "通用 insertRows/updateRows 已闭环保护人工列"在 main 上不成立。**

## 3. owner 决策队列(全部无代码依赖)

| # | 决策 | 影响 | 现状 |
|---|---|---|---|
| O-1 | **裁定 D2 binding 载体设计锁(PR #4520)** | **一次 ratify 解开三条线**(V2 后续刀 + 通用备料的设计与执行两条计划) | OPEN **32 天**,PROPOSED |
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

1. **"没有任何测试断言过 ext_ 值到达"—— 说过头了。** `__tests__/stock-preparation-pack-aware-refresh.test.cjs:377-378` 与 ~:600-604 确实把 ext_ 值推过了真实的 planner 与 apply。准确表述:**没有任何生产代码从任何源产出过 ext_ 值** —— planner→记录 这半段是真的且有测试,**源→planner 这半段不存在**。缺的是展开/导入边界上的一个 mapper,不是 planner 的工作。
2. **未映射的 ext_ PLM 列是惰性失效,不是破坏性。** `pickFields` 只挑 `row[field] !== undefined` 的键(`lib/stock-preparation-conflict-planner.cjs:871-877`),所以那些列会静默陈旧,**不会被写 null**。
3. **给安装器加严格类型校验,今天一条都不会触发** —— 手搭列根本读不到、全判 `missing`。该校验只在存在认领机制之后才 materialize;而彼时它会把"假成功"变成"硬拒绝",因此**类型协调策略必须与之同时定案**。

## 4. 已知缺口与债务

| 项 | 说明 |
|---|---|
| **V3 抽取债** | #5079/#5101 建的 pack registry 是 **V3「最小场景注册」本该拥有的东西**;并往 `stock-preparation-conflict-planner.cjs` 加了领域逻辑——正是 V3 要抽取的模块。按章程("以客户能用为验收,不预先建设通用性")发货,**债记在 #5101 正文**。 |
| **`ext_` 守卫接线缺口** | `assertExtensionFieldIdValid` **只在 repair 路径**(`stock-preparation-target-provisioning.cjs:525`、`mvp-provisioning.cjs:392`),**不在 ensure 路径**。pack 安装器走 ensure 路径写 `ext_` 列,靠自己的归一器自检。任何"ensure 已被平台守卫覆盖"的假设都是错的。 |
| **提案文档 stale** | 通用化提案仍写"V2 runtime 在 Charter ratify 前 NO-GO",而 **Charter 已于 2026-07-21 RATIFIED**。两份文档在 main 上互相矛盾,**会误导每一个先读提案的人**(本线已被误导过一次)。 |
| **大 BOM 路径未接** | 只有小 BOM 的 dry-run/apply 对供给 `installedFieldProperties`(二者必须同步移动,否则 plan revision 失配)。 |
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
