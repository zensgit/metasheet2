# DingTalk 用户管理复制目录回跳链接开发及验证

日期：2026-05-05

## 开发目标

目录同步页返回用户管理后，管理员可能需要把当前目录定位上下文发给其他管理员协同排查。本轮在用户管理页目录回跳提示条中补一个复制入口，直接复制可打开的目录同步链接，减少手工复制 URL 和参数的错误。

## 本次改动

### 1. 目录回跳提示条新增复制按钮

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在目录回跳提示条操作区新增：
  - `复制目录链接`
- 与现有动作并列：
  - `返回目录同步`
  - `清除目录回跳`

### 2. 新增复制目录回跳链接逻辑

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `copyDirectoryReturnLocation()`
- 复制内容为完整绝对 URL：
  - `/admin/directory?integrationId=...&accountId=...&source=user-management&userId=...`
- 成功后显示：
  - `目录回跳链接已复制`
- 失败时显示：
  - 剪贴板异常信息或 `复制目录回跳链接失败`

## 验证

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 32/32 通过
- `tests/directoryManagementView.spec.ts` 36/36 通过
- 总计 68/68 通过
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
- 点击 `复制目录链接`。
- `navigator.clipboard.writeText` 收到完整目录链接：
  - `${window.location.origin}/admin/directory?integrationId=ding-1&accountId=user-2-directory&source=user-management&userId=user-2`
- 当前 URL 不变。
- 页面显示：
  - `目录回跳链接已复制`
- 原目录失败提示仍保留，复制动作不改变当前定位上下文。

## 后续建议

并行只读检查建议的下一步小切片：
- 补齐 `DirectoryManagementView` 的 `清除定位` URL 清理。
- 目标是让目录页成功定位后点击 `清除定位` 时，只保留当前 `integrationId`，清掉 `accountId/source/userId`，避免刷新后再次自动定位。

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-user-management-copy-directory-return-link-development-verification-20260505.md`
