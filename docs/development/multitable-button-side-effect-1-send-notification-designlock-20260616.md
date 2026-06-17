# 多维表 Button 副作用动作 #1 — send_notification — 设计锁 D0-A — 2026-06-16

> Status: **DESIGN-LOCK → 已实现(IMPLEMENTED,经 owner 安全复审重做)**。承接 `multitable-button-field-b1s0-designlock-20260615.md`(B1-S0 inert `record_click` 已落地)。
> 范围:button 字段的**第一个有副作用动作** `send_notification` —— 写入通知中心(durable in-app notification)。
> 一句话:把"按钮点击"从"零副作用审计"升级为"对**经服务端硬校验**的收件人产生一条**可持久化**的站内通知",并把**服务端确认 / 持久化审计 / 幂等 / 收件人硬拒**一并锁死成**一个全成功或全失败的路由级副作用事务**。

## 0. D0 决策(已定:**D0-A**)+ 复审重做的架构基线

B1-S0 §0 标记了一处前提缺口(premise-break):`executeSendNotification` 当时**只 `eventBus.emit`**,没有任何持久化写,也没有生产侧订阅者 —— 即"看似能发通知,实则没有落地"。

**D0 决策 = D0-A:第一个副作用动作就是 `send_notification`,且它必须把通知作为一条 durable 行写入通知中心 sink(`meta_record_subscription_notifications`),而不是仅 eventBus。** 半成品状态(能发但无审计 / 有 sink 但按钮不受控 / 收件人不校验)一律不可接受 —— 故迁移 + 写入 seam + Bell 渲染 + 派发/确认/审计/幂等/收件人鉴权**同一个 PR 落地**。

**架构基线(复审重做,REQUEST CHANGES):durable 通知写**不**进 `AutomationExecutor`,而是 `routes/multitable-button.ts` 里一个**路由级专用副作用事务**(`pool.transaction` = 一个 client 的 BEGIN/COMMIT/ROLLBACK),严格按序、全成功或全失败:**服务端确认闸 → actor 编辑闸 → 收件人硬拒 → dedup → 通知行 → 审计行**。无副作用的校验(确认 / actor / 收件人)在**事务开启之前**完成,被拒的 run **不写任何东西**(无通知、无审计、无 dedup marker;requestId 不被消费,后续同 requestId 的合法重试仍发一次)。dedup + 通知 + 审计**在同一事务内**提交;**审计写入失败 = 整个 run 回滚(fail-closed,无"已发未审计"状态)**。

> **规则触发路径不受本 PR 影响**:`executeSendNotification` 对规则路径恢复为**仅 `eventBus.emit`**(不加 durable 写 / 成员过滤 / dedup / button 审计 —— 那会扩大 automation 的行为面,超出 button slice 范围)。durable 路径只活在路由。watcher 通知(`record.updated` / `comment.created`)走的是 `notifyRecordSubscribers`,不受影响(回归测试守住)。§0 标记的前提缺口由**路由的 durable 写**修复,而非共享 executor。

## 1. sink 复用(不另造通知表)

复用既有通知中心 sink 表 `meta_record_subscription_notifications`(迁移 `zzzz20260505103000`)。本 PR 两处 schema 变更:

- 新增可空列 `message text` —— 自定义通知正文;watcher 事件为 NULL。
- 扩展 `event_type` CHECK 接纳 `notification.sent`(保留原有 `record.updated` / `comment.created`)。原 CHECK 为**内联无名约束**(Postgres 自动命名 `<table>_<column>_check`),迁移先 DROP 自动名 + 任何旧的具名约束(幂等),再以**具名约束** `chk_meta_record_subscription_notifications_event_type` 重建,后续扩展稳定。

## 2. 写入 seam(单一 INSERT 之家,无旁路)

把 `notifyRecordSubscribers` 的 INSERT 半边抽成导出函数
`insertRecordSubscriptionNotifications(query, { userIds, sheetId, recordId?, eventType, message?, actorId?, revisionId?, commentId? }) → { inserted }`。

- **忠实超集**:仍携带 `revisionId` / `commentId`,故 `notifyRecordSubscribers` 改指向它后**不回归**(`record.updated` 的 `revision_id` 必须 round-trip)。`message` 是唯一新增列(watcher 路径恒为 NULL)。
- **收件人不在此处鉴权**:seam 只写"被交给它的内容";收件人策略归调用方(button 路由在派发前按成员集过滤)。

## 3. 执行 + 派发(路由级副作用事务,durable 写不进 executor)

- button 路由对 `send_notification`**自己拥有派发**:先做无副作用校验(确认 / actor / 收件人硬拒),再在 `pool.transaction` 内 dedup → 经写入 seam `insertRecordSubscriptionNotifications` 落 durable 行(`eventType='notification.sent'` + `message`)→ 写审计行。`eventBus.emit('automation.notification', …)` 仅在**提交后**触发(绝不在事务内,否则回滚会发幽灵通知;重放跳过)。
- executor 的 `executeSendNotification`**恢复为仅 `eventBus.emit`**(规则路径不变;durable / dedup / 审计都是路由的事,不在共享 executor)。
- 启用动作的"两改陷阱"已处理:`record_click` 的硬编码派发改为按**校验后的 actionType** 派发;`ENABLED_BUTTON_ACTIONS` 升级为 `BUTTON_ACTION_POLICIES`(每动作声明 actor 闸 + `sideEffecting` 标志 + 派发类型;`sideEffecting` 同时驱动 requestId 要求与服务端确认要求)。

### 3.1 收件人鉴权(头号控制)=== 硬拒 ===

`config.userIds` 必须**全部**是 sheet 成员,**服务端在事务开启前校验**,复用 `loadSheetMemberUserIdSet`(与 Person 字段写校验器同一成员集,单解析器无漂移)。**只要任一**配置收件人不是成员 → **硬拒整个 run**(400 `RECIPIENT_NOT_AUTHORIZED`,validation-failed),**什么都不写**(无静默部分投递)。零收件人 / 空 message 同样在事务前 400。硬拒发生在事务前,故被拒的 run **不消费 requestId**。

### 3.2 actor 闸(临时代理)

`send_notification` 以 `canEditRecord` 为闸(provisional proxy:有副作用、对外投递的按钮按"记录编辑类"动作把关,直到有专用 per-action 权限);`record_click` 仍是读闸。actor 闸在事务前,被拒 = 不写。

## 4. 服务端确认 / 硬审计 / 幂等(同一事务,全成功或全失败)

- **服务端确认强制(SERVER GATE)**:请求体新增 `confirmed?: boolean`。当字段 `property.confirm.enabled` **且**动作 side-effecting 时,路由**要求 `confirmed === true`**,否则 400 `CONFIRMATION_REQUIRED` 且**什么都不写**(无通知、无审计、无 dedup) —— "未确认 → 不写"现在是**服务端行为**,直 POST 绕不过去。FE 仍弹 `window.confirm`(确认后 `runButton` 带 `confirmed:true`),但 FE 只是 affordance,**服务端是闸**。
- **硬持久化审计(同事务前置条件)**:路由经 `AutomationLogService.recordWithQuery(txClient, …)` 在**同一事务 client** 上写一条 redacted `multitable_automation_executions`,`triggered_by='button'`(显式,不依赖 executor 的 `'event'` 默认)。`recordWithQuery` 用**与 `record()` 同一组脱敏 helper**(`redactValue`/`redactString`)对 steps / trigger_event / rule_snapshot / error 四条秘密通道脱敏,杜绝脱敏回退;jsonb 列以**脱敏后的 PLAIN 值** `JSON.stringify(...)` + `$n::jsonb` 写入(**不**走 `toPersistedExecutionValues` —— 它把值包成 kysely `RawBuilder`,`JSON.stringify` 会序列化成空 `{}`,致审计内容为空)。**审计写失败 → 抛错 → 整个事务回滚**(通知 + dedup 一并撤销),run fail-closed 返回失败,**绝无"已发未审计"**。button 行**排除**出规则监控读(`listExecutions` + `getRecent` 加 `triggered_by != 'button'`),但 `getById` 仍可取回。审计 `steps` 内容(非仅 `triggered_by`)由 unit + 实库测试 round-trip 守住。
  - INERT `record_click` 是 **logger-only,不写 durable 行**(与 §9 / AUDIT-1 一致):durable `multitable_automation_executions` 行**专属 side-effecting 动作**;把 inert 动作挡在审计表外也让 DF-N1 规则监控面保持干净。(单测断言 record_click run 不触发任何 `multitable_automation_executions` INSERT。)
- **幂等(§6,at-most-once)**:side-effecting 动作**要求 requestId**(`record_click` 仍可选)。dedup key = `JSON.stringify([actor, sheet, record, field, requestId])`(**结构化数组**而非 `|` 拼接 —— requestId 是客户端输入,可能含分隔符,拼接会有 false-replay 风险),存入新表 `multitable_button_run_dedup`(`UNIQUE(dedup_key)`);dedup `INSERT ... ON CONFLICT DO NOTHING` 在**事务内**(通知 + 审计之前)。`rowCount===0` = 重放 → 成功形返回 + **不写第二条通知、不写第二条审计**(单一效果),且**返回原始已 COMMIT 的 executionId**(从 dedup 行的 `execution_id` 取回,可追溯到真实审计行;绝不返回本次新生成的不可追溯 id)。**dedup marker 在事务内**意味着:一个回滚的 run(如审计失败)**不消费 requestId** —— 重试仍发一次。replay 只在**真有一次先前 COMMIT 的效果**时短路。

## 5. 配置 / 渲染(B1-c + Bell)

- B1-c 配置:button 配置新增 `send_notification` 的 `actionConfig {userIds(逗号/成员), message}` 编写(`MetaFieldManager.vue`),保存校验要求 message + 至少一个收件人;其它 action type 的 opaque-actionConfig clobber guard 不变。
- `MetaNotificationBell.vue` 新增 message 渲染路径(`notification.sent` 行展示自定义 message)。
- i18n:typed en+zh,无 dead key;FE 不做权限镜像(服务端把关)。

## 6. 已实现范围(IMPLEMENTED SCOPE)

四块同 PR 落地:

1. **迁移**:`..._add_meta_record_subscription_notification_message.ts`(message 列 + CHECK 扩展,幂等 up/down)+ `..._create_multitable_button_run_dedup.ts`(dedup 表)。
2. **写入 seam**:`insertRecordSubscriptionNotifications`(接受任意 `QueryFn`,可传事务 client)+ `notifyRecordSubscribers` 改指(忠实超集,无回归);序列化 `normalizeEventType` 接纳三种类型 + map `message`;list SELECT 增 `message`。
3. **Bell 渲染**:`notification.sent` 自定义 message 渲染 + typed i18n。
4. **路由级副作用事务**:button 路由 `pool.transaction` 内 dedup → 通知 → 审计;`AutomationLogService.recordWithQuery`(事务版审计,复用 `record()` 脱敏);`executeSendNotification` 恢复 eventBus-only;`triggered_by='button'` 审计排除;at-most-once dedup;收件人**硬拒**;服务端确认闸;FE `confirmed:true` 信号。

## 7. 测试

unit(mock pool / mock query,含**带回滚语义**的 transaction mock):
- **服务端确认**:confirm.enabled + side-effecting + `confirmed` 缺省或 `false` → 400 `CONFIRMATION_REQUIRED`,**无通知、无审计、requestId 不消费**(随后同 requestId + `confirmed:true` 仍发一次)。
- 重复 requestId(同 dedup key,且有先前 COMMIT 效果)→ 通知只写一次 + 不写第二条审计。
- **越界收件人(任一非成员)→ 硬拒整个 run(400 `RECIPIENT_NOT_AUTHORIZED`),什么都不写**。
- **硬审计**:模拟审计 insert 失败 → 通知**不提交**(回滚),run 返回失败(fail-closed)。
- 全成员收件人 → `notification.sent` + message 投递 + 同事务审计行 `triggered_by='button'`。
- Bell 渲染 `notification.sent` 自定义 message;序列化不把它强转 `record.updated`。
- 旧 watcher 通知(`record.updated` 经 `notifyRecordSubscribers`)不回归(seam 重构守住 revision_id round-trip)。
- 持久化审计 `triggered_by='button'`,排除 `listExecutions`/`getRecent`,`getById` 可取回。
- `record_click` 仍 inert(requestId 可选,无 durable 行)。
- FE:`runButton` body 仅在 confirm 时带 `confirmed:true`;onRunButton 取消 = 不调 runButton,确认 = 带 `confirmed:true`。

real-DB integration(`plugin-tests.yml` 实库白名单):全成员投递 + dedup 重放 + `notification.sent` round-trip 跑真实 `UNIQUE(dedup_key)` / `ON CONFLICT DO NOTHING` / 扩展后的 CHECK;**收件人硬拒(非成员)→ 什么都不写**;**§2 硬审计回滚 = 真实事务回滚**(审计抛错 → 通知行确实消失 → 唯有实库能证明,mock 无法回滚自身状态)。mock 无法验证错误列名 / 缺约束 / 被 CHECK 拒的行,实库测试是唯一兜底。

## 8. 排除矩阵(沿用 B1-S0 §2)

本 PR 不动 §2 value-field 排除矩阵 —— `send_notification` 仍是"无值字段 + 点击执行",所有消费字段值的路径继续显式排除 button。
