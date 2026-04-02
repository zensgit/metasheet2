# PLM Compare/Substitutes 独立 Composable 拆分设计与对标

日期: 2026-03-08

## 1. 本轮目标

上一轮已经把 `compare + substitutes` 从 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 的内联 `panel object` 推进到状态模块，但两块能力仍然共处于一个 composable 中，状态边界还不够干净。

本轮目标是继续把它们拆成两个独立模块：

- [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)

目标不是改业务逻辑，而是进一步收紧职责边界：

- `compare` 只持有对比域本地状态与 contract
- `substitutes` 只持有替代件域本地状态与 contract
- 父页保留 query/deep-link/跨面板编排

## 2. 对标对象与超越目标

### 2.1 当前对标

当前前端结构已经优于“巨页直接堆模板”，但如果 `compare` 和 `substitutes` 继续共享一个大 composable，后续还会出现几个问题：

- 一个模块同时承担两类高联动状态，难以做局部验证
- 父页虽然变薄了，但仍然依赖一个较宽的组合返回面
- 后续若继续细化 capability contract，很容易回到“大对象传透”的老路

### 2.2 本轮超越目标

本轮要超越的不是功能量，而是结构质量：

- 从“合并状态模块”进一步收敛为“单面板单模块”
- 从“typed contract 已有”升级到“contract 与状态域一一对应”
- 让下一步的 `BOM / Where-Used` 和 `Documents / CAD` 具备完全可复用的拆分模板

及格线：

- 父页不再依赖 `usePlmCompareSubstitutesPanels`
- 新模块都能被单独测试
- `PlmComparePanel.vue` 和 [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue) 不再需要从一个混合状态对象中读取彼此无关的字段

## 3. 设计边界

### 3.1 父页保留什么

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 继续保留：

- `compareLeftId / compareRightId` 这类页面级 query 驱动状态
- `scheduleQuerySync` / `copyDeepLink` 这类页面级协议
- `loadBomCompare` / `loadSubstitutes` / `addSubstitute` / `removeSubstitute` 等联邦动作
- `applySubstitutesFromCompare`、`applyWhereUsedFromCompare` 这类跨面板跳转

原因很简单：这些能力天然跨域，不适合直接沉进某一个局部面板模块。

### 3.2 compare composable 负责什么

[usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts) 只负责：

- 对比输入状态
- 对比结果/筛选状态
- schema / selection / detailRows 等派生状态
- `comparePanel` typed contract

它通过 option 注入页面级动作，但不直接拥有页面级协议本身。

### 3.3 substitutes composable 负责什么

[usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts) 只负责：

- `bomLineId`、`substituteItemId` 等替代件本地输入
- 替代件列表过滤与 BOM 行上下文
- `substitutesPanel` typed contract

这样 `substitutes` 的状态和 `compare` 的 schema/selection 不再共享一个实现容器。

### 3.4 共享类型层

共享 contract 仍集中在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)，这是刻意保留的：

- 面板 contract 仍能统一检视
- 组件和 composable 使用同一份类型源
- 后续若抽 `capabilities` 层，不需要再倒回匿名对象

## 4. 验证目标

本轮至少应满足：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

新增关注点：

- `compare` 和 `substitutes` 可以分别被单元测试覆盖
- 父页不再引用已删除的合并 composable
- lint 门能覆盖新的 `usePlmComparePanel.spec.ts` 和 `usePlmSubstitutesPanel.spec.ts`

## 5. 下一步建议

- 继续把 `BOM / Where-Used` 也按同样方式拆成独立 composable，而不是再做一组组合模块
- 若后续需要进一步收紧边界，可以再抽 `compare capabilities` 与 `substitutes capabilities`，把跨面板动作从 option 列表中做语义分组
- 暂时不建议把这两块直接推成 Pinia；当前页面级 orchestrator + 面板级 composable 已足够清晰

## 6. 结论

这轮真正完成的是“第二次结构收敛”：

- 不是继续拆模板
- 不是继续堆大对象
- 而是把 `compare` 和 `substitutes` 正式变成两块独立、可测试、可持续演进的状态模块

这一步完成后，`/plm` 前端已经从“巨页组件化”推进到“多面板 + 多独立状态模块”的阶段。
