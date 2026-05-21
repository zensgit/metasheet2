# Bridge Agent Driver Smoke Runbook (BA-M0.5) - 2026-05-20

This runbook is the operator-side companion to BA-M0.5 in
`docs/development/data-factory-legacy-sql-readonly-bridge-agent-plan-20260520.md`.

## What this gate is

A ≤1-hour smoke that proves the customer-approved SQL Server driver on the
chosen bridge machine can:

1. open a connection to the legacy SQL Server endpoint, and
2. execute exactly one read-only query (`SELECT @@VERSION`).

Until this smoke returns `decision=PASS`, **BA-M1 (Bridge Agent MVP
implementation) does not start**.

## What this gate is NOT

- Not a Bridge Agent. The MVP is a separate, later step (BA-M1).
- Not a sampling step. No business tables are read (no `t_ICItem`,
  `t_ICBOM`, `t_ICBomChild`).
- Not a writeback step. No `INSERT`, `UPDATE`, `DELETE`, DDL, or stored
  procedure is invoked.
- Not a K3 Save / Submit / Audit step. Those are out of scope.

## Prerequisites

- BA-M0 customer / maintainer confirmations are complete (Bridge Agent
  host chosen, runtime/driver chosen, allowlist confirmed, packaging
  decision made).
- The chosen bridge machine has the chosen driver installed and reachable
  to the legacy SQL Server endpoint.
- A read-only SQL account exists (or Windows Integrated Security is
  approved for the smoke).
- The operator has a private workspace on the bridge machine where the
  redacted evidence pair will be written (default in examples below:
  `C:\metasheet\bridge-evidence\`). This directory must NOT be inside any
  Git working tree or any directory that auto-syncs to a shared store.

## Secret hygiene (read first)

- **Do not commit** any real connection string, host, database name,
  username, password, or token to Git, issue comments, PR bodies, or the
  evidence files produced by this harness.
- The harness intentionally does not accept a plaintext password on the
  command line. Choose one of:
  - **`-IntegratedSecurity`** (Windows auth, no password input), or
  - **`-PasswordEnvVar BRIDGE_SMOKE_DB_PASSWORD`** (set the env var in
    the same shell session, run the harness, then unset the env var), or
  - **interactive prompt** (default; the harness calls
    `Read-Host -AsSecureString` so the password is never echoed).
- After the smoke completes, **clear the env var** and / or **close the
  shell**:
  ```powershell
  Remove-Item Env:\BRIDGE_SMOKE_DB_PASSWORD -ErrorAction SilentlyContinue
  ```
- The harness's evidence files contain **no** server / database / user /
  password values. Inspect both files before handing them off; they
  should not require further redaction.

## Primary path: PowerShell harness on Windows (preferred)

The PowerShell harness `scripts/ops/bridge-agent-driver-smoke.ps1` runs in
three provider modes, mirroring the BA-M0 runtime options.

### Mode A: `System.Data.SqlClient` (default, Microsoft .NET Framework)

Best when the customer's environment already runs .NET Framework apps
talking to this SQL Server.

```powershell
.\scripts\ops\bridge-agent-driver-smoke.ps1 `
  -Server '<host>' `
  -Database '<db>' `
  -Username '<readonly_user>' `
  -PasswordEnvVar BRIDGE_SMOKE_DB_PASSWORD `
  -OutDir 'C:\metasheet\bridge-evidence' `
  -Provider SqlClient
```

### Mode B: ODBC

Best when customer IT has standardized on the ODBC stack. The driver
name the harness uses comes from `-OdbcDriverName`. The default targets
the modern ODBC Driver 17, but BA-M0 may have selected a different
**customer-approved driver** — the whole point of BA-M0.5 is to exercise
*that* driver, not our preset. Override with the exact name as it
appears under `HKLM\SOFTWARE\ODBC\ODBCINST.INI` on the bridge machine.

Modern (default):

```powershell
.\scripts\ops\bridge-agent-driver-smoke.ps1 `
  -Server '<host>' `
  -Database '<db>' `
  -Username '<readonly_user>' `
  -PasswordEnvVar BRIDGE_SMOKE_DB_PASSWORD `
  -OutDir 'C:\metasheet\bridge-evidence' `
  -Provider Odbc `
  -OdbcDriverName 'ODBC Driver 17 for SQL Server'
```

Legacy (only if BA-M0 approved the older Native Client or the ancient
Windows ODBC driver):

```powershell
# SQL Server Native Client 11.0 (common on 2014-era Windows servers):
.\scripts\ops\bridge-agent-driver-smoke.ps1 ... `
  -Provider Odbc `
  -OdbcDriverName 'SQL Server Native Client 11.0'

# Other approved alternates:
#   -OdbcDriverName 'ODBC Driver 18 for SQL Server'
#   -OdbcDriverName 'SQL Server'   (the original ancient one)
```

### Mode C: OLE DB

Best when the customer IT inventory still proves OLE DB providers.
`-OleDbProviderName` selects which provider the harness asks for. The
default targets the modern `MSOLEDBSQL`; legacy customers may require
`SQLNCLI11` or `SQLOLEDB`.

Modern (default):

```powershell
.\scripts\ops\bridge-agent-driver-smoke.ps1 `
  -Server '<host>' `
  -Database '<db>' `
  -IntegratedSecurity `
  -OutDir 'C:\metasheet\bridge-evidence' `
  -Provider OleDb `
  -OleDbProviderName 'MSOLEDBSQL'
```

Legacy (only if approved by BA-M0):

```powershell
# SQL Server Native Client 11.0 OLE DB provider:
.\scripts\ops\bridge-agent-driver-smoke.ps1 ... `
  -Provider OleDb `
  -OleDbProviderName 'SQLNCLI11'

# Legacy SQL OLE DB provider (deprecated by Microsoft, still installed on
# many older Windows servers; only use if BA-M0 explicitly approved it):
.\scripts\ops\bridge-agent-driver-smoke.ps1 ... `
  -Provider OleDb `
  -OleDbProviderName 'SQLOLEDB'
```

### Fallback: jTDS (Java) if no .NET path is acceptable

Only if Java + jTDS is the customer-approved runtime (see BA-M0). The
runbook does not ship a Java harness — keep it to a five-line manual
verification:

```bash
# On the bridge machine, with jTDS 1.3.1 on classpath:
java -cp "jtds-1.3.1.jar" Main
# where Main.java is:
#
#   import java.sql.*;
#   public class Main {
#     public static void main(String[] a) throws Exception {
#       String url = System.getenv("BRIDGE_SMOKE_JDBC_URL"); // jdbc:jtds:sqlserver://<host>:<port>;DatabaseName=<db>
#       String u   = System.getenv("BRIDGE_SMOKE_DB_USER");
#       String p   = System.getenv("BRIDGE_SMOKE_DB_PASSWORD");
#       try (Connection c = DriverManager.getConnection(url, u, p);
#            Statement s = c.createStatement();
#            ResultSet r = s.executeQuery("SELECT @@VERSION")) {
#         if (r.next()) System.out.println("SQL_VERSION_LEN=" + r.getString(1).length());
#       }
#     }
#   }
```

Record only the driver / `@@VERSION` length (or, defensively, the
redacted echo); the JSON evidence template below can be filled by hand
for the jTDS path.

## Decision logic

The harness writes a JSON + Markdown evidence pair to `OutDir`:

- `ba-m0_5-driver-smoke.json` — machine-readable, no secret values.
- `ba-m0_5-driver-smoke.md` — human-readable summary, mirrors JSON.

Both contain a top-level `decision` field:

- **`PASS`** = `open-connection` ✅ AND `select-version` ✅. BA-M1 may
  proceed once a maintainer signs off the evidence.
- **`FAIL`** = either check failed. BA-M1 remains blocked. The
  `error.class` + `error.message` in the failing check guide the next
  diagnostic step (TLS/Schannel, driver build, account permission,
  network reachability).

## Acceptance ritual

1. Operator runs the harness once per provider candidate the customer
   listed in BA-M0.
2. Operator inspects both evidence files locally; confirms no host /
   database / user / password value appears.
3. Operator transmits the redacted evidence pair through the agreed
   secure channel to a maintainer.
4. Maintainer reviews and posts a follow-up comment on issue #1710
   recording the chosen provider + decision (no evidence file contents
   are pasted into the issue itself).
5. On PASS, the maintainer unblocks BA-M1. On FAIL, the chain returns to
   BA-M0 driver/runtime re-selection.

## Stop rules

Stop the smoke and re-decide if:

- the harness ever prints something that looks like a connection
  string, password, or token (this should not happen; if it does, treat
  it as a defect and report);
- the customer-supplied account turns out to have write/DDL privileges
  (escalate to BA-M0 to obtain a true read-only account);
- the customer asks for raw SQL editor access in lieu of this gate
  (refuse; raw SQL surface is explicitly out of scope per the Bridge
  Agent plan).

## Out of scope (deliberate)

- `plugins/plugin-integration-core` runtime — not touched.
- DB migration / API runtime / frontend runtime — not touched.
- K3 Save / Submit / Audit — out of scope.
- Bridge Agent MVP implementation (BA-M1) — gated by this smoke.

The customer GATE state is unchanged; BA-M0.5 is the next pre-flight
gate inside an already-running PoC track, not a GATE lift.
