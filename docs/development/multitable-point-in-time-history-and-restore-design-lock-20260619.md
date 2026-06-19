# 多维表 时点历史与版本恢复(point-in-time history & restore)— 设计锁 / 开发计划

> **状态**:**PROPOSED(gated plan)。** 每个 Phase 是独立 owner-gated 一刀:design-lock → opt-in → impl。未经逐 Phase 显式 go,不写 runtime。
> **口径**:本文写 MetaSheet 自有能力目标与设计;**不引用任何竞品、不使用竞品功能名**。驱动本计划的外部成熟产品对照在内部 research audit(不在此复述)。
> **基线**:代码实测 @ `origin/main`(`meta_record_revisions`、`record-history-service.ts`、record-level restore route、2b rule-deny、field-mask)。

## 0. 一页结论

把现有**记录级**历史/恢复升级为**表级时点历史 + 版本恢复**:可按**时间 / 操作人 / 来源 / 数据**筛选整表的全部变更、查看任意时点的状态、并把表(或选定子集)**恢复到指定时点**。
**定位 = 深度优先,不拼规模(depth, not scale)。** 我们不试图在超大表行数上正面对标(我们无 200 万行级引擎,grid-virtualization 仍 reopen-only);我们赢在**语义与可信度**:权限随时间生效(permission-through-time)、富来源溯源(provenance)、可选择性恢复、可非破坏性预览、可 API 取用。规模上限诚实声明(§7)。

## 1. 现状(verified — 已具备的底座)

- `meta_record_revisions`(migration `…create_meta_record_revisions`)**每次变更存**:`snapshot jsonb`(整条记录快照)、`actor_id`、`source`(`rest`/`multitable`/`admin`/`automation`/`restore`/`global-rbac`…)、`changed_field_ids[]`、`created_at`,且有 `(actor_id, created_at DESC)` 索引。**= append-only + 快照化 + 归因 + 时间索引的变更日志** —— 正是时点历史最贵、最难补的底座,已经有了。
- 记录级历史 `GET …/records/:id/history` + 记录级版本恢复 `POST …/records/:id/restore`(逐字段可选、写门控、原子、schema-drift fail-closed、forward-change)+ 回收站 undelete,均已落地。
- 历史已**字段级脱敏**(field-mask),回收站已接 **2b 行级 rule-deny**。

**缺口(本计划要补)**:(a) **表级**聚合/查询(跨记录、按时间/人/来源/数据筛选);(b) **整表时点重建 + 版本恢复**;(c) **schema/配置变更捕获**(现完全不记 —— action 仅 create/update/delete of 记录数据);(d) 时点**预览/diff**;(e) **保留/老化**策略(现无);(f) API 暴露。

## 2. 数据模型(LOCK)

**双变更日志 = 表的完整事件流:**
1. **记录数据变更** = 复用现有 `meta_record_revisions`(快照 + actor + source + changed_fields + time)。**不改其写入语义**。
2. **schema/配置变更(NEW)** = `meta_schema_revisions`:`sheet_id, change_type(field_add|field_rename|field_retype|field_delete|view_*|sheet_config_*), target_id, before jsonb, after jsonb, actor_id, source, created_at`。同样 append-only + 归因。

**时点重建**:
- 记录 R 在时点 T 的状态 = `meta_record_revisions` 中 `record_id=R ∧ created_at<=T` 的**最近一条**的 `snapshot`(已快照化 → O(1) 取,无需 replay patch)。
- 表在 T 的状态 = 对每条记录取其 ≤T 最近快照 + 应用 T 时的 schema(来自 `meta_schema_revisions`)。

## 3. 安全语义(LOCK — ratify 重点;两条都是安全决策,非 UI)

### LOCK-A 权限随时间生效(permission-through-time)= **交集** 不变量
查看/恢复历史时,记录/字段的可见性 = **「现在能读 R」∧「该时点快照的数据本身不被规则拒读」** 的**交集**。理由 / 堵的两个漏:
- **数据漏**(同 2b/trash-deny 已立的口径):对**所展示的快照数据**跑条件读规则求值(`evaluateRecordDenied`),被拒则不显示该时点的值。
- **存在性漏(本计划新点名)**:若 R **现在**被 rule-deny(当前隐藏),则**不得**因为它**过去**未被拒就泄露其历史快照 —— 否则泄露「这条记录存在过、且曾经是 X」。故必须先过「现在能读 R」这一关。
- **权限用「现在」的,不回滚**:时点历史展示**过去的数据**,但一律在**当前**权限模型(field-mask + 2b rule-deny + admin-bypass + flag-off-inert)下裁剪 —— 与版本恢复不回滚权限一致。
- **验收**:adversarial verify(此类正是 #2900 踩过的类)。逐 vector:现在被拒的记录其历史不可见(存在性)、快照中被规则命中的字段值不可见(数据)、admin bypass、flag-off byte-identical。

### LOCK-B 整表恢复的删除语义(**点名最有争议的决策**)
「恢复到 T」对**T 之后新建的记录**只有两条路,二选一必须明写:
- **(默认)Revert to T —— 非破坏**:把 T 后被改的记录**回退**到 T 值、把 T 后被删的记录**undelete**;**T 后新建的记录保留**(在 dry-run 里标注「保留 —— 晚于该时点创建」)。结果 = 「你 T 时的数据 + 此后的新增」,**零数据丢失**,延续我们「恢复=forward-change、绝不破坏」的既有口径。
- **(显式 opt-in)Reset to T —— 精确但破坏**:上面 + **删除 T 后新建的记录** → 表精确等于 T 时态。**强制 dry-run 列出将删/将改/将恢复的每条**、更强二次确认、建议 admin-only。
- **两种都**:dry-run 预览 → 确认 → **单事务原子** → 每条改动写 forward-change revision(恢复本身可再被恢复)→ **只写 actor 有写权限的字段/记录**(逐条权限门,复用记录级 restore 的 Lock B layer-3 pre-check)。
- **Phase 4 自带独立 design-lock**(见 §5)。

## 4. 差异化原则(我们的「超越」轴 —— 自有口径)

1. **权限随时间生效**(LOCK-A)—— 历史/恢复不绕过 field-mask 与 2b 行级 rule-deny。
2. **富来源溯源**:历史每条展示 `source`(自动化 run / 导入批次 / API token / 按钮动作 / 用户),不止「操作人」。已 tag source,Phase 1 增「具体诱因 id」链接(automation run / import)。
3. **可选择性恢复**:整表 to T,**或**按筛选子集 / 指定字段 to T(复用逐字段 restore)。
4. **非破坏性预览 / diff**:只读重建「表在 T」、对比「T1↔T2」,不变更。
5. **可 API 取用**:历史 + 时点重建经 OAPI 暴露(Phase 6)。

## 5. 开发计划(分 Phase,各自 gated)

> **Phase 1 是独立可交付的**(只读、跑在现有 revision 数据上,**无需 Phase 2–6**)—— 最快的价值落地 + 给整条 arc 去险。设计深度前置在 Phase 1 + 数据模型;Phase 4 标「impl 前自带 design-lock」;P5/P6 仅 sketch。

| Phase | 内容 | 独立交付? | 验收 | 风险 |
|---|---|---|---|---|
| **P1 表级历史视图(只读)** | 跨记录聚合现有 `meta_record_revisions` 成**表级**历史流;按 **时间 / 操作人 / 来源 / 变更数据** 筛选;详情视图;**LOCK-A 权限随时间生效**;富来源(差异化②)。新 base 级入口(非记录抽屉内)。 | **是** | real-DB:筛选正确性 · LOCK-A 逐 vector(存在性+数据+admin+flag-off)· 分页/索引;FE builder spec | 低(只读) |
| **P2 schema/配置变更捕获** | 新 `meta_schema_revisions`;把 **field add/rename/retype/delete、view、sheet config** 的变更写入。**关键任务:枚举每一个 config 变更入口 —— 不假设单一 chokepoint**(本会话已踩 RecordService vs RecordWriteService 双写路径,config 入口更分散)。在 P1 历史流中展示结构变更。 | 是(补全历史完整性) | real-DB:每类 config 变更落 log;**入口覆盖审计**(grep 全部 mutation site → 逐一接线,缺一即历史不完整) | 中(完整性靠覆盖) |
| **P3 时点预览 + diff(只读)** | §2 重建:只读「表在 T」(记录+schema)、「diff T1↔T2」。非破坏。 | 是 | real-DB:重建正确(快照取值)· LOCK-A 同样生效 · diff 正确 | 中 |
| **P4 版本恢复(整表 + 选择性)** | **impl 前自带独立 design-lock。** LOCK-B 删除语义(Revert 默认 / Reset 显式)+ dry-run 枚举 + 二次确认 + 单事务原子 + forward-change + 逐条写权限门。 | 是 | real-DB:dry-run 准确 · 原子回滚 · 权限门(只恢复可写)· forward-change 可再恢复 · Reset 删除项精确 · LOCK-A | **高**(批量变更;额外 review + adversarial) |
| **P5 保留/老化 + 规模(sketch)** | 见 §6(三者耦合)。 | 是 | retention 后 PITR 触达边界正确;checkpoint 后重建一致 | 中 |
| **P6 API 暴露(sketch)** | 历史 + 时点重建经 OAPI(read-only,token-scoped,沿用 OAPI-1 门)。 | 是 | API 合同 + 权限门 | 低 |

**推荐顺序**:P1(最快价值、去险)→ P2(完整性)∥ P3(预览)→ **P4 自带 design-lock** →(P5 retention 在 P4 落地前必须有,因为快照会无界增长)→ P6。

## 6. 保留 ↔ 重建 ↔ checkpoint(**LOCK — 一个耦合区,非三件事**)
- 快照化每次变更 → 存储**无界增长** → 必须有**保留/老化**(可配置,org 级;默认值待 owner 定)。
- 但 **purge 旧 revision 会缩短 PITR 可触达的最早时点** —— retention 直接决定「能恢复到多久以前」。
- 故规模优化用 **periodic full-table checkpoint(整表快照检查点)**:有了检查点,才能**purge 检查点之前的逐条 detail** 而仍能重建(从最近检查点 + 其后 revision)。三者必须**同一设计**,否则 retention 会悄悄打断深恢复。本区 = Phase 5,但其 retention 子项是 **Phase 4 的前置**(快照增长不能无界等到最后)。

## 7. 规模上限(诚实声明,非目标)
- 快照-per-revision 模型在**中等规模**(数万行 / 有界 revision 数)良好;超大表上**重建/恢复成本随 revision 数增长**。
- 我们**不**声明超大表行数级正面对标;`checkpoint`(§6)是把上限往上推的设计预留,但本计划**不**承诺竞品级规模。**「超越」走深度/语义/可信,不走规模。**

## 8. 非目标(各自独立 gate)
- 超大表行数/引擎级规模对标(单独重投入);
- **历史权限回滚**(我们刻意用「现在」的权限裁剪过去数据 —— LOCK-A);
- 跨 base 时点恢复;
- 实时协作冲突的时点合并(CRDT 层另议)。

## 9. Gating
每个 Phase 是独立 opt-in。**P2(完整性=安全相关)与 P4(批量破坏性写)拿额外 review + adversarial verify。** 本文是 PROPOSED design-lock,不含 runtime;P1 + §2 数据模型 + §3 LOCK-A/B 是首批 ratify 对象。ratify 后先做 **P1**(独立可交付),其余逐 Phase 再 opt-in。
