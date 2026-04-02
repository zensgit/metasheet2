# PLM Search State 下沉与 Workbench 状态模块化设计验证

日期: 2026-03-08

## 1. 本轮目标

在 `Search / Product / BOM / Documents / CAD / Approvals / Where-Used / Compare / Substitutes` 都完成组件化之后，父页里仍然有一类复杂度没有真正下降：

- 大量 refs 和动作虽然不再直接渲染模板，但仍然堆在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)

本轮不再只拆模板，而是开始把第一批真实状态下沉到独立模块，优先选择最自包含的 `search` 区。

## 2. 快速对标与超越目标

### 2.1 当前基线

如果只做组件化，不做状态模块化，会留下两个问题：

- 父页仍然需要自己维护搜索 refs、搜索动作、对比联动和复制动作
- 下一步继续拆 `product / documents / cad` 状态时，父页仍会保持很高的脚本复杂度

### 2.2 本轮对标目标

对标对象是“真正的工作台状态层”，而不是“组件数量更多”。

本轮的及格线：

- 搜索状态不再定义在父页本体
- 搜索行为仍能驱动产品加载、左右对比、复制动作
- 父页通过明确接口消费 `searchPanel`

### 2.3 超越目标

- 从模板拆分进一步推进到状态拆分
- 为后续 `product / documents / cad / compare` 继续下沉建立模式
- 让父页逐步演变成 `state orchestrator`，而不是 `all-in-one view model`

## 3. 设计

### 3.1 新增状态模块

- [usePlmSearchPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSearchPanel.ts)

该模块负责：

- `searchQuery / searchItemType / searchLimit`
- `searchResults / searchTotal / searchLoading / searchError`
- `searchProducts`
- `applySearchItem`
- `applyCompareFromSearch`
- `copySearchValue`
- `searchPanel` 组装

### 3.2 父页职责变化

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 现在不再声明搜索 refs 和搜索动作本体，而是通过 `usePlmSearchPanel(...)` 获取：

- 跨面板仍然需要消费的搜索状态
- 组件直接使用的 `searchPanel`

父页保留的只是：

- 把 `product / compare / deep link` 等跨区块依赖传给 composable
- 保持页面级编排

### 3.3 为什么先从 Search 开始

`search` 是最适合做第一批状态模块化的区域，因为它：

- 输入输出边界清晰
- 与后续产品加载和对比联动存在真实连接
- 比 `product / documents / cad` 更容易先收口模式

换句话说，这不是随机挑一块，而是在为更大范围的状态下沉试模版。

## 4. 验证

### 4.1 静态验证

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

### 4.2 真实联调验证

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

关注点：

- 搜索仍能正常触发
- “使用”动作仍能加载产品
- “左对比 / 右对比”仍能改写 compare 上下文
- 搜索结果复制仍可用
- 整页 `/plm` 回归不受影响

## 5. 结果与下一步

### 5.1 结果

这轮之后，`PLM` 这条线已经从：

- 巨页模板

推进到：

- 巨页模板拆分
- 工作台组件化
- 第一批状态模块化

### 5.2 下一步

- 继续把 `productPanel` 相关状态下沉
- 评估 `documents / cad` 是否适合合并成第二个 workbench state 模块
- 再往后才考虑把更多 `panel` 对象从父页整体收走
