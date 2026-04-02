# PLM Workbench Deep Link Scope Hydration Verification

## 范围

验证 authoritative route hydration 不再把本地 deep-link builder 的 `deepLinkScope` 误当成 route-owned state 清掉。

## 依赖

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- [usePlmDeepLinkState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmDeepLinkState.spec.ts)
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmDeepLinkState.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：沿用 `usePlmDeepLinkState` 回归通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：route hydration 已经只清 canonical route owner，不再误清 deep-link builder 的本地 scope 草稿。
