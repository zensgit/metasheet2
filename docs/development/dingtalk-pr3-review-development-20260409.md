# DingTalk PR3 审查执行记录

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`  
对比基线：`origin/codex/dingtalk-pr2-directory-sync-20260408`

## 执行命令

```bash
git diff --stat origin/codex/dingtalk-pr2-directory-sync-20260408...HEAD
git diff --name-only origin/codex/dingtalk-pr2-directory-sync-20260408...HEAD
```

## Findings

### 高

1. `packages/core-backend/src/services/NotificationService.ts:77`
   - `postJsonWithRetry()` 只把 `response.ok` 当成成功条件，没有检查钉钉机器人返回 JSON 体里的业务错误码。
   - 钉钉机器人很多失败是 `HTTP 200` 但 `errcode != 0`，例如签名错误、关键词校验失败、频控或 webhook 配置错误。
   - 这会导致 `DingTalkNotificationChannel` 在真实失败时仍返回 `sent`，把通知记录、审计和重试链路都标成成功，线上排障会被误导。

### 中

1. `apps/web/src/views/RoleDelegationView.vue:714`
   - `loadTemplates()` 刷新模板列表后，只在“当前没有选择”时才自动选择第一项，没有处理“当前已选模板已不在筛选结果中”的情况。
   - 结果是页面还能保留并操作一个已经从当前结果集消失的模板，平台管理员可能在搜索后误把隐藏模板继续应用到管理员范围。

2. `apps/web/src/views/RoleDelegationView.vue:840`
   - `loadUsers()` 也没有在筛选结果移除当前成员时清空 `selectedUserId/selectedAccess`。
   - 结果是列表左侧已经不显示该成员，但右侧详情和“分配角色/撤销角色/加入成员集”仍会作用在旧成员上，属于隐藏目标误操作。

## 结论

本轮审查没有再发现新的高危 RBAC 越权点，但仍不建议在修完上述 3 个问题前合并 `PR3`：

1. 通知成功判定问题会直接影响真实钉钉机器人联调和线上告警可信度。
2. 角色委派页的两处失效选择问题会让平台管理员在筛选后继续操作隐藏对象，风险虽然在前端，但足以造成错误授权。

## 文档关联

这轮审查基于以下已有设计/开发文档继续往下看：

1. [dingtalk-pr3-attendance-notify-design-20260408.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/docs/development/dingtalk-pr3-attendance-notify-design-20260408.md)
2. [dingtalk-pr3-attendance-notify-verification-20260408.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/docs/development/dingtalk-pr3-attendance-notify-verification-20260408.md)
3. [platform-member-groups-delegated-scope-design-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/docs/development/platform-member-groups-delegated-scope-design-20260409.md)
4. [platform-member-groups-delegated-scope-development-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/docs/development/platform-member-groups-delegated-scope-development-20260409.md)
