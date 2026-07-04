# 数据源 & 系统集成能力对标 — 钉钉 / 飞书 / 宜搭 — 内部研究 — 2026-07-03

> 内部 benchmark 研究(研究层,非 committed design)。评估 MetaSheet 的「数据库及系统连接」能力相对钉钉集成中心 / 飞书多维表格+开放平台 / 宜搭数据源的定位,并给改进 roadmap。竞品特性描述标注置信度;不作为承诺。

## 0. 结论(定位)

**能对标,但要选对轴。** 在「**受治理的、安全的企业级集成**」轴上,MetaSheet 对标三家**不落下风、局部领先**;在「**连接器广度 / 低代码易用性**」轴上,它们作为生态平台**结构性领先**,我们短期不该硬追。

**护城河 = 集成的安全与治理,不是连接器广度。** 应打我们赢的轴:可安全、可审计、可回滚地接入并写回关键业务系统——这恰是低代码平台在受监管/企业级 under-serve 的缝。

## 1. 我们实际有什么(repo-grounded)

`plugins/plugin-integration-core/`:

| 维度 | 落地 | 成熟度 |
| --- | --- | --- |
| 连接器/适配器 | K3 WISE(WebAPI + SQLServer channel/executor)、PLM/Yuantus wrapper、通用 SQL(只读源 `data-source-sql-readonly` + `write-gated` 目标)、HTTP、metasheet staging 源、metasheet multitable 目标、bridge readonly | ERP 深、SaaS 广度缺 |
| READ 自助化 | 顾问配置→校验→审批→运行层(S0–S3,#1709);`isSafeRelativeReadPath` SSRF 守卫;values-free 证据;resolver_lookup(R0–R3);dry-run probe | **strong** |
| WRITE | C6 `external-write-dry-run`(dry-run→apply,sandbox-first);write-gated 目标(latent);K3 upsert(pipeline 级) | 通用写**仅 W0 方向锁**;partial |
| 数据工厂/管道 | `pipelines`/`pipeline-runner`、transform、sync、field-option-sync、integration-templates | partial→strong |
| 可观测 | DF-N 运行监控、`provenance-contracts`(JSONB)、`dead-letter` + replay、`run-log`(借鉴 NiFi) | strong(企业级) |
| 跨库 | C2 cross-base 写穿(default-off,三锁 + no-oracle + Decision-F) | strong(待启用) |
| 治理 | 两层模型、配额、审计、`credential-store`(加密)、审批门、content-keyed 幂等 | **strong(护城河)** |

## 2. 三条轴上的实况

### ① 连接器广度 — 它们赢(生态结构性优势,置信度 high)
- **钉钉**:集成中心 + 连接器市场(iPaaS,数百预建连接器);**宜搭**:成熟数据源管理(数据源→数据集,连外部 DB/API/已有系统);**飞书**:开放平台 API + 自动化 + 企业级集成平台。
- **我们**:ERP 深 + 通用 SQL/HTTP,无连接器目录/市场,无 OAuth SaaS 连接器。

### ② 集成的安全与治理 — 我们领先(置信度 high on ours)
低代码平台为广度+易用优化;我们为安全+治理优化,独有且更严:
- SSRF 皇冠守卫(拒全部 %-编码/遍历/scheme/协议相对)
- 两层模型(顾问配置→平台校验→运行层只供键,永不带原始端点/结构)
- values-free 证据 + no-oracle(masked ≡ missing ≡ denied 字节一致)
- 写路径 sandbox-first 阶梯(dry-run→sandbox apply→re-pull 幂等→逐次 owner 生产门)
- content-keyed 幂等 + 凭证加密存储(backend-reference-only)+ 审计 + 配额

低代码平台把这些当「能写就行」,我们当「能安全写才行」。

### ③ 可观测 / 数据工厂 — 至少持平、偏领先
provenance / 运行监控 / dead-letter / replay / cross-base 写穿——企业级可观测低代码工具做得浅。

## 3. 我们落后的地方(改进项,按杠杆排)

| # | 差距 | 现状 | 对标缺口 |
| --- | --- | --- | --- |
| 1 | **写自助化未成熟** | 通用外部写仅 W0 方向锁;写真库只 pipeline 级 | 宜搭能写外部 DB;我们的 sandbox-first 是**建好后的差异化**,但先得建 W1→W4 |
| 2 | **连接器广度/目录** | ERP + 通用 SQL/HTTP,无市场 | 用既有 `integration-templates`/`reference-integration-templates` 扩成 values-free 连接器模板目录 |
| 3 | **事件驱动入站同步** | 拉取/pipeline 为主 | 缺「外部事件/webhook→multitable」通用入站(automation 有 webhook 触发,需泛化) |
| 4 | **可视化数据准备** | 代码/pipeline transform | 宜搭「数据准备」是可视化清洗流;缺可视化 transform 授权面 |
| 5 | **OAuth/SaaS 连接器** | ERP/SQL 为主 | 触达 SaaS 集成空间 |
| 6 | **增量/CDC 同步** | 有 watermark,无全量 CDC | 变更数据捕获 |

## 4. 改进优先级建议

**把「安全强」的窄切片转成广度而不丢治理:**

1. **完成写阶梯 W1→W4** — 把 W0 方向锁变成已交付的受治理写(闭合读→读写),保住 sandbox-first 差异化。standing refresh 排 #1。**生产写对客户 2026-07-03 显式禁(SaveSubmitAuditK3Write/externalWrite/productionWrite=false),需显式授权 + sandbox-first,不由泛指令解封。**
2. **连接器模板目录** — 扩现有模板机制,接新系统=配置非代码,用现有机制攻广度。
3. **事件驱动入站同步** — 补拉取之外的推送/webhook→multitable。
4. **可视化数据准备** — multitable-as-hub 上的清洗/transform 授权面(宜搭 parity)。
5. **OAuth/SaaS 连接器** — 中长期,触达 SaaS 空间。

## 5. 边界纪律(适用于上述任一改进)

每一项都是单独 gated opt-in,第一刀是设计锁不是 build;写路径走 sandbox-first 阶梯 + 逐次 owner 生产门;values-free / 两层模型 / SSRF 守卫是所有新集成面的既定纪律。相关既有研究:`multitable-feishu-refresh-audit-20260629.md`、`yida-workflow-automation-benchmark-improvement-plan-20260515.md`、`dingtalk-attendance-benchmark-refresh-v3-20260621.md`、`data-factory-hub-direction-20260525.md`、`nifi-provenance-vs-metasheet2-df-n2-benchmark-20260526.md`。

## 6. 一句话

对标成立,定位「企业级受治理集成」而非「连接器市场」。飞书/钉钉/宜搭在广度赢,我们在**可安全、可审计、可回滚地接入并写回关键业务系统**上赢——他们的软肋,我们的护城河。

## 7. 转 customer-facing / design 文档前须做(内部备忘)

本文是**内部研究判断**。若未来转成对外或 committed design 文档:

- **软化口径**:如「低代码平台把这些当『能写就行』」这类内部判断句需改软(陈述我方原则,不贬竞品——遵循「committed docs 陈述 MetaSheet 原则、不体现品牌」的既定纪律)。
- **逐条 citation**:§2 竞品能力目前只标了 confidence 级别、未逐条给来源。对外前须为每条竞品特性加可核 citation(开放平台文档/官方发布),置信度 low 的先复核或删。
- 我方能力侧已 repo-grounded(可验证),保留。
