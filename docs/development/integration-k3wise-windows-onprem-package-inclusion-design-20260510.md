# Design: K3 WISE Operator Tooling in the Multitable On-Prem Package

**Date**: 2026-05-10
**Files**:
- `scripts/ops/multitable-onprem-package-build.sh` (modified — `REQUIRED_PATHS` + `INSTALL.txt` block)

---

## Problem

The K3 WISE PoC operator tooling shipped over PRs #1433 / #1437 / #1442 /
#1445 / #1447 — the on-prem preflight script, the live PoC packet builder,
the evidence compiler, the postdeploy smoke + summary, the mock fixtures,
and the three K3 operator runbooks — all live in `scripts/ops/` and
`docs/operations/`. None of them are included in the Multitable On-Prem
delivery package built by `scripts/ops/multitable-onprem-package-build.sh`.

A Windows on-prem customer running the K3 PoC therefore would not have the
preflight / GATE-packet / evidence tooling on the deployed box — they would
need a separate `git clone` of the repo, which contradicts the package's
stated goal ("deliver a full-app package without requiring `git pull` on
the target host", per `docs/deployment/multitable-onprem-package-layout-20260319.md`).

## Goal

Add the K3 WISE **operator tooling** (scripts + fixtures + runbooks) to the
package's `REQUIRED_PATHS` manifest so a Windows on-prem customer doing the
K3 PoC has the C1 / C2 / C3 preflight, the live PoC packet builder, the
evidence compiler, the postdeploy smoke, and the three runbooks on the box.

Explicitly scoped (option A, chosen 2026-05-10): operator tooling only. The
backend-side plugin (`plugins/plugin-integration-core`) is **not** added —
that would activate the integration-core战线 in the shipped package before
customer GATE PASS, which sits in a Stage-1-Lock gray area. The on-prem
backend in the package (`packages/core-backend/dist`) continues to ship
only `plugin-attendance`; the `metadata.json`'s `includedPlugins`
unchanged.

## Non-goals

- New runtime / script behaviour. The build script gains nine new manifest
  entries and an `INSTALL.txt` block; no new code.
- Adding `plugins/plugin-integration-core` to the package. Out of scope —
  see above.
- Making `run-mock-poc-demo.mjs` runnable on the customer box. It is
  bundled (as part of the `scripts/ops/fixtures/integration-k3wise` dir)
  only so the on-prem preflight's `fixtures.k3wise-mock` file-existence
  check passes; it imports `plugins/plugin-integration-core/lib/adapters/*.cjs`
  via `createRequire` and will fail with a module-not-found error if invoked
  from the package. The live PoC sequence (C2 onward) — the actual operator
  workflow on a customer box — does not need the mock chain. This limitation
  is documented in the build script's comment block and in `INSTALL.txt`.
- Updating the on-prem preflight runbook (`k3-poc-onprem-preflight-runbook.md`)
  with a footgun row about `run-mock-poc-demo.mjs` requiring a dev checkout.
  That is a small follow-up doc PR if desired; this PR keeps the surface to
  the build script alone.

## Design

### `REQUIRED_PATHS` additions (9 entries)

Inserted after the `multitable-onprem-*` ops scripts, before the
`docker/` config block, behind an explanatory comment:

| Entry | Role in the K3 PoC flow |
|---|---|
| `scripts/ops/integration-k3wise-onprem-preflight.mjs` | C1 (mock readiness) / C2 (`--live` against customer K3) |
| `scripts/ops/integration-k3wise-live-poc-preflight.mjs` | C3 — builds the Save-only live PoC packet from the GATE answer JSON; also `--print-sample` for the GATE schema |
| `scripts/ops/integration-k3wise-live-poc-evidence.mjs` | C10 — compiles live PoC evidence into PASS / PARTIAL / FAIL |
| `scripts/ops/integration-k3wise-postdeploy-smoke.mjs` | post-deploy authenticated control-plane smoke |
| `scripts/ops/integration-k3wise-postdeploy-summary.mjs` | renders the postdeploy smoke evidence into a signoff summary |
| `scripts/ops/fixtures/integration-k3wise` (dir) | `gate-sample.json`, `evidence-sample.json`, `mock-k3-webapi-server.mjs`, `mock-sqlserver-executor.mjs`, `run-mock-poc-demo.mjs` (+ their `.test.mjs`), `README.md` — satisfies the preflight's `fixtures.k3wise-mock` check |
| `docs/operations/k3-poc-onprem-preflight-runbook.md` | per-check fix recipes for the on-prem preflight |
| `docs/operations/integration-k3wise-internal-trial-runbook.md` | post-deploy auth smoke + host-shell mint pattern |
| `docs/operations/integration-k3wise-live-gate-execution-package.md` | C0–C10 sequence + customer GATE field list (A.1–A.6) |

`copy_path()` already handles directory entries (`cp -R`), so the fixtures
dir is a single entry. The build script's pre-package guard
(`[[ -e "${ROOT_DIR}/${rel}" ]] || die "Required file missing before packaging"`)
runs against every entry; all nine resolve on `origin/main` at this commit
(verified — see verification MD §2).

### `INSTALL.txt` block

A new "K3 WISE PoC operator tools" block listing the three primary
commands (preflight, packet builder, evidence compiler) and the three
runbook paths. Mirrors the existing "Server-side apply helpers" block in
style.

### What this does NOT change

- `metadata.json` — `includedPlugins` stays `["plugin-attendance"]`,
  `productMode` stays `platform`. No new plugin is shipped.
- `multitable-onprem-package-verify.sh` — has no expected-paths list, so
  nothing to add there.
- `multitable-onprem-release-gate.test.mjs` — does not assert on package
  contents, so no test change.
- Any CI workflow. `.github/workflows/multitable-onprem-package-build.yml`
  runs the build script unchanged; the new manifest entries are picked up
  automatically.

## Affected files

| File | Change |
|---|---|
| `scripts/ops/multitable-onprem-package-build.sh` | 9 new `REQUIRED_PATHS` entries + an 8-line explanatory comment + a ~13-line `INSTALL.txt` block. +30 lines, no deletions. |

No source code change. No CI workflow change. No `.gitignore` change. No
plugin added to the package.

## Deployment impact

The next run of the `Multitable On-Prem Package Build` workflow (or the
local `pnpm build:multitable-onprem-package`) will include the nine K3
paths in the `.tgz` / `.zip` outputs. Existing already-built packages are
unaffected. No change to what the deployed backend loads or runs.

## Customer GATE status

PR is **outside** the GATE block:

- Build-manifest change only; no runtime, no integration-core code.
- `plugins/plugin-integration-core` deliberately not added — keeps the
  integration-core战线 out of the shipped package until customer GATE PASS,
  consistent with the Stage 1 Lock memory.
- The bundled K3 tooling is operator-facing preflight / packet-builder /
  evidence tooling — 内核打磨 / delivery readiness, permitted under
  Stage 1 Lock.
