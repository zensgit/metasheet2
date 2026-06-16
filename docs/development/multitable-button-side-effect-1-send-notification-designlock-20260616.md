# 多维表 Button 首个有副作用动作 (B1-S1 = send_notification) — 设计锁 — 2026-06-16

> Status: **DESIGN-LOCK(待评审,不实现)**。owner opt-in 2026-06-16:先锁定第一个有副作用 button action 的合同,审过再实现。
>
> 命名:称 **B1-S1**(side-effecting action #1)。**不复用 "B1-d"**(B1-d 已是 §8 验证 closeout 行)。本动作是 B1-S0 §3.3 升级序里 `record_click → **send_notification** → update_record/send_webhook` 的第二步。
>
> 价值:把按钮从"可点"变成"有用",并把两条**刻意 deferred 的安全承诺**一起落地——confirm 从 parsed→**强制**;durable audit 从"等首个有副作用动作"→**强制记录**。`record_click` 继续保持 inert/logger-only,不混淆。send_notification 成为后续动作(update_record/send_webhook)扩展的**可复用合同样板**。
>
> grounded:dynamic workflow `wf_5be673e0-fd0`(3 路,逐 file:line 核验)+ 独立读 `executeSendNotification`。

## 0. 头号发现 + 必须先定的决策:send_notification 当前**投递到空**

`executeSendNotification`(`automation-executor.ts:2337-2369`)只 `eventBus.emit('automation.notification', …)`;**生产环境无任何订阅者**(枚举 core-backend/src 所有 eventBus 订阅,仅测试文件监听)。即 `status:'success'` = **已 emit,非已送达**。`eventBus.emit` 同步、返回 void、吞异常(`event-bus.ts:32-37`)。

**这破坏前提,不只是一个 flag**:若 send_notification 投递到空,它**今天就不是"有副作用动作"——它做的事和 inert `record_click` 一样:什么都没有**。把 confirm 强制 + durable audit + 幂等这套安全装置包在一个 no-op 外面,就是当初我们为 inert record_click **拒绝**写持久审计行时拒绝的同一种 ceremony。故**不**把"先 ship、sink 后补"当作平权选项(那正是该 smell)。

**决策 D0(待 owner 拍板,前提破坏需可见)**:
- **D0-A:send_notification **连 sink 一起做**(真正有副作用)**——同 slice 接最小 in-app 通知 sink(`automation.notification` 订阅者 → notifications 表 + 最小未读/收件 FE 面,或复用既有通知面)。这才真正送达、安全承诺才有意义、才符合"从可点变成有用"。真实 scope,如实命名。
- **D0-B:改选首个动作 = `update_record`**——它**无需 sink 就真正有副作用**(写记录),可能才是更真的"首个 side-effecting action",代价是更高风险(写数据)。
- **D0-C(若选,必须如实标注):仅把可复用合同样板搭在最便宜的动作(send_notification,仅 eventBus)上,作为 framework 工作,明确"不交付按钮的产品价值"**——不得包装成"让按钮有用"。

> 评审先在 D0-A / D0-B / D0-C 间选定(前提破坏摆在明处)。其余合同(§2-§9)三路通用。

## 1. 启用 = **两处改动,非一处**(陷阱)

`multitable-button.ts`:(i) `ENABLED_BUTTON_ACTIONS` 加 `send_notification`(:35);**AND** (ii) 把 dispatch 处**硬编码的 `{ type: 'record_click' }`(:104)改成传校验后的 `actionType`**。只加 allowlist 不改 dispatch = 静默 no-op(仍跑 record_click)。这是非显而易见的关键。

## 2. 动作 payload 合同

持久 `property.actionConfig` = `{ userIds: string[]; message: string }`(均必填;空 userIds/message → executor 返回 `status:'failed'`)。这是 rule editor 的**保存形**(`MetaAutomationRuleEditor.vue:2806`),**非** editor 草稿的单数 `config.userId`。**B1-c 配置面需扩**:authoring userIds(多选/逗号)+ message。无模板插值(message 原样发,不并入 recordData)。

## 3. 权限(actor 闸,服务端 dispatch 时以 actor 重评)

`executeSendNotification` **自身无 actor 授权**(`executor.ts:2337-2369`);run 路由是**唯一**能为按钮点击路径加 actor 权限处。**锁(PROVISIONAL,评审重点审):B1-S1 闸 = `canEditRecord`**——注意这是**语义代理**(能改数据 ≠ 能给人发消息),取它仅因是已有的最近写级闸;**标记为暂定**,评审应认真定夺是否需要专门的 notify 能力,勿因"已锁"而继承。"可见 ≠ 可执行"不变量:按钮可见不代表可点发;非授权点击 → 干净 403。后续动作各自定闸。

## 3.1 收件人授权(notify 动作的**头号安全控制**,勿漏)

`userIds: string[]` **必须**受约束:**收件人只能是该 sheet/base 的成员**,**服务端校验**(config 保存时 and/or dispatch 时,实现期定其一或两者)。否则字段作者可配一个按钮,向**任意 user ID** 发**自定义消息** = 信息泄露 / 垃圾消息向量——而本文其余控制(actor 闸、脱敏、审计)俱全,唯独这条 notify 动作**最重要**的控制缺失,评审若不补即等于默许此洞。**锁:dispatch 时把 `userIds` 过滤/拒绝到 sheet/base 成员集;越界收件人 → 拒(校验失败语义)**。

## 4. confirm 强制(parsed → enforced;闭合 §3.4 deferral 的 confirm 半)

FE `onRunButton`:若 `field.property.confirm.enabled` → **先弹确认**(用 message,缺省走通用确认文案)再 `client.runButton`。confirm 已在 B1-c **authoring**(存),本 slice 把它**强制执行**。确认在 FE(动作 dispatch 前),不下发到后端。

> **confirm 是客户端 UX 防误触,不是安全控制**。真正的权限/收件人闸在服务端(§3 / §3.1)。本文是后续动作样板——当扩到 `update_record`/`send_webhook`(破坏性/egress)时,**绝不可**把 FE confirm 误当服务端强制。

## 5. durable audit(强制;闭合 §3.4 deferral 的审计半)+ 防污染

side-effecting 动作**必须**经 `AutomationLogService.record()` 写一条**已脱敏**的 `multitable_automation_executions` 执行行:
- `runSingleAction` 返回的是 step 不是 execution → 路由**自行构造** `AutomationExecution`{id, ruleId:`btn_<fieldId>`(仅 provenance), **triggeredBy:'button'(显式!)**, triggeredAt, status(from step), steps:[step], sheetId, triggerEvent}。**勿依赖** executor 的 `_triggeredBy` 推导(按钮设的是 `_trigger`,会默认成 'event' 而不可滤)。
- **防污染(DF-N1 运行监控)**:监控读 `GET /api/multitable/automation-executions → listExecutions`(admin 跨规则列表,**非** rule-scoped)。在 **service 方法** `listExecutions`(+ 顺手 `getRecent`)加 `WHERE triggered_by != 'button'`,把按钮行排除出规则监控;`getById`(/:id)**不滤**(按 id 仍可审计);rule-scoped(`getByRule`/stats)天然安全。`triggered_by` 列 `TEXT NOT NULL DEFAULT 'event'` 无 CHECK,接受 'button' 免迁移。
- 测试要点:triggered_by='button' 行**不出现**在 GET /automation-executions,**但**可经 GET /automation-executions/:id 取回。

## 6. 幂等 / requestId(防双发)

- **side-effecting 动作 requestId 必填**(`record_click` 仍可选);可选+未用 = 零保护(正是要防的双击场景)。
- **scoped dedup key** = `actor + sheetId + recordId + fieldId + requestId`(勿全局,免跨 actor 撞)。
- **D6 失败模式(必须选,exactly-once 不可达——emit 与 dedup 写非同事务)**:**锁 at-most-once**(先持久 dedup 行,后 emit;崩溃于两者间则静默漏发)。理由:重复通知比偶发漏发 UX 更差(MVP)。后续写类动作(update_record)可重选 at-least-once。

## 7. 失败语义(3 路,保留路由现状)

- `200 { status:'succeeded' }` = **accepted-for-delivery**(已 emit/enqueue,**非**已送达 —— 见 D0);
- `200 { status:'failed', message }` = 动作校验失败(空 userIds/message 等);
- 非 2xx = 权限/契约/幂等拒绝(`MultitableApiError`,带 status)。
- 审计行**dispatch 后**最佳努力写;但 side-effecting 用 **dedup-before-emit + audit-after**(§6)。**绝不**为审计写失败而把已成功的 emit 报成 500。

## 8. 通道边界

B1-S1 **仅** send_notification(in-app:`automation.notification` + §0 的 sink)。`send_email`(需 `notificationService`,按钮路由现未注入)/ `send_dingtalk_*`(真 egress + 凭据 + 投递记录)= **各自独立的后续动作,出 B1-S1 范围**。

## 9. record_click 不变

继续 inert、`logger.info`-only、requestId 可选、**不写持久行**(持久行是 side-effecting 动作专属;§5 的 `triggered_by != 'button'` 排除 + record_click 根本不写行 → 双重不污染)。

## 10. 可复用样板

本合同(启用=两改 + 校验 dispatch + actor 闸 + 必填 requestId dedup + triggered_by='button' durable audit + confirm 强制 + 3 路失败 + at-most/least-once 显式选择)即后续动作(`update_record` / `send_webhook`)扩展的模板;各动作只换 payload/闸/失败模式,框架不变。

## 11. 实现期验证计划(审过后)

单测 + 真实-PG/HTTP:actor 非授权 → 403;requestId 缺失(side-effecting)→ 拒;同 dedup key 重放 → 单次效果(at-most-once);durable 行落库 + **监控列表排除 / by-id 可取**;confirm enforce(FE);3 路失败语义;(D0-A 则)sink 落库 + 收件可见。`record_click` 回归:仍 inert/logger-only/无行。CI lane 视 sink 的 FE 面而定。

## 12. 落地

本设计锁(docs)→ 评审(**先定 D0 首动作选择 + D6 at-most/least-once + §3 actor 闸(暂定 canEditRecord)+ §3.1 收件人授权**)→ 实现(后端 run 路由启用=两改 + actor 闸 + 收件人约束 + dedup + audit + B1-c config 扩 payload + FE confirm enforce + (D0-A) sink)。B1-e(record drawer)排其后。
