# K3 WISE Postdeploy Auth Token Resolution Design

## Context

The K3 WISE postdeploy smoke can already run public checks after every main
deploy, and it can run authenticated tenant-scoped control-plane probes when a
bearer token is supplied. In practice, the long-lived repository secret
`METASHEET_K3WISE_SMOKE_TOKEN` is not always configured, which leaves the
default deploy evidence at public-only `2 pass / 2 skipped`.

The deploy workflow already has SSH access to the 142 deploy host and can run
commands against the freshly restarted backend container. That gives us a safer
fallback than copying `JWT_SECRET` into GitHub: mint a short-lived token from the
same runtime that validates it.

## Change

Add `scripts/ops/resolve-k3wise-smoke-token.sh` and call it from both K3 WISE
workflow entrypoints:

- Manual `K3 WISE Postdeploy Smoke`.
- Main `Build and Push Docker Images` deploy workflow.

Resolution order:

1. Use `METASHEET_K3WISE_SMOKE_TOKEN` when the repository secret exists.
2. Otherwise, if `METASHEET_TENANT_ID` and deploy SSH inputs are available,
   connect to the deploy host, execute inside the running backend container,
   select an active admin user, and sign a temporary JWT with
   `authService.createToken()`.
3. If auth is optional, emit a warning and continue without a token.
4. If auth is required, fail before running the smoke.

The temporary token defaults to `JWT_EXPIRY=2h` for the minting process and
carries the explicit `tenantId` used by the postdeploy list probes.

## Safety

- The workflow never prints `JWT_SECRET`.
- The generated token is masked through `::add-mask::`.
- The token is written only to `GITHUB_ENV` for the current job.
- The deploy-host fallback is read-only against the application database.
- The deploy workflow keeps auth optional so missing deploy-token prerequisites
  do not block public postdeploy evidence.
- Manual `require_auth=true` becomes a hard gate: missing secret, missing tenant,
  or missing deploy SSH inputs fail early with a clear reason.

## Non-Goals

- Does not store generated tokens as repository secrets.
- Does not call customer K3 WISE, PLM, SQL Server, or middleware.
- Does not make production deploy require authenticated K3 WISE smoke yet.
