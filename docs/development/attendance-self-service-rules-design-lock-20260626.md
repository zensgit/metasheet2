# 考勤员工端规则透明度 — 设计锁（PROPOSED）

> **Status**: PROPOSED（2026-06-26）。本设计锁只锁定员工端“我的考勤规则”只读解释面：让员工能看到自己当前适用的考勤组、班次/规则摘要、打卡与补卡相关约束的可见摘要。本文不写运行时代码；后续仍按 SR-1 → SR-3 一刀一 PR。

---

## 1. Grounding（当前 main）

当前代码已有以下事实：

- 员工端 self-service overview 已存在，包含 `My status`、`My request status`、`Quick actions`、`Status guide` 等卡片；之前的 self-service workbench 文档也明确该线主要是工作台体验，不改后端契约。
- `platform` / `attendance` 模式下普通员工已经具备自助所需的 `attendance:read` / `attendance:write` / `attendance_employee` 角色回填，员工可以查看自己的考勤数据并提交申请。
- `GET /api/attendance/effective-calendar` 已支持 `attendance:read`，但它是日历解析结果，不是“我适用哪些规则”的稳定说明面；且 `userId` 模式允许有权限的人查他人，不适合作为员工端规则卡的直接契约。
- `GET /api/attendance/settings` 是 `attendance:admin`，返回完整 admin settings；它不能暴露给员工端，也不能被前端拿来裁剪。
- `punchPolicy` 已在 settings 中落地：未排班打卡策略、内外勤卡合并、外勤审批配置均有后端/UI。员工端目前没有一个只读面解释“我这里为什么允许/阻止/需要审批”。
- 当前通用 `getOrgId(req)` 会读取 body/query/header 的 org override；`/me` endpoint 不能使用这个 helper 作为 org 真值，否则会破坏 token-org 锁定。
- `makeupPunchPolicy` 仍处于设计锁提案阶段；若后续落地，它也只能作为“可见摘要”进入本面，不能让本面提前承诺未合入的运行时能力。

结论：SR v1 不应复用 admin settings，也不应让员工端拼接多个管理接口；应新增一个 token-subject locked 的只读 read model，返回可展示、非敏感、可解释的“当前适用规则摘要”。

---

## 2. 目标与非目标

### v1 目标

1. 新增员工端只读 endpoint，推荐路径：`GET /api/attendance/rules/me`。
2. Endpoint 只读取当前 token subject 与 token org，不接受 `userId` / `orgId` / `groupId` 查询参数改变 subject。
3. 返回一个非敏感 rule summary：
   - 当前考勤组 / 排班组摘要（多 membership 时 fail-visible，不任意挑一条）；
   - 当前对该用户/日期真正参与计算的 runtime rule profile；
   - 班次窗口、时区、工作日、迟到/早退宽限、严重迟到/旷工迟到阈值；
   - org-level 未排班打卡、外勤审批、内外勤卡合并等 punch policy 的可见摘要；
   - 已落地的余额/申请入口链接状态可作为 action hints，但不重复返回余额 ledger。
4. 员工端 self-service overview 新增“我的考勤规则 / My attendance rules”卡片，解释当前规则与下一步入口。
5. 对缺配置 / 无分组 / 默认规则回退保持 fail-visible：显示 fallback 来源，不静默伪装成“已配置”。

### OUT

- 不开放 admin settings 给员工端。
- 不返回原始 settings JSON、完整 geofence 坐标、Wi-Fi/IP/device allowlist、approval graph、approval flow internals、secret-like 配置。
- 不做跨员工查询；管理员查看他人规则另起 admin endpoint。
- 不在 SR v1 里实现补卡规则、提醒、打卡策略运行时；本线只读解释。
- 不改变 `effective-calendar` 的现有 RBAC 语义。

---

## 3. Endpoint 契约

推荐路径：

```http
GET /api/attendance/rules/me
```

权限：

- `withPermission('attendance:read')`。
- `requesterId = getUserId(req)` 必须存在，否则 401。
- `tokenOrgId` 必须来自 token/context（例如 `req.user?.orgId ?? req.user?.workspaceId`，或后续封装出的 token-only org helper）。SR-1 **不得**调用会读取 body/query/header 的通用 `getOrgId(req)`。
- 若 query/body/header 提供 `userId`、`orgId`、`groupId`、`x-org-id` 之类 subject/org override，v1 推荐直接 400 `ATTENDANCE_RULES_ME_SUBJECT_OVERRIDE_UNSUPPORTED`，而不是忽略；这样能把 spoof 测试锁清楚。

返回 shape（示意，字段名以后端 slice 定稿为准）：

```json
{
  "ok": true,
  "data": {
    "userId": "u_123",
    "orgId": "org_123",
    "resolvedAt": "2026-06-26T00:00:00.000Z",
    "resolvedForDate": "2026-06-26",
    "assignment": {
      "attendanceGroups": [
        {
          "id": "group_1",
          "name": "上海门店 A",
          "code": "sh-a",
          "type": "scheduled_shift"
        }
      ],
      "scheduleGroups": [
        {
          "id": "schedule_group_1",
          "name": "早晚班排班组",
          "effectiveFrom": "2026-06-01",
          "effectiveTo": null
        }
      ],
      "source": "direct_group_membership"
    },
    "runtimeRule": {
      "source": "resolve_work_context",
      "name": "早班",
      "timezone": "Asia/Shanghai",
      "workStartTime": "09:00",
      "workEndTime": "18:00",
      "workingDays": [1, 2, 3, 4, 5],
      "lateGraceMinutes": 5,
      "earlyLeaveGraceMinutes": 5,
      "severeLateThresholdMinutes": 30,
      "absenceLateThresholdMinutes": 60
    },
    "configuredGroupRule": {
      "id": "rule_set_1",
      "name": "门店规则集",
      "enforcement": "not_user_calc_chain"
    },
    "punchPolicy": {
      "source": "org_settings",
      "unscheduledMode": "allow",
      "outdoorApprovalRequired": false,
      "outdoorNoteRequired": false,
      "merge": {
        "internalWinsOnIn": false,
        "externalWinsOnOut": false
      }
    },
    "availability": {
      "canSubmitAttendanceRequests": true,
      "requestCenterActions": [
        "leave",
        "overtime",
        "missing_punch",
        "shift_swap"
      ]
    },
    "warnings": []
  }
}
```

### 可见信息白名单

SR-1 必须用显式白名单构造 response，不允许 `...settings` / `...rule` 原样透传。

允许展示：

- group/schedule group 的 id/name/code/type 与 schedule membership 生效窗口；
- 规则的工作时间窗、时区、工作日、宽限/分级阈值；
- punch policy 的 org-level 布尔/枚举摘要，仅限 `unscheduled.mode`、`merge.internalWinsOnIn`、`merge.externalWinsOnOut`、`outdoor.requireApproval`、`outdoor.requireNote`；
- “需要审批”这类状态。

禁止展示：

- geofence 坐标、多边形、半径、设备/Wi-Fi/IP allowlist；
- approval flow graph / node / approver internals；
- `approvalFlowId`、`outdoor.requirePhoto`（当前 wire 未开放）、raw photo / device proof 字段；
- integration tokens、channel config、SMTP/IM/webhook 之类外发配置；
- 任何 admin-only raw JSON。

---

## 4. 解析语义

### 4.1 Subject 与 org

SR-1 的 read model 只解析当前 token user 在当前 token org 下的规则。若用户不属于当前 org：

```json
{ "code": "ATTENDANCE_RULES_ME_USER_NOT_IN_ORG" }
```

状态码推荐 404，避免向普通员工暴露 org membership 细节。

### 4.2 当前 runtime profile

v1 必须返回“当前用户/日期实际参与打卡、记录计算的 runtime profile”，而不是把管理端配置直接当成已执行规则。当前代码里 per-user punch/records 走 `resolveWorkContext` 的 shift / rotation / default rule 链；group rule-set 主要用于 group-mode effective-calendar，不等同于 user calc chain。

SR-1 口径：

1. 找当前用户在 token org 内的 active attendance group memberships；多条时全部列出并给出 `MULTIPLE_ATTENDANCE_GROUPS` warning，不能任意挑一条作为唯一真值。
2. 找当前用户在 `resolvedForDate` 有效的 schedule group memberships；按 date window 过滤，多条 overlap 时全部列出并给出 `SCHEDULE_GROUP_WINDOW_OVERLAP` / `MULTIPLE_SCHEDULE_GROUPS` warning。
3. 调用或复用与 `resolveWorkContext` 一致的 runtime 规则解析，返回 `runtimeRule`。
4. 若 group 上配置了 rule set，但当前 user calc chain 不使用它，可作为 `configuredGroupRule` 展示，并标记 `enforcement: "not_user_calc_chain"`；同时给出 `GROUP_RULE_SET_PREVIEW_DIVERGENCE` warning，直到另一个切片真正完成 calc-chain cutover。
5. 若没有分组或规则，返回 fallback：
   - `assignment.source = "none"` 或 `"default_rule"`;
   - `warnings[]` 包含 `NO_ATTENDANCE_GROUP` / `DEFAULT_RULE_FALLBACK`；
   - 不 500，不伪造具体配置。

### 4.3 生效日期

v1 endpoint 默认以 `today`（org/rule timezone）解析当前规则。可以接受可选 `asOf=YYYY-MM-DD` 用于员工查看某日规则，但必须：

- 日期严格校验；
- 范围上限，例如仅允许今天前后 31 天；
- 仍只查自己；
- 前端 v1 可先不暴露日期切换。

若不加 `asOf`，后端仍应在 response 里返回 `resolvedForDate`，避免“当前规则”含糊。

---

## 5. 前端卡片

新增 self-service card：

```html
<div class="attendance__card attendance__card--selfservice" data-selfservice-card="rules">
```

推荐位置：`My status` 之后、`Quick actions` 之前。理由：

- 先看今天状态；
- 再理解为什么这些规则适用；
- 然后执行请假/补卡/加班等动作。

卡片内容：

- 当前考勤组 / 排班组；
- 工作时间窗 + 时区；
- 工作日摘要；
- 迟到/早退宽限与严重/旷工阈值；
- 打卡策略摘要（未排班、外勤审批、内外勤合并）；
- warnings：无分组、默认规则回退、规则未配置。

交互：

- 只读，无保存按钮；
- “去申请中心”按钮只跳已有 Request Center / quick actions，不新增写路径；
- load 开始时清空旧规则数据，失败时不保留上一个用户/上一次响应的卡片内容（沿用 L5a stale-balance 教训）。

---

## 6. 测试锁

### SR-1 后端

真实 DB integration 必须覆盖：

1. token user 成功读取自己的规则摘要；
2. `?userId=other` / body userId / spoof user header 不改变 subject，并按 v1 口径 400；
3. `?orgId=other` / body orgId / `x-org-id` 不改变 org，并按 v1 口径 400；测试必须证明 SR-1 没有调用通用 `getOrgId(req)`；
4. 非 org 成员返回 404 或等价 fail-closed 错误；
5. response 不包含 raw settings 敏感键（至少断言不含 geofence 坐标、approval graph、approvalFlowId、integration config）；
6. 无 group / default fallback 时 fail-visible；
7. 多 attendance group、多 schedule group、schedule group 生效窗口 overlap 都 fail-visible；
8. group rule-set 与 runtime calc chain 不一致时，返回 `configuredGroupRule.enforcement = "not_user_calc_chain"` 与 `GROUP_RULE_SET_PREVIEW_DIVERGENCE`；
9. punch policy 摘要只返回白名单字段，并标记 `source = "org_settings"`。

### SR-2 前端

Web spec 必须覆盖：

1. 卡片首次进入 self-service overview 即加载，不依赖点击；
2. 成功响应渲染 group/rule/punch summary；
3. 失败/重新加载时同步清空旧数据，不显示 stale rules；
4. warnings 渲染；
5. 不出现 admin-only raw keys。

如果新增 self-service card 会影响已有 card 计数或 anchor/nav guard，必须同 PR 更新对应 spec。

---

## 7. 切片计划

| Slice | 内容 | 口径 |
|---|---|---|
| SR-0 | 本设计锁 | docs-only，PROPOSED，等待 owner 拍板 |
| SR-1 | `GET /api/attendance/rules/me` | token-subject locked、白名单 response、真实 DB 反向测试 |
| SR-2 | self-service “我的考勤规则”卡片 | 只读 UI、stale-data regression、typecheck/web specs |
| SR-3 | staging smoke | employee token → card/API → no residue；不需要 admin settings 权限 |

---

## 8. Open decisions

1. Endpoint path：推荐 `GET /api/attendance/rules/me`。
2. 卡片位置：推荐 `My status` 后、`Quick actions` 前。
3. owner/sub_owner 是否展示：推荐 v1 不展示具体负责人姓名，只展示“联系考勤管理员/负责人”；避免把管理范围与人员目录权限混进员工端。
4. `asOf` 是否 v1 开放：推荐 backend 支持可选 `asOf`，frontend v1 先不暴露日期切换。
