# DingTalk P4 API Health And Auth Preflight Verification - 2026-04-30

## Commands

```bash
node --check scripts/ops/dingtalk-p4-remote-smoke.mjs
node --check scripts/ops/dingtalk-p4-smoke-preflight.mjs
node --check scripts/ops/dingtalk-p4-remote-smoke.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-preflight.test.mjs
node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs scripts/ops/dingtalk-p4-smoke-preflight.test.mjs
git diff --check
```

Additional 142 preflight command:

```bash
node scripts/ops/dingtalk-p4-smoke-preflight.mjs \
  --env-file /Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-next-slice-20260423/output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --api-base http://142.171.239.56:8081/api \
  --web-base http://142.171.239.56:8081 \
  --require-manual-targets \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-token-preflight-20260430T1620 \
  --timeout-ms 120000
```

## Expected Coverage

- Root `/health` returning frontend HTML is not accepted as backend JSON health.
- API-prefixed `/api/health` is tried when `--api-base` includes `/api`.
- Existing root-backend `/health` deployments keep working.
- `GET /api/auth/me` validates the bearer token after backend health passes.
- Invalid or expired bearer tokens fail as `auth-token-valid` before remote
  smoke state mutations or DingTalk delivery attempts.
- Group robot test-send and group form-link automation payloads include the
  required `P4 metasheet` keywords for the real A/B robots.
- Delivery-history reads tolerate delayed DingTalk delivery row writes after
  automation test-run completion.
- Secrets remain outside stdout and generated summaries.

## Live Finding

The failed live session at
`output/dingtalk-p4-remote-smoke-session/142-session-20260430T1536` confirmed the
deployment shape: `http://142.171.239.56:8081/health` serves HTML while
`http://142.171.239.56:8081/api/health` serves backend JSON.

After the fallback change, the live preflight in
`output/dingtalk-p4-remote-smoke-session/142-session-20260430T1540` passed
`api-health` against `http://142.171.239.56:8081/api/health`. The next live
blocker moved to authentication: the API runner reached
`POST /api/multitable/bases` and received `401 Invalid token`, so a fresh 142
application admin token is required before continuing the remote smoke.

After adding `auth-token-valid`, the 142 preflight in
`output/dingtalk-p4-remote-smoke-session/142-token-preflight-20260430T1620`
passed local tooling, API base, web base, token presence, two DingTalk group
robot shapes, optional SEC secrets, allowlist, person smoke input, manual
targets, and `api-health`. It then failed safely at
`GET http://142.171.239.56:8081/api/auth/me` with `401 Invalid token`. No raw
bearer token, robot access token, or SEC secret was written to the generated
summary.

After re-issuing a fresh 72h 142 application admin token from the running
backend container, the live preflight in
`output/dingtalk-p4-remote-smoke-session/142-token-preflight-20260430T-live`
passed every check, including `auth-token-valid`.

The first full live smoke reached group test-send and failed because the real
robots enforce keywords. After adding `P4 metasheet` to group smoke messages,
the live run in
`output/dingtalk-p4-remote-smoke-session/142-session-20260430T-live-keyword-retry30`
passed group robot binding, test-send, and group automation delivery history.
It then stopped at person automation because the running `metasheet-backend`
container has no `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID` configured.

The group-only live smoke in
`output/dingtalk-p4-remote-smoke-session/142-session-20260430T-live-group-only`
completed with exit code 0. It verified disposable base/form creation, two
group robot destinations, both group test-send delivery rows, DingTalk-granted
form share, and two group automation delivery rows. Manual client evidence and
person-message evidence remain pending by design.
