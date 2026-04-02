# PLM Compare / Substitutes / BOM Export Typed Action Layer 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- 新增 [plm-compare-substitutes-bom-export-models-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-bom-export-models-benchmark-design-20260308.md)

## 本轮结果

### 1. Compare 的 effectivity / substitute 统计已进入共享 typed layer

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `formatEffectivityProps`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `formatEffectivity`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `formatSubstituteCount`

现在都直接消费 `CompareEntry / CompareLineProps / CompareEffectivityEntry`，不再依赖局部 `Record<string, any>`。

### 2. Substitutes 导出已切到显式 source/substitute 语义

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `exportSubstitutesCsv`

现在：

- `substitute_*` 字段走 `getSubstitute*`
- `part_*` 字段走 `getSubstituteSourcePart`

这样导出语义和页面展示保持一致，不再混用匿名 `entry.part`。

### 3. Where-Used 行属性与关系属性边界已显式化

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 中新增了：

- `WhereUsedLineProps`
- `WhereUsedRelationship`

对应辅助函数：

- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `getWhereUsedRefdes`
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中的 `getWhereUsedLineValue`

已经不再因为 `relationship.properties` 与 `relationship` 混用而掉出类型系统。

### 4. Where-Used 内部树状态已脱离 `any`

- [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)

新增 `WhereUsedTreeNode` 后：

- `root`
- `current`
- `child`
- `walk(node, ...)`

都已不再依赖 `any`。

## 验证命令

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

补充检查：

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`
- 结果：`200`

## 验证结果

- `apps/web` 测试通过，当前为 `13 files / 48 tests`
- `type-check` 初次执行暴露了 `Where-Used relationship` 的字段边界问题，已在本轮修正后回绿
- `lint` 与根级 `pnpm lint` 均通过
- `build` 通过，行为上未引入新的阻断项

## 非阻塞提示

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍会触发动态/静态混合导入 warning
- `apps/web` 构建产物仍有大 chunk warning

## 未补跑项

本轮没有新增完整 `/plm` UI regression 报告。

原因：

- 这轮仅收紧前端内部 typed action/export layer
- 未改联邦协议，也未改真实 UI 流程
- 最近一次成功的真实 UI 回归基线仍可复用：
  [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

这轮说明 `/plm` 已经不只是“typed panel + typed state + typed payload”，而是开始把导出、辅助动作和跨面板联动也拉进共享类型边界。下一步继续拆父页时，`Compare / Substitutes / Where-Used` 这几块的辅助逻辑已经不再需要重复引入匿名 shape。
