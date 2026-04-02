# PLM Workbench Authoritative Route Hydration Verification

## 范围

验证 `PlmProductView` 现在会 authoritative 地消费同一路由 query 变化，并在 route hydration 前清掉待发送的 debounce query patch。

## 回归

新增/更新：

- [usePlmDeepLinkState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmDeepLinkState.spec.ts)

覆盖点：

1. `cancelScheduledQuerySync()` 能清掉待发送的 debounce patch
2. 原有 deep-link query debounce/copy 行为保持不变

同时依赖：

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmDeepLinkState.ts)
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmDeepLinkState.spec.ts tests/plmWorkbenchViewState.spec.ts tests/usePlmTeamViews.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`3` 个文件，`51` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：`PlmProductView` 的 route hydration 已从“mounted 时的一次性 sparse patch”收口成 authoritative 同步，本地 stale query patch 也不会在外部 route pivot 后反向回写。
