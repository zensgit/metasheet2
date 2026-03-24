# PLM Audit External Scene-Context Takeover Design

## Problem

本地 scene banner / scene token 动作已经会把页面带进 scene-context takeover cleanup：

- 清 attention
- 清 collaboration draft / followup / 单行 selection
- 清 management-owned form draft
- 必要时消费 `auditEntry=share`

但浏览器回退、外部 deep link、以及其他非本地 `syncRouteState(...)` 触发的 route pivot 仍然只走 `route.query` watcher。只要 canonical `teamViewId` 没变，旧的 collaboration owner 和 management form draft 就会继续留在页面上；如果 URL 还带着 `auditEntry=share`，refresh 分支甚至会把刚清掉的 shared-entry owner 再装回来。

## Design

- 在 `plmAuditSceneContext.ts` 中新增纯 helper：
  - `isPlmAuditSceneContextActive(...)`
  - `shouldTakeOverPlmAuditSceneContextOnRouteChange(...)`
- 这条 predicate 只在“外部 route 进入或切换 scene-context”时返回 `true`：
  - 非 scene-context -> scene-context
  - scene A -> scene B
  - owner-context <-> scene-query-context
  - 不覆盖 scene-context 内部仅分页/过滤变化
- `PlmAuditView.vue` 的 `route.query` watcher 检测到这类外部 scene-context takeover 时，复用已有 `applySceneContextTakeoverCleanup(...)`：
  - 清 attention / saved-view followup / collaboration draft / followup
  - 清 management-owned form draft
  - 对齐 selector 到新的 route owner
- 如果这次 cleanup 返回 `consumeSharedEntry: true`，watcher 还会显式 `replace` 当前 route，消费掉 `auditEntry=share` marker，避免 refresh 重新激活 shared-entry notice。

## Expected Outcome

- 外部 scene-context route pivots 和本地 scene banner 动作共享同一套 takeover 合同。
- scene-context route 不再残留旧 collaboration owner 或 management form draft。
- stale `auditEntry=share` marker 不会在 scene takeover 后通过 refresh 把 shared-entry notice 复活。
