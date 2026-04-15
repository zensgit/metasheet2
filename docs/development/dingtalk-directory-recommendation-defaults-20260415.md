# DingTalk Directory Recommendation Defaults

## Goal

继续把目录 review queue 做成“推荐优先”的管理员操作面。

本轮目标：

- 当 `pending_binding` 队列里存在可直接确认的推荐项时，默认进入“可推荐处理”视图。
- 在推荐视图下，首次加载自动选中当前可见的推荐项，减少管理员重复勾选。
- 管理员一旦显式切到“需人工处理”，刷新队列时要保留这个选择，不能被默认逻辑覆盖。
- 前端不再根据 `recommendations.length` 自己推导“是否可确认推荐”，只信任后端返回的 `actionable.canConfirmRecommendation`。

## Implementation

### Frontend

- 在 `apps/web/src/views/DirectoryManagementView.vue` 将 `pendingBindingView` 默认值调整为 `recommended`。
- 增加 `pendingBindingViewTouched`，用于区分“系统默认选择”与“管理员手动切换”。
- 调整 `syncPendingBindingQueueDefaults()`：
  - 无待绑定项时回退到 `all`，并清空选中项。
  - 有推荐项时默认进入 `recommended`。
  - 无推荐项但仍有待绑定项时回退到 `manual`。
  - 已显式切到 `manual` 的情况下，刷新队列时保持 `manual`，除非当前视图已失效。
  - 仅在推荐视图且当前没有任何选择时，自动选中当前可见推荐项。
- 调整 review item payload 归一化逻辑：
  - `canConfirmRecommendation` 只接受后端显式返回的 `true`。
  - 不再使用 `recommendations.length > 0` 做前端推导。
- 加固 `selectedRecommendedReviewBindEntries`，只处理同时满足“已选中 + 后端允许确认推荐 + recommendation 非空”的条目，避免空数组访问。

### Tests

更新前端测试 `apps/web/tests/directoryManagementView.spec.ts`：

- `filters review queue by recommendation readiness and selects visible recommended items`
  - 覆盖默认进入推荐视图。
  - 覆盖首次加载自动选中推荐项。
  - 覆盖 `可推荐处理 / 需人工处理` 切换。
- `keeps the manual review view on queue refresh after the user explicitly switches to it`
  - 覆盖管理员显式切到人工视图后，刷新队列仍保持人工视图。
- `batch-confirms recommended pending bindings`
  - 按新语义补齐推荐 fixture 的 `actionable.canConfirmRecommendation`，保证批量确认测试与后端契约一致。

## Verification

通过：

```bash
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

`Claude Code CLI` 只读核对结论：

- 推荐默认流仍是前端行为，没有扩展后端接口。
- 页面已只依赖 `actionable.canConfirmRecommendation`，不再从 `recommendations` 长度推导。

## Notes

本轮没有变更后端推荐规则：

- 仍然只使用唯一精确邮箱/手机号匹配。
- 仍然要求后端显式判定该项是否允许“确认推荐”。

这样可以避免前端和后端在推荐资格上的语义漂移。
