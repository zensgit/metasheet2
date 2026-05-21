# Bridge Agent Driver Smoke (BA-M0.5) - design - 2026-05-20

Companion to the operator runbook
`docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` and to the
Bridge Agent plan
`docs/development/data-factory-legacy-sql-readonly-bridge-agent-plan-20260520.md`
(BA-M0.5 section).

## Scope

Deliver the **BA-M0.5 driver smoke gate** as a small operator-runnable
harness + runbook + evidence templates. Nothing more.

In scope:

- `scripts/ops/bridge-agent-driver-smoke.ps1` — PowerShell harness
  invoking exactly one read-only query (`SELECT @@VERSION`) through a
  customer-chosen provider (`SqlClient` / `Odbc` / `OleDb`).
- `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` —
  operator-facing runbook.
- `scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.{json,md}` —
  shape-only evidence templates with no host/user/password values.
- this design MD + companion verification MD.

Out of scope (deliberate):

- `plugins/plugin-integration-core` runtime — not touched.
- DB migration / API runtime / frontend runtime — not touched.
- K3 Save / Submit / Audit — out of scope.
- Bridge Agent MVP (BA-M1) — explicitly gated by this smoke, not
  implemented here.
- Sampling of business tables (`t_ICItem`, `t_ICBOM`, `t_ICBomChild`) —
  not in BA-M0.5, only in BA-M1 onwards.
- jTDS smoke harness — not shipped as code; the runbook documents a
  five-line Java fallback for environments where Java + jTDS is the
  only accepted runtime.

## Why this gate exists

The Bridge Agent plan's `## Why This Is Needed` section identifies
pre-login / TLS / protocol negotiation against SQL Server 2014 RTM
(`12.0.2000.8`) as the failure mode that direct MetaSheet Node `mssql`
hit on the entity machine. The plan then proposes three viable runtime
paths (Java + jTDS + Spring Boot, Apache Camel + fixed routes, .NET
Framework Windows service) but **does not yet know which of those
actually negotiates with the customer's specific SQL Server endpoint**.

Without BA-M0.5, BA-M1 implementation risks:

- writing several hundred lines of Bridge Agent code on top of a
  driver that fails to pre-login,
- only surfacing the failure at V3 (customer bridge-machine smoke),
  i.e. after the MVP is already shipped,
- forcing rework instead of a 1-hour spike.

BA-M0.5 is the cheapest evidence that the chosen driver works at all,
before any meaningful code is written.

## Design

### Single executable, three provider modes

The harness is one PowerShell script with a `-Provider` parameter
(`SqlClient` | `Odbc` | `OleDb`). The branches share connection-string
builders, error redaction, and evidence writers. The customer's choice
in BA-M0 selects which mode the operator runs. Multiple modes can be
run sequentially if the customer wants to compare drivers; each
produces its own evidence pair.

A Java + jTDS fallback is documented in the runbook (a five-line
`Main.java` skeleton + JDBC URL env-var pattern) but is **not** shipped
as a separate script. The repo standard for Windows on-prem operator
scripts is PowerShell; adding a JVM-only script would broaden the
build/verify surface for a fallback case.

### Exactly one query

The harness runs exactly two database operations:

1. `connection.Open()`
2. `command.ExecuteScalar("SELECT @@VERSION")`

Nothing else. No business table is read; no row data is emitted; no
write/DDL/Submit/Audit is issued. This is the minimum that proves the
driver can negotiate pre-login, authenticate, and execute a read.

### Credentials never written to disk by this harness

- Plaintext password as a CLI parameter is **not supported**.
- The harness accepts: `-IntegratedSecurity` (Windows auth, no
  password), `-PasswordEnvVar <NAME>` (env var read once at startup),
  or interactive `Read-Host -AsSecureString`.
- The connection string is built in memory and passed straight into
  the connection constructor; it is never `Write-Output`ed or
  serialized into the evidence files.
- Errors are passed through a regex-based redactor that masks any
  `Password=`, `User ID=`, `Server=`, `Data Source=`, `Initial Catalog=`,
  `Bearer ...`, and JWT-shape substring before being written to the
  evidence files.
- The evidence files capture only structural facts: provider name,
  driver assembly version, OS / PS / CLR version, elapsed milliseconds,
  PASS / FAIL per check, and a defensively-redacted `@@VERSION` echo.

### Evidence is a signed-off artefact, not just stdout

The harness writes two files to `-OutDir`:

- `ba-m0_5-driver-smoke.json` — machine-readable.
- `ba-m0_5-driver-smoke.md` — human-readable, mirrors the JSON.

Both have a top-level `decision` of `PASS` or `FAIL` and a `nextStep`
sentence. The operator inspects both, then hands them to a maintainer
via the agreed secure channel. The maintainer posts a follow-up on
#1710 referencing the chosen provider + decision (the evidence file
bodies are NOT pasted into the public issue).

## Security model summary

Inherited verbatim from the Bridge Agent plan's `## Security Model`:

- read-only only,
- no raw SQL from CLI / config / request body (the harness's SQL is
  the hard-coded literal `SELECT @@VERSION`),
- credentials never leave the bridge machine in any artefact this
  harness writes,
- evidence redaction is layered: in-process credential acquisition,
  in-memory-only connection string, regex redaction of error
  messages, harness output that captures only structural facts.

## What this PR proves

- A working harness that compiles and runs on Windows PowerShell 5.1+
  and PowerShell 7+.
- An operator runbook that mirrors the BA-M0.5 section in the plan
  MD verbatim in terms of acceptance criteria + stop rules.
- Shape-only evidence templates for review / orientation.

## What this PR does not prove

- That the harness connects to *the customer's* SQL Server 2014 RTM
  endpoint. That is the operator's job at run-time; this PR cannot
  exercise a customer endpoint in CI.
- That any specific driver is the right choice. That is BA-M0's
  output; this gate consumes BA-M0's decision.

## Files touched

- `scripts/ops/bridge-agent-driver-smoke.ps1` (new)
- `scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.json` (new)
- `scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.md` (new)
- `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` (new)
- `docs/development/bridge-agent-driver-smoke-design-20260520.md` (this file)
- `docs/development/bridge-agent-driver-smoke-verification-20260520.md`
  (companion verification MD)

No existing file in `plugins/` / `apps/web/` / `packages/core-backend/` /
`scripts/ops/multitable-onprem-*` is modified.
