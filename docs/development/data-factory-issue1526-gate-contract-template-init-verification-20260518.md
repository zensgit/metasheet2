# Data Factory #1526 Gate Contract Template Init Verification - 2026-05-18

## Scope

This verification covers the packaged `--init-template` path for
`scripts/ops/integration-k3wise-gate-contract-check.mjs`.

Stage 1 Lock status: held. The change is ops/docs/test only and does not touch
integration-core runtime, migrations, API routes, K3 calls, or pipeline
execution.

## Local Verification

| Command | Result |
| --- | --- |
| `node --check scripts/ops/integration-k3wise-gate-contract-check.mjs` | PASS |
| `node --check scripts/ops/integration-k3wise-gate-contract-check.test.mjs` | PASS |
| `pnpm verify:integration-k3wise:gate-contract` | 5/5 PASS |
| `pnpm verify:integration-k3wise:delivery` | 14/14 PASS |
| `pnpm verify:integration-k3wise:poc` | PASS: 21 preflight tests, 51 evidence tests, 4 fixture tests, 4 mock K3 tests, 12 mock SQL tests, and 9-step mock chain |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `PACKAGE_TAG=gate-template-rebased-local INSTALL_DEPS=0 BUILD_WEB=1 BUILD_BACKEND=1 scripts/ops/multitable-onprem-package-build.sh` | PASS on rebased HEAD |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-gate-template-rebased-local.zip` | Package verify OK |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-gate-template-rebased-local.tgz` | Package verify OK |

The test suite now includes:

- complete packet PASS evidence;
- missing answer/sample `GATE_BLOCKED`;
- absolute endpoint rejection;
- secret-looking sample rejection with raw secret not echoed into evidence;
- template initializer smoke.

## Template Initializer Assertions

The new initializer test runs:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --init-template <tmp-dir>
```

It verifies:

- stdout returns `decision=TEMPLATE_CREATED`;
- exactly eight sample skeletons are listed;
- `k3wise-gate-contract-packet.template.json` is written;
- WebAPI and relationship answers contain `<fill-outside-git>`;
- every referenced sample file exists;
- sample contents do not contain JWT-shaped values, Bearer headers, credentialed
  DB URLs, or secret-looking URL query parameters;
- running the checker against the generated packet exits `2` with
  `decision=GATE_BLOCKED`;
- generated samples are present, while answer counts remain `0/12` and `0/7`.

This proves the generated directory is useful as a fillable handoff scaffold but
cannot accidentally unlock runtime work.

## Operator Workflow

The manifest docs now tell operators to initialize the packet outside Git first:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --init-template /path/outside-git/k3wise-gate-contract
```

After the customer replaces placeholders and redacted sample files, the same
checker is run with `--input` and must return `PASS` before the post-GATE runtime
PR starts.

## Package Verification

The on-prem package verifier was extended to require:

- `--init-template` in the packaged checker;
- `k3wise-gate-contract-packet.template.json` in the checker source;
- initializer documentation in both customer sample manifests;
- this design and verification document in the package.

The first local package build used `INSTALL_DEPS=1`, `BUILD_WEB=1`, and
`BUILD_BACKEND=1` to prove a clean worktree could build from scratch. After
rebasing onto latest `origin/main`, the second package build used
`INSTALL_DEPS=0`, `BUILD_WEB=1`, and `BUILD_BACKEND=1` and verified both the
Windows `.zip` and Linux `.tgz` artifacts. The final generated local package tag
was `gate-template-rebased-local`.

Tracked nested `node_modules` symlink drift from the initial `pnpm install` was
restored; no dependency artifacts are part of this PR.

## Residual Risk

The template cannot prove customer semantics. It only eliminates packet-shape,
filename, and redaction-process mistakes before customer evidence arrives. The
real unlock remains the filled packet returning `PASS` plus the broader customer
GATE PASS.
