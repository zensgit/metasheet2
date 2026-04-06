# Multitable Sheet ACL Attachment Read Verification

Date: 2026-04-06

## Targeted commands

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-attachments.api.test.ts
pnpm --filter @metasheet/core-backend build
pnpm lint
pnpm type-check
```

## Expected coverage

- `GET /api/multitable/attachments/:attachmentId` succeeds for sheet `spreadsheet:read`
- `GET /api/multitable/attachments/:attachmentId` succeeds for sheet `spreadsheet:write-own`
- `GET /api/multitable/attachments/:attachmentId` still rejects non-readable grants
- Existing upload/download and delete attachment flows remain green

## Result

- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-attachments.api.test.ts` passed
- `pnpm --filter @metasheet/core-backend build` passed
- `pnpm lint` passed
- `pnpm type-check` passed
