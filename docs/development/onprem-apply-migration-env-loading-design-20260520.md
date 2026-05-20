# On-prem apply migration env loading - design - 2026-05-20

## Problem (from the 2026-05-20 bridge feedback on #1526)

The 7070db825 Windows on-prem zip deployment confirmed the
dependency-refresh wrapper + exit-marker fix from #1684 is working
end-to-end: dependency refresh runs non-interactively under cmd.exe and
the apply script picks up the wrapper exit marker. But the official apply
then **fails during the migration step** with:

```text
DATABASE_URL not set
```

and the scheduled task exits 1 before PM2 restart or the healthcheck ever
runs. The host operator's manual workaround was to **load the env file
into the process and re-run migrations + PM2 restart + healthcheck**, which
succeeded (8/8 mock preflight, 10/0 authenticated postdeploy, 200
healthcheck).

Root cause located in `scripts/ops/multitable-onprem-apply-package.ps1`:

- The script already accepts a `-EnvFile` parameter and falls back to
  `docker\app.env` under the package root.
- It already validates the file with `Test-Path` and throws when missing.
- **It never reads that file into the PowerShell process environment.**
  The migration call `node $migratePath` then runs with an empty env,
  hence `DATABASE_URL not set`.

PM2 starts later through `scripts/ops/attendance-onprem-start-pm2.ps1`,
which **does** import the same env file (its own `Import-AppEnvFile`
helper). That is why the manual workaround works after the operator runs
PM2 startup themselves: PM2 sourcing the env file masks the apply-side
gap, but the migration step had already failed.

## Fix

Mirror the PM2 helper inside `multitable-onprem-apply-package.ps1` and
invoke it immediately after `Test-Path` succeeds, before any block that
spawns a child process needing the env (migrations, PM2 startup,
healthcheck request).

- New helper `Import-AppEnvFile` in apply.ps1, byte-for-byte equivalent
  parser to `attendance-onprem-start-pm2.ps1` (comments + blanks
  skipped, `KEY=VALUE` split on first `=`, matching outer quotes
  stripped, written with `Set-Item Env:NAME`). The helper returns the
  number of variables applied so the apply log can report a count
  without echoing names or values.
- Call site is inserted after the existing env-file `Test-Path` block:

  ```powershell
  if (-not (Test-Path -LiteralPath $resolvedEnvFile)) {
    throw "EnvFile not found: $resolvedEnvFile. Use -EnvFile <path> or place app.env at docker\app.env under the root."
  }

  $importedEnvCount = Import-AppEnvFile -EnvFile $resolvedEnvFile
  Write-Info ("Loaded env from {0} ({1} variables); migration / restart / healthcheck will inherit DATABASE_URL and JWT_SECRET when present in that file" -f $resolvedEnvFile, $importedEnvCount)
  ```

- The error string for the missing-file case is upgraded to include the
  override path so an operator hitting "EnvFile not found" sees both the
  default location and the `-EnvFile` escape hatch.

## Why mirror PM2's parser exactly

- Both code paths (apply migration, PM2 backend) must read the **same**
  env file the **same** way, or DATABASE_URL might be quoted/unquoted or
  whitespace-trimmed differently between the two. Identical parser
  removes that risk class.
- The operator already knows the PM2 helper's behavior; reusing it keeps
  the mental model and any future hardening in one shape.

## Order-of-operations note

Env is loaded **before** the dependency-refresh wrapper runs, not just
before migration - this is the right placement (PM2 startup and the
healthcheck step both need DATABASE_URL / JWT_SECRET too, and dependency
refresh happens earlier in the script). One consequence to acknowledge:
the cmd.exe wrapper for `pnpm install --frozen-lockfile` will now
inherit whatever the operator's `app.env` contains. The wrapper still
sets `CI=true` and `PNPM_CONFIG_CONFIRM_MODULES_PURGE=false` explicitly,
which overrides the pnpm-relevant subset of anything `app.env` might
declare. If `app.env` were to carry `NODE_OPTIONS`, `PATH`,
`NPM_CONFIG_REGISTRY`, or `NODE_TLS_REJECT_UNAUTHORIZED`, those would
now be visible during dependency refresh. Typical on-prem `app.env`
holds app-runtime vars only (DB URL, JWT secret, ports), so this is a
low-probability surface; calling it out so a future surprise here is
debuggable rather than mysterious.

## Secret hygiene

- No env name or value is logged. Only the file path and the count are
  written via `Write-Info`. `DATABASE_URL` and `JWT_SECRET` are mentioned
  in the log message as *expected* env vars, not as values - that text
  is a static template.
- Helper does not return the dictionary, only the count, so callers
  cannot inadvertently spill it.

## Preservation of #1684 / 7070db825 behavior

Untouched in this PR:

- `New-DependencyRefreshCommandWrapper`, `Get-DependencyRefreshExitCodeFromLog`,
  `WaitForExit()` + ExitCode polling, the `cmd.exe /c pnpm install`
  non-interactive env (`CI=true PNPM_CONFIG_CONFIRM_MODULES_PURGE=false`),
  the deploy-local pnpm store, taskkill on timeout, the wrapper stdout
  marker `[dependency-refresh-wrapper] pnpm install exit=<n>`.
- All the verify-script assertions added by #1684 for those behaviors
  remain in place. The new assertions in this PR are pure additions
  next to them.

## Package verify gate (lock-safe ops hygiene)

`scripts/ops/multitable-onprem-package-verify.sh`
`verify_windows_entrypoints` gets two new `search_fixed_string`
assertions against the packaged apply.ps1:

- `Import-AppEnvFile` (helper present)
- `Loaded env from` (helper invoked before downstream blocks)

So a future stale package without the env loader fails verify in CI
before anyone reaches a Windows box. Verified as a real gate: pre-fix
origin/main apply.ps1 had **0** occurrences of either string, so the
gate would die on a regressed package.

## Out of scope (deliberate)

- No change to `plugin-integration-core` business runtime.
- No change to the SQL Server executor or the SQL/TLS failure
  summarization (separate #1526 actionable; explicitly tagged
  out-of-scope here).
- No change to deploy.bat / its forwarded arguments. `-EnvFile`
  remains the operator escape hatch on the apply.ps1 side; deploy.bat
  continues to rely on the default `docker\app.env` location. An
  EnvFile forward through deploy.bat is a follow-up if a customer
  needs a non-default location end-to-end.
- No K3 Save / Submit / Audit behavior change.
- No customer GATE lifted. This PR removes a deploy blocker; the
  GATE for live PoC still depends on customer-supplied answers.

## Files touched

- `scripts/ops/multitable-onprem-apply-package.ps1` (helper + call site
  + error-message upgrade)
- `scripts/ops/multitable-onprem-package-verify.sh` (two assertions)
- this design MD + companion verification MD
