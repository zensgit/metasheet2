# DingTalk P4 API Health Fallback Verification - 2026-04-30

## Commands

```bash
node --check scripts/ops/dingtalk-p4-remote-smoke.mjs
node --check scripts/ops/dingtalk-p4-smoke-preflight.mjs
node --check scripts/ops/dingtalk-p4-remote-smoke.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-preflight.test.mjs
node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs scripts/ops/dingtalk-p4-smoke-preflight.test.mjs
git diff --check
```

## Expected Coverage

- Root `/health` returning frontend HTML is not accepted as backend JSON health.
- API-prefixed `/api/health` is tried when `--api-base` includes `/api`.
- Existing root-backend `/health` deployments keep working.
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
