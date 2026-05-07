# DingTalk 目录自动准入复制完整交付信息开发及验证

## 开发目标

- 将自动准入结果卡片的单条交付动作补齐到与手工创建结果一致。
- 当无邮箱成员被自动创建后，管理员应能一键复制“精确用户治理链接 + 邀请文案”的组合文本，直接转发给协作者或运维。

## 本轮实现

### 1. 自动准入结果卡片新增复制完整交付信息

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在每个自动准入结果包上新增 `复制完整交付信息` 按钮。

### 2. 新增组合复制逻辑

- 新增 `copyAutoAdmissionDeliveryPacket(packet)`
- 逻辑：
  - 使用 `packet.userId/accountId/integrationId` 生成精确用户治理绝对 URL
  - 读取 `packet.onboarding.inviteMessage`
  - 如果有邀请文案，拼接格式为：

```text
用户治理链接：<absolute-user-url>

<inviteMessage>
```

  - 如果没有邀请文案，仅复制治理链接
  - 成功提示 `自动准入完整交付信息已复制`
  - 失败提示 `复制自动准入完整交付信息失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在目录手动同步用例中增加断言：
  - 自动准入结果卡片出现 `复制完整交付信息`
  - 点击后剪贴板拿到完整组合文本
  - 页面提示 `自动准入完整交付信息已复制`

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

- 自动准入结果卡片现在具备：
  - 查看本地用户
  - 复制用户链接
  - 复制邀请文案
  - 复制完整交付信息
- 这样自动准入和手工创建两条账号交付链路的主要单条动作已经完全对齐。
