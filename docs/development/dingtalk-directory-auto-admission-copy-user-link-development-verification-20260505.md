# DingTalk 目录自动准入复制用户链接开发及验证

## 开发目标

- 补齐目录同步“自动准入临时凭据”链路的协作能力。
- 当无邮箱成员在同步过程中被自动创建为本地用户后，管理员除了拿到登录账号和临时密码，还应该能直接复制该用户的精确治理链接，交给其他管理员继续处理。

## 本轮实现

### 1. 后端补齐自动准入结果上下文

- 文件：`packages/core-backend/src/directory/directory-sync.ts`
- 为 `DirectoryAutoAdmissionOnboardingPacket` 增加：
  - `accountId`
  - `integrationId`
- 在自动准入创建无邮箱用户时，把当前目录成员 ID 和集成 ID 一起返回给前端。

### 2. 前端自动准入结果卡片新增复制入口

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在每个 `autoAdmissionOnboardingPackets` 卡片中新增 `复制用户链接` 按钮。
- 新增 `copyAutoAdmissionUserManagementLocation(packet)`：
  - 复用已有 `buildUserManagementLocation(...)`
  - 生成带 `userId/source/integrationId/accountId` 的精确用户管理链接
  - 复制为绝对 URL
  - 成功提示 `自动准入用户链接已复制`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在“手动同步并刷新当前集成”用例中增加断言：
  - mock 的 `autoAdmissionOnboardingPackets` 包含 `accountId` 和 `integrationId`
  - 页面出现 `复制用户链接`
  - 点击后剪贴板拿到精确用户管理 URL
  - 页面提示 `自动准入用户链接已复制`

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

- 自动准入创建的无邮箱用户现在也能直接复制精确治理链接。
- 这样目录页的三条主要用户创建/定位路径都已具备协作分享能力：
  - 手工创建并绑定结果
  - 当前定位成员
  - 自动准入临时凭据
