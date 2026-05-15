# Data Factory SQL Executor Bridge Handoff - Verification - 2026-05-15

## Verification Matrix

| Check | Command | Result |
| --- | --- | --- |
| Shell syntax | `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| Shell syntax | `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| Handoff included in package paths | `rg -n "integration-k3wise-sql-executor-bridge-handoff.md" scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| Handoff has executor contract | `rg -n "createK3WiseSqlServerChannelFactory|testConnection|select\\(|insertMany|SQLSERVER_EXECUTOR_MISSING" docs/operations/integration-k3wise-sql-executor-bridge-handoff.md` | PASS |
| Runbook links handoff | `rg -n "integration-k3wise-sql-executor-bridge-handoff.md" docs/operations/integration-k3wise-internal-trial-runbook.md` | PASS |
| Bridge Codex handoff updated | `rg -n "SQL Server executor handoff|queryExecutor.testConnection|queryExecutor.select|queryExecutor.insertMany" docs/development/k3wise-bridge-machine-codex-handoff-20260513.md` | PASS |
| Delivery bundle includes handoff | `rg -n "integration-k3wise-sql-executor-bridge-handoff.md|k3wise-bridge-machine-codex-handoff-20260513.md" scripts/ops/multitable-onprem-delivery-bundle.mjs` | PASS |
| Diff hygiene | `git diff --check origin/main...HEAD` | PASS |
| Secret text guard | secret-pattern grep on the three new docs | 0 matches |

## Expected Operator Behavior

Before bridge wiring:

- SQL source test may report `SQLSERVER_EXECUTOR_MISSING`;
- postdeploy smoke may emit `sqlserver-executor-availability=skipped`;
- staging-to-K3 #1542 signoff can still pass.

After bridge wiring:

- SQL source test should pass;
- postdeploy smoke should emit `sqlserver-executor-availability=pass`;
- direct SQL Server source dry-run can begin only against approved readonly
  views/tables.

## Safety Assertions

The handoff explicitly forbids:

- storing SQL credentials in tracked JSON or `external_systems.config`;
- user-written raw SQL;
- direct writes to K3 core tables;
- Submit/Audit through the SQL channel;
- printing credentials or token values into chat or artifacts.

The existing internal-trial runbook contains the literal field name
`must_change_password` in an unrelated token-minting SQL snippet. That is not a
secret value and was not introduced by this slice; the new bridge handoff docs
return 0 matches for the secret-pattern grep.

## Remaining Work

The actual production executor must be implemented and tested on the Windows/K3
bridge machine because it needs network access, customer-approved SQL
credentials, and the customer's actual allowlisted views or middle tables.
