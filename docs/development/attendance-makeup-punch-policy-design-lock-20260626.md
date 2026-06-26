# 考勤补卡自助与规则强约束 — 设计锁（PROPOSED）

> **Status**: PROPOSED（2026-06-26）。本设计锁只锁定 MetaSheet 自身的补卡规则模型：现有 `missed_check_in` / `missed_check_out` / `time_correction` 申请已经能走审批并在最终通过后写 `attendance_records` + `attendance_events`；缺的是企业可配置的**次数 / 时限 / 类型 / 周期**强约束。本文不写运行时代码，后续仍按 MP-1 → MP-6 一刀一 PR。

---

## 1. Grounding（当前 main）

当前代码已有以下事实：

- `REQUEST_TYPES` 已包含 `missed_check_in`、`missed_check_out`、`time_correction`。
- `POST /api/attendance/requests` 是补卡自助入口之一：使用 `withPermission('attendance:write')`，`userId` 来自 token；当前 generic route 没有 target-user 参数，v1 即 self-service。
- `resolveAttendanceRequestDraft` 已校验三类补卡的基础形状：
  - `missed_check_in` 必须有 `requestedInAt`；
  - `missed_check_out` 必须有 `requestedOutAt`；
  - `time_correction` 至少有一个 `requestedInAt` / `requestedOutAt`；
  - 但今天没有次数、时限、类型、未来日期、周期额度等 policy 检查。
- `findDuplicateAttendanceRequest` 已阻止同一 `org/user/workDate/requestType` 的 pending/approved 重复申请。
- 最终审批通过时，三类补卡会进入 `resolveRequest` 的 final-approval 分支，调用 `upsertAttendanceRecord({ mode:'override', statusOverride:'adjusted' })`，并写 generic `adjustment` 事件。
- Request Center 前端已经有补卡申请 UI；当前异常预填来自 `/api/attendance/anomalies` + Request Center quick action。当前 C5 `unscheduled_reminder` 是未排班提醒，不是补卡来源。未来若新增 HMR（漏打卡提醒）候选/入口，也只能预填，不能授权。

结论：MP v1 应该**复用现有申请与审批写入**，在其前后加一层可配置资格检查与审计快照，不新建“第二套补卡写记录系统”。

---

## 2. 目标与非目标

### v1 目标

1. 增加 dormant `makeupPunchPolicy` 设置，默认 OFF，确保现有客户字节级不变。
2. policy enabled 时，在补卡申请创建/更新时强制校验：
   - 周期内次数上限；
   - 补卡时限；
   - 可补类型；
   - 不允许未来 workDate；
   - reason / attachment 要求。
3. 把最近一次成功 create/update 生效的 policy snapshot 写进 request metadata，最终审批沿用 latest persisted snapshot，避免 policy 改动反向改变 pending 申请。
4. 最终审批仍复用现有 adjusted record + adjustment event 路径；event meta 追加 makeup policy evidence，而不是改记录模型。
5. 当前 anomaly prefill / 未来 HMR reminder 产生的候选/入口不能绕过 policy；它只能预填，不能授权。

### OUT

- 不做任意 DSL / 公式规则。
- 不做弹性打卡“晚到晚走”补卡时间自动顺延。当前代码只有迟到/早退宽限与分级阈值，没有 attendance-scoped flexible punch runtime；该能力归 MP-v2。
- 不做代提交 / admin 代员工补卡。`POST /api/attendance/requests` 是 token-user self-service；但当前 generic `PUT /api/attendance/requests/:id` 可由有 `canAccessOtherUsers` 权限的人编辑他人 pending request。MP-v1 对三类补卡必须拒绝 cross-user PUT，除非先新增 submitter/audit 事实；不能用 target user 冒充“实际补卡人”。
- 不做照片、人脸、设备侧证明。
- 不改变审批流、approval graph、`attendance_records` 一日一行模型。

---

## 3. `makeupPunchPolicy` 配置契约

配置形态沿用已落地的 enum-strict / bounded config 纪律：管理员选词表、数字和开关；非法 supplied 值显式 400；缺省值走默认，不静默吞错。

```json
{
  "makeupPunchPolicy": {
    "enabled": false,
    "timezone": "Asia/Shanghai",
    "cycle": {
      "type": "calendar_month",
      "startDay": 1
    },
    "quota": {
      "maxRequestsPerCycle": 3,
      "countStatuses": ["pending", "approved"],
      "principal": "self_service_user"
    },
    "submitWindow": {
      "unit": "calendar_day",
      "days": 30
    },
    "allowedAnomalyTypes": [
      "missing_check_in",
      "missing_check_out",
      "late",
      "severe_late",
      "absence_late",
      "early_leave"
    ],
    "allowedRequestTypes": [
      "missed_check_in",
      "missed_check_out",
      "time_correction"
    ],
    "requireReason": true,
    "requireAttachment": false
  }
}
```

### 默认 preset

| 字段 | 推荐默认 | 说明 |
|---|---:|---|
| `enabled` | `false` | dormant，不改变现状 |
| `cycle.type` | `calendar_month` | v1 只锁月度周期 |
| `cycle.startDay` | `1` | 允许 1..31；落在短月时按该月最后一天 clamp |
| `quota.maxRequestsPerCycle` | `3` | 允许 1..99；企业可配 |
| `submitWindow.unit` | `calendar_day` | v1 可验、低歧义 |
| `submitWindow.days` | `30` | 允许 0..180；0 = 只能当天 |
| `allowedAnomalyTypes` | 缺卡 + 迟到/严重迟到/旷工迟到 + 早退 | “正常补卡”默认关 |
| `requireReason` | `true` | 低成本审计 |
| `requireAttachment` | `false` | 企业可开 |

---

## 4. 校验语义

### 4.1 适用 request type

Policy enabled 时只约束：

- `missed_check_in`
- `missed_check_out`
- `time_correction`

`leave` / `overtime` / `outdoor_punch` / `shift_swap` / `schedule_dispatch` 不读本 policy。

### 4.2 周期额度

额度主体锁为被补卡的 attendance subject（target `attendance_requests.user_id`），不按 submitter/admin actor 计。`POST` 创建路径是 self-service；`PUT /api/attendance/requests/:id` 当前可跨用户编辑 pending request，因此 MP-v1 对三类补卡的 cross-user PUT 必须 fail-closed（403/422 均可，runtime slice 决定错误码），直到新增 submitter/audit 事实列或专用表。后续若做 admin/delegated submit，必须额外审计实际提交人；v1 先不支持该路径。

计数口径：

- 同 org、同 `user_id`、同 policy cycle、request type 属三类补卡；
- policy cycle 以 `workDate` 在 policy timezone 的本地日期锚定，不以提交时间锚定；
- 只计 `pending` + `approved`；
- `rejected` / `cancelled` 不占额度；
- create 计所有既有行；update 必须排除当前 `request_id`，并按编辑后的 `workDate` / `requestType` 重新评估额度；
- existing duplicate guard 仍保留：同日同 request type pending/approved 只能一条。

超额返回：

```json
{ "code": "MAKEUP_PUNCH_QUOTA_EXCEEDED" }
```

### 4.3 补卡时限

以 policy timezone 的本地日期判定：

- `workDate` 不得大于今天：未来日期返回 `MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED`。
- `submitWindow.unit = calendar_day`：`todayLocalDate - workDate <= days`。
- `workday` 口径不进 v1；它依赖 effective-calendar 逐日计数，另起 MP-v2。

超期返回：

```json
{ "code": "MAKEUP_PUNCH_WINDOW_EXPIRED" }
```

### 4.4 类型限制

类型判定必须来自服务端事实，不能相信前端 anomaly prefill。

推荐映射（注意：一次记录可匹配多个事实，例如 `late_early` 同时匹配 late 与 early_leave）：

| request type | 允许的 anomaly type |
|---|---|
| `missed_check_in` | `missing_check_in` |
| `missed_check_out` | `missing_check_out` |
| `time_correction` | `late`, `severe_late`, `absence_late`, `early_leave`, `normal` |

`normal` 默认关闭；开启后表示允许“正常日修正”，不等于允许未来日期或绕过 quota/window。

服务端判定来源：

- `matchedAnomalyTypes` 是数组，不是单值；
- 从服务端事实派生：`attendance_records.status`（如 `partial` / `late` / `early_leave` / `late_early`）、缺失侧打卡、`lateMinutes`、`earlyLeaveMinutes`、RT-1a 的 `meta.severe_late_count` / `meta.absence_late_count`；
- 若记录不存在但当日应出勤且缺某侧打卡，可判为 missing；
- 当前 `/api/attendance/anomalies` 对 absent 的建议动作偏向请假，不应被补卡 policy 解释成自动可补；
- 无法分类且 policy enabled 时 fail-closed：`MAKEUP_PUNCH_TYPE_NOT_ALLOWED`。

### 4.5 reason / attachment

- `requireReason=true` 且 reason 为空：`MAKEUP_PUNCH_REASON_REQUIRED`。
- `requireAttachment=true` 且 attachmentUrl 为空：`MAKEUP_PUNCH_ATTACHMENT_REQUIRED`。

---

## 5. Policy snapshot 与审批通过

补卡申请每次成功 create/update 时，若 policy enabled 且 request type 属三类补卡，`metadata.makeupPunchPolicySnapshot` 字段必须**替换**为该次写入的 snapshot（不是保留旧 snapshot，也不是在 approve 时重读当前 policy）；不得丢失本次 draft 应保留的 `attachmentUrl` / `approvalFlow` 等 metadata sibling。

```json
{
  "makeupPunchPolicySnapshot": {
    "version": 1,
    "enabled": true,
    "timezone": "Asia/Shanghai",
    "cycle": { "type": "calendar_month", "startDay": 1 },
    "quota": { "maxRequestsPerCycle": 3, "countStatuses": ["pending", "approved"], "principal": "self_service_user" },
    "submitWindow": { "unit": "calendar_day", "days": 30 },
    "allowedAnomalyTypes": ["missing_check_in", "missing_check_out", "late", "severe_late", "absence_late", "early_leave"],
    "requestEvaluatedAt": "2026-06-26T00:00:00.000Z",
    "matchedAnomalyTypes": ["missing_check_in"]
  }
}
```

最终审批：

- 有 snapshot 的请求按 snapshot 审计，不用当前 policy 重新解释；
- 最终审批使用最新持久化 snapshot（last accepted create/update）；
- 无 snapshot 的 pending 行包括 MP 前旧行，以及 policy disabled 时创建/最后编辑的行；approve 时按 legacy/no-policy 处理，不 retro-block，也不重读当前 policy；
- adjusted record 写法保持当前 `upsertAttendanceRecord(... mode:'override', statusOverride:'adjusted')`；
- generic `adjustment` event meta 追加 `makeupPolicySnapshot` 摘要（不要把整份 settings dump 进 event）。

这个口径避免“今天改规则，昨天 pending 的补卡突然被另一套规则拒掉”，也避免 `PUT` wholesale metadata replacement 把旧 snapshot 偷偷丢掉。

---

## 6. HMR reminder 边界

当前 main 没有补卡专用 HMR 后端；已有 C5 `unscheduled_reminder` 是未排班提醒，不是补卡来源。当前补卡预填入口是 `/api/attendance/anomalies` + Request Center quick action。未来若新增 HMR（人工漏打卡提醒），它只负责：

1. 找候选；
2. 入 outbox；
3. 让用户跳到补卡入口。

异常预填 / 未来 HMR 不得：

- 写补卡申请；
- 消耗 quota；
- 豁免 window/type/reason/attachment；
- 将 reminder candidate 当成服务端 anomaly truth。

因此 `/api/attendance/anomalies` 或未来 HMR 入口预填出的请求必须走同一个 `POST /api/attendance/requests` policy helper；若 policy 拒绝，UI 展示同一错误码。

---

## 7. 切片计划

| Slice | 内容 | 验证 |
|---|---|---|
| MP-0 | 本设计锁 | docs-only |
| MP-1 | dormant `makeupPunchPolicy` settings：DEFAULT + normalize + zod + mergeSettings | 真实 PUT→GET full shape；nested deep-merge `cycle` / `quota` / `submitWindow`；arrays 仅 supplied 时替换；partial `{ quota: { maxRequestsPerCycle } }` 保留 `countStatuses/principal`；partial `{ submitWindow: { days } }` 保留 `unit`；`enabled=true` 时 invalid IANA timezone 400；非法 supplied 值 400 |
| MP-2 | create/update policy helper：quota/window/type/future/reason/attachment | real-DB route tests：disabled byte-identical；enabled 拒超额/超期/未来/类型不符；duplicate guard 不退化 |
| MP-3 | request metadata snapshot + final approval audit meta | final approve 仍写 adjusted record；legacy pending grandfather；event meta 有 policy evidence |
| MP-4 | admin config UI | settings card + client guard；anchor/web guard 若新增 section 同步 |
| MP-5 | Request Center UX：错误码、quota/window 提示、HMR prefill 走同一路径 | 前端回归：prefill 后提交被 policy 拒绝时不展示成功态 |
| MP-6 | staging smoke | quota/window/type/anomaly-prefill/approval adjusted record/residue=0 |

MP-1/MP-2 可以独立设计；MP-5 先接现有 `/api/attendance/anomalies` + Request Center quick action，若未来 HMR UI 入口落地，再追加同路径回归。

---

## 8. 验收用例

1. Policy disabled：现有补卡申请与审批路径行为不变。
2. `maxRequestsPerCycle=1`：同周期第二个补卡申请返回 `MAKEUP_PUNCH_QUOTA_EXCEEDED`；reject 第一条后再提交可过。
3. `submitWindow.days=0`：昨天的 workDate 返回 `MAKEUP_PUNCH_WINDOW_EXPIRED`；今天可过。
4. future workDate 返回 `MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED`。
5. 仅允许 `missing_check_in`：迟到修正返回 `MAKEUP_PUNCH_TYPE_NOT_ALLOWED`。
6. `requireReason=true`：空 reason 返回 `MAKEUP_PUNCH_REASON_REQUIRED`。
7. `/api/attendance/anomalies` prefill（以及未来 HMR prefill）的 missed-check-in 请求仍被同一 quota/window/type helper 拦截。
8. 审批通过后 record = adjusted，event = adjustment，metadata 中可追到 `makeupPunchPolicySnapshot.matchedAnomalyTypes`。
9. Policy 改动后，已有 snapshot 的 pending request 最终审批仍使用 latest persisted snapshot。

---

## 9. 待 owner 拍板

1. **默认 quota**：推荐 `3 / cycle`，范围 1..99。是否接受？
2. **默认 window**：推荐 `30 calendar days`，范围 0..180。是否接受？
3. **cycleStartDay**：推荐支持 1..31，并在短月 clamp 到月末。是否接受？
4. **quota status**：推荐只计 `pending` + `approved`，rejected/cancelled 释放额度。是否接受？
5. **normal 修正**：推荐默认关闭。是否接受？
6. **delegated/admin 代提交**：推荐 v1 OUT，因现表无法审计实际提交人。是否接受？
7. **workday window / 弹性晚到晚走**：推荐 MP-v2，不混入 v1。是否接受？
