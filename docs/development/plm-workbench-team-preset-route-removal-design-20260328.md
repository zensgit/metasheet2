# PLM Workbench Team Preset Route Removal Design

## Problem

`BOM / Where-Used team preset` 的 external route hydration 已经覆盖了 `A -> B` owner takeover，但还漏掉了 `A -> none`。

当前 `applyQueryState()` 只在 route query 里仍然带着 `bomTeamPreset / whereUsedTeamPreset` 时才执行 hydrated owner cleanup。若外部 deep-link、浏览器回退或 reset patch 把这个 key 直接删掉：

- 内存里的 `bomTeamPresetQuery / whereUsedTeamPresetQuery` 还保留旧 owner
- 页面层默认 auto-apply blocker 仍会把它当成显式 collaborative owner
- 下一轮 query sync 还有机会把旧 owner 写回 URL

## Design

- 为 `bomTeamPresetParam === undefined`、`whereUsedTeamPresetParam === undefined` 增加对称 removal 分支。
- 新增 `resolvePlmHydratedRemovedTeamPresetOwner(...)`，按旧 owner 和本地 selector 计算 cleanup：
  - 若本地 selector 仍指向被移除的 owner，清空 selector / name / group / owner draft，并清掉 selection
  - 若用户已经切到另一个 pending selector，则只消费旧 route owner，保留 pending 管理态
- route removal 分支里同步把 `...TeamPresetQuery` 置空，确保本轮 hydration 后不会再重放旧 owner。

## Expected Outcome

外部 route 把 team preset owner 去掉时，页面会 authoritative 地消费旧 collaborative owner，不再出现“URL 已无 owner，但页面仍当它存在”的伪显式状态。
