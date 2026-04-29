# K3 WISE Offline PoC CI Design

## Context

The K3 WISE live PoC remains blocked on the customer's GATE answers. While we
wait, the repository already has a complete offline chain that does not contact
customer PLM, K3 WISE, SQL Server, or a running MetaSheet backend:

- preflight packet tests;
- evidence compiler tests;
- an end-to-end mock PoC demo that drives preflight, mock K3 WebAPI, mock SQL
  Server executor, Save-only upsert, SQL safety rejection, and evidence PASS.

Before this change, those commands were documented but not collected under one
root script or attached to a required GitHub PR workflow. That left the
customer-ready chain easy to forget when changing nearby integration code.

## Change

Add a root verification script:

```bash
pnpm run verify:integration-k3wise:poc
```

The script runs:

1. `node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
2. `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`
3. `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`

Then wire the script into `.github/workflows/plugin-tests.yml` as a lightweight
Node 20 job named `K3 WISE offline PoC`.

## Why Plugin System Tests

`Plugin System Tests` already runs on PRs and watches `plugins/**`, `scripts/**`,
`package.json`, and workflow changes. It is the closest existing workflow to the
integration plugin/runtime surface.

The offline PoC scripts are lightweight and dependency-free beyond Node and
checked-in source files. Keeping them in a separate Node 20 job avoids adding
work to the existing heavy test matrix, which installs the full workspace, runs
lint/typecheck/backend tests, starts Postgres/backend, and builds the web app.

## Safety

- No customer network calls.
- No production deploy behavior change.
- No database migration.
- No credentials or secrets required.
- No workspace dependency install is required for this job.
- The mock demo keeps the explicit `mock pass != customer live pass` boundary.

## Non-Goals

- Does not start K3 WISE live PoC.
- Does not infer customer GATE answers.
- Does not enable authenticated postdeploy smoke; that still needs a tenant
  scope or repository token.
