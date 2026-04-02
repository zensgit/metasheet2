# PLM Workbench Approval History Feedback Parity Verification

## Scope

Verify that `Approval Inbox` history loading now uses the same structured error feedback contract
as approval actions.

## Checks

1. Focused helper regression:
   - `pnpm --filter @metasheet/web exec vitest run tests/plmApprovalInboxFeedback.spec.ts`
2. Frontend type-check:
   - `pnpm --filter @metasheet/web type-check`
3. Frontend PLM regression sweep:
   - `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Results

- Shared helper returns nested structured error messages when JSON payloads are available.
- Shared helper falls back to `status statusText` when the response body is unreadable.
- `ApprovalInboxView.vue` compiles and consumes the shared helper without local duplication.
