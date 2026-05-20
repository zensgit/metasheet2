# On-prem scheduled-task exit-marker fix - verification - 2026-05-20

Companion to `onprem-scheduled-task-exit-marker-design-20260520.md`. Ops
only: launcher.ps1 + build / verify scripts; no `plugin-integration-core`,
no DB migration, no API runtime, no route, no frontend, no K3
Save/Submit/Audit.

## Local evidence (all on the isolated worktree)

### 1. Syntax / static checks

```text
bash -n scripts/ops/multitable-onprem-package-build.sh    -> exit 0
bash -n scripts/ops/multitable-onprem-package-verify.sh   -> exit 0
git diff --check                                          -> exit 0
```

`pwsh` is not installed on this dev host; the launcher's PowerShell
parse will be exercised on Windows-side CI / on-prem apply.

### 2. End-to-end build + verify (positive)

```text
pnpm install --frozen-lockfile                            -> Done in 3.4s
BUILD_WEB=1 BUILD_BACKEND=1 INSTALL_DEPS=0 \
  bash scripts/ops/multitable-onprem-package-build.sh
  -> exit 0; produced metasheet-multitable-onprem-v2.5.0-20260519-205803.zip

bash scripts/ops/multitable-onprem-package-verify.sh <that zip>
  -> "Package verify OK", exit 0
```

### 3. Bundled wrappers carry every marker (visual check)

After extracting the produced zip:

**deploy.bat**

```batch
powershell ... -File "%~dp0scripts\ops\multitable-onprem-deploy-launcher.ps1" -RootDir "%~dp0." -PackageArchive "%~1"
set "APPLY_EXIT=%ERRORLEVEL%"
echo [multitable-onprem-deploy] apply exit=%APPLY_EXIT%
exit /b %APPLY_EXIT%
```

**deploy-remote.bat** (now synchronous)

```batch
if not exist "%~dp0output\logs" mkdir "%~dp0output\logs"
call "%~dp0deploy.bat" "%~1" >> "%~dp0output\logs\deploy-remote.log" 2>&1
set "APPLY_EXIT=%ERRORLEVEL%"
>> "%~dp0output\logs\deploy-remote.log" echo [multitable-onprem-deploy-remote] apply exit=%APPLY_EXIT%
echo [multitable-onprem-deploy-remote] apply exit=%APPLY_EXIT%. See output\logs\deploy-remote.log
exit /b %APPLY_EXIT%
```

The previous `start "" /min cmd /c ... ; exit /b 0` fire-and-forget
pattern is gone.

**deploy-${LABEL}.bat**

```batch
call "%~dp0deploy.bat" "%~1"
set "APPLY_EXIT=%ERRORLEVEL%"
echo [multitable-onprem-deploy-label] apply exit=%APPLY_EXIT%
exit /b %APPLY_EXIT%
```

**multitable-onprem-deploy-launcher.ps1** (tail)

```powershell
try {
  & $stagedApply -RootDir $resolvedRoot -PackageArchive $resolvedArchive
  $launcherExit = 0
}
catch {
  Write-LauncherInfo ("Apply helper raised an error: {0}" -f $_.Exception.Message)
  $launcherExit = 1
}
...
Write-LauncherInfo ("apply exit={0}" -f $launcherExit)
exit $launcherExit
```

The `if ($null -ne $LASTEXITCODE) {` leak is gone.

### 4. Negative proof: pre-fix zip dies on the first new assertion

A previously-built zip (built right before this fix landed):

```text
/Users/.../output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-20260519-200530.zip

bash scripts/ops/multitable-onprem-package-verify.sh <pre-fix zip>
  -> [multitable-onprem-package-verify] ERROR: deploy.bat must capture
     the launcher exit code into APPLY_EXIT
```

The new gate dies on the very first new deploy.bat assertion, with the
exact intended message. To prove the remaining new assertions are also
real gates (not single-bit speculation), here is the empirical
per-marker count in the same pre-fix zip:

| File | New marker | Count in pre-fix zip |
| --- | --- | --- |
| deploy.bat | `set "APPLY_EXIT=%ERRORLEVEL%"` | 0 |
| deploy.bat | `[multitable-onprem-deploy] apply exit=` | 0 |
| deploy.bat | `exit /b %APPLY_EXIT%` | 0 |
| launcher.ps1 | `apply exit=` | 0 |
| deploy-remote.bat | `set "APPLY_EXIT=%ERRORLEVEL%"` | 0 |
| deploy-remote.bat | `[multitable-onprem-deploy-remote] apply exit=` | 0 |
| deploy-remote.bat | `exit /b %APPLY_EXIT%` | 0 |
| deploy-${LABEL}.bat | `set "APPLY_EXIT=%ERRORLEVEL%"` | 0 |
| deploy-${LABEL}.bat | `[multitable-onprem-deploy-label] apply exit=` | 0 |
| deploy-${LABEL}.bat | `exit /b %APPLY_EXIT%` | 0 |
| deploy-remote.bat | `start "" /min cmd /c` (the new **negative** the gate forbids) | 1 |

All 10 new positive assertions would fire on this zip; the new negative
(fire-and-forget pattern) would also fire because the pre-fix zip
contains it. The gate is multi-bit real, not single-bit wishful.

## Behavior change: `deploy-remote.bat` is now synchronous

The previous `deploy-remote.bat` returned immediately ("fire and
forget"), letting `cmd.exe` close while apply ran in a background
process. That is incompatible with the user-stated requirement
("outer wrapper returns 0 on success and non-zero on failure"): if the
wrapper returns before apply completes, the outer caller has no way to
get a meaningful exit code.

If a caller specifically needs background semantics:

- run their own `start ""` against `deploy.bat`, or
- use a scheduled task with a separate completion handler.

This is the documented trade. The PR description and #1526 follow-up
comment both call this out.

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| Real code path located, not guessed | `write_windows_entrypoints` in `multitable-onprem-package-build.sh`; the four heredocs (deploy.bat / deploy-remote.bat / deploy-${LABEL}.bat / bootstrap-admin.bat); and the launcher.ps1 itself. All visible in the diff. |
| Outer wrapper exits 0 on apply success | launcher's throw/no-throw contract -> launcher exits 0; deploy.bat captures + propagates; deploy-remote.bat and deploy-${LABEL}.bat capture + propagate. End-to-end synchronously. |
| Outer wrapper exits non-zero on apply failure | Same chain in reverse: apply.ps1 throws -> launcher catch sets `$launcherExit = 1` -> PowerShell exits 1 -> %ERRORLEVEL%=1 -> APPLY_EXIT=1 -> `exit /b %APPLY_EXIT%`. |
| `apply exit=0` written stably on success | launcher emits via `Write-LauncherInfo "apply exit={0}"`; deploy.bat / deploy-remote.bat / deploy-${LABEL}.bat all echo their own labeled marker; deploy-remote.bat also appends to `output\logs\deploy-remote.log`. |
| Package verify detects relevant markers | New assertions in `verify_windows_entrypoints`; pre-fix zip dies on the first one with the exact intended message. |
| bash -n on related shell scripts | exit 0 (both) |
| package build/verify | exit 0 / "Package verify OK" |
| git diff --check | exit 0 |

## Deployment impact

- Operators currently relying on the old `deploy-remote.bat` "return
  immediately" behavior will see the wrapper now block until apply
  completes. The trade is necessary for a meaningful exit code; the
  background pattern can still be assembled by the caller.
- No env var, no migration, no flag, no route, no bundle behavior
  change.
- Scheduled-task Last Result becomes a trustworthy success/failure
  signal that matches the underlying apply outcome.
- `deploy-remote.log` now ends with a parseable marker
  (`[multitable-onprem-deploy-remote] apply exit=N`) so operators can
  correlate a log file with the scheduled-task Last Result without
  scanning the full log body.

End-to-end log capture: `Write-Info` from apply.ps1 and
`Write-LauncherInfo` from the launcher both write to stdout via
PowerShell's `Write-Output`. `deploy.bat` inherits that stdout.
`deploy-remote.bat`'s `>> "%~dp0output\logs\deploy-remote.log" 2>&1`
redirection captures both, so #1696's `Loaded env from ...` line and
this PR's `apply exit=N` line both land in deploy-remote.log on the
scheduled-task path - no separate plumbing needed.

## GATE-blocking status

This PR does **not** lift the customer GATE. SQL Server / TLS failure
summarization and K3 Save / Submit / Audit behavior are explicitly out
of scope and unchanged.

## Rollback

Revert the PR. The launcher reverts to the prior `$LASTEXITCODE` check,
the three batch wrappers lose the APPLY_EXIT capture, and `deploy-remote.bat`
returns to its `start ""` fire-and-forget pattern. No DB or runtime
state to undo.

## Operational note for parallel sessions

This PR was developed in an isolated `git worktree`
(`/tmp/ms2-sched-exit-...`) to avoid the parallel-session worktree
hazard that affected #1699's first commit. The main checkout was being
held by other branches during the work; only the isolated worktree was
ever modified, committed, and pushed.
