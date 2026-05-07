# DingTalk Group Failure Alert Final Handoff

Date: 2026-05-07

## Scope

This handoff covers DingTalk group robot automation failure alerts to the rule creator.

## Final Behavior

- New DingTalk group robot automation rules default `notifyRuleCreatorOnFailure` to `true`.
- Frontend defaults are enabled in both the inline automation manager and advanced rule editor.
- Backend create/API normalization also defaults omitted `notifyRuleCreatorOnFailure` to `true`.
- Explicit `notifyRuleCreatorOnFailure: false` is preserved.
- Existing DingTalk group rules without this saved flag remain unchecked when edited and are not silently upgraded.
- Existing V1 rules that already contain a DingTalk group action in `actions[]` are treated as existing group rules, even if the legacy top-level action is stale.
- Switching an existing rule from another action type into `send_dingtalk_group_message` defaults the flag to `true`.
- Unchecking the option sends `notifyRuleCreatorOnFailure: false` from both frontend editors, so backend create defaults cannot accidentally re-enable a user opt-out.
- API create requests that explicitly pass `notifyRuleCreatorOnFailure: false` preserve that value in service input and response payload.
- API update requests that explicitly pass `notifyRuleCreatorOnFailure: false` while switching into a DingTalk group action preserve that opt-out instead of applying the default-on behavior.
- Direct service updates preserve explicit `notifyRuleCreatorOnFailure: false` in persisted top-level group action config and V1 `actions[]` group action config.
- Direct service updates and API PATCH requests default omitted `notifyRuleCreatorOnFailure` to `true` when an existing non-group rule is switched into a DingTalk group action.
- When enabled and group delivery fails:
  - group failure remains recorded in `dingtalk_group_deliveries`;
  - a DingTalk work notification is attempted for the rule creator;
  - linked/active creator delivery is recorded as `success` in `dingtalk_person_deliveries`;
  - linked/active creator delivery is recorded as `failed` if the DingTalk work notification API itself rejects the alert;
  - unlinked/inactive creator delivery is recorded as `skipped`.
- When explicitly disabled and group delivery fails:
  - group failure remains recorded in `dingtalk_group_deliveries`;
  - no rule-creator lookup is performed;
  - no DingTalk work notification is sent;
  - no `dingtalk_person_deliveries` alert row is created.
- The deployment probe can generate redaction-safe `summary.json` and
  `summary.md` for PASS/BLOCKED business checks plus fatal argument, auth, API,
  timeout, network, and rule-selection failures.
- Record-scoped probe runs now pass `recordId` into backend delivery history
  APIs so the selected record is filtered before the history `limit`.
- Disabled selected rules now return `RULE_DISABLED`, so stale delivery history
  cannot make a non-runnable rule pass acceptance.
- Creator-alert subject matching defaults to the built-in subject and can be
  overridden with `--alert-subject` for customized deployments.

## Files

- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts`
- `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- `packages/core-backend/tests/unit/dingtalk-group-delivery-service.test.ts`
- `packages/core-backend/tests/unit/dingtalk-person-delivery-service.test.ts`
- `packages/core-backend/tests/integration/dingtalk-delivery-routes.api.test.ts`
- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs`
- `scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-enabled-rule-guard-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-alert-subject-config-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-acceptance-status-helper-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`

## Verification

Targeted backend automation suite:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

Targeted backend DingTalk automation route suite:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
```

Result: passed, 36 tests.

Targeted frontend advanced editor suite:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false
```

Result: passed, 64 tests.

Targeted frontend automation manager suite:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
```

Result: passed, 73 tests.

Latest coverage includes saving a legacy V1 DingTalk group rule through both frontend editor paths and asserting it remains explicitly disabled instead of silently enabled.

Latest coverage also includes creating a new DingTalk group rule after unchecking the creator failure alert option and asserting the saved payload contains `notifyRuleCreatorOnFailure: false`.

Latest route coverage includes API create with explicit `notifyRuleCreatorOnFailure: false`, proving route normalization does not overwrite user opt-out.

Latest update coverage includes API PATCH switching into DingTalk group delivery with explicit `notifyRuleCreatorOnFailure: false`.

Latest service coverage includes direct `updateRule` persistence of explicit disabled creator failure alerts for both top-level group actions and V1 `actions[]`.

Latest default-on coverage includes direct `updateRule` and API PATCH switching from a non-group rule into DingTalk group delivery without an explicit value.

Latest runtime coverage includes the linked-creator failure branch where DingTalk work notification returns a business error and the creator alert is audited as `failed`.

Deployment-side probe suite:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Latest probe coverage includes `--record-id` filtering so explicit opt-out acceptance can ignore older creator-alert rows from previous records.

Latest probe coverage also includes custom creator-alert subject matching via
`--alert-subject` or `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`, plus negative
cases proving unrelated person notifications and same-subject non-automation
deliveries do not satisfy acceptance.

Latest probe coverage also asserts token-file input is not printed or written
to `summary.json`/`summary.md`, and API error details redact
webhook/access_token/SEC/JWT values before they are written.

Live-acceptance input helper suite:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs
```

Result: passed, 7 tests.

The helper produces redaction-safe `ready`/`blocked` summaries for 142 probe
inputs, can generate a fill-in env template, and generates the next probe
commands without calling 142 or DingTalk.

Latest probe coverage also includes `RULE_DISABLED`, so a disabled selected rule
blocks acceptance even if historical group/person delivery evidence exists.

Latest probe coverage also includes redaction-safe fatal summaries for missing token file, omitted token, omitted sheet id, invalid arguments, auth failure, deployed API 404, API timeout, API network reachability failure, ambiguous group rule selection, missing requested rule ids, and sheets without group rules. API blockers include the failing API path; timeout blockers include the timeout value; rule-selection blockers include safe rule ids/names so operators can rerun with the correct `--rule-id`. `--skip-auth-me` is covered and records `auth.checked = false` without requesting `/api/auth/me`.

Latest record-scope delivery coverage includes backend service filtering,
delivery route query parsing, and probe URLs that pass `recordId` to both group
and person delivery history APIs.

Targeted delivery route and service suite:

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

Result: passed. Vite still reports existing chunk-size and `WorkflowDesigner.vue` dynamic/static import warnings.

Scoped diff check:

```bash
git diff --check -- packages/core-backend/src/multitable/automation-actions.ts packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/src/multitable/automation-service.ts packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts packages/core-backend/tests/unit/automation-v1.test.ts packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts apps/web/src/multitable/components/MetaAutomationRuleEditor.vue apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/tests/multitable-automation-rule-editor.spec.ts apps/web/tests/multitable-automation-manager.spec.ts scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: passed, no whitespace errors.

## Deployment Notes

- Requires existing DingTalk app message envs for creator work notifications: `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, and `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID`.
- The failed group robot is not reused for the personal failure alert.
- No migration is required for existing rules.
- Existing rules can opt in manually by enabling the checkbox and saving.
- After deploying, use `scripts/ops/dingtalk-group-failure-alert-probe.mjs` to generate redaction-safe `summary.json` and `summary.md` evidence for the selected sheet/rule.
- Before triggering the live test, use `scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs --write-env-template <file>` to create the private input file, then rerun the same helper with `--env-file <file>` to confirm the API base, token/token file, sheet id, rule id, and fresh test record id are ready.
- If the token file, token value, sheet id, selected rule, backend timeout, or backend reachability is wrong, the probe still exits non-zero but writes blocked evidence under the selected `--output-dir` or default output root.
- Acceptance packets should attach only the redaction-safe probe summaries or
  manually redacted DB snippets. Do not paste raw webhook URLs, access tokens,
  DingTalk robot `SEC` secrets, JWTs, full error response bodies, or unmasked
  user identifiers into issue comments or chat.

Probe example:

```bash
node scripts/ops/dingtalk-group-failure-alert-probe.mjs \
  --api-base "http://142.171.239.56:8081" \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --sheet-id "<sheet-id>" \
  --rule-id "<automation-rule-id>" \
  --record-id "<current-test-record-id>" \
  --acceptance \
  --expect-person-status success \
  --alert-subject "MetaSheet DingTalk group delivery failed" \
  --output-dir "output/dingtalk-group-failure-alert-probe/142-acceptance"
```

## Manual Acceptance Checklist

Use these steps after deploying to a real environment with DingTalk app message credentials configured.

### New Rule Default

1. Open a multitable sheet and create a new automation rule.
2. Select `Send DingTalk group message`.
3. Confirm `Notify me if DingTalk group delivery fails` is checked by default.
4. Save the rule.
5. Reopen the rule and confirm the checkbox remains checked.
6. Confirm the rule summary includes `Failure alerts: rule creator`.

Expected result: new group robot automation rules opt in to creator failure alerts without extra user action.

### Failed Group Send With Linked Creator

1. Use a rule creator that has an active linked DingTalk account.
2. Configure the rule to send to a test group robot.
3. Intentionally make the group robot send fail, for example by using an invalid keyword or signature in a test-only destination.
4. Trigger the automation.
5. Confirm the group failure is visible in group delivery history.
6. Confirm the rule creator receives a DingTalk work notification.
7. Confirm `dingtalk_person_deliveries` contains a `success` row for the rule creator and the same automation rule.

Expected result: group robot failure is still recorded, and the rule creator receives a separate personal work notification.

### Failed Group Send With Unlinked Creator

1. Use a rule creator that is active locally but not linked to DingTalk.
2. Enable `Notify me if DingTalk group delivery fails`.
3. Trigger a failing group robot delivery.
4. Confirm `dingtalk_group_deliveries` contains the failed group delivery.
5. Confirm `dingtalk_person_deliveries` contains a `skipped` row with error `DingTalk account is not linked or user is inactive`.

Expected result: no personal notification is sent, but the skipped alert is auditable.

### Existing Legacy Rule Preservation

1. Find or create a DingTalk group rule that does not have `notifyRuleCreatorOnFailure` saved.
2. Open it for edit.
3. Confirm the checkbox is unchecked.
4. Save without checking it.
5. Confirm the saved config still omits the flag or keeps it disabled.

Expected result: existing rules are not silently upgraded into sending creator alerts.

### Existing Legacy V1 Rule Preservation

1. Find or create a V1 rule whose top-level action is stale, for example `notify`, while `actions[]` contains `send_dingtalk_group_message`.
2. Ensure the DingTalk group action does not have `notifyRuleCreatorOnFailure` saved.
3. Open it in the advanced rule editor.
4. Confirm the checkbox is unchecked.
5. Save without checking it.
6. Confirm the saved group action still omits the flag or keeps it disabled.

Expected result: existing V1 group-message rules are not silently upgraded because of stale top-level action fields.

### Explicit Disable

1. Create or edit a DingTalk group rule.
2. Uncheck `Notify me if DingTalk group delivery fails`.
3. Save the rule.
4. Trigger a failing group robot delivery.
5. Confirm group delivery history records the failure.
6. Confirm no creator alert row is created in `dingtalk_person_deliveries` for that failure.
7. If the rule has older delivery history, run the probe with the current failed record id:

```bash
node scripts/ops/dingtalk-group-failure-alert-probe.mjs \
  --api-base "http://142.171.239.56:8081" \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --sheet-id "<sheet-id>" \
  --rule-id "<automation-rule-id>" \
  --record-id "<current-test-record-id>" \
  --expect-alert disabled \
  --expect-person-status none \
  --require-group-failure \
  --output-dir "output/dingtalk-group-failure-alert-probe/142-disabled"
```

Expected result: explicit opt-out is respected.
