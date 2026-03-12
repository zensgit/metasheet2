# PLM Compare/Substitutes 独立 Composable 拆分验证记录

日期: 2026-03-08

## 范围

本轮对应以下增量：

- 新增 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- 新增 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 新增 [usePlmComparePanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmComparePanel.spec.ts)
- 新增 [usePlmSubstitutesPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSubstitutesPanel.spec.ts)
- 删除已被替换的合并模块 `usePlmCompareSubstitutesPanels.ts`

本轮目标：

- 把 `compare + substitutes` 从一个组合 composable 继续拆为两个独立模块
- 保持现有 `/plm` 行为不回归
- 让两块高联动状态可以分别测试和分别演进

## 包级验证

### 1. 测试

命令：

- `pnpm --filter @metasheet/web test`

结果：

- 通过
- `9 files / 42 tests`

新增覆盖：

- [usePlmComparePanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmComparePanel.spec.ts)
- [usePlmSubstitutesPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSubstitutesPanel.spec.ts)

校验点：

- compare quick pick 与左右交换仍会更新页面级 compare ids
- substitutes 的 BOM 行 quick pick、替代件 quick pick、过滤与复制仍正常

### 2. Type Check

命令：

- `pnpm --filter @metasheet/web type-check`

结果：

- 通过

校验点：

- 父页已改为直接消费 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts) 和 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)
- `PlmComparePanel.vue` 与 [PlmComparePanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- `PlmSubstitutesPanel.vue` 与 [PlmSubstitutesPanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)

### 3. Lint

命令：

- `pnpm --filter @metasheet/web lint`
- `pnpm lint`

结果：

- 通过

说明：

- `apps/web` 的 PLM 作用域 lint 门已覆盖 `tests/usePlm*.spec.ts`
- 这轮新增的两个 composable 和两个 spec 已进入门禁

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
- 阻塞在 `docker compose -f docker/dev-postgres.yml up -d`
- 额外直接执行 `docker compose -f docker/dev-postgres.yml ps` 时也卡在同一阶段
- 观测到本机端口 `5435 / 7778 / 8899` 未拉起监听

判断：

- 这是本机依赖自启动阻塞，不是本轮 `compare/substitutes` composable 拆分引入的前端异常
- 当前最近一次成功 UI 回归仍是 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

本轮已经完成：

- 独立 composable 拆分
- 单测覆盖
- 类型检查
- lint 门
- 构建验证

唯一未补上的仍是新的真实 UI regression 报告，原因是本机 Docker 自启动阻塞，不是代码级回归。
