# PLM Workbench Audit Scene Takeover Form Draft Verification

## Scope

Verified the `audit scene context takeover` fix that now clears managed team-view form drafts while preserving create-mode drafts.

## Focused Checks

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmAuditSceneContextTakeover.spec.ts tests/plmAuditTeamViewOwnership.spec.ts
```

Result:

- `2` files passed
- `22` tests passed

Locked behavior:

- scene takeover clears managed rename/owner drafts
- create-mode drafts remain available
- shared-entry consumption and collaboration cleanup remain unchanged

## Type Check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Outcome

`audit scene context takeover` now matches the rest of the authoritative takeover flows instead of leaving stale team-view management drafts behind.
