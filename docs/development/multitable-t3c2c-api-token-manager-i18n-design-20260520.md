# T3C-2c API Token Manager I18n Design

Date: 2026-05-20

Branch: `codex/multitable-t3c2c-api-token-i18n-20260520`

## Decision Summary

T3C-2c localizes the `MetaApiTokenManager.vue` chrome to zh-CN while preserving raw product data, persisted enum values, token material, URLs, backend error messages, and existing accessibility structure.

This slice covers three surfaces in one component:

| Surface | Scope |
| --- | --- |
| API Tokens | Tabs, form labels/placeholders, scope display, empty/loading states, token action labels, token meta labels |
| Webhooks | Form/list chrome, known event labels, status labels, delivery panel chrome, delivery result labels |
| DingTalk Groups | Scope note, group form chrome, validation fallback copy, group status/meta labels, delivery panel chrome |

## Files In Scope

| File | Purpose |
| --- | --- |
| `apps/web/src/multitable/components/MetaApiTokenManager.vue` | Wire labels into the API token, webhook, and DingTalk group manager chrome |
| `apps/web/src/multitable/utils/meta-api-token-labels.ts` | New T3C-2c label module and enum-display helpers |
| `apps/web/tests/meta-api-token-labels.spec.ts` | Unit coverage for static labels and helper behavior |
| `apps/web/tests/multitable-api-token-manager.spec.ts` | Existing component spec plus zh-CN render assertions and raw-boundary checks |

Out of scope:

| Surface | Reason |
| --- | --- |
| `MetaAutomationRuleEditor.vue` | T3D automation domain |
| Backend/API contracts | This is frontend chrome-only i18n |
| Token/webhook/DingTalk user-authored names and URLs | User data must remain raw |
| Backend `err.message` | Server-provided messages remain raw; only frontend fallback strings are localized |

## Label Module

New module:

`apps/web/src/multitable/utils/meta-api-token-labels.ts`

The module exports:

| Export | Role |
| --- | --- |
| `apiTokenLabel(key, isZh)` | Static chrome lookup |
| `apiManagerTitle(canManageDingTalkGroups, isZh)` | Title variant for full vs reduced permission mode |
| `apiScopeLabel(scope, isZh)` / `apiScopesText(scopes, isZh)` | Known token scopes localized; unknown scopes preserved raw |
| `apiWebhookEventLabel(event, isZh)` / `apiWebhookEventsText(events, isZh)` | Known webhook events localized; unknown events preserved raw |
| `apiWebhookStatusLabel(active, isZh)` | Webhook enabled/disabled display |
| `apiToggleLabel(active, isZh)` | Webhook enable/disable action text |
| `apiDingTalkEnabledLabel(enabled, isZh)` | DingTalk group enabled/disabled display |
| `apiDingTalkToggleLabel(enabled, isZh)` | DingTalk group enable/disable action text |
| `apiDeliveryResultLabel(success, isZh)` | Delivery success/failure display |
| `apiDingTalkScopeLabel(scope, ids, isZh)` | DingTalk scope label while preserving raw IDs |
| `apiDingTalkSecretStateLabel(hasSecret, isZh)` | SEC secret configured/not configured display |
| `apiDingTalkDeliverySourceLabel(sourceType, isZh)` | Known DingTalk delivery source labels; unknown source types preserved raw |

Shared manager actions continue to come from `meta-manager-labels.ts`:

| Shared key | Used for |
| --- | --- |
| `action.cancel` | Cancel buttons |
| `action.delete` | Delete buttons |
| `action.dismiss` | Dismiss new-token panel |

This avoids redeclaring shared action helpers inside the T3C-2c domain.

## Raw Boundary

The following values stay raw and must not be translated:

| Category | Examples |
| --- | --- |
| Persisted enum/data attributes | `data-token-scope="read"`, `data-webhook-event="record.created"`, `data-webhook-status="active"`, `data-dingtalk-group-status="enabled"` |
| User-authored names | Token names, webhook names, DingTalk group names |
| Sensitive/token material | New token plaintext, token prefix, DingTalk `access_token`, SEC secret state values |
| URLs and IDs | Webhook URLs, masked DingTalk robot URLs, `sheetId`, `orgId` |
| Delivery payloads | Delivery subject/content, HTTP status, timestamps |
| Backend error messages | `err.message` when supplied by API client |

Frontend fallback strings are localized through the label module.

## Test Plan

Run from repo root:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-api-token-labels.spec.ts \
  tests/multitable-api-token-manager.spec.ts \
  --watch=false
```

Expected coverage:

| Spec | Assertions |
| --- | --- |
| `meta-api-token-labels.spec.ts` | Static labels, known enum mapping, unknown enum raw preservation, DingTalk scope/source helpers |
| `multitable-api-token-manager.spec.ts` | Existing English behavior plus zh-CN render assertions across all three tabs |

Additional gates:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

## Acceptance Criteria

- API token manager title, tabs, form chrome, empty/loading states, validation fallbacks, action labels, and delivery panels render in zh-CN when locale is `zh-CN`.
- Existing English behavior remains unchanged when locale is `en`.
- Raw enum/data attributes remain unchanged and are asserted in component tests.
- Unknown token scopes, webhook events, and DingTalk delivery source types remain raw.
- No backend/API contract, migration, K3, or attendance code is touched.
