# DingTalk 目录页复制用户管理链接开发及验证

## 开发目标

- 在目录同步页面的“当前定位成员”卡片中补充一个对称操作：
  - 管理员已从用户管理页或待处理队列定位到某个目录成员后，除了直接点击“前往用户管理”，还可以一键复制带精确上下文的用户管理链接。
- 复制动作需要满足两个约束：
  - 生成绝对 URL，方便直接发给其他管理员协作排查。
  - 不修改当前目录页的 URL、定位状态或高亮上下文。

## 本轮实现

### 1. 目录页增加复制入口

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在 `focusedAccountId` 对应的定位卡片内，若当前定位成员已绑定本地用户，则新增 `复制用户链接` 按钮。
- 按钮与现有 `前往用户管理` 同时出现，保持操作语义对称。

### 2. 增加复制逻辑

- 新增 `copyFocusedUserManagementLocation()`
- 逻辑：
  - 从 `focusedVisibleAccount.localUser.id` 读取目标本地用户。
  - 复用现有 `buildUserManagementLocation(...)` 生成用户管理相对路径。
  - 在浏览器环境下补全为 `${window.location.origin}` 开头的绝对地址。
  - 调用 `navigator.clipboard.writeText(...)` 写入剪贴板。
  - 成功后显示 `用户管理链接已复制`。
  - 失败时显示明确错误信息。

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 新增用例覆盖：
  - 从用户管理参数自动定位目录成员。
  - 点击 `复制用户链接` 后，校验：
    - 剪贴板收到精确的绝对用户管理 URL。
    - 当前目录页查询参数不变。
    - 页面仍保留“当前定位成员”上下文。
    - 页面状态提示为 `用户管理链接已复制`。

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

- 目录页现在具备与用户页对称的“复制精确回跳链接”能力。
- 管理员可以在目录定位成功后，把用户管理精确链接直接发给协作者，而不会破坏当前目录页上下文。
