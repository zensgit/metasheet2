# 考勤通知 DingTalk/WeCom 渠道 — org 无 active integration 终态改 retryable（H1，review #3920 P3-1）design-lock — 2026-07-10
> Status: RATIFIED（口径由 #3920 R4 review 的 P3-1 精确给定，视同已锁；本轮为实现，不含设计裁量）。

## 缺陷
`AttendanceNotificationDeliveryWorker.ts` 的 `DingTalkAttendanceDeliveryChannel.resolveRecipient` / `WeComAttendanceDeliveryChannel.resolveRecipient` 三表 JOIN 0 行分支，把两种不同情形都终态成 `skipped`：
1. 用户未在该 org 下与该 provider 建立 `linked+active` 绑定（`directory_account_links` 缺行）——**正确**，结构性、非故障，重试无意义。
2. 该 org 对该 provider **整体没有** `status='active'` 的 `directory_integrations` 行（被 suspend/重配/删除）——**org 级、通常可恢复的故障**。因为 `skipped` 是终态（`claimDueDeliveries` 只 claim `pending`/`retrying`/过期 `sending`，从不 reclaim `skipped`），该窗口内该 org 的**每一条**通知都会被永久丢弃；即使集成之后恢复 active，已 skip 的行也不会自愈。

## 修法
0 行分支内二次判定——对 `(org_id, provider)` 做一次 `SELECT EXISTS(... status='active' ...)`（仅参数化 `org_id`，provider/status 与主查询一致地用字面量）：
- **存在** active integration → 维持既有行为：`skip: true`，`{dingtalk|wecom}_recipient_not_bound`（byte-identical，未加参数化的字段/含义变化）。
- **不存在** → 返回 `{ ok: false, retryable: true, error: '{dingtalk|wecom}_org_integration_inactive' }`（**不设 `skip`**），worker 按既有 `!failure.retryable && failure.skip` 门禁走 `markRetrying`（未耗尽 `maxAttempts`）→ 集成恢复后下一次轮询自动重新解析、自愈；耗尽后落 `failed`（可见的 dead-letter，而非静默 `skipped`）。
- 二次查询只在 0 行冷路径触发，绑定命中（热路径）不受影响、零额外查询。
- 两个 channel（DingTalk + WeCom）逐字 parity 修改——WeCom 三表 JOIN 是 DingTalk 的字面复制（S4 design-lock G5 既定惯例），此处沿用同一 parity 纪律。

## 四分支表（每 channel）
| 0 行 | org 有 active integration | 结果 | 备注 |
|---|---|---|---|
| 用户未绑定 | 是 | `skip: true`, `retryable: false`, `error='{provider}_recipient_not_bound'` | 行为不变（既有用例覆盖） |
| 用户未绑定 | 否（suspend/删除） | `skip` 不设, `retryable: true`, `error='{provider}_org_integration_inactive'` | **本次新增**：H1 硬化 |
| >1 行（ambiguous） | n/a | `retryable: false`，不 skip，`error='{provider}_recipient_ambiguous'` | 不动（OUT） |
| external_user_id 为空 | n/a | `skip: true`, `retryable: false`，`error='{provider}_recipient_external_user_id_missing'` | 不动（OUT） |

## 测试
- 单测（`tests/unit/attendance-scheduler.test.ts` DingTalk / `tests/unit/attendance-wecom-delivery-channel.test.ts` WeCom）：query stub 按 SQL 内容（含 `directory_account_links` vs 否）判别调用序，覆盖 not_bound(有集成,行为不变) / org_integration_inactive(无集成,新增) 两态；新增用例精确 pin 第二条查询的 SQL 谓词（`provider = '...'`、`status = 'active'`）与参数（仅 `[orgId]`）。
- 集成测试（`tests/integration/attendance-notification-deliveries.test.ts`，真 DB）：新增一条覆盖 DingTalk+WeCom 双 channel，用 `status='suspended'`（非缺行）证明谓词按 status 过滤而非仅存在性；`runBatch()` 精确断言 `{claimed, sent:0, retrying:2, failed:0, skipped:0}`，逐行断言 `status='retrying'`、`last_error='{provider}_org_integration_inactive'`、`claim_worker_id=null`、`next_attempt_at` 非空；两 channel 的 readConfig/fetchAccessToken/send 均断言从未被调用。
- 既有 C5-3（DingTalk）/ S4（WeCom）真实-DB not_bound 用例本就在 org 内插入 `status='active'` integration 行，未做任何改动即继续绿——这是「行为不变」的真实证明，而非重写后再断言。

## OUT（本切片不做）
- `ambiguous`（>1 行）与 `external_user_id_missing` 分支不动——review 原文明确排除。
- 不加 per-org 健康门/告警/仪表盘；本修法只解决终态是否可恢复，不新增可观测性面。
- Email 渠道（`EmailAttendanceDeliveryChannel`）不在本次 review finding 范围内，不动。
- 不改变 `maxAttempts`/backoff 曲线；耗尽重试后仍落既有 `failed` 桶（dead-letter），不新增第三终态。
