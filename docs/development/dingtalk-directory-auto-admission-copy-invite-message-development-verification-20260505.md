# DingTalk 目录自动准入复制邀请文案开发及验证

## 开发目标

- 补齐“自动准入临时凭据”结果卡片的分发动作。
- 当无邮箱成员被自动创建后，管理员不应手工选择 `inviteMessage` 文本再复制，而应支持一键复制邀请文案。

## 本轮实现

### 1. 自动准入结果卡片新增复制邀请文案

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在每个自动准入结果包上新增 `复制邀请文案` 按钮。
- 仅在 `packet.onboarding.inviteMessage` 存在时显示。

### 2. 新增复制逻辑

- 新增 `copyAutoAdmissionInviteMessage(packet)`
- 逻辑：
  - 读取 `packet.onboarding.inviteMessage`
  - 调用 `navigator.clipboard.writeText(...)`
  - 成功提示 `自动准入邀请文案已复制`
  - 失败提示 `复制自动准入邀请文案失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在目录手动同步用例中新增断言：
  - 自动准入结果卡片出现 `复制邀请文案`
  - 点击后写入剪贴板的内容为完整邀请文案
  - 页面提示 `自动准入邀请文案已复制`

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

- 自动准入结果卡片现在具备完整分发动作：
  - 查看本地用户
  - 复制用户链接
  - 复制邀请文案
- 这样无邮箱用户自动准入后的账号交付流程可以直接在目录页完成。
