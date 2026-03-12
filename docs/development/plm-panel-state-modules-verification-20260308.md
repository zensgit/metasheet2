# PLM Panel State Modules 验证记录

日期: 2026-03-08

## 范围

本轮验证对应以下增量：

- 新增 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 新增 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [usePlmSearchPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSearchPanel.ts)
- 更新 [PlmSearchPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSearchPanel.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmProductPanel.spec.ts)
- 更新 [usePlmSearchPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSearchPanel.spec.ts)

本轮目标：

- 把 `productPanel` 从父页内联对象抽为独立 composable
- 为 `Search / Product` 两个 panel 建立 typed contract
- 让 `PlmProductView.vue` 继续从巨页状态容器收敛为 page orchestrator

## 静态与包级验证

### 1. 单元测试

命令:

- `pnpm --filter @metasheet/web test`

结果:

- 通过
- `7 files / 38 tests`
- 新增覆盖:
  - [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmProductPanel.spec.ts)
  - [usePlmSearchPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSearchPanel.spec.ts)

校验点:

- `auth/plm auth` 文案、样式 class 和 hint 推导
- `productPanel` 对外 contract 的动作透传
- `searchPanel` 搜索、加载产品、对比联动、复制值的基本行为

### 2. Type Check

命令:

- `pnpm --filter @metasheet/web type-check`

结果:

- 通过

校验点:

- `PlmSearchPanel.vue` 与 [PlmSearchPanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- `PlmProductPanel.vue` 与 [PlmProductPanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- `usePlmProductPanel.ts` / `usePlmSearchPanel.ts` 的输入输出类型

### 3. Lint

命令:

- `pnpm --filter @metasheet/web lint`

结果:

- 通过

说明:

- 当前 lint 仍是 `apps/web` 的 PLM 作用域门
- 本轮新增的 `src/views/plm/*.ts` 已被覆盖

### 4. Build

命令:

- `pnpm --filter @metasheet/web build`

结果:

- 通过

保留提示:

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍有动态/静态混合导入 warning
- `apps/web` 仍有大 chunk warning

以上提示为既有问题，本轮未新增构建阻断。

## 真实 UI 回归

尝试命令:

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

本轮结果:

- 未完成
- 阻塞在 `docker compose -f docker/dev-postgres.yml up -d`
- 观测到本机端口 `5435 / 7778 / 8899` 均未拉起
- 新的 UI regression 报告未生成

判断:

- 这次阻塞发生在本机依赖自启动阶段，不是 `PLM panel state module` 代码本身报错
- [artifacts/plm-ui-regression-backend.log](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-ui-regression-backend.log) 没有出现本轮新启动日志，只有更早一次成功回归的后端日志
- 当前可引用的最新成功 UI 回归仍是 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

本轮代码增量已经通过：

- 测试
- 类型检查
- Lint
- 构建

真实 UI 回归本次未能复跑，不是因为前端状态模块化引入了明确错误，而是因为本机 `docker/dev-postgres.yml` 的自启动链路卡住。就当前代码结果而言，这一轮可以视为“静态与包级验证闭环、真实回归待环境恢复后补跑”。
