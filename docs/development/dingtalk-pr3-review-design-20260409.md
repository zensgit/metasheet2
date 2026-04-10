# DingTalk PR3 审查设计

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`  
对比基线：`origin/codex/dingtalk-pr2-directory-sync-20260408`

## 目标

对 `PR3` 做一轮合并前审查，重点确认这 3 类风险：

1. 钉钉通知、考勤和 staging/ops 改动是否存在明显行为回归。
2. 角色委派、成员组、组织范围模板等新 RBAC 能力是否会越权或泄露不该看的数据。
3. 前端角色委派和用户管理页面在筛选、切换、搜索后，是否会保留失效状态并把操作打到错误目标。

## 审查范围

### 后端

1. [NotificationService.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/services/NotificationService.ts)
2. [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
3. [dingtalk-oauth.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/auth/dingtalk-oauth.ts)
4. [plugin-attendance/index.cjs](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/plugins/plugin-attendance/index.cjs)

### 前端

1. [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)
2. [UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/UserManagementView.vue)

### 配套资产

1. `scripts/ops/*`
2. `docker-compose.app.staging.yml`
3. 本轮新增测试和说明文档

## 审查方法

1. 先看 `PR3` 相对 `#723` 的 diff 面，定位关键文件。
2. 对后端权限链路、前端委派页、通知与 ops 分块审查。
3. 只记录真实行为风险，不记录纯风格问题。
4. findings 按严重度排序，并带文件与落点位置。

## 审查准则

1. 优先看权限提升、数据泄露、错误成功判定、隐藏状态误操作。
2. 如果某条逻辑只能在真实 DingTalk 返回体下暴露，也算有效 finding。
3. 如果风险已被当前测试覆盖并明确兜住，不再重复计为 finding。
