# Data Factory #1526 Gate Contract Install Entry Verification - 2026-05-18

## Scope

This verifies the generated on-prem package root `INSTALL.txt` exposes the GATE
contract template initializer added by #1634.

Stage 1 Lock status: held. The change is packaging/docs only and does not touch
integration-core runtime, migrations, APIs, adapters, pipelines, or K3 behavior.

## Local Verification

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `pnpm verify:integration-k3wise:gate-contract` | 5/5 PASS |
| `pnpm verify:integration-k3wise:delivery` | 14/14 PASS |
| `PACKAGE_TAG=gate-install-entry-local INSTALL_DEPS=1 BUILD_WEB=1 BUILD_BACKEND=1 scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-gate-install-entry-local.zip` | Package verify OK |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-gate-install-entry-local.tgz` | Package verify OK |

## Package Verification Plan

After building a local package, run:

```bash
scripts/ops/multitable-onprem-package-verify.sh <package.zip-or-tgz>
```

The verifier must pass these new checks against packaged `INSTALL.txt`:

- `--init-template` is present;
- `8 redacted` is present.

The first check proves the package landing file exposes the safer first command.
The second proves the text describes what the initializer writes, so operators
know they should receive the packet plus 8 sample skeletons.

The local package build used `INSTALL_DEPS=1`, `BUILD_WEB=1`, and
`BUILD_BACKEND=1`; both generated package formats passed the verifier. Tracked
nested `node_modules` symlink drift from `pnpm install` was restored after the
package smoke, so no dependency artifacts are part of this PR.

## Expected Operator Result

From the package root, an operator can now discover the full sequence without
opening GitHub:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <safe-dir>
node scripts/ops/integration-k3wise-gate-contract-check.mjs --input <contract.json> --out-dir <art>
```

The generated template still returns `GATE_BLOCKED` until customer answers and
redacted samples are filled outside Git; this PR does not lift the customer
GATE.
