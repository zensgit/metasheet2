# DingTalk Final Closeout Completion - Verification

- Date: 2026-05-11
- Main SHA verified: `ca70e340ad8a8c1482b68c723e86fd6ce99324de`
- 142 deployment: backend and web images both match the verified main SHA.
- Verdict: **PASS / CLOSED for DingTalk delivery**.

## Verification Summary

| Gate | Result |
| --- | --- |
| Main branch deploy gates for `ca70e340ad8a8c1482b68c723e86fd6ce99324de` | PASS |
| Build and Push Docker Images | PASS |
| Deploy to Production | PASS |
| Plugin System Tests | PASS |
| Observability E2E | PASS |
| SafetyGuard E2E | PASS |
| Phase 5 Production Flags Guard | PASS |
| monitoring-alert workflow | PASS |
| 142 backend image equals main SHA | PASS |
| 142 web image equals main SHA | PASS |
| 142 `/api/health` | PASS, `200` |
| 142 web `/` | PASS, `200` |
| 142 `/admin/directory` | PASS, `200` |
| Work-notification admin route unauthenticated probe | PASS, `401` expected |
| Final remote smoke required checks | PASS, `8/8` |
| Final remote smoke strict status | PASS |
| Final evidence packet publish check | PASS |
| Final evidence packet secret findings | PASS, `0` |
| Backend public-form + no-email directory regression tests | PASS, 35 tests |
| Frontend DingTalk link + directory page tests | PASS, 47 tests |
| DingTalk P4 ops regression gate | PASS |

## Commands Run

### 142 Deployment and Health

```bash
ssh metasheet-142 'cd ~/metasheet2 &&
  git rev-parse HEAD &&
  docker inspect metasheet-web --format "web={{.Config.Image}} {{.State.StartedAt}}" &&
  docker inspect metasheet-backend --format "backend={{.Config.Image}} {{.State.StartedAt}}" &&
  curl -sS -o /dev/null -w "root=%{http_code}\n" http://127.0.0.1:8081/ &&
  curl -sS -o /dev/null -w "admin_directory=%{http_code}\n" http://127.0.0.1:8081/admin/directory &&
  curl -sS -o /dev/null -w "health=%{http_code}\n" http://127.0.0.1:8900/api/health &&
  curl -sS -o /dev/null -w "work_notification_unauth=%{http_code}\n" http://127.0.0.1:8900/api/admin/directory/dingtalk/work-notification'
```

Result:

```text
head=ca70e340ad8a8c1482b68c723e86fd6ce99324de
root=200
admin_directory=200
health=200
work_notification_unauth=401
```

### GitHub Actions

```bash
gh run list --repo zensgit/metasheet2 --branch main --limit 10 \
  --json databaseId,headSha,workflowName,status,conclusion,createdAt
```

For the verified main SHA, all observed delivery and regression workflows completed with `success`, including Docker build, production deploy, Plugin System Tests, Observability E2E, SafetyGuard E2E, Phase 5 Production Flags Guard, and monitoring-alert.

### Final Remote Smoke Evidence

```bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260510 \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final/handoff-summary.json \
  --require-release-ready

node scripts/ops/validate-dingtalk-staging-evidence-packet.mjs \
  --packet-dir artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final \
  --output-json artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final/publish-check.json

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260510 \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final \
  --docs-output-dir docs/development \
  --date 20260511
```

Recorded result:

```text
required_checks=8
passed_checks=8
failed_checks=0
pending_or_missing_checks=0
manual_evidence_issues=0
secret_findings=0
status=pass
final_strict_status=pass
smoke_status=release_ready
publish_status=pass
```

### Backend Regression Tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/public-form-flow.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       35 passed (35)
```

Coverage in this command includes:

- anonymous public form context and submission;
- `dingtalk` protected form anonymous redirect, unbound rejection, and bound-user allow;
- `dingtalk_granted` selected-user and allowlist rejection paths;
- selected-user without DingTalk binding rejection;
- allowlist/member-group configuration;
- no-email DingTalk directory admission and bind/unbind regressions.

### Frontend Regression Tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/dingtalk-public-form-link-warnings.spec.ts \
  tests/directoryManagementView.spec.ts \
  --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       47 passed (47)
```

### Ops Regression Gate

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops
```

Result:

```text
[dingtalk-p4-regression-gate] pass
```

## Final Acceptance Matrix

| Item | Status | Evidence |
| --- | --- | --- |
| A/B real DingTalk group robot delivery | PASS | Final remote smoke, group delivery count 2, screenshots accepted by operator |
| Protected form link delivered through DingTalk | PASS | Final remote smoke |
| Authorized DingTalk-bound user can submit | PASS | Final remote smoke |
| Unauthorized DingTalk-bound user is denied | PASS | Final remote smoke |
| No-email `ddzz` local user can be created and bound | PASS | Final remote smoke + directory regression test |
| `/admin/directory` is deployed and reachable on 142 | PASS | 142 route probe returned 200 |
| Work-notification admin route is deployed and auth-gated | PASS | unauthenticated probe returned 401 |
| Failure-alert code path remains covered | PASS | merged runtime path + ops regression gate |
| `public` form mode | PASS | backend integration regression |
| `dingtalk` form mode | PASS | backend integration regression |
| `dingtalk_granted` form mode | PASS | backend integration regression + final remote smoke |
| Evidence packet publish readiness | PASS | publish check passed |
| Evidence packet secret scan | PASS | 0 findings |

## Rollback

If a production issue appears, roll back backend and web to the previous known-good GHCR tag recorded before the final deployment, then re-check:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8900/api/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/admin/directory
```

Keep the evidence packet and logs for comparison; do not paste raw webhook, token, `SEC`, JWT, app secret, Agent ID, recipient id, or temporary password values into incident notes.
