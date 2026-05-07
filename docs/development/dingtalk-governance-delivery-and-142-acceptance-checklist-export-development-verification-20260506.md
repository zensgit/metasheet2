# DingTalk 治理工作台交付清单与 142 联调验收清单导出

## 开发目标

- 在用户管理页治理工作台补齐交付收口导出物，而不是只停留在联调过程文档。
- 让值班、运维和验收同学可以直接从页面导出 `交付清单` 和 `142 联调验收清单`。
- 保持现有导出交互一致，继续使用 Markdown 单文件导出和页面状态提示。

## 实现说明

### 1. 新增两个治理工作台导出按钮

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 的治理工作台按钮区新增：
  - `导出交付清单`
  - `导出 142 联调验收清单`

### 2. 新增交付清单导出

- 新增 `exportGovernanceDeliveryChecklist()`。
- 导出内容包含：
  - 当前交付判断
  - 当前代码基线
  - 核心交付项
  - 交付前操作
  - 关键入口
  - 剩余风险
  - 当前建议

### 3. 新增 142 联调验收清单导出

- 新增 `exportGovernance142AcceptanceChecklist()`。
- 导出内容包含：
  - 验收前提
  - 142 验收矩阵
  - 执行入口
  - 结果回填模板
  - 当前基线
  - 当前建议

## 验证

### 执行命令

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

### 预期结果

- `userManagementView.spec.ts` 新增覆盖两个新导出按钮与导出内容。
- `directoryManagementView.spec.ts` 保持通过，确认本轮没有破坏目录治理流程。
- `git diff --check` 通过，确保本轮改动没有格式或冲突残留。
