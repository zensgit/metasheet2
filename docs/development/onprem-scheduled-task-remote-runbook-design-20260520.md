# On-prem scheduled-task remote runbook update - design - 2026-05-20

## Goal

Docs-only follow-up to release `584dbc88a` (PR #1703 merge: "trustworthy
scheduled-task exit code + apply-exit marker"). The fix code already
shipped; this PR records the **operator-side acceptance recipe** the
bridge run validated, plus two follow-up notes the bridge surfaced that
were not yet captured in the canonical Windows on-prem runbook.

## Scope

- Update `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
  with a new `## 10.2) Scheduled-task remote apply (release 584dbc88a and
  later)` subsection, sitting after the existing `## 10.1)` block (which
  already describes the wrappers).
- Add this design MD + companion verification MD under
  `docs/development/`.
- No code change. No package build. No verify-script gate change.

## Content the runbook section adds

1. **Pre-584dbc88a upgrade gotcha.** The new `deploy-remote.bat`
   (synchronous, captures APPLY_EXIT, writes `apply exit=N`) only takes
   effect after it has been copied into the installed root. The very
   first scheduled-task run on an upgrade from a pre-584dbc88a state
   still uses the **old** `deploy-remote.bat` (fire-and-forget, returns
   0). Two operator-side paths to bridge this:
   - one synchronous `deploy.bat <new.zip>` run first to land the new
     wrappers, then let the scheduled task fire, or
   - manually copy the four files (`deploy.bat`, `deploy-remote.bat`,
     `deploy-runXX.bat`, `multitable-onprem-deploy-launcher.ps1`) from
     the new package zip into the installed root before scheduling.
2. **SYSTEM scheduled-task env requirement.** A scheduled task running
   as LocalSystem does not inherit the Administrator's `PATH` or home
   environment, so `pnpm.cmd` / `pm2` fail to resolve Node / pnpm and
   to find a writable home. The task definition must explicitly inject
   `PATH` (Node + pnpm install roots), `HOME` / `HOMEPATH` /
   `USERPROFILE` (Administrator profile), and `APPDATA`. Alternative:
   run the task as the Administrator account directly.
3. **Success acceptance, explicit.**
   - `LastTaskResult = 0`.
   - `output/logs/deploy-remote.log` tail contains all three markers
     (inner-most → outer-most): launcher, deploy, deploy-remote each
     with `apply exit=0`.
   - apply progression reaches dependency refresh, migrations, PM2
     restart/save, "Package deploy complete", "Healthcheck OK".
4. **Out of scope, explicit.** No `plugin-integration-core`, DB, API,
   frontend, K3 Save/Submit/Audit, SQL/TLS failure summary. Customer
   GATE unchanged.

## Why the existing runbook, not a new file

The canonical install runbook
`docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
already has `## 10) Upgrade later` and `## 10.1) One-command server-side
package apply`, which describe `deploy.bat`/`deploy-remote.bat` flows.
The new section is a direct continuation (`10.2`) of that thread.
Creating a separate doc would force operators to read two places for
the same upgrade flow, which the bridge feedback explicitly does not
want.

## Why a "real-environment" acceptance section is worth the addition

The bridge feedback distinguishes between two kinds of "looks OK":

- `apply` log ends with "Package deploy complete" but `LastTaskResult`
  is wrong (the pre-584dbc88a quirk that PR #1703 fixed in code);
- `LastTaskResult = 0` but only because `deploy-remote.bat` was
  fire-and-forget and returned 0 regardless of apply (also pre-fix).

Recording the three-marker check + the chain of progression in one
checklist gives operators a single grep target to distinguish "the
scheduled task really succeeded" from "the scheduled task returned 0
without proving anything".

## Non-goals

- No content about K3 PoC, GATE intake, SQL Server, TLS — they belong
  to other runbooks.
- No tooling change to validate the three markers automatically beyond
  what `multitable-onprem-package-verify.sh` already enforces in CI.
  The runbook acceptance is operator-side; the CI gate is
  build-time-side. Both already exist; this PR just documents the
  operator-side flow.

## Files touched

- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
  (new `## 10.2)` subsection inserted before `## 11) Delivery
  checklist`)
- `docs/development/onprem-scheduled-task-remote-runbook-design-20260520.md`
  (this file)
- `docs/development/onprem-scheduled-task-remote-runbook-verification-20260520.md`
  (companion)
