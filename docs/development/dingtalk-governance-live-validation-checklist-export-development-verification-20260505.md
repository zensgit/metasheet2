# DingTalk 治理联调检查单导出开发及验证

日期：2026-05-05

## 开发目标

在治理工作台里补一个更偏部署后联调的导出物，让真实数据验证可以按统一步骤执行，而不是靠口头交接或手工整理。

## 本次改动

### 1. 工作台标题区新增“导出联调检查单”

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在治理工作台标题区新增 `导出联调检查单` 按钮。
- 与现有 `导出治理日报摘要` 并排保留，分别服务于：
  - 结果沉淀
  - 真实数据联调

### 2. 新增联调检查单导出内容

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `exportGovernanceLiveValidationChecklist()`
- 导出文件格式为 Markdown：
  - `dingtalk-governance-live-validation-checklist-YYYY-MM-DD.md`
- 导出内容包含：
  - 当前基线统计
    - 缺 OpenID
    - 待收口
    - 已收口
  - 联调步骤
    - 缺 OpenID 成员清单核对
    - 目录同步补齐 openId
    - 批量关闭钉钉扫码
    - 最近 7 天收口审计复盘
    - 真实钉钉账号登录验证
    - 导出日报归档
  - 当前建议
    - 直接复用工作台 3 张卡当前实时 note
  - 3 个工作台 deep link

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 24/24 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 点击 `导出联调检查单` 后：
  - 生成 `dingtalk-governance-live-validation-checklist-2026-05-05.md`
  - 内容包含当前基线统计
  - 内容包含联调步骤
  - 内容包含 3 个工作台 deep link
  - 页面显示成功提示 `已导出 DingTalk 联调检查单`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-live-validation-checklist-export-development-verification-20260505.md`
