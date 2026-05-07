# DingTalk 目录自动准入复制全部完整交付信息开发及验证

## 开发目标

- 给自动准入结果卡片补最后一层批量交付动作。
- 当一次同步自动创建多个无邮箱账号时，管理员应能一键复制整批“用户治理链接 + 邀请文案”的组合文本，直接发给协作者或运维。

## 本轮实现

### 1. 自动准入结果卡片新增批量完整交付复制

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在“本次自动准入临时凭据”卡片头部新增 `复制全部完整交付信息`。

### 2. 新增批量组合复制逻辑

- 新增：
  - `autoAdmissionDeliveryPackets`
  - `copyAllAutoAdmissionDeliveryPackets()`
- 行为：
  - 对每个自动准入包生成：

```text
用户治理链接：<absolute-user-url>

<inviteMessage>
```

  - 没有 `inviteMessage` 时仅保留治理链接
  - 多个包之间使用 `\n\n---\n\n` 分隔
  - 成功提示 `全部自动准入完整交付信息已复制`
  - 失败提示 `复制全部自动准入完整交付信息失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在目录手动同步用例中增加断言：
  - 显示 `复制全部完整交付信息`
  - 点击后剪贴板收到批量完整交付文本
  - 页面提示 `全部自动准入完整交付信息已复制`

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

- 自动准入结果卡片现在支持：
  - 复制全部用户链接
  - 复制全部邀请文案
  - 复制全部完整交付信息
  - 以及单条查看/复制动作
- 这基本已经把目录页无邮箱账号交付动作补到可直接上线使用的程度。
