# Attendance Custom Template Validation Verification

Date: 2026-01-29

## Validation
- `pnpm --filter @metasheet/web build`

## UI Checklist (post-deploy)
- Invalid field name blocks save and shows error with rule ID/index.
- Invalid operator/value type shows clear error message.
- Allowed fields/operators save successfully.

## Result
- Local build: PASS
- UI validation: pending after deploy
