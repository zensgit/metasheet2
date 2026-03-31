# Claude Task Pack Archives Verification

日期：2026-03-31

## 范围

验证 `claude-task-pack-archives` 是否满足：

- 14 份执行包 / 模板文档都已纳入版本控制
- 本轮未夹带 rollout backlog 或运行时代码
- 归档后 dirty tree 只剩真实 backlog

## 实际命令

```bash
git status --short -- docs/development/*claude*20260330.md docs/development/*verification-template*20260330.md
git diff --check -- \
  docs/development/dingtalk-oauth-backend-claude-task-pack-20260330.md \
  docs/development/dingtalk-oauth-backend-claude-verification-template-20260330.md \
  docs/development/dingtalk-oauth-backend-repair1-claude-task-pack-20260330.md \
  docs/development/dingtalk-oauth-backend-repair1-claude-verification-template-20260330.md \
  docs/development/dingtalk-oauth-backend-repair2-claude-task-pack-20260330.md \
  docs/development/dingtalk-oauth-backend-repair2-claude-verification-template-20260330.md \
  docs/development/dingtalk-onprem-rollout-claude-task-pack-20260330.md \
  docs/development/dingtalk-onprem-rollout-claude-verification-template-20260330.md \
  docs/development/dingtalk-ops-hardening-claude-task-pack-20260330.md \
  docs/development/dingtalk-ops-hardening-claude-verification-template-20260330.md \
  docs/development/dingtalk-ops-hardening-repair-claude-task-pack-20260330.md \
  docs/development/dingtalk-ops-hardening-repair-claude-verification-template-20260330.md \
  docs/development/dingtalk-ops-hardening-repair2-claude-task-pack-20260330.md \
  docs/development/dingtalk-ops-hardening-repair2-claude-verification-template-20260330.md \
  docs/development/claude-task-pack-archives-design-20260331.md \
  docs/development/claude-task-pack-archives-verification-20260331.md \
  docs/verification-index.md
```

## 实际结果

### 1. 待归档文件数

- 命令：`git status --short -- docs/development/*claude*20260330.md docs/development/*verification-template*20260330.md`
- 结果：通过
- 汇总：
  - `14` 个未跟踪文档
  - 全部位于 `docs/development/`

### 2. 格式检查

- 命令：`git diff --check -- ...`
- 结果：通过

### 3. 归档范围

本轮归档的 14 个文档是：

- OAuth backend：`6`
- on-prem rollout：`2`
- ops hardening：`6`

没有夹带：

- `docs/deployment/dingtalk-*.md`
- `docs/development/dingtalk-*-design-20260330.md`
- `docs/development/dingtalk-*-verification-20260330.md`
- `scripts/openapi-check.mjs`

### 4. 归档后的剩余 backlog

在上一轮生成物清理后，dirty tree 已降到 `21` 个路径。

本轮把其中 `14` 个 task pack / template 归档后，剩余 backlog 应收敛为：

- `dingtalk-rollout-docs-backlog = 6`
- `reconciliation-tooling-and-entrypoints = 1`

也就是：

- DingTalk rollout 设计 / 验证 / 部署文档
- `scripts/openapi-check.mjs`

## 结论

这条 archive slice 成立。

收口后，主工作树不再被 Claude 协作模板污染，剩余的就是下一轮真正需要处理的 rollout/docs backlog 与单个脚本 follow-up。
