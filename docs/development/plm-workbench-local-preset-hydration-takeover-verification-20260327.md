# PLM Workbench Local Preset Hydration Takeover Verification

## Focused Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmHydratedLocalFilterPresetTakeover.spec.ts tests/plmWorkbenchViewState.spec.ts
```

Result:

- passed

Focused coverage added:

- external local preset route `A -> B` clears the stale selector and local drafts
- same-owner hydration preserves the current local selector state

## Type Validation

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Frontend Regression Sweep

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- passed
