# 通用备料系统 — 设计及验证 MD（Design & Verification）

**状态:PROPOSED（设计+验证记录;实现物 pre-ratify 已落分支未 arm;每门刀待 owner ratify 后接线）**
**分支:`claude/prep-p1a-substrate-proof-20260722`。基线 origin/main。**

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
| **模板演进 rung(W2)** | stock-prep 设计门 | **✅ 已建(unarmed)**:additive-only `ensureMissingObjectFields`(DO NOTHING)+ MVP/canonical governed repair(admin/只修缺集/plm_system·ext_ 限定/human reject 承重)+ DB-backed 字段发现;真库 scoped repair 端到端证 + 变异(DO NOTHING→UPDATE / human-reject 各红)。plugin.ts/plugin-scope.ts 已接线(assertObjectScope),type-check 绿。ensure 的 fail-closed throw 不动;repair 未接路由。见 §6 审阅吸收 |
| **P0** production-policy 生产激活 | 🔶 owner 配置决策 | 接线**已完成**(#3199,审阅 P1-1 纠正我原「未接线」误判)。剩 = owner 设 `context.config.stockPrepApplyProduction` + 验收。**非代码刀,owner 决策,不替你开** |
| **P-T3** K3-Save ERP 写回解锁 | 🔶 需求门 | 参考系统「写回 K3」的**真 go-live 前置**(审阅 P1-1 揭示,原计划遗漏)。T3 external-write 线,大工程。**未建,待具名用例过需求门** |
| **P5** identity-convention profile | 设计门 + D2 依赖 | 载体是 D 线 binding(#4520 未合 PROPOSED)。**出设计,不建载体** |
| **P7** K1 kernel 抽取 | 🔶 owner §4 | **由 D 线第二场景拉动**(非"第二备料客户"),owner 已拍板序 |

## 5. 里程碑现状

| 里程碑 | 刀 | 状态 |
|---|---|---|
| **M1 可行性实证** | P1a | ✅ **完成**(4/4 真库绿+CI 白名单) |
| **M2 可演示试点** | P1b+P2 | 模块+配置包**已构建**;接线 hook 待 ratify;P2 通知限人工/日程 |
| **M3 治理内核补齐** | P3+P4+P5 | P3/P4/W2 模块+变异**已构建**;P3 接线待 W2 路由(rung 已就绪);P5 待 D2 |
| **M4 配置样例** | P6 | gallery 包**已构建** |
| **M5a canonical apply go-live** | P0 | owner 配置决策 |
| **M5b ERP 写回 go-live** | P-T3 | 需求门(真前置) |
| **M6 通用性证明** | P7 | D 线拉动 |

## 5b. 独立审阅吸收(codex,W2 首版 2P1+3P2 全修)

W2 首版推送后经独立审阅(codex,exact head 8e107),抓出 **4 个真缺陷 + MD 陈旧**——**全部确认属实并修复**:
- **P1(接线未通+type-check 红)**:index.ts 加了 `ensureMissingObjectFields` 但 plugin.ts 类型未声明(TS2353)、plugin-scope 未转发 → 真实插件调用只得 `*_REPAIR_API_UNAVAILABLE`。修:plugin.ts 加两方法类型、plugin-scope 转发**过 `assertObjectScope`**(写能力不裸转发)。type-check 现 0 error。
- **P1(repair 真库发现断链)**:`resolveFieldIds` 只算稳定 id、不查 meta_fields → repair 永远「无缺列」永不写;首版真库测试**直调原语**绕过了这条链(「mock 不是契约」「触发≠验证」)。修:新增 DB-backed `resolveExistingObjectFieldIds`(真查 meta_fields),repair 改用它;新增 scoped-repair 真库测试**走真实 surface** 端到端证(ensure→删列→repair 发现+补回)。
- **P2(canonical 可注入任意字段)**:canonical repair 收 `input.template` → 修:冻结为 registry 主模板,忽略 input.template。
- **P2(P4 依输入序静默选第一)**:同 idempotencyKey 不同 human 内容静默折第一 → 修:同 key 冲突内容 = 真歧义,**hold**(order-independent),新增 reorder 测试。
- **P2(MD 陈旧)**:本节即修。

教训:「真库测试直调原语 = wire-vs-fixture 自欺」再次自证——已入 [[feedback_triggered_is_not_verified]] / [[feedback_mock_is_not_the_contract]]。

**第二轮审阅(codex,head 9ae761;HOLD)——又 1P1+2P2,全修:**
- **P1(repair 假报 ready)**:repair 写后**不复核**、无条件 return ready → 删列探针得 schemaComplete=false 但 reportedReady=true。修:MVP/canonical 写后**重读 + `missingLogicalFields` 复核**,仍缺 → `*_REPAIR_INCOMPLETE` fail-closed(never ready unproven);加 INCOMPLETE 探针测试。
- **P2(scoped 测试仍绕真实 scope)**:facade 手搓、未过 `createPluginScopedMultitableApi`;删 assertObjectScope 仍 10/10 绿。修:scope 单测调两新方法 + 断言 assertObjectScope(**变异删转发→红**);realdb 测试改**走真实 scope wrapper** + 断言 hook 被调。
- **P2(P4 conflictType 越词表)**:`carry_conflicting_source_content` 不在冻结 `CARRY_CONFLICT_TYPES`。修:入词表 + `makeManualConfirm` 校验(越词表 fail-closed)+ 测试钉住。

教训升级:**动核心+跨包接线的刀,推送前必过独立对抗审**——本刀跳过首审,连吃两轮 HOLD。

**第三轮审阅(codex,HOLD)——旧 1P1+2P2 闭合,又 4 个新 P2 + 1 MD,全修(head 9192601):**
- **P2(repair 无既有列前后内容快照)**:上一轮只复核「缺列补回」,未证「既有列 name/type/property 未被动过」——DO NOTHING 只是 SQL 意图,无运行时正控。修:新增 DB-backed `readObjectFieldsContent`(逐既有字段读 name/type/property)+ `assertNoExistingFieldMutated(before,after)`,repair 前后各快照一次,任何漂移 → `REPAIR_MUTATED_EXISTING_FIELD`(MVP+canonical 双路);变异「禁用守卫」→ 红。
- **P2(MVP 完整性复核无承重测试)**:MVP_REPAIR_INCOMPLETE 无红探针 → 可能空转。修:加 INCOMPLETE + MUTATED 探针;变异「stillMissing 直通」→ 红。
- **P2(scope 测试未钉「检查先于 delegate」)**:仅证 hook 被调,未证**写 DB 之前**被调。修:拒绝型 hook + 断言三新方法 delegate 调用数 = 0;变异「先写 DB 后 assertObjectScope」→ 红。
- **P2(P4 闭词表第二层漂移)**:`UNKNOWN_CONFLICT_TYPE` 不在 `CARRY_POLICY_ERROR_REASONS`;`CARRY_CONFLICT_TYPES` 无 exact-vocab 测试(偷加第 4 值仍绿);错误 details 回显传入的未知 conflictType。修:入错误词表 + `deepEqual` exact-vocab 测试(变异偷加第 4 值→红)+ `makeManualConfirm` details 改 coarse(不 echo 值)。
- **MD**:execution-plan 承诺 evidence 带 `addedFields`(字段清单),实现只发 `addedFieldCount` → 统一为 count(values-free);快照机制描述从 compute-only `resolveFieldIds` 改为 DB-backed `readObjectFieldsContent`。

**第三轮验证边界**:四修全部本地 mutation-verified load-bearing(内容快照/MVP stillMissing/scope reorder/exact-vocab 各红),type-check 0 error、CJS 链 103/103、scope 单测 11/11、4 realdb 15/15;已 commit+push(9192601)。

**第四轮:独立对抗审(本机 3-lens workflow,worktree 隔离,refute-first)——1 P3 + 2 NIT,全修:**
- **P3(coarse-details 修复无承重测试)**:上一轮把 `makeManualConfirm` details 改 coarse(不 echo 传入 conflictType),但无测试钉住 → 变异「改回 `{ conflictType }`」仍绿,可静默回退。修:加 `manualConfirmOutOfVocabIsCoarse` 测试(越词表 → `details` deepEqual `{}` + 断言 smuggled 值不出现在 message/details);变异回显 → 红。
- **NIT(CARRY_POLICY_ERROR_REASONS 仅 .includes-pin,无运行时消费者)**:删任一 reason(如 UNSUPPORTED_DECISION)仍绿,「闭词表」只是文档。修:(a)`fail()` 运行时校验 reason ∈ 冻结表(13/13 调用点已核对全在表内,越表 → 内部错;冻结表现有真运行时消费者、fail-closed),(b)加 `deepEqual` exact-pin 测试;变异删 reason → 红。
- **NIT(既有列快照只覆盖 name/type/property,漏 mutable `order` 列)**:契约称「既有列一列不动」但快照少一列 → 若未来 write-primitive 改为 renumber,order 漂移可静默过关(当前 wired 写是 append-only DO NOTHING,latent 非 live)。修:`readObjectFieldsContent` SELECT + 比较加 `"order"`(`updated_at` 故意排除=housekeeping 时间戳);探针 order-change → THROW、identical → 不抛;realdb scoped-repair 仍 1/1 绿(DO NOTHING 下 order 不变、不误报)。

**第四轮验证边界**:三修全部 mutation-verified load-bearing;合并电池(F1 target+mvp/F2/F3/F4a exact-vocab/F4b reasons-drift/F4c coarse-echo/Fix-C order)全红或 throw;type-check 0 error、CJS 链 103/103、scope 单测 11/11、realdb scoped-repair 1/1。**note**:workflow 的 test-load-bearing lens 因子代理登录基建错(`Not logged in`)未返回,但其覆盖已由 guard-correctness lens(两 CJS 套件 node --test 全过 + 直探 assertNoExistingFieldMutated)+ 我本机对 F1/F2/F3/F4 的逐一变异证实补齐。

**第五轮:owner 侧 codex 复审(HOLD,0 P1/3 P2/2 P3)——两个"判别输入原样复现"的 P2 + 两个 P3 全修;P2-3 记为 W3-entry 门:**
- **P2(MVP repair 与 fresh 不同构)**:fresh 走 `buildMvpTargetDescriptor` 注入 `property.stockPreparationMvp`,repair 却从裸 `buildSheetStructureFromMvpTableTemplate` 取描述符 → `repairedHasFrozenMvpMetadata=false`、`sameProperty=false`。修:repair 改用 `buildMvpTargetDescriptor(template).fields`;加 fresh-vs-repair 全 `property` deep-equal 判别测试;变异「退回裸 builder」→ 红。
- **P2(并发 skipped-field 未证即 ready)**:缺列在两次读之间被他者抢插,`stillMissing.length===0` 只证 id 存在、不证抢插行符合冻结描述符 → `missingFieldWasContentVerified=false` 却 `ready=true`。修:只交本轮缺集,`skippedExistingFieldIds` 任意非空 ⇒ 抛 `REPAIR_CONCURRENT_FIELD_APPEARED`(MVP+canonical 两路);变异「删 fail-close」两路各红。
- **P2→W3-entry 门(内容守卫非原子)**:before/write/after 分处独立事务,mutation 变红只证「发现」非「状态未变」;当前 DO NOTHING 本身安全。**修正口径**:守卫注释与 execution-plan §3.3-4 明标为 post-write **检测 canary**、非原子;§3.3a 记为 W3-entry 门(host 侧 `runObjectFieldsRepairTransaction`:scope+读+写+复核+回滚同一事务,realdb 证既有行回滚)。**为何 W2 期不建**:repair unarmed/未接路由;原语形状受 W3 接线牵引,提前反应式建有搭错形状之险(见 [[feedback_adversarial_review_before_pushing_core_cross_package]])。
- **P3(coarse-details 未来保护层回显 reason)**:`fail()` 未声明 reason 的内部错误把 `${reason}` 写进 message。修:改固定 coarse token,不回显拒绝值。
- **P3(order 无落库回归 + 两 CJS fake 只返回 name/type/property)**:手工变异不能替代 CI 钉。修:两 fake 补 `order`;MVP/canonical 各加 order-only 变更 → `REPAIR_MUTATED_EXISTING_FIELD` 的落库判别测试。

**第五轮验证边界**:四修(2 P2 + 2 P3)全 mutation-verified load-bearing——MVP g/h/i(退裸 builder/删 race/剥 order 比较)各红、canonical b4(删 race)红;type-check 0 error、CJS 链 103/103、scope 单测 11/11、realdb 15/15。**P2-3 未在本轮建**(按 reviewer「在 W3 接路由前应提供」框定 + 自认「当前 DO NOTHING 本身安全」),而是记为 W3-entry 门 + 修正过度声称。**至此两个"判别输入"闭合、P3 收尾;是否需在宣布 W2 clean 前先建 §3.3a 原子原语(而非留作 W3 首任务),留 owner 裁。**

## 6. 验证纪律记录

- **独立对抗审阅**:两份计划先经 Fable5 独立审(refute-first,对 origin/main 逐 file:line),打掉我 2 个基于陈旧注释/记忆的 P1 前提(P0 已接线、drift 单向),6 个 P2 缺口全吸收进 rev-2。**教训**:「对旧基点断言把已落地写成 gap」再次自证,已入台账。
- **实证优先**:地基断言(9 表是真 multitable + 插件不发事件)从「读代码以为」升级为「真库跑出来」——负例是审阅逼加的,否则 P1a 会证明生产写路径不具备的性质(wire-vs-fixture 陷阱)。
- **pre-ratify 不 arm**:所有模块作为新文件落地、守卫入 CI,但**零接进 live 路径**——符合本线「设计锁→ratify→arm」纪律。共享文件 hook 精确记账(§3),ratify 后机械接线。
- **变异承重**:P4(load-bearing 语义)带变异电池,commit 后跑、跑后还原、树干净(本线两次踩「commit 前 mutate」已入台账,本轮守住)。

## 7. 下一步(owner 决策点)

1. **🔶 ratify 通用备料方向**(可行性 rev-2)→ 解锁 §3 全部接线;
2. **模板演进 rung(W2)已建** → 解锁 P3 字段接线 + P5;
3. **🔶 P0** 生产激活决策(canonical apply)/ **🔶 P-T3** 需求门(ERP 写回,真 go-live);
4. **🔶 P5** 待 D2(#4520);**🔶 P7** 待 D 线第二场景。

**本轮交付边界诚实标明**:可并行、不需门的 slice 全部构建+验证;需门的全部设计冻结+记账。**没有把任何 gated 特性偷偷 arm 进承重路径。**
