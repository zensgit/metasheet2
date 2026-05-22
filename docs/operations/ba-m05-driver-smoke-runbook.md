# BA-M0.5 Driver Smoke Runbook

## Purpose

BA-M0.5 is the gate step in the legacy SQL readonly Bridge Agent plan
(`docs/development/data-factory-legacy-sql-readonly-bridge-agent-plan-20260520.md`).

Before any Bridge Agent MVP (BA-M1) implementation starts, the
customer-approved SQL client driver must be proven to connect to the legacy
SQL Server endpoint and run one read-only query. This runbook explains how to
run that proof on a Windows host.

This is **only** the driver smoke gate. It is not the Bridge Agent. It does
not expose HTTP, does not touch `plugin-integration-core`, the MetaSheet
runtime, the API, or the database schema.

## What the smoke does and does not do

Does:

- open a single SQL connection with the chosen driver;
- run exactly one query: `SELECT @@VERSION`;
- write a redacted JSON + MD evidence pair.

Does not:

- read any business table (`t_ICItem`, `t_ICBOM`, `t_ICBomChild`, or any
  other);
- run any write / DDL / stored procedure;
- accept a connection string, host, or password as a command-line argument;
- log or store the connection string, host, database, username, or password.

## Prerequisites

- A Windows host that can reach the legacy SQL Server endpoint. This is the
  machine that would later host the Bridge Agent (the MetaSheet on-prem
  server in same-machine mode, or the separate customer bridge machine).
- Windows PowerShell 5.1 (built into Windows Server). Use Windows PowerShell,
  not PowerShell 7, so the `System.Data.SqlClient` / `System.Data.Odbc` /
  `System.Data.OleDb` providers resolve from the .NET Framework GAC.
- For the Odbc path: the customer-approved ODBC driver installed (for
  example `ODBC Driver 17 for SQL Server`, or `SQL Server Native Client
  11.0`).
- For the OleDb path: the customer-approved OLE DB provider installed (for
  example `MSOLEDBSQL`, or `SQLOLEDB`).

## Step 1 - create the env file (0600, outside Git)

Create `ba-m05-driver-smoke.env` somewhere **outside any Git repository**,
readable only by the operator account. Never commit this file.

```ini
# ba-m05-driver-smoke.env  -- keep outside Git, restrict file permissions
BA_M05_SQL_SERVER=<host or host\instance or host,port>
BA_M05_SQL_DATABASE=master
BA_M05_SQL_AUTH=windows
# For SQL auth instead of Windows auth, set BA_M05_SQL_AUTH=sql and:
# BA_M05_SQL_USERNAME=<readonly-account>
# BA_M05_SQL_PASSWORD=<password>
# Optional TLS knobs:
# BA_M05_SQL_ENCRYPT=false
# BA_M05_SQL_TRUST_CERT=true
# For the Odbc path:
# BA_M05_ODBC_DRIVER={ODBC Driver 17 for SQL Server}
# For the OleDb path:
# BA_M05_OLEDB_PROVIDER=MSOLEDBSQL
# Optional extra connection-string fragment for the Odbc / OleDb paths:
# BA_M05_SQL_EXTRA=
```

Restrict the file so only the operator account can read it:

```powershell
icacls .\ba-m05-driver-smoke.env /inheritance:r /grant:r "$env:USERNAME:R"
```

## Step 2 - run the smoke for the customer-approved driver

Run only the driver the customer's IT has confirmed for this PLM source.

```powershell
# .NET Framework System.Data.SqlClient
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\ba-m05-driver-smoke.ps1 `
  -Driver SqlClient -EnvFile C:\path\outside-git\ba-m05-driver-smoke.env -OutDir C:\path\outside-git\ba-m05-evidence

# ODBC (System.Data.Odbc) - requires BA_M05_ODBC_DRIVER in the env file
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\ba-m05-driver-smoke.ps1 `
  -Driver Odbc -EnvFile C:\path\outside-git\ba-m05-driver-smoke.env -OutDir C:\path\outside-git\ba-m05-evidence

# OLE DB (System.Data.OleDb) - requires BA_M05_OLEDB_PROVIDER in the env file
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\ba-m05-driver-smoke.ps1 `
  -Driver OleDb -EnvFile C:\path\outside-git\ba-m05-driver-smoke.env -OutDir C:\path\outside-git\ba-m05-evidence
```

The harness exits `0` on a successful `SELECT @@VERSION`, non-zero on any
connection or query failure.

## Driver preference order

1. **.NET Framework `System.Data.SqlClient` / ODBC / OLE DB** - preferred
   when the customer is a Windows-native SQL Server 2014-era site. Their IT
   usually already has a driver stack that connected to this database, so
   this is the lowest-friction path and needs no extra runtime.
2. **jTDS (Java)** - fallback only when no .NET / ODBC / OLE DB path
   negotiates with the legacy server and the customer accepts a JVM. jTDS is
   an old but battle-tested legacy SQL Server JDBC driver. See the jTDS
   fallback section below.

## jTDS fallback smoke (only if the .NET paths all fail)

If `SqlClient`, `Odbc`, and `OleDb` all fail pre-login / TLS negotiation and
the customer accepts a JVM on the bridge machine, run an equivalent jTDS
smoke. Save the following as `BaM05JtdsSmoke.java` outside Git, compile with
the jTDS jar on the classpath, and run it. It reads the same env-style file,
runs only `SELECT @@VERSION`, and prints a redacted one-line result.

```java
import java.sql.*;
import java.util.*;
import java.nio.file.*;

public class BaM05JtdsSmoke {
  public static void main(String[] args) throws Exception {
    Map<String,String> cfg = new HashMap<>();
    for (String line : Files.readAllLines(Paths.get(args[0]))) {
      line = line.trim();
      if (line.isEmpty() || line.startsWith("#")) continue;
      int i = line.indexOf('=');
      if (i > 0) cfg.put(line.substring(0, i).trim(), line.substring(i + 1).trim());
    }
    // jTDS URL is composed in-process and never printed.
    String url = "jdbc:jtds:sqlserver://" + cfg.get("BA_M05_SQL_SERVER")
      + "/" + cfg.getOrDefault("BA_M05_SQL_DATABASE", "master");
    Class.forName("net.sourceforge.jtds.jdbc.Driver");
    try (Connection c = DriverManager.getConnection(url,
           cfg.get("BA_M05_SQL_USERNAME"), cfg.get("BA_M05_SQL_PASSWORD"));
         Statement s = c.createStatement();
         ResultSet rs = s.executeQuery("SELECT @@VERSION")) {
      rs.next();
      String v = rs.getString(1).replaceAll("\\b\\d{1,3}(\\.\\d{1,3}){3}\\b", "<redacted-ip>");
      System.out.println("{\"tool\":\"ba-m05-driver-smoke\",\"driver\":\"jTDS\",\"ok\":true,"
        + "\"sqlServerVersion\":\"" + v.replace("\"", "'") + "\"}");
    } catch (Exception e) {
      System.out.println("{\"tool\":\"ba-m05-driver-smoke\",\"driver\":\"jTDS\",\"ok\":false,"
        + "\"errorType\":\"" + e.getClass().getName() + "\"}");
      System.exit(1);
    }
  }
}
```

```bat
javac -cp jtds-1.3.1.jar BaM05JtdsSmoke.java
java -cp .;jtds-1.3.1.jar BaM05JtdsSmoke C:\path\outside-git\ba-m05-driver-smoke.env > ba-m05-jtds-evidence.json
```

Capture the printed JSON line as the jTDS evidence; it follows the same
redaction rule (no host, no credentials, no connection string).

## Step 3 - interpret the result

| Observed | Disposition |
| --- | --- |
| harness exits `0`, evidence `ok: true`, `sqlServerVersion` shows the expected SQL Server build | **BA-M0.5 PASS** - the chosen driver can connect; BA-M1 may be scoped |
| harness exits non-zero, evidence `ok: false`, `errorType` is a pre-login / TLS / SSL / socket class | **BA-M0.5 FAIL** - this driver cannot negotiate with the legacy server; try the next customer-approved driver, or escalate the SQL Server patch / TLS path per the Bridge Agent plan |
| harness exits non-zero with a login / permission error after the connection opened | connection works; the smoke account lacks rights - confirm a read-only account, then re-run |

## Step 4 - deliver the evidence

- The evidence JSON + MD are written to the `-OutDir` directory. Keep that
  directory **outside Git**.
- The evidence is already redacted (no host, no database, no username, no
  password, no connection string; IP addresses and UNC paths masked).
- Deliver the evidence pair through the agreed secure channel for maintainer
  sign-off. Do not paste it into a public issue or PR if you are not certain
  the redaction held - re-check with the self-check below.

Pre-delivery self-check (run against the evidence files):

```powershell
Select-String -Path .\ba-m05-evidence\*.json,.\ba-m05-evidence\*.md `
  -Pattern 'Password|Pwd=|User Id|Uid=|Data Source|Server=' -SimpleMatch
```

Expect no matches. If anything matches, do not deliver; report the leak.

## Stop conditions

Stop and escalate (do not proceed to BA-M1) if:

- no customer-approved driver can negotiate with the legacy SQL Server;
- only a writable SQL account is available;
- the evidence files contain any credential, host, or connection string
  after redaction;
- the customer asks to bypass this gate and start BA-M1 directly.

## Out of scope

- The Bridge Agent itself (BA-M1 and later).
- Any read of business tables or relationship data.
- `plugin-integration-core`, MetaSheet runtime, API, DB migration.
- K3 Save / Submit / Audit.
- SQL Server patch / TLS remediation - tracked separately in the Bridge
  Agent plan and #1710.

BA-M1 implementation does not start until a BA-M0.5 run returns
`ok: true` for a customer-approved driver and the evidence passes the
redaction self-check.
