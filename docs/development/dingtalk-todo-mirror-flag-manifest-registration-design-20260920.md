# DINGTALK_TODO_MIRROR_* flag manifest registration — design (2026-09-20)

## Why

AGENTS.md 章程: "新增 env flag 必须登记"（`scripts/ops/global-history-flag-manifest.mjs`）。钉钉待办 B 方案
（一路镜像，#5772 0e769bc88 / #5768 c787f644f）已合入 main：consumer
`packages/core-backend/src/integrations/dingtalk/dingtalk-todo-mirror-service.ts`（实际文件路径为
`services/dingtalk-todo-mirror-service.ts`）、worker `services/dingtalk-todo-mirror-worker.ts`、迁移
`zzzz20260916120000_create_dingtalk_todo_mirrors.ts`，但其两条 env flag 从未登记到 manifest。

## 侦察（grep 全部读取点，path:line）

```
packages/core-backend/src/config/flags.ts:14        import DINGTALK_TODO_MIRROR_ENABLED
packages/core-backend/src/config/flags.ts:64         [DINGTALK_TODO_MIRROR_ENABLED]: isDingTalkTodoMirrorEnabled()
packages/core-backend/src/integrations/dingtalk/todo-mirror-flag.ts:20  export const DINGTALK_TODO_MIRROR_ENABLED = 'DINGTALK_TODO_MIRROR_ENABLED'
packages/core-backend/src/integrations/dingtalk/todo-mirror-flag.ts:23  String(env[...]).trim().toLowerCase() === 'true'
packages/core-backend/src/services/dingtalk-todo-mirror-service.ts:15   THE FLAG ... IS CHECKED FIRST AND WRITES NOTHING WHEN OFF
packages/core-backend/src/services/dingtalk-todo-mirror-worker.ts:25    FLAG: the worker is only ever constructed/started ...
packages/core-backend/src/index.ts:3924,3943,3948,3959  sink gate + worker startup gate + INTERVAL_MS read
packages/core-backend/src/multitable/automation-durable-activation.ts:59        (mention only, handler registered unconditionally)
packages/core-backend/src/multitable/automation-durable-consumer-handlers.ts:75,149  (mention only, own gate)
packages/core-backend/src/multitable/automation-routing-manifest.ts:161          (mention only, routing independent of flag)
```

Two distinct env flags read from `process.env`:

1. **`DINGTALK_TODO_MIRROR_ENABLED`** — boolean, exact-literal `'true'` (case-insensitive/trimmed via
   `isDingTalkTodoMirrorEnabled`), default OFF. Gates both sink legs (writes nothing to
   `dingtalk_todo_mirrors` when off) and the delivery worker's construction/start in `index.ts`.
2. **`DINGTALK_TODO_MIRROR_INTERVAL_MS`** — numeric, worker poll interval
   (`index.ts:3948`: `Math.max(5_000, Number(process.env.DINGTALK_TODO_MIRROR_INTERVAL_MS) || 30_000)`),
   default 30000ms, floored at 5000ms. No-op unless flag 1 is active (worker never constructed
   otherwise) — modeled as `dependsOn: ['DINGTALK_TODO_MIRROR_ENABLED']`.

`DINGTALK_TODO_MIRROR_STATUSES` (migration `zzzz20260916120000...ts:35`) is a CHECK-constraint status
vocabulary array, **not** an env var — nobody reads it from `process.env`. It is denylisted in the test's
`NON_GH_EXACT`, mirroring the existing pattern for `MULTITABLE_RECORD_APPROVAL_IN_FLIGHT_STATUSES` etc.

## What changed

1. `scripts/ops/global-history-flag-manifest.mjs` — appended two `FlagSpec` entries
   (`DINGTALK_TODO_MIRROR_ENABLED`, `DINGTALK_TODO_MIRROR_INTERVAL_MS`) following the `ELEARNING_*` entry
   shape (key/type/activationValue/dependsOn/conflictsWith/danger/purpose/source).
2. `scripts/ops/global-history-flag-manifest.test.mjs` — extended `globalHistoryFlagsInSource()` with a
   `DINGTALK_TODO_MIRROR_[A-Z_0-9]+` grep (not restricted to `*_ENABLED`, unlike the elearning grep,
   because `DINGTALK_TODO_MIRROR_INTERVAL_MS` is a real flag too) and added
   `DINGTALK_TODO_MIRROR_STATUSES` to `NON_GH_EXACT`.
3. `packages/core-backend/src/index.ts:498-507` — comment-only correction. The old comment claimed
   "there is no DingTalk 待办/todo API anywhere in this codebase to ride"; that is now stale since the
   B-plan mirror added `createDingTalkTodoTask` (client.ts). Corrected to state the todo API exists but
   is bound to exactly one ledger (the approval-seat mirror, fired by `approval.task_created`), which
   the stock-prep handoff (#5442) has no access to — so the group-only limitation still holds, for a
   different, now-accurate reason. Zero behavior change.
4. `scripts/ops/multitable-global-history-flag-status.mjs` — **no change needed**: it imports
   `GLOBAL_HISTORY_FLAG_KEYS` directly from the manifest and iterates it generically, so the two new
   keys are picked up automatically.

## Why `dependsOn` and not `conflictsWith`/a rule

`DINGTALK_TODO_MIRROR_INTERVAL_MS` is a `numeric` type. Per `isActivated()`, non-boolean specs never
"activate" and can never participate in a `requires`/`conflicts` rule evaluated by `evaluateFlagRules`
(same reason `MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS` only carries a `dependsOn` array with no
`rules` entry). `dependsOn` here is documentation only, matching that existing pattern — no new
enforcement code was needed or added.
