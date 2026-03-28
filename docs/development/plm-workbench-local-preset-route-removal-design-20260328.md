# PLM Workbench Local Preset Route Removal Design

## Problem

`BOM / Where-Used` 本地 preset 的 external route hydration 已经覆盖了 `A -> B` takeover，但还漏掉了 `A -> none`。

当前 `applyQueryState()` 只在 route query 里仍然带着 `bomFilterPreset / whereUsedFilterPreset` 时才会进入 hydration cleanup。若外部 deep-link 或浏览器回退把这个 key 直接删掉：

- 内存里的 `bomFilterPresetQuery / whereUsedFilterPresetQuery` 仍保留旧值
- 同一轮 `applyQueryState()` 后半段的“如果 query owner 存在则重放 preset”分支会继续执行
- 结果是刚被 URL 去掉的 local owner 会被旧内存值复活

## Design

- 在 `applyQueryState()` 里为 `bomFilterPresetParam === undefined`、`whereUsedFilterPresetParam === undefined` 增加对称分支。
- 该分支不再等待后续逻辑偶然收口，而是直接走 `resolvePlmLocalFilterPresetRouteIdentity(...)`：
  - `routePresetKey` 使用当前内存里的旧 owner
  - `activePreset` 明确传 `null`
  - 其余 selector / drafts / selection / batchGroup 按现有 missing-owner 合同一起清理
- route removal 后立即把 `...FilterPresetQuery` 清空，确保本轮 `applyQueryState()` 不会再重放旧 owner。

## Expected Outcome

外部 route 把本地 preset owner 去掉时，页面会把旧 local owner authoritative 地消费掉，不再出现“URL 已无 owner，但页面又把旧 preset 套回来”的复活行为。
