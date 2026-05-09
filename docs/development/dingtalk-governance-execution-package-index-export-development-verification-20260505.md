# DingTalk 联调执行包索引导出开发及验证

日期：2026-05-05

## 开发目标

在治理工作台里补一份联调执行包索引，把日报摘要、联调检查单、真实联调入口、结果回填模板串成固定顺序。这样 142 或其他真实环境验证时，可以先导出索引，再按索引逐项执行和归档。

## 本次改动

### 1. 工作台标题区新增“导出联调执行包索引”

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在治理工作台导出按钮组中新增：
  - `导出联调执行包索引`

当前导出按钮分工为：
- `导出治理日报摘要`
- `导出联调检查单`
- `导出联调结果模板`
- `导出联调执行包索引`

### 2. 新增联调执行包索引 Markdown

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `exportGovernanceExecutionPackageIndex()`
- 导出文件格式为 Markdown：
  - `dingtalk-governance-execution-package-index-YYYY-MM-DD.md`
- 索引内容包含：
  - 推荐执行顺序
    - 导出治理日报摘要
    - 导出联调检查单
    - 执行真实联调
    - 导出联调结果模板
    - 回填并归档结果
  - 当前治理基线
    - 缺 OpenID / 待收口 / 已收口 / 目录已链接
  - 导出文件清单
    - `dingtalk-governance-daily-summary-YYYY-MM-DD.md`
    - `dingtalk-governance-live-validation-checklist-YYYY-MM-DD.md`
    - `dingtalk-governance-validation-result-template-YYYY-MM-DD.md`
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
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 26/26 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 点击 `导出联调执行包索引` 后：
  - 生成 `dingtalk-governance-execution-package-index-2026-05-05.md`
  - 内容包含 `DingTalk 治理联调执行包索引`
  - 内容包含 5 步推荐执行顺序
  - 内容包含 3 个联调产物文件名
  - 内容包含缺 OpenID 成员、目录同步修复、最近 7 天收口审计 3 个 deep link
  - 页面显示成功提示 `已导出 DingTalk 联调执行包索引`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-execution-package-index-export-development-verification-20260505.md`
