# DingTalk Directory Recommendation Operations

## Goal

继续把目录 review queue 从“有推荐能力”推进到“推荐优先运营”。

本轮目标：

- 明确展示 `pending_binding` 中可推荐处理和需人工处理的数量。
- 让管理员可以按推荐就绪度筛选 review queue。
- 给管理员一键选择当前筛选结果和一键选择可推荐项，减少手工勾选。
- 保持现有批量确认推荐、手工绑定、停权处理路径不变。

## Implementation

### Backend

- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:343) 为 `DirectoryReviewItemSummary.actionable` 增加 `canConfirmRecommendation`。
- 在 [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:525) 让 `pending_binding` 且存在推荐候选的项显式标记为可确认推荐。

这样前端不需要自己重复推断推荐可用性，review item payload 自带运营信号。

### Frontend

- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:153) 增加待绑定运营摘要：
  - `可推荐`
  - `需人工`
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:169) 增加 `全部待绑定 / 可推荐处理 / 需人工处理` 视图切换。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:194) 和 [DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:202) 增加：
  - `选择当前筛选`
  - `选择可推荐`
  - `清空选择`
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:967) 增加推荐/人工计数。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:972) 调整 `filteredReviewItems`，让 `pending_binding` 可以按推荐就绪度切分。
- 在 [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1581) 和 [DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1588) 增加批量选择工具函数。

## Behavior

现在管理员可以：

- 先看 `待绑定中：可推荐 X · 需人工 Y`
- 切换到 `可推荐处理`
- 一键 `选择可推荐`
- 直接执行 `批量确认推荐`

如果需要手工处理，也可以切到 `需人工处理`，再继续使用现有搜索本地用户和批量绑定流程。

## Tests

新增/更新：

- 后端：
  - [packages/core-backend/tests/unit/directory-sync-review-items.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-review-items.test.ts:21)
  - [packages/core-backend/tests/unit/directory-sync-review-items.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-review-items.test.ts:103)
- 前端：
  - [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1167)

前端新增用例覆盖：

- 推荐/人工计数展示
- `可推荐处理` 视图切换
- `选择可推荐`
- `批量确认推荐`
- `需人工处理` 视图切换

## Verification

通过：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-review-items.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-scheduler.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

`Claude Code CLI` 只读核对通过：

- 已确认页面存在：
  - 待绑定中可推荐/需人工计数
  - `选择当前筛选`
  - `选择可推荐`
  - `可推荐处理 / 需人工处理` 筛选

未通过但与本轮无关：

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

当前仍是仓库既有问题，集中在：

- `src/db/types.ts`
- `src/middleware/api-token-auth.ts`
- 若干 `src/multitable/*`
- `src/routes/comments.ts`
- `src/routes/dashboard.ts`
- `src/routes/univer-meta.ts`
