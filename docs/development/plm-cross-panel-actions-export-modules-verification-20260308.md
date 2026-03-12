# PLM Cross-Panel Actions / Export Modules 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmCrossPanelActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCrossPanelActions.ts)
- 新增 [usePlmExportActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmExportActions.ts)
- 新增 [usePlmCrossPanelActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCrossPanelActions.spec.ts)
- 新增 [usePlmExportActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmExportActions.spec.ts)

## 本轮结果

### 1. 父页中的跨面板动作已下沉

以下逻辑已从 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 移入 [usePlmCrossPanelActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCrossPanelActions.ts)：

- `BOM -> Where-Used`
- `BOM -> Substitutes`
- `BOM -> Product`
- `Compare -> Substitutes`
- `Compare -> Where-Used`
- `Compare -> Product`
- `Where-Used -> Product`
- `Substitute -> Product`
- `Compare line id copy`

结果是父页不再继续堆叠联动动作细节，面板仍通过原有接口消费这些行为。

### 2. 导出与复制动作已下沉

以下逻辑已从 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 移入 [usePlmExportActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmExportActions.ts)：

- `Where-Used CSV`
- `BOM Compare CSV`
- `Compare detail copy`
- `Compare detail CSV`
- `BOM CSV`
- `Substitutes CSV`
- `Documents CSV`
- `Approvals CSV`

这意味着 `/plm` 的导出语义不再游离在父页角落，而是有了独立模块边界。

### 3. 新增模块已有聚焦测试

- [usePlmCrossPanelActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCrossPanelActions.spec.ts) 锁定：
  - `BOM -> Where-Used`
  - `Compare -> Product`
  - `Compare -> Substitutes`
  - `compare line id copy`
- [usePlmExportActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmExportActions.spec.ts) 锁定：
  - `compare detail copy`
  - `substitutes CSV` 的 `source part / substitute part` 导出语义

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

- `apps/web` 测试通过，当前为 `15 files / 52 tests`
- 新增的 `cross-panel actions` 与 `export actions` 两份 spec 均通过
- `type-check` 通过
- `apps/web lint` 与根级 `pnpm lint` 通过
- `apps/web build` 通过

## 非阻塞提示

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍会触发动态/静态混合导入 warning
- `apps/web` 构建产物仍有大 chunk warning

## 未补跑项

本轮没有新增完整 `/plm` UI regression 报告。

原因：

- 本轮只做父页动作/导出逻辑模块化，没有改联邦协议和页面交互流程
- 最近一次成功的 `/plm` UI regression 基线仍可复用：
  [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

这轮证明 `/plm` 已经从“面板拆分 + 状态下沉 + 类型收口”，进一步推进到“行为模块化”。[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 现在更接近编排层，后续继续拆剩余逻辑时，不需要再把动作与导出重新堆回父页。
