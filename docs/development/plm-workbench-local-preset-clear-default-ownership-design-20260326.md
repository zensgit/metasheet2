# PLM Workbench Local Preset Clear-Default Ownership Design

## 背景

`BOM / Where-Used` 面板上的本地过滤预设和团队过滤预设共存。页面层已经把大多数 team preset action 包进了 `runPlmLocalPresetOwnershipAction(...)`，确保只有团队 preset 真正接管当前过滤状态时，才会清掉本地 owner：

- `bomFilterPreset`
- `whereUsedFilterPreset`

但 `clear default` 仍然是一个漏口：

- `usePlmTeamFilterPresets.ts` 里的 `clearTeamPresetDefault()` 在成功后会继续返回 surviving preset target
- `PlmProductView.vue` 之前却直接暴露了 `clearBomTeamPresetDefault` / `clearWhereUsedTeamPresetDefault`
- 结果是 `set default` 会清本地 owner，`clear default` 不会

这会产生不对称 takeover：

1. 当前 BOM/Where-Used 过滤仍由本地 preset owner 驱动。
2. 用户切到另一条 default team preset。
3. 执行 `Clear default` 后，surviving team preset 仍然是当前目标。
4. 页面没有消费本地 owner，后续 refresh / route hydration 还会回退到旧本地 preset。

## 设计目标

1. `clear default` 和 `set default / apply / rename / transfer` 一样，遵守同一套 local-owner handoff 合同。
2. 只有 `clear default` 成功且存在 surviving target 时才清本地 owner。
3. 不改变 `usePlmTeamFilterPresets.ts` 现有成功/失败语义。

## 方案

### 1. 扩展 local ownership action kind

在 `plmLocalPresetOwnership.ts` 的 `PlmLocalPresetTeamPresetActionKind` 中补入：

- `clear-default`

并继续复用既有规则：

- destructive `archive / batch-archive / batch-delete` 默认不 clear
- 其它成功且返回 truthy result 的 action 默认 clear

### 2. page wrapper 补齐 clear-default handoff

在 `PlmProductView.vue` 中，BOM / Where-Used 的 `clearTeamPresetDefault` 不再直连 composable，而是像其它 team-preset action 一样改成 wrapper：

- 调用 `clearBomTeamPresetDefaultBase()` / `clearWhereUsedTeamPresetDefaultBase()`
- 通过 `runPlmLocalPresetOwnershipAction(...)`
- 使用 `shouldClearLocalPresetOwnerAfterTeamPresetAction('clear-default', saved)`

这样成功后会消费本地 owner，失败或无结果则保留。

## 结果

修复后，`clear default` 的 takeover 语义与其它 team preset action 保持一致：

- 成功 reapply surviving team preset：清本地 owner
- 失败 / no-op：保留本地 owner

页面不会再留下“team preset 已接管，但 local preset owner 还活着”的双 owner 状态。
