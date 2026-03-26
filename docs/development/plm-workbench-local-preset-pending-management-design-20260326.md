# PLM Workbench Local Preset Pending Management Design

## 背景

`BOM / Where-Used` 同时支持：

- 本地 `filter preset` owner
- 团队 `team preset` owner

当前页面如果仍由本地 preset 拥有过滤状态，用户可以先在 selector 里挑一个 team preset，但还不点击 `Apply`。

## 问题

现有 `usePlmTeamFilterPresets(...)` 只把“team preset requested owner != selected team preset”识别成 pending apply，对“当前 canonical owner 其实是本地 preset”没有概念。

结果是：

- `clear default / rename / share / archive / transfer` 这类 generic management action 仍然会放行
- action 成功后 wrapper 会把本地 owner 清掉
- 未 `Apply` 的 team preset 因此偷走 ownership

## 设计决策

- 不改变 `Apply` 和 `Duplicate` 的可用性
- 把“本地 preset owner 仍然 active，且当前 selector 已经选中了 team preset”提升成真正的 pending management state
- 这个状态只冻结 generic management actions，不冻结 `Apply / Duplicate`

## 实现

- `usePlmTeamFilterPresets(...)` 新增 `hasPendingExternalOwnerDrift?: () => boolean`
- composable 内部把它并入 `hasPendingManagementSelection`
- `selectedManagementTarget` 在这种状态下返回 `null`
- `PlmProductView.vue` 对 BOM / Where-Used 分别传入：
  - 本地 route preset 仍匹配当前 `field/value`
  - 且当前 team preset selector 非空

## 预期结果

- 本地 preset 仍拥有当前状态时，未应用的 team preset 不会再通过 `clear default` 等管理动作偷走 owner
- 用户如果真要切到 team preset，必须先 `Apply`
- `Apply / Duplicate` 继续保持可用
