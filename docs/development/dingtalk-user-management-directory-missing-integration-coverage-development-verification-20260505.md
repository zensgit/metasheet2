# DingTalk 用户管理目录缺集成回跳覆盖开发及验证

日期：2026-05-05

## 开发目标

继续收口目录同步页返回用户管理的失败定位体验。上一轮已经支持 `missing_account` 和 `missing_integration` 两类失败提示，本轮补齐 `missing_integration` 的用户管理测试覆盖，并确认历史 conflict marker 阻塞已经解除，恢复全量 `git diff --check`。

## 本次改动

### 1. 补齐目录集成缺失分支测试

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增用例：
- `shows a directory failure banner when returning from a missing directory integration`

覆盖场景：
- URL：
  - `/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_integration&integrationId=ding-missing&accountId=user-2-directory`
- 页面显示：
  - `目录定位未完成`
  - `未找到目标目录集成`
  - `目标集成：ding-missing · 目标成员：user-2-directory`
- 仍能定位用户：
  - `已从目录同步定位到用户 Bravo`
- `返回目录同步` 链接：
  - `/admin/directory?integrationId=ding-missing&accountId=user-2-directory&source=user-management&userId=user-2`

### 2. 验证历史 diff check 阻塞已解除

此前全量 `git diff --check` 曾被工作树中已有 conflict marker 阻塞。本轮重新确认：
- 指定历史冲突文件当前无 conflict marker。
- 当前全量 `git diff --check` 已通过。

## 验证

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 30/30 通过
- `tests/directoryManagementView.spec.ts` 36/36 通过
- 总计 66/66 通过
- 全量 `git diff --check` 通过

说明：
- Vitest 输出中仍有既有 jsdom 提示：
  - `Not implemented: navigation to another Document`
- 该提示来自既有测试环境能力限制，不影响本轮断言结果。

## 产出文件

- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-user-management-directory-missing-integration-coverage-development-verification-20260505.md`
