# PLM Product Workbench 组件化与父页瘦身设计验证

日期: 2026-03-08

## 1. 本轮目标

在 `BOM / Documents / CAD / Approvals / Where-Used / Compare / Substitutes` 都已经拆成独立面板之后，父页里剩下的重型模板主要集中在两块：

- 产品搜索区
- 产品工作台头部与详情区

本轮目标是继续把这两块从 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中拆走，让父页更接近“状态源 + 副作用 + 跨面板编排器”。

## 2. 快速对标与超越目标

### 2.1 当前问题

即便其他面板已经拆走，只要搜索区和产品详情头部还留在父页里，`PlmProductView` 仍然会承担三种职责：

- 页面骨架
- 产品检索与详情渲染
- 跨面板状态编排

这会继续拖慢后续把 `panel` 对象下沉为 composable 或状态模块的节奏。

### 2.2 本轮对标目标

对标对象不是“更多组件数量”，而是更清晰的职责边界：

- 搜索应是独立的输入与候选面板
- 产品详情头部应是独立的工作台入口面板
- 父页应只保留编排，不再继续充当大号模板容器

### 2.3 超越目标

- 搜索、产品详情、业务分析面板形成统一工作台结构
- 深链接、预设、认证状态、产品复制动作不因拆页回归
- 为下一步 `panel -> composable` 下沉铺路

## 3. 设计

### 3.1 新增组件

- [PlmSearchPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSearchPanel.vue)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)

### 3.2 父页职责变化

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 现在只负责：

- 保持 refs / computed / actions
- 把状态与动作收口为 `searchPanel / productPanel / bomPanel / ...`
- 负责深链接和跨面板联动

不再负责：

- 搜索表格模板
- 产品详情头部模板
- 深链接预设表单模板
- 产品详情字段表与复制按钮模板

### 3.3 样式策略

[PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css) 本轮继续补齐：

- `btn.primary`
- `deep-link-scope / option / drop`
- `subtext`
- `auth-*`

这样搜索区和产品工作台头部拆成子组件后，仍然能沿用原来的交互和视觉结构。

## 4. 验证

### 4.1 静态验证

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

### 4.2 真实联调验证

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

关注点：

- `/plm` 页面仍能正常打开
- 搜索、使用产品、左右对比、复制 ID/料号动作不回归
- 深链接范围、预设导入导出、认证状态展示不回归
- 产品详情加载、复制字段、描述与原始数据展示不回归

## 5. 结果与下一步

### 5.1 结果

完成后，PLM 主工作台已形成更稳定的组件骨架：

- Search
- Product
- BOM
- Documents
- CAD
- Approvals
- Where-Used
- Compare
- Substitutes

这意味着父页的模板级复杂度已经基本压平。

### 5.2 下一步

- 继续把 `panel` 对象收成 composable / 状态模块
- 评估是否把 `searchPanel / productPanel / documentsPanel / cadPanel` 先下沉为第一批 domain helpers
- 继续保持真实 PLM UI 回归随每轮拆分一起跑
