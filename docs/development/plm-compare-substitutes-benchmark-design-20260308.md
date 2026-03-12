# PLM Compare/Substitutes 对标、超越目标与设计验证

日期: 2026-03-08

## 1. 背景

当前 `/plm` 页面已经承载产品详情、BOM、Where-Used、BOM 对比、替代件、审批、文档、CAD 等多条链路，但主页面 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 仍然是高耦合巨页。上一轮已完成：

- 请求层统一收口到 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)
- 审批面板独立为 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- BOM / Where-Used 独立为 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue) 和 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)

本轮继续拆出：

- [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue)
- [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue)
- [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css)

目标不是只做模板搬家，而是把 PLM 工作台收成可以持续演进的领域面板。

## 2. 快速对标基线

### 2.1 当前 MetaSheet PLM 巨页基线

现状优点:

- 单页内即可完成产品定位、BOM 分析、Where-Used、对比、替代件联动
- 已具备深链接、预设、复制、导出等操作能力
- 已接通联邦 PLM 数据源与真实 UI 回归

现状问题:

- 面板模板和父页状态过度耦合，继续加功能会放大维护成本
- 对比和替代件属于高联动区域，选择、跳转、复制、导出逻辑都挤在一个组件里
- UI 能力虽然多，但结构上还没有形成“可复用工作台面板”

### 2.2 上游 Yuantus / 原生 PLM 工作流基线

上游原生 PLM 的优势通常在于：

- 数据语义原生，审批和 BOM 关系链不需要联邦转换
- ECO / 文档 / 物料关系是同一套业务上下文
- 页面往往围绕单一业务动作设计，路径清晰

但 MetaSheet PLM 工作台可以超越的点也很明确：

- 跨面板联动更强
- 深链接与预设更适合协同分享
- 可以逐步桥接到平台统一审批 / 工作流
- 可以把原生 PLM 的查询操作，转成“分析工作台”

## 3. 超越目标

不是去复制一个原生 PLM 页面，而是形成 `ECO/BOM 分析工作台`。

### 3.1 短期超越目标

- 从任意对比条目一跳联动到 `Where-Used` 和 `替代件`
- 把 `compare + substitutes` 做成可分享的深链接工作区
- 保持 CSV 导出、复制字段对照、Line ID 复制等高频动作的低摩擦
- 让父页只负责状态编排，面板负责展示与局部操作

### 3.2 中期超越目标

- 把 PLM ECO 审批桥接到平台统一 [approvals.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/approvals.ts) / [workflow.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow.ts)
- 让 `compare / where-used / substitutes / approvals` 共用更稳定的领域服务与 SDK helper
- 把巨页进一步拆成“工作台面板 + 共享状态模块 + 深链接协议”

### 3.3 不做的事

- 不在这一轮重写整页状态管理
- 不在这一轮把所有 PLM 区块一次拆完
- 不在这一轮引入新业务点稀释结构治理

## 4. 本轮设计

### 4.1 面板边界

`Compare` 面板负责：

- 左右件选择
- 对比参数配置
- 新增 / 删除 / 变更结果表
- 字段级对照
- 对比结果导出与复制
- 从条目联动到产品、Where-Used、替代件

`Substitutes` 面板负责：

- BOM Line 选择
- 替代件查询与过滤
- 新增 / 删除替代件
- 原件 / 替代件快速跳转
- CSV 导出与深链接

父页 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 保留：

- 核心状态
- 深链接同步
- 跨面板联动动作
- 联邦请求时序控制

### 4.2 组件接口策略

本轮没有立即重写成复杂 typed props，而是先采用 `panel` 对象透传：

- 降低拆分时的回归风险
- 保留现有状态和动作命名
- 便于后续逐步把 `panel` 拆成更细的 composable / store

这是刻意的阶段性方案，不是最终形态。

### 4.3 样式策略

把重复的表格、上下文条、diff 行、severity tag 样式统一收口到 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css)，避免每次拆页都复制一份样式。

这样做的收益：

- 新面板能快速复用
- 父页样式继续瘦身
- 视觉结构保持一致

## 5. 验证矩阵

### 5.1 静态验证

- `pnpm --filter @metasheet/web exec vitest run --watch=false`
- `pnpm --filter @metasheet/web exec vue-tsc -b`
- `pnpm --filter @metasheet/web build`

通过标准:

- 单测通过
- 类型检查通过
- 构建通过
- 不新增阻断性 lint / build error

### 5.2 真实联调验证

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

关注点:

- `/plm` 页面可正常加载
- 产品详情、BOM、Where-Used、Compare、Substitutes 面板仍可用
- 对比条目联动 Where-Used / 替代件不回归
- 页面截图与报告落盘

### 5.3 验证结果

本轮已生成：

- [verification-plm-ui-regression-20260308_112420.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_112420.md)
- [platform-plm-weekly-execution-and-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/platform-plm-weekly-execution-and-verification-20260308.md)

结论:

- Compare / Substitutes 已从巨页中独立出来
- 前端验证与真实 PLM UI 回归均通过
- 当前下一步应继续拆 `documents / CAD` 或把 `panel` 继续下沉为更稳定的领域状态模块

## 6. 下一步建议

### 6.1 优先做

- 继续拆 `documents / CAD`
- 让 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts) 逐步切到 SDK helper
- 把 `compare / substitutes` 的 `panel` 对象逐步收成 composable

### 6.2 暂缓做

- 新加大块业务区
- 重做整页框架
- 现在就引入新的多维表格 UI 重写 PLM

## 7. 结论

这轮不是功能扩张，而是把 PLM 工作台朝“可维护、可验证、可继续超越原生 PLM 查询页”的方向推进了一步。

真正的超越点不在页面数量，而在：

- 分析链路更顺
- 协同分享更强
- 平台统一能力更容易接入
- 后续演进成本更低
