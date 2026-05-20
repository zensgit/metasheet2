# On-prem scheduled-task exit-marker fix - design - 2026-05-20

## Problem (from the 2026-05-20 bridge feedback on #1526)

After #1696 (apply env loading) and #1699 (self-bootstrap launcher) shipped,
operators still see a misleading state on Windows on-prem upgrades:

- `apply` log ends with `Package deploy complete` and healthcheck `200`,
- but the outer Scheduled Task / wrapper exits **1**,
- and no parseable `apply exit=N` marker is anywhere in the chain, so
  there is no way to tell at a glance whether `apply` itself reported
  failure or the wrapper introduced the non-zero.

## Root cause

The fault is at the launcher boundary, then compounded by the outer
wrappers.

### Launcher: `$LASTEXITCODE` leak across an in-process call

`scripts/ops/multitable-onprem-deploy-launcher.ps1` invoked the staged
apply helper via:

```powershell
& $stagedApply -RootDir $resolvedRoot -PackageArchive $resolvedArchive
if ($null -ne $LASTEXITCODE) {
  $launcherExit = $LASTEXITCODE
} else {
  $launcherExit = 0
}
```

The call operator `&` runs the .ps1 in-process. `$LASTEXITCODE` is the
**session-wide** last external-program exit code. Apply.ps1 itself
invokes several external programs internally (`tar`, `node migrate.js`,
`pm2`, the cmd.exe dependency-refresh wrapper, etc.). Whatever the
**last external program** apply touched is what `$LASTEXITCODE` reflects
after `& $stagedApply ...` returns - **not the apply script's overall
outcome**.

Worse, apply.ps1's contract is `$ErrorActionPreference = 'Stop'` plus
`throw` on real failures. Successful completion does **not** call
`exit 0`. So the post-`&` `$LASTEXITCODE` can be any of:

- whatever the last internal external program returned (often 0, but
  not guaranteed across all code paths);
- whatever it was before the call, if apply.ps1 only used cmdlets;
- mismatched with the true outcome on any path that ends with a
  non-fatal exit-1 external call (e.g., a `findstr` that found no
  match, a `pm2 list` after a fresh start, etc.).

This is the silent leak that puts a stray `1` into the scheduled task's
Last Result while the apply log still reads "complete".

### deploy-remote.bat: fire-and-forget that ignores the apply outcome

`deploy-remote.bat`, the wrapper most scheduled-task setups call,
contained:

```batch
start "" /min cmd /c "call deploy.bat ... >> deploy-remote.log 2>&1"
echo [multitable-onprem-deploy-remote] started. See output\logs\deploy-remote.log
exit /b 0
```

`start ""` fires the inner `call deploy.bat` as a separate background
process; the launching cmd returns immediately. `deploy-remote.bat`
**always** exits 0, regardless of whether the background apply
eventually succeeds or fails. The Last Result the scheduled task records
is therefore unrelated to the apply outcome; the log file has no final
`apply exit=N` line. (When the operator did see `1`, it was almost
certainly the launcher leak above and a scheduled-task configured to
call `deploy.bat` directly, not deploy-remote.bat - but both paths are
misleading.)

### No `apply exit=` marker anywhere

Grep across `scripts/ops` for `apply exit=` / `APPLY_EXIT` returned
nothing. The chain had no stable last-line breadcrumb the operator could
match against the scheduled-task Last Result. Bridge feedback explicitly
asks for it.

## Fix

Three coordinated, narrow changes - all in `scripts/ops/*` heredocs +
the launcher.

### 1. Launcher: drop `$LASTEXITCODE`, use the throw/no-throw contract

```powershell
try {
  & $stagedApply -RootDir $resolvedRoot -PackageArchive $resolvedArchive
  $launcherExit = 0
}
catch {
  Write-LauncherInfo ("Apply helper raised an error: {0}" -f $_.Exception.Message)
  $launcherExit = 1
}
```

apply.ps1's contract is "throw on failure, return on success". The
launcher honors that contract and ignores `$LASTEXITCODE` for this call.
A successful apply now reliably yields `$launcherExit = 0`; a failure
throws and yields 1.

### 2. Launcher: emit `apply exit=N` as the last informative log line

After the staging cleanup, before the script exits:

```powershell
Write-LauncherInfo ("apply exit={0}" -f $launcherExit)
exit $launcherExit
```

This is the **inner-most source of truth** for the apply outcome. Outer
wrappers echo the same marker; this one is the parseable canonical line.

Contract note: the launcher's `Write-LauncherInfo "apply exit=..."`
runs at script body scope, after the `try/finally`, before `exit`.
If apply.ps1 ever switched from `throw` to an uncaught `exit N`
inside `& $stagedApply`, PowerShell would terminate the launcher
script too and this marker line would not fire. The launcher would
still exit with apply's code (correct), but the parseable marker
would be absent. Documenting this so a future change to apply.ps1's
error pattern does not silently break the marker contract.

### 3. deploy.bat / deploy-remote.bat / deploy-${LABEL}.bat: capture +
emit + propagate

Every batch wrapper that calls the layer below now captures
`%ERRORLEVEL%` into a named local `APPLY_EXIT`, echoes a parseable
`[multitable-onprem-deploy*] apply exit=%APPLY_EXIT%` line, and exits
with `exit /b %APPLY_EXIT%`. The dedicated logged-to-file wrapper
(`deploy-remote.bat`) **also** appends that marker into
`output\logs\deploy-remote.log` so a scheduled-task operator can
correlate the file with the Last Result.

`deploy-remote.bat` additionally changes from `start ""` (background) to
synchronous `call`. The original "fire-and-forget" semantics is what
made the wrapper return 0 regardless of apply outcome; that was the
opposite of what the user needs. The trade is acknowledged in the
verification MD - if any caller depended on the wrapper returning
immediately, they should instead use the underlying `deploy.bat` and
their own background scheduler.

## Package verifier gate

`verify_windows_entrypoints` gets new assertions and one new negative:

- `deploy.bat` must have `set "APPLY_EXIT=%ERRORLEVEL%"`,
  `[multitable-onprem-deploy] apply exit=%APPLY_EXIT%`, and
  `exit /b %APPLY_EXIT%`.
- launcher.ps1 must emit an `apply exit=` line and must **not** contain
  the `if ($null -ne $LASTEXITCODE) {` leak pattern.
- `deploy-remote.bat` must contain the synchronous
  `call "%~dp0deploy.bat" "%~1" >> "%~dp0output\logs\deploy-remote.log" 2>&1`
  redirection, `set "APPLY_EXIT=%ERRORLEVEL%"`, the parseable marker
  with the `deploy-remote` prefix, and `exit /b %APPLY_EXIT%`. The
  fire-and-forget `start "" /min cmd /c` pattern is now a die().
- `deploy-${LABEL}.bat` must also capture + echo + propagate APPLY_EXIT.

A pre-fix package (latest build before this PR) dies on the very first
new assertion with the exact intended message.

## Out of scope (deliberate)

- No `plugin-integration-core` change.
- No DB migration.
- No API runtime / frontend / K3 Save / Submit / Audit change.
- No SQL / TLS failure summarization (separate #1526 actionable).
- Customer GATE **not** lifted. This PR makes the scheduled-task Last
  Result trustworthy; it does not unblock live PoC.

## Files touched

- `scripts/ops/multitable-onprem-deploy-launcher.ps1` (drop
  `$LASTEXITCODE` leak; emit `apply exit=N`)
- `scripts/ops/multitable-onprem-package-build.sh`
  (deploy.bat / deploy-remote.bat / deploy-${LABEL}.bat heredocs +
  comment context)
- `scripts/ops/multitable-onprem-package-verify.sh`
  (verify_windows_entrypoints assertions)
- this design MD + companion verification MD
