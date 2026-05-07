# DingTalk Group Failure Alert To Rule Creator - Development & Verification

Date: 2026-05-07

## Goal

Add an operator-facing failure alert option for DingTalk group robot automations. The user who creates/configures the rule should be able to opt in to receiving a DingTalk work notification when group robot delivery fails.

## Development

- Added `notifyRuleCreatorOnFailure` to DingTalk group message action config.
- Added UI checkboxes in the inline automation manager and advanced rule editor:
  - `Notify me if DingTalk group delivery fails`
- When enabled, failed DingTalk group delivery attempts trigger a rule-creator alert flow:
  - The backend resolves the rule creator's linked DingTalk account.
  - If linked and active, it sends a DingTalk work notification to the creator.
  - If not linked or inactive, it records a skipped DingTalk person delivery so the missed alert is auditable.
- The group delivery failure itself remains recorded in `dingtalk_group_deliveries`.
- The alert delivery is recorded in `dingtalk_person_deliveries`.
- Added regression coverage for both alert outcomes:
  - creator not linked/inactive: alert is recorded as `skipped`;
  - creator linked/active: alert is sent through DingTalk work notification and recorded as `success`.
- The inline automation manager now saves the opt-in flag and the rule list summary shows `Failure alerts: rule creator` when enabled.
- New DingTalk group robot automation rules now default this option to enabled in the inline manager, advanced rule editor, and backend API normalization path. Existing rules still keep their saved value when edited, so legacy rules are not silently upgraded.
- API-created DingTalk group rules that omit `notifyRuleCreatorOnFailure` are normalized to `true`; explicitly passing `false` still disables the alert.
- PATCH/update normalization preserves existing DingTalk group rules that do not already have this flag. If a rule is newly switched from another action type into `send_dingtalk_group_message`, the flag defaults to `true`.
- PATCH/update normalization also preserves legacy V1 rules where the top-level action is stale but `actions[]` already contains a DingTalk group action.
- Added route-layer coverage so the public API also defaults new group rules to creator failure alerts while preserving existing top-level and V1 group actions without the saved flag.
- Added advanced manager save coverage so reopening and saving a legacy V1 DingTalk group rule does not accidentally write `notifyRuleCreatorOnFailure` back into `actionConfig` or `actions[].config`.
- Fixed explicit opt-out from the frontend create/edit paths: when a user unchecks the creator failure alert option, the frontend now sends `notifyRuleCreatorOnFailure: false` instead of omitting the field and letting backend create defaults re-enable it.
- Added executor coverage proving explicit opt-out still records the failed group delivery but does not resolve the rule creator, does not send a DingTalk work notification, and does not write a `dingtalk_person_deliveries` row.
- Added route-layer coverage proving API create requests that explicitly pass `notifyRuleCreatorOnFailure: false` are not overwritten by the backend default-on behavior.
- Added update-path coverage proving explicit `notifyRuleCreatorOnFailure: false` is preserved when switching an existing rule into a DingTalk group action, including V1 `actions[]` normalization.
- Added direct `AutomationService.updateRule` coverage proving explicit disabled creator failure alerts are preserved in persisted top-level action config and V1 `actions[]` payloads.
- Added direct service and API PATCH coverage proving omitted `notifyRuleCreatorOnFailure` defaults to `true` when an existing rule is switched into a DingTalk group action.
- Added runtime coverage for the linked-creator but failed DingTalk work-notification branch, proving the group failure remains recorded and the creator alert is audited as `failed`.
- Added a deployment-side probe for 142 acceptance evidence:
  - `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
  - `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
  - `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- Added `--record-id` probe filtering so explicit opt-out acceptance can verify the current failed group delivery without being confused by older creator-alert history for the same rule.
- Hardened the deployment-side probe so argument/auth/API/rule-selection fatal failures still write redaction-safe `summary.json` and `summary.md` evidence.
- Added safe rule-selection details to probe summaries so ambiguous, missing,
  or absent group-rule blockers include rule ids/names for the next rerun.
- Added deployed API failure details to probe summaries so 403/404/timeout/network
  blockers identify the failing API path, with redacted response body where available.
- Added delivery API `recordId` filtering and updated the probe to pass
  `recordId` into backend history reads before `limit` is applied.
- Added a probe guard so disabled selected rules return `RULE_DISABLED`
  instead of passing from stale historical delivery evidence.
- Added `--alert-subject` so customized or localized creator-alert subjects can
  be validated without code changes.

## Answer To "Can I Receive Failure Info?"

Yes, after enabling this new option on the DingTalk group automation rule, "I" means the rule creator (`createdBy` / `ruleCreatedBy`). The creator can receive a DingTalk work notification when the group robot send fails, provided that creator has an active linked DingTalk account. If the creator is not linked, the failed alert attempt is recorded as skipped.

## Files Changed

- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`
- `packages/core-backend/tests/unit/dingtalk-group-delivery-service.test.ts`
- `packages/core-backend/tests/unit/dingtalk-person-delivery-service.test.ts`
- `packages/core-backend/tests/integration/dingtalk-delivery-routes.api.test.ts`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-enabled-rule-guard-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-alert-subject-config-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`

## Verification

Targeted backend automation test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

Coverage includes the linked-creator success path, linked-creator failed work-notification path, explicit opt-out execution path, backend default-normalization coverage, update-preservation coverage, V1 legacy-action preservation coverage, and direct `updateRule` coverage.

Targeted backend DingTalk automation route test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
```

Result: passed, 36 tests.

Targeted frontend advanced editor test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false
```

Result: passed, 64 tests.

Targeted frontend automation manager test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
```

Result: passed, 73 tests.

Latest coverage includes inline save of `notifyRuleCreatorOnFailure` and list-summary display of `Failure alerts: rule creator`.

Latest coverage also asserts the option is checked by default for newly created DingTalk group robot rules.

Latest coverage also asserts legacy DingTalk group rules without the saved flag remain unchecked when edited.

Latest coverage also asserts unchecking the option writes an explicit `notifyRuleCreatorOnFailure: false` payload, so backend defaults cannot re-enable it.

Latest coverage also asserts legacy V1 DingTalk group rules remain unchecked and save as explicitly disabled rather than silently enabled.

Latest route coverage also asserts explicit API create opt-out remains `false` in both service input and response payload.

Latest update coverage also asserts explicit API PATCH opt-out remains `false` when a rule switches from another action type into `send_dingtalk_group_message`.

Latest service coverage also asserts direct `updateRule` persistence keeps explicit opt-out as `false` for both top-level group actions and V1 `actions[]` group actions.

Latest default-on coverage also asserts direct `updateRule` and API PATCH both add `notifyRuleCreatorOnFailure: true` when a non-group rule is switched into a DingTalk group action without an explicit value.

Latest runtime coverage also asserts that if the creator is linked but DingTalk work notification returns a business error, the automation output includes `failureAlert.status = failed` and `dingtalk_person_deliveries` stores a `failed` audit row.

Deployment-side probe test:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Probe coverage asserts a deployed acceptance snapshot can be checked without sending new DingTalk messages, custom creator-alert subject matching passes with `--alert-subject` or `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`, unrelated person notifications and same-subject non-automation deliveries do not satisfy creator-alert acceptance, token-file input is not printed or written to `summary.json`/`summary.md`, API error details redact webhook/access_token/SEC/JWT values, disabled alert config blocks the default enabled expectation, disabled selected rules are summarized as `RULE_DISABLED`, explicit opt-out can be scoped by `--record-id`, `--acceptance` requires delivery evidence, auth failures are summarized as `AUTH_FAILED`, missing token files are summarized as `AUTH_TOKEN_FILE_NOT_FOUND`, omitted tokens are summarized as `AUTH_TOKEN_REQUIRED`, omitted sheet ids are summarized as `SHEET_ID_REQUIRED`, invalid arguments are summarized as `INVALID_ARGUMENTS`, deployed API 404 failures include the failing API path, timeout failures include the failing API path and timeout value, network reachability failures include the failing API path, ambiguous rule selection is summarized as `MULTIPLE_GROUP_RULES` with candidate ids, missing rule ids are summarized as `RULE_NOT_FOUND` with available group rule ids, sheets without group rules are summarized as `NO_GROUP_RULE` with safe rule inventory, and `--skip-auth-me` avoids `/api/auth/me`.

Targeted delivery route and service tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/multitable-automation-service.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false
```

Result: passed, 44 tests.

Backend build:

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

Frontend build:

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Vite reported existing chunk-size warnings and one dynamic/static import warning for `WorkflowDesigner.vue`.

Scoped diff check:

```bash
git diff --check -- packages/core-backend/src/multitable/automation-actions.ts packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/src/multitable/automation-service.ts packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts packages/core-backend/tests/unit/automation-v1.test.ts packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts apps/web/src/multitable/components/MetaAutomationRuleEditor.vue apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/tests/multitable-automation-rule-editor.spec.ts apps/web/tests/multitable-automation-manager.spec.ts scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: passed, no whitespace errors.

Note: frontend targeted tests printed `WebSocket server error: Port is already in use`, but the processes exited successfully and all targeted tests passed.

## Acceptance Notes

- Existing automations are unchanged unless the new option is enabled.
- Alert delivery does not use the failed group robot; it uses DingTalk work notification to the rule creator.
- If the rule creator has no active DingTalk binding, the alert is auditable as a skipped person delivery.
- If deployment validation is blocked by a missing token file, omitted token, omitted sheet id, expired token, wrong rule id, ambiguous group rule selection, backend timeout, or backend reachability failure, the probe still produces attachable redaction-safe evidence.
