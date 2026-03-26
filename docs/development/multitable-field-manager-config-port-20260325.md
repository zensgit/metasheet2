# Multitable Field Manager Config Port

Date: 2026-03-25

## Goal

Port the richer `MetaFieldManager` flow from the old multitable worktree into the clean mainline, then push it one step further with the same clean live-refresh cue pattern already added to `MetaViewManager`.

## Problem

Before this round, the clean mainline still had a simplified field manager:

- no config UI for `select / link / person / lookup / rollup / formula / attachment`
- no dirty-draft discard guard for config switching / close / rename switching
- no stale-type protection while upstream metadata changed
- no focused field-manager regression file at all

That left the clean mainline below the old multitable worktree in a real user-facing area, even though view-manager parity had already been restored.

## Design

### 1. Port the richer field-manager config surface

File:
[MetaFieldManager.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaFieldManager.vue)

The clean mainline field manager now supports:

- `select` option editing
- `link` target-sheet + single-record limit
- `person` preset-specific limit toggle
- `lookup` config
- `rollup` config
- `formula` expression + field token insert
- `attachment` max-files + accepted mime types

It also restores:

- close / rename / config-target discard guards
- stale config detection
- reload-latest handling
- field-type drift blocking

### 2. Port the full field-config helpers

File:
[field-config.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/utils/field-config.ts)

The helper module now includes the normalized parsers and adapters required by the richer manager:

- select options
- link
- lookup
- rollup
- formula
- attachment

This keeps the manager-side config logic centralized instead of inlining field-property parsing in the component.

### 3. Reconnect workbench field management to rich property payloads

File:
[MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue)

The workbench now:

- passes `sheets` into `MetaFieldManager`
- accepts `property` payloads from `create-field`
- accepts `property` payloads from `update-field`
- merges person-field manager overrides into the prepared people preset before creating the actual hidden `link` field

This keeps the `person` shortcut aligned with the richer manager UI instead of throwing away its config payload.

### 4. Exceed old-worktree parity with clean live-refresh cues

The old worktree already had dirty-draft stale protection, but not a positive cue for safe automatic refresh.

The clean mainline now adds:

- `Latest field metadata loaded from the sheet context.`
- dismissible info cue for clean-draft upstream refreshes
- suppression of that cue whenever the draft is already dirty

That means the clean mainline now exceeds the old field-manager UX instead of just matching it.

## Files Changed

- [MetaFieldManager.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaFieldManager.vue)
- [field-config.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/utils/field-config.ts)
- [MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue)
- [multitable-field-manager.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-field-manager.spec.ts)
- [multitable-workbench-view.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts)

## Verification

Executed in:
[metasheet2-multitable-next](/Users/huazhou/Downloads/Github/metasheet2-multitable-next)

### Frontend typecheck

```bash
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result: passed

### Focused frontend regressions

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-workbench-manager-flow.spec.ts \
  --reporter=dot
```

Result:

- `3 files / 17 tests passed`

Coverage in this run includes:

- configured field creation
- attachment property save
- new-field config gating after cancel
- stale link target rejection after sheet list drift
- clean live-refresh cue
- dirty stale reload flow
- close guard
- field-type drift blocking
- person preset property merge in the workbench

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result: passed

Observed warning:

- Vite large chunk warning remains, but this slice did not materially change bundle structure

## Outcome

The clean multitable mainline is now ahead of the old worktree in field management:

- old worktree rich config surface is restored
- workbench property wiring is restored
- clean live-refresh cue is newly added on top

That closes one of the biggest remaining frontend parity gaps in the clean mainline multitable flow.

## Parallel Review Notes

Parallel side checks this round found:

- the old-worktree comparison still pointed at `MetaFieldManager` as the most visible remaining frontend parity gap
- the old branch already had richer field config, but did not have the new clean live-refresh cue
- Claude Code reviewer was invoked for this slice, but did not return a stable short response in the available wait window, so final acceptance remained based on local `tsc + vitest + build`

## Next

Recommended next slice:

1. Extend the same parity-and-beyond pass to `MetaImportModal`, which still lags behind the upgraded manager UX in visible stale/live-refresh feedback.
2. After that, reassess whether the old multitable worktree still contains any remaining frontend slice worth selective migration before deleting it.
