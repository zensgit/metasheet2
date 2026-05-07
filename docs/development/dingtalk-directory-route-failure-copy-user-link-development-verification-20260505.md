# DingTalk 目录失败定位复制用户链接开发及验证

## 开发目标

- 在目录同步页面的“定位未完成”提示条中补充失败场景下的协作能力。
- 当目录页因为 `missing_integration` 或 `missing_account` 无法完成从用户管理页带来的定位时，管理员除了点击 `返回用户管理`，还应该能直接复制精确的用户管理回跳链接发给其他管理员。
- 复制行为不能破坏当前失败定位上下文。

## 本轮实现

### 1. 失败提示条增加复制入口

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在 `routeNavigationFailureNotice` 提示条中，如果已有 `routeNavigationFailureUserManagementLocation`，则新增 `复制用户链接` 按钮。

### 2. 新增失败回跳复制逻辑

- 新增 `copyRouteNavigationFailureUserManagementLocation()`
- 逻辑：
  - 复用已有 `routeNavigationFailureUserManagementLocation` 计算结果。
  - 浏览器环境下转成绝对 URL。
  - 调用 `navigator.clipboard.writeText(...)` 写入剪贴板。
  - 成功时提示 `失败回跳用户链接已复制`。
  - 失败时提示 `复制失败回跳用户链接失败` 或具体异常。

### 3. 补齐缺成员失败场景测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在 `missing_account` 场景中新增断言：
  - 失败提示条存在 `复制用户链接`。
  - 点击后会复制带 `directoryFailure=missing_account` 的绝对用户管理 URL。
  - 当前目录页查询参数保持不变。
  - 页面仍处于失败定位上下文。

## 验证命令

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --watch=false
git diff --check
```

## 验证结果

- `directoryManagementView.spec.ts` 37/37 通过
- `userManagementView.spec.ts` 32/32 通过
- 总计 69/69 通过
- `git diff --check` 通过

## 结果

- 目录页现在在成功定位和失败定位两种上下文里都支持复制精确用户管理链接。
- 管理员在“找不到目标成员/集成”的排查过程中，不需要自己拼接 URL，就能把准确回跳链接转交给协作者。
