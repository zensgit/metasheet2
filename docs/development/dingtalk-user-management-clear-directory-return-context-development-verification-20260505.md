# DingTalk 用户管理清除目录回跳上下文开发及验证

日期：2026-05-05

## 开发目标

目录同步页返回用户管理后，用户管理页会显示目录回跳或目录定位失败提示。该提示对排查有用，但操作人员完成处理后需要一个显式入口清除回跳上下文，避免 `source/integrationId/accountId/directoryFailure` 长时间挂在 URL 和页面提示上。

## 本次改动

### 1. 用户管理提示条新增清除按钮

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在目录回跳提示条的操作区新增：
  - `清除目录回跳`
- 按钮与已有 `返回目录同步` 并列。

### 2. 新增清除目录回跳上下文逻辑

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `clearDirectoryNavigationContext()`
- 点击后清除：
  - `source`
  - `integrationId`
  - `accountId`
  - `directoryFailure`
- 保留：
  - `userId`
  - 当前业务筛选 `filter`
- 成功后显示：
  - `已清除目录回跳上下文`

## 验证

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 31/31 通过
- `tests/directoryManagementView.spec.ts` 36/36 通过
- 总计 67/67 通过
- 全量 `git diff --check` 通过

说明：
- Vitest 输出中仍有既有 jsdom 提示：
  - `Not implemented: navigation to another Document`
- 该提示来自既有测试环境能力限制，不影响本轮断言结果。

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 从目录页失败回跳用户管理。
- 切换到 `缺 OpenID` 筛选。
- 点击 `清除目录回跳`。
- URL 变为：
  - `?userId=user-2&filter=dingtalk-openid-missing`
- 页面显示：
  - `已清除目录回跳上下文`
- 页面不再显示：
  - `目录定位未完成`
  - 原目录目标上下文
- 当前用户仍保持可见：
  - `Bravo`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-user-management-clear-directory-return-context-development-verification-20260505.md`
