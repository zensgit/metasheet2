# Bridge Agent Driver Smoke PowerShell 5.1 Encoding Fix - verification - 2026-05-22

## Trigger

Issue follow-up reported that the packaged
`scripts/ops/bridge-agent-driver-smoke.ps1` from release
`multitable-onprem-bridge-agent-20260521-575261f43` hit a Windows PowerShell
5.1 UTF-8 parsing issue when executed directly from the package.

The operator worked around it with a UTF-8 BOM execution copy. This
verification records the code-side fix that removes the need for that
workaround in future packages.

## Static source checks

Command:

```bash
LC_ALL=C grep -n '[^ -~]' scripts/ops/bridge-agent-driver-smoke.ps1 || true
```

Result:

```text
0 matches
```

The script starts without a BOM and contains only ASCII-safe bytes:

```text
00000000: 2372 6571 7569 7265  #require
```

## Contract tests

Command:

```bash
node --test \
  scripts/ops/bridge-agent-driver-smoke-contract.test.mjs \
  scripts/ops/bridge-agent-readonly-contract.test.mjs
```

Result:

```text
tests 7
pass 7
fail 0
```

Covered assertions:

- driver-smoke script is ASCII-safe for Windows PowerShell 5.1;
- localized SQL login redaction uses `\uXXXX` regex escapes;
- literal CJK regex characters do not reappear in the script;
- package verifier contains the non-ASCII rejection marker;
- existing BA-M1 readonly contract tests still pass.

## Package verifier syntax / diff checks

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
```

Result:

```text
PASS
PASS
```

## Package-level check

The isolated worktree did not install dependencies, so the package build reused
the already-built local `apps/web/dist` and `packages/core-backend/dist`
artifacts from the main checkout to exercise package assembly and verification.
The changed Bridge Agent files and package verifier came from this branch.

Expected command shape:

```bash
INSTALL_DEPS=0 BUILD_WEB=0 BUILD_BACKEND=0 \
  PACKAGE_TAG=bridge-agent-ps51-local \
  scripts/ops/multitable-onprem-package-build.sh

VERIFY_REPORT_JSON=/tmp/ms2-bridge-agent-ps51-zip.verify.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-agent-ps51-zip.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-bridge-agent-ps51-local.zip

VERIFY_REPORT_JSON=/tmp/ms2-bridge-agent-ps51-tgz.verify.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-agent-ps51-tgz.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-bridge-agent-ps51-local.tgz
```

Result:

```text
zip: Package verify OK
tgz: Package verify OK
```

## Secret hygiene

Touched files were scanned for common secret shapes:

- JWT-like values;
- authorization headers;
- raw password assignments;
- raw PostgreSQL userinfo URLs;
- raw access-token URL query values.

Result:

```text
0 matches
```

## Remaining live validation

Because this development host is macOS and does not provide Windows
PowerShell 5.1, the final live check remains an operator-side rerun on the
on-prem Windows bridge host:

```powershell
.\scripts\ops\bridge-agent-driver-smoke.ps1 `
  -Provider SqlClient `
  -Server '<host>' `
  -Database '<db>' `
  -Username '<readonly_user>' `
  -PasswordEnvVar BRIDGE_SMOKE_DB_PASSWORD `
  -OutDir 'C:\metasheet\bridge-evidence'
```

Expected: the packaged script runs directly, without creating a BOM copy, and
still emits redacted JSON/Markdown evidence.

No K3 Save / Submit / Audit should be run for this validation.
