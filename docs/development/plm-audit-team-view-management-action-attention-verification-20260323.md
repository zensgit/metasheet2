# PLM Audit Team View Management Action Attention Verification

Date: 2026-03-23

## Scope

Verify that generic team-view management actions now consume stale source attention and saved-view followup state before installing a new management-owned outcome.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts
```

Result:

- `1` file passed
- `13` tests passed

Covered assertions:

- the generic managed-team-view helper clears source/local attention
- the persisted-team-view helper still matches the generic managed-team-view contract

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `257` tests passed

Note:

- Vitest printed `WebSocket server error: Port is already in use`, but the run completed successfully and all tests passed.

## Behavioral Assertions

1. `recommendation -> Save to team / Rename / Transfer owner` ends with only the management-owned focus active
2. `source focus -> Clear default / Archive / Restore / Delete` no longer leaves recommendation or saved-view source highlights behind
3. batch lifecycle actions still keep a single management anchor while clearing inherited source/local attention
