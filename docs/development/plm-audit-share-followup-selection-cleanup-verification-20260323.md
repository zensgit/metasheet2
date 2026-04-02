# PLM Audit Share Followup Selection Cleanup Verification

## Scope

Verify that share followups do not inherit draft-owned batch selection residue.

## Focused Checks

### Collaboration selection reducer

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- clears single-row auto selection when a share followup replaces the draft
- preserves multi-row selection if the user already changed it
- leaves non-share followups unchanged

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `36` tests passed
- full PLM/frontend Vitest: `46` files / `291` tests passed
