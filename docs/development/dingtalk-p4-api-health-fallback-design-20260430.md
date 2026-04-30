# DingTalk P4 API Health Fallback Design - 2026-04-30

## Problem

The 142 deployment exposes the web app at `http://142.171.239.56:8081` and the
backend API through the `/api` reverse-proxy prefix. The P4 smoke preflight only
checked that `/health` returned HTTP 200, so the frontend HTML shell could be
misclassified as a valid backend health endpoint. The API runner then attempted
to parse the same HTML response as JSON and stopped before creating the smoke
workspace.

## Change

- `scripts/ops/dingtalk-p4-remote-smoke.mjs` now tries `/health` first and, when
  `--api-base` includes a path such as `/api`, falls back to `<base-path>/health`.
- `scripts/ops/dingtalk-p4-smoke-preflight.mjs` now matches the runner contract
  by requiring the health response to be JSON, then uses the same path-aware
  fallback before reporting `api-health` as pass.
- Regression tests cover a frontend HTML `/health` response plus a backend JSON
  `/api/health` response for both preflight and API runner flows.

## Result

Operators can keep the public web base at `http://142.171.239.56:8081` while
using an API base such as `http://142.171.239.56:8081/api` without the smoke
runner failing on the frontend health page.
