# DingTalk 目录自动准入复制全部邀请文案开发及验证

## 开发目标

- 进一步降低无邮箱自动准入后的账号分发成本。
- 当一次同步生成多个自动准入账号时，管理员应能一键复制整批邀请文案，而不是逐个点击复制。

## 本轮实现

### 1. 自动准入结果卡片新增批量复制入口

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在“本次自动准入临时凭据”卡片头部新增 `复制全部邀请文案`。
- 仅当至少一个自动准入包存在 `inviteMessage` 时显示。

### 2. 新增批量复制逻辑

- 新增：
  - `autoAdmissionInviteMessages`
  - `hasAutoAdmissionInviteMessages`
  - `copyAllAutoAdmissionInviteMessages()`
- 行为：
  - 汇总所有存在的 `packet.onboarding.inviteMessage`
  - 使用双换行 `\n\n` 拼接为一段批量分发文本
  - 成功提示 `全部自动准入邀请文案已复制`
  - 失败提示 `复制全部自动准入邀请文案失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在目录手动同步用例中增加断言：
  - 显示 `复制全部邀请文案`
  - 点击后剪贴板收到完整批量邀请文案
  - 页面提示 `全部自动准入邀请文案已复制`

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

- 自动准入结果卡片现在不仅支持逐个复制邀请文案，还支持整批复制。
- 对真实交付来说，这能明显减少管理员分发无邮箱账号时的重复操作。
