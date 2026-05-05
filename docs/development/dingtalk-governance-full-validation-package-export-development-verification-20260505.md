# DingTalk 完整联调包导出开发及验证

日期：2026-05-05

## 开发目标

在治理工作台里补一个单文件完整联调包导出，把治理日报摘要、联调检查单、结果回填模板、工作台入口和当前建议放到同一份 Markdown。这样 142 真实联调时不必手动拼接多份导出文件，适合快速执行、回填和归档。

## 本次改动

### 1. 工作台标题区新增“导出完整联调包”

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在治理工作台导出按钮组中新增：
  - `导出完整联调包`

当前导出按钮分工为：
- `导出治理日报摘要`
- `导出联调检查单`
- `导出联调结果模板`
- `导出联调执行包索引`
- `导出完整联调包`

### 2. 新增完整联调包 Markdown

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `exportGovernanceFullValidationPackage()`
- 导出文件格式为 Markdown：
  - `dingtalk-governance-full-validation-package-YYYY-MM-DD.md`
- 完整包内容包含：
  - 包内目录
  - 当前治理基线
    - 缺 OpenID / 待收口 / 已收口 / 目录已链接
  - 推荐执行顺序
  - 治理日报摘要
  - 联调检查单
  - 联调结果回填模板
  - 工作台入口
    - 缺 OpenID 成员
    - 目录同步修复
    - 最近 7 天收口审计
  - 当前建议
    - 复用治理工作台卡片实时 note

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check -- apps/web/src/views/UserManagementView.vue apps/web/tests/userManagementView.spec.ts docs/development/dingtalk-governance-full-validation-package-export-development-verification-20260505.md
```

结果：
- `tests/userManagementView.spec.ts` 27/27 通过
- 本轮文件 targeted `git diff --check` 通过

说明：
- 全量 `git diff --check` 当前会被工作树中既有未合并文件阻塞，示例包括：
  - `apps/web/tests/multitable-form-share-manager.spec.ts`
  - `packages/core-backend/tests/integration/public-form-flow.test.ts`
  - `packages/core-backend/tests/unit/jwt-middleware.test.ts`
- 这些文件不属于本轮完整联调包导出改动范围，本轮未修改。

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 点击 `导出完整联调包` 后：
  - 生成 `dingtalk-governance-full-validation-package-2026-05-05.md`
  - 内容包含 `DingTalk 治理完整联调包`
  - 内容包含包内目录
  - 内容包含当前基线
  - 内容包含推荐执行顺序
  - 内容包含治理日报摘要
  - 内容包含联调检查单
  - 内容包含联调结果回填模板
  - 内容包含缺 OpenID 成员、目录同步修复、最近 7 天收口审计 3 个 deep link
  - 页面显示成功提示 `已导出 DingTalk 完整联调包`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-full-validation-package-export-development-verification-20260505.md`
