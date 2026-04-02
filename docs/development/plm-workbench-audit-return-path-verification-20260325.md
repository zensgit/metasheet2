# PLM Workbench Audit Return Path Verification

## 范围

验证 workbench 打开 audit 时，`returnToPlmPath` 现在从当前本地 workbench state 构造，而不是直接抄旧 URL。

## 回归

新增/更新：

- [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts)

覆盖点：

1. `buildPlmWorkbenchRoutePath(...)` 会从当前 snapshot 生成相对 `/plm?...` path
2. 支持叠加 `sceneFocus`
3. 支持保留 `hash`

同时依赖：

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- [plmWorkbenchSceneAudit.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneAudit.ts)

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts tests/plmWorkbenchSceneAudit.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：见本轮提交后的回归结果
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：`returnToPlmPath` 已从“旧 URL 快照”切换到“当前本地 authoritative state”，从 audit 返回 workbench 不再丢掉刚改过但尚未 flush 的筛选。
