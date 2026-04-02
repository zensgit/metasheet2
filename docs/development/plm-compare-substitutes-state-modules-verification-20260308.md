# PLM Compare/Substitutes State Modules 验证记录

日期: 2026-03-08

## 范围

本轮验证对应以下增量：

- 新增 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- 新增 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue)
- 更新 [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmComparePanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmComparePanel.spec.ts)
- 新增 [usePlmSubstitutesPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSubstitutesPanel.spec.ts)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)

本轮目标：

- 把 `compare + substitutes` 的局部状态与 panel contract 从父页中下沉到 composable
- 让 [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue) 和 [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue) 摆脱 `panel: any`
- 保持 compare 与 substitutes 的联动、复制、导出和 quick pick 行为不回归

## 静态与包级验证

### 1. Test

命令:

- `pnpm --filter @metasheet/web test`

结果:

- 通过
- `8 files / 41 tests`

本轮新增覆盖:

- [usePlmComparePanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmComparePanel.spec.ts)
- [usePlmSubstitutesPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSubstitutesPanel.spec.ts)

重点校验:

- compare quick pick 会写入左右对比 ID，并同步 query
- substitutes 的 `bomLineQuickPick / substituteQuickPick` 会更新局部状态并清理旧状态
- substitutes 过滤和复制当前 `bomLineId` 的行为正确

### 2. Type Check

命令:

- `pnpm --filter @metasheet/web type-check`

结果:

- 通过

重点校验:

- [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue) 已消费 [PlmComparePanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue) 已消费 [PlmSubstitutesPanelModel](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- `compare/substitutes` 的 state/computed/action 边界已通过 `vue-tsc` 检查

### 3. Lint

命令:

- `pnpm --filter @metasheet/web lint`

结果:

- 通过

补充:

- `apps/web` 的 PLM 作用域 lint 门已扩大到 `tests/usePlm*.spec.ts`
- 本轮新增测试文件已进入 lint 门

### 4. Build

命令:

- `pnpm --filter @metasheet/web build`

结果:

- 通过

保留提示:

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍有动态/静态混合导入 warning
- `apps/web` 仍有大 chunk warning

以上提示为既有问题，本轮未新增构建阻断。

### 5. Root Lint

命令:

- `pnpm lint`

结果:

- 通过

说明:

- 根级 lint 已实际覆盖到 `apps/web` 这条 PLM 作用域门

## 真实 UI 回归

尝试命令:

- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

本轮结果:

- 未完成
- 再次阻塞在 `docker compose -f docker/dev-postgres.yml up -d`
- 观测到本机端口 `5435 / 7778 / 8899` 均未拉起
- 本轮未生成新的 UI regression 报告

判断:

- 阻塞发生在本机依赖自启动阶段，不是 `compare/substitutes` 状态模块化本身报错
- 当前最新成功 UI 回归仍是 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 结论

本轮 `compare/substitutes` 增量已经通过：

- 单元测试
- 类型检查
- Lint
- 构建
- 根级 lint 入口

真实 UI 回归这次没有复跑成功，但阻塞点仍是本机 `docker/dev-postgres.yml` 自启动，而不是前端 compare/substitutes 状态模块化本身。就当前结果而言，这一轮可视为“静态与包级验证闭环，真实 UI 回归待环境恢复后补跑”。
