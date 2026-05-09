# DingTalk 治理日报摘要导出开发及验证

日期：2026-05-05

## 开发目标

在现有治理工作台基础上补一个可直接导出的日报摘要，方便把当天治理情况同步给运营、值班和协作同事，而不必手工整理统计和链接。

## 本次改动

### 1. 工作台新增“导出治理日报摘要”动作

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在治理工作台标题区新增 `导出治理日报摘要` 按钮。
- 导出文件格式为 Markdown：
  - `dingtalk-governance-daily-summary-YYYY-MM-DD.md`

### 2. 新增治理日报导出内容

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `exportGovernanceDailySummary()`
- 导出内容包含：
  - 日期
  - 核心统计
    - 缺 OpenID
    - 待收口
    - 已收口
    - 目录已链接
  - 当前建议
    - 基于工作台 3 张卡当前实时 note 生成
  - 工作台入口
    - 缺 OpenID 筛查 deep link
    - 目录修复 deep link
    - 最近 7 天审计 deep link

### 3. 标题区样式微调

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `user-admin__section-head--workbench`
- 让工作台标题、提示文案和导出按钮更稳定地排布在一起。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 23/23 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 点击 `导出治理日报摘要` 后：
  - 会生成 `dingtalk-governance-daily-summary-2026-05-05.md`
  - 内容包含核心统计
  - 内容包含当前建议
  - 内容包含 3 个工作台 deep link
  - 页面显示成功提示 `已导出 DingTalk 治理日报摘要`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-daily-summary-export-development-verification-20260505.md`
