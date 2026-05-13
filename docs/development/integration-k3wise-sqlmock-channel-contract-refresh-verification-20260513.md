# K3 WISE SQL Mock Channel Contract Refresh Verification - 2026-05-13

## Local Verification

```bash
node --check scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs
```

Result:

- Syntax check passes.

```bash
node --test scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs
```

Result:

- SQL mock contract suite passed: 12/12.
- Real channel `read()` goes through mock `select()`.
- Real channel `upsert()` goes through mock `insertMany()`.
- Direct K3 core-table upsert stays rejected before executor write.
- CTE-wrapped writes, `MERGE`, and unsupported `EXEC` are rejected.
- Existing bracketed and three-part identifier coverage remains passing.

```bash
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Result:

- Mock K3 WebAPI Save-only flow passes.
- SQL channel `read()` returns one canned K3 core-table row.
- SQL channel `upsert()` writes one integration middle-table row.
- Raw SQL safety probe rejects `INSERT` into `t_ICItem`.
- Evidence compiler returns PASS.

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

- Preflight tests passed: 20/20.
- Evidence tests passed: 37/37.
- SQL mock contract tests passed: 12/12.
- Mock PoC chain completed with PASS.

```bash
git diff --check origin/main..HEAD
```

Result:

- No whitespace errors.

## Notes

This verification is offline. It validates fixture/adapter contract coverage before a live customer K3 WISE run, not a real customer database.
