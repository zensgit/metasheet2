# 通用备料 — 生产工程 gallery 包:工段/工序/工艺(P6,2026-07-22)

**状态:CONFIG PACK(手工配置 + 文档;非可导入工件;拒 MES 蔓延)**
**归属:general-prep 线 P6 刀(`general-prep-system-development-plan-20260721.md` §2 P6);
入口门 = P2 模式就绪。配套部门协作包:
`general-prep-dept-collaboration-config-pack-20260722.md`。**

## 0. 定性:普通非冻结租户表,不是治理模板

工段/工序/工艺三张表是**普通多维表租户表**——与 `stock-preparation-templates.cjs` 的冻结
治理模板族(main + 9 MVP 表,:524-833,带 ownership 契约 + drift 检查 + fail-closed
provisioning)**刻意不同类**:

- 冻结纪律只留给承载治理语义的表(refresh 保留/冲突规划/审计所在);
- 工艺词表(工段名、设备、工时口径、30 字段级的工艺属性)**属实施方/租户**,产品不冻结、
  不 drift-检查、不 fail-closed——租户加删字段自由;
- **拒 MES 蔓延**:不做排产/产能/报工/安灯。这些是逃生舱(链接出去),不是本底座的表。

「包」的诚实措辞(同 P2,审阅 P3-3):`template-library.ts` 只装 sheets/fields/views
(`InstallMultitableTemplateResult`,`packages/core-backend/src/multitable/template-library.ts`),
且模板目录 `TEMPLATE_LIBRARY` 是**代码内常量**(template-library.ts:117)——把三张表注册成
一键安装模板 = 改产品代码(小,但过 PR)。所以:

- 【手工配置·现成】= 实施方经 UI 手建三张表(本文档即建表说明书);
- 【需小代码·可选】= 三张表进 `TEMPLATE_LIBRARY`,换来 `POST /templates/:templateId/install`
  (univer-meta.ts:6859,有 dry-run :6953)一键装 **sheet/field/view**——即便如此,自动化与
  权限仍是手工(无导入原语)。

## 1. 三张表(字段类型全部取自现有闭词表)

字段类型词表:`routes/univer-meta.ts:348-376`(`MULTITABLE_FIELD_TYPES` 含
`string/number/boolean/date/select/link/lookup/rollup/formula/person/…`)。字段名用 `x_` 前缀
之外的普通命名即可(这三张表不在冻结模板族,无撞名风险;前缀纪律只针对**冻结备料表上的**
租户扩展字段)。

### 1.1 工段(work-section)

| 字段 | 类型 | 说明 |
|---|---|---|
| sectionCode | string | 编码(租户词表) |
| sectionName | string | 名称 |
| supervisor | person | 负责人 |
| active | boolean | 启用 |

### 1.2 工序(operation)

| 字段 | 类型 | 说明 |
|---|---|---|
| operationCode / operationName | string | 编码/名称 |
| section | **link → 工段表** | 归属工段 |
| sectionSupervisor | **lookup**(经 section link 取 supervisor) | 级联自动显示,见 §2 |
| equipment | string 或 select | 设备(租户词表) |
| standardMinutes | number | 标准工时 |

### 1.3 工艺路线(process-plan)

| 字段 | 类型 | 说明 |
|---|---|---|
| planCode / planName | string | 编码/名称 |
| operations | **link → 工序表**(多值) | 工序序列 |
| sectionCount / totalStandardMinutes | **rollup**(count / sum over operations link) | 汇总列 |
| sourceDrawingNo | string | 关联图号(对齐 `plmDrawingNo` 语义,见 §3) |
| status | select(租户词表) | 草稿/发布等,由实施方定义 |
| releasedDone | boolean | done-state,同协作包配方 D |

**同 base 纪律(重要)**:三张表建在**与备料表相同的 base**。link 字段默认同 base;跨 base
写与镜像是另一套 flag-gated 机制(`MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE` 等,默认 OFF),
本包不依赖它。

## 2. 级联自动填:link + lookup/rollup 为主,automation update_record 为辅

**首选机制是计算列,不是复制**:

- `lookup`(link 上取目标字段,配置解析 `univer-meta.ts:1328-1332` / `parseLookupFieldConfig`
  :1641-1646):工序表选了 section,`sectionSupervisor` 即时跟随——**活引用,改工段自动全表
  生效,零自动化规则**;
- `rollup`(aggregation over link):工艺路线的 `totalStandardMinutes` = sum(工序.standardMinutes);
- `formula` 列可再组合。

**automation `update_record` 的诚实边界**:`update_record` 的 `fields` 是**静态配置值**
(`automation-actions.ts:46-60`;执行器 automation-executor.ts:2227+ 无插值——`{{ }}` 模板
只用于 email/DingTalk 消息体,:3083/:3613/:4216)。所以它能做的是**闭词表盖章**,不能做
值复制:

| 可以【手工配置·现成】 | 不可以【需代码】 |
|---|---|
| `field.value_changed` on `operations` → `update_record` 把 `status` 盖成固定选项(如「已变更待复核」) | 「把工段的某值**复制**进工序可编辑字段」——update_record 不支持取触发记录/关联记录的值 |
| link 变更 → `send_notification` 通知工艺员 | 跨表批量重算(lookup/rollup 已覆盖其合理子集) |

值复制型 autofill 本就是反模式(复制会腐化,lookup 活引用不会);真需要「建议值写入可编辑
字段」的场景走 §3 的预填算子(经 K2 确认),不走自动化盖章。

**触发边界(同协作包 §7)**:这三张表的写入方是**人(网格)**,所以 `record.* /
field.value_changed` 自动化在这里**全量可用**——P1a 的「插件写不发事件」边界打不到 gallery 表
(它们没有插件写入方)。这也是把工艺建模放普通租户表的架构红利。

## 3. 最全方案复用:P3 预填算子按字段填充度排序 【需代码·P3 刀·有门】

需求:新工艺路线想「从历史最全的同类方案起步」。

**今天(纯配置)能做的**:按 `sourceDrawingNo` 过滤的存档视图 + 手工参照/复制。诚实说:这就
是手工抄,没有排序智能。

**P3 刀提供的(计划中,`general-prep-system-development-plan-20260721.md` §2 P3,stock-prep
门后)**:跨项目预填候选算子——沿用已跨项目的 `plmDrawingNo` 映射语义
(`plm_stock_preparation_material_mapping` 表,templates.cjs:691-699;匹配逻辑先例
`stock-preparation-material-match.cjs:93/:129`)。**按字段填充度排序** = 候选记录在一组闭字段
集上的非空计数降序(feasibility rev-2 层 1「预填算子按字段填充度排序」),只产**建议**:

- 建议写 `plm_system` 建议列,**只经 K2 确认进 human/可编辑字段**(confirm-writes 先例);
- 前置欠账(审阅 P2-2):新增 `plm_system` 列撞上 `stock-preparation-mvp-provisioning.cjs:212-215`
  的 fail-closed(existing+incomplete 表「never repairs in place」)——**先补模板演进/迁移
  rung**。注意该前置只关冻结备料表;gallery 三张表非冻结,加建议列无此约束,但**排序算子
  本身仍是 P3 代码**,本包不假装它已存在。

## 4. 视图与协作(复用 P2 配方,不再重述)

- 工序表:kanban 按 `section` 分组(`POST /views` type + `groupByFieldId`,univer-meta.ts:12122);
- 工艺路线表:grid「按图号」视图 + 「待发布」过滤视图;
- 字段权限/视图权限/personal-view/通知配方:全部照
  `general-prep-dept-collaboration-config-pack-20260722.md` §3-§7 的路由与边界执行
  (gallery 表上 `field.value_changed` 触发全量可用,见 §2 末)。

## 5. 明确不做(逃生舱)

排产与产能(MRP/ATP 已在 feasibility 非目标清单)、报工采集、设备接入、安灯;工艺文件正文
(附件字段可挂,内容治理不进本包)。需要时经 link/url 字段链接外部系统,不在底座内建。

## 6. 实施核对单

1. ☐ 在备料表同 base 手建三张表(§1 字段清单;词表值由租户定,本文档不带业务值);
2. ☐ 配 lookup/rollup 级联列(§2);
3. ☐ 自动化:link 变更 → 状态盖章 + 通知(闭词表动作,`POST /sheets/:sheetId/automations`);
4. ☐ 视图 + 权限照 P2 包;
5. ☐ 【可选·需小代码】三张表注册进 `TEMPLATE_LIBRARY`(template-library.ts:117)换一键装
   sheet/field/view——单独小 PR,不与本包捆绑;
6. ☐ 【等 P3】方案复用排序算子;落地前用 §3「今天能做的」过渡,不向租户承诺排序智能。
