# DingTalk Directory Review Pagination

## Goal

继续把目录 review queue 做成可用于更大规模成员治理的工作台。

当前后端 `review-items` 已经支持分页和 `total`，但前端一直固定请求第一页 `page=1&pageSize=100`。当待处理项超过 100 条时，管理员只能看到第一页，而且页面没有任何“队列被截断”的提示。

本轮目标：

- 把 review queue 从“固定第一页”改成“已加载 / 总数 + 加载更多”。
- 保持现有筛选、推荐默认流、人工原因分组不变。
- 刷新队列时回到第一页，避免把旧的追加页残留在刷新结果里。

## Implementation

### Frontend

- 在 `apps/web/src/views/DirectoryManagementView.vue` 增加 review queue 分页状态：
  - `reviewPage`
  - `reviewTotal`
  - `reviewPageSize`
  - `loadingMoreReviewItems`
- `loadReviewItems(...)` 现在支持两种模式：
  - 默认刷新：请求第一页并替换当前队列
  - `append: true`：请求下一页并把结果追加到当前队列
- 页面头部新增加载进度提示：
  - `当前已加载 X / Y 项，筛选统计基于已加载数据。`
- 页面底部新增：
  - `加载更多 (N)` 按钮
- 如果当前筛选在已加载数据中暂无结果，但后面还有未加载页，空状态改成：
  - `当前筛选在已加载数据中暂无结果，可继续加载更多。`
- 分页追加失败时不会清空已加载队列，只提示错误；完整刷新失败时仍按原逻辑清空并报错。

### Backend

- 本轮没有改后端接口。
- 继续复用已有：
  - `GET /api/admin/directory/integrations/:integrationId/review-items`
  - 返回的 `items / total / page / pageSize`

## Tests

前端测试更新在：

- `apps/web/tests/directoryManagementView.spec.ts`

覆盖点：

- 初次加载 `page=1` 时显示 `当前已加载 X / Y`。
- 当 `total > 当前已加载数` 时显示 `加载更多`。
- 点击 `加载更多` 后请求 `page=2`，并把第二页条目追加到 review queue。
- 点击 `刷新队列` 后重新请求 `page=1`，并回到第一页结果。

## Verification

通过：

```bash
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

## Notes

- 本轮并行开发里使用了 worker 辅助补测试。
- 也调用了 `Claude Code CLI` 做只读辅助检查；最终实现与结论仍以本地代码和本地测试结果为准。
