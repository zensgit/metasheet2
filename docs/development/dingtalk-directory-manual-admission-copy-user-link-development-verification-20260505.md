# DingTalk 目录手工创建结果复制用户链接开发及验证

## 开发目标

- 在目录同步页面“最近创建并绑定结果”卡片中补充协作入口。
- 当管理员刚通过目录页手工创建本地用户并完成绑定后，除了点击 `查看本地用户`，还应该能一键复制该用户的精确治理链接，便于转交其他管理员继续处理角色、授权或 openId 治理。

## 本轮实现

### 1. 手工创建结果卡片新增复制按钮

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在 `manualAdmissionResult` 结果卡片中，新增 `复制用户链接` 按钮。
- 该按钮与现有 `查看本地用户` 复用同一条精确用户管理路由。

### 2. 新增复制逻辑

- 新增 `copyManualAdmissionUserManagementLocation()`
- 逻辑：
  - 从 `manualAdmissionResult.userId / accountId / integrationId` 构造用户管理链接。
  - 复用已有 `buildUserManagementLocation(...)`，保持与页面跳转完全一致。
  - 浏览器环境下补全为绝对 URL。
  - 调用 `navigator.clipboard.writeText(...)` 复制到剪贴板。
  - 成功时提示 `创建结果用户链接已复制`。
  - 失败时提示 `复制创建结果用户链接失败` 或具体异常。

### 3. 补齐前端测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在“从成员列表创建并绑定无邮箱用户”用例中增加断言：
  - 成功出现“最近创建并绑定结果”卡片后可点击 `复制用户链接`
  - 剪贴板收到带 `userId/source/integrationId/accountId/filter` 的绝对用户管理链接
  - 页面状态提示变为 `创建结果用户链接已复制`

## 验证命令

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --watch=false
git diff --check
```

## 验证结果

- `directoryManagementView.spec.ts` 37/37 通过
- `userManagementView.spec.ts` 33/33 通过
- 总计 70/70 通过
- `git diff --check` 通过

## 结果

- 目录页手工创建用户成功后，现在可以直接复制该用户的精确治理链接。
- 这样“创建账号”到“继续治理”的衔接不再依赖人工重新搜索用户或手动拼接参数。
