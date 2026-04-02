# PLM Workbench Team Preset Lifecycle Draft Cleanup Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts`

This verifies:

- duplicate clears stale `name/group/owner` drafts
- rename clears stale `name/group/owner` drafts
- single restore clears stale `name/group/owner` drafts
- batch restore clears stale `name/group/owner` drafts
- archived preset transfer is blocked with a restore-first message before owner validation

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused team preset suite passes
- type-check passes
- full PLM frontend suite passes
