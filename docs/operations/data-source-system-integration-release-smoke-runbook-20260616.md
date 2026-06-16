# Data Source System Integration Release Smoke Runbook

Purpose: coordinate the final database/source-system integration release gate
after the C2/C3/C4/C5/C6 implementation slices have landed. This runbook does
not replace the slice-specific runbooks; it ties them into one values-free
release evidence package.

This runbook does not authorize production rollout, batch writes, K3 Save /
Submit / Audit / BOM, raw SQL, or broad writable database grants. C6 external
write remains sandbox-only until the C6 smoke gate passes and a separate
production/batch gate is explicitly opened.

## Scope

Allowed:

- verify the published on-prem package and deploy health;
- verify migration/auth readiness before trusting UI/API failures;
- run C2 read-only source smoke on the deployed package;
- run C3 incremental/watermark resume smoke on a bounded fixture;
- run C4 UI configuration smoke without copying credentials;
- cite or rerun the C5 K3/MSSQL read-only smoke gate;
- run C6 through the sandbox smoke runbook.

Forbidden:

- production or batch writes;
- using a production table as a C6 sandbox target;
- MetaSheet/product-driven external DB delete;
- raw SQL / query / stored procedure / trigger paths;
- K3 Save / Submit / Audit / BOM;
- credentials, connection strings, SQL text, raw row values, payload JSON,
  target request bodies, dry-run token, private ids, or value-bearing stack
  traces in issue comments.

## Evidence Reuse Ledger

Use this ledger to avoid rerunning already-closed gates blindly. It is an index,
not a release pass by itself: if the current release package changed the relevant
surface, or if the owner wants evidence against the exact release artifact, rerun
the corresponding section below and post fresh values-free evidence.

| Gate | Current anchor | Reuse rule for release signoff |
| --- | --- | --- |
| C2 read-only SQL source | issue #2600 closed PASS on package `f483bfdac`: PostgreSQL, MySQL/MariaDB, and SQL Server read-only paths all passed with `rowsWritten=0`, credentials stayed in `/data-sources`, and C3/C6/K3 writes were not run. | May be cited as prior entity-machine coverage for the read-only bridge. Rerun section 3 on the release package if C2 source/adapter/package surfaces changed or if exact-package evidence is required. |
| C3 incremental/watermark | Runtime and CI real-DB wire locks are landed on main, but no release-package entity-machine incremental/resume smoke is recorded in this runbook. Large-BOM #2425 is related Data Factory C3/C4 evidence, not the SQL watermark/resume release gate. | Section 4 remains required for complete delivery unless an owner explicitly narrows the release scope and uses downgraded wording. Do not cite #2425 as C3 watermark/resume PASS. |
| C4 UI configuration | Source/object/schema picker, source-field picker, watermark UI, and read-only/source-only boundary UX have landed, but this runbook has no final release-package UI smoke evidence yet. | Section 5 remains required for complete delivery unless exact UI smoke is explicitly deferred with downgraded wording. |
| C5 K3/MSSQL read-only seam | issue #2670 closed PASS on package `dea391a1`: generic SQL Server smoke and K3 SQL Server executor smoke both passed after operator SQL scope adjustment; no K3 Save/Submit/Audit/BOM, external DB write, raw SQL, credentials, or row values were printed. | May be cited when no C5-relevant package/runtime surface changed after `dea391a1`; otherwise rerun the C5 runbook on the release package. |
| C6 external write | issue #2720 core sandbox dry-run/apply/re-pull/rollback PASS and read-only dedicated-route PASS; controlled bad-row remains HOLD on `HOLD_TARGET_DDL_UNAVAILABLE` until a safe seeded-row/DDL-backed write-time failure shape is available. | C6-5 is not closed. Release signoff cannot claim complete database/source-system delivery until controlled bad-row row-level failure/dead-letter/provenance evidence passes values-free. |

## Required Inputs

Capture only values-free identifiers:

```text
release:
  packageFingerprint=<git short sha>
  releaseTag=<public release tag>
  packageName=<package name>
  sha256SumsPresent=true|false
  tgzVerified=true|false
  zipVerified=true|false
  deployApplyExit=<code>
  health=200|...
```

Do not include hosts, database names, usernames, passwords, connection strings,
table values, dry-run tokens, target payload JSON, or raw SQL.

## 1. Package / Deploy Preflight

Run after the release package is deployed on the entity machine.

Expected:

- published assets include `.tgz`, `.zip`, `.sha256`, `SHA256SUMS`, and verify
  reports;
- local checksum verification passes;
- deploy command exits `0`;
- `/health` returns `200`;
- package fingerprint matches the intended source commit.

Evidence:

```text
packagePreflight:
  assetSetComplete=true|false
  checksumVerified=true|false
  deployApplyExit=<code>
  health=200|...
  packageFingerprint=<git short sha>
```

## 2. Migration / Auth Preflight

Run before interpreting any UI/API failure as an application bug.

Expected:

- pending migration diff is clean or explicitly applied before deploy;
- post-deploy auth round-trip succeeds;
- silent `401` is triaged as possible schema/migration drift first, not as a
  JWT secret guess.

Evidence:

```text
migrationAuth:
  pendingMigrationDiffClean=true|false
  migrationsAppliedBeforeDeploy=true|false
  authRoundTrip=pass|fail
  silent401Observed=true|false
  triagePath=schema_migration_first|not_needed|other
```

## 3. C2 Read-Only Source Smoke

Verify the deployed package can read configured SQL sources through the
Data Factory bridge.

Expected:

- `/data-sources` remains the only credential surface;
- Workbench/integration config references `dataSourceId` only;
- `testConnection`, `listObjects`, `getSchema`, and bounded read/dry-run pass
  for each available engine in scope;
- no rows are written.

Evidence:

```text
c2ReadOnly:
  postgres=pass|fail|not_run
  mysql=pass|fail|not_run
  sqlserver=pass|fail|not_run
  objectsListed=true|false
  schemaLoaded=true|false
  rowsReadGreaterThanZero=true|false
  rowsWritten=0
  credentialsCopied=false
  valuesFreeEvidence=true
```

## 4. C3 Incremental / Watermark Smoke

Use a bounded fixture that can prove resume behavior without exposing row
values.

Expected:

- `updated_at + tiebreaker` composite cursor does not miss same-timestamp ties;
- in-run cursor advances across pages;
- resume starts from the stored watermark without duplicating already-read rows;
- max-pages/partial behavior does not advance watermark on truncated reads;
- cursor details are redacted in evidence.

Evidence:

```text
c3Incremental:
  mode=updated_at_composite|monotonic_id|not_run
  pagesRead=<count>
  sameTimestampTieCovered=true|false
  resumeReadDuplicateCount=0
  maxPagesPartialNoWatermarkAdvance=true|false|not_applicable
  cursorValuesPrinted=false
  valuesFreeEvidence=true
```

## 5. C4 UI Configuration Smoke

Use the Workbench UI on the deployed package.

Expected:

- source picker stores `config.dataSourceId + object`, not credentials;
- schema/table/object picker works for the selected source;
- source-field picker uses loaded schema and keeps stale values explicit;
- watermark UI stores `options.watermark` only for incremental mode;
- read-only/source-only boundary text is visible.

Evidence:

```text
c4Ui:
  sourcePicker=pass|fail|not_run
  objectPicker=pass|fail|not_run
  schemaPicker=pass|fail|not_run
  sourceFieldPicker=pass|fail|not_run
  watermarkUi=pass|fail|not_run
  credentialsInputVisible=false
  credentialsCopied=false
  boundaryTextVisible=true|false
  valuesFreeEvidence=true
```

## 6. C5 K3/MSSQL Read-Only Seam

C5 is already closed by issue #2670. For release signoff, either cite the closed
gate when no C5-relevant package surface changed after that package, or rerun
the C5 runbook on the current package if the package/runtime surface changed.

Reference runbook:

- `docs/operations/data-source-system-integration-c5-k3-mssql-smoke-runbook-20260615.md`

Evidence:

```text
c5K3Mssql:
  gateSource=issue_2670|rerun_current_package
  genericSqlServerSmoke=pass|fail|not_run
  k3SqlServerExecutorSmoke=pass|fail|not_run
  k3Save=false
  k3Submit=false
  k3Audit=false
  k3BomWrite=false
  externalDbWrite=false
  rawSql=false
  valuesFreeEvidence=true
```

## 7. C6 Sandbox External-Write Smoke

Run or continue the dedicated C6 sandbox runbook. For a fresh run, do not
compress or skip its ordered sequence. If issue evidence already proves earlier
steps, continue from the next pending step and cite those passed checkpoints
instead of rerunning write/admin Apply solely to repeat evidence.

Reference runbook:

- `docs/operations/data-source-system-integration-c6-sandbox-smoke-runbook-20260616.md`

Required C6 evidence summary:

```text
c6Sandbox:
  sandboxWriteTargetConfigured=true|false
  activeC6PipelineConfigured=true|false
  dryRun=pass|fail|not_run
  apply=pass|fail|not_run
  repullIdempotence=pass|fail|not_run
  readOnlyUserExternalWriteDryRunAllowed=true|false
  readOnlyUserApplyBlocked=true|false
  controlledBadRow=pass|fail|hold|not_run
  controlledBadRowStopReason=none|target_ddl_unavailable|seeded_row_unavailable|no_safe_failure_shape|not_available
  rollbackCleanup=pass|fail|not_run
  productDeleteRouteUsed=false
  productRawSqlUsed=false
  productExternalDbDelete=false
  productionWrite=false
  batchWrite=false
  valuesFreeEvidence=true
```

Current #2720 checkpoint as of 2026-06-16:

- core sandbox dry-run/apply/re-pull/rollback: passed;
- dedicated read-only route subgate: passed
  (`/external-write/dry-run` allowed for `integration:read`; `/external-write/apply`
  blocked for the same read-only user);
- controlled bad-row: attempted, HOLD on target DDL/TRIGGER privilege unavailable;
  no Apply ran for that attempt, no target rows were written.

## Stop Rules

Stop and report HOLD if any of these occur:

- package checksum or deploy health fails;
- pending migration diff is not understood;
- auth round-trip fails or silent `401` appears without schema/migration triage;
- Workbench stores credentials outside `/data-sources`;
- C2/C3/C4 evidence contains row values or secrets;
- C3 cursor values appear in issue evidence;
- C5 touches K3 Save / Submit / Audit / BOM or external DB write;
- C6 sandbox target/pipeline is missing;
- C6 dry-run mutates the target;
- C6 dedicated `/external-write/dry-run` rejects an `integration:read` user
  in a fresh rerun;
- C6 apply can be sent by a read-only user;
- C6 re-pull produces duplicate target rows or `add>0` after a successful
  apply;
- C6 rollback/cleanup requires a MetaSheet product delete/raw SQL path;
- any evidence contains credentials, connection strings, raw SQL, row values,
  payload JSON, private ids, dry-run tokens, or value-bearing stack traces.

## Issue Reply Template

```text
Data-source/system-integration release smoke

release:
  packageFingerprint=<git short sha>
  releaseTag=<public release tag>
  packageName=<package name>

packagePreflight:
  assetSetComplete=true|false
  checksumVerified=true|false
  deployApplyExit=<code>
  health=200|...

migrationAuth:
  pendingMigrationDiffClean=true|false
  migrationsAppliedBeforeDeploy=true|false
  authRoundTrip=pass|fail
  silent401Observed=true|false
  triagePath=schema_migration_first|not_needed|other

c2ReadOnly:
  postgres=pass|fail|not_run
  mysql=pass|fail|not_run
  sqlserver=pass|fail|not_run
  objectsListed=true|false
  schemaLoaded=true|false
  rowsReadGreaterThanZero=true|false
  rowsWritten=0
  credentialsCopied=false

c3Incremental:
  mode=updated_at_composite|monotonic_id|not_run
  pagesRead=<count>
  sameTimestampTieCovered=true|false
  resumeReadDuplicateCount=0
  maxPagesPartialNoWatermarkAdvance=true|false|not_applicable
  cursorValuesPrinted=false

c4Ui:
  sourcePicker=pass|fail|not_run
  objectPicker=pass|fail|not_run
  schemaPicker=pass|fail|not_run
  sourceFieldPicker=pass|fail|not_run
  watermarkUi=pass|fail|not_run
  credentialsInputVisible=false
  credentialsCopied=false
  boundaryTextVisible=true|false

c5K3Mssql:
  gateSource=issue_2670|rerun_current_package
  genericSqlServerSmoke=pass|fail|not_run
  k3SqlServerExecutorSmoke=pass|fail|not_run
  k3Save=false
  k3Submit=false
  k3Audit=false
  k3BomWrite=false
  externalDbWrite=false
  rawSql=false

c6Sandbox:
  sandboxWriteTargetConfigured=true|false
  activeC6PipelineConfigured=true|false
  dryRun=pass|fail|not_run
  apply=pass|fail|not_run
  repullIdempotence=pass|fail|not_run
  readOnlyUserExternalWriteDryRunAllowed=true|false
  readOnlyUserApplyBlocked=true|false
  controlledBadRow=pass|fail|hold|not_run
  controlledBadRowStopReason=none|target_ddl_unavailable|seeded_row_unavailable|no_safe_failure_shape|not_available
  rollbackCleanup=pass|fail|not_run
  productDeleteRouteUsed=false
  productRawSqlUsed=false
  productExternalDbDelete=false
  productionWrite=false
  batchWrite=false

boundaries:
  credentialsPrinted=false
  connectionStringPrinted=false
  rawSqlPrinted=false
  rowValuesPrinted=false
  payloadJsonPrinted=false
  privateIdsPrinted=false
  dryRunTokenPrinted=false
  valuesFreeEvidence=true

operatorDecision=pass|hold|fail
```

## Pass Criteria

Release signoff requires all of:

- package preflight passes;
- migration/auth preflight passes;
- C2 read-only smoke passes for the engines in release scope;
- C3 incremental/resume smoke passes;
- C4 UI config smoke passes;
- C5 K3/MSSQL gate is either cited from #2670 or rerun cleanly on the current
  package;
- C6 sandbox smoke passes through the dedicated C6 runbook;
- issue evidence is values-free;
- no forbidden boundary is opened.

The Evidence Reuse Ledger above may justify citing prior gates where explicitly
allowed, but it does not change these pass criteria and does not turn a HOLD into
PASS.

Before C6 sandbox smoke passes, describe the product as "read-only database
source integration available with external-write still gated". Only after C2,
C3, C4, C5, and C6 all pass may the release discuss complete
database/source-system integration delivery. If an owner explicitly removes C3
from a narrower release scope, use downgraded wording that names the missing
incremental/resume gate; do not call it complete delivery. Production/batch
rollout still requires a separate explicit gate.
