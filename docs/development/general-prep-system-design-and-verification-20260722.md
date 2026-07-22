# 通用备料系统 — 设计及验证 MD（Design & Verification）

**状态:PROPOSED（设计+验证记录;实现物 pre-ratify 已落分支未 arm;每门刀待 owner ratify 后接线）**
**分支:`claude/prep-line-substrate-proof-20260722`。基线 origin/main。**

本 MD 是通用备料线的统摄交付,汇总:①可行性(经独立对抗审阅)②rev-2 门控计划 ③本轮已构建+已验证的
实证 ④每刀 ratify 后的精确接线 hook ⑤门控记账。配套文档:
- `general-prep-system-on-multitable-feasibility-20260721.md`(rev-2,可行性+三层架构)
- `general-prep-system-development-plan-20260721.md`(rev-2,P0-P7+P-T3 门控计划)
- `general-prep-dept-collaboration-config-pack-20260722.md` / `general-prep-production-engineering-gallery-pack-20260722.md`(配置包)
- 审阅报告 `/tmp/prep-plan-review-fable5.md`(Fable5 独立对抗审,2×P1+6×P2 已吸收)

## 1. 一句话结论

**能——通用备料可在多维表+现有 stock-prep 线上实现为受治理 scenario。** 地基已由真库测试实证(非论证)。
本轮把可并行、不需外部门的 slice **构建+验证完毕**(pure 模块+守卫入 CI);需 owner 决策/外部门的刀**设计冻结+精确 hook 记账,不擅自 arm**。

## 2. 已构建 + 已验证(本轮实证)

### 2.1 M1 substrate 证明(真库,4/4 绿)——`stock-prep-substrate-p1a-realdb.test.ts`
在专属迁移库 `metasheet_prep_p1a_test`(271 表)实测:
| 断言 | 结果 |
|---|---|
| 插件 `records.createRecord` 落 `meta_records`(真 multitable 写路径) | ✅ |
| `field_permissions` 绑在该 sheet(部门列权限 substrate) | ✅ |
| durable ON 时同事务 enqueue 落 `meta_automation_outbox`(机制存在) | ✅ |
| **负例★:durable ON 时插件 createRecord 产出零 outbox 事件** | ✅ |
**负例★是最有价值的一条**:运行时坐实审阅 P2-1——自动化事件只在网格路由层发射,refresh/apply/sync/confirm
(9 表的生产主写入方)走插件路径不发事件。「批次刷新→通知部门」**需新 emit seam**,此测试把边界钉死防被抹掉。
已挂 `plugin-tests.yml` realdb 白名单。

### 2.2 Pure 逻辑模块(hermetic,入 CI 链 94→97 段)

| 模块 | 模型 | 冻结语义 | 测试 |
|---|---|---|---|
| **P1b** `stock-preparation-extension-namespace.cjs` | sonnet | 租户 `ext_` 前缀命名空间纪律:前缀必需、不撞冻结模板字段名、FORBIDDEN_CONTENT_KEYS 复用、fail-closed。审阅 P1-2:**新增治理非修守卫**(drift 本已单向) | 11 组/28+ 断言 PASS |
| **P4** `stock-preparation-carry-policy.cjs` | opus | 跨批 human 字段继承。`carryKey`=idempotency_key→NO_CARRY(1→1 已由 UPDATE-保留免费);=component_source_id→ 恰1 `CARRY_VIA_CONFIRM`(K2 签署,绝不静默越 assertNoHumanFields)/ 2+ `MANUAL_CONFIRM` 行 hold。**绝不 latest-createTime 静默覆盖** | 16 组/63 断言 + **变异电池 RED**(1→N 改自动选→红;去 confirm 形状→红) |
| **P3** `stock-preparation-suggestion-operators.cjs` | fable | 需求日期级联(日历日,**无节假日**,建议列)+ 跨项目预填**候选**;二者只发建议 payload 待 K2 确认,绝不直写 human;零历史→无候选(不编造) | 7 组 PASS |

全链复跑 EXIT=0,三新测试打印 OK(真跑非空转),8 新文件零触碰现有文件。

### 2.3 配置包(诚实标注,审阅 P3-3)
`template-library` 只装 sheets/fields/views,**不含权限/自动化导入原语**——故两包是**手工配置 runbook**,不谎称「可导入」:
- **部门协作包**:字段权限 profile(采购只改 procurementReply、仓库只改 warehouseConfirmation,引真 HUMAN_PRESERVED_FIELD_IDS)+ 部门过滤视图 + personal-view + done-state 字段 + 通知配方(**仅人工编辑+日程触发**,refresh 驱动列为未来 seam 刀,引 M1 负例)。
- **生产工程 gallery 包**:工段/工序/工艺 = 普通非冻结租户表(拒 MES),级联自动填 link+lookup+automation,方案复用用 P3 预填算子排序。

## 3. 精确接线 hook(ratify 后机械接线,本轮**不 apply**)

| 刀 | 接入点(file:line) | 编辑 | 为何不现在接 |
|---|---|---|---|
| P1b | `stock-preparation-target-provisioning.cjs:214` 后 | 新增 `assertTenantExtensionFieldIdsValid(template, resolved)`,在 :287/:413 `buildCanonicalTargetBinding` 前调用;可选:`templates.cjs` 顶层导出 `FORBIDDEN_CONTENT_KEYS`(免新模块伸手 `__internals`) | 接进 provisioning 承重路径=arm gated 特性;对 ext_ 命名空间外**惰性**(现无 ext_ 字段) |
| P3 | `stock-preparation-templates.cjs:578` 后 | 加 `field('suggestedDemandDate','Suggested Demand Date','date','plm_system')`;**不**入 REQUIRED_SYSTEM_FIELDS/HUMAN_PRESERVED | **改冻结模板→已 provision 表变 incomplete、ensure 抛**(审阅 P2-2)。**必须先建模板演进 rung**(见 §4) |
| P4 | `stock-preparation-confirm-writes.cjs`(admin-gated K2 先例) | 新增 `applyCarryViaConfirm({permission,target,decision,recordsApi})`:先 assertAdminPermission → `__internals.assertCarryViaConfirmShape(decision)` → 按 sourceIdempotencyKey/idempotencyKey 读源/目标行 → 对 carryFields(⊆HUMAN_PRESERVED)服务代人 UPDATE 盖章。**apply-writer 的 `unsupported_decision` throw 保持不动**(是好 fail-closed) | 独立消费者刀,触碰 confirm-writes + 需真库验证;本身是 P4 的 arm |

## 4. 未构建:门控记账(诚实标明为何不做)

| 刀 | 门 | 状态 |
|---|---|---|
| **模板演进 rung** | stock-prep 设计门 | **P3/P5 共享前置**(审阅 P2-2):`mvp-provisioning.cjs:215` 对 existing+incomplete 表 fail-closed「never repairs in place」,无迁移 rung。加任何 plm_system 列前须先建。**本轮识别为下一刀,未建**(改承重 provisioning) |
| **P0** production-policy 生产激活 | 🔶 owner 配置决策 | 接线**已完成**(#3199,审阅 P1-1 纠正我原「未接线」误判)。剩 = owner 设 `context.config.stockPrepApplyProduction` + 验收。**非代码刀,owner 决策,不替你开** |
| **P-T3** K3-Save ERP 写回解锁 | 🔶 需求门 | 亚光「写回 K3」的**真 go-live 前置**(审阅 P1-1 揭示,原计划遗漏)。T3 external-write 线,大工程。**未建,待具名用例过需求门** |
| **P5** identity-convention profile | 设计门 + D2 依赖 | 载体是 D 线 binding(#4520 未合 PROPOSED)。**出设计,不建载体** |
| **P7** K1 kernel 抽取 | 🔶 owner §4 | **由 D 线第二场景拉动**(非"第二备料客户"),owner 已拍板序 |

## 5. 里程碑现状

| 里程碑 | 刀 | 状态 |
|---|---|---|
| **M1 可行性实证** | P1a | ✅ **完成**(4/4 真库绿+CI 白名单) |
| **M2 可演示试点** | P1b+P2 | 模块+配置包**已构建**;接线 hook 待 ratify;P2 通知限人工/日程 |
| **M3 治理内核补齐** | P3+P4+P5 | P3/P4 模块+变异**已构建**;P3 待模板演进 rung;P5 待 D2 |
| **M4 配置样例** | P6 | gallery 包**已构建** |
| **M5a canonical apply go-live** | P0 | owner 配置决策 |
| **M5b ERP 写回 go-live** | P-T3 | 需求门(真前置) |
| **M6 通用性证明** | P7 | D 线拉动 |

## 6. 验证纪律记录

- **独立对抗审阅**:两份计划先经 Fable5 独立审(refute-first,对 origin/main 逐 file:line),打掉我 2 个基于陈旧注释/记忆的 P1 前提(P0 已接线、drift 单向),6 个 P2 缺口全吸收进 rev-2。**教训**:「对旧基点断言把已落地写成 gap」再次自证,已入台账。
- **实证优先**:地基断言(9 表是真 multitable + 插件不发事件)从「读代码以为」升级为「真库跑出来」——负例是审阅逼加的,否则 P1a 会证明生产写路径不具备的性质(wire-vs-fixture 陷阱)。
- **pre-ratify 不 arm**:所有模块作为新文件落地、守卫入 CI,但**零接进 live 路径**——符合本线「设计锁→ratify→arm」纪律。共享文件 hook 精确记账(§3),ratify 后机械接线。
- **变异承重**:P4(load-bearing 语义)带变异电池,commit 后跑、跑后还原、树干净(本线两次踩「commit 前 mutate」已入台账,本轮守住)。

## 7. 下一步(owner 决策点)

1. **🔶 ratify 通用备料方向**(可行性 rev-2)→ 解锁 §3 全部接线;
2. **🔶 模板演进 rung** 设计门 → 解锁 P3 字段 + P5;
3. **🔶 P0** 生产激活决策(canonical apply)/ **🔶 P-T3** 需求门(ERP 写回,真 go-live);
4. **🔶 P5** 待 D2(#4520);**🔶 P7** 待 D 线第二场景。

**本轮交付边界诚实标明**:可并行、不需门的 slice 全部构建+验证;需门的全部设计冻结+记账。**没有把任何 gated 特性偷偷 arm 进承重路径。**
