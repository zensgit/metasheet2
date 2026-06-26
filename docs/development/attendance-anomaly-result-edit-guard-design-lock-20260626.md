# 考勤异常结果编辑护栏 — 设计锁（PROPOSED）

> **Status**: 🟡 **PROPOSED（待 owner 拍板）**。本设计锁把“异常考勤结果可人工更正”收敛成 MetaSheet 自己的契约：专用动作、原因/证据、可配置编辑窗口、审计、只通知被影响员工、以及“正常结果不可被改成异常”的 v1 护栏。本文只锁设计，不写运行时代码；实现仍按 AE-1 → AE-4 一刀一 PR。

---

## 1. 背景与现状

当前 main 上的异常面是**只读 + 引导申请**：

- `GET /api/attendance/anomalies` 是 `attendance:read` 只读 route。它从 `attendance_records` 里筛出工作日且 `status` 不在 `normal/off/adjusted` 的记录，并返回 `suggestedRequestType`，前端在 anomalies 表格里只有 `Create request` 操作。
- `AttendanceView.vue` 的异常列表展示日期、状态、warnings、关联申请，并用 `prefillRequestFromAnomaly(item)` 引导补卡 / 时间更正 / 请假申请。
- `attendance_records` 的写入路径集中在 punch/import/auto-absence/approved-request 重算等 upsert helper；没有一个专门的“管理员修改异常结果” route，也没有专门的 edit audit row。

这意味着当前系统能让用户**申请修正**，但没有一个一等化的“管理员已确认并修改这条异常结果”的事实动作。v1 要补的是这个动作本身，而不是把它混进 `/records` 读接口或复用通用申请流。

---

## 2. v1 目标

v1 提供一个小而清晰的“异常结果编辑”能力：

1. 管理员在异常列表中打开一条异常记录。
2. 系统展示可选的目标结果、当前结果、日期、员工、打卡事实和 guardrail copy。
3. 管理员必须填写**修改原因**，可附带**证据引用**。
4. 后端在一个事务内：
   - 锁定目标 `attendance_records` row；
   - 校验组织边界、编辑窗口、状态流、原因/证据；
   - 用专用逻辑更新记录结果与相关 meta；
   - 写入不可变 audit row；
   - enqueue 一条只发给被影响员工的 C5 通知。
5. 前端刷新 anomalies / records / summary，让结果变化可见。

v1 不是批量处理，也不是自由改考勤事实。它只做单条异常记录的、带原因和审计的人工更正。

---

## 3. 核心契约

### 3.1 专用 route，不复用读接口

新增写 route：

```http
POST /api/attendance/anomaly-result-edits
```

建议请求形态：

```json
{
  "orgId": "default",
  "recordId": "uuid",
  "targetStatus": "normal",
  "reason": "员工提交了线下签到凭证，管理员核验后更正。",
  "evidence": [
    { "type": "url", "label": "现场签到照片", "url": "https://..." }
  ],
  "idempotencyKey": "client-generated-key"
}
```

v1 route 权限：

- `withPermission('attendance:admin')`。
- 目标 row 必须满足 `attendance_records.id = recordId AND org_id = orgId`。
- 不新增“组负责人/排班范围管理员”权限；scheduler-scope / group-scope edit 是后续单独设计。v1 先用 attendance admin，避免把结果写权限扩散到不完整的 org-admin 模型。
- `idempotencyKey` **必填**，trim 后 `1..200`。前端可以在打开 modal 时生成，但请求必须携带；缺失返回 `400 VALIDATION_ERROR`，后端不生成随机 key。

### 3.2 状态流

v1 只允许**异常 → 可解释结果**：

- 可编辑来源：`late`, `early_leave`, `late_early`, `partial`, `absent`。
- 不可编辑来源：`normal`, `off`, `adjusted`。
- 目标状态词表：`normal`, `late`, `early_leave`, `late_early`, `partial`, `absent`, `adjusted`。
- `normal → abnormal` 在 v1 明确拒绝：`422 ATTENDANCE_RESULT_EDIT_NORMAL_TO_ABNORMAL_UNSUPPORTED`。

这条护栏是为了防止把本来正常的员工记录改坏。后续如果真的需要“正常改异常”的调查/追责流，必须有单独的设计锁、二次确认和更强 audit。

### 3.3 编辑窗口

新增 bounded config：

```json
{
  "attendanceResultEditPolicy": {
    "enabled": true,
    "editWindowDays": 180,
    "requireReason": true,
    "notifyAffectedEmployee": true
  }
}
```

约束：

- `editWindowDays` 是企业可配置值，v1 默认 180，允许范围建议 `1..366`。
- 窗口按 `work_date` 与 org timezone 的 today 比较。超窗拒绝：`422 ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED`。
- `requireReason` v1 默认 true；如果未来允许 false，也只能隐藏前端必填，不影响 audit row 的 before/after 记录。
- `notifyAffectedEmployee` v1 默认 true；若客户关闭，也必须在 audit row 里记录 `notificationSkippedReason='policy_disabled'`。

### 3.4 原因与证据

原因：

- `reason` 必填，trim 后 `1..500`。
- 永远写入 audit row。

证据：

- v1 不做二进制上传；只接受**证据引用 metadata**，例如 URL / attachmentId / label。
- AE-1 必须新增并测试一个 evidence validator。当前 main 没有 attendance-specific URL allowlist；因此 v1 要么只接受 `attachmentId` / 安全文本 label，要么在 AE-1 同步落一个 HTTPS-only URL allowlist（含长度上限、禁止脚本/HTML、禁止空 host）。不能把任意 URL 字符串直接写入 audit row。
- 未来接入文件上传时，必须先落文件存储与权限设计，不在本锁里顺手做。

### 3.5 记录更新不是裸改 status

实现不能直接 `UPDATE attendance_records SET status = ...` 后结束。原因：

- `attendance_records.meta` 里已有报表分级字段（例如 severe/absence late tiers），如果 late/early metrics 被改动，meta 也必须一致。
- `records` / `summary` / report export 都从同一条 record 读事实。结果编辑必须保持这些 surface 一致。

AE-1 实现应新增一个专用 helper，例如：

```js
applyAttendanceResultEdit(trx, {
  orgId,
  recordId,
  targetStatus,
  reason,
  evidence,
  actorUserId,
  idempotencyKey,
})
```

helper 必须：

- `SELECT ... FOR UPDATE` 锁定 record；
- 读取原始 row 的 before snapshot；
- 按目标状态应用一套显式 normalization 表；
- 如涉及 late/early/work minutes，复用现有 metric/tier 计算能力，或明确写入 overrideMetrics 并重算 meta；
- 写 audit row 后再返回 after snapshot。

---

## 4. 审计与通知

### 4.1 Audit table

新增表建议：

```sql
attendance_record_result_edits (
  id uuid primary key,
  org_id text not null,
  record_id uuid not null,
  user_id text not null,
  work_date date not null,
  before_status text not null,
  after_status text not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,
  actor_user_id text not null,
  idempotency_key text not null,
  notification_delivery_id uuid,
  notification_skipped_reason text,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
)
```

`idempotency_key` 来自请求里的必填 `idempotencyKey`；route 不生成随机 key。表内始终 `NOT NULL`，避免 Postgres nullable unique 的绕过语义。同一 `(org_id, idempotency_key)` 重放必须对比关键字段，完全一致才返回 `alreadyApplied=true`，不一致返回 `409 ATTENDANCE_RESULT_EDIT_IDEMPOTENCY_CONFLICT`。

### 4.2 只通知被影响员工

v1 通知口径：

- source_type: `attendance_result_edit`
- source_id: edit audit id
- recipient_user_id: 目标员工本人
- 不 fan-out 给负责人 / 管理员 / 主管。

如果员工已离职或不再是 active org member：

- edit 仍然可以成功，因为历史记录 correction 不应被 active membership 卡死；
- 通知跳过，并在 audit row 记录 `notificationSkippedReason='recipient_not_active'`。

通知 payload 包含：

- workDate
- beforeStatus / afterStatus
- reason 摘要
- actor display name（若可安全取得）
- deeplink 到员工端记录页（如已有）

---

## 5. 前端 v1

位置：现有 anomalies 表格的 Action 列，包括主 `AttendanceView.vue` surface 和抽出的 `AttendanceRequestCenterSection.vue` surface。两个 surface 都已有 `Create request` / `prefillRequestFromAnomaly(item)` 动作；AE-3 必须同时处理或明确只保留一个 canonical surface，避免一个入口能编辑、另一个入口仍旧只能申请。

新增按钮：

- `Edit result / 修改结果`
- 仅当 row 可编辑时启用。
- 对超窗、来源非异常、权限不足显示 inline disabled copy，不用静默隐藏。

Modal 内容：

- 员工、日期、当前状态、warnings、关联申请状态。
- 目标状态下拉。
- 修改原因 textarea（必填）。
- 证据引用输入（v1 metadata-only）。
- in-DOM confirm panel，confirm 消费打开时的 snapshot，避免打开 confirm 后再改表单造成 TOCTOU。

保存成功后：

- 清空 modal state；
- reload anomalies / records / summary；
- 显示 “已修改并通知员工 / 已修改，通知已跳过：xxx”。

---

## 6. OUT

v1 不做：

- 批量处理异常（另起 batch design-lock）。
- 正常结果改异常。
- 二进制照片上传 / OCR / AI 图片识别。
- 员工自助修改结果。
- 直接编辑原始 punch event。
- 重新结算已关闭 payroll cycle。v1 route 必须先查 `attendance_payroll_cycles`，只要同 org 存在任一 `status IN ('closed','archived')` 且 `work_date BETWEEN start_date AND end_date` 的周期，就返回 `409 ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED`；不要求 settlement row 存在。若周期表不可用，按 DB_NOT_READY/503 fail-closed，不允许绕过。
- 组负责人 / scope-admin 编辑权限。

---

## 7. 实现切片

| Slice | 内容 | 合并口径 |
|---|---|---|
| AE-0 | 本设计锁 | docs-only, owner 拍板后 merge |
| AE-1 | Backend route + audit table + idempotency + record update helper | real-DB route tests：org boundary、window、normal-to-abnormal reject、reason required、idempotency conflict、audit before/after |
| AE-2 | C5 通知 producer | real-DB tests：只给 affected employee、inactive recipient skip、无 manager fan-out |
| AE-3 | Anomalies UI modal | web tests：disabled copy、required reason、confirm snapshot、stale state clear、save reloads anomalies/records |
| AE-4 | Staging smoke runbook | owner-run：edit one anomaly, verify audit, notification, UI refresh, residue=0 |

---

## 8. 验证矩阵

AE-1 必测：

- abnormal `late` → `normal` succeeds, writes audit row, after snapshot matches updated record.
- `normal` source → any abnormal target returns `422 ATTENDANCE_RESULT_EDIT_NORMAL_TO_ABNORMAL_UNSUPPORTED`.
- too-old `work_date` returns `422 ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED`.
- missing/blank reason returns `400 VALIDATION_ERROR`.
- target record from another org returns 404/403 without leaking cross-org details.
- same idempotency key + same payload returns `alreadyApplied=true` and does not double-write audit.
- same idempotency key + different target/status/reason returns 409.
- missing idempotency key returns 400 and writes nothing.
- closed or archived payroll cycle containing `work_date` returns 409 even when no settlement row exists.
- overlapping cycles: any matching closed/archived cycle wins over open cycles and rejects the edit.

AE-2 必测：

- exactly one delivery row for the affected user.
- no delivery row for manager/admin roles.
- inactive recipient skip still preserves edit audit.

AE-3 必测：

- opening an ineligible row shows disabled copy, no POST.
- modal reason required blocks save client-side.
- confirm uses snapshot payload, not live form.
- failed POST does not leave stale success state.

---

## 9. Owner 拍板问题

1. v1 `editWindowDays` 默认是否锁 180 天？是否允许企业改到最多 366 天？
2. v1 目标状态是否允许 `adjusted`？还是只允许改成 `normal`？
3. v1 evidence 是否只接受 attachmentId/文本引用，还是 AE-1 同步落 HTTPS-only URL allowlist？
4. 关闭 payroll cycle 后的历史记录修改：v1 是否一律 409，还是允许但只写 audit、不改 payroll facts？
5. 通知是否可被企业关闭？如果可关闭，是否仍必须在 audit row 记录 skipped reason？

---

## 10. 当前 grounding

- `GET /api/attendance/anomalies`：只读，`attendance:read`，筛异常工作日记录，返回 `suggestedRequestType`。
- `AttendanceView.vue` anomalies 表格：当前 action 是 `Create request`，会调用 `prefillRequestFromAnomaly(item)`。
- `upsertAttendanceRecord` / `computeAttendanceRecordUpsertValues`：集中处理 attendance record 写入、metrics 和 tier meta；结果编辑不能绕过这条一致性能力裸改 status。
- `attendance_notification_deliveries` + C5：已有通用投递表和 worker，可作为 “只通知 affected employee” 的投递底座。
