# Stock Preparation S6-A SQL Server On-Prem Runbook

Status: S6-A package content. Execution requires a separate S6-B owner token.

## Scope

This runbook covers one controlled, read-only SQL Server sealed-snapshot run
into the existing internal stock-preparation persistence path.

Frozen limits:

- one customer;
- source mode `READ_ONLY`;
- `externalWrite=false`;
- feature flag default and final state `OFF`;
- at most 24,999 business lines;
- no scheduler, generic public route, rollout, or PLM/ERP/CRM/SRM
  generalization.

Stop immediately if the S6-B instruction, package SHA256, service/runtime SHA,
manifest digest, or provenance digest is absent or differs from the published
values. Do not substitute an earlier package.

Until that exact S6-B instruction is published:

```text
nextTestMachineAction=STOP_AND_WAIT
deployment=NOT_AUTHORIZED
customerSourceAccess=NOT_AUTHORIZED
flagOnWindow=NOT_AUTHORIZED
```

## Required Inputs

The S6-B instruction must publish these non-secret values:

```text
serviceRuntimeSha=<40-hex merge SHA>
packageFile=<exact archive name>
packageSha256=<64-hex digest>
packageProvenanceManifestDigest=<64-hex digest>
acceptanceOperationId=<random values-free operation token>
runtimeDatabaseRole=<role name>
provisioningDatabaseRole=<different role name>
```

The operator supplies secrets through the deployment secret store. Do not put
database URLs, passwords, bearer tokens, source endpoints, SQL, private keys,
or source rows in GitHub comments or evidence artifacts.

## 1. Verify The Frozen Package

1. Download the exact archive named by the S6-B instruction.
2. Verify its SHA256 before extraction.
3. On a host with Node.js 20, run the packaged
   `scripts/ops/multitable-onprem-package-verify.sh` against the extracted
   package.
4. Read `BUILD_PROVENANCE.json` from the package and require its 40-hex
   `gitCommit` to equal the published `serviceRuntimeSha`.
5. Run the packaged sealed-export provenance verifier and require its
   `frozenManifestDigest` to equal the published
   `packageProvenanceManifestDigest`:

   ```powershell
   node -e "const p=require('./plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs'); console.log(p.verifySealedExportRuntimePackageProvenance({repoRoot:process.cwd()}).frozenManifestDigest)"
   ```

6. Perform the prescribed one-byte mutation negative check on a disposable
   copy. The verifier must fail.

Any mismatch is a terminal `STOP_AND_REPORT`; do not deploy.

## 2. Create PostgreSQL Roles Before Migrations 073, 074 And 075

Migration `073_create_sealed_export_stock_prep_runtime_authority` is recorded
once by Kysely. The two roles and both PostgreSQL settings must exist before
that migration is first applied. Applying migration 073 without the settings
leaves its grants latent and is not an accepted deployment.

As the database owner, create two distinct login roles with:

```text
NOSUPERUSER
NOCREATEDB
NOCREATEROLE
NOREPLICATION
NOBYPASSRLS
NOINHERIT
```

Neither role may participate in any PostgreSQL role membership in either
direction at migration time. They must not equal the migration owner.
Passwords remain in the deployment secret store.

Before running the package migration command, set:

```powershell
$env:PGOPTIONS = '-c metasheet.sealed_export_runtime_role=<runtime-role> -c metasheet.sealed_export_provisioning_role=<provisioning-role>'
```

Then run the packaged migration entry point and confirm the exact migration:

```powershell
node packages/core-backend/dist/src/db/migrate.js --list
node packages/core-backend/dist/src/db/migrate.js
node packages/core-backend/dist/src/db/migrate.js --confirm 073_create_sealed_export_stock_prep_runtime_authority
node packages/core-backend/dist/src/db/migrate.js --confirm 074_repair_sealed_export_runtime_authority_privileges
node packages/core-backend/dist/src/db/migrate.js --confirm 075_grant_sealed_export_runtime_authority_row_lock
Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
```

`PGOPTIONS` must stay set for the WHOLE migration run, not just around 073.
Migrations 074 and 075 read the SAME two settings and take the SAME
NOTICE-and-return branch when those settings are absent (074 lines 64-78, 075
lines 107-121). A run that sets them only for 073 records 074 and 075 as
applied while their grants are latent, and reports NOTHING wrong.

If migration 073, 074 or 075 was already recorded without the two grants, stop.
Do not rerun the SQL file manually and do not enable the feature flag.

Then confirm the grants actually landed. `--confirm` proves a migration was
RECORDED; it does not prove the grants exist, because the latent branch records
the migration too. All three predicates must return true:

```sql
SELECT
  has_column_privilege('<provisioning-role>',
    'integration_sealed_export_signer_public_keys', 'updated_at', 'UPDATE') AS grant_074,
  has_column_privilege('<runtime-role>',
    'integration_sealed_export_authority_state', 'updated_at', 'UPDATE')    AS grant_075,
  has_table_privilege('<runtime-role>',
    'integration_sealed_export_generation_audit', 'SELECT')                 AS grant_073;
```

Why these two migrations exist, so a reader can judge whether a latent grant
matters: without 074 provisioning fails at the signer-key row lock; without 075
the final activation transaction fails to lock the authority state. Both surface
at RUNTIME as a bare PostgreSQL `42501`, already wrapped by the time an operator
sees it. Both were verified on PostgreSQL 16 AND 17.

## 3. Deploy With The Feature Flag Off

Deploy the verified package using the existing on-prem package procedure with:

```text
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED=false
```

Restart the service and verify:

- PM2/service state is stable;
- `/api/integration/health` is healthy;
- `stockPreparationSqlServerSealedSnapshot` is not enabled;
- no customer-source connection occurs.

## 4. Prepare Private Material

Create these files outside the package and repository, restrict their ACL to
the service/provisioning identities, and never print their contents:

```text
identity key:       32-128 random bytes
evidence key:       32-128 random bytes
qualification key:  32-128 random bytes
signer key:         Ed25519 PKCS8 private PEM
provisioning spec:  strict JSON matching the approved customer binding
```

The provisioning spec contains private connection material. Store it only in
the controlled secret area and remove the transient copy after successful
provisioning. Its external-system identity and source configuration must match
the approved server-side external-system record used by the runtime.

That record is a PREREQUISITE this runbook does not create. Nothing earlier in
this document, and nothing in the PostgreSQL readiness checklist, produces it —
so treat it as an input to be confirmed BEFORE the window, not a step inside it.

The first-party surface that creates and lists it is:

```text
POST /api/integration/external-systems     (create/update; admin)
GET  /api/integration/external-systems     (list; admin — read-only, safe to run now)
```

Confirm with the GET, before the window, that a record exists whose identity
fields equal the ones in the provisioning spec: `id`, `tenantId`,
`workspaceId` (JSON `null`), `kind`, `role`, `status`. A mismatch on any of
them is refused as `SEALED_EXPORT_BINDING_UNQUALIFIED` — a token that reads as
"the binding is bad" and does not say which field disagreed.

`scripts/ops/stock-preparation-s6a-operator-preflight.mjs` checks this same
identity agreement offline and names the disagreeing input. It cannot check
agreement against the DATABASE (that needs the running service), so the GET
above and the preflight are complementary, not alternatives.
This single-customer v1 route has no workspace selector: both
`binding.workspaceId` and `externalSystem.workspaceId` must be JSON `null`.
Any non-null workspace scope is refused before qualification.

The SQL Server credential in that spec must be a dedicated login for this
binding. Grant it `SELECT` only on the approved source relation. It must not be
`sysadmin`, `db_owner`, or `db_datawriter`, and it must have no effective
`INSERT`, `UPDATE`, `DELETE`, `ALTER`, or `CONTROL` permission on that
relation. Do not reuse the DBA/setup credential. The runtime forces
`ApplicationIntent=ReadOnly` and rechecks these effective permissions before
opening the snapshot transaction; any mismatch is fail-closed.

## 5. Provision The Authority

Set the provisioning environment in the controlled shell:

```text
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_ROLE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_URL
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_SPEC_FILE
```

Run:

```powershell
node plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs
```

The command probes the approved source and issues a qualification that expires
five minutes after that probe. Run it immediately before the controlled
flag-on restart. An exact rerun with the same binding, system identity, signer,
and public key refreshes only the qualification; any changed anchor is refused.

The only accepted success shape is values-free, with `changed` set to either
`true` or `false`:

```json
{"ok":true,"changed":true,"externalWrite":false,"qualificationCurrent":true,"signerEnrolled":true,"valuesFree":true}
```

The first provisioning or a qualification refresh reports `"changed":true`;
an exact replay within the same qualification instant may report
`"changed":false`. Any other result is `STOP_AND_REPORT`.

## 6. One Controlled Flag-On Window

Set the runtime-only environment:

```text
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED=true
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_EVIDENCE_KEY_FILE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_ROLE
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_URL
MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE
```

Restart the service. Confirm health reports
`stockPreparationSqlServerSealedSnapshot=true`. Put the admin bearer token in
`METASHEET_ADMIN_TOKEN`, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  scripts/ops/stock-preparation-s6a-onprem-acceptance.ps1 `
  -OperationId '<published acceptanceOperationId>' `
  -ExpectedServiceRuntimeSha '<published serviceRuntimeSha>' `
  -ExpectedPackageSha256 '<published packageSha256>' `
  -PackageRoot '<absolute extracted package root>' `
  -PackageArchivePath '<absolute original archive path>' `
  -SummaryPath stock-preparation-s6a-acceptance-summary.txt
```

The runner performs one controlled source read and replays the same
`operationId`. The replay must be `internal_noop`, retain the same line count,
and keep `sourceReadCount=1`.

## 7. Unconditional Flag-Off Restoration

Whether the acceptance passes or fails:

1. set `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED=false`;
2. remove the runtime source/database secret values from the process
   environment;
3. restart the service;
4. confirm the service is healthy and the S6 capability is disabled;
5. confirm no bearer token remains in the shell environment.

Do not retry with a new `operationId` after a failure without a new owner
instruction.

If the process stops while the source capture is still `CAPTURING`, the
original `operationId` remains reserved for a five-minute lease. The runtime
never resumes or repeats that source read. Under a subsequent owner
instruction, observing the same operation after the lease atomically records
`CAPTURE_FAILED`; only a separately authorized new operation may read the
source again.

Flag-off restoration disables execution; it is not a data-erasure claim. The
artifact root contains private source-derived material and must remain under
the approved ACL and retention policy. The S6-B instruction must name the
post-window retention or purge owner. Do not manually delete it while a run
may still require recovery.

## 8. Values-Free Result

Return only:

```text
serviceRuntimeSha=<40-hex>
packageSha256=<64-hex>
packageProvenanceManifestDigest=<64-hex>
packageVerification=PASS|FAIL
oneByteNegativeCheck=PASS|FAIL
migration073=PASS|FAIL
runtimeRoleVerified=PASS|FAIL
provisioningRoleVerified=PASS|FAIL
provisioning=PASS|FAIL
healthFlagOffBefore=PASS|FAIL
healthFlagOn=PASS|FAIL
firstRun=PASS|FAIL
replayRun=PASS|FAIL
sourceReadCount=0|1
businessLineCount=<count only>
externalWrite=false
machineBindingDigest=<64-hex>
operationBindingDigest=<64-hex>
flagOffRestored=PASS|FAIL
tokenHygiene=PASS|FAIL
overallAcceptance=PASS|FAIL
```

Do not attach logs containing source values, identifiers, SQL, endpoints,
credentials, tokens, private keys, tenant IDs, raw HTTP bodies, or stack
traces.
