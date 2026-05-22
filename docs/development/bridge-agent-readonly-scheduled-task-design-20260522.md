# Bridge Agent Readonly Scheduled Task Design

Date: 2026-05-22

## Purpose

BA-M2 proved that MetaSheet Data Factory can read `material`, `bom`, and
`bom_child` through the localhost readonly Bridge Agent. The entity-machine
smoke also exposed an operational gap: a Bridge Agent process launched as an
SSH child process can disappear when the SSH session ends, leaving Data Factory
with `fetch failed`.

This slice makes the durable startup path explicit and package-verified by
adding a Windows Scheduled Task helper for the existing readonly Bridge Agent.

## Scope

In scope:

- install/start/stop/status/uninstall helper for Windows Task Scheduler;
- run the existing `scripts/ops/bridge-agent-readonly.ps1` as `SYSTEM`;
- at-startup trigger;
- stable task name `MetaSheetReadonlyBridgeAgent`;
- secret-free `Status` output with Task Scheduler state, `LastTaskResult`, and
  a local TCP listener probe;
- runbook instructions for machine-level environment variables;
- package-build and package-verify gates so the helper ships in the on-prem
  zip/tgz.

Out of scope:

- changing Bridge Agent SQL query behavior;
- adding writes, filters, watermarks, relationship expansion, or raw SQL;
- changing `plugin-integration-core`;
- changing Data Factory UI;
- K3 Save / Submit / Audit;
- Windows Service packaging.

## Design

The helper is `scripts/ops/bridge-agent-readonly-scheduled-task.ps1`.

It registers a task with:

- action: Windows PowerShell 5.1;
- arguments: `-NoProfile -ExecutionPolicy Bypass -File <root>\scripts\ops\bridge-agent-readonly.ps1 -ConfigPath <config>`;
- trigger: `AtStartup`;
- principal: `SYSTEM`, service account logon, highest run level;
- restart policy: up to three restarts at one-minute intervals.

The helper keeps all Bridge Agent protocol and SQL safety rules in the existing
agent script. This is intentionally an operational wrapper, not a second agent.

## Secret Handling

The Scheduled Task runs as `SYSTEM`, so user-scoped environment variables from
SSH/RDP are not visible. The runbook now directs operators to use machine-level
environment variables or an approved host secret mechanism for:

- `METASHEET_BRIDGE_SQL_USERNAME`
- `METASHEET_BRIDGE_SQL_PASSWORD`
- `METASHEET_BRIDGE_SHARED_SECRET`

The helper does not print those values and does not call authenticated Bridge
Agent endpoints. The `Status` action uses `Get-ScheduledTaskInfo` and a
`System.Net.Sockets.TcpClient` probe against `127.0.0.1:<port>` only.

## Package Contract

`multitable-onprem-package-build.sh` now includes the helper in
`REQUIRED_PATHS` and mentions it in `INSTALL.txt`.

`multitable-onprem-package-verify.sh` now fails if the package lacks:

- `scripts/ops/bridge-agent-readonly-scheduled-task.ps1`;
- install/start/stop/status/uninstall action markers;
- `Register-ScheduledTask`;
- `SYSTEM` principal;
- `Get-ScheduledTaskInfo`;
- secret-free local TCP listener check;
- runbook documentation for persistent Scheduled Task startup and
  machine-level environment variables.

## Expected Operator Flow

1. Configure `C:\ProgramData\MetaSheet\BridgeAgent\config.json`.
2. Store Bridge Agent secrets in machine-level environment variables.
3. Run `bridge-agent-readonly.ps1 -ValidateConfigOnly`.
4. Install and start the task:

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\metasheet\scripts\ops\bridge-agent-readonly-scheduled-task.ps1 `
     -Action Install `
     -RootDir C:\metasheet `
     -ConfigPath C:\ProgramData\MetaSheet\BridgeAgent\config.json `
     -StartAfterInstall
   ```

5. Run the authenticated `/health`, `/objects`, `/schema/*`, and `/query/*`
   smoke commands from the existing runbook.

## Compatibility

The helper targets Windows PowerShell 5.1 and stays ASCII-only. It does not
require PowerShell 7, NSSM, WinSW, .NET SDK, Visual Studio, Docker, or a new
database migration.
