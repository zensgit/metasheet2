# DingTalk 目录页清除定位上下文开发及验证

日期：2026-05-05

## 开发目标

用户管理页可以跳到目录同步页并自动定位某个目录成员。此前目录页成功定位后点击 `清除定位` 只清本地高亮，不清 URL 中的 `accountId/source/userId`，刷新或复用链接时仍会再次自动定位。本轮让成功定位的清理行为和失败定位的清理行为对齐：保留当前目录集成，清除具体成员定位上下文。

## 本次改动

### 1. 成功定位后清除 URL 定位上下文

文件：
- `apps/web/src/views/DirectoryManagementView.vue`

改动：
- 将 focus card 的 `清除定位` 从 `clearFocusedAccount()` 切到：
  - `clearFocusedAccountAndDirectoryNavigation()`
- 点击后清除：
  - `accountId`
  - `source`
  - `userId`
- 保留：
  - 当前 `integrationId`
- 成功后显示：
  - `已清除目录定位上下文`

### 2. 失败定位清理同步本地 navigation key

文件：
- `apps/web/src/views/DirectoryManagementView.vue`

改动：
- `clearFailedDirectoryNavigation()` 现在显式构造 `nextNavigation`。
- 同步更新：
  - `directoryNavigation.value`
  - `appliedDirectoryNavigationKey.value`
- 再执行 `replaceDirectoryNavigation(nextNavigation)`。
- 这样清除失败定位不依赖 `replaceState` 事件回流来更新本地状态。

## 验证

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/directoryManagementView.spec.ts` 36/36 通过
- `tests/userManagementView.spec.ts` 32/32 通过
- 总计 68/68 通过
- 全量 `git diff --check` 通过

说明：
- Vitest 输出中仍有既有 jsdom 提示：
  - `Not implemented: navigation to another Document`
- 该提示来自既有测试环境能力限制，不影响本轮断言结果。

### 本次新增覆盖

文件：
- `apps/web/tests/directoryManagementView.spec.ts`

新增/扩展验证：
- 从用户管理进入目录页：
  - `/admin/directory?integrationId=dir-1&accountId=account-focus&source=user-management&userId=user-1`
- 页面自动定位成员：
  - `已从用户管理定位到目录成员 定位成员`
  - `当前定位成员：定位成员`
- 点击 `清除定位` 后：
  - URL 变为 `?integrationId=dir-1`
  - 显示 `已清除目录定位上下文`
  - focus card 消失
  - `.directory-admin__account--focused` 高亮消失

## 产出文件

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`
- `docs/development/dingtalk-directory-clear-focused-return-context-development-verification-20260505.md`
