# PLM Workbench Team Preset Clear-Default Result Design

## 背景

上一刀已经把 `BOM / Where-Used` 的 `clear default` 接入了 `runPlmLocalPresetOwnershipAction(...)`，但 composable 本身还有一个事务边界缺口：

- `usePlmTeamFilterPresets.ts` 里的 `clearTeamPresetDefault()` 成功后只写 message，不返回 surviving preset
- 页面 wrapper 的 clear-owner 条件依赖 `Boolean(result)`
- 结果是 wrapper 结构虽然补齐了，但 `clear default` 仍然拿不到 truthy result，local preset owner 依旧不会被消费

这会让页面看起来“已经接入 deferred handoff”，但运行结果仍和旧逻辑一样。

## 设计目标

1. `clearTeamPresetDefault()` 要和 `save / apply / set default / rename / transfer` 一样返回 canonical success/null。
2. page wrapper 继续只根据 composable result 决定是否 clear 本地 owner。
3. blocked path、archived no-op、失败 path 都返回 `null`，避免误 clear。

## 方案

在 `usePlmTeamFilterPresets.ts` 中把 `clearTeamPresetDefault()` 改成显式事务结果：

- 无选中 preset：`return null`
- pending management drift：`return null`
- `canClearTeamPresetDefault=false`：`return null`
- 调用成功：`return saved`
- catch：`return null`

这样 page wrapper 的：

- `shouldClearLocalPresetOwnerAfterTeamPresetAction('clear-default', saved)`

就能拿到和其它 team-preset action 一致的 canonical result。

## 结果

修复后，`clear default` 终于真正完成了和其它 team-preset action 一致的 takeover 事务：

- composable 成功返回 surviving preset
- 页面 wrapper 按结果消费 local owner
- 失败或 no-op 时不清本地 owner
