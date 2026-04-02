# PLM Workbench Transfer Readonly Draft Cleanup Verification

## Scope

Verify that successful transfers clear stale management drafts when the returned team view or team preset is no longer manageable.

## Checks

1. Updated `usePlmTeamViews.ts` so readonly post-transfer targets clear `teamViewName` and `teamViewOwnerUserId`.
2. Updated `usePlmTeamFilterPresets.ts` so readonly post-transfer targets clear `teamPresetName`, `teamPresetGroup`, and `teamPresetOwnerUserId`.
3. Extended focused transfer success tests in:
   - `apps/web/tests/usePlmTeamViews.spec.ts`
   - `apps/web/tests/usePlmTeamFilterPresets.spec.ts`
4. Ran focused tests.
5. Ran web type-check.
6. Ran the PLM web regression suite.

## Result

All checks passed. Successful transfers into readonly targets no longer retain stale management drafts.
