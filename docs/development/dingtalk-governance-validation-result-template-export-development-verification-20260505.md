# DingTalk 联调结果回填模板导出开发及验证

日期：2026-05-05

## 开发目标

在治理工作台里补一份联调执行后的统一回填模板，让 142 等真实环境联调完成后，结果可以按统一结构沉淀，而不是散落在聊天或临时备注里。

## 本次改动

### 1. 工作台标题区新增“导出联调结果模板”

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 在现有工作台标题区的导出按钮组中新增：
  - `导出联调结果模板`

当前导出按钮分工为：
- `导出治理日报摘要`
- `导出联调检查单`
- `导出联调结果模板`

### 2. 新增联调结果模板导出内容

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `exportGovernanceValidationResultTemplate()`
- 导出文件格式为 Markdown：
  - `dingtalk-governance-validation-result-template-YYYY-MM-DD.md`
- 模板内容包含：
  - 联调环境
    - 环境 / 执行人 / 协同人 / 执行时间
  - 执行前基线
    - 缺 OpenID / 待收口 / 已收口
  - 结果回填
    - 缺 OpenID 清单是否一致
    - 目录同步是否补齐 openId
    - 批量关闭钉钉扫码后统计是否变化
    - 最近 7 天审计是否可追溯
    - 真实钉钉账号验证结果
  - 异常记录
  - 执行后结论
  - 当前建议
    - 继续复用工作台 3 张卡的实时 note

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 25/25 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 点击 `导出联调结果模板` 后：
  - 生成 `dingtalk-governance-validation-result-template-2026-05-05.md`
  - 内容包含联调环境
  - 内容包含执行前基线
  - 内容包含结果回填区
  - 内容包含执行后结论
  - 内容包含 3 个工作台 deep link
  - 页面显示成功提示 `已导出 DingTalk 联调结果模板`

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-validation-result-template-export-development-verification-20260505.md`
