# DingTalk 治理工作台入口开发及验证

日期：2026-05-05

## 开发目标

将用户管理页、目录同步页、审计页三边已经打通的治理 deep link 聚合成固定快捷入口，降低管理员在不同页面之间来回找入口的成本。

## 本次改动

### 1. 用户管理页新增治理工作台

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在用户列表 summary 下新增固定的“治理工作台”快捷卡区域。
- 当前包含 3 张卡：
  - `缺 OpenID 成员`
    - `/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance`
  - `目录同步修复入口`
    - `/admin/directory?source=dingtalk-governance`
  - `最近 7 天收口审计`
    - `/admin/audit?resourceType=user-auth-grant&action=revoke&from=...&to=...`

### 2. 增加目录修复入口链接构造

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `buildDirectoryMissingOpenIdWorkbenchLocation()`
- 统一从用户管理页跳往目录同步治理入口的链接格式。

### 3. 工作台样式补齐

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增工作台卡片样式：
  - `user-admin__workbench`
  - `user-admin__workbench-card`
  - `user-admin__workbench-kicker`
- 移动端下会自动折成单列，避免入口区过挤。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 22/22 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 工作台中的 `缺 OpenID 成员` 链接会指向用户管理缺 OpenID deep link。
- `目录同步修复入口` 会指向目录同步治理入口。
- `最近 7 天收口审计` 会指向最近 7 天的治理审计视图。

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-workbench-development-verification-20260505.md`
