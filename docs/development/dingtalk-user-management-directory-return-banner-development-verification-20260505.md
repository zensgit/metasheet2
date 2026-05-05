# DingTalk 用户管理目录回跳提示条开发及验证

日期：2026-05-05

## 开发目标

补齐目录同步页返回用户管理后的上下文提示。目录页已经会把 `userId`、`integrationId`、`accountId` 和 `directoryFailure` 带回用户管理页，但用户管理页此前只消费 `userId/source/filter`，操作人员无法直接看出这次回跳来自哪个目录成员，也看不到目录定位失败原因。

## 本次改动

### 1. 用户管理读取并保留目录回跳参数

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 扩展 `InitialUserNavigation`：
  - `integrationId`
  - `accountId`
  - `directoryFailure`
- `readInitialUserNavigation()` 读取上述 query。
- `buildUserNavigationKey()` 纳入上述字段，避免同一用户不同目录上下文被误判为已处理。
- `buildUserLocation()` 在切换筛选时保留目录回跳上下文。

### 2. 新增目录回跳 / 失败提示条

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 当 `source=directory-sync` 时显示来源提示条：
  - 普通回跳：`目录同步回跳`
  - 失败回跳：`目录定位未完成`
- 支持失败原因：
  - `missing_integration`：未找到目标目录集成
  - `missing_account`：未找到目标目录成员
- 显示目标目录上下文：
  - `目标集成`
  - `目标成员`
- 提供 `返回目录同步` 链接，回到：
  - `/admin/directory?integrationId=...&accountId=...&source=user-management&userId=...`

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 30/30 通过
- `tests/directoryManagementView.spec.ts` 36/36 通过
- 全量 `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 普通目录回跳：
  - 自动定位用户
  - 显示 `目录同步回跳`
  - 显示目标集成和目标成员
  - `返回目录同步` 链接带回 `integrationId/accountId/source=user-management/userId`
- 目录成员缺失回跳：
  - 显示 `目录定位未完成`
  - 显示 `未找到目标目录成员`
  - 仍保留当前用户详情上下文
  - `返回目录同步` 链接可回到原目录定位入口
- 目录集成缺失回跳：
  - 显示 `目录定位未完成`
  - 显示 `未找到目标目录集成`
  - 仍保留当前用户详情上下文
  - `返回目录同步` 链接可回到原目录定位入口
- 切换治理筛选：
  - 保留 `userId/source/directoryFailure/integrationId/accountId`
  - 追加 `filter=dingtalk-openid-missing`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-user-management-directory-return-banner-development-verification-20260505.md`
