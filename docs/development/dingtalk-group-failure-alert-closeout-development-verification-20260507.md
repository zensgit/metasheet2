# DingTalk Group Failure Alert Closeout - Development & Verification

Date: 2026-05-07

## Closeout Scope

This closeout covers the DingTalk group robot automation failure alert feature:
when a group robot delivery fails, MetaSheet can notify the automation rule
creator through DingTalk work notification, and every outcome is auditable.

The closeout did not trigger real DingTalk sends. It validates source behavior,
frontend configuration, delivery-history APIs, deployment probe behavior, build
health, and secret redaction. Live 142 acceptance remains a deployment step that
requires a current admin token, selected sheet/rule/record ids, and one real
failed group robot delivery.

## Final Development Notes

- `notifyRuleCreatorOnFailure` is available in DingTalk group automation config.
- New DingTalk group automation rules default creator failure alerts to enabled
  across frontend editors and backend create/update normalization.
- Existing legacy group rules are not silently upgraded when edited.
- Explicit opt-out is preserved by frontend payloads, route normalization, and
  direct `AutomationService.updateRule` paths.
- Runtime failure handling records the group robot failure, attempts a DingTalk
  work notification to the rule creator when enabled, and audits creator-alert
  outcomes as `success`, `failed`, or `skipped`.
- Explicit opt-out still records group failure but does not resolve the creator,
  does not send work notification, and does not create a person-delivery alert.
- Delivery history APIs support `recordId`, so acceptance can isolate the
  current test record instead of being polluted by older delivery rows.
- The deployment probe writes redaction-safe `summary.json` and `summary.md`
  for PASS/BLOCKED results, including argument/auth/API/timeout/network/rule
  selection blockers.
- The probe rejects disabled selected rules with `RULE_DISABLED`.
- The probe supports custom creator-alert subjects through `--alert-subject` or
  `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`.
- The probe now counts creator alerts only when `sourceType === 'automation'`;
  same-subject non-automation deliveries cannot satisfy acceptance metrics.
- Probe redaction coverage now asserts token-file input is absent from both
  `summary.json` and `summary.md`, and API error details redact webhook,
  access_token, `SEC...`, and JWT-like values.
- Added a local live-acceptance input/status helper:
  `scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs`. It checks
  whether the 142 probe inputs are present and writes redaction-safe
  `summary.json`/`summary.md` before any real failed group robot delivery is
  triggered.
- The acceptance-status helper can also generate a fill-in env template with
  `--write-env-template`, and refuses to overwrite existing templates unless
  `--force` is passed.

## Verification Run

Syntax checks:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
node --check scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed.

Deployment probe tests:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Acceptance-status helper tests:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs
```

Result: passed, 7 tests.

Backend automation runtime and normalization tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

Backend delivery service and route tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/multitable-automation-service.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false
```

Result: passed, 44 tests.

Frontend API client contract tests:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts --watch=false
```

Result: passed, 22 tests.

Frontend automation editor tests:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
```

Result: passed, 64 tests and 73 tests. The test runner printed an existing
`WebSocket server error: Port is already in use` message, but both suites exited
successfully.

Backend type/build checks:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend build
```

Result: passed.

Frontend production build:

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Vite reported existing chunk-size warnings and the existing
`WorkflowDesigner.vue` dynamic/static import warning.

Whitespace check:

```bash
git diff --check -- packages/core-backend/src/multitable/automation-actions.ts packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/src/multitable/automation-service.ts packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts packages/core-backend/src/routes/univer-meta.ts packages/core-backend/tests/unit/automation-v1.test.ts packages/core-backend/tests/unit/dingtalk-group-delivery-service.test.ts packages/core-backend/tests/unit/dingtalk-person-delivery-service.test.ts packages/core-backend/tests/unit/multitable-automation-service.test.ts packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts packages/core-backend/tests/integration/dingtalk-delivery-routes.api.test.ts apps/web/src/multitable/api/client.ts apps/web/src/multitable/components/MetaAutomationRuleEditor.vue apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/tests/multitable-client.spec.ts apps/web/tests/multitable-automation-rule-editor.spec.ts apps/web/tests/multitable-automation-manager.spec.ts
```

Result: passed.

Secret scan:

```bash
rg -n "oapi\.dingtalk\.com/robot/send\?access_token=[0-9a-fA-F]{32,}|access_token=[0-9a-fA-F]{32,}|SEC[0-9a-fA-F]{32,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}" scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert*.md packages/core-backend/src/multitable packages/core-backend/src/routes/univer-meta.ts apps/web/src/multitable
```

Result: no matches.

## 142 Live Acceptance Status

Source-side closeout is ready for deployment. Live 142 acceptance was not rerun
in this closeout because it needs current live inputs:

- a non-expired admin token file;
- the exact sheet id;
- the exact automation rule id;
- the current record id produced by a new failed group robot test;
- configured DingTalk app-message envs for work notification.

Before triggering the live test, generate and fill the private input template:

```bash
node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs \
  --write-env-template "output/dingtalk-group-failure-alert-acceptance/142.env"
```

Then check the private inputs:

```bash
node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs \
  --env-file "output/dingtalk-group-failure-alert-acceptance/142.env" \
  --output-json "output/dingtalk-group-failure-alert-acceptance-status/summary.json" \
  --output-md "output/dingtalk-group-failure-alert-acceptance-status/summary.md" \
  --allow-blocked
```

After deploying and producing a fresh failed group robot delivery, run:

```bash
node scripts/ops/dingtalk-group-failure-alert-probe.mjs \
  --api-base "http://142.171.239.56:8081" \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --sheet-id "<sheet-id>" \
  --rule-id "<automation-rule-id>" \
  --record-id "<current-test-record-id>" \
  --acceptance \
  --expect-person-status success \
  --output-dir "output/dingtalk-group-failure-alert-probe/142-acceptance"
```

Attach only the generated redaction-safe `summary.md` and `summary.json`.

## Remaining Work

- Required before production sign-off: deploy these source changes to 142 or the
  target environment.
- Required before production sign-off: run the acceptance-status helper and
  confirm it reports `ready`.
- Required before production sign-off: trigger one controlled failed group robot
  delivery from a rule creator with linked DingTalk identity, then run the probe
  and archive PASS evidence.
- Optional but recommended: run the explicit opt-out scenario with
  `--expect-alert disabled --expect-person-status none --require-group-failure`
  and the current `--record-id`.

No additional source-code work is currently known for this feature scope.
