# DingTalk Directory Focus Account Development

日期：2026-04-15

## 目标

把 `DirectoryManagementView` 里的待处理复核项和成员账号列表串起来，补一个更短的人工处理路径：

- 从 review item 直接“定位到成员”
- 自动带着钉钉用户 ID 刷新账号列表
- 在成员区域高亮目标账号
- 复用已有绑定草稿，直接从聚焦卡片执行快捷绑定

## 本次改动

### 前端视图

文件：
- `apps/web/src/views/DirectoryManagementView.vue`

新增能力：
- 成员区 section 增加 `accountsSectionRef`
- 引入 `focusedAccountId` 和 `pendingFocusedAccountScroll`
- review item 点击“定位到成员”后：
  - 把 `accountQuery` 预填为 `externalUserId`
  - 重载成员列表
  - 成功后滚动到高亮成员
- 成员区顶部新增 focus card：
  - 显示当前定位成员
  - 若目标成员仍在当前结果页，允许直接“绑定当前成员”
  - 提供“清除定位”
- 账号卡片增加 `directory-admin__account--focused` 高亮态
- 切换 integration、搜索、分页、调整 page size 时清掉旧的 focus 状态，避免错误残留

### 测试

文件：
- `apps/web/tests/directoryManagementView.spec.ts`

新增内容：
- mock `HTMLElement.prototype.scrollIntoView`
- 新增回归用例：
  - 从 review item 定位成员
  - 断言账号列表按钉钉用户 ID 重载
  - 断言滚动、高亮、focus card 文案
  - 断言可直接从 focus card 触发绑定并刷新结果

## 范围控制

这次只收一个前端 follow-up slice：

- 不改后端 API
- 不改目录 review/batch bind 语义
- 不把主工作区里其他 `directory` 脏改动混进来

## 对 Claude 反馈的核对

本次顺手核对了 Claude 提到的 3 个修复点，结论如下：

- `packages/core-backend/src/routes/dashboard.ts`
  当前 `main` 已是 `async` 路由并包含对应 `await`
- `packages/core-backend/src/routes/automation.ts`
  当前 `main` 已对 `getByRule()` / `getStats()` 使用 `await`
- migration 时间戳冲突
  当前 `main` 已去重为：
  - `zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts`
  - `zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts`

因此这些问题不需要在本 follow-up 分支里重复修复。
