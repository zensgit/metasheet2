# Bridge Agent Readonly BA-M1 Development Notes

Date: 2026-05-21

## Purpose

This slice starts BA-M1 after the BA-M0 customer decisions and BA-M0.5 driver
smoke evidence were accepted by the maintainer.

The goal is deliberately small: provide a standalone, localhost-only readonly
Bridge Agent that can be run on the MetaSheet on-prem Windows server and proven
against the customer's legacy SQL Server before any `plugin-integration-core`
runtime integration begins.

## Decision

The first runtime is a PowerShell 5.1 script hosted on Windows .NET Framework
`System.Data.SqlClient`.

Reasons:

- the customer-side BA-M0.5 evidence selected the Windows-native provider path;
- Windows PowerShell 5.1 is already present on the target Windows bridge host;
- no Visual Studio, MSBuild, .NET SDK, or service installer is required for the
  first runtime contract;
- the script can be reviewed as plain ops code and later wrapped as a Windows
  service if BA-M1 succeeds.

## Files

- `scripts/ops/bridge-agent-readonly.ps1`
- `scripts/ops/fixtures/bridge-agent-readonly/config.example.json`
- `scripts/ops/bridge-agent-readonly-contract.test.mjs`
- `docs/operations/bridge-agent-readonly-runbook-20260521.md`
- `docs/development/bridge-agent-readonly-development-20260521.md`
- `docs/development/bridge-agent-readonly-verification-20260521.md`

## Runtime Contract

The Bridge Agent exposes:

- `GET /health`
- `GET /objects`
- `GET /schema/<object>`
- `POST /query/<object>`

The process binds only to `127.0.0.1` or `localhost`; non-localhost config is
rejected at config resolution time. The default auth mode is
`shared-secret-header` with the secret read from a local environment variable.

## Data Safety

The implementation does not accept raw SQL. `POST /query/<object>` builds
`SELECT TOP <limit> [allowlisted fields] FROM [allowlisted source]` from the
configuration only.

The default config registers three read models:

- `material` from `v_MetaSheet_MaterialRead`
- `bom` from `v_MetaSheet_BomRead`
- `bom_child` from `v_MetaSheet_BomChildRead`

Those names intentionally prefer customer-created readonly views. If the
customer cannot provide views, the maintainer must review any direct table
source changes before live use.

## Error Hygiene

Errors returned by `/health` and the generic exception handler are passed through
the shared redactor. The redactor covers connection-string fragments, bearer/JWT
shapes, SQL login-failure messages, nested `InnerException` chains, and
credential-looking `Exception.Data` keys.

No connection string is printed or returned.

## Out Of Scope

- Windows Service packaging.
- MetaSheet backend or `plugin-integration-core` integration.
- Data Factory UI wiring.
- SQL write operations.
- K3 Save / Submit / Audit.
- Relationship resolver and incremental cursor protocol.
- Non-localhost network exposure.

Those belong to BA-M2+ after this Bridge Agent can be proven on the bridge host.
