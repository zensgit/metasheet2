# K3 WISE Mock SQL Bracketed Schema Verification

Date: 2026-05-07

## Scope

Files verified:

- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs`
- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`

## Checks

Run from repository root:

```bash
node --check scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs
node --check scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs
node --test scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
pnpm run verify:integration-k3wise:poc
git diff --check
```

## Results

- `node --check scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs`: pass.
- `node --check scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs`: pass.
- `node --test scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs`: pass, 5/5 tests.
- `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`: pass, end-to-end mock chain decision PASS.
- `pnpm run verify:integration-k3wise:poc`: pass, preflight 16/16, evidence 31/31, mock PoC demo PASS.
- `git diff --check`: pass.

## Acceptance

- `[dbo].[t_ICItem]` resolves to `t_icitem` and reads canned K3 core rows.
- `[AIS_TEST_MOCK].[dbo].[t_ICItem]` resolves to `t_icitem`.
- `[dbo].[integration_material_stage]` resolves to
  `integration_material_stage` and remains writable in the mock.
- `[dbo].[t_ICItem]` core-table writes remain blocked.
- `"dbo"."integration_material_stage"` resolves correctly.
- The offline K3 WISE mock PoC chain still passes.
