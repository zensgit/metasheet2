# Deploy Immutable Traceability Verification

Issue: #504
Date: 2026-05-27

## Scope

This change hardens the GitHub Actions Docker deploy path. It does not change application deployment secrets, K3 WISE smoke semantics, or the on-prem package flow.

## Implementation Summary

- Docker images receive OCI revision/source/created labels.
- Backend runtime exposes normalized build metadata in `/health` under `build`.
- Frontend image writes `build-info.json` into the nginx web root.
- `.github/workflows/docker-build.yml` deploys only a full commit-SHA image tag for production.
- Remote deploy logs the expected commit, pulled backend/web images, and repo digests.
- Remote deploy adds `VERSION VERIFY` after smoke:
  - fetch backend `/health`;
  - fetch web `/build-info.json`;
  - fail the deploy when either served commit differs from the expected SHA.
- `scripts/ops/deploy-attendance-prod.sh` now enforces the same full-SHA production deploy contract.
- Step summary gains a `Deploy Traceability` section and links to the operator runbook.

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/build-info.test.ts --reporter=verbose
node --test scripts/ops/deploy-immutable-traceability-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Acceptance Mapping

- Immutable deploy identity: `DEPLOY_IMAGE_TAG` is `${{ github.sha }}` and remote deploy rejects non-40-character SHA values.
- Operator-visible output: deploy log and step summary include expected commit, served backend/web commits, image tags, and repo digests.
- Post-deploy verification: remote deploy fails if backend `/health` or web `/build-info.json` does not report the expected commit.
- Documentation: `docs/operations/deploy-immutable-traceability-runbook.md`.
