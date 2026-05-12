# Generic Integration Workbench Same-System and SQL Advanced Verification - 2026-05-12

## Files Changed

- `plugins/plugin-integration-core/__tests__/pipelines.test.cjs`
- `docs/development/generic-integration-workbench-development-plan-20260512.md`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-same-system-sql-design-20260512.md`
- `docs/development/generic-integration-workbench-same-system-sql-verification-20260512.md`

## Verification Matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Same source and target system with `bidirectional` role | Pipeline is accepted | New `crm_bidirectional` test case |
| Same source and target system with `source` role | Pipeline is rejected as invalid target | New `crm_source_only` test case |
| Source and target objects differ on same system | Objects are preserved separately | New assertions on `customers_raw` and `customers_clean` |
| SQL channel positioning | Advanced-only in plan/TODO | Development plan and TODO M3 |
| No migration introduced | PASS by inspection | Only docs and one test file changed |

## Commands

Executed in `/Users/chouhua/Downloads/Github/metasheet2`:

```bash
node plugins/plugin-integration-core/__tests__/pipelines.test.cjs
pnpm -F plugin-integration-core test
git diff --check
```

## Result

PASS.

| Command | Result |
| --- | --- |
| `node plugins/plugin-integration-core/__tests__/pipelines.test.cjs` | PASS - pipeline registry tests passed, including same-system bidirectional coverage |
| `pnpm -F plugin-integration-core test` | PASS - all 20 plugin-integration-core test files passed |
| `git diff --check` | PASS - no whitespace errors or conflict markers |

The full plugin test run also covered K3 WISE WebAPI, K3 WISE SQL Server channel, HTTP adapter, PLM wrapper, pipeline runner, REST routes, feedback writer, staging installer, and migration SQL shape tests.
