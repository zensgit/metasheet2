# 通用备料系统 — 开发计划(Development Plan, rev-2)

**状态:PROPOSED（门控执行计划;配套 `general-prep-system-on-multitable-feasibility-20260721.md` rev-2）**
**rev-2:据 Fable5 独立对抗审阅吸收 2×P1 + 6×P2 + P3 组修订;修订点标 ⟲。**

原则:①第二场景拉动抽取(不 big-bang);②治理内核我们建+拥有、定制交配置层、长尾走逃生舱;
③每刀标「复用件 / 门 / 模型 / 量级」;④owner 决策点标 🔶。模型:设计门/对抗审=opus,实现=fable/sonnet,
事务复核=codex。

## 0. 脊柱

**受治理内核 + 配置层 + 逃生舱。** 关键路径到「可行性 demo」= P1a;到「试点可用」= P1→P2→P3→P4→P6;
⟲ **到「真实 ERP 写回 go-live」= 还需 P-T3(K3-Save 生产解锁)——原计划遗漏的真欠账**;P7 由 D 线拉动。

## 1. 依赖图(rev-2:补 D 线 + T3 节点)

```
P1a(substrate 证明+负例·零风险·无门) ──┬─→ P2(部门协作+通知·配置)──→ P6(工艺 gallery·配置)
                                        ├─→ P3(suggestion 算子·stock-prep 门)
🔶 approach ratify ─→ P1b(扩展命名空间·小门·新增非修订)─┤─→ P4(carry-policy·stock-prep 门·硬)
                                        └─→ P5(identity profile·设计门)──依赖──→ D2 binding 落地(#4520,现 PROPOSED)
P0(production-policy 生产激活·配置/运维刀·owner 门) ──→ [canonical 表 apply go-live]
⟲ P-T3(K3-Save ERP 写回生产解锁·真代码·需求门) ──→ [真实 ERP 写回 go-live·参考系统替代的真前置]
P7(K1 kernel 抽取) ── 由 D 线第二场景上线拉动(owner §4 已拍板) ·owner 门
```

P3/P4/P5 三刀 P1 之后可**并行**;P0 与 P-T3 是**两个不同的 go-live 欠账**(前者 canonical apply 配置激活、
后者 ERP 外写代码解锁),都正交于 P1-P6。

## 2. 逐刀计划(门控 TODO)

### ▢ P1a — Substrate 证明 + 负例(先做·零风险·无门)
- **入口门**:无。
- ⟲ **做(审阅扩充)**:真库测试证明**正例**——provision 出的 stock-prep sheet 上自动化触发(网格路径)、
  字段权限绑定、视图/personal-view 作用;并**钉死三条负例现状**:① **插件写路径(persist/apply/refresh)不触发
  自动化事件**(审阅 P2-1,防止把生产写路径不具备的性质当已具备);② 租户经网格改坏冻结表结构 → 事后 fail-closed
  (无前置防护,审阅 P3-4);③ 部门用户能在真实工作区 UI 找到并打开该表(sheet 默认落 `base_legacy`,可达性未证)。
- ⟲ **复用(审阅 P3-1 纠正)**:**不需新建 harness**——既定通道是 `packages/core-backend/tests/integration/*realdb*`
  + `plugin-tests.yml` 白名单(已有 4 个 stock-prep realdb 测试,:664)。P1a = 在该 harness 写测试 + 白名单加行。
- **出口**:正例绿 = 「通用备料在多维表上成立」实证;负例绿 = 边界(refresh 通知需新 seam)被诚实钉死。
- **模型**:sonnet 写测试。**量级**:小-中。

### ▢ P1b — 租户扩展字段命名空间(🔶 approach ratify 后·新增非修订)
- **入口门**:🔶 ratify 总体方向 + 小设计门。
- ⟲ **做(审阅 P1-2 重定范围)**:审阅证实扩展字段今天已 refresh-安全、drift 单向不误判。故本刀**不修订守卫**
  (伪命题),而是**新增**:前缀命名空间纪律 + 防未来模板字段与租户字段撞名 + (可选)新增双向 drift 守卫。
- **复用**:`templates.cjs` normalize;planner `pickFields` 已隔离。
- **出口**:租户加字段有纪律、未来模板演进不撞名。
- **模型**:opus 门 → sonnet。**量级**:中。

### ▢ P0 — production-policy 生产激活(⟲ 配置/运维刀,非代码刀·owner 门)
- ⟲ **审阅 P1-1 重定性**:接线**已完成**(#3199)。剩余 = owner 设 `context.config.stockPrepApplyProduction`
  (server-config-only、default dormant)+ 验收。**不是「最高风险代码刀」,是激活决策 + 验收。**
- **做**:生产激活配置 + 一轮受控验收(canonical 备料表 apply 在 policy 门下按 maxCleanRows 执行)。
- **复用**:`table-actions.cjs:863` `assertStockPrepApplyAllowed`(已在两入口)。
- **出口**:MetaSheet canonical 备料表 apply 生产可用。**注:此刀不解锁 ERP 外写(见 P-T3)。**
- **模型**:opus 审配置 + 验收。**量级**:小(配置+验收)。

### ⟲ ▢ P-T3 — K3-Save ERP 写回生产解锁(新增·真欠账·需求门)
- **入口门**:需求门(具名用例)+ T3 external-write 线设计门。
- **审阅 P1-1 揭示**:参考系统的 K3 写回(物料/BOM/ECN/生产任务 Save)对应我们的 **T3 external-write 线**,现锁在
  dry-run/Save-only。**这才是替代该参考系统「写回 K3」的真 go-live 前置**,原 P0-P7 无一覆盖。
- **做**:K3 Save 生产写路径治理解锁(egress/审计/幂等/values-free 全线),循 send-trigger 审计与 external-write 纪律。
- **出口**:受治理的 K3 写回可用。**量级**:大。**风险最高刀**(真外部写)。

### ▢ P2 — 部门协作 + 通知配置包(配置)
- **入口门**:P1a 正例+负例绿。
- **做**:字段权限 profile + 部门视图 + personal-view + done-state 字段 + 自动化通知配方。
- ⟲ **审阅圈定**:通知配方**只覆盖人工网格编辑触发 + 日程触发**;**refresh-驱动跨部门通知列为后续刀**
  (需插件写入口发事件/outbox seam)。M2 演示**前置含投递 flag 决策**(四 durable-delivery flag OFF、env-gated)。
- ⟲ **「包」诚实化**:template-library 只装 sheet/field/view;权限/自动化**无导入原语**——本刀交付 = 手工配置 + 文档
  (守「无代码」),真「可导入」另需 installer 代码刀。
- **模型**:fable。**量级**:中。

### ▢ P3 — suggestion 算子切片(stock-prep 门)
- **入口门**:P1 绿 + stock-prep 门。
- **做**:日期级联(DATEADD/WORKDAY,**无节假日**,写 plm_system 建议列)+ 跨项目预填候选(plmDrawingNo 映射表);
  **只经 K2 确认进 human**。
- ⟲ **审阅 P2-2 未列前置**:两者写新 plm_system 列,而 `mvp-provisioning.cjs:215` 对 existing+incomplete 表
  fail-closed「never repairs in place」——**必须先补冻结模板演进/迁移 rung**(P3/P5 共享前置,原计划漏预算)。
- **复用**:`engine.ts`、`material_mapping`、confirm-writes K2。
- **模型**:opus 门 → fable。**量级**:中(+ 模板演进 rung)。

### ▢ P4 — carry-policy 扩展冲突规划器(stock-prep 门·**最硬**)
- **入口门**:P1 绿 + stock-prep 门。
- ⟲ **做(审阅 P2-3/P2-4 收窄+定死)**:① **真实增量收窄到 `carryKey=component_source_id` 跨 key 场景**
  ——1→1 同 idempotencyKey 继承今天已由 UPDATE-保留免费成立;② 跨 key carry 带 human 字段进 ADD 撞
  `assertNoHumanFields` 墙,**走 K2 式服务代人签署写**(非「墙不变」);③ **1→N 歧义落点二选一并写明**:
  planner 行级 hold(现成、UX 弱)**或** 扩 `exception_confirmation` 8 项闭词表(新治理代码 + confirm-reads/writes 改)。
  **绝不静默覆盖。**
- **复用**:`conflict-planner.cjs`、`apply-writer.cjs` hold、(若扩队列)`mvp-generation.cjs` 词表。
- **模型**:opus 门 + 对抗审 → fable。**量级**:中大。

### ▢ P5 — identity-convention profile(config 非 code·设计门·⟲ 依赖 D 线)
- **入口门**:P1 绿 + 设计门。可与 P3/P4 并行。⟲ **对 D2 落地有真实依赖**。
- **做**:图号语法 = 版本化+审批的有界 ReDoS-checked 分类规则,**只发 plm_system 注解列,永不发身份**。
- ⟲ **审阅 P2-5 纠正**:载体是 **D 线 binding 模式复制 + 新建载体**,非「直接复用」——main 只有 D1 契约模板
  (被 MR 场景锁死),物理载体 D2(#4520)现 PROPOSED 未合。**P5 排期依赖 D2 落地。**
- **模型**:opus 门 → sonnet。**量级**:中(+ D2 依赖)。

### ▢ P6 — 生产工程 gallery 包(配置)
- **入口门**:P2 模式就绪。
- **做**:工段/工序/工艺 = 非冻结租户表 + link/lookup/automation;最全方案复用 = P3 预填算子排序。
  **30 字段工艺词表属实施方,不进冻结模板**(拒 MES)。⟲ 同 P2「包」诚实化。
- **模型**:fable。**量级**:中。

### ▢ P7 — K1 kernel 抽取(🔶 ⟲ 由 D 线第二场景拉动,非"第二客户")
- ⟲ **审阅 P2-6 对齐**:owner §4 已拍板触发 = **V2 第二场景 = D 线物料主数据对账(charter #4484 已 ratify、
  D1 已落)拉动 K1 抽取**,**与是否有第二个备料客户无关**。原计划「第二真实客户」触发是静默改写,已改回对齐 §4;
  若确要改判触发,须显式请 owner 裁。
- **量级**:大。**之前 stock-prep preset #1 = 参考系统行为逐字节钉死,不预抽象。**

## 3. 明确非目标(仅逃生舱)

MRP/ATP、SMB 图纸、宜搭推送(需求门)、像素复刻、human 字段跨 path 静默继承、自动选复用候选、节假日日期算术。

## 4. Owner 决策点(🔶)

1. **🔶 ratify 本计划方向** → 解锁 P1b 及设计门刀;
2. **🔶 P0 生产激活决策**(canonical apply)+ **🔶 P-T3 需求门**(ERP 写回,真 go-live 前置,两者不同);
3. **🔶 每设计门刀**(P1b/P3/P4/P5)各自 ratify;
4. **🔶 P5** 依赖 D2(#4520)落地;**🔶 P7** 由 D 线第二场景拉动(§4)。

## 5. 建议执行序

- **第 1 步(现在,零风险)**:P1a(正例+负例)。绿了「可行」变 demo,且钉死「refresh 通知需新 seam」边界。
- **第 2 步(ratify 方向后)**:P1b + P2 并行——补扩展纪律 + 纯配置搭部门协作(通知限人工/日程触发)。
- **第 3 步**:P3/P4/P5 按设计门并行(P4 最硬;P5 等 D2);P3/P5 先补模板演进 rung。
- **go-live 双欠账**:P0(canonical apply 配置激活)+ P-T3(ERP 写回代码解锁)——**替代该参考系统 K3 写回靠 P-T3**。
- **P6 收尾;P7 由 D 线拉动。**

## 6. 里程碑(⟲ M5 拆分)

| 里程碑 | = 哪些刀 | 意义 |
|---|---|---|
| **M1 可行性实证** | P1a | 论证→demo + 边界钉死 |
| **M2 可演示试点** | P1b+P2 | 部门协作+人工/日程通知,零后端代码 |
| **M3 治理内核补齐** | P3+P4+P5(+模板演进 rung, +D2) | 日期级联/跨批继承/图号 profile |
| **M4 配置样例完整** | P6 | 工艺建模 gallery 包 |
| **⟲ M5a canonical apply go-live** | P0 | MetaSheet 备料表 apply 生产可用 |
| **⟲ M5b ERP 写回 go-live** | P-T3 | K3 Save 受治理写回——**替代该参考系统的真前置** |
| **M6 通用性证明** | P7(D 线拉动) | 第二场景抽取 K1 |
