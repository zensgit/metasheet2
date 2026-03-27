# PLM Workbench Approval Conflict Recovery Verification

## Scope

Verify that `Approval Inbox` recovers from optimistic-lock conflicts without requiring manual
refresh.

## Checks

1. Focused helper regression:
   - `pnpm --filter @metasheet/web exec vitest run tests/plmApprovalInboxFeedback.spec.ts`
2. Frontend type-check:
   - `pnpm --filter @metasheet/web type-check`
3. Frontend PLM regression sweep:
   - `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Results

- Shared helper extracts `APPROVAL_VERSION_CONFLICT` and `currentVersion` from structured payloads.
- Stale approval versions can be reconciled locally without mutating unrelated rows.
- `ApprovalInboxView.vue` compiles against the new helper contract and keeps a useful conflict
  message after refresh succeeds.
