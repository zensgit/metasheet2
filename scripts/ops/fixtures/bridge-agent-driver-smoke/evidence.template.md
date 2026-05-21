# BA-M0.5 Driver Smoke Evidence (template)

This file is the human-readable companion to `ba-m0_5-driver-smoke.json`.
Both files are produced together by `scripts/ops/bridge-agent-driver-smoke.ps1`.
This template documents the shape; the harness emits an equivalent file
populated with redacted values.

> NOTE - this template is a fixture for review and operator orientation.
> It is intentionally empty of any host, database, user, or password
> value. The harness output likewise carries no such values.

- spec: `ba-m0.5-driver-smoke v1.0`
- timestamp (UTC): `<UTC ISO-8601>`
- decision: **`<PASS | FAIL>`**
- next step: `<one-line maintainer-facing summary>`

## Runner

- OS: `<windows version string>`
- PowerShell: `<x.y.z>`
- CLR: `<x.y.z>`

## Target (no host / DB / user values recorded)

- provider: `<SqlClient | Odbc | OleDb>`
- server present: `<true | false>`
- database present: `<true | false>`
- integrated security: `<true | false>`

## Driver

- typeName: `<System.Data.*.Connection class>`
- assembly version: `<x.y.z.b>`

## Checks

- open-connection: **`<PASS | FAIL>`** (`<n>` ms)
- select-version: **`<PASS | FAIL>`** (`<n>` ms)

On FAIL, each entry above carries `error.class` + `error.message`. The
harness redacts credential-shaped substrings from those messages before
writing.

## SQL Server `@@VERSION` echo (redacted defensively)

```text
<server-emitted @@VERSION banner; defensively redacted; absent on FAIL>
```

## Hand-off note

This file contains no connection string, host, database name, username,
or password. Hand to a maintainer through the secure channel agreed
with the customer.
