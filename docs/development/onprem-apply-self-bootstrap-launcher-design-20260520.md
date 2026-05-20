# On-prem apply self-bootstrap launcher - design - 2026-05-20

## Problem (from the 2026-05-20 bridge feedback on #1526)

The 3e76aa7c6 package (which contains the #1696 env-loading fix) deployed
PASS on its **second** `official apply`. The **first** apply still
executed the stale apply helper already installed in the root - because
`deploy.bat` invokes
`%~dp0scripts\ops\multitable-onprem-apply-package.ps1`, which is the
helper present **before** the new package contents land on disk. The new
helper only arrives after the running apply finishes its
extraction+copy step, so on an upgrade from a broken or older helper the
first apply is always running stale code. Operators have to rerun apply
("first fails, second succeeds").

## Fix: self-bootstrapping launcher

Insert a small, stable launcher between `deploy.bat` and the apply
helper. `deploy.bat` now invokes
`scripts/ops/multitable-onprem-deploy-launcher.ps1`. The launcher:

1. extracts the supplied package archive into a fresh temp staging dir
   (Expand-Archive for .zip, `tar -xzf` for .tgz / .tar.gz);
2. locates the staged package root (preferring a directory named
   `metasheet-multitable-onprem-*` for safety);
3. resolves the staged apply helper at
   `<staged>\scripts\ops\multitable-onprem-apply-package.ps1`;
4. invokes it with `-RootDir <installed-root> -PackageArchive <orig>`,
   so apply runs from the **freshest** helper but writes into the
   **same installed root** that deploy.bat targets;
5. cleans up the staging directory and propagates the apply exit code.

Result: on any upgrade where the installed `deploy.bat` is `>=` this PR,
the first apply uses the apply helper inside the supplied package -
even if the helper sitting in the installed root is older or broken.

This is intentionally a *forward* fix. The literal upgrade from a
pre-this-PR install still goes through the old `deploy.bat` -> old
apply.ps1 once, lands the new files (including the new launcher and
the new deploy.bat), and from then on every upgrade is first-apply
correct.

## Why launcher (extract-first) and not self-refresh (copy-files-first)

A self-refresh approach (deploy.bat copies just the new apply.ps1 from
the package into the installed root before invoking it) was considered
and rejected:

- self-refresh has its own chicken-and-egg: the OLD `deploy.bat` is
  still the one running on a stale install, so the OLD copy-files
  logic is what executes. Whatever invariant we want to establish at
  the top of the chain must live in `deploy.bat` itself.
- self-refresh leaves a partially-overwritten installed root if it
  fails mid-copy (e.g., one file replaced, helpers not), which is
  harder to recover from than a self-contained staging directory the
  launcher always wipes.
- the launcher does *not* mutate the installed root - it only stages
  to a temp dir and invokes apply. apply continues to do the
  copy-into-root step exactly as before, so on success the installed
  root ends up in the same shape today's apply produces, with no new
  partial-write states to worry about.

## What the launcher does not do

- It does not load env (still apply.ps1's job - #1696).
- It does not run migrations (apply.ps1).
- It does not start PM2 (apply.ps1 -> attendance-onprem-start-pm2.ps1).
- It does not touch the DB.
- It does not call any K3 endpoint.
- It does not run dependency-refresh; the staged apply.ps1 still
  generates and runs the dependency-refresh wrapper exactly as #1684
  established.

## #1684 / #1696 preserved (diff scope)

This PR adds one new file
(`scripts/ops/multitable-onprem-deploy-launcher.ps1`), adds two lines
to the build script (REQUIRED_PATHS + the INSTALL.txt note), rewrites
the build script's `deploy.bat` heredoc to call the launcher, and
adjusts the package verifier. **No line of
`multitable-onprem-apply-package.ps1` is changed.** The #1684
dependency-refresh wrapper + exit-marker behavior and the #1696 env
loader behavior are inherited unchanged when the staged apply.ps1
runs.

## Package verifier gate (lock-safe ops hygiene)

`verify_windows_entrypoints` is updated:

- the previous "deploy.bat must call apply-package.ps1" assertion
  becomes "deploy.bat must call deploy-launcher.ps1" (the launcher is
  now the canonical PS entry point);
- a new positive assertion ensures `deploy.bat` does NOT call the
  apply helper directly (a stale build that bypasses the launcher
  would fail verify);
- the launcher file must exist in the package;
- the launcher must contain the self-identification marker
  `[multitable-onprem-deploy-launcher]`, the `Expand-StagingArchive`
  and `Resolve-StagedPackageRoot` function names, the reference to
  the staged `multitable-onprem-apply-package.ps1`, and the staging
  cleanup `Remove-Item -LiteralPath $stage`.

This proves at build/verify time that an attempt to ship a stale
package without the launcher fix would die() in CI rather than reach
an operator's machine.

## Out of scope (deliberate)

- No change to `plugin-integration-core` runtime.
- No SQL Server / TLS failure summarization (separate #1526 actionable).
- No K3 Save / Submit / Audit behavior change.
- No customer GATE lifted. This PR removes the "first apply uses
  stale helper" failure mode; it does not unblock live PoC.

## Files touched

- `scripts/ops/multitable-onprem-deploy-launcher.ps1` (new)
- `scripts/ops/multitable-onprem-package-build.sh`
  (REQUIRED_PATHS entry + deploy.bat heredoc + INSTALL.txt note)
- `scripts/ops/multitable-onprem-package-verify.sh`
  (verify_windows_entrypoints assertions)
- this design MD + companion verification MD
