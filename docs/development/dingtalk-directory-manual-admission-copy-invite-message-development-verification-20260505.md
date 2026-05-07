# DingTalk 目录手工创建结果复制邀请文案开发及验证

## 开发目标

- 将目录页“最近创建并绑定结果”卡片的分发动作补齐到与自动准入结果一致。
- 当管理员通过目录页手工创建并绑定本地用户后，应能直接一键复制邀请文案，而不是手工选择文本。

## 本轮实现

### 1. 手工创建结果卡片新增复制邀请文案

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在 `manualAdmissionResult` 结果卡片中新增 `复制邀请文案`。
- 仅在 `manualAdmissionResult.onboarding.inviteMessage` 存在时显示。

### 2. 新增复制逻辑

- 新增 `copyManualAdmissionInviteMessage()`
- 逻辑：
  - 读取 `manualAdmissionResult.onboarding.inviteMessage`
  - 复制到剪贴板
  - 成功提示 `创建结果邀请文案已复制`
  - 失败提示 `复制创建结果邀请文案失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在“从待处理队列创建并立即绑定本地用户”用例中增加断言：
  - 结果卡片显示 `复制邀请文案`
  - 点击后写入剪贴板的内容与邀请文案一致
  - 页面提示 `创建结果邀请文案已复制`

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

- 目录页手工创建结果卡片现在具备完整协作动作：
  - 查看本地用户
  - 复制用户链接
  - 复制邀请文案
- 这样手工创建和自动准入两条账号交付链路已经基本对齐。
