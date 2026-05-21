# T3C-2c API Token Manager I18n Verification

Date: 2026-05-20

Branch: `codex/multitable-t3c2c-api-token-i18n-20260520`

## Definition Of Done

| Gate | Status |
| --- | --- |
| Target label/helper spec passes | PASS |
| API token manager component spec passes | PASS |
| `vue-tsc --noEmit` | PASS |
| `pnpm --filter @metasheet/web build` | PASS |
| `git diff --check` and `git diff --check origin/main..HEAD` | PASS |
| Raw enum/data attributes preserved | PASS via component spec |
| Shared action helper redeclare avoided | PASS via code review |

## Target Test Evidence

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-api-token-labels.spec.ts \
  tests/multitable-api-token-manager.spec.ts \
  --watch=false
```

Result:

```text
✓ tests/meta-api-token-labels.spec.ts  (8 tests)
✓ tests/multitable-api-token-manager.spec.ts  (26 tests)

Test Files  2 passed (2)
Tests       34 passed (34)
```

## Coverage Notes

`meta-api-token-labels.spec.ts` covers:

- Static en/zh label lookup.
- Full/reduced manager title variants.
- Known token scope localization and unknown scope raw preservation.
- Known webhook event localization and unknown event raw preservation.
- Webhook status/action/delivery labels.
- DingTalk enabled/disabled, secret-state, scope, and delivery-source helpers.
- Unknown DingTalk delivery source raw preservation.

`multitable-api-token-manager.spec.ts` covers:

- Existing token, webhook, and DingTalk group manager behavior.
- `zh-CN` render assertions across API token, webhook, and DingTalk group tabs.
- Raw `data-token-scope`, `data-webhook-event`, `data-webhook-status`, and `data-dingtalk-group-status` preservation.
- User data/raw payload preservation for token name/prefix, webhook URL, DingTalk group name, masked access token, delivery subject, and HTTP status.

## Scope Audit

Expected PR files:

```text
apps/web/src/multitable/components/MetaApiTokenManager.vue
apps/web/src/multitable/utils/meta-api-token-labels.ts
apps/web/tests/meta-api-token-labels.spec.ts
apps/web/tests/multitable-api-token-manager.spec.ts
docs/development/multitable-t3c2c-api-token-manager-i18n-design-20260520.md
docs/development/multitable-t3c2c-api-token-manager-i18n-verification-20260520.md
```

Out-of-scope paths intentionally untouched:

```text
packages/core-backend/**
plugins/plugin-attendance/**
plugins/plugin-integration-core/**
lib/adapters/k3-wise-*
apps/web/src/multitable/components/MetaAutomationRuleEditor.vue
apps/web/src/multitable/components/MetaFormShareManager.vue
apps/web/src/multitable/components/MetaRecordPermissionManager.vue
```

## Final Gate Output

```text
pnpm --filter @metasheet/web exec vue-tsc --noEmit: PASS (exit 0, no output)
pnpm --filter @metasheet/web build: PASS (Vite build completed; existing chunk-size warnings only)
git diff --check: PASS (exit 0)
git diff --check origin/main..HEAD: PASS (exit 0)
```
