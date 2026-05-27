# Immutable Deploy Traceability Runbook

Issue: #504
Date: 2026-05-27

## Purpose

Production deploys must be traceable from a GitHub commit to the exact runtime that the target host is serving. The Docker build workflow now treats the GitHub commit SHA as the deploy identity and verifies it after rollout.

## Deploy Identity

The production Docker workflow builds both runtime images with the current `GITHUB_SHA`:

- `ghcr.io/zensgit/metasheet2-backend:<GITHUB_SHA>`
- `ghcr.io/zensgit/metasheet2-web:<GITHUB_SHA>`

The workflow and `scripts/ops/deploy-attendance-prod.sh` reject deploys whose `DEPLOY_IMAGE_TAG` is not a full 40-character commit SHA. The backend image exposes the same SHA through `/health`; the web image writes it to `/build-info.json`.

## Operator-Visible Evidence

Download the deploy artifact for a run:

```bash
gh run download <run-id> -n "deploy-logs-<run-id>-<attempt>" -D output/playwright/ga/<run-id>
```

Inspect trace lines:

```bash
rg -n "deploy-trace|deploy-version|Deploy version|VERSION VERIFY" \
  output/playwright/ga/<run-id>/deploy.log \
  output/playwright/ga/<run-id>/step-summary.md
```

Expected deploy log markers:

- `[deploy-trace] expected_commit=<40-char-sha>`
- `[deploy-trace] backend_image=ghcr.io/zensgit/metasheet2-backend:<40-char-sha>`
- `[deploy-trace] backend_repo_digest=...@sha256:...`
- `[deploy-trace] web_image=ghcr.io/zensgit/metasheet2-web:<40-char-sha>`
- `[deploy-trace] web_repo_digest=...@sha256:...`
- `[deploy-version] backend_commit=<40-char-sha>`
- `[deploy-version] web_commit=<40-char-sha>`
- `Deploy version: expected=<40-char-sha> backend=ok web=ok`

The step summary also includes a **Deploy Traceability** section with the expected commit, served backend/web commits, and pulled repo digests.

## Direct Host Verification

From the deploy host:

```bash
EXPECTED_COMMIT=<40-char-sha>

curl -fsS http://127.0.0.1:8900/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"]["commit"])'

curl -fsS http://127.0.0.1:8081/build-info.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"])'
```

Both commands must print the expected commit.

To inspect immutable image provenance after pull:

```bash
docker image inspect "ghcr.io/zensgit/metasheet2-backend:${EXPECTED_COMMIT}" \
  --format '{{range .RepoDigests}}{{println .}}{{end}}'

docker image inspect "ghcr.io/zensgit/metasheet2-web:${EXPECTED_COMMIT}" \
  --format '{{range .RepoDigests}}{{println .}}{{end}}'
```

The digest lines are recorded in `deploy.log` and should match the pulled images on the host.

## Failure Interpretation

- `DEPLOY_IMAGE_TAG must be an exact 40-character commit SHA`: the workflow was not deploying an immutable commit identity.
- `backend commit mismatch`: the backend container did not serve the image built from the expected commit.
- `web commit mismatch`: nginx is serving a web image that does not match the expected commit.
- Missing repo digest: investigate GHCR pull/cache behavior; the commit check still protects served runtime identity, but the digest should be recovered before incident closeout.

Do not close a production incident with only `IMAGE_TAG` evidence. Use the served backend/web commit checks plus the pulled repo digests.

## Manual Production Script

For host-shell production deployment:

```bash
DEPLOY_IMAGE_TAG=<40-char-sha> \
DEPLOY_EXPECTED_COMMIT=<same-40-char-sha> \
bash scripts/ops/deploy-attendance-prod.sh
```

The script prints the expected commit, backend/web image references, repo digests, and served backend/web commits before reporting `Deploy complete`.
