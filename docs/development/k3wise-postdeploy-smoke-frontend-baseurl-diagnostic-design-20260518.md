# K3 WISE Postdeploy Smoke Frontend Base URL Diagnostic Design - 2026-05-18

## Context

Issue #651 reported a deployment where authenticated backend checks passed but
the frontend route checks failed:

- `/api/auth/me`: pass
- `/api/integration/*`: pass
- staging install/schema/pipeline-save: pass
- `/integrations/k3-wise`: 404
- `/integrations/workbench`: 404

The current package already contains the Vue routes and the built frontend
chunks, and `multitable-onprem-package-verify.sh` gates both route strings in
`apps/web/dist`. The likely operator fault is therefore not a missing bundle,
but a postdeploy smoke `--base-url` pointed at the backend/API port instead of
the frontend/nginx entry, or a reverse proxy without SPA history fallback.

## Change

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` now adds a targeted
diagnostic when this shape occurs:

- `/api/health` passed, proving the base URL reaches a MetaSheet backend.
- A frontend SPA route returns HTTP 404.

The failing route check remains a failure, but the check now includes:

- `code: FRONTEND_ROUTE_NOT_FOUND`
- `likelyCause`: backend/API-only URL or missing SPA fallback
- `hint`: use the frontend/nginx URL and verify `/`, `/login`, and
  `/integrations/*` return the app shell.

The diagnostic is written to both JSON and Markdown evidence. Existing
single-error Markdown formatting is preserved when no diagnostic fields exist.

## Non-Goals

- No change to frontend routing.
- No change to nginx templates.
- No relaxation of postdeploy smoke signoff.
- No customer GATE behavior change and no K3 Save/Submit/Audit path change.

## Operator Impact

When the field team sees the #651 failure shape again, the artifact will point
directly to the right next check:

1. Try the smoke with the frontend URL, for example `http://127.0.0.1` or
   `http://127.0.0.1:8081`.
2. Confirm `/` and `/login` return the Vue app shell.
3. If `/` works but `/integrations/*` still returns 404, fix the frontend
   reverse proxy SPA fallback to `index.html`.

