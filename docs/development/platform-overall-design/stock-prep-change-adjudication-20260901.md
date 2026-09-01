# 备料变更与冲突裁决——智能化设计(2026-09-01,DRAFT)

> **地位**:候选设计,不进入当前任何门;values-free。上级文档:`docs/development/platform-overall-design/stock-prep-onboarding-acceleration-20260901.md`(P1 工作项⑤「更新/重拉 + 冲突裁决 UX」)——本稿是该条目的详细设计,不重复其 P0①②③、P1④、P2⑦⑧的内容。
> **owner 关切(原文)**:「当PLM中bom更新时,能自动获取该更新」+「BOM修改或批次中有相同物料时可人为判断」。
> **本稿要回答的问题**:今天已经有不可变快照批次、批次间 diff(增/删/数量/单位/版本)、人工列高墙(human_preserved 列刷新后原样保留)、确认决策台账(keep_multiple_rows / accept_current / manual_hold)——这套"重拉+diff+同物料裁决"够不够好用?怎么让它智能化?
> **方法**:结论全部落在对 `plugins/plugin-integration-core/lib/stock-preparation-*.cjs` 现有实现的实读上,每条论断标 `path:line`;分不清"已经有"和"要新建"的地方,以现有代码为准。

---

## 0. 一句话结论:换心智模型,不是换引擎

今天的心智模型是「拉一个批次 → 和上一个批次做 diff → 人工扫一张大 diff 表」——`StockPreparationSnapshotDiffView.vue:148` 的原话就是「上面选一份,这里会显示它和上一份比改了什么」,而 diff 表的每一行不分轻重地摆出 `diffType`/`reviewStatus`/`changeTypes` 三个 token(`:290-307`)。这套底层机器是对的、也是可信的(不可变批次、确定性 diff、人工列高墙、确认台账全部真实存在且经过审计),但**呈现层没有分诊**——今天的阻断策略字面意思是"每一种变化都阻断":

```
// stock-preparation-snapshot-diff.cjs:544-546
// The single held/ready policy source (currently: EVERY change type blocks).
```

本设计不换引擎,换的是人和这台机器打交道的方式:从「人扫一张大表」变成**活 BOM + 人工附着层 + 变更收件箱**。

- **活 BOM**:PLM 的当前事实,随时间变化——不可变快照批次链,已存在,原样复用。
- **人工附着层**:人在备料上做的工作(领料节点/到货/尺寸 + 裁决),粘在具体的物料上(按 componentSourceId / IdentityNo 签名定位,不按行号)——human_preserved 列高墙,已存在,原样复用。
- **变更收件箱**:PLM 变了的时候,人**不看**原始 diff 表——人看到"N 处变化需要你看一眼"的分诊收件箱,每张卡片带**系统提议 + 影响**,一键接受/改判。人始终在一个稳定的"当前 BOM"上工作,变化以一份精简、已分诊的待办小清单推给人。

五层智能化(§4)全部服务这一个转变;每一层都**收窄人工要看的集合**,没有一层移除"写入正式主表前必须人工确认"这道门——门变成"确认系统的提议",不是"从零判断"。

---

## 1. 现有机器:五件已经存在、且互相独立的真实组件

先把清单摆平,后面每一层讲"复用什么、新建什么"时才有据可依。

| 组件 | 文件 | 现状 |
|---|---|---|
| 不可变快照批次 + 批次间 diff | `stock-preparation-snapshot-diff.cjs`(`planBomSnapshotDiff`)、`stock-preparation-snapshot-reads.cjs`(`getSnapshotDiff`/`listSnapshotDiffRows`) | **纯函数、确定性、已接线**。先按 `pathKey` 精确匹配,未匹配的再按 `identityKey`(`childDrawingNo+childVersion` 的小写拼接,`:148-153`)找"挪动了位置但还是同一个件"的行;产出 12 种 `CHANGE_TYPES`(数量/单位/版本/路径/父件/来源指纹/非法数量/缺子 BOM/重复路径键/缺路径键等),`reviewStatus` 只有 ready/held 两档,而**今天 `BLOCKING_CHANGE_TYPES` 等于全部 12 种**(`:33-46`,`:544-546` 的注释原话)。 |
| 冲突计划器 | `stock-preparation-conflict-planner.cjs` | **纯函数、已接线**。产出 `DECISIONS = {ADD, UPDATE, SKIP, INACTIVE, MANUAL_CONFIRM}`(`:18-24`);批次级门槛 `valid: counts[MANUAL_CONFIRM] === 0`(`:1271`)——一批里只要有一行进人工确认,整批不能 apply;结构性人工列高墙 `assertNoHumanFields`(`:987`,ADD/UPDATE/INACTIVE 三个决策构造函数各调用一次,`:1057/:1071/:1094`)——机器**不可能**写 human_preserved 列,这是断言,不是约定。 |
| 重复展开键裁决词表 | `stock-preparation-conflict-planner.cjs`(`DUPLICATE_EXPANDED_KEY_POLICIES`) | 6 个冻结 token:`hold`/`keep_multiple_rows`/`merge_quantity`/`select_representative`/`skip_selected`/`source_correction_required`(`:52-59`)。**只有 `keep_multiple_rows` 是唯一的 RESOLVING 已实现策略**(`:64`,`:783-796` 的推导注释:"a policy counts as implemented iff the planner does something NAMED with it");`merge_quantity`/`select_representative`/`skip_selected` 是**刻意未实现**("Unimplemented BY DECISION, not by ...")。 |
| 确认决策台账 | `stock-preparation-confirmation-decisions.cjs` | **已接线、已审计**。今天只覆盖一个冲突类:`duplicate_expanded_key`(`FIRST_CUT_CONFLICT_TYPE`,`:199`)。三个人工裁决动作 `RESOLUTION_ACTIONS = {KEEP_MULTIPLE_ROWS, ACCEPT_CURRENT, MANUAL_HOLD}`(`:214-218`)一一映射到计划器的策略词表(`READBACK_POLICY_BY_RESOLUTION_ACTION`,`:225-229`);状态 pending/confirmed/superseded(`:209-213`);**指纹绑定的 supersede/reopen**——同一冲突的输入内容变了(A→B),旧决策被 supersede、开一条新的 pending;内容**复原**(A→B→A)时旧决策被复活为 pending 但**清空**人工填的 `resolutionAction`/`notes`/`resolvedValue`(`:74-77`,owner 2026-08-29 裁决 Q5-A 原话:"a revived conflict must be re-confirmed by a human, never silently re-armed with the old answer")——这条设计对"同一冲突原样复发"是保守正确的,但也说明**今天没有跨冲突实例的记忆**,只有单一冲突自身的指纹绑定生命周期;DB 租约保证单活跃对账器(迁移 077,`RECONCILE_LEASE_TABLE`)。 |
| 人工列高墙 | `stock-preparation-templates.cjs` | `STOCK_PREPARATION_FIELD_OWNERSHIPS = ['plm_system', 'human_preserved']`(`:12`);`ownership === 'human_preserved'` 强制 `preserveOnRefresh = true`(`:262-263`);8 个 human_preserved 列冻结在 `HUMAN_PRESERVED_FIELD_IDS`——`materialType`/`blankType`/`stockPreparationStatus`/`demandDate`/`leadTimeDays`/`notes`/`procurementReply`/`warehouseConfirmation`(`:104-113`);`conflictStrategy` 的 `missingFromPlmPolicy` 今天只允许一个值 `mark_inactive`(`:199-201` 校验)。 |

还有两个**已写好但没有被任何调用方使用**的组件,是本设计layer③、④要复用的关键部件:

- **跨批次人工数据 CARRY 策略(未接线)**——`stock-preparation-carry-policy.cjs`。纯函数,输入"上一批次已标 INACTIVE 的行 + 当前批次一条新 ADD 行",按 `componentSourceId` 是否跨 `idempotencyKey` 复现,产出三态决策:`NO_CARRY`(同 key 更新场景、无匹配、或匹配到的历史行没有人工字段可带)、`CARRY_VIA_CONFIRM`(恰好 1 个匹配,提议把人工列带过去,但只能经 K2 风格的服务端签名确认写入,绝不静默 ADD)、`MANUAL_CONFIRM`(1→N 多个匹配,行级挂起,绝不猜)(`:16-46`,`CARRY_DECISIONS` 词表 `:84-86`)。仓库内对这个文件的唯一引用是它自己的测试——`plugins/plugin-integration-core/__tests__/stock-preparation-carry-policy.test.cjs`——生产代码零调用点。**这正是 PLM 把一个件改版/换号(idempotencyKey 变了,但物理上还是同一个 componentSourceId)时该做的判断,已经写好、已经测过,只是没有接进重拉/裁决的实际流程。**
- **物料匹配的"历史确认"记忆(不同域,同形状)**——`stock-preparation-material-match.cjs`。`MATCH_METHODS.HISTORICAL_CONFIRMED`(`:21`)+ `selectHistoricalMapping(line, confirmedMappings)`(`:156`):按 `(drawingNo, version)` 去查一份已确认的历史映射,命中就以 `confidence: 1` 直接复用并带出 `confirmedBy`/`confirmedAt`(`:235-251`,`makeHistoricalRow`);歧义时退化为 `MULTI_CANDIDATE`/`VERSION_CONFLICT`,从不瞎猜。这是"记住人工怎么判的,下次直接用"的**真实生产实现**,只是服务于 ERP 物料映射,不是服务于 BOM 变更裁决——是 §4④ 要照抄的形状,不是要复用的代码。
- **系统提议、人工确认的既有范式**——`stock-preparation-suggestion-operators.cjs`。`computeDemandDateCascade`/`crossProjectPrefillCandidates` 两个纯算子都只产出建议(`applyMode: 'k2_confirm_required'`),目标要么是独立的 `plm_system` 建议列(`suggestedDemandDate`,绝不直接落 human_preserved),要么是排好序的候选列表、且必须经显式 K2 确认才写入(`:9-19`);零历史时返回零候选,**从不捏造**。这是 §4② 要照抄的另一个既有范式。

---

## 2. 现有机器缺什么:三处具体缺口(不是空话)

1. **诊断分诊缺失**:`BLOCKING_CHANGE_TYPES` 今天字面等于全部 12 种 `CHANGE_TYPES`(`stock-preparation-snapshot-diff.cjs:33-46`)——引擎从不区分"这行变化要紧"还是"无关痛痒",人只能面对一张所有行同等对待的表。
2. **同物料裁决从零开始**:`duplicate_expanded_key` 台账的三个动作(`keep_multiple_rows`/`accept_current`/`manual_hold`)没有任何一个是**预选**的——人工确认页面(`StockPreparationExceptionQueueView.vue` 等)今天给出的是一张空白菜单,不是一个"系统认为该这样、你确认或改判"的默认值。
3. **PLM 变更 × 人工作业碰撞检测——两个子情形都有实质缺口**:
   - **删除子情形**(PLM 那边这个件消失了):`makeInactiveDecision`(`stock-preparation-conflict-planner.cjs:1089-1101`)只做了两件事——把 `active` 置为 `false`,断言 patch 里不含人工字段。它**不计算**被冻结的这一行是否已经有人工填过的数据——一个空的计划行消失,和一个仓库已经确认到货的行消失,在今天的机器眼里是同一件事,都只在批次差异视图里安静地多一行 `removed`。
   - **改版/换号子情形**(PLM 把这个件的图号/版本换了,底层还是同一个物理件):判断逻辑其实已经写好——`stock-preparation-carry-policy.cjs`——但零调用点(见 §1)。今天这个子情形的实际行为是:旧行安静地变 `INACTIVE`(人工数据被高墙原样保住,但行本身对人不可见),新行作为一条空白 `ADD` 出现,**没有任何信号告诉人"这两行其实是同一个物理件,你之前填的数据在旧行上躺着"**。
4. **无跨实例记忆**:确认台账的指纹供销语义(§1)对同一冲突的原样复发是保守正确的,但没有一层"这个图号/这类变化,你上次是怎么判的"的**跨实例**签名记忆——`stock-preparation-material-match.cjs` 已经在另一个域证明了这个形状是可行、可审计的,只是没人把它搬到 BOM 变更裁决这边。
5. **无异常拦截**:`CHANGE_TYPES` 有 `QUANTITY_CHANGED`,但没有任何幅度判断——2 件变 200 件和 2 件变 3 件,今天在阻断策略里是同一个 token。
6. **无触发智能**:上级文档 §2.B 证据 5 已核实,全仓库对 `cron`/`schedule`/自动重拉关键词在备料表动作与大 BOM 任务两个模块里零命中——重拉今天 100% 靠人手动点击项目接入面板;DN_PDM 侧的 `SysVer`(已被 `stock-preparation-bom-expansion.cjs:208/214/561/587/613` 与 preset 读取)之外,`Editime`/`Createtime` 这类落库时间戳列在仓库任何 `.cjs`/`.json` 文件里**零出现**——今天没有任何"先探一下有没有变"的廉价探针,重拉永远是全量展开。

---

## 3. 五层智能化(按本设计内优先级排列)

**排序原则**(与上级文档一致):③ 先做——它是今天唯一"空白"的一层,也是客户最痛的一类事故(人工已投入的工作被 PLM 变更悄悄架空却毫无提示);①②④ 其次——它们是"把现有机器的输出重新分诊/预选/记住",toil 收敛最直接;⑤ 与 AI 摘要助手排最后——锦上添花,且⑤需要新建判断口径(尚无幅度/兼容性字典),AI 摘要是纯文案层,两者都不影响任何裁决正确性。

### 3.1 层③ —— PLM 变更 × 人工作业碰撞检测(最高优先级,今天最实的空白)

**目标**:人已经在某个件上做过备料工作(至少一个 human_preserved 列非空)时,PLM 对**同一个物理件**(componentSourceId 相同)做了会让这份工作过时的动作(改版换号 / 删除),系统必须**主动**告诉人"你备过料的这个件,PLM 刚改了/删了,怎么处理?"——而不是让人工数据在高墙后面安静地躺着,靠人自己想起来去翻。

**新建的核心信号**:一个 values-free 的存在性布尔值 `hadHumanWork`——检查即将被置为 `INACTIVE`(删除子情形)或即将被 `carry-policy` 判定为 `CARRY_VIA_CONFIRM`/`MANUAL_CONFIRM`(改版换号子情形)的既有行上,`HUMAN_PRESERVED_FIELD_IDS` 这 8 个列里是否**至少一个非空**——只判"有没有填过",不读值本身,与仓库现有 values-free 纪律(`stock-preparation-carry-policy.cjs:56-61` 的既有承诺)一致。

**两个子情形的具体设计**:

- **改版/换号子情形——复用 `stock-preparation-carry-policy.cjs`,把它接线**:重拉流程在产出 `ADD` 决策前,先对每条候选新行跑一次 `planCarry(prevBatchRows, newAddRow, carryPolicy, options)`(该模块已导出的判定函数,`:399`);`CARRY_VIA_CONFIRM` 与 `MANUAL_CONFIRM` 两种结果,只要命中的历史行 `hadHumanWork === true`,一律进入收件箱的**顶级碰撞卡片**(而不是普通的"新增了一行");人工确认沿用该模块已经设计好的 K2 风格确认写入,机器不新增一条自动写路径。这是"接线 + 加一个存在性判定",不是重写决策逻辑。
- **删除子情形——扩展 `makeInactiveDecision`,不改变它的写入行为**:该函数产出的 `patch` 与 `assertNoHumanFields` 断言原样不变(数据安全基线不受影响);新增的是它旁边一份**只读的 evidence**(`hadHumanWork` 布尔值 + 触发原因 `missing_from_plm`),供收件箱据此把这一类 `INACTIVE` 决策单独挑出来,标为顶级碰撞卡片,而不是混在普通"删除"计数里。
- **两个子情形共享同一个碰撞卡片视觉优先级**:收件箱里,任何 `hadHumanWork === true` 触发的行,排在所有分诊结果(层①②)之前,且**不允许被层①的"无关变化自动带过"规则吸收**——碰撞检测的产出永远走人工看一眼这条路径,即使触发它的字段变化本身(如仅仅是版本号变了)按层①单看会被判为低优先级。

**复用 vs 新建**:

| 内容 | 复用 | 新建 |
|---|---|---|
| 人工数据不被覆盖的安全基线 | `assertNoHumanFields`,原样不变 | — |
| 改版/换号判定逻辑 | `stock-preparation-carry-policy.cjs` 全部判定函数 | 把它接进重拉/裁决流程(今天零调用点) |
| 删除判定逻辑 | `makeInactiveDecision` 的写入行为 | 旁挂 `hadHumanWork` 存在性检查 + evidence |
| 收件箱顶级碰撞卡片 | — | 全新 UI/服务层拼接 |

### 3.2 层① —— 变更影响分诊

**目标**:人只看"要紧且模糊"的行;纯元数据变化不打扰人;影响采购的变化连着人话影响一起给。

**设计**:今天的 `BLOCKING_CHANGE_TYPES` 是全部 12 种 `CHANGE_TYPES` 的扁平集合(`stock-preparation-snapshot-diff.cjs:33-46`)。本设计不改 diff 引擎本身产出的枚举,只在它之上加一层**三级分诊映射**(纯读、纯展示层,不改变 diff/计划器任何写入行为):

| 分诊档 | 覆盖的 `CHANGE_TYPES` | 人看到什么 |
|---|---|---|
| C:对备料无关,自动带过 | 只命中 `SOURCE_FINGERPRINT_CHANGED` 且不伴随其他阻断类型的行(来源整行内容变了,但数量/单位/版本/路径/父件均未变——大概率是名称/描述这类元数据编辑) | 不出现在收件箱;计入批次汇总的"已自动带过"计数 |
| B:影响采购,给出人话影响 | `QUANTITY_CHANGED`、`UNIT_CHANGED`、`VERSION_CHANGED` | 卡片直接给影响句,如"需多备 2 件"/"材料相关的版本变了,建议核实是否需要重新采购"(§5 举例) |
| A:真歧义,人工判断 | `DUPLICATE_PATH_KEY`、`MISSING_PATH_KEY`、`INVALID_QTY`、`MISSING_CHILD_BOM`、`PATH_CHANGED`+`PARENT_CHANGED` 同时出现(挪动了位置又换了父件,系统无法确定是搬家还是换件) | 卡片说明歧义原因(见层②"系统解释 WHY") |

**层③的碰撞卡片不受这张表约束**(见 3.1 末段)——`hadHumanWork` 一旦为真,无论触发它的变化类型属于哪一档,都直接进人工必看的顶层。

**复用 vs 新建**:复用现有 12 个 `CHANGE_TYPES` 与其判定逻辑(diff 引擎一行不改);新建的是这张三级映射(纯读)+ 收件箱按档呈现的 UI/服务层。这一层本质是**给已有枚举分类**,不是新建判定引擎。

### 3.3 层② —— 相同物料:系统先提方案,人只确认

**目标**:人不从零判断,只确认/改判系统的提议。

**三种情形,分别设计**:

1. **同 IdentityNo + 同规格/版本(真正的 `duplicate_expanded_key`)**——今天台账的三个动作里,只有 `keep_multiple_rows` 是已实现的 RESOLVING 策略(`stock-preparation-conflict-planner.cjs:64`,`:783-796`);`merge_quantity`(owner 举例的"合并,数量 12→14"正对应这个词表 token)是**刻意未实现**。本设计在这里给两条并行的路:
   - **短期(不改变今天已实现的策略集)**:签名匹配层只在**已实现的三个动作**(`keep_multiple_rows`/`accept_current`/`manual_hold`)之间做**预选**——例如按 `IDENTITY_FIELD_IDS`(`componentCode`/`componentName`/`material`/`sourceVersion`,`conflict-planner.cjs:40-45`)判断两行是否同图号同版本,预选 `keep_multiple_rows` 并在卡片上说明"两行图号、版本一致,系统建议保留全部,人工核实是否应合并数量"——**卡片文案诚实地说明"合并数量"这个具体动作今天还没有真正的写入路径**,不让操作员误以为点了"合并"就真的合并了。
   - **中期(与上级文档 P1⑤ 是同一件事,交给它落地)**:把 `merge_quantity` 补成真实的 RESOLVING 策略 + 台账新增一个映射到它的 `RESOLUTION_ACTION`——补齐之后,层②的签名匹配直接预选 `merge_quantity`,不再需要"诚实免责声明"这一步。本设计不重复上级文档已经列出的这项工作,只标注:**层②的价值随 `merge_quantity` 是否补齐而增长,不依赖它才能上线**——预选 `keep_multiple_rows`/`manual_hold` 这条路今天就能做。
2. **同物料、不同 IdentityNo("不是冲突")**——diff 引擎按 `pathKey`/`identityKey`(图号+版本)匹配,从不按 `material` 字段匹配(`compareMatchedRows`,`stock-preparation-snapshot-diff.cjs:196-211` 全文没有引用 `material`)。**这个情形今天本来就不会触发 `duplicate_expanded_key`**——两个不同图号的行天然是两条独立的行,各走各的 ADD/UPDATE/SKIP。这一条**不需要新机制**,只需要在收件箱的文案/文档里把这一点讲清楚,避免实施者误以为"同物料"字面意思要系统去做额外判断。
3. **真歧义(系统答不出来)**——`manual_hold` 预选 + **系统给出的"为什么歧义"**,取材于诊断已计算出的字段:两行的 `LINEAGE_FIELD_IDS`(`projectNo`/`componentSourceId`/`parentSourceId`/`path`)或 `IDENTITY_FIELD_IDS` 冲突点(比如 IdentityNo 相同但 `parentSourceId` 不同,说明这两处出现分别挂在不同的上级部件下,系统判断不出该不该视为同一物料的两个用量)——这段解释文案是**纯拼接已有诊断字段**,不需要新的判定逻辑,只需要一个"把决策里已经算出的差异点转成一句话"的展示层(与上级文档 P2⑦「逐行溯源」是同一手法:字段语义早就在,缺的是拼成人话的 UI)。

**复用 vs 新建**:复用 `duplicate_expanded_key` 冲突类、台账三个已实现动作、`LINEAGE_FIELD_IDS`/`IDENTITY_FIELD_IDS` 现有诊断字段;新建的是签名匹配预选层(纯读,输出"建议选哪个已实现动作"而非新决策)+ 歧义原因拼句 UI。`merge_quantity` 真正实现与否留给上级文档 P1⑤,本设计不重复。

### 3.4 层④ —— 决策记忆 / 学习(真正、可审计的智能化)

**目标**:同类情形第二次出现时,系统记得人上次怎么判,预填提议,人工 toil 在重复模式上趋于零;新情形不受影响,仍然要问。

**硬约束(与 owner 意图直接对齐)**:每一条"学到的规则"必须是台账里一条真实、有日期、有操作人、可点开、可撤销的裁决记录——绝不是黑箱模型的输出。这条约束不是本设计发明的,`stock-preparation-material-match.cjs` 的 `HISTORICAL_CONFIRMED` 已经在生产代码里实现过完全一样的形状(`selectHistoricalMapping`,`:156-251`):按签名查已确认记录、命中就复用并带出 `confirmedBy`/`confirmedAt`,歧义退化为多候选/版本冲突,从不瞎猜。

**设计**:确认台账(`stock-preparation-confirmation-decisions.cjs`)已经是一份完整的、可审计的人工裁决历史——每条 `CONFIRMED` 行本身就是一次记录在案的人工判断。今天缺的只是**一层跨实例的读侧索引**:

- **新建**:一个只读的**签名记忆索引**,不是新的事实来源——它按一个比台账自身 `stableDecisionKey`(绑定单个冲突实例的指纹)更粗的**签名**(如 IdentityNo/material + 变化形状,比如"图号相同、版本变了、数量变了")去扫台账里的历史 `CONFIRMED` 行,命中时把那条历史裁决作为**预填提议**呈现在新出现的同类冲突卡片上——人依然要走既有的确认接口(`confirmConfirmationDecision`)完成裁决,只是默认值已经替他填好、并注明"参照 2026-08-15 图号 XXXX 的裁决,操作人:王xx"。
- **不改变**台账现有的指纹级 `supersede`/`reopen` 语义(§1,owner Q5-A 裁决)——那是"同一个冲突自己复发"的保守正确行为,与"另一个新冲突,但和历史某条形状相似"是两件不同的事,层④只处理后者,前者保持原样。
- 命中记忆的行在收件箱里折叠进一个"已按记忆预填"的分区,与仍需人工从零判断的行分开呈现,人可以批量确认或逐条改判——**从不自动落地**,预填之后仍然经过与今天完全相同的确认写入路径。

**复用 vs 新建**:复用台账的整条历史记录(不新建存储)、`HISTORICAL_CONFIRMED` 已验证过的"按签名查历史、命中就复用、歧义就退化"的**形状**;新建的是签名定义(粒度比台账自身指纹更粗)+ 只读索引 + 预填展示层。

### 3.5 层⑤ —— 异常/风险主动拦(最后做)

**目标**:在人确认前,把疑似数据错误标出来——不阻断,只提醒。

**设计(新建,今天没有对应机制)**:

- **数量跳变**:`QUANTITY_CHANGED` 今天只是一个布尔判定(变了/没变,`quantityChanged`,`stock-preparation-snapshot-diff.cjs:124-129`)。新增一个幅度判定(如变化倍数超过一个可配置阈值,例如 5x/10x)——命中时卡片标"疑似数据错误"角标,而不是普通的"影响采购"标签(仍然走层①的 B 档,只是多一个视觉信号,不改变分诊结果或阻断状态)。
- **材料替换不兼容**:标为**远期项**——今天 DN_PDM preset 与仓库任何字典里都没有材料兼容性对照表,做这条判断需要先有这样一份字典(客户特定,不通用),不在本设计的可交付范围内,先如实记录缺口。
- **删除中途**:与层③"删除子情形"是同一件事,不重复设计,层③已覆盖。

### 3.6 AI 摘要助手(锦上添花,不裁决)

**硬立场(不妥协)**:写入正式主表前的合并/采购/裁决动作**绝不能**由黑箱模型决定——采购系统不能让一个说不清道理的模型替人拍板。本设计层①②③④全部是**确定性规则 + 签名匹配 + 决策记忆**(全部可审计、可覆盖),AI 只允许出现在**辅助**位置:总结一处变化、解释它对采购的影响、起草一句建议裁决——例如"AI 摘要:封头材料 S30408→S31603,3 件受影响,建议重新采购"——但落哪个裁决,永远是人 + 已记录的规则说了算,AI 的话只是建议。

**复用**:平台已有的 AI 能力底座——`packages/core-backend/src/services/ai-provider-readiness.ts` 的 `MULTITABLE_AI_*` 环境契约(`AI_ENABLED_ENV`/`AI_PROVIDER_ENV`/`AI_API_KEY_ENV`/`AI_MODEL_ENV` 必填,租户日/周 token 上限、突发 RPM、账号日均 USD 上限均可选声明)与 `packages/core-backend/src/routes/multitable-ai.ts` 的 admin-gated AI Shortcut(`requireAdminRole`)+ 用量台账(`ai-usage-ledger.ts`)——本设计的"AI 摘要"直接挂在这套已审计的底座下,不新开一条 AI 调用通道。输入范围参照 `source-onboarding-self-service-design-20260830.md` §5 已经验证过的 values-free 口径("输入仅表结构 + 字典标签……失败/不可用回退人工……可关")——本设计的 AI 摘要输入仅诊断字段(变化类型、字段名、量级,不含未脱敏的业务原文任意拼接),默认可关(`MULTITABLE_AI_ENABLED` 为假时,卡片没有 AI 摘要行,系统提议仍然完整可用),on-prem 无外呼场景不受影响。

---

## 4. 触发智能:让重拉本身变聪明

**目标**:重拉前先廉价探一下"这个项目有没有变",只对真变了的项目做全量展开;定时/自动重拉不再是打扰;只有分诊后判定"有意义"的变化才通知人,绝不是"重拉完了,啥也没变"这种噪音。

**现状核实**:`SysVer` 已经是仓库里被实际读取的字段——`stock-preparation-bom-expansion.cjs:208/214/561/587/613` 与 `dn-pdm-family.preset.json:62/75/266` 都在用它做版本比对。但 owner 提到的 `Editime`/`Createtime` 这类落库时间戳列,在仓库全部 `.cjs`/`.json` 文件里**零出现**——这是本设计新提出的读取面,不是把已有代码接线。

**设计(新建)**:

1. 在 `dn-pdm-family.preset.json` 这类供应商 preset 里新增一个**可选**角色描述(如 `changeProbe: { versionColumn: 'SysVer', timestampColumns: ['Editime', 'Createtime'] }`),而不是把这两个列名硬编码进读取计划——理由与上级文档 P0②「拓扑自测」完全一致:不同客户的 DN_PDM 部署对这类列是否存在、叫什么名字会漂移,必须按源实测、preset 描述,而不是假设放之四海而皆准。preset 的既有"未命中就是未命中"式匹配机制(`matches.minSignatureTablesPresent`,`dn-pdm-family.preset.json:22`)天然支持"这个客户没有这两列"时优雅降级为全量展开,不报错、不假装探测过。
2. **廉价探针**:在全量展开前,先对该项目锚点(`FileCode`)下的行做一次只读 `SysVer`/时间戳列比对(不展开子 BOM、不落备料行);比对结果与上一批次快照记录的同一组值不一致时,才触发§1 现有的全量展开 + diff 流程。
3. **通知只在分诊后触发**:探针命中"有变化"不等于立刻打扰人——真正触发通知的是层①分诊之后落在 B/A 档、或层③碰撞检测命中的收件箱卡片数量 > 0。探针+全量展开都判定"无变化"或"全部变化都被层① C 档自动带过"时,系统**不产出任何通知**,与上级文档§4⑤给出的期望("只有 meaningful 变化才通知,不是'重拉了,没变'")一致。

**复用 vs 新建**:复用 `SysVer` 现有读取路径、preset 的信号表匹配降级机制、层①②③既有的分诊/裁决/碰撞逻辑(探针只决定"要不要触发它们",不改变它们本身);新建的是 `changeProbe` preset 角色 + 廉价探针读取路径 + "分诊后才通知"的编排层。

---

## 5. 数据模型

```
不可变快照批次链(已存在,原样复用)
  plm_stock_preparation_line  (snapshotBatchId 分区,每次重拉一批,永不改写历史批次)
        │
        │ planBomSnapshotDiff(previous, current)  ── 已存在,纯函数
        ▼
  批次间 diff(values-free,pathKey/identityKey 匹配 → 12 种 CHANGE_TYPES)
        │
        │ 层①三级分诊映射(新建,纯读)
        │ 层③ hadHumanWork 碰撞判定(新建,复用 carry-policy.cjs)
        ▼
  冲突计划器 DECISIONS = {ADD, UPDATE, SKIP, INACTIVE, MANUAL_CONFIRM}  ── 已存在
        │
        │ 层②签名匹配预选(新建,产出"建议选哪个已实现的台账动作")
        │ 层④签名记忆索引(新建,只读,查历史 CONFIRMED 行)
        ▼
  确认决策台账 plm_stock_preparation_confirmation_decision  ── 已存在
    (pending/confirmed/superseded,指纹绑定 supersede/reopen)
        │
        │ 人工确认(既有接口,不变)
        ▼
  正式主表 plm_stock_preparation_main
    human_preserved 8 列(高墙,原样复用)  +  plm_system 列(刷新覆盖)
```

**人工附着层如何在 BOM 变化时保持粘住正确的物料**:

- 主粘接键是 `idempotencyKey`(`{projectNo, componentSourceId, parentSourceId, path}` 的 JSON 序列化,`stock-preparation-bom-expansion.cjs` 的 `makeIdempotencyKey`)——只要这四个字段不变,人工列在 `UPDATE` 决策下自动原样保留(高墙,已存在)。
- `idempotencyKey` 因为 PLM 改版/换号而变化时(物理上还是同一个 `componentSourceId`),粘接靠层③接线的 `carry-policy.cjs`——`componentSourceId` 是这一层的次级签名,`CARRY_VIA_CONFIRM` 结果里显式带 `sourceIdempotencyKey` + 待带过去的字段名清单,由人经确认后把旧行的人工数据接到新行上。
- 供人识别"这是不是同一个物料"的第三重签名是 diff 引擎已有的 `identityKey`(`childDrawingNo` 图号 + `childVersion` 版本,`stock-preparation-snapshot-diff.cjs:148-153`)——`IdentityNo` 与 `SysVer` 正是这两个字段在 DN_PDM 侧的来源列。
- 决策记忆(层④)不是第四重粘接键,是一份**旁挂的建议索引**——它不决定人工数据粘在哪一行,只是在同类冲突再次出现时,把历史裁决作为默认值端上来。

---

## 6. "变更收件箱" UX 走一遍

实施者点开一个项目的"这次重拉有什么变化",看到的不是原始 diff 表,是这样一份分诊结果:

> **本次重拉:项目 230920006 · 共 14 处差异 → 9 处已自动带过(仅元数据)/ 4 处需要你看一眼(采购影响)/ 1 处需要你决定,其中 1 处是最高优先级碰撞。**

收件箱按优先级从上到下排卡片:

1. **【顶级碰撞,层③】** 「你已确认到货的这个件(图号 `XXXX-03`,IdentityNo)在 PLM 最新版本里改了材料:`Material` 从 Q345 变成 S30408(`SysVer` 同步升了一版)。你之前填写的仓库确认/领料信息还在,但绑定的还是旧规格那一行。」
   → `[把仓库确认信息带到新规格行]` `[标记为需要重新确认,暂不带]` `[人工搁置,说明原因]`

2. **【顶级碰撞,层③】** 「你已备料的这个件(图号 `XXXX-04`)在这次拉取里从 PLM 消失了(可能被删除或移出这个 BOM)。系统已把这一行冻结(数据没有丢),需要你确认下一步。」
   → `[该件确实作废,保留记录]` `[PLM 可能删错了,人工核实]`

3. **【影响采购,层①B档】** 「图号 `XXXX-01` 数量从 12 变成 14(`Bom_ExAttr1` 换算而来)。系统判断:需多备 2 件。」
   → `[接受]` `[查看这行的历史]`

4. **【同物料裁决,层②】** 「图号 `XXXX-02` 在本批次出现 2 行,`SysVer` 相同。系统建议:保留全部两行,人工核实是否应合并数量(合并写入今天还未开放,见上级文档 P1⑤)。」
   → `[接受系统建议]` `[改为:人工搁置]`

5. **【已按记忆自动处理,层④,默认折叠】** 「图号 `XXXX-05` 出现同类合并冲突,系统按你在 2026-08-15 对同一图号的裁决(操作人:王xx)预填了`人工搁置`。」
   → `[确认预填]` `[改判]`

6. **【异常提醒,层⑤ + AI 摘要】** 「图号 `XXXX-06` 数量从 2 变成 200(x100)。疑似数据错误角标。AI 摘要(可关):这个跳变幅度显著高于同类变更,建议核实是否为录入错误而非真实需求变化。」
   → `[核实后接受]` `[标记为数据错误,搁置]`

**9 处自动带过的行不出现在任何卡片里**,只计入顶部汇总的计数——这是层①对"对备料无关"变化的直接效果。

---

## 7. 非目标 / 必须保留

- **不移除人工确认门**。批次级门槛 `valid: counts[MANUAL_CONFIRM] === 0`(`stock-preparation-conflict-planner.cjs:1271`)原样保留;`assertNoHumanFields` 结构性断言原样保留。本设计五层智能化全部作用于"人该看哪些、系统提议什么",没有一层让机器绕过确认写入正式主表。
- **不让"预填/预选"变成"自动裁决"**。层④的记忆预填、层②的签名预选,产出的都是**默认值**,人依然要走既有确认接口;没有任何新路径能跳过 `confirmConfirmationDecision` 或 K2 确认写入直接落地。
- **AI 摘要不裁决**,且默认可关、走已有的 admin-gated + 用量受限 AI 底座,不新开调用通道。
- **不新建人工列存储或新的粘接键机制**。层③③接线复用 `componentSourceId`/`idempotencyKey` 这两个既有键,不新增第三套身份体系。
- **不改变 `merge_quantity`/`select_representative`/`skip_selected` 三个策略今天"刻意未实现"的状态**——是否补齐留给上级文档 P1⑤ 单独决定与排期,本设计只依赖已实现的 `keep_multiple_rows`/`accept_current`/`manual_hold` 三个动作即可上线层②的预选价值。
- **触发智能的新读取面(`Editime`/`Createtime`)必须走 preset 声明式降级**,不得假设所有 DN_PDM 部署都有这两列;preset 未声明时探针直接跳过,退回今天的全量展开路径。

---

## 8. 复用 vs 新建总表

| 层 | 复用(已存在、已接线) | 复用(已存在、未接线,本设计负责接线) | 新建 |
|---|---|---|---|
| ③ 碰撞检测 | `assertNoHumanFields` 高墙、`makeInactiveDecision` 写入行为 | `stock-preparation-carry-policy.cjs` 全部判定 | `hadHumanWork` 存在性检查、顶级碰撞卡片 UI |
| ① 变更分诊 | 12 种 `CHANGE_TYPES` 及其判定逻辑 | — | 三级分诊映射(纯读)、按档呈现 UI |
| ② 同物料提议 | `duplicate_expanded_key` 冲突类、台账三个已实现动作、`LINEAGE_FIELD_IDS`/`IDENTITY_FIELD_IDS` | — | 签名匹配预选层、歧义原因拼句 UI |
| ④ 决策记忆 | 确认台账全部历史 `CONFIRMED` 行(不新建存储) | — | 签名定义 + 只读记忆索引 + 预填展示层 |
| ⑤ 异常拦截 | `QUANTITY_CHANGED` 布尔判定 | — | 幅度阈值判定(材料兼容性字典标为远期,未交付) |
| 触发智能 | `SysVer` 现有读取路径、preset 信号表降级机制 | — | `changeProbe` preset 角色、廉价探针、分诊后通知编排 |
| AI 摘要 | `MULTITABLE_AI_*` 环境契约、admin-gated AI Shortcut、用量台账 | — | 摘要 prompt 的 values-free 输入范围(诊断字段,非业务原文) |

---

values-free:本文不含主机名 / IP / 口令 / 凭据 / 客户真实业务数据;举例中的图号、数量、材料代号均为示意值。
