# 多维表系统计划验证报告（2026-04-04）

## 结论

《多维表系统计划（采纳 Claude 反馈后的修正版）》在本工作树已完成本地验证收口。此前阻塞 `ready:local` 的问题已经从运行时代码收敛到过时 integration tests；本轮补齐测试后，最终 readiness gate 已通过。

## 本轮直接验证

### 1. backend integration suite（修复后）

命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-form.api.test.ts \
  tests/integration/multitable-attachments.api.test.ts \
  tests/integration/multitable-view-config.api.test.ts
```

结果：

- `4/4` test files passed
- `28/28` tests passed

### 2. multitable pilot ready local

命令：

```bash
pnpm verify:multitable-pilot:ready:local
```

结果：

- PASS
- readiness JSON：
  - [readiness.json](/tmp/metasheet2-multitable-plan-mORTqT/output/playwright/multitable-pilot-ready-local/20260404-105314/readiness.json)
- readiness Markdown：
  - [readiness.md](/tmp/metasheet2-multitable-plan-mORTqT/output/playwright/multitable-pilot-ready-local/20260404-105314/readiness.md)
- smoke report：
  - [report.json](/tmp/metasheet2-multitable-plan-mORTqT/output/playwright/multitable-pilot-ready-local/20260404-105314/smoke/report.json)
- profile report：
  - [report.json](/tmp/metasheet2-multitable-plan-mORTqT/output/playwright/multitable-pilot-ready-local/20260404-105314/profile/report.json)
- gate report：
  - [report.json](/tmp/metasheet2-multitable-plan-mORTqT/output/playwright/multitable-pilot-ready-local/20260404-105314/gates/report.json)

## 本工作树内已完成的其他验证

以下命令已在本工作树通过，且本轮没有引入会使其失效的运行时代码改动：

### 前端定向测试

命令：

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-import.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-comments.spec.ts \
  tests/multitable-comment-composer.spec.ts \
  tests/multitable-comment-inbox-view.spec.ts \
  tests/multitable-comment-inbox.spec.ts \
  tests/multitable-comment-realtime.spec.ts \
  tests/multitable-form-view.spec.ts \
  tests/multitable-record-drawer.spec.ts
```

结果：

- `70/70` passed

### backend 定向测试

命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/comments.api.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-attachment-cleanup.test.ts
```

结果：

- `comments.api.test.ts`: `1/1` passed
- `multitable-attachment-cleanup.test.ts`: passed

### 构建与契约

命令：

```bash
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend build
pnpm verify:multitable-openapi:parity
```

结果：

- 全部通过

### 本地 pilot smoke

命令：

```bash
pnpm verify:multitable-pilot:local
```

结果：

- PASS
- artifact：
  - [report.json](/tmp/metasheet2-multitable-plan-mORTqT/output/playwright/multitable-pilot-local/20260404-104236/report.json)

### release-gate 测试脚本

命令：

```bash
pnpm verify:multitable-pilot:release-gate:test
pnpm verify:multitable-pilot:readiness:test
node --test \
  scripts/ops/multitable-onprem-release-gate.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-ready-local.test.mjs \
  scripts/ops/multitable-pilot-ready-staging.test.mjs
```

结果：

- 全部通过

### on-prem release gate

命令：

```bash
pnpm verify:multitable-onprem:release-gate
```

结果：

- PASS
- artifact：
  - [report.json](/tmp/metasheet2-multitable-plan-mORTqT/output/releases/multitable-onprem/gates/20260404-104439/report.json)

## 故障与修复摘要

本轮之前出现的失败，已经通过以下修复消除：

1. 恢复缺失历史迁移  
2. 增加 repair migrations，修正 `meta_*` / `multitable_attachments` 结构漂移  
3. 在运行时挂载 canonical `/api/multitable` 路由  
4. 修复 [comments.api.test.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/tests/integration/comments.api.test.ts) 对共享 dev DB 的 destructive 行为  
5. 将以下两组过时 integration tests 对齐到当前契约：
   - [multitable-context.api.test.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/tests/integration/multitable-context.api.test.ts)
   - [multitable-record-form.api.test.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/tests/integration/multitable-record-form.api.test.ts)

## 最终状态

当前本工作树验证结论如下：

- multitable 前端定向测试：通过
- multitable / comments 后端定向测试：通过
- web build：通过
- core-backend build：通过
- openapi parity：通过
- local pilot smoke：通过
- local pilot readiness：通过
- on-prem release gate：通过

这意味着当前计划对应的多维表系统实现已经达到本地试点 / on-prem 收口门槛。
