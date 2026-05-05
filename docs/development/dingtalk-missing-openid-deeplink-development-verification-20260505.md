# DingTalk 缺 OpenID 筛选 Deep Link 开发及验证

日期：2026-05-05

## 开发目标

把用户管理页的 `缺 OpenID` 治理筛选做成可直接分享和复用的 deep link，让用户管理、目录同步、审计治理三边的入口能够围绕同一个问题视角联动。

## 本次改动

### 1. 缺 OpenID summary 卡片改为 deep link 入口

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 将顶部 summary 中的 `缺 OpenID` 指标改成可点击卡片。
- 链接目标为：
  - `/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance`

### 2. 用户管理页支持从 URL 回填筛选

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 扩展用户管理页导航状态，支持解析和持久化 `filter` 参数。
- 新增 `normalizeUserListFilter()`，只接受受支持的筛选值。
- 首次加载 `/admin/users?filter=dingtalk-openid-missing` 时，会直接进入“缺 OpenID”筛选视图。

### 3. 页内切换筛选时同步回 URL

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 监听 `userListFilter` 变化。
- 当管理员在页面内点击“缺 OpenID”等筛选按钮时，地址栏会同步更新 query。
- 这样当前治理视角可以直接复制给其他管理员使用。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 21/21 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- `缺 OpenID` summary 卡片链接到可分享的 deep link。
- 首次打开 `/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance` 时，会直接只显示缺 OpenID 用户。
- 在页内点击 `缺 OpenID` 筛选按钮后，地址栏会同步更新为：
  - `?filter=dingtalk-openid-missing`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-missing-openid-deeplink-development-verification-20260505.md`
