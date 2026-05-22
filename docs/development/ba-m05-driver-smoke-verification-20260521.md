# BA-M0.5 driver smoke gate - verification - 2026-05-21

Companion to `ba-m05-driver-smoke-design-20260521.md`. Scripts + docs only:
one PowerShell harness + one operator runbook + two dev MDs. No
`plugin-integration-core`, no DB migration, no API runtime, no frontend, no
K3 Save / Submit / Audit.

## Local evidence (isolated worktree)

### 1. Secret-shape sweep across all changed files

Patterns searched, expected count `0` on each file:

| Pattern | ba-m05-driver-smoke.ps1 | runbook.md | design MD |
| --- | --- | --- | --- |
| `eyJ[A-Za-z0-9_-]{6,}` (JWT shape) | 0 | 0 | 0 |
| `(Password\|Pwd)=<populated>` | 0 | 0 | 0 |
| `Bearer <token>` | 0 | 0 | 0 |
| `postgres://<userinfo>@` | 0 | 0 | 0 |
| IPv4 literal | 0 | 0 | 0 |

The harness and runbook only ever reference connection parameters as env
keys (`BA_M05_SQL_SERVER`, `BA_M05_SQL_PASSWORD`, ...) or placeholders
(`<host or host\instance or host,port>`, `<readonly-account>`,
`<password>`). No real value of any kind is committed.

### 2. Harness static checks

```text
open-brace / close-brace balance      -> 91 / 91 (balanced)
SELECT @@VERSION occurrences           -> 5 (1 executed query + 4 doc/help)
Protect-Text redaction helper          -> 3 (definition + 2 call sites)
"composed in-process and never logged" -> 1 (the connection-open log line)
git diff --check                       -> exit 0
```

`pwsh` is not installed on this dev host; the PowerShell parse will be
exercised on the Windows-side run. The harness targets Windows PowerShell
5.1 specifically (so `System.Data.SqlClient` / `Odbc` / `OleDb` resolve
from the .NET Framework GAC) - it is not meant to parse-check under
PowerShell 7 / `pwsh` on macOS.

### 3. Secret-safety design points verified by reading the harness

- `param()` exposes only `-Driver`, `-EnvFile`, `-OutDir` - no connection
  string / host / password argument.
- the connection string is built inside `New-SqlClientConnString` /
  `New-KeyValueConnString` and handed straight to the `*Connection`
  constructor; it is never assigned to a logged variable and never written
  to the evidence object.
- `Protect-Text` is applied to both the `@@VERSION` echo and the error
  summary; it masks the literal server / database / username / password,
  IPv4 addresses, UNC paths, and `key=value` connection-string fragments.
- on failure the evidence records `errorType` + `errorNumber` + a 240-char
  redacted `errorSummary`, never a full stack trace.
- the evidence JSON has a fixed key set; none of the keys is a host or
  credential field.
- the runbook adds a pre-delivery `Select-String` self-check for
  `Password|Pwd=|User Id|Uid=|Data Source|Server=` against the evidence
  files.

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| BA-M0.5 driver smoke runbook added | `docs/operations/ba-m05-driver-smoke-runbook.md` |
| Minimal harness, .NET-first (SqlClient/Odbc/OleDb), jTDS fallback | `scripts/ops/ba-m05-driver-smoke.ps1` with `-Driver` SqlClient/Odbc/OleDb; runbook has the jTDS fallback `BaM05JtdsSmoke.java` block |
| Smoke runs only `SELECT @@VERSION`, no business tables, no writes | harness `CommandText = 'SELECT @@VERSION'`, single `ExecuteScalar`; no other statement; design + runbook state this explicitly |
| Redacted JSON / MD evidence format | harness writes `ba-m05-driver-smoke-<driver>-<stamp>.{json,md}`; `Protect-Text` redaction; fixed-key JSON |
| design MD + verification MD | this PR adds both under `docs/development/` |
| #1710 comment: BA-M1 not started until BA-M0.5 green | posted on PR open; harness/runbook/design all also state the BA-M1 gate |
| No real connection string / password / host / token committed | secret-shape sweep above, 15/15 cells `0` |
| No K3 Save/Submit/Audit, no integration-core, docs/scripts only | file list below |

## Files

- `scripts/ops/ba-m05-driver-smoke.ps1` (new)
- `docs/operations/ba-m05-driver-smoke-runbook.md` (new)
- `docs/development/ba-m05-driver-smoke-design-20260521.md` (new)
- `docs/development/ba-m05-driver-smoke-verification-20260521.md` (this file, new)

No file under `plugins/`, `packages/`, `apps/`, or any migration directory
is touched.

## Deployment impact

None. A PowerShell harness that is run manually on a customer/operator
Windows host plus three Markdown files. No CI gate change, no build
behavior, no runtime, no DB. The harness writes evidence only to an
operator-chosen `-OutDir` kept outside Git.

## GATE-blocking status

Does not lift the customer GATE. BA-M0.5 is a gate *before* BA-M1; this PR
delivers the gate's tooling, not the Bridge Agent. BA-M1 implementation
does not start until a BA-M0.5 run returns `ok: true` for a
customer-approved driver and the evidence passes the redaction self-check.

## Operational note

Developed in an isolated `git worktree` per the parallel-session worktree
hazard memory; branch verified
(`codex/ba-m05-driver-smoke-20260521`) before commit and push.
