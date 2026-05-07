# DingTalk 142 GHCR Closeout Development And Verification

Date: 2026-05-07

## Summary

This closeout shipped the DingTalk group robot configuration, validity testing,
group-delivery failure audit, rule-creator failure-alert defaulting, probe/helper
tooling, Docker build fix, and migration alignment through immutable GHCR images.

142 main is now running backend and web image tag:

`77b4439ca00b4fa7ee0fee2512f6694693bb1d0f`

Rollback baseline retained:

`d921c93e7f5500f0ad83edc92b153b0da97d93f4`

No raw webhook URL, robot access token, SEC secret, JWT, or app credential is
stored in this document.

## TODO Status

- [x] Confirmed local delivery scope: backend runtime, frontend configuration UI, destination validity test, failure audit, creator failure-alert defaults, probe/helper, scripts, and docs.
- [x] Ran local safety checks: scoped secret scan, staged leak scan, and whitespace scan.
- [x] Ran local automation verification: backend runtime/routes/services, probe/helper, frontend client/editor/manager, backend typecheck/build, and web build.
- [x] Created closeout commits and pushed the `codex/` branch.
- [x] Confirmed GHCR backend/web images were generated from the closeout branch.
- [x] Recorded 142 pre-release baseline and admin API access.
- [x] Updated and restarted 142 `metasheet-backend` and `metasheet-web` from GHCR.
- [x] Verified post-release health, frontend entry, admin API, migrations, and public/protected form paths.
- [x] Verified real DingTalk group destination save policy and failure audit against the configured A/B robots.
- [x] Verified default rule-creator failure-alert behavior on 142 with a controlled failed automation.
- [ ] Non-blocking: configure DingTalk app work-notification envs on 142, then rerun creator alert probe expecting `success` instead of the current expected `failed`.

## Implemented Scope

- DingTalk group robot destinations validate before save and reject invalid or non-DingTalk webhook input without persisting changes.
- Frontend automation editors default new DingTalk group rules to notify the rule creator on group send failure while preserving explicit opt-out.
- Backend API/create/update paths normalize default-on behavior and preserve explicit `notifyRuleCreatorOnFailure: false`.
- Runtime records group delivery failures in `dingtalk_group_deliveries`.
- Runtime attempts a DingTalk work notification to the rule creator when enabled and records the creator alert in `dingtalk_person_deliveries` as `success`, `failed`, or `skipped`.
- Probe/helper scripts produce redaction-safe readiness and acceptance evidence.
- Docker backend/frontend builds now pin PNPM for Node 20 images.
- Restored the missing `zzzz20260505110000_create_meta_field_auto_number_sequences` migration so 142 migrations are not corrupted.

## Local Verification

Commands run locally:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
node --check scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-group-destination-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/multitable-automation-service.test.ts tests/integration/dingtalk-automation-link-routes.api.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts tests/integration/dingtalk-group-destination-routes.api.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-api-token-manager.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check
git diff --cached --check
```

Results:

- Node probe/helper tests: 28 passing.
- Backend targeted suites: 260 passing.
- Frontend targeted suites: 273 passing.
- Backend typecheck/build: passed.
- Web build: passed with existing Vite chunk-size and `WorkflowDesigner.vue` dynamic/static import warnings.
- Whitespace checks: passed.
- Scoped secret/leak scan for DingTalk closeout files and staged files: passed.
- Full repository secret scan still reports pre-existing false positives in historical scripts/tests, so it was not used as the release gate.
- Local Docker daemon was unavailable, so GHCR workflow runs were used as image build validation.

## Commits And GHCR

Closeout commits:

- `d8a47297c` `feat(dingtalk): close out group failure alerts`
- `fed6d6123` `fix(docker): pin pnpm for node 20 images`
- `77b4439ca` `fix(db): restore auto number migration`

GHCR workflow evidence:

- Run `25501377233`: failed during backend Docker build because Node 20 image activated PNPM 11, which required `node:sqlite`.
- Run `25501617234`: passed after PNPM pinning.
- Run `25502059792`: passed for deployed SHA `77b4439ca00b4fa7ee0fee2512f6694693bb1d0f`.

## 142 Deployment

Pre-release baseline:

- Backend/web previous tag: `d921c93e7f5500f0ad83edc92b153b0da97d93f4`.
- Postgres and Redis were already healthy and were not structurally changed.
- Admin token was validated with `/api/auth/me` before deploy.

Deployment action:

- Updated `/home/mainuser/metasheet2/.env` to `IMAGE_OWNER=zensgit` and `IMAGE_TAG=77b4439ca00b4fa7ee0fee2512f6694693bb1d0f`.
- Pulled GHCR backend/web images.
- Recreated only backend and web containers.
- Ran backend migration command after the container restart.

Post-release verification:

- `metasheet-backend`: `ghcr.io/zensgit/metasheet2-backend:77b4439ca00b4fa7ee0fee2512f6694693bb1d0f`, running.
- `metasheet-web`: `ghcr.io/zensgit/metasheet2-web:77b4439ca00b4fa7ee0fee2512f6694693bb1d0f`, running.
- `/api/health`: `status=ok`, `pluginsActive=13`, `pluginsFailed=0`.
- Frontend local entry: HTTP 200 from `http://127.0.0.1:8081/`.
- Admin API: `/api/auth/me` returned `success=true`, admin email `zhouhua@china-yaguang.com`, role `admin`.
- Migration table count: 158 applied migrations after release.
- Temporary closeout automation rules were cleaned up; remaining temp rule count is 0.

## DingTalk Live Verification

Real A/B group destination validation:

- Created temporary A and B group destinations from the existing configured robots.
- Both saves returned HTTP 201 and `lastTestStatus=success`.
- Temporary destinations were deleted immediately.
- Remaining temporary destination rows: 0.

Invalid save policy:

- PATCH with a non-DingTalk webhook returned HTTP 400.
- Error code: `UPDATE_FAILED`.
- Destination fingerprint and `last_test_status` were unchanged.

Manual group failure audit:

- A controlled test-send without the required robot keyword returned HTTP 400.
- A failed `dingtalk_group_deliveries` row was recorded with a DingTalk business error.
- A valid restore test-send returned HTTP 204.
- Destination `last_test_status` returned to `success`.

Default creator failure-alert rule:

- A temporary DingTalk group automation created without `notifyRuleCreatorOnFailure` returned `responseDefault=true`.
- Persisted `action_config.notifyRuleCreatorOnFailure` was `true`.
- Temporary default-check rule was deleted; remaining temp rule count is 0.

Controlled automation failure and probe:

- Created one temporary enabled automation rule and triggered a controlled group robot failure for `recordId=test_record`.
- Group delivery audit: one failed automation group delivery with DingTalk business error.
- Creator alert audit: one automation person-delivery row with `status=failed`.
- The person alert failed because 142 currently has no `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, `DINGTALK_AGENT_ID`, or `DINGTALK_NOTIFY_AGENT_ID` configured in the app env or container env.
- Probe result: `PASS` with `--expect-person-status failed`.
- Probe evidence path on 142: `/tmp/metasheet-dingtalk-group-failure-alert-probe-20260507-closeout/summary.md`.
- Temporary live automation rule was deleted; remaining temp rule count is 0.

Form path smoke:

- Public anonymous form context: HTTP 200, `ok=true`.
- DingTalk-protected form context without DingTalk sign-in: HTTP 401, `DINGTALK_AUTH_REQUIRED`.
- This matches the expected protected-form contract: protected public forms require DingTalk sign-in before fill access is evaluated.

## Remaining Non-Blocking Items

- Configure 142 DingTalk app-message envs: `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, and either `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID`.
- After env configuration, restart backend and rerun the same controlled automation probe with `--expect-person-status success`.
- Public internet curl from the local machine to `http://142.171.239.56:8081/api/health` returned empty reply, while server-local frontend/API checks passed. If external access is required from this network, inspect host firewall/proxy/Nginx path separately.
- Full repository secret scan still needs historical false positives to be allowlisted or cleaned if it is required as a global CI gate.

## Rollback

Use the preserved baseline tag if production needs rollback:

```bash
cd /home/mainuser/metasheet2
sed -i.bak 's/^IMAGE_TAG=.*/IMAGE_TAG=d921c93e7f5500f0ad83edc92b153b0da97d93f4/' .env
docker compose -f docker-compose.app.yml pull backend web
docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend web
curl -fsS http://127.0.0.1:8900/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/
```

Rollback should not change Postgres or Redis. If a future migration changes
schema shape, add a migration-specific rollback note before release.
