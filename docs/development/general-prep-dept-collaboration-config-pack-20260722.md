# 通用备料 — 三部门协作配置包(P2,2026-07-22)

**状态:CONFIG PACK(手工配置 + 文档;非可导入工件)**
**归属:general-prep 线 P2 刀(`general-prep-system-development-plan-20260721.md` §2 P2);
前置 = P1a substrate 证明已落(commit 2d0ebcdab,
`packages/core-backend/tests/integration/stock-prep-substrate-p1a-realdb.test.ts`)。**

## 0. 「包」的诚实定性(审阅 P3-3,先说清)

`template-library` 的安装原语**只装 sheet / field / view**:
`packages/core-backend/src/multitable/template-library.ts` 的
`InstallMultitableTemplateResult = { template, base, sheets, fields, views }`,安装路由
`POST /templates/:templateId/install`(`routes/univer-meta.ts:6859`)。
**字段权限、自动化规则、personal-view 均无导入原语。**

所以本文档**不是**「一键导入的协作包」,而是**实施方照做的手工配置 runbook**——每一步只用
今天 main 上已存在的多维表原语,零后端代码。真「可导入」需要新 installer 代码,那是另一刀
(有门),不在本包范围。每节标注:

- 【手工配置·现成】= 今天就能做,无代码;
- 【flag·owner 门】= 原语存在但默认 OFF,开启是 owner 决策;
- 【需代码·后续刀】= 本包做不到,诚实列账。

## 1. 底座事实(为什么纯配置能成立)

1. **备料表是真多维表**:main 表 + 9 张 MVP 表
   (`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs:524-833`,objectId
   `plm_stock_preparation_main / _project / _bom_snapshot_batch / _bom_snapshot_line /
   _erp_material_master / _material_mapping / _unit_conversion_rule / _line /
   _exception_confirmation / _run`)。P1a 真库测试已证:插件 `records.createRecord` 落
   `meta_records`,`field_permissions` 行绑得上该 sheet(正例 1/2)。
2. **字段所有权是模板级契约**:`stock-preparation-templates.cjs:28-37`
   `HUMAN_PRESERVED_FIELD_IDS` 恰好 8 个:

   ```
   materialType, blankType, stockPreparationStatus, demandDate,
   leadTimeDays, notes, procurementReply, warehouseConfirmation
   ```

   `human_preserved` 字段强制 `preserveOnRefresh = true`(同文件 :172-178),refresh 原地保留;
   其余 `plm_system` 字段每次 refresh 由 planner 覆写。
3. **P1a 负例(本包所有通知配方的硬边界)**:同库同 flag 下,**插件写路径
   (refresh/apply/sync/confirm)不产出任何自动化事件**——record 事件只在网格路由层发射
   (`routes/univer-meta.ts:10530+` 的 `enqueueRecordEventIfDurable`/`emitRecordEventIfLegacy`)。
   「批次刷新 → 自动通知采购/仓库」**今天表达不了**,是未来的 emit-seam 刀(feasibility rev-2
   §关键事实)。本包的通知配方因此**只挂人工网格编辑触发 + 日程触发**。

## 2. 部门 ↔ 字段映射(配置的唯一真源)

| 角色(占位) | 可编辑字段(全部来自 HUMAN_PRESERVED_FIELD_IDS) | 其余字段 |
|---|---|---|
| 计划员 `<planner-role>` | `materialType` `blankType` `stockPreparationStatus` `demandDate` `leadTimeDays` `notes` | 只读 |
| 采购 `<procurement-role>` | `procurementReply` | 只读 |
| 仓库 `<warehouse-role>` | `warehouseConfirmation` | 只读 |

`plm_system` 字段对**所有**部门角色一律只读:即使网格写进去,下次 refresh 也会被 planner 覆写
(`refreshPlmSystemFields: true`,templates.cjs:551-558 conflictStrategy)——锁只读是防「写了又被
静默冲掉」的用户困惑,不是防数据损坏(损坏本就不会发生)。

## 3. 配方 A — 字段权限 profile 【手工配置·现成】

**原语**:`field_permissions` 表
(`packages/core-backend/src/db/migrations/zzzz20260411140100_create_field_permissions.ts`:
`sheet_id, field_id, subject_type, subject_id, visible, read_only`,默认 visible=true /
read_only=false;subject_type 经 `zzzz20260418143000` 扩为 `user | role | member-group`)。

**路由**(`routes/univer-meta.ts`):
- 读:`GET /sheets/:sheetId/field-permissions`(:7927)
- 写:`PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId`(:8040)

**操作**:对 `plm_stock_preparation_main` 对应的 sheet,逐字段逐角色 PUT:
- 对 `<procurement-role>`:除 `procurementReply` 外全部 `read_only: true`;
- 对 `<warehouse-role>`:除 `warehouseConfirmation` 外全部 `read_only: true`;
- 对 `<planner-role>`:6 个计划员字段可写,其余(含 `plm_system` 全部)`read_only: true`。

**诚实注记**:`field_permissions` 是「默认可见可写、按行收紧」模型——profile 必须**枚举**行
(约 25 字段 × 3 角色)。手工量不小但纯机械,可用上述 PUT 路由脚本化;这仍算「配置」而非
「代码」(不进产品仓)。写侧强制在 layer-3 生效(`isFieldWriteForbidden`,univer-meta.ts:10555
等多处调用),不是纯 UI 装饰。

## 4. 配方 B — 部门存档视图 【手工配置·现成】

**原语**:`meta_views` + 视图级权限 `meta_view_permissions`。
- 建视图:`POST /views`(univer-meta.ts:12122;`type` 默认 `grid`,支持 `filterInfo` / `config`);
- 视图权限:`GET /views/:viewId/permissions`(:7712)、
  `PUT /views/:viewId/permissions/:subjectType/:subjectId`(:7823;subject 同样支持
  `user | role | member-group`)。

**建议视图集**(过滤条件写字段引用,不写业务值——值由实施方按租户词表填):

| 视图 | filter(示意) | 给谁 |
|---|---|---|
| 采购工作台 | `active = true` 且 `procurementReply` 为空 | `<procurement-role>` |
| 仓库工作台 | `active = true` 且 `warehouseConfirmation` 为空 | `<warehouse-role>` |
| 计划总览 | `active = true`,按 `stockPreparationStatus` 分组 | `<planner-role>` |
| 冲突待处理 | `lastPlmRefreshDecision = <conflict 选项>`(选项词表 `plm_stock_preparation_decision_v1`) | `<planner-role>` |

## 5. 配方 C — personal-view overlay 【flag·owner 门】

**原语存在但默认 OFF**:`MULTITABLE_ENABLE_PERSONAL_VIEWS`
(`packages/core-backend/src/multitable/personal-view-config.ts:47-53`,default-OFF;
设计锁 `multitable-personal-views-design-lock-20260705.md`)。路由
`GET/PUT /views/:viewId/personal-config`(univer-meta.ts:12826+)。

开启后,部门成员可在共享视图上叠个人 `filterInfo / sortInfo / groupInfo / hiddenFieldIds /
fieldOrder`(overlay 白名单即此五项,personal-view-config.ts:30-37),**不改共享视图**;无
overlay 时按引用原样返回共享配置(降级契约 §1-C)。**本包不授权开 flag**——列为 owner 决策项。

## 6. 配方 D — done-state 复选字段 【手工配置·现成,带 P1b 注记】

给三部门各加一个「本部门已完成」布尔字段(多维表字段类型含 `boolean`,univer-meta.ts:348-376),
如 `x_procurementDone` / `x_warehouseDone` / `x_planReleased`(`x_` 前缀见下)。

**为什么安全(feasibility rev-2 已证)**:
- planner 只 patch 模板内 `plm_system` 字段,模板外租户字段**永不进 refresh patch**
  ——扩展字段 refresh-安全 by construction;
- drift 检查单向(`stock-preparation-target-provisioning.cjs:214` `missingLogicalFields`
  只查模板字段缺失),多余租户字段不触发 drift。

**P1b 注记(诚实)**:命名空间纪律(前缀防未来模板字段撞名)是**未落的 P1b 刀**。本包先行约定
`x_` 前缀作实施方纪律;P1b 落地前它只是约定,没有守卫强制。

## 7. 通知配方 【手工配置·现成 + 硬边界 + 投递 flag 列账】

**原语**:sheet 级自动化规则,`POST /sheets/:sheetId/automations`(univer-meta.ts:17429;
GET :17404 / PATCH :17467 / DELETE :17515)。触发词表
`automation-triggers.ts:6-17`,动作词表 `automation-actions.ts:6-26`(闭词表,勿超出)。

**本包只用两类触发**(P1a 负例圈定):

| # | 触发 | 动作 | 语义 |
|---|---|---|---|
| R1 | `field.value_changed` on `procurementReply` | `send_notification` → `<planner-user-ids>` | 采购回复了 → 通知计划 |
| R2 | `field.value_changed` on `warehouseConfirmation` | `send_notification` → `<planner-user-ids>` | 仓库确认了 → 通知计划 |
| R3 | `field.value_changed` on `x_planReleased`(changed_to true) | `send_notification` → `<procurement-user-ids>` | 计划放行 → 通知采购 |
| R4 | `schedule.date_field` on `demandDate`(N 天前,`automation-date-reminder.ts`) | `send_notification` | 需求日期临近提醒 |
| R5 | `schedule.cron` / `schedule.interval` | `send_notification` | 固定节奏例会提醒(无 record 上下文) |

**R4 的特殊价值(诚实说明)**:`schedule.date_field` 按**记录字段值**扫描算 occurrence
(automation-date-reminder.ts 头注,DATA-driven、按 rule+record+occurrence 去重)——它**读值不读
事件**,所以对插件 refresh 写进来的行同样生效。这是今天唯一能「够到」插件写入数据的通知形态。

**硬边界(再钉一次)**:R1-R3 只在**人经网格编辑**时触发。refresh/apply/sync/confirm 改行
**不触发任何 record.* 规则**(P1a 负例★)。不要配置 `record.updated` 规则去等批次刷新——它永远
不响。refresh-驱动通知 = 未来 emit-seam 刀【需代码·后续刀】。

**投递 flag(owner 门,全部默认 OFF)**:
- `send_notification` 本身是进程内 eventBus 发射(automation-executor.ts:3004-3045,best-effort
  in-app,非持久);
- durable 投递:`AUTOMATION_DURABLE_DELIVERY_ENABLED`(automation-durable-delivery.ts:21);
- Class-A claim:`AUTOMATION_CLASSA_CLAIM_ENABLED`(automation-execution-ledger.ts:38);
- Class-B 出站(email/DingTalk):`AUTOMATION_CLASSB_OUTBOUND_ENABLED`
  (automation-outbound-intent.ts:64)+ 各渠道 env 凭据(env-gated register-only)。

本包配方在 flag 全 OFF 下即可用(in-app 通知);任何出站/持久投递的开启是 **owner 决策**,
不在本包授权范围。消息模板 `{{fields.<fieldId>}}` 插值只存在于 email/DingTalk 消息体
(`renderAutomationTemplate`,automation-executor.ts:171-175,调用点 :3083/:3613/:4216)。

## 8. 需代码账本(本包明确做不到的)

| 项 | 缺口 | 归属 |
|---|---|---|
| 一键导入本包 | 权限/自动化/personal-view 无导入原语 | 新 installer 刀(有门) |
| 刷新驱动通知 | 插件写路径零事件 | emit-seam / outbox 刀 |
| 跨批 human 字段继承 | `assertNoHumanFields` 墙,需 K2 代签 | P4 carry-policy 刀 |
| 建议列(日期级联/预填) | 需模板演进 rung + P3 算子 | P3 刀 |

## 9. 实施核对单

1. ☐ 确认 P1a 测试在目标环境绿(底座前提);
2. ☐ 建三角色 subject(`user`/`role`/`member-group` 任一,与租户组织对齐);
3. ☐ 配方 A:逐字段 PUT field-permissions(§3 矩阵);
4. ☐ 配方 B:四个存档视图 + 视图权限;
5. ☐ 配方 D:三个 `x_*Done` 布尔字段;
6. ☐ 配方通知 R1-R5(flag 全 OFF 即 in-app);
7. ☐ 【owner】personal-view flag、投递 flag 决策各自单独过门;
8. ☐ 验收:以三角色各登一次,验证「只能编辑本部门字段 + 本部门视图 + 通知可达」。
