# PLM Workbench Merge Lint Parity Design

## Background

After reconciling `codex/plm-workbench-collab-20260312` with `origin/main`, the branch became mergeable again, but GitHub Actions still failed on `Plugin System Tests / test (20.x)` during `pnpm lint`.

The failure was not behavioral. It came from stale symbols left behind by the merge:

- an unused `requestJson(...)` helper in `apps/web/src/services/plm/plmWorkbenchClient.ts`
- an unused `normalizePlmWorkbenchQuerySnapshot` import in `apps/web/src/views/PlmProductView.vue`
- two unused query-key constants in `apps/web/src/views/PlmProductView.vue`

## Goal

Restore CI parity with the repository lint gate without changing PLM runtime behavior.

## Design

### Remove dead helper code

`plmWorkbenchClient.ts` no longer uses the legacy `requestJson(...)` wrapper after the SDK runtime client migration.  
The helper should be removed instead of `_`-prefixing it, because the dead path no longer expresses any supported contract.

### Remove dead merge residue in product view

`PlmProductView.vue` already uses the newer route/query helpers. The leftover import and query-key constants are merge residue, not active behavior.  
They should be deleted so the lint gate reflects the actual runtime surface.

## Expected Outcome

- `pnpm lint` for `apps/web` passes again
- no runtime behavior changes
- branch remains ready for RC evaluation once remote checks finish
