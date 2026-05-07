# DingTalk 用户管理复制当前治理链接开发及验证

## 开发目标

- 在用户管理页的“目录同步回跳/目录定位未完成”提示条中补充一个对称能力：
  - 管理员在目录回跳上下文里完成筛查、切换过滤器或检查授权后，可以一键复制当前用户治理链接，直接把完整上下文发给其他管理员。
- 复制结果需要保留当前页的关键上下文：
  - `userId`
  - `source=directory-sync`
  - `directoryFailure`
  - `integrationId`
  - `accountId`
  - 当前筛选 `filter`

## 本轮实现

### 1. 用户管理目录回跳条新增复制入口

- 文件：`apps/web/src/views/UserManagementView.vue`
- 在现有 `返回目录同步 / 复制目录链接 / 清除目录回跳` 之间新增 `复制用户链接` 按钮。

### 2. 新增复制当前治理链接逻辑

- 新增 `copyCurrentUserManagementLocation()`
- 逻辑：
  - 复用现有 `buildUserLocation(userNavigation.value)` 生成当前用户管理相对路径。
  - 浏览器环境下补全为绝对 URL。
  - 调用 `navigator.clipboard.writeText(...)` 写入剪贴板。
  - 成功时提示 `用户治理链接已复制`。
  - 失败时提示 `复制用户治理链接失败` 或具体异常。

### 3. 补齐前端测试

- 文件：`apps/web/tests/userManagementView.spec.ts`
- 新增用例覆盖：
  - 目录回跳上下文存在时切到 `缺 OpenID` 筛选。
  - 点击 `复制用户链接`。
  - 校验复制内容包含完整目录回跳和筛选上下文。
  - 校验当前页面 URL 保持不变。
  - 校验页面仍保留“目录定位未完成”提示和目标标签。

## 验证命令

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 验证结果

- `userManagementView.spec.ts` 33/33 通过
- `directoryManagementView.spec.ts` 37/37 通过
- 总计 70/70 通过
- `git diff --check` 通过

## 结果

- 用户管理页现在也能一键复制“当前精确治理链接”。
- 这样目录页和用户页在双向协作时都能直接转发可复现的精确页面链接，不需要人工拼接参数。
