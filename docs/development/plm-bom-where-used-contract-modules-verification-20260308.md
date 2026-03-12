# PLM BOM / Where-Used Contract Modules 验证记录

日期: 2026-03-08

## 范围

本轮验证对应以下增量：

- 新增 [usePlmBomPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomPanel.ts)
- 新增 [usePlmWhereUsedPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedPanel.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmBomPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomPanel.spec.ts)
- 新增 [usePlmWhereUsedPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedPanel.spec.ts)

本轮目标：

- 抽出 `BOM / Where-Used` 的面板 contract composable
- 移除两个面板的 `panel: any`
- 保持现有 `/plm` 页面行为不回归

## 包级验证

### 1. 测试

命令：

- `pnpm --filter @metasheet/web test`

结果：

- 通过
- `11 files / 44 tests`

新增覆盖：

- [usePlmBomPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomPanel.spec.ts)
- [usePlmWhereUsedPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedPanel.spec.ts)

校验点：

- `usePlmBomPanel` 会保留 BOM panel contract 的引用边界
- `usePlmWhereUsedPanel` 会保留 Where-Used panel contract 的引用边界

### 2. Type Check

命令：

- `pnpm --filter @metasheet/web type-check`

结果：

- 通过

重点校验：

- `PlmBomPanel.vue` 已消费 [PlmBomPanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- `PlmWhereUsedPanel.vue` 已消费 [PlmWhereUsedPanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- `BOM 行` 和 `Where-Used 行` 相关字段访问能通过 `vue-tsc`

### 3. Lint

命令：

- `pnpm --filter @metasheet/web lint`
- `pnpm lint`

结果：

- 通过

### 4. Build

命令：

- `pnpm --filter @metasheet/web build`

结果：

- 通过

保留提示：

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍有动态/静态混合导入 warning
- `apps/web` 仍有大 chunk warning

以上为既有提示，本轮未新增构建阻断。

## 真实 UI 回归

尝试命令：

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

本轮结果：

- 未完成
- 再次阻塞在 `docker compose -f docker/dev-postgres.yml up -d`
- 停在 `Starting dev postgres (docker/dev-postgres.yml)...` 之后，仅输出 compose 的 `version` obsolete warning

判断：

- 本轮仍是本机 Docker 自启动阻塞，不是 `BOM / Where-Used contract module` 代码回归
- 当前最近一次成功 UI 回归仍是 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

本轮已经完成：

- `BOM / Where-Used` contract composable 抽取
- 两个面板的显式类型化
- 单测、类型检查、lint、构建和根级 lint 验证

这轮没有拿到新的真实 UI regression 报告，但阻塞点仍然是环境，不是本轮代码本身。
