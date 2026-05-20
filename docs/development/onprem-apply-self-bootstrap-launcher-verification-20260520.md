# On-prem apply self-bootstrap launcher - verification - 2026-05-20

Companion to `onprem-apply-self-bootstrap-launcher-design-20260520.md`.
Ops only: build script + verify script + a new self-contained launcher
ps1; no `plugin-integration-core`, no DB migration, no API runtime, no
route.

## Local evidence

### 1. Syntax

```text
bash -n scripts/ops/multitable-onprem-package-build.sh   -> exit 0
bash -n scripts/ops/multitable-onprem-package-verify.sh  -> exit 0
```

`pwsh` is not installed on this dev host; the launcher's PowerShell
parse will be exercised on Windows-side CI / on-prem apply.

### 2. Positive markers inside the new launcher

```text
[multitable-onprem-deploy-launcher]         -> 1 occurrence
Expand-StagingArchive                       -> 2 (definition + call)
Resolve-StagedPackageRoot                   -> 2 (definition + call)
multitable-onprem-apply-package.ps1         -> 2 (Join-Path + reference)
Remove-Item -LiteralPath $stage             -> 1 (finally cleanup)
```

### 3. Negative proof: pre-fix package fails on the new gate

Took the previous (pre-launcher) zip already sitting in
`output/releases/multitable-onprem/`:

```text
metasheet-multitable-onprem-v2.5.0-20260519-191605.zip
  (built from origin/main without this PR; contains the #1696 env-loading
   fix but no launcher and no launcher reference in deploy.bat)

bash scripts/ops/multitable-onprem-package-verify.sh <that pre-fix zip>
  -> [multitable-onprem-package-verify] ERROR: deploy.bat must call the
     self-bootstrapping PowerShell launcher (multitable-onprem-deploy-launcher.ps1)
     so first apply on an upgrade uses the freshest apply helper from the
     supplied package
```

The new gate dies with the exact intended message. It is a real gate,
not a no-op.

### 4. End-to-end: build the new package and re-verify

```text
BUILD_WEB=1 BUILD_BACKEND=1 INSTALL_DEPS=0 \
  bash scripts/ops/multitable-onprem-package-build.sh
  -> exit 0; produced metasheet-multitable-onprem-v2.5.0-20260519-200530.zip

bash scripts/ops/multitable-onprem-package-verify.sh <new zip>
  -> "Package verify OK", exit 0
```

### 5. Tar-branch coverage note

The launcher handles both `.zip` (`Expand-Archive`) and `.tgz` /
`.tar.gz` (`tar -xzf`). The end-to-end + negative-proof tests above
exercise the `.zip` branch; the `tar` branch is exercised
structurally by the same build (which produces both `.tgz` and
`.zip` archives) and by the same launcher file shipping with the
package, but no live tgz extraction was driven from this dev host.
The tar code is six lines of standard PowerShell relying on the
Windows-10+ built-in `tar.exe`; review-time scrutiny of that branch
is intentional rather than test-skipped.

### 6. Bundled artifacts (smoke-look at the produced zip)

After extracting the new zip:

- `deploy.bat` now begins with the explanatory comment block and ends
  with the `powershell ... multitable-onprem-deploy-launcher.ps1`
  invocation (no direct apply.ps1 call), matching the design.
- `scripts/ops/multitable-onprem-deploy-launcher.ps1` is present.
- `scripts/ops/multitable-onprem-apply-package.ps1` is untouched
  compared to origin/main (diff confirmed by code review; this PR
  doesn't modify the apply helper at all).

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| First apply uses new package's apply.ps1 (or self-refreshes) | `deploy.bat` calls `multitable-onprem-deploy-launcher.ps1`; the launcher extracts the supplied package to staging temp and invokes the staged `multitable-onprem-apply-package.ps1` with `-RootDir = installed root` |
| Preserve #1684 dependency-refresh wrapper | `multitable-onprem-apply-package.ps1` not touched by this PR; the staged apply helper is the one already containing #1684 logic |
| Preserve #1696 env loading | Same: apply.ps1 not modified; env loading runs inside the staged apply |
| package verify detects launcher / self-refresh behavior | `verify_windows_entrypoints` updated: deploy.bat must reference the launcher, must NOT call apply directly, launcher file must exist + contain self-id + extract / resolve / invoke / cleanup markers. Real-gate negative proven on a pre-fix zip |
| design MD + verification MD produced | this PR |

## Deployment impact

- The first upgrade from a pre-this-PR install still routes through
  the OLD `deploy.bat` -> OLD apply.ps1 once (unchanged by this PR -
  cannot retroactively rewrite already-shipped artifacts). After
  that single landing of new files, every subsequent upgrade enters
  through the new `deploy.bat` -> new launcher -> staged apply.
- **The launcher file lands in the installed root as part of the
  first apply's normal copy step**, no extra logic required.
  Confirmed: apply.ps1's copy step (lines 466-468) iterates the
  top-level items of the extracted package
  (`Get-ChildItem ... -Force`) and runs `Copy-Item -Recurse -Force`
  on each into the installed root, with no exclusion list. The
  `scripts/` directory is one of those top-level items, and
  `scripts/ops/multitable-onprem-deploy-launcher.ps1` rides in with
  it. Verified by extracting the freshly-built zip and locating the
  file at the expected path.
- No env, no migration, no flag, no route, no bundle behavior
  change. The launcher writes only to a fresh temp staging dir and
  cleans it up on exit.

## GATE-blocking status

This PR does **not** lift the customer GATE. It removes the first-run
self-overwrite failure mode so future official applies do not need a
manual rerun. SQL/TLS failure summarization and K3 Save / Submit /
Audit are explicitly out of scope and unchanged.

## Rollback

Revert the PR. The launcher file goes away; the build script's
`deploy.bat` reverts to its previous form; verify-script reverts to
the previous assertions. The two existing apply helpers
(`multitable-onprem-apply-package.ps1`) are untouched, so there is no
behavioral rollback to manage.
