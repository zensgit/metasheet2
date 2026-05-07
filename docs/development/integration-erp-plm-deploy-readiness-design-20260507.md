# Integration ERP/PLM Deploy Readiness Design - 2026-05-07

## Context

The PLM -> MetaSheet cleanse -> K3 WISE work has enough backend and UI slices to start internal staging tests, but the current implementation is spread across many small PRs and one UI stack:

- Mainline hardening PRs against `main`.
- K3 WISE setup UI stack: `#1305 -> #1364 -> #1392`.
- Existing local gates: offline K3 WISE PoC, plugin integration-core tests, K3 setup helper tests, frontend build.

Without a single readiness check, staging prep becomes a manual spreadsheet exercise and it is easy to deploy an incomplete stack.

## Change

Add `scripts/ops/integration-erp-plm-deploy-readiness.mjs`.

The script:

- Checks required mainline hardening PRs are present, open, based on `main`, clean, and have no failed/pending checks.
- Checks the K3 WISE UI stack is continuous from `main` through `#1305`, `#1364`, and `#1392`.
- Emits text, markdown, or JSON reports.
- Supports offline `--input-json` fixtures for deterministic tests.
- Supports `--require-approvals` for stricter release governance, but does not require approval by default because internal staging can run before human approval if CI is clean.
- Treats `mergeStateStatus=BLOCKED` as an approval/branch-protection warning by default, not a code-readiness failure; `BEHIND`, `DIRTY`, failed checks, and pending checks still block internal staging.

Package shortcut:

```bash
pnpm run verify:integration-erp-plm:deploy-readiness
```

## Scope

This is an ops/readiness gate only. It does not merge PRs, deploy services, access customer credentials, or call real PLM/K3 WISE systems.

## Internal Staging Definition

The script reports `candidate-ready` only when:

1. Required mainline hardening PRs are clean.
2. The K3 WISE UI stack is continuous and clean.

After that, the composed staging branch still needs local gates:

```bash
pnpm run verify:integration-k3wise:poc
pnpm -F plugin-integration-core test
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Customer Live Definition

Customer live remains blocked until the customer GATE answers, test account set, network route, and rollback plan exist. The script makes that explicit with `customerLive=blocked-until-customer-gate-and-test-account`.
