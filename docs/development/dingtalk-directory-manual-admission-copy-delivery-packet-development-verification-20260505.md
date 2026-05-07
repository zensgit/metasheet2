# DingTalk 目录手工创建结果复制完整交付信息开发及验证

## 开发目标

- 进一步降低管理员交付手工创建账号的操作成本。
- 当目录页手工创建并绑定用户成功后，管理员应能一键复制一段可直接转发的信息，包含：
  - 精确用户治理链接
  - 邀请文案

## 本轮实现

### 1. 手工创建结果卡片新增复制完整交付信息

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在 `manualAdmissionResult` 结果卡片中新增 `复制完整交付信息` 按钮。

### 2. 新增组合复制逻辑

- 新增 `copyManualAdmissionDeliveryPacket()`
- 逻辑：
  - 复用 `buildUserManagementLocation(...)` 生成精确用户治理链接
  - 在浏览器环境下转为绝对 URL
  - 如果有 `inviteMessage`，按以下格式拼接：

```text
用户治理链接：<absolute-user-url>

<inviteMessage>
```

  - 如果没有 `inviteMessage`，只复制治理链接
  - 成功提示 `创建结果完整交付信息已复制`
  - 失败提示 `复制创建结果完整交付信息失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在“从待处理队列创建并立即绑定本地用户”用例中增加断言：
  - 显示 `复制完整交付信息`
  - 点击后剪贴板拿到组合后的完整交付文本
  - 页面提示 `创建结果完整交付信息已复制`

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

- 手工创建结果卡片现在具备：
  - 查看本地用户
  - 复制用户链接
  - 复制邀请文案
  - 复制完整交付信息
- 对真实交付来说，这使管理员可以直接把“治理入口 + 登录引导”一次性发出。
