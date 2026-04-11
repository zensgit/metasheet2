# PLM Yuantus Pact Consumer CI

Date: 2026-04-11

## Summary

This change adds a dedicated Metasheet2 consumer contract gate for the
Yuantus federation surface.

The goal is narrow on purpose:

- run only when the Yuantus pact-relevant consumer surface changes
- avoid mixing this gate into unrelated platform CI
- keep the exact local verification commands identical to the GitHub Actions
  workflow

## Design

The new workflow is:

- `.github/workflows/yuantus-pact-consumer.yml`

It triggers on:

- `pull_request` to `main`
- `push` to `main`

It only runs when one of these paths changes:

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/tests/contract/**`
- `packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts`
- `packages/core-backend/package.json`
- `pnpm-lock.yaml`
- `.github/workflows/yuantus-pact-consumer.yml`

Runtime shape:

- Node `20.x`
- `pnpm/action-setup@v4`
- pnpm `10.16.1`
- `pnpm install --frozen-lockfile`

Execution commands:

```bash
pnpm --filter @metasheet/core-backend test:contract
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-adapter-yuantus.test.ts --reporter=dot
```

## Verification

Local verification on the closeout branch:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend test:contract
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-adapter-yuantus.test.ts --reporter=dot
```

Observed results:

- contract tests: `16 passed`
- targeted Yuantus adapter unit tests: `19 passed`

Additional checks:

- `git diff --check` passed
- workflow YAML parsed successfully

## Non-Goals

- no new business logic
- no Pact artifact regeneration
- no merge with the broader plugin / platform CI workflows
