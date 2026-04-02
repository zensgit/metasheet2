# PLM Workbench Team Preset Pending Apply Gating Verification

## Scope

Verify that `usePlmTeamFilterPresets()` now matches the pending-apply ownership semantics already enforced by `usePlmTeamViews()`.

## Focused Coverage

Added coverage in `/apps/web/tests/usePlmTeamFilterPresets.spec.ts` for:

- blocking generic management actions until the pending preset selector target is applied
- hiding readonly management controls while the pending target remains applyable
- allowing duplication of the pending selector target before apply
- allowing apply of the pending selector target while generic management remains frozen

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- Focused preset hook tests pass
- workspace type-check passes
- full PLM web test sweep stays green

## Result

- `tests/usePlmTeamFilterPresets.spec.ts`: `24` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`: `53` files / `387` tests passed
