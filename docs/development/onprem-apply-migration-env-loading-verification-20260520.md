# On-prem apply migration env loading - verification - 2026-05-20

Companion to `onprem-apply-migration-env-loading-design-20260520.md`. Ops
only: `multitable-onprem-apply-package.ps1` + the package verifier; no
`plugin-integration-core`, no DB migration, no API runtime, no route.

## Local evidence

### 1. Bash syntax of the modified verify script

```text
bash -n scripts/ops/multitable-onprem-package-verify.sh
  -> exit 0 (syntax OK)
```

### 2. Positive markers in post-fix apply.ps1

```text
grep -c 'Import-AppEnvFile'  apply.ps1   -> 3 (function def + comment + call)
grep -c 'Loaded env from'    apply.ps1   -> 1 (Write-Info on the call site)
```

### 3. Negative proof: pre-fix apply.ps1 lacked both (gate is real)

```text
git show origin/main:scripts/ops/multitable-onprem-apply-package.ps1
  | grep -c 'Import-AppEnvFile'  -> 0
  | grep -c 'Loaded env from'    -> 0
```

A package built from pre-fix `main` would now die on **both** new
assertions, so the verify gate is genuinely catching the regression
class - it is not a no-op.

### 4. End-to-end build + verify

```text
BUILD_WEB=1 BUILD_BACKEND=1 INSTALL_DEPS=0 \
  bash scripts/ops/multitable-onprem-package-build.sh
  -> exit 0; produced metasheet-multitable-onprem-v2.5.0-20260519-191605.zip

bash scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/<that>.zip
  -> "Package verify OK", exit 0
```

Bundled apply.ps1 inside the produced zip greps clean: 3 occurrences of
`Import-AppEnvFile`, 1 of `Loaded env from`. The new gate is satisfied
by the packaged ps1.

## What this PR does **not** prove

- No live deploy executed against a Windows machine in this run. The
  Windows-side validation will run on a real on-prem bridge against the
  official package built from this PR's merge. The runbook for that is
  unchanged - the bridge already runs `multitable-onprem-apply-package.ps1`
  via the scheduled task.
- No PowerShell parse-check executed locally (no `pwsh` on this dev
  host). The PR relies on the existing CI / on-prem apply path to
  exercise the script. The change is small and follows the existing
  helper idioms exactly.

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| PowerShell apply can load env before migration | Helper definition + call placed before migration block in apply.ps1 |
| Missing env file gives a clear error | Existing `Test-Path` check kept; message upgraded to mention both default and `-EnvFile` override |
| With env file present, migration sees DATABASE_URL / JWT_SECRET | `Import-AppEnvFile` writes via `Set-Item Env:` so child `node migrate.js` inherits the process env |
| Package verify confirms scripts/docs are in the Windows on-prem zip | Two new `search_fixed_string` assertions wired into `verify_windows_entrypoints`; build + verify produced "Package verify OK" |

## #1684 / 7070db825 behavior preserved (diff-proven, not spot-checked)

```text
git diff origin/main -- scripts/ops/multitable-onprem-apply-package.ps1 \
  | grep -c '^-[^-]'    -> 1
```

The single non-header delete line is the old throw message
`throw "EnvFile not found: $resolvedEnvFile"`, replaced with the
upgraded message required by acceptance criterion 2 (mention default
location + `-EnvFile` override). It is in the env-file resolution
block, **not** in any of the `#1684` wrapper / exit-marker code paths.
All other changes are pure additions.

Spot-checked still-present after the diff-prove:

- `New-DependencyRefreshCommandWrapper`,
  `Get-DependencyRefreshExitCodeFromLog`, the wrapper stdout marker
  `[dependency-refresh-wrapper] pnpm install exit=<n>`, the
  `cmd.exe /c pnpm install --frozen-lockfile` invocation with
  `CI=true` / `PNPM_CONFIG_CONFIRM_MODULES_PURGE=false`, the deploy-local
  `.pnpm-store`, taskkill on timeout, `WaitForExit()` before reading
  `ExitCode`.

The PR adds code; it does not modify or remove any wrapper line.

## Deployment impact

- No env var, no migration, no flag, no route, no bundle behavior
  change.
- The new helper imports values **already in the operator's env file**
  on each apply run. It does not invent or default any value.
- An operator with no `docker\app.env` and no `-EnvFile` override gets
  the existing `EnvFile not found` error, now with a clearer message
  pointing at both the default path and the override flag.

## GATE-blocking status

This PR does **not** lift the customer GATE and does not change any K3
Save / Submit / Audit behavior. It removes a deploy blocker on Windows
on-prem apply so future bridge runs can reach PM2 restart and the
authenticated postdeploy smoke from a clean scheduled-task invocation,
matching what the manual finalize already demonstrated on
`multitable-onprem-k3wise-20260519-7070db825`.

## Rollback

Revert the PR. The change is two helper-style edits in one ps1 file
plus two grep assertions; rollback restores the prior state exactly,
returning operators to the pre-fix workaround (manual env load before
finalize).
