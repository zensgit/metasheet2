# PLM Workbench Panel State Projection Verification

## 范围

验证 panel route-owner 比较现在只依赖显式字段，不会因为 state 中新增无关字段而误清 route owner。

## 回归

新增/更新：

- [plmTeamViewStateMatch.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmTeamViewStateMatch.spec.ts)

覆盖点：

1. `pickPlmTeamViewStateKeys(...)` 只提取 route-owner 比较需要的字段
2. 现有 `matchPlmTeamViewStateSnapshot(...)` 和 boolean map merge 合同继续保留

同时依赖：

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- focused `plmTeamViewStateMatch.spec.ts`
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmTeamViewStateMatch.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`1` 个文件，`4` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：panel route-owner watcher 已经从“整对象比较”收口到“显式字段投影比较”，future state 扩展不会再误清 canonical owner。
