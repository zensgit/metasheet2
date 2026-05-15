# K3 WISE Bridge Machine Codex Handoff - 2026-05-13

## Purpose

Use this file to start a new Codex session on the integration bridge machine.

The bridge machine should sit in the same network as K3 WISE, so it can reach
the K3 WebAPI and, only when explicitly allowed, the K3 SQL Server or integration
database. The bridge Codex session is responsible for live connectivity,
preflight, dry-run, and Save-only sample validation. It should not become the
main development machine.

## First Message For The Bridge Codex Session

Paste this into Codex on the bridge machine after cloning the repository:

```text
请阅读 docs/development/k3wise-bridge-machine-codex-handoff-20260513.md。
当前目标：在集成桥接机上验证 MetaSheet 与 K3 WISE 的连接、dry-run、Save-only 小样本。
请不要输出任何密码、Token、authorityCode、SQL 连接串。
先做只读检查，再跑 preflight，再测试 WebAPI，再 dry-run；真实 Save-only 需要我明确确认。
```

## Division Of Work

| Machine | Responsibility |
| --- | --- |
| Current development machine | Code changes, PRs, release package generation, 142 deployment, tracked docs. |
| Bridge machine | K3 WISE intranet access, live WebAPI checks, optional SQL channel checks, dry-run, Save-only sample evidence. |

Do not copy full chat history between machines. Use this handoff file plus new
verification markdown written by the bridge machine.

## Required Local Tools On Bridge Machine

- Git
- Node.js 20 or newer
- pnpm 10
- Codex
- curl or PowerShell `Invoke-WebRequest`
- Network access to MetaSheet deployment
- Network access to K3 WISE WebAPI host
- Optional: SQL Server client tooling if SQL channel testing is approved

## Repository Setup

```bash
git clone https://github.com/zensgit/metasheet2.git
cd metasheet2
git checkout main
git pull --ff-only origin main
pnpm install
```

If dependency install is slow, the bridge session can still run the packaged
operator scripts from the deployed package as long as Node is available.

## Current Deployable Package

Use the Windows on-prem package when installing MetaSheet on a Windows bridge or
Windows-side test host:

```text
https://github.com/zensgit/metasheet2/releases/tag/multitable-onprem-k3wise-workbench-20260513-20548fe
```

Windows asset:

```text
metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip
```

This package is a prerelease intended for deployment testing. It includes the
K3 WISE setup page, generic integration workbench, postdeploy smoke scripts,
on-prem preflight script, and K3 WISE material/BOM template support.

## Secret Handling

Never paste or commit these values:

- K3 password
- K3 `authorityCode`
- K3 session ID
- SQL Server password
- SQL connection string
- MetaSheet admin JWT
- Bearer token

Use local files instead:

```text
.local/k3wise/gate.json
.local/k3wise/metasheet-admin.jwt
.local/k3wise/sql.env
```

Recommended permissions on Linux/macOS:

```bash
mkdir -p .local/k3wise
chmod 700 .local .local/k3wise
chmod 600 .local/k3wise/*
```

On Windows, keep the files outside Git-tracked folders if possible, or ensure
they remain untracked and never appear in `git status` staged output.

## Local GATE File Template

Create a local GATE file on the bridge machine. Do not commit it.

```json
{
  "environment": "test",
  "k3Wise": {
    "version": "<fill-outside-git>",
    "webApiBaseUrl": "http://<k3-host>:<port>",
    "acctId": "<fill-outside-git>",
    "authMode": "login",
    "username": "<fill-outside-git>",
    "passwordFile": ".local/k3wise/k3-password.txt",
    "authorityCodeFile": "",
    "loginPath": "/K3API/Login",
    "tokenPath": "/K3API/Token/Create"
  },
  "material": {
    "object": "material",
    "savePath": "/K3API/Material/Save",
    "sampleLimit": {
      "min": 1,
      "max": 3
    },
    "fields": {
      "code": "FNumber",
      "name": "FName",
      "spec": "FModel",
      "uom": "FBaseUnitID"
    }
  },
  "bom": {
    "object": "bom",
    "savePath": "/K3API/BOM/Save",
    "fields": {
      "parentCode": "FParentItemNumber",
      "childCode": "FChildItemNumber",
      "quantity": "FQty",
      "uom": "FUnitID",
      "sequence": "FEntryID"
    }
  },
  "lifecycle": {
    "saveOnly": true,
    "autoSubmit": false,
    "autoAudit": false
  },
  "sqlServer": {
    "enabled": false,
    "readOnly": true,
    "useIntegrationDatabaseOnly": true
  }
}
```

If the customer uses `authorityCode` authentication, store it in a local file
and do not paste the value into chat or markdown.

## SQL Server executor handoff

Direct K3 WISE SQL Server source execution is an advanced bridge-machine task.
The normal package registers `erp:k3-wise-sqlserver`, but it does not inject a
production SQL Server executor. Until the bridge machine wires one, Data Factory
and postdeploy smoke may report `SQLSERVER_EXECUTOR_MISSING`.

This state is expected before SQL work is explicitly approved:

- Use `metasheet:staging` as the source for Data Factory retests.
- Do not mark the SQL source as runnable.
- Do not copy the mock SQL executor into production registration.
- Do not store SQL credentials in Git, chat, or `external_systems.config`.

When SQL source testing is approved, the bridge implementation must inject an
executor into `createK3WiseSqlServerChannelFactory({ queryExecutor })`. The
minimum contract is:

- `queryExecutor.testConnection({ system, input })`
  - verifies reachability and credentials;
  - returns no raw connection string or secret values.
- `queryExecutor.select({ table, columns, limit, cursor, filters, watermark, orderBy, options, system })`
  - reads only configured allowlist views/tables;
  - uses parameterized values and structured filters;
  - accepts no user-written raw SQL.
- `queryExecutor.insertMany({ table, records, keyFields, mode, options, system })`
  - writes only to approved middle tables or controlled procedures;
  - never writes directly to K3 core tables such as `t_ICItem`,
    `t_ICBOM`, or `t_ICBomChild`.

After wiring the executor, rerun the authenticated postdeploy smoke. A configured
SQL source should move from:

```text
sqlserver-executor-availability=skipped
code=SQLSERVER_EXECUTOR_MISSING
```

to:

```text
sqlserver-executor-availability=pass
```

For the method-level contract and operator acceptance checklist, see
`docs/operations/integration-k3wise-sql-executor-bridge-handoff.md`.

## Test Sequence

### 1. Confirm MetaSheet Deployment

Use whichever MetaSheet URL is being tested:

```bash
export METASHEET_BASE_URL="http://142.171.239.56:8081"
```

Basic probes:

```bash
curl -fsS "$METASHEET_BASE_URL/api/health"
curl -fsS "$METASHEET_BASE_URL/integrations/k3-wise" >/tmp/k3wise-page.html
curl -fsS "$METASHEET_BASE_URL/integrations/workbench" >/tmp/workbench-page.html
```

If local network cannot reach 142 but GitHub Actions smoke passes, record that
as a local network-path issue rather than a product failure.

### 2. Run Authenticated Postdeploy Smoke

Put a MetaSheet admin JWT in a local token file:

```bash
export METASHEET_AUTH_TOKEN_FILE=".local/k3wise/metasheet-admin.jwt"
export METASHEET_TENANT_ID="default"
```

Run:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --out-dir artifacts/integration-k3wise/bridge-postdeploy-smoke
```

Expected:

```text
ok=true
authenticated=true
signoff.internalTrial=pass
summary.pass=10
summary.fail=0
```

### 3. Run On-Prem Mock Preflight

This proves the bridge machine has the local environment needed to run the
operator tooling, without touching K3:

```bash
node scripts/ops/integration-k3wise-onprem-preflight.mjs \
  --mock \
  --out-dir artifacts/integration-k3wise/bridge-onprem-preflight-mock
```

Expected exit code: `0`.

### 4. Run Live K3 Reachability Preflight

Only run this after the local GATE file exists:

```bash
K3_API_URL="http://<k3-host>:<port>" \
K3_ACCT_ID="<acct-id>" \
K3_USERNAME="<username>" \
K3_PASSWORD="$(cat .local/k3wise/k3-password.txt)" \
node scripts/ops/integration-k3wise-onprem-preflight.mjs \
  --live \
  --gate-file .local/k3wise/gate.json \
  --out-dir artifacts/integration-k3wise/bridge-onprem-preflight-live
```

Expected:

- `PASS` if K3 host and required GATE fields are reachable and valid.
- `GATE_BLOCKED` if customer answers are incomplete.
- `FAIL` if local env, PostgreSQL, or URL reachability is broken.

### 5. Configure K3 WISE In The UI

Open:

```text
/integrations/k3-wise
```

Use:

- Tenant ID: `default`
- Workspace ID: leave blank unless testing a specific workspace
- Environment: `test` or `staging`; do not choose production for PoC
- WebAPI Base URL: prefer `http://<k3-host>:<port>`
- Advanced paths: keep relative paths such as `/K3API/Login`,
  `/K3API/Material/Save`, `/K3API/BOM/Save`
- Lifecycle: Save-only enabled, Submit/Audit disabled

Click:

1. Save configuration
2. Test WebAPI

Expected:

- WebAPI status changes from `untested` to connected/pass.
- If it stays `untested`, inspect browser Network tab for the failing endpoint.
- If the backend says `tenantId is required`, explicitly fill `default`, save,
  and retry.

### 6. Dry-Run In Generic Integration Workbench

Open:

```text
/integrations/workbench
```

First path:

1. Select a source system or staging table.
2. Select K3 WISE as target.
3. Select object: `material` or `bom`.
4. Review field mappings.
5. Preview JSON payload.
6. Run dry-run only.

Expected:

- Payload is wrapped as `{ "Data": ... }`.
- Material target fields include `FNumber`, `FName`, `FModel`,
  `FBaseUnitID`.
- BOM target fields include `FParentItemNumber`, `FChildItemNumber`, `FQty`,
  `FUnitID`, `FEntryID`.
- No Token, password, authorityCode, SQL connection string, or raw credential
  appears in preview, logs, or artifacts.

### 7. Save-Only Sample

Do this only after the user explicitly confirms.

Constraints:

- Use test account set only.
- 1 to 3 material rows maximum for first write.
- Save-only only.
- Submit/Audit disabled.
- Record K3 response IDs and bill numbers.
- Record rollback/contact owner before running.

After run, verify writeback:

- `erpSyncStatus`
- `erpExternalId`
- `erpBillNo`
- `erpResponseCode`
- `erpResponseMessage`
- open dead letters for failed rows

## Evidence To Write Back

After bridge testing, create a new verification file:

```text
docs/development/k3wise-bridge-live-verification-YYYYMMDD.md
```

Include:

- Bridge machine OS and network position, no hostname if sensitive
- MetaSheet URL tested
- K3 WebAPI URL shape only, with host redacted if needed
- postdeploy smoke result
- mock preflight result
- live preflight result
- UI WebAPI test result
- dry-run result
- Save-only result, if executed
- artifact paths
- secret leak self-check result
- remaining blockers

Do not include secrets.

## Secret Leak Self-Check

Before sharing artifacts, run checks like:

```bash
ART_DIR="artifacts/integration-k3wise"
rg -n "eyJ[A-Za-z0-9._-]{20,}|Bearer\\s+[A-Za-z0-9._-]+|access_token=|api_key=|session_id=|authorityCode|password" "$ART_DIR" || true
```

Expected: no raw secret values. Benign words in headings are acceptable only if
they do not include actual values.

## Current Known State From Development Machine

- This handoff branch was rebased onto current `origin/main` after:
  - `da1fca4de` / PR #1509: ERP feedback evidence is now required before K3
    live PoC evidence can return PASS.
  - `b72b1038b` / PR #1511: saved K3 setup `autoSubmit` / `autoAudit`
    booleans hydrate correctly from common string, numeric, and Chinese
    variants.
- Latest 142 deployment was performed through GitHub Actions, not local SSH.
- Latest successful deployed commit observed at the time of the bridge handoff:
  `cfa9d2a14`. Treat this as the last verified 142 deployment snapshot, not as
  the current repository HEAD.
- 142 deploy run `25784749891`: remote preflight, deploy, migrate, and smoke
  all passed.
- K3 WISE manual postdeploy smoke run `25785420343`: authenticated signoff
  passed with `10 pass / 0 fail`.
- Local development machine could not SSH directly into 142 and saw
  `Empty reply from server` from its own network path, while GitHub Actions
  postdeploy smoke passed. Treat this as a local network-path observation until
  reproduced from the bridge machine.

## Stop Rules

Stop and report before any real write if:

- Environment is production.
- Submit or Audit is enabled.
- More than 3 material rows are selected for first Save-only.
- K3 unit codes are not confirmed.
- K3 account set is not confirmed.
- WebAPI test is not connected/pass.
- Dry-run payload contains unexpected fields or secrets.
- SQL channel requires direct writes to core K3 tables.
