# DingTalk 目录页到用户管理缺 OpenID Deep Link 开发及验证

日期：2026-05-05

## 开发目标

让目录同步页在 `openId` 缺失场景下跳回用户管理时，自动落到同一个治理筛选上下文，而不是只定位到单个用户。

## 本次改动

### 1. 目录页“前往用户管理”在缺 OpenID 场景下追加筛选参数

文件：
- `apps/web/src/views/DirectoryManagementView.vue`

改动：
- 调整 `buildUserManagementLocation()`
- 原本目录页回跳用户管理只带：
  - `userId`
  - `source=directory-sync`
  - `integrationId`
  - `accountId`
- 现在如果目录成员满足 `openId` 缺失且属于钉钉 grant 风险场景，会额外带上：
  - `filter=dingtalk-openid-missing`

这样管理员从目录页进入用户管理后，会直接落到“缺 OpenID”治理视图，而不是回到全量用户列表。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/directoryManagementView.spec.ts` 36/36 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/directoryManagementView.spec.ts`

新增验证：
- 当目录成员缺 `openId` 且页面出现“前往用户管理”按钮时，链接为：
  - `/admin/users?userId=...&source=directory-sync&integrationId=...&accountId=...&filter=dingtalk-openid-missing`
- 其余已有“前往用户管理”链接回归测试继续通过，说明普通目录回跳未被破坏。

## 产出文件

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`
- `docs/development/dingtalk-directory-to-user-missing-openid-deeplink-development-verification-20260505.md`
