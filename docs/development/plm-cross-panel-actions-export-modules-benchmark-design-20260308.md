# PLM Cross-Panel Actions / Export Modules 对标设计

日期: 2026-03-08

## 目标

在上一轮完成 `typed action/export layer` 收口之后，本轮继续向前推进一层：

- 把 `/plm` 父页里剩余的跨面板动作与导出逻辑，下沉成独立模块
- 让 `PlmProductView` 更接近“状态编排 + 面板装配”，不再继续承载业务动作细节
- 为后续继续拆父页、继续压缩页面体积提供稳定边界

## 对标判断

当前 `/plm` 已经具备：

1. 面板组件化
2. state module / composable 下沉
3. shared typed payload model
4. typed action/export layer

但父页里仍然残留两块高耦合逻辑：

- 跨面板动作
  例如 `BOM -> Where-Used`、`Compare -> Substitutes`、`Where-Used -> Product`
- 导出动作
  例如 `BOM / Compare / Substitutes / Documents / Approvals / Where-Used`

如果这两块长期留在父页，问题会很明显：

- 新面板虽然已拆出，但父页仍是所有业务动作的集中地
- typed model 虽然存在，但真正的 action/export 语义没有独立归属
- 后续再拆 `/plm` 时，父页仍会被“按钮行为”和“导出行为”拖住

所以这轮目标不是继续拆模板，而是把父页里“能复用、可测试、可独立演进”的操作逻辑正式模块化。

## 设计决策

### 1. 新增 Cross-Panel Actions 模块

新增 [usePlmCrossPanelActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCrossPanelActions.ts)，统一承接：

- `applyWhereUsedFromBom`
- `applySubstitutesFromBom`
- `applyProductFromBom`
- `applySubstitutesFromCompare`
- `applyProductFromWhereUsed`
- `applyProductFromWhereUsedRow`
- `applyProductFromCompareParent`
- `applyWhereUsedFromCompare`
- `copyCompareLineId`
- `applyProductFromSubstitute`

这些动作本质上都是“跨 panel 跳转 / 联动 / 复制”，并不属于任何单一面板内部状态，因此独立成模块更合理。

### 2. 新增 Export Modules 模块

新增 [usePlmExportActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmExportActions.ts)，统一承接：

- `exportWhereUsedCsv`
- `exportBomCompareCsv`
- `copyCompareDetailRows`
- `exportCompareDetailCsv`
- `exportBomCsv`
- `exportSubstitutesCsv`
- `exportDocumentsCsv`
- `exportApprovalsCsv`

这组函数已经建立在 typed payload / typed panel model 之上，继续留在父页里没有结构收益。

### 3. 用 getter/callback 解耦模块与父页初始化顺序

由于 `Substitutes / Compare` 的一部分状态是在后续 composable 中生成的，本轮没有强行重排父页初始化顺序，而是让新模块通过 getter/callback 取值。

这样做有三个好处：

- 不打乱当前页面装配时序
- 不引入一次性大重排风险
- 仍然能把逻辑真正搬出父页

### 4. 同步补测试，而不是只做代码搬家

本轮新增：

- [usePlmCrossPanelActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCrossPanelActions.spec.ts)
- [usePlmExportActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmExportActions.spec.ts)

这意味着本轮不是单纯“挪文件”，而是把跨面板联动和导出语义正式变成可回归验证的模块。

## 超越目标

这轮真正想超越的不是“父页少几百行”，而是让 `/plm` 进入下一阶段：

- 父页负责编排
- composable 负责状态
- typed model 负责语义
- action/export module 负责操作

这比单纯的 panel 化更进一步，因为它开始切开“页面结构”和“页面行为”。

## 本轮不做

- 不继续拆 `Documents / CAD / Approvals` 的内部状态
- 不改联邦接口
- 不新增 UI 面板
- 不处理全量异常链上的 `error: any`
- 不把 `/plm` 整页直接重写成更细颗粒的 store 体系

本轮目标很明确：把跨面板动作和导出动作从父页里正式抽离，让后续继续压缩 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 具备清晰落点。
