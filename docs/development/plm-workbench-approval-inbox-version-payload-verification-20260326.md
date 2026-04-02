# PLM Workbench Approval Inbox Version Payload Verification

## Scope

验证 approval inbox 现在会按后端 optimistic-lock contract 构造 action payload。

## Focused Checks

1. [plmApprovalInboxActionPayload.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmApprovalInboxActionPayload.spec.ts)
   - approve 空 comment 仍可提交，但 payload 包含 `version`
   - approve 带 comment 时 payload 包含 `version + comment`
   - reject 空 comment 时 helper 仍只返回 `version`
   - reject 带 reason 时 payload 包含 `version + reason + comment`

2. Type-check
   - 因为 helper 签名改成必传 `version`，所有调用点必须显式传版本号

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmApprovalInboxActionPayload.spec.ts
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused spec 通过
- web type-check 通过
- 前端全量 spec 继续通过
