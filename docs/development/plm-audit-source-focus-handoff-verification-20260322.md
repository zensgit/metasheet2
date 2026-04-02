# PLM Audit Source Focus Handoff Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that `focus-source` now replaces transient source attention instead of merging with stale recommendation or saved-view focus, while preserving the existing collaboration provenance contract.

## Focused Checks

Commands:

```bash
cd apps/web
pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
pnpm --filter @metasheet/web type-check
```

Checks:

- shared attention helper clears old management/source focus before applying the next source focus
- anchor-only `scene-context` source intent remains explicit
- recommendation and saved-view provenance still restore the expected source target
- `PlmAuditView.vue` still compiles after switching the `focus-source` branch to the shared helper

## Full PLM Frontend Regression

Command:

```bash
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` test files passed
- `239` tests passed

## Results

- `cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts`
  - passed, `2 files / 31 tests`
- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - passed, `43 files / 239 tests`

## Verified Paths

1. recommendation followup `focus-source` clears stale saved-view/source residue before restoring the recommendation card
2. saved-view promotion followup `focus-source` clears stale recommendation residue before restoring the saved-view card
3. scene-context `focus-source` clears stale recommendation/saved-view residue and only scrolls back to the source anchor
4. anchor-only followups still preserve the intended recommendation filter contract by not mutating filters unless the intent explicitly carries one

## Notes

- This slice is frontend-only.
- No browser-level replay was added.
- Confidence comes from helper coverage, collaboration intent coverage, `vue-tsc`, and the full PLM frontend regression suite.
