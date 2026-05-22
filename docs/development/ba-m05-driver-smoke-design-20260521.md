# BA-M0.5 driver smoke gate - design - 2026-05-21

## Goal

Deliver the BA-M0.5 step from the legacy SQL readonly Bridge Agent plan
(`docs/development/data-factory-legacy-sql-readonly-bridge-agent-plan-20260520.md`,
on `main` since 081db299a / PR #1720) as a concrete, runnable artifact:

- a minimal driver smoke harness, and
- an operator runbook,

so the customer can prove a SQL client driver connects to their legacy SQL
Server endpoint **before** any Bridge Agent MVP (BA-M1) implementation
starts.

This PR delivers the **harness + runbook + docs only**. It does not run the
smoke (that happens on the customer's machine), and it does not implement
the Bridge Agent.

## Scope

In scope:

- `scripts/ops/ba-m05-driver-smoke.ps1` - the harness.
- `docs/operations/ba-m05-driver-smoke-runbook.md` - the operator runbook.
- this design MD + a verification MD.

Out of scope (hard):

- the Bridge Agent itself (BA-M1+);
- `plugins/plugin-integration-core`, MetaSheet runtime, API, DB migration,
  frontend;
- K3 Save / Submit / Audit;
- reading any business table;
- SQL Server patch / TLS remediation.

## Harness shape

`ba-m05-driver-smoke.ps1`, Windows PowerShell 5.1, three driver paths
selectable via `-Driver`:

- `SqlClient` - `System.Data.SqlClient` (.NET Framework GAC);
- `Odbc` - `System.Data.Odbc`, customer ODBC driver named in the env file;
- `OleDb` - `System.Data.OleDb`, customer OLE DB provider named in the env
  file.

jTDS (Java) is documented as a fallback in the runbook, with a ~30-line
`BaM05JtdsSmoke.java` the operator saves and compiles outside Git. It is
not shipped as a repo file because it needs the jTDS jar on the classpath
and a JVM, neither of which the repo provides; the runbook code block keeps
it copy-pasteable without adding an unbuildable file to the tree.

### Why .NET-first, jTDS-fallback

Legacy SQL Server 2014-era customers are typically Windows-native sites
whose IT already has a driver stack that connected to that database. The
.NET Framework `System.Data.*` providers are present on every Windows
Server with no extra runtime. jTDS needs a JVM and an old (2013) jar;
useful as a fallback when no .NET path negotiates, but not the default.
This mirrors the runtime preference order already written into the Bridge
Agent plan.

### What the harness runs

Exactly one statement: `SELECT @@VERSION`. No `USE`, no business table,
no DDL, no stored procedure, no write. `@@VERSION` needs no user database,
so the env file may leave `BA_M05_SQL_DATABASE` unset and the harness
defaults to `master`.

## Secret-safety design

The harness is built so a connection string / host / credential cannot
reach Git, logs, or evidence:

1. **No secret CLI arguments.** `-Driver`, `-EnvFile`, `-OutDir` only. The
   connection parameters come from a 0600 env file outside the repo. A
   connection string passed on a command line would otherwise land in the
   process list and shell history.
2. **Connection string composed in-process.** `New-SqlClientConnString` /
   `New-KeyValueConnString` build the string, hand it straight to the
   `*Connection` constructor, and never assign it to a logged variable or
   write it to evidence.
3. **Redaction pass on every text that reaches evidence.** `Protect-Text`
   replaces the literal server / database / username / password values,
   masks IPv4 addresses, masks UNC paths, and masks
   `key=value` connection-string-shaped fragments. It is applied to both
   the `@@VERSION` echo and the error message.
4. **Error text is capped and classified, not dumped.** On failure the
   evidence records `errorType` (exception class), `errorNumber`, and a
   240-char redacted `errorSummary` - never a full stack trace, never the
   connection string.
5. **Evidence files carry no host/credential by construction.** The JSON
   has fixed keys (`driver`, `ok`, `connected`, `driverAssembly`,
   `sqlServerVersion`, `errorType`, `errorNumber`, `errorSummary`,
   `query`, `timestamp`). None is a host or credential field.
6. **Runbook adds a pre-delivery self-check** - a `Select-String` for
   `Password|Pwd=|User Id|Uid=|Data Source|Server=` against the evidence
   files; expect zero matches before delivering.

## Evidence format

JSON (machine) + MD (human), written to `-OutDir` (kept outside Git):

```json
{
  "tool": "ba-m05-driver-smoke",
  "step": "BA-M0.5",
  "driver": "SqlClient",
  "ok": true,
  "connected": true,
  "driverAssembly": "System.Data, Version=...",
  "sqlServerVersion": "Microsoft SQL Server 2014 ... (redacted)",
  "errorType": "",
  "errorNumber": "",
  "errorSummary": "",
  "query": "SELECT @@VERSION",
  "timestamp": "2026-05-21T00:00:00Z"
}
```

`ok: true` + a `sqlServerVersion` matching the expected build is the BA-M0.5
PASS signal. `ok: false` with a pre-login / TLS / SSL / socket `errorType`
is the FAIL signal that keeps BA-M1 gated.

## Why this gates BA-M1

The Bridge Agent plan's risk is: write the full agent, ship it, discover at
the customer bridge-machine smoke that no driver actually connects. BA-M0.5
collapses that risk into a ~1 hour, ~200-line harness run. The runbook and
this design both state, and the plan MD already states, that **BA-M1
implementation does not start until a BA-M0.5 run returns `ok: true` for a
customer-approved driver**.

## Files

- `scripts/ops/ba-m05-driver-smoke.ps1` (new)
- `docs/operations/ba-m05-driver-smoke-runbook.md` (new)
- `docs/development/ba-m05-driver-smoke-design-20260521.md` (this file)
- `docs/development/ba-m05-driver-smoke-verification-20260521.md` (companion)
