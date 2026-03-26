# Multitable View Manager Live Refresh Cues

Date: 2026-03-25

## Goal

Make live metadata refresh in the multitable view manager visible when drafts are still clean, so the restored dialog polling does not stay completely silent.

## Problem

After restoring dialog-scoped `loadSheetMeta(...)` polling, the clean worktree correctly refreshed metadata while the manager stayed open, but users still had two uneven experiences:

- dirty drafts already surfaced a stale warning and `Reload latest`
- clean drafts silently rehydrated from the latest sheet metadata with no cue at all

That meant the safety behavior existed, but users had no indication that the manager had already refreshed itself from upstream field/view changes.

## Design

### 1. Add a clean-draft live refresh cue

File:
[MetaViewManager.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaViewManager.vue)

The manager now shows a lightweight info banner when upstream metadata changes while the current config draft is still clean:

- `Latest view metadata loaded from the sheet context.`
- `Latest field metadata loaded from the sheet context.`

This appears only when the manager can safely adopt the latest metadata without risking local edits.

### 2. Keep stale behavior unchanged for dirty drafts

If the user already has local config edits, the new info cue is suppressed and the existing stale warning stays authoritative:

- `This view changed in the background...`
- field/type-specific blocking reasons
- `Reload latest`

This avoids mixing "safe auto-refresh" and "draft is stale" messaging in the same state.

### 3. Only show the cue for real upstream changes

The manager now tracks a serialized source signature covering:

- target view identity and name
- target view `config`
- target view `groupInfo`
- current field ids / names / types

Clean rehydration only surfaces the info cue when this signature actually changes, so repeated parent rerenders do not spam the banner.

### 4. Allow manual dismissal

The info cue includes a lightweight `Dismiss` action. This keeps the refreshed state visible, but does not force the user to keep the banner around once acknowledged.

## Files Changed

- [MetaViewManager.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaViewManager.vue)
- [multitable-view-manager.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-view-manager.spec.ts)

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
  tests/multitable-view-manager.spec.ts \
  tests/multitable-workbench-manager-flow.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --reporter=dot
```

Result:

- `3 files / 18 tests passed`

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result: passed

Observed warning:

- Vite large chunk warning remains, but this slice did not materially change bundle structure

## Outcome

The clean multitable mainline now exceeds the old worktree in this area:

- old worktree had dialog refresh, but no explicit clean-refresh cue
- clean mainline now has both
  - silent protection for dirty drafts via stale warning
  - explicit info feedback for safe live refresh on clean drafts

## Parallel Review Notes

Two side checks were run in parallel:

- old-worktree scan confirmed that the highest-value old gap was workbench context sync, and that gap is already fixed in the clean mainline
- Claude Code reviewer was invoked for this slice, but did not return a stable short response in the available wait window, so final acceptance remained based on local `tsc + vitest + build`

## Next

Recommended next slice:

1. Extend the same live-refresh cue pattern to `MetaFieldManager`, which still has less explicit feedback than `MetaViewManager`.
2. Keep moving only high-value multitable polish from the old worktree when it is backed by focused regression coverage.
