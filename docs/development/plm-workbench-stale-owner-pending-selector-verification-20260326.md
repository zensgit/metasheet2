# PLM Workbench Stale Owner Pending Selector Verification

## Focused Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
```

Expected:

- stale route owners are cleared on refresh
- pending selector targets are not promoted into active management targets
- related drafts are cleared with the selector reset
- pending apply / duplicate flows that are still valid continue to work

## Type Validation

Command:

```bash
pnpm --filter @metasheet/web type-check
```

## Regression Validation

Command:

```bash
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- PLM workbench, preset, and audit suites remain green after the refresh ownership cleanup change
