# PLM Documents/CAD 模块化与作用域 Lint 门设计验证

日期: 2026-03-08

## 1. 本轮目标

在 `Compare / Substitutes` 完成拆分之后，本轮继续推进两件事：

- 把 `documents / CAD` 从 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中拆成独立面板
- 给 `apps/web` 补一个可执行的 PLM 作用域 lint 门，避免前端质量门继续空跑

本轮不追求一次解决整个前端历史积压，而是先把 `PLM 工作台` 这条主线纳入可维护、可验证、可持续拆分的节奏。

## 2. 快速对标与超越目标

### 2.1 当前基线

拆分前的 `documents / CAD` 区块有两个现实问题：

- 模板体积大，但本质上是高度自包含的工作台区块
- 页面虽然已经支持 `文档 -> CAD` 选择、CAD 差异、评审、历史，但这些能力都被埋在父页内部

### 2.2 对标对象

对标不是做一个“更像原生 PLM”的页面，而是让 MetaSheet 的 PLM 工作台在协同和分析效率上超越原生查询页。

对标维度：

- 原生 PLM 强项：文档、CAD、ECO 数据语义原生一致
- MetaSheet 强项：跨区块联动、深链接分享、可逐步接入平台统一能力

### 2.3 本轮超越目标

- 文档区与 CAD 区变成可以独立演进的工作台面板
- 保留 `文档选主 CAD / 对比 CAD` 的低摩擦操作路径
- 让父页只保留编排与联动，不继续承载大段模板
- 让 PLM 主线有一个真正执行中的 lint 门，而不是停留在“后续补”

## 3. 设计

### 3.1 面板拆分

本轮新增：

- [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)

父页 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 现在通过 `documentsPanel` 和 `cadPanel` 透传状态与动作。

### 3.2 状态边界

`Documents` 面板负责：

- 文档过滤、排序、列开关
- 文档导出
- CAD 主文件 / 对比文件选择
- 文档 ID / 下载链接复制

`CAD` 面板负责：

- CAD 元数据加载
- 属性、视图状态、评审编辑
- 历史查看
- 差异与网格统计查看

父页保留：

- 深链接协议
- 跨面板联动
- 请求函数与状态源

### 3.3 样式复用

[PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css) 本轮继续扩展，新增 `cad-grid / cad-card / cad-textarea / cad-span`，这样 CAD 面板拆出去后不会因为 `scoped` 样式边界丢布局。

### 3.4 Lint 门策略

本轮没有直接把整个 `apps/web` 历史 backlog 一次清空，而是先补一个 `PLM 作用域 lint 门`：

- 脚本在 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 配置在 [apps/web/.eslintrc.cjs](/Users/huazhou/Downloads/Github/metasheet2/apps/web/.eslintrc.cjs)

当前覆盖：

- `PlmProductView.vue`
- `src/views/plm/*.ts`
- `PlmService.ts`
- `src/components/plm/*.vue`
- `tests/plmService.spec.ts`

这是刻意的阶段性质量门，先锁住 PLM 主线，再决定是否向全 `apps/web` 扩展。

## 4. 验证

### 4.1 静态验证

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

### 4.2 真实联调

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

关注点：

- `/plm` 页面可正常加载
- 文档列表、列切换、文档复制功能不回归
- 从文档面板选择主 CAD / 对比 CAD 仍能驱动 CAD 面板
- CAD 属性、视图状态、评审、历史、差异、网格统计区块仍可展示

### 4.3 本轮结果

本轮验证通过后，PLM 主页面已经形成：

- 产品
- BOM
- Documents
- CAD
- Approvals
- Where-Used
- Compare
- Substitutes

这 8 个主要业务区块里，除产品区外其余重点区域都已被拆成独立面板。

## 5. 结论与下一步

### 5.1 结论

这轮的价值不在新增功能，而在两点：

- `documents / CAD` 已从巨页内联模板收成独立模块
- `apps/web` 至少在 `PLM 主线` 上终于有了真实 lint 门

### 5.2 下一步

- 继续把 `panel` 对象收成更明确的 composable 或状态模块
- 让 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts) 逐步切到 SDK helper
- 视情况把 lint 门从 `PLM 作用域` 扩到整个 `apps/web`
