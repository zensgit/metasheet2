# On-Prem Package Node Modules Prune Verification (2026-06-17)

## Context

Issue #2720 reported that the C6-5c sandbox package published from `642560126`
could not be applied on the Windows entity machine. The `.zip` failed during
launcher staging extraction and the `.tgz` failed before dependency refresh with
a missing staged path under `packages/mssql-readonly-utils/node_modules`.

The package contract already said `nodeModulesBundled=false`, but the build
script copied workspace package directories with `cp -R`. If a local workspace
package had a pnpm `node_modules` directory or symlink, the archive could carry
that content even though the deploy flow is supposed to refresh dependencies
during apply.

## Change

- `scripts/ops/multitable-onprem-package-build.sh` now prunes copied
  `node_modules` entries immediately after directory copies and sweeps the final
  package root before archive creation.
- `scripts/ops/multitable-onprem-package-verify.sh` now rejects any archive list
  entry matching `(^|/)node_modules(/|$)`.
- The verifier failure is intentionally before any package is considered valid:
  the entity machine must not be the first place this contract is checked.

## Verification

Commands run:

```bash
node scripts/ops/multitable-onprem-package-no-node-modules.test.mjs
node scripts/ops/multitable-onprem-package-verify-k3-helper-contract.test.mjs
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
```

Results:

- `multitable-onprem-package-no-node-modules.test.mjs`: 2 passed.
- `multitable-onprem-package-verify-k3-helper-contract.test.mjs`: 1 passed.
- Shell syntax checks passed.

Negative control:

- A synthesized archive list containing
  `packages/mssql-readonly-utils/node_modules/typescript/package.json` fails
  package verification with `Package must not contain node_modules entries`.

## Boundary

This is package/build verification only. It does not change C6 runtime,
external-write behavior, K3 paths, database permissions, request bodies, or
production/batch rollout state. C6-5c remains blocked until a recut package
deploys cleanly and the entity machine posts the controlled bad-row evidence.
