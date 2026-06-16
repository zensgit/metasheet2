# 多维表 Button / Action 字段 — B1-S0 设计锁 — 2026-06-15

> Status: **DESIGN-LOCK(实现前)**。对应基准刷新阶梯 `multitable-benchmark-refresh-ladder-20260615.md` 的 **B1**(按钮/动作字段,差异化"超越"项)。
> 范围:字段 schema + 执行 API + 排除矩阵 + 渲染/配置边界。**docs-only,本 PR 不含实现。**
> 评审:增量 + APPROVE-WITH-CORRECTION 已并入(inert-action 解 §2↔§5 冲突)。

## 0. 核心心智模型(B1 主轴)

**Button = qrcode 式 render-only 字段(吃"无值"排除)+ AI-shortcut-run 式执行(吃"点击"语义)。**

一句话目标:用户在表里加一个 button 字段,每行显示一个按钮,点击后按**当前记录上下文**执行已配置动作,返回 succeeded/failed/进行中 + 审计。

关键认知:这不是"加一个 field type + 渲染按钮",而是"**一个无值字段进入一个以值字段为中心的系统**"。因此**第一优先级是排除矩阵**(§2),不然伪值语义会在导出、查询、公式、聚合、自动化条件、条件格式里到处漏出。

## 1. 字段类型决策

- **真字段类型 `MetaFieldType = 'button'`**(FE `types.ts` + 后端 `field-codecs.ts` 的 `MultitableFieldType`),不用 `property.kind` 伪类型——避免后续查询/渲染/字段管理一直绕弯。代价是 §2 的排除矩阵,必须接受并系统化。
- **无值模型**:`record.data[fieldId]` 对 button **不是权威输入、通常不存在**。按钮状态 = 字段 property(配置)+ 当前记录权限 + action runtime,**与单元格值无关**。
- **先例复用**:`autoNumber`/`createdTime`/`createdBy`/`modifiedBy` 已是"非用户录入"字段且有 `isSystemField` 闸;`qrcode`/`barcode`(#2593)是"只渲染、不可编辑"先例。button 的"无值/不可编辑"侧尽量复用 `isSystemField` 式既有闸,不另造排除逻辑。

## 2. value-field 排除矩阵(B1 头号硬约束 · 后端兜底,不只靠前端不显示)

真加第 29 个字段类型,所有"消费字段值"的 `switch(field.type)` 路径必须**显式排除 button**,否则 B1-a0 漏出伪值。**每条都要后端 guard + 一个"button 被排除"的断言测试**:

| 子系统 | 锚点文件 | button 必须 |
|---|---|---|
| 导出 | `xlsx-service.ts` + A2 导出选择器 | 不进列 / 不取值 |
| 查询·读 | `query-service.ts` | 不当值列 |
| 写 | `record-write-service.ts` | **拒绝写入 button 单元格**(写路径兜底) |
| 校验 | `field-validation-engine.ts` | 跳过 |
| 公式 / lookup / rollup | formula 引擎 + 字段管理 | 不可被引用为输入 / 不可作 lookup·rollup 目标 |
| sort / filter / aggregation | query / 聚合 | 不可排序 / 筛选 / 聚合 |
| 条件格式(算子 + A5 scale) | `conditional-formatting-service.ts` | 不是合法 fieldId(scale 还要求数值) |
| 自动化条件 | `automation-conditions.ts` | 不可作条件字段 |
| 搜索 | 读路径搜索 | 无文本可匹 |
| 网格可编辑集 | `MetaGridTable.vue` `EDITABLE` | **不加入 EDITABLE**(button 是点击,不是编辑) |

原则:**排除在后端兜底**(前端不显示只是 UX,不是边界)。B1-a0 的验收 = 每条路径有一个"喂进 button 字段 → 被正确排除/拒绝"的 fail-first 测试。

## 3. 执行走既有 executor + inert 首 action(解 §2↔§5 冲突)

### 3.1 不变量:只经 executor 派发,不开旁路

`button/run` 只组装 `{ sheetId, recordId, fieldId, actorId, recordData }` 上下文,然后调用**既有 action executor**(单-action 派发在 `automation-executor.ts:1581` 的 `private executeSingleAction`(:1573)内 `switch(action.type)`;`execute()` 入口在 :776。**勘误:本设计锁初稿误写 :1346,经 origin/main 核验更正为 :1581**),继承其 per-action 权限闸、审计(`automation-log-service` + redact)、跨 base 治理墙(`evaluateCrossBaseWrite`)。button **不新增任何 action 语义,只加一个触发面**。`actionType` 取值 = `AutomationActionType` 集合内。

### 3.2 修正:首 action = executor-owned inert action(新增 action type,非旁路)

"不开旁路" ≠ "不新增 action type"——两者不等价。现有 `AutomationActionType`(update_record/create_record/delete_record/send_webhook/send_notification/send_email/send_dingtalk_*/lock_record/wait_for_callback/condition_branch/start_approval/parallel_branch)**没有 inert 类型**,故首刀不能是纯 no-op,除非:

**决策:新增一个 executor 名下的 inert action(暂名 `record_click`,见命名注)**,在 `automation-executor.ts:1581`(`executeSingleAction` 的 `switch`)加一个 `case`:只写审计/点击记录、**零业务副作用**(不写记录、不外发)。它是 executor 自己派发的动作,**满足"统一 executor"**;又**满足"最安全首刀"**(爆炸面为零)。严格优于以 `send_notification` 起步(后者有真外发副作用 + 投递语义)。

- **inert action 的闸** = `record-readable`(零副作用,能读该记录即可点击;仍服从 §4 的"执行授权 = action 自身闸")。
- **picker 可见性**(是否出现在通用自动化 action 选择器,`MetaAutomationManager.vue`/`MetaAutomationRuleEditor.vue`)= **B1-c 的 UI 决策**;倾向 button 上下文专用、从自动化构建器过滤(inert 点击在定时/触发自动化里无意义)。B1-a1 只管注册+派发。
- **命名注**:executor 触发无关,按**行为**命名(`audit_only`/`record_click`)比按触发(`button_click`)更贴习惯;实现期定,二者皆可。

### 3.3 action 升级序(各自门控 follow-up)

`record_click`(inert,首刀)→ `send_notification`(additive)→ `update_record`/`send_webhook`(写 / egress;webhook 还要等 redaction value-scrub 那条落定再开)→ 其余按需。

### 3.4 审计姿态(AUDIT-1,有意决策,经评审)

- **B1-a1 inert `record_click` 的审计 = `logger.info`(ephemeral),有意,不写持久行**。理由:inert action **零已提交状态**(不写记录/不外发/不起 job),没有"对数据发生的事"可追;为一个 no-op 写一条持久 `multitable_automation_executions` 行不是审计严谨而是 ceremony。**且会污染**该表所驱动的规则执行分析与 DF-N1 运行监控 UI(非-rule 的 `rule_id='btn_*'` 行会出现在 `getRecent`/`listExecutions`/监控列表等非 rule-scoped 面)。
- **持久审计行 = 行为级硬前置,挂在"首个有副作用的 button action"那一刀上**(即 §3.3 中 `send_notification` 起):**该 slice 必须经 `AutomationLogService.record()` 写一条已脱敏的 `multitable_automation_executions` 执行行,并带一条断言该行落库的测试**。这样审计随"button 真正做事"同 PR 落地——正是"feature 一能用,审计最易丢"防线生效处。
- **confirm-before-run 同此前置(AUDIT-1 的孪生)**:button property 的 `confirm:{enabled,message?}` 在 B1-b 仅**解析**(`resolveButtonFieldProperty`),**不强制**——理由对齐:confirm 只能在 B1-c 配置 UI 里**被设置**(B1-b 前无配置面),且当前唯一启用的 action 是 inert `record_click`(确认一个 no-op 无意义),confirm 本质是**破坏性 action 的安全闸**。故 **confirm 强制与首个有副作用 action 同 slice 落地 + 带测**——与持久审计行捆绑:"button 能做事"那一刀同时带上"做之前先确认 + 落审计"。
- **覆盖既有 §run-API 第 2 步措辞**:那条"写执行记录行(走既有 log-service + redact)"针对**有副作用 action**;inert 首刀按本节用 `logger.info`。
- 例外(会翻成"现在就建"):出现明确要求**连 inert 点击也须持久可查**的合规/安全诉求时再建,并须先确认所有会浮现的执行查询面(运行监控 + recent/list)都是 rule-scoped,否则即引入污染。

## 4. 不变量:可见性 ≠ 可执行性

B1 头号安全风险 = 低权限用户看到一个执行高权限动作的按钮。锁:

- **看见**按钮 = view 内该 field visible。
- **执行** = 点击时由 **action 自身的闸在服务端 dispatch 时重新评**(`update_record`→canEditRecord;`send_webhook`→webhook 闸;`record_click`→record-readable)。**永不"可见即可执行"**。
- **配置** button 字段 = `canManageFields`。

## 5. run API 契约(照搬 AI-shortcut-run / #2623 形状)

`POST /api/multitable/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run`

与 `multitable-ai.ts` 的 AI-shortcut-run 同构(同类问题:per-record 服务端动作 + 审计 + 状态):

1. **preflight**:字段存在 + 类型为 button + 用户可读字段&记录 + 配置可用;失败 → 语义码(404/400/403)。
2. **audit/log best-effort**:写执行记录行(走既有 log-service + redact);**绝不为写一条 log 而 500 已提交的写**。**(审计姿态分级见 §3.4:inert 首刀用 `logger.info`;持久执行行挂在首个有副作用 action 那一刀。)**
3. **dispatch**:经 executor 调底层 action(§3.1),action 自身闸在此评(§4)。
4. **settle**:返回统一 shape `{ status: 'succeeded'|'failed', message?, executionId? }`;**错误不吞**;403/409(version conflict)/429 等按语义透出(同 #2623)。

**幂等/防双击**:前端 in-flight 禁用;后端接受 optional `requestId`,首版至少保证同一按钮短时间重复点击不产生不可解释状态(完整 exactly-once 作 follow-up,参 #2623 reserve-then-settle / DF-N1.5 幂等先例)。

## 6. 配置 shape(最小化)

```ts
{
  label: string,
  variant?: 'primary' | 'secondary' | 'danger',
  actionType: AutomationActionType,        // §3 子集;首版仅暴露 B1-a1 已支持者
  actionConfig: Record<string, unknown>,   // 复用既有 per-action config schema/validator
  confirm?: { enabled: boolean, message?: string },
}
```

button 字段本身不存每行值;展示全来自此 property。

## 7. 边界锁(不写进 S0 后面实现必漂)

- **form-create 视图**:button 在建记录上下文语义怪(还没有记录)。锁:**B1 仅 grid + 记录详情**;form-view button 出范围。
- **跨 base action**:跨 base 的 button 动作继承本季的跨 base 治理墙。锁:**B1 首批 action 同 base**;跨 base 走既有跨 base 闸,门控 follow-up。
- **locked / read-only 行**:button 在 locked 行**禁用**(执行端也兜底拒绝)。
- **FieldManager property merge**:button 字段 PATCH **必须保留未知 property 键**(fail-closed allowlist / deep-merge),测试"只改 label 不丢 actionConfig"——防 v2-b1 shallow-overwrite 配置丢失重演。

## 8. 切片(评审调整后)

| Slice | 内容 | PR 类型 | 我能否独立验证 |
|---|---|---|---|
| **B1-S0** | 本设计锁(排除矩阵 + inert-action 决策 + run API 契约 + 不变量) | docs | ✅ 现在 |
| **B1-a0** | 后端字段契约:`MetaFieldType='button'` + property sanitizer + **§2 全排除 guard** | backend | ✅ 纯单测 + tsc |
| **B1-a1** | 执行:`button/run` + executor-owned `record_click` inert action + 审计 + dispatch 授权 | backend | ✅ 单测(含 §4 闸 / §5 失败语义 fail-first) |
| **B1-b** | **grid** render button(可见/禁用/执行中/错误态,不含配置 UI)。**SHIPPED #2699(grid only)**;原 S0 文写"grid/记录详情"但实交付仅 grid(经 MetaCellRenderer);记录详情面是 MetaRecordDrawer 的并行 per-type 链,拆为 **B1-e**(见下) | frontend | ✅ jsdom 渲染/emit/禁用 + **真实 Chromium lane**(render→click→pending→done) |
| **B1-c** | FieldManager 配置 UI(创建/编辑 button、label/variant/actionType/confirm authoring、actionConfig clobber-guard)。**SHIPPED #2703** | frontend | ✅ jsdom(create + keystone actionConfig 保留)+ lane 验 🔘 header icon |
| **B1-d** | 验证 + tracker closeout(fail-first 证据、CI 锁、剩余项登记) | docs/test | ✅ |
| **B1-e**(新,queued — owner 2026-06-16「可排队不急」) | **记录详情(MetaRecordDrawer)clickable button render** —— 其独立 per-type 链(非 MetaCellRenderer);今天 button 在记录详情走默认只读、不崩、但不可点。**form-view 保持出范围(§7);如启用须先定 hide / read-only 展示 / clickable 动作**。续做 button arc 时**优先 record drawer**,form-view 仅设计决定 | frontend | ⚠️ jsdom + lane(harness 需扩 MetaRecordDrawer) |

## 9. 验证计划(实现期)

- **B1-a0**:§2 矩阵每行一个"button 被排除/拒绝"fail-first 测试 + property sanitizer enum/merge 测试 + tsc。
- **B1-a1**:非读者 403 · field hidden 403/404-like · 非 button field 400 · disabled/malformed config 400 · inert action 成功带 record context + 写审计 · 失败不吞 · requestId 去重 · 可见≠可执行(低权限点高权限 action 被服务端闸挡)。
- **B1-b**:button 渲染为按钮(不显示普通值)· 点击 emit `{recordId,fieldId}` · pending 禁用防双击 · field hidden 不渲染 · locked 行禁用。
- **B1-c**:创建带 property · 只改 label 不丢 actionConfig · 切 actionType 清理不兼容 config · confirm round-trip · **需浏览器**真路径目检。
- **验证边界(诚实)**:S0/a0/a1 在纯单测+tsc 验证半径内可独立交付;b/c 的真实 configure→render→click 路径需 app/browser access(同 A5 渲染/对话框边界)。

## 10. 落地

本 PR = B1-S0 设计锁。实现按 §8 切片,contracts-first,每片独立 PR + fail-first 验证;a0/a1 可即时推进,b/c 挂浏览器访问。
