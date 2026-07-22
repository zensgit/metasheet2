# 现有 stock-prep（备料）线能力全景（2026-07-22）

**状态:参考文档（现状解读，非提案）。全部对照本分支真实代码,file:line 可核。**
用途:让团队/owner 一眼看清「我们的备料线已经实现了什么」,并与「通用备料缺口」(见
`general-prep-*` 系列)对照。**这不是要建什么,是盘清已有的。**

## 一句话

我们的备料线是一条**治理完备的「PLM → 快照 → 匹配 → 异常 → 生成 → 审计」流水线**:
**~9-10 张冻结表 + ~30 个 HTTP 端点 + 9 个前端视图 + 32 个后端运行时模块**,在治理/并发/
审计/安全上系统性强于一厂自建成品;缺的是「嵌进车间的定制细节」(见 §7)。

## 1. 数据模型:冻结表（`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs`）

| objectId | 作用 | 写纪律 |
|---|---|---|
| `plm_stock_preparation_main`（:524） | 备料主表(人+机分列) | 混合:plm_system 机写 / human_preserved 人写 |
| `_project`（:599） | 项目登记 | — |
| `_bom_snapshot_batch`（:620） | BOM 快照批次(每批一行) | create-only 不可变 |
| `_bom_snapshot_line`（:642） | BOM 快照行(多级展开后每个零件) | create-only 不可变 |
| `_erp_material_master`（:667） | K3/ERP 物料主数据缓存 | upsert |
| `_material_mapping`（:691） | PLM→ERP 物料映射(**跨项目**,键=图号) | 版本化 approved |
| `_unit_conversion_rule`（:727） | 单位换算规则(scope: material/category/generic) | 确认复用 |
| `_line`（:761） | 备料行(生成产物) | create-only |
| `_exception_confirmation`（:800） | 异常确认队列 | append |
| `_run`（:833） | 同步/生成运行记录 | 状态机 |

**人机字段划分**(所有权墙的承重词表,`templates.cjs:28`):`HUMAN_PRESERVED_FIELD_IDS` = 8 项——
`materialType / blankType / stockPreparationStatus / demandDate / leadTimeDays / notes /
procurementReply / warehouseConfirmation`(采购/仓库各自那一列即在此)。机器刷新对这 8 列
**构造性零触碰**(§5)。

## 2. 端到端流水线（32 个运行时模块）

**读取 → 快照 → 差异 → 匹配 → 生成 → 异常 → 确认 → 应用 → 审计**:

1. **PLM BOM 多级拉取**（`bom-expansion.cjs`）:approved 只读源,递归展开,预算控制
   (maxDepth/maxRows/maxPages/maxReadCount/maxElapsedMs)+ 环检测(`cycle_detected`)+ 数量级联
   (parent×qty)。大 BOM 走 `large-bom-jobs.cjs` 分块 checkpoint。
2. **快照批次+行**（`sync-run-plan.cjs` / `sync-run-persist.cjs`）:落不可变批次+行,身份键 =
   `makeIdempotencyKey`(projectNo+componentSourceId+parentSourceId+path)。
3. **快照差异**（`snapshot-diff.cjs`）:批次间 **6 类阻断式 diff**——added / removed /
   quantity_changed / unit_changed / version_changed / path_changed,全 BLOCKING。
4. **物料匹配**（`material-match.cjs`）:PLM 零件 → ERP 物料,状态 matched / pending_confirm /
   multi_candidate / version_conflict;跨项目映射表使一次确认服务所有后续项目。
5. **单位换算**（`unit-rule-match.cjs`）:converted / missing_rule / conflict,规则按 scope 复用
   (确认过 REUSED)。
6. **备料行生成**（`mvp-generation.cjs` / `generation-runtime.cjs`）:合成备料行,**阻断异常门**
   ——有阻断异常不生成。
7. **冲突规划**（`conflict-planner.cjs`）:刷新所有权墙 `assertNoHumanFields`——机器刷新永不碰
   人填字段;决策 add / update / skip / inactive / manual_confirm。
8. **异常队列**（`mvp-generation.cjs:5` **8 类闭词表**）:`missing_mapping / multi_candidate /
   version_conflict / erp_item_missing / unit_missing / unit_conflict / invalid_qty /
   missing_child_bom`。
9. **人工确认**（`confirm-writes.cjs` / `confirm-reads.cjs`）:K2 服务盖章——`confirmedBy`=路由
   身份、`confirmedAt`=服务写,body 两者皆不可携带。
10. **应用写回**（`apply-writer.cjs` + `production-policy.cjs`）:policy-gated,canonical 表 apply
    受 `maxCleanRows` 上界;`unsupported_decision` fail-closed。
11. **审计**（`audit-store.cjs` + 不可变触发器迁移 `zzzz…stock_prep_audit_immutable_trigger`）:
    values-free。

## 3. HTTP 端点（~30 条,`http-routes.cjs`）

`projects` / `snapshot-batches` / `prep-lines` / `exceptions`(+`bulk-resolve`/`resolve`) /
`material-mappings`(`candidates`/`candidates/sync`/`confirm`/`retire`/`summary`) /
`unit-conversions`(同族四条) / `generation/run` /
`mvp`(`ensure`/`readiness`/`options/sync`/`erp-materials/sync`/`source-runs/plm-bom`/
`source-runs/erp-materials`/`sync/plan`/`sync/persist`) /
`target`+`sandbox-target`(`ensure`/`readiness`) / `audit`。

## 4. 前端:9 个视图（`apps/web/src/components/integration/stockPreparation/`）

`Workspace` / `ProjectWorkspace` / **`StageStepper`**(阶段步进器) / `SnapshotDiff`(快照差异) /
`MappingConfirm`(映射确认) / `UnitConfirm`(单位确认) / `PrepLine`(备料行) /
**`ExceptionQueue`**(异常队列) / `Dashboard`——一套向导式备料工作台。

## 5. 治理/安全属性（强于一厂自建成品处）

- **approved 只读源**(非直连库);
- **所有权墙**:机器刷新永不覆盖人填 8 字段(`conflict-planner.cjs` `assertNoHumanFields`);
- **不可变快照 + 内容寻址身份键**;
- **values-free 审计**(不泄业务值)+ 不可变审计触发器;
- **乐观并发 + global-history**;
- **K3 写回锁在 dry-run / Save-only**(受 T3 治理,非直接写);
- **异常 8 类闭词表 + K2 盖章确认**(confirmedBy/At 服务写,body 不可携带)。

## 6. 与 #4437 RC-A 的关系

RC-A(`#4437`)是这条线的**实体机受控验收窗口**:approved-source → 内部持久化,T3b flag 临时 ON,
一跑一无条件复原。sidecar v2 诊断器(`stock-preparation-rca-abort-provenance`)已发布验证。
即:上面这条流水线的**生产可用性验收**正在实体机侧进行(A 段已过,C 段单窗口待操作员)。

## 7. 现有线**故意未做**的（对照一厂成品的缺口,已逐个 grep 确认不存在）

| 缺口 | 现状核实 | 对应新刀(general-prep 线) |
|---|---|---|
| 跨批 human 字段继承(component_source_id) | conflict-planner 零 cross-batch/carry 命中,只做 1→1 同 key UPDATE-保留 | **P4 carry-policy**(已建已审) |
| 日期级联 / 跨项目预填 | stock-prep lib 里 demandDate 从 leadTime 计算 = 零命中 | **P3 suggestion-operators**(已建已审) |
| 租户扩展字段命名空间 | 无 ext_ 命名空间(命中皆 CONTEXT_/next_ 子串) | **P1b extension-namespace**(已建已审) |
| 模板加列不炸已装表 | `ensureFields` 是 DO UPDATE(覆写);无 additive 原语 | **W2 additive rung**(核心原语已真库验证) |
| 工段/工序/工艺、图号识别、钉钉待办总线、宜搭、MRP、SMB 图纸 | 无对应域 | 配置层(C1/C2/G2)或明确不做 |

**注**:`stock-preparation-sync-run-repair-once.cjs` 的「repair」是**修数据行**(补缺失写后缀 /
推进陈旧项目指针),**不是修 schema/字段**——与 W2 的「加缺失模板列」正交,零重叠(易误判,特此标明)。

## 一句话总结

**备料这个功能我们有,而且是一条治理完备的成品流水线。** 缺的不是「备料」,是「参考系统嵌进车间
的那几块定制」(跨批继承/日期级联/工艺/图号/待办)——其中数据面四块(P1b/P3/P4/W2)已建/验证,
车间面(工艺/图号/待办)走配置层或需求门。
