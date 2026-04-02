# PLM Workbench Approval Inbox Feedback Verification

## Focused

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plmApprovalInboxActionPayload.spec.ts tests/plmApprovalInboxFeedback.spec.ts
```

Expected contract:

- approval inbox action payloads still send versioned approve/reject bodies
- refresh keeps success status only when explicitly requested
- structured backend error payloads override generic HTTP fallback text

## Type Check

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm --filter @metasheet/web type-check
```

## Full Frontend

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```
