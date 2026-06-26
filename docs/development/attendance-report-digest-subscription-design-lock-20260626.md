# 考勤统计通知订阅 — 设计锁（PROPOSED）

> **Status**: 🟡 **PROPOSED（待 owner 拍板）**。本设计锁把“按日/周/月主动发送考勤统计摘要”收敛成 MetaSheet 自己的契约：订阅配置、周期 producer、C5 outbox、可解释 payload、以及 delivery observability。本文只锁设计，不写运行时代码；实现仍按 RD-1 → RD-5 一刀一 PR。

---

## 1. 背景与现状

当前 main 上已有三块可复用基座：

- **统计读取**：`GET /api/attendance/summary`、`GET /api/attendance/reports/requests`、`GET /api/attendance/payroll-cycles/:id/summary` 已能读个人 / 周期考勤统计事实。
- **通知投递**：C5 `attendance_notification_deliveries` outbox + `AttendanceNotificationDeliveryWorker` 已落；delivery worker 只按 row.channel 路由，当前已有默认工作通知 channel 与 `email_smtp`。
- **调度器**：`AttendanceScheduler` 支持注册 secondary jobs；producer 只能写 outbox row，真实发送只能由 delivery worker 执行。

缺口：没有一个**考勤统计通知订阅**配置，也没有 producer 在每日/每周/每月到点把摘要写入 C5 outbox。现在 admin 能查看 delivery status，但不能让员工或负责人定期收到“今天/本周/本月考勤摘要”。

---

## 2. v1 目标

v1 提供一个小而稳的 report digest 能力：

1. 管理员配置 org-level 订阅：daily / weekly / monthly 开关、发送时间、默认 channel、收件人范围。
2. Scheduler job 到点后，为目标用户计算对应 period 的统计摘要。
3. Producer 只写 C5 outbox rows，带稳定 source_key；不直接调用外部 channel。
4. Delivery worker 继续负责真实发送、retry、失败可见。
5. Admin UI 提供配置卡和只读最近投递状态链接；不提供手动群发按钮。

---

## 3. 配置契约

新增 settings 字段：

```json
{
  "attendanceReportDigestPolicy": {
    "enabled": false,
    "timezone": "Asia/Shanghai",
    "channel": "work_notification",
    "cadences": {
      "daily": { "enabled": true, "sendAt": "18:30", "recipients": ["self"] },
      "weekly": { "enabled": false, "weekday": 1, "sendAt": "09:00", "recipients": ["self", "owner"] },
      "monthly": { "enabled": false, "dayOfMonth": 1, "sendAt": "09:00", "recipients": ["self", "owner"] }
    }
  }
}
```

Normalizer:

- `enabled` 默认 false。
- `timezone` 必须是有效 IANA timezone；enabled=true 时必填。
- `channel` 是品牌无关配置枚举，只允许 `work_notification` / `email_smtp`。默认 `work_notification`。
- producer 写 outbox 前把 `work_notification` 映射到当前 worker 已注册的默认工作通知 channel 常量；配置层不暴露外部品牌命名。
- `sendAt` = `HH:mm`，按 policy timezone 解释。
- `weekly.weekday` ∈ `1..7`，1=Monday。
- `monthly.dayOfMonth` ∈ `1..31`；不存在的日期按当月最后一天发送。
- `recipients` 有限词表：`self`, `owner`, `sub_owner`。v1 默认只发 `self`，manager fan-out 必须显式配置。

默认全关，避免新增 producer 后突然给客户发消息。

---

## 4. Producer 契约

新增 scheduler job：

```ts
resolveAttendanceReportDigestJob()
```

env gate 分层：

```text
ATTENDANCE_SCHEDULER_ENABLED=true
ATTENDANCE_REPORT_DIGEST_ENABLED=true
```

`ATTENDANCE_REPORT_DIGEST_ENABLED` 只控制本 producer 是否注册 / 写 outbox。它不替代共享 scheduler 进程 gate。真实投递仍由既有 C5 delivery worker 控制，需另行满足 `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED=true` 以及对应 channel 的环境配置；RD-5 staging smoke 必须分别证明“producer 写 row”和“worker 可见地发送 / 失败”。

运行口径：

- job 每个 scheduler cycle 只判断“当前分钟是否命中某个 cadence 的发送窗口”。
- 命中后，为 org 内目标用户写 C5 outbox rows。
- source_type: `attendance_report_digest`
- source_id: `orgId:cadence:periodKey`
- source_key: `attendance_report_digest:{orgId}:{cadence}:{periodKey}:{recipientRole}:{recipientUserId}:channel:{deliveryChannel}`
- outbox row 幂等由 `source_key` unique 保护；repeat tick 不重复。幂等粒度包含最终 delivery channel，沿用现有 C5 producer 的 per-channel source_key 习惯，避免 channel 变更时静默复用旧 row。
- producer 不直接发送、不调用 channel SDK。

Period:

- daily: 前一自然日，或 owner 决定是否当天日终。
- weekly: 上一个完整周，默认 Monday-Sunday。
- monthly: 上一个完整自然月。

v1 推荐“完整已结束 period”，避免当天未收盘数据反复变化。

---

## 5. 统计 payload

Payload 应只包含摘要，不嵌大表：

```json
{
  "title": "Attendance daily digest",
  "cadence": "daily",
  "period": { "from": "2026-06-25", "to": "2026-06-25", "label": "2026-06-25" },
  "summary": {
    "totalMinutes": 480,
    "lateDays": 0,
    "earlyLeaveDays": 0,
    "absentDays": 0,
    "leaveMinutes": 0,
    "overtimeMinutes": 60,
    "fullAttendanceEligible": true
  },
  "requestBreakdown": [
    { "requestType": "leave", "status": "approved", "total": 1, "minutes": 240 }
  ]
}
```

Rules:

- summary 事实来自 `loadAttendanceSummary` / existing summary route helper，不重新发明统计口径。
- request breakdown 复用 `/reports/requests` 的 group-by 口径。
- payload 必须小而稳定；详细 records 表不进消息体，只提供 deep link。
- `fullAttendanceEligible` 只有 policy 已开启且 summary 能算出时才出现；不把 absent/leave/overtime 等字段互推。

---

## 6. 目标人群

v1 目标用户来源：

- active `users` + active `user_orgs` member。
- 若未来需要 offboarded historical digest，另起设计。

Recipient roles：

- `self`: 配置层词表；RD-3 producer 写 C5 row 时映射成既有 `recipient_role='subject'`，`recipient_user_id` 为目标员工本人。
- `owner` / `sub_owner`: RD-3 producer 必须自己解析 active attendance group membership + active group manager / sub-manager，再写入具体 `recipient_user_id`。C5 delivery worker 只投递已 materialize 的 row，不做 owner/sub_owner fan-out。
- 目标员工没有 active attendance group 时：`self` 仍可发，`owner` / `sub_owner` 跳过并计入 producer summary，不把整次 digest 判失败。
- 目标员工同时属于多个 active attendance groups 时：RD-3 必须去重 recipient_user_id；同一 recipient 对同一 subject/period/channel 只写一 row。若不同组解析到不同负责人，则分别写 row。
- 解析失败只跳过对应 role，不影响 `self` row。

Scope：

- v1 org-level policy，只按 org 跑。
- per-group / per-department / per-user subscription 是 RD-6 future，不混进 v1。

---

## 7. Admin UI

位置：Attendance admin 的 notification/delivery 区域附近，新增 “统计通知订阅 / Report digest subscription” 配置卡。

控件：

- enabled toggle。
- timezone select/input。
- channel select（只展示可配置 channel 名称，不保证 worker 当前 env 已启用；worker 失败由 delivery status 可见）。
- daily/weekly/monthly 三个 subsection。
- sendAt time input。
- weekly weekday / monthly dayOfMonth。
- recipients checkbox group。

保存：

- 通过现有 `PUT /api/attendance/settings` partial update。
- 客户端做同后端一致的基础校验，但后端 normalizer 是最终权威。

---

## 8. OUT

v1 不做：

- 手动群发 / 立即发送按钮。
- 员工自助订阅管理。
- 每人自定义 cadence。
- 附件、CSV、完整明细表。
- 新通知 channel。
- SMS/电话/原生 push。
- payroll 金额。

这些都是可选后续，不阻塞 v1。

---

## 9. 实现切片

| Slice | 内容 | 合并口径 |
|---|---|---|
| RD-0 | 本设计锁 | docs-only, owner 拍板后 merge |
| RD-1 | latent config + settings PUT/GET round-trip | default-off；invalid timezone/channel/sendAt/recipients 400/422；partial PUT preserves siblings |
| RD-2 | digest period + payload builder | pure tests：daily/weekly/monthly period、month-end clamp、summary/request payload shape |
| RD-3 | scheduler producer + C5 outbox | real-DB tests：source_key idempotency、self→subject mapping、producer-resolved owner fan-out opt-in、zero/multiple group cases、no direct send |
| RD-4 | admin UI config card | web tests：hydrate from settings、invalid sendAt blocks PUT、empty recipients rejected, anchor-nav updated if needed |
| RD-5 | staging smoke runbook | owner-run：enable scheduler + digest producer + delivery worker/channel gates, force/run scheduler tick, delivery row created, worker sends/fails visibly, residue=0 |

---

## 10. 验证矩阵

RD-1:

- full PUT/GET returns complete policy.
- partial PUT toggling enabled does not wipe cadences.
- enabled=true without timezone rejects.
- invalid channel rejects.
- invalid sendAt / weekday / dayOfMonth / recipients rejects.

RD-2:

- daily chooses previous complete day.
- weekly chooses previous complete Monday-Sunday week.
- monthly dayOfMonth 31 clamps to shorter month.
- payload omits large records and includes only summary/request totals.

RD-3:

- scheduler tick when disabled writes zero rows.
- enabled daily writes one self row per active user/org member.
- repeat tick writes zero duplicates.
- source_key includes normalized delivery channel and repeat tick on the same channel writes zero duplicates.
- `self` config writes C5 `recipient_role='subject'`.
- owner/sub_owner rows are resolved by the producer only when configured; worker never resolves those roles.
- missing owner does not fail self row.
- user with zero active attendance group still gets self row and skips owner/sub_owner.
- user with multiple groups deduplicates the same recipient_user_id and writes distinct rows for distinct managers.
- channel value stamped from normalized policy and never interpolated from arbitrary input.

RD-4:

- first screen hydrates from `loadSettings()`.
- save payload preserves unrelated settings.
- failed save does not show stale success.

---

## 11. Owner 拍板问题

1. Period 口径：daily/weekly/monthly 是否都发送**上一个完整 period**？还是 daily 发当天日终？
2. 默认 cadence：daily 是否默认开启（在 policy enabled 后）？weekly/monthly 是否默认关闭？
3. 默认收件人：v1 是否只发 self，owner/sub_owner 必须显式勾选？
4. Channel：v1 是否允许 `email_smtp`，还是先只允许 `work_notification`？
5. UI 是否放在现有 notification delivery 区域旁边，还是放在 report settings 区域？

---

## 12. 当前 grounding

- `AttendanceScheduler` 支持 secondary jobs，且文档约束 producer 只写 outbox。
- `AttendanceNotificationDeliveryWorker` 按 row.channel 路由，当前已有默认工作通知 channel 与 `email_smtp`。
- `GET /api/attendance/notification-deliveries` 是 `attendance:admin` read-only observability。
- `GET /api/attendance/summary` 与 `GET /api/attendance/reports/requests` 已提供 digest 所需统计事实。
- `AttendanceView.vue` 已有 notification delivery admin section，但只有只读投递状态，没有订阅配置。
