# K3 WISE SQL Mock Channel Contract Verification

Date: 2026-05-06

## Local Verification

Command:

```bash
node --test scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs
```

Result:

- `8/8` tests passed.

Command:

```bash
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Result:

- Mock K3 WebAPI Save-only flow passed.
- SQL channel `read()` returned one canned K3 core-table row.
- SQL channel `upsert()` wrote one integration middle-table row.
- Raw SQL safety probe rejected `INSERT` into `t_ICItem`.
- Evidence compiler returned `PASS`.

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

- Preflight tests passed: `16/16`.
- Live evidence tests passed: `31/31`.
- SQL mock contract tests passed: `8/8`.
- Mock PoC chain completed with `K3 WISE PoC mock chain verified end-to-end (PASS)`.

Command:

```bash
git diff --check -- package.json scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs scripts/ops/fixtures/integration-k3wise/README.md docs/development/integration-k3wise-sqlmock-channel-contract-development-20260506.md docs/development/integration-k3wise-sqlmock-channel-contract-verification-20260506.md
```

Result:

- Passed with no whitespace errors.

## Coverage

- real channel `read()` succeeds through mock `select()`;
- real channel `upsert()` succeeds through mock `insertMany()`;
- direct K3 core-table upsert remains rejected;
- CTE-wrapped write is rejected through `query()`;
- `MERGE` into K3 core tables is rejected;
- unsupported SQL operations are rejected;
- mock PoC demo still reaches PASS after using channel-level SQL probes.
