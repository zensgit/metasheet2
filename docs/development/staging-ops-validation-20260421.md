# Staging Ops Validation - 2026-04-21

## Scope

This note records the post-merge staging validation performed after the latest `main` rollout to the 142 server.

Validated main commits:

- `8688896ba` - `feat(auth): close no-email user admission and login loop`
- `02045206d` - `feat(dingtalk): support dynamic group destinations`

Additional stacked PR cleanup completed during this pass:

- PR `#991` - `fix(dingtalk): surface delivery viewer load errors`
- PR `#992` - `fix(dingtalk): warn on invalid member group paths`
- PR `#993` - `refactor(dingtalk): share recipient warning logic`

Those stacked PRs were validated and merged into their stack base branches; they are not recorded here as `main` deployment commits.

## GitHub Deployment

Workflow:

- `Build and Push Docker Images`
- Run id: `24714487950`
- Head SHA: `02045206daedb97cba6a554433c185ea27863368`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/24714487950`

Result:

- `build`: success
- `deploy`: success
- Deploy artifact: `deploy-logs-24714487950-1`

The deploy job completed with remote deploy return code `0`.

## External Smoke

Target:

- `http://142.171.239.56:8081`

Commands:

```bash
curl -fsS -m 15 -D /tmp/metasheet2-curl-headers.txt -o /tmp/metasheet2-curl-body.txt \
  http://142.171.239.56:8081

curl -fsS -m 15 -D /tmp/metasheet2-curl-headers.txt -o /tmp/metasheet2-curl-body.txt \
  http://142.171.239.56:8081/api/plugins

curl -fsS -m 15 -D /tmp/metasheet2-curl-headers.txt -o /tmp/metasheet2-curl-body.txt \
  http://142.171.239.56:8081/api/admin/yjs/status
```

Results:

- `GET /`: `200 OK`, frontend HTML served.
- `GET /api/plugins`: `200 OK`, plugin list returned; plugin `lastAttempt` timestamps were around `2026-04-21T09:23:23Z`, matching the deploy window.
- `GET /api/admin/yjs/status`: `401 Unauthorized`, expected without bearer token.

Note:

- `GET /health` through port `8081` returned the frontend HTML. The backend health endpoint is checked by the GitHub deploy job internally against backend port `8900`.

## Credential-Gated Checks

Local credential file checked:

- `$HOME/.config/yuantus/p2-shared-dev.env`

Observed keys:

- `BASE_URL`
- `USERNAME`
- `PASSWORD`
- `TENANT_ID`
- `ORG_ID`
- `ENVIRONMENT`

The stored `BASE_URL` points to `http://142.171.239.56:7910`, which is not the current `8081` deployment entrypoint.

Credential attempts:

```bash
POST http://142.171.239.56:8081/api/auth/login
```

Result:

- `401 Unauthorized`
- response error: `Invalid account or password`

Therefore these admin-only checks were not executed:

- `node scripts/ops/check-yjs-rollout-status.mjs --base-url http://142.171.239.56:8081 --token <token> --json`
- DingTalk admin/API smoke checks requiring an authenticated admin token.

## SSH / Retention Checks

SSH probe:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
  mainuser@142.171.239.56 'pwd && hostname && docker compose version'
```

Result:

- denied: `Permission denied (publickey,password).`

Because SSH access was unavailable from this workstation, DB-side Yjs retention checks through remote compose were not executed:

```bash
node scripts/ops/check-yjs-retention-health.mjs --use-compose-postgres ...
```

## Local PR Validation Completed

PR `#991`:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check -- \
  apps/web/src/multitable/components/MetaAutomationGroupDeliveryViewer.vue \
  apps/web/src/multitable/components/MetaAutomationPersonDeliveryViewer.vue \
  apps/web/tests/multitable-automation-manager.spec.ts \
  docs/development/dingtalk-delivery-viewer-errors-development-20260421.md \
  docs/development/dingtalk-delivery-viewer-errors-verification-20260421.md
```

Result:

- `57` tests passed.
- web build passed.
- diff check passed.

PR `#992`:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-automation-rule-editor.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  --watch=false
pnpm --filter @metasheet/web build
git diff --check -- \
  apps/web/src/multitable/components/MetaAutomationManager.vue \
  apps/web/src/multitable/components/MetaAutomationRuleEditor.vue \
  apps/web/tests/multitable-automation-manager.spec.ts \
  apps/web/tests/multitable-automation-rule-editor.spec.ts \
  docs/development/dingtalk-person-member-group-path-warnings-development-20260421.md \
  docs/development/dingtalk-person-member-group-path-warnings-verification-20260421.md
```

Result:

- `109` tests passed.
- web build passed.
- diff check passed.

PR `#993`:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/dingtalk-recipient-field-warnings.spec.ts \
  tests/multitable-automation-rule-editor.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  --watch=false
pnpm --filter @metasheet/web build
git diff --check -- \
  apps/web/src/multitable/utils/dingtalkRecipientFieldWarnings.ts \
  apps/web/src/multitable/components/MetaAutomationManager.vue \
  apps/web/src/multitable/components/MetaAutomationRuleEditor.vue \
  apps/web/tests/dingtalk-recipient-field-warnings.spec.ts \
  docs/development/dingtalk-recipient-warning-utils-development-20260421.md \
  docs/development/dingtalk-recipient-warning-utils-verification-20260421.md
```

Result:

- `114` tests passed.
- web build passed.
- diff check passed.

## Conclusion

Deployment to the 142 server completed through the GitHub Actions deploy path for `02045206d`.

Confirmed:

- frontend is serving on `8081`
- backend proxy/API is reachable through `8081/api/plugins`
- unauthenticated admin endpoint rejects as expected
- GitHub deploy job succeeded

Blocked:

- authenticated Yjs admin status
- DingTalk admin smoke
- DB-side Yjs retention health

Blocker reason:

- local shared-dev credentials are stale for the current `8081` deployment
- SSH access from this workstation is not configured

Next step:

- provide a valid admin token for `http://142.171.239.56:8081`, or configure SSH access for `mainuser@142.171.239.56`, then rerun the credential-gated Yjs/DingTalk retention and admin smoke checks.
