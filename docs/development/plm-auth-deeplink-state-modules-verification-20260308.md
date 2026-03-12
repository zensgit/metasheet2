# PLM Auth / Deep-Link State Modules 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmAuthStatus.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmAuthStatus.ts)
- 新增 [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmDeepLinkState.ts)
- 新增 [usePlmAuthStatus.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmAuthStatus.spec.ts)
- 新增 [usePlmDeepLinkState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmDeepLinkState.spec.ts)

## 本轮结果

### 1. 认证状态已从父页抽离

- `decodeJwtPayload / resolveTokenStatus / refreshAuthStatus / handleAuthError`
  已进入 [usePlmAuthStatus.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmAuthStatus.ts)
- 父页只消费：
  - `authState`
  - `authExpiresAt`
  - `plmAuthState`
  - `plmAuthExpiresAt`
  - `plmAuthLegacy`
  - `authError`
  - `refreshAuthStatus / handleAuthError / startAuthStatusPolling / stopAuthStatusPolling`

### 2. Deep-link / preset 状态已从父页抽离

- `deepLinkScope / deepLinkPreset / deepLinkStatus / deepLinkError`
  已由 [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmDeepLinkState.ts) 统一管理
- query sync、防抖计时器、preset 持久化、拖放导入、deep-link 复制逻辑已不再由父页内联维护
- sanity check:
  - [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中已无这组本地函数定义：
    `decodeJwtPayload / resolveTokenStatus / refreshAuthStatus / handleAuthError / scheduleQuerySync / copyDeepLink / clearDeepLinkScope / applyDeepLinkPreset / saveDeepLinkPreset / deleteDeepLinkPreset / applyPresetRename / movePreset / exportCustomPresets / importCustomPresets / handlePresetFileImport / handlePresetDrop`

### 3. 父页继续退回编排层

- 当前 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 现为 `5748` 行
- 新增模块规模：
  - [usePlmAuthStatus.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmAuthStatus.ts): `112` 行
  - [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmDeepLinkState.ts): `418` 行
- 这轮的价值不是简单挪代码，而是把“页面基础设施状态”从父页中剥离为独立可测模块

### 4. 新测试已经进入质量门

- [usePlmAuthStatus.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmAuthStatus.spec.ts) 覆盖：
  - token 过期窗口判断
  - `auth_token / plm_token / jwt` legacy 兼容
- [usePlmDeepLinkState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmDeepLinkState.spec.ts) 覆盖：
  - preset 保存与持久化
  - 手动 scope 变更清空 active preset
  - query sync 防抖
  - deep-link copy helper

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

- `17 files / 56 tests` 通过

## 非阻塞提示

- `apps/web` 构建仍会打印 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 的动态/静态混合导入 warning
- `apps/web` 构建仍有大 chunk warning

## 未补跑项

本轮没有新增完整 `/plm` UI regression 报告。

原因：

- 改动集中在前端内部状态模块化
- 联邦协议、SDK 协议和真实 UI 行为没有变化

当前最近一次成功基线仍是：

- [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 验证结论

这轮改动证明三件事：

1. `/plm` 的认证与深链接基础设施已经不再依赖父页内联维护
2. 这两块状态已经进入独立测试和 lint/type-check/build 门
3. `PLM product workbench` 的结构治理已经从“面板和动作拆分”继续推进到“页面基础设施模块化”
