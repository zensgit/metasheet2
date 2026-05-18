# Data Factory issue #1526 GATE contract package verification - 2026-05-18

Companion to
`docs/development/data-factory-issue1526-gate-contract-package-verify-design-20260518.md`.

## Verification matrix

| Check | Evidence | Result |
| --- | --- | --- |
| Stage 1 Lock held | Diff is limited to package build/verify scripts and docs. No `plugins/plugin-integration-core`, migration, backend route/API, or frontend runtime files. | PASS |
| Build manifest includes checker | `multitable-onprem-package-build.sh` `REQUIRED_PATHS` includes `scripts/ops/integration-k3wise-gate-contract-check.mjs`. | PASS |
| Build manifest includes customer manifests | `REQUIRED_PATHS` includes WebAPI read/list and relationship mapping customer sample manifests. | PASS |
| Package verifier requires checker | `multitable-onprem-package-verify.sh` required content list includes the checker script. | PASS |
| Package verifier checks checker semantics | Verifier asserts the packaged checker still contains `READ_ANSWER_IDS`, `RELATIONSHIP_ANSWER_IDS`, `GATE_BLOCKED`, and `SECRET_QUERY_PATTERN`. | PASS |
| Package verifier checks manifest wiring | Verifier asserts the packaged manifests point operators at `integration-k3wise-gate-contract-check.mjs` and contain O/R answer IDs. | PASS |
| Local checker regression | `pnpm verify:integration-k3wise:gate-contract` remains green. | PASS |
| Generated package proof | Local package build plus package verify passes against the generated zip and tgz. | PASS |

## Commands run

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
pnpm verify:integration-k3wise:gate-contract
pnpm install --frozen-lockfile
PACKAGE_TAG=issue1526-gate-package-local INSTALL_DEPS=0 BUILD_WEB=1 BUILD_BACKEND=1 \
  scripts/ops/multitable-onprem-package-build.sh
scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-issue1526-gate-package-local.zip
scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-issue1526-gate-package-local.tgz
git diff --check origin/main...HEAD
```

Note: the local package proof used `BUILD_WEB=1 BUILD_BACKEND=1` in the clean
temporary worktree because `apps/web/dist` and `packages/core-backend/dist` were
not already present there.

## Expected command results

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `pnpm verify:integration-k3wise:gate-contract` | PASS |
| `pnpm install --frozen-lockfile` | PASS |
| `PACKAGE_TAG=issue1526-gate-package-local ... BUILD_WEB=1 BUILD_BACKEND=1 ... package-build.sh` | PASS |
| `multitable-onprem-package-verify.sh <generated zip>` | PASS |
| `multitable-onprem-package-verify.sh <generated tgz>` | PASS |
| `git diff --check origin/main...HEAD` | PASS |

## Deployment impact

No runtime deployment behavior changes. The only deploy impact is stricter
package verification: packages that omit the GATE checker or its customer
manifests now fail before installation.

## GATE status

Customer GATE is still blocking runtime work. This change only makes the future
GATE packet validation available from the bridge/on-prem package.
