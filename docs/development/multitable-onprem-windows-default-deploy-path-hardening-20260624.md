# Multitable on-prem Windows default deploy-path hardening (2026-06-24)

## Scope

This slice addresses the deployment-path caveat reported during the FOS-4b-3
sandbox validation on the entity machine:

- default `.zip` deploy failed before dependency refresh in the PowerShell
  extraction step;
- default `.tgz` deploy failed under the default staging path with a Windows
  path-length issue;
- the short-staging launcher workaround succeeded.

This is deployment tooling only. It does not change FOS apply behavior, K3
behavior, external writes, production writes, option sync semantics, or database
schema.

## Change

Windows PowerShell deploy helpers now default to a short local staging root when
no explicit staging override is supplied:

```text
C:\ms-tmp
```

`METASHEET_ONPREM_STAGING_ROOT` remains the explicit override for hosts that
need a different short local path.

Zip extraction in both Windows deploy helper layers now uses
`System.IO.Compression.ZipFile.ExtractToDirectory(...)` instead of
`Expand-Archive`, matching the package verifier's Windows zip smoke. `.tgz` /
`.tar.gz` extraction continues to use `tar`, but now benefits from the same
short default staging base.

## Guardrails

- The self-bootstrapping launcher still invokes the apply helper from inside
  the staged package, not the installed root.
- The apply helper still refreshes dependencies, runs migrations, restarts PM2,
  and performs healthchecks exactly as before.
- The package verifier now rejects packages whose Windows helpers fall back to
  `Expand-Archive` or omit the built-in short staging default.
- Package metadata records both the override env
  (`METASHEET_ONPREM_STAGING_ROOT`) and the default staging root (`C:\ms-tmp`).

## Verification

Run:

```text
node --test scripts/ops/onprem-windows-system-hardening.test.mjs
node --test scripts/ops/multitable-onprem-package-no-node-modules.test.mjs
bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
```

For a full package proof, build a package and verify both archive types:

```text
BUILD_WEB=0 BUILD_BACKEND=0 INSTALL_DEPS=0 PACKAGE_TAG=windows-default-staging-smoke \
  scripts/ops/multitable-onprem-package-build.sh

scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-windows-default-staging-smoke.zip

scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-windows-default-staging-smoke.tgz
```

Entity-machine verification is still required to close the operational caveat on
the exact Windows host. The expected result is:

```text
zipDefaultDeployExit=0
tgzDefaultStagingDeployExit=0
shortStagingWorkaroundNoLongerRequired=true
```

This follow-up is independent of the FOS-4b-3 production apply gate. Production
apply remains closed.
