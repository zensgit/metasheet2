# 数据库 / 系统对接 — 计划与验证汇总(2026-06-19 刷新)

> 本文是"数据库连接 → 通用对接"业务线的**计划 + 验证**汇总(完成态交付物)。它索引各刀的设计/验证文档,不替代它们。
> production / batch / **首笔真实外部写 = 始终独立显式 owner gate**。

## 0. 一页结论

- **只读数据库接入(C2)+ 增量(C3)+ 配置体验(C4)+ K3 generic MSSQL seam(C5)+ 外部写 sandbox 链路(C6)**:已交付并实体机验收闭合(release evidence #2769 PASS)。
- **通用对接收敛(S1a + S1b sandbox 弧)= 本轮全部落地**:C6 `dry-run→apply` 安全写生命周期**已从 `data-source:sql-write-gated` 泛化**到一个 **target write profile + 注入式 raw write-source 合同**;自有 `metasheet:multitable` target 已经骑上同一生命周期(**sandbox、零外部写**)。S1a 早期的 `targetWriteLifecycle`(lookup/apply)方法面在实现中被证明 orphaned 且有"绕过 C6 gate 直接写"误用风险,**已退役**;S1a 合同**重定义为 profile + raw write-source**。
- **S4(adapter 自描述元数据)= 已落地**(#2903,`7734b8495`):静态 `ADAPTER_METADATA` 退役为各 adapter 自声明 + registry 收集;`/adapters` 输出**全 9 kind 字节级一致**(经验比对,含 3 个测试未断言的 kind)。
- **S3(模版对象)= 设计锁 + S3-1 合同/存储已落地**(#2919:`integration_templates` 表/migration 061 + CRUD,**无实例化**);S3-2(实例化)/ S3-3(参考模板)仍 gated。
- **S2(K3)/ S5(PLM stock-prep 吸收)/ 首笔生产外部写**:后续 gated opt-in,各带自己的 gate(见 §5)。**S2 因实体机 gate + K3 红线**不在本轮自动构建;**S5 按计划短期不重写**。

## 1. 状态阶梯

| 阶段 | 内容 | 状态 | 锚点(SHA = squash 合并) |
|---|---|---|---|
| C2 | 只读 SQL 源链路 smoke | ✅ done | #2600 |
| C3 | 增量 / watermark runtime | ✅ done | #2609/#2619/#2625/#2628/#2631 |
| C4 | UI / 配置体验 | ✅ done | #2643/#2646/#2649/#2652/#2655 |
| C5 | K3 generic MSSQL seam(红线不开) | ✅ done | #2670;#2700 |
| C6 | 外部写 sandbox 链路 | ✅ done | #2720;#2761;#2820 |
| Release | 总包 + 实体机验收(scoped) | ✅ done | #2769(package `79ab455e`) |
| **S1a** 合同 | 通用可选写能力(合同层) | ✅ done | #2868 设计锁;#2872 能力;#2882 values-free 加固(`687271dd6`) |
| **S1a-retire** | 退役 orphaned `targetWriteLifecycle`,S1a 重定义为 profile + raw write-source | ✅ done | #2894(`14ffaf10b`) |
| **S1b-1** | C6 planner 写原语来源可插拔(profile seam,SQL 零漂移) | ✅ done | #2887(`060d72635`) |
| **S1b-2** | `metasheet:multitable` raw write-source + profile(rides C6,自有 sheet) | ✅ done | #2892(`e5dc7cf9f`) |
| **S1b-3** | C6 route 接入 multitable target(server-side 解析,sandbox 零外部写)+ wire-vs-fixture smoke | ✅ done | #2898(`5e65a4add`) |
| S2 | K3 WebAPI target opt-in 同一安全写(sandbox) | 🔒 gated(opt-in + **实体机** + K3 红线保留) | 总锁 §6 |
| S3 | first-class `integration_templates` 对象 | 🟡 design-locked + **S3-1 合同/存储已落地**(无实例化);S3-2/S3-3 gated | #2919(`6b94125ef`)+ `…s3-template-object-design-lock-20260619.md` |
| **S4** | adapter 自描述元数据(退役 `ADAPTER_METADATA` 静态字面量) | ✅ done(`/adapters` 输出全 9 kind 字节级一致) | #2903(`7734b8495`) |
| S5 | 统一 field-mapping + PLM stock-prep 吸收 | 🔒 gated(**低优先,短期不重写**) | 总锁 §3/§6 |
| 首笔生产外部写 | sandbox-first 序列后单独一刀 | 🔒 **owner 授权** | 总锁 §5/§6 |

## 2. 本轮交付:通用对接收敛(S1a 重定义 + S1b sandbox 弧)

**最终架构**:C6 的 `dry-run → revision-fence → token-apply → per-row → dead-letter` 安全写生命周期不再焊死在 `data-source:sql-write-gated`。它由两件解耦的东西驱动:**(a) target write profile**(`kind` + capability `normalize`/`assert`,**per-kind 安全策略**,server-side 装配,绝不来自 request),**(b) 注入式 raw write-source**(`test/lookupByKey/insertRows/updateRows`)。planner 已验证的判定(value-diff classify)+ 安全原语**原样不动**,自产 values-free evidence。

逐刀:

- **S1a values-free 加固(#2882)**:result builder 的 error/revision/metadata 自由串收口(revision→opaque `revisionHash` 保相等性用于 fence;drop free-text error→落 dead-letter;metadata→number\|boolean\|null;errorCode→CODE charset 纵深防御)。逐 vector canary + **经验回退证明非空洞** + 独立复审 APPROVE + `REQUIRED_ADAPTER_METHODS` 未变。
- **S1a-retire(#2894)**:S1b 实现证明 `targetWriteLifecycle`(lookup/apply)零 runtime 消费者(seam 用 profile + raw source,planner 自产 evidence),且 adapter 上留 `apply()` = 绕过 C6 gate 直接写的误用风险。退役该方法面(含其专用 values-free helpers + crypto),`REQUIRED_ADAPTER_METHODS` 未变;文档把 S1a 重定义为 profile + raw write-source 合同。复审 APPROVE(无 over-deletion / 无 missed consumer)。
- **S1b-1 planner seam(#2887)**:`normalizeTargetConfig` kind 门 + capability-state 断言抽象为 profile;写原语来源 = 注入 `dataSourceWrites`(已可插拔)。**SQL 路径零漂移(既有套件原样绿 + revision hash 字节级一致,经验证)**;新增 capability 路径用 fake profile + fake 写源覆盖 add/update/skip/held/token/fence/per-row/dead-letter。复审 APPROVE。
- **S1b-2 multitable 写源 + profile(#2892)**:`createMetaSheetMultitableWriteSource`(自有 sheet,logical↔physical 字段映射)+ `MULTITABLE_WRITE_PROFILE`(**真安全属性**:own-sheet scoped、external-write=false,fail-closed)。**零外部写**。复审 REQUEST-CHANGES→修(P2:`lookupByKey` 取 `limit:2` 让重复键命中 planner 的 ambiguous→held,而非静默改一条)→**经验回退证非空洞**→re-review APPROVE。
- **S1b-3 route + smoke(#2898)**:C6 dry-run/apply route 由 `resolveC6WritePlanInputs` **server-side 按 target kind** 解析 write-source + profile + 派生 flat targetConfig(`writableFields` = 已映射非键字段,保 re-pull 幂等);dry-run 与 apply **同一解析**(故 apply recompute 复现 dry-run revision,fence 成立)。wire-vs-fixture 集成 smoke 跑**真实 route**:dry-run→apply→re-pull 幂等、只写自有 sheet、evidence values-free、read-only 403。**经验回退证非空洞**(关掉 multitable 分支即 fail)。复审 APPROVE(server-side-only / dry-run-apply parity / own-sheet / SQL 零漂移 全确认)。

## 3. 红线 / 不变式(继承,逐字保留)

- 凭据只经 credential store;UI / request 只引用 system / dataSourceId,**不复制凭据**;**write profile 绝不来自 request**(它是 per-kind 安全策略,server-side 装配)。
- **首笔真实外部写 = 独立 owner 授权**;sandbox-first 序列不变。S1b 全程**零外部写**(multitable 写自有 sheet)。
- 两阶段 dry-run→apply;per-row 隔离,不 batch-abort;无自动重试打爆;dead-letter 收口;revision fence 硬围栏。
- **K3 Submit/Audit/BOM 红线不开**(S1b 不碰 K3;K3 = S2,另门)。
- issue / evidence **values-free**。
- **SQL `data-source:sql-write-gated` 路径在整条 S1b 后行为零漂移**(既有套件原样绿 = 硬验收,已多刀确认)。

## 4. 验证汇总

| 维度 | 证据 |
|---|---|
| C2-C6 + Release | TODO 账本 `…delivery-todo-20260614.md` 全勾 + #2769 scoped release evidence PASS |
| S1a 加固 #2882 | 逐 vector canary + 经验回退非空洞 + 独立复审 APPROVE + suite 绿 + REQUIRED 未变 |
| S1a-retire #2894 | grep 零 runtime 消费者 + 无 over-deletion + adapter-contracts/S1b-1/S1b-2 绿 + REQUIRED 未变 + 复审 APPROVE |
| S1b-1 #2887 | SQL revision hash 字节级一致(经验) + 既有 C6 套件原样绿 + fake-profile 新路径覆盖 + 复审 APPROVE |
| S1b-2 #2892 | 非身份 fieldIdMap 往返 + re-pull 幂等 + 重复键→held(limit:2,经验非空洞) + own-sheet + values-free + 复审 APPROVE |
| S1b-3 #2898 | 真实 route dry-run→apply→re-pull 幂等 + own-sheet + values-free + read-only 403 + dry-run/apply parity + SQL 零漂移 + 经验非空洞 + 复审 APPROVE |

## 5. 剩余 gated 项(各带 gate,均非本轮自动构建)

| 项 | gate | 备注 |
|---|---|---|
| **S2(K3 WebAPI opt-in)** | opt-in + **实体机 smoke**(operator 执行,无法在此完成)+ **K3 Submit/Audit/BOM 红线保留** | 全系统最受控红线面;需 eyes-open 单独 opt-in;不自动构建 |
| **S3-2 / S3-3(template 实例化 + 参考模板)** | opt-in | 设计锁 §3 已 owner 裁定(单事务原子性 / snapshot 无 re-sync / 参考模板 opt-in / 模板只引用不重定义 C6 安全)。**S3-1 合同/存储已落地**(#2919:`integration_templates` 表 + **migration 061** + CRUD,无实例化)。S3-2 = 实例化(template→pipeline+mappings+system.config,单事务);S3-3 = 参考模板(multitable 先行;K3 模板 runtime 写等 S2) |
| **S5(PLM stock-prep 吸收)** | opt-in | 计划:**低优先、短期不重写**专用链路;泛化到通用 table-action seam 是后续 |

> S4(自描述元数据)已落地(#2903),从本"剩余 gated"表移除——见 §1 阶梯。
| **首笔生产外部写** | **owner 授权** | 多样本只读 dry-run→sandbox apply→re-pull 幂等+人工字段保留→生产 |

---

_校验脚注(2026-06-19):S1b 全弧合并态已核实——#2882/#2894/#2887/#2892/#2898 均 MERGED;`origin/main` 上 `external-write-dry-run.cjs` 含 profile seam、`metasheet-multitable-target-adapter.cjs` 含 write-source + profile、`http-routes.cjs` 含 `resolveC6WritePlanInputs`、`contracts.cjs` 已无 `targetWriteLifecycle`、`REQUIRED_ADAPTER_METHODS` 未变。_
