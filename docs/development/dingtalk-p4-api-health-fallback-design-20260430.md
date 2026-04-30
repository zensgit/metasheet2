# DingTalk P4 API Health And Auth Preflight Design - 2026-04-30

## Problem

The 142 deployment exposes the web app at `http://142.171.239.56:8081` and the
backend API through the `/api` reverse-proxy prefix. The P4 smoke preflight only
checked that `/health` returned HTTP 200, so the frontend HTML shell could be
misclassified as a valid backend health endpoint. The API runner then attempted
to parse the same HTML response as JSON and stopped before creating the smoke
workspace.

After the health fallback fix, the next 142 run reached the real API and failed
with `401 Invalid token`. The preflight only checked that a token was present,
so an expired or wrong 142 application token was not detected until the remote
smoke started mutating state.

## Change

- `scripts/ops/dingtalk-p4-remote-smoke.mjs` now tries `/health` first and, when
  `--api-base` includes a path such as `/api`, falls back to `<base-path>/health`.
- `scripts/ops/dingtalk-p4-smoke-preflight.mjs` now matches the runner contract
  by requiring the health response to be JSON, then uses the same path-aware
  fallback before reporting `api-health` as pass.
- `scripts/ops/dingtalk-p4-smoke-preflight.mjs` now validates the bearer token
  with `GET /api/auth/me` after backend health passes. The auth check uses the
  same API-prefix handling and reports a redacted `auth-token-valid` failure on
  `401` or `403`.
- `scripts/ops/dingtalk-p4-remote-smoke.mjs` now includes the P4 robot
  keywords `P4 metasheet` in group test-send and group form-link automation
  messages so the real A/B robots with keyword security can accept smoke
  traffic.
- Delivery-history reads now retry for a short window after group/person
  automation test-runs. The 142 backend can write DingTalk delivery rows a few
  seconds after the test-run API returns.
- Regression tests cover a frontend HTML `/health` response plus a backend JSON
  `/api/health` response for both preflight and API runner flows.
- Regression tests also cover valid-token preflight success and invalid-token
  preflight failure without leaking the bearer token into stdout or generated
  summaries.
- Regression tests assert the group robot smoke payload includes both required
  keywords.

## Result

Operators can keep the public web base at `http://142.171.239.56:8081` while
using an API base such as `http://142.171.239.56:8081/api` without the smoke
runner failing on the frontend health page. Expired 142 application admin tokens
now fail during preflight before the remote smoke creates any tables or sends
any DingTalk messages. Real group robot keyword checks and delayed delivery
history writes are handled by the runner, leaving only genuine environment
configuration and manual DingTalk-client evidence as release blockers.
