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
