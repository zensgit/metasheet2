# PLM Workbench Panel Owner Hydration Takeover Design

## 背景

`PlmProductView.vue` 在 route hydration 时会把显式的 `workbenchTeamView / documentTeamView / cadTeamView / approvalsTeamView` 从 query 回灌到 `...TeamViewQuery`，再交给对应 `usePlmTeamViews(...)` 处理。

## 问题

如果页面本地 selector 仍停在旧 owner `A`，而外部 deep-link / 站内跳转把 route owner 改成了 `B`：

- hydration 只会更新 `...TeamViewQuery`
- 本地 `...TeamViewKey / ...TeamViewName / ...TeamViewOwnerUserId` 还保留旧的 `A`
- `usePlmTeamViews(...)` 会把 `B` 识别成 requested owner，并进入 pending-apply 分支
- 但真正的 route takeover 不会发生，因为本地 selector 并没有被 authoritative 地清掉

结果就是 canonical route 已经是 `B`，但本地管理状态仍挂在 `A`，页面进入假的 pending drift。

## 设计决策

- 保持 `usePlmTeamViews(...)` 现有“本地 selector pending apply”语义不变
- 只把“route hydration 读到显式 owner，且与本地 selector 不一致”这条路径提升为 authoritative takeover
- authoritative takeover 时统一清掉：
  - `teamViewKey`
  - `teamViewName`
  - `teamViewOwnerUserId`
  - 当前 `teamViewSelection`

## 实现

- 新增纯 helper：`resolvePlmHydratedTeamViewOwnerTakeover(...)`
- `PlmProductView.vue` 在读取 4 条 panel owner query 时统一调用 `applyHydratedTeamViewOwnerTakeover(...)`
- 只有 route owner 与本地 selector 不同，才会触发清理；同 owner 或 route 无 owner 时不动本地状态

## 预期结果

- 显式 deep-link `A -> B` 时，旧 selector 不会把 `B` 卡成假的 pending target
- hydration 后 refresh/default/requested owner 可以按 canonical route 正常接管
- 既有本地 pending selector 语义不被破坏
