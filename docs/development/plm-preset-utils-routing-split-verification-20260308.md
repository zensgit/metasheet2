# PLM Preset Utils / Routing Split 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- 新增 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)
- 更新 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- 更新 [vite.config.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/vite.config.ts)
- 更新 [package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)

## 本轮结果

### 1. BOM / Where-Used preset 规则已进入共享工具层

- `upsert / apply / load / persist / share / parse / merge / export`
  已从父页抽到 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 不再内联维护这一整套共享规则
- `BOM / Where-Used` 现在共同依赖同一组 preset helper

### 2. 新工具层已进入测试门

新增 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)，覆盖：

- preset `upsert / apply`
- import parse / merge
- `persist / load`
- share url encode/decode
- 文件导出

### 3. `featureFlags` 混合导入 warning 已消失

- [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 现在静态导入 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts)
- 本轮 `vite build` 日志中已不再出现之前那条：
  `featureFlags.ts is dynamically imported ... but also statically imported ...`

### 4. 主入口已切到路由级懒加载

- 主页面已改成路由级 `import()`
- 构建产物从此前单入口约 `2.19 MB`，转为：
  - `index-*.js` 约 `17.74 kB`
  - `PlmProductView-*.js` 约 `239.71 kB`
  - `AttendanceExperienceView-*.js` 约 `243.10 kB`
  - `WorkflowDesigner-*.js` 约 `14.67 kB`
  - `workflow-bpmn-*.js` 约 `556.77 kB`
  - `vendor-element-plus-*.js` 约 `877.00 kB`

也就是说，平台壳已经不再承载所有页面代码。

## 验证命令

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

补充检查：

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`
- 结果: `200`

包级测试结果：

- `18 files / 59 tests` 通过

## 非阻塞提示

本轮构建仍保留两类 chunk warning：

- `workflow-bpmn` 约 `556.77 kB`
- `vendor-element-plus` 约 `877.00 kB`

这两块与上一轮不同，已经不是“所有页面被压在一个入口 chunk”，而是明确的独立 vendor/route chunk。

## 未补跑项

本轮没有新增完整 `/plm` UI regression 报告。

原因：

- 改动集中在前端共享规则抽取和入口切块
- 没有改联邦协议，也没有调整 `/plm` 真实业务动作

当前最近一次成功基线仍是：

- [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 验证结论

这轮改动证明四件事：

1. `BOM / Where-Used` preset 规则已经不再被父页独占
2. 共享 preset 规则已进入独立测试和 lint/type-check/build 门
3. `featureFlags` 混合导入 warning 已被真正消掉
4. `apps/web` 已完成从“重入口”到“路由级切块”的又一次前进
