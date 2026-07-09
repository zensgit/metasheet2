# 考勤审批流·结构化步骤编辑器（档 A1）验证报告 — 2026-07-08

> A1 MERGED `85c232612`（PR #3893）。设计锁:`attendance-approval-flow-editor-a1-design-lock-20260708.md`。
> 双路对抗审阅(owner + opus)逐条闭环。**考勤执行引擎与后端 approval-flow 端点零改动**。

## 1. 交付

考勤 admin「审批流」创建流程从**裸 JSON 文本框**升级为结构化步骤编辑器
（`AttendanceApprovalFlowStepsEditor.vue` + 纯 `attendanceApprovalSteps.ts`):
步骤增删改 + 上下移、审批人用户(目录选择器)、审批角色 chip、保存前预览最终 steps JSON、空审批人警告。
顺带修真 bug:request type 下拉从 6 种补齐为后端全 8 种(**外勤 outdoor_punch / 调度 schedule_dispatch** 原缺失)。

## 2. 边界守住（design-lock 完成口径）

| 项 | 证据 |
|---|---|
| **payload 形状不变** | POST body 仍 `{name,requestType,steps,isActive,orgId}`;`steps` 由 `toApprovalPayloadSteps` 构建,形状同旧;admin-regressions 挂载测试断言 POST body = `{name,requestType,steps:[],isActive}`(mutation 守) |
| **权限端点修正**（owner P2） | approver picker 走 `/api/attendance-admin/users/search`(`rbacGuard('attendance','admin')` = 审批流 CRUD 同权限),不再 `/api/admin/users`(`ensurePlatformAdmin`);委派考勤管理员可用;测试锁"不调平台端点" |
| **request type 补齐** | `ATTENDANCE_APPROVAL_REQUEST_TYPES` = 后端 `REQUEST_TYPES` 8 种;**fixture-sync 测试**锁 FE↔后端相等(防再漏);挂载断言下拉含 outdoor_punch/schedule_dispatch |
| **后端引擎零改动** | 仅改 apps/web/前端 + 测试 + 设计锁;`resolveRequest`/`loadApprovalFlow`/`/approval-flows` 端点未动 |
| **fail-closed 往返** | `normalizeStep`/`toPayloadSteps` 保留编辑器未建模的键(未来 mode/threshold 等)不丢;测试锁 |

## 3. 双路复审逐条闭环

- **owner P2**（authoring 回退:picker 走平台管理员端点）→ 修:endpoint 参数 + 考勤作用域搜索 + 测试。
- **owner P3**（roleDraft 按 index 串步)→ 修:move/remove 清 draft;**测试初版未咬住已坦白,改移动场景重写**,mutation 现红。
- **opus P3-1/P3-2**（死代码:`approvalFlowForm.steps`/`parseApprovalStepsInput`/`formatApprovalSteps` 悬空)→ 清 5 处;
  其他调用点在孤儿 composable `useAttendanceAdminLeavePolicies`(无 importer),不受影响。
- **opus P3-3**（挂载态断言欠账)→ admin-regressions 补断言(下拉含新类型 + 结构化编辑器/预览在 + 旧 textarea 除)。
- opus 复审曾漏 owner 的 P2 权限回退;owner 复审曾漏 opus 的死代码——两路互补,均已并入。

## 4. guard 结果

新 spec `attendance-approval-steps` + `AttendanceApprovalFlowStepsEditor` 接入 attendance-web-guard(双 path 块 + run-list + src 路径)。
web-guard 全套 21 spec / 433+ 绿;`vue-tsc -b` 清。mutation:拆类型补全→fixture-sync 红 / 拆往返保留→红 /
拆 endpoint→P2 测试红 / 拆 clearRoleDrafts→P3(移动)红。

## 5. 界面走查（作者视角;真机目视留部署后）

创建卡:名称 + 8 项类型下拉 + 启用 + 结构化编辑器(每步:第 N 级标题 / ↑↓✕ / 名称 / 用户 chip 列 / 角色 chip 列 / 空审批橙警) + `+添加步骤` + 折叠 `预览步骤 JSON`。手感:从工程师级(手写 JSON)拉到 HR 级(选人/贴标签/预览/红字防坑)。

## 6. 后续

- **A2（gated,等 owner 看 live 后拍)**:考勤引擎加 `direct_manager`/`dept_head`/多级上级 resolver + 运行时兜底语义——
  是**执行语义刀**,独立设计锁 + real-DB/反向测试,不与 A1 收口混。
- **档 B（战略候选,治理门冻结)**:考勤请求发起中央模版 + 审批终态回写闭环。
- A1 落地后部署,建议 owner 在 live 环境目视审批流创建界面手感,再决定 A2。
