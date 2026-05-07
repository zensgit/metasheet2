# DingTalk 目录自动准入复制全部用户链接开发及验证

## 开发目标

- 继续增强自动准入结果卡片的批量协作能力。
- 当一次同步自动创建多个无邮箱账号时，管理员应能一键复制整批精确用户治理链接，而不是逐个点击复制。

## 本轮实现

### 1. 自动准入结果卡片头部新增批量复制用户链接

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在“本次自动准入临时凭据”卡片头部新增 `复制全部用户链接`。

### 2. 新增批量复制逻辑

- 新增：
  - `autoAdmissionUserManagementLocations`
  - `copyAllAutoAdmissionUserManagementLocations()`
- 行为：
  - 为每个自动准入包生成精确用户管理绝对 URL
  - 按换行拼接为一段文本
  - 成功提示 `全部自动准入用户链接已复制`
  - 失败提示 `复制全部自动准入用户链接失败`

### 3. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在目录手动同步用例中增加断言：
  - 显示 `复制全部用户链接`
  - 点击后剪贴板收到整批用户链接文本
  - 页面提示 `全部自动准入用户链接已复制`

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
  - 单条查看本地用户
  - 单条复制用户链接
  - 单条复制邀请文案
- 这已经比较接近真实交付场景下的批量账号分发工作台。
