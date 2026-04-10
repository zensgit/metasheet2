# DingTalk PR3 审查修复设计

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 目标

收掉 `PR3` 审查中剩余的 3 个真实问题：

1. 钉钉机器人 `HTTP 200 + errcode != 0` 被误判为发送成功。
2. 角色委派页搜索模板后，如果当前模板已不在结果里，页面仍保留隐藏旧选择。
3. 角色委派页搜索成员后，如果当前成员已不在结果里，右侧详情仍保留旧目标。

## 设计原则

1. 最小修复，不改已有接口形态。
2. 钉钉通知只收紧成功判定，不顺手扩大重试面。
3. 前端搜索刷新后，凡是“已不在当前结果集”的选择，都必须立刻失效。
4. 用回归测试锁住这 3 个问题，避免后续在页面状态管理或通知通道上回退。

## 修复方案

### 1. 钉钉机器人成功判定

在 [NotificationService.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/services/NotificationService.ts) 里：

1. 保留现有 `postJsonWithRetry()` 重试骨架。
2. 给它增加可选 `responseValidator`。
3. 仅在 `DingTalkNotificationChannel` 上挂 `validateDingTalkRobotResponse()`。
4. 当响应 JSON 中 `errcode !== 0` 时，抛 `NonRetryableNotificationError`，结果落成 `failed`，且不误重试。

### 2. 模板失效选择清理

在 [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue) 的 `loadTemplates()` 中：

1. 刷新模板列表后判断当前 `selectedTemplateId` 是否仍存在。
2. 若不存在，则清空：
   - `selectedTemplateId`
   - `selectedTemplate`
   - `selectedTemplateDepartmentId`
   - `selectedTemplateMemberGroupId`
3. 若列表仍有模板，则自动切到首个模板。

### 3. 成员失效选择清理

在同文件的 `loadUsers()` 中：

1. 刷新成员列表后判断当前 `selectedUserId` 是否仍存在。
2. 若不存在，则清空：
   - `selectedUserId`
   - `selectedAccess`
   - `selectedScopeConfig`
   - `selectedRoleId`
   - `selectedDepartmentId`
   - `selectedAudienceGroupId`
3. 若列表仍有成员，则自动切到首个成员。

## 非目标

这轮不做：

1. 钉钉机器人业务错误码的细粒度分类重试。
2. 角色委派页的大范围重构。
3. 新增通用状态机或额外 store。
