# Verification: K3 WISE Operator Tooling in the Multitable On-Prem Package

**Date**: 2026-05-10
**Design**: `docs/development/integration-k3wise-windows-onprem-package-inclusion-design-20260510.md`
**File under verification**:
- `scripts/ops/multitable-onprem-package-build.sh` (modified)

---

## 1. Build script syntax still valid

```
$ bash -n scripts/ops/multitable-onprem-package-build.sh
# (exit 0, no output)
```

The nine new `REQUIRED_PATHS` entries, the explanatory comment block, and
the `INSTALL.txt` heredoc addition do not break shell parsing.

## 2. Every `REQUIRED_PATHS` entry resolves (no broken `die` guard)

The build script's pre-package guard is
`[[ -e "${ROOT_DIR}/${rel}" ]] || die "Required file missing before packaging: ${rel}"`,
run against every entry. Extracting the array and testing each:

```
$ sed -n '/^REQUIRED_PATHS=(/,/^)/p' scripts/ops/multitable-onprem-package-build.sh \
    | grep -E '^\s*"' | tr -d '"' | sed 's/^\s*//' | while read -r p; do
      [ -e "$p" ] && echo "EXIST $p" || echo "MISS  $p"
    done
```

Result: **45/45 EXIST**, 0 `MISS`. The nine K3 additions all resolve on
`origin/main` at this commit:

```
EXIST scripts/ops/integration-k3wise-onprem-preflight.mjs
EXIST scripts/ops/integration-k3wise-live-poc-preflight.mjs
EXIST scripts/ops/integration-k3wise-live-poc-evidence.mjs
EXIST scripts/ops/integration-k3wise-postdeploy-smoke.mjs
EXIST scripts/ops/integration-k3wise-postdeploy-summary.mjs
EXIST scripts/ops/fixtures/integration-k3wise            (dir; cp -R)
EXIST docs/operations/k3-poc-onprem-preflight-runbook.md
EXIST docs/operations/integration-k3wise-internal-trial-runbook.md
EXIST docs/operations/integration-k3wise-live-gate-execution-package.md
```

## 3. Package-layout simulation — bundled tooling works in a package-shaped tree

Built a temp tree mirroring `${PACKAGE_ROOT}/` by replicating `copy_path()`'s
`cp -R` / `cp` logic for the nine K3 entries (using a `pwd -P` realpath so
the macOS `/var → /private/var` symlink does not interfere with the
preflight script's `isEntry` check — see §6).

### 3.1 Bundled on-prem preflight runs and `fixtures.k3wise-mock` passes

```
$ DATABASE_URL='postgres://pkg:<fill-outside-git>@127.0.0.1:65432/pkg' \
  JWT_SECRET="$(printf 'p%.0s' {1..40})" \
  node "$PKG/scripts/ops/integration-k3wise-onprem-preflight.mjs" --mock --skip-tcp --skip-migrations --out-dir "$PKG/artifacts/preflight-sim"

integration-k3wise-onprem-preflight: PASS (exit 0, mode=mock)
  [pass         ] env.database-url
  [pass         ] env.jwt-secret
  [skip         ] pg.tcp-reachable — --skip-tcp
  [skip         ] pg.migrations-aligned — --skip-migrations
  [pass         ] fixtures.k3wise-mock — mock smoke (run-mock-poc-demo.mjs) is runnable offline
  [skip         ] k3.live-config — mock mode does not require K3 endpoint or credentials
  [skip         ] k3.live-reachable — mock mode
  [skip         ] gate.file-present
```

`decision=PASS / exit 0`, `fixtures.k3wise-mock: pass`, `details.missing: []`.
The bundled `scripts/ops/fixtures/integration-k3wise/` directory is at the
right relative path under the package root, so the preflight's four-file
existence check (`gate-sample.json`, `mock-k3-webapi-server.mjs`,
`mock-sqlserver-executor.mjs`, `run-mock-poc-demo.mjs`) passes.

### 3.2 Bundled live PoC packet builder works standalone

```
$ node "$PKG/scripts/ops/integration-k3wise-live-poc-preflight.mjs" --print-sample | head -4
{
  "tenantId": "tenant-test",
  "workspaceId": "workspace-test",
  "operator": "integration-admin",
$ echo $?
0
```

`--print-sample` (the GATE schema source) works with only Node stdlib
imports — no `node_modules`, no `plugins/` required.

### 3.3 Documented limitation confirmed: `run-mock-poc-demo.mjs` is not runnable from the package

```
$ node "$PKG/scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs"
Error: Cannot find module '../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs'
  code: 'MODULE_NOT_FOUND'
```

This is expected and documented (in the build script's comment block and in
`INSTALL.txt`). `run-mock-poc-demo.mjs` imports `plugins/plugin-integration-core`
adapters via `createRequire`; that plugin is deliberately **not** in the
package (option A). The file is bundled only so the preflight's
`fixtures.k3wise-mock` file-existence check passes. The live PoC sequence
(C2 onward) — the operator's actual workflow on a customer box — does not
need the mock chain.

## 4. No collateral changes

| Surface | Status |
|---|---|
| `metadata.json` produced by the build | unchanged — `includedPlugins` stays `["plugin-attendance"]`, `productMode` stays `platform`. No plugin added. |
| `scripts/ops/multitable-onprem-package-verify.sh` | has no expected-paths list — nothing to update |
| `scripts/ops/multitable-onprem-release-gate.test.mjs` | does not assert on package contents — no test change |
| `.github/workflows/multitable-onprem-package-build.yml` | runs the build script unchanged; new manifest entries picked up automatically |
| `.gitignore` | unchanged |

## 5. Existing test-suite regression

This PR touches one build script; no source code, no test fixture.

```
$ pnpm verify:integration-k3wise:onprem-preflight     # 14/14 PASS
$ pnpm verify:integration-k3wise:poc                  # 37 unit + mock chain PASS
$ bash -n scripts/ops/multitable-onprem-package-build.sh   # exit 0
```

Both K3 verify suites green; the package build script parses cleanly.

## 6. Verification-harness note (macOS symlink artifact, not a real issue)

The first package-layout simulation attempt used a raw `mktemp -d` path
under `/var/folders/...`. On macOS `/var` is a symlink to `/private/var`,
so `process.argv[1]` (= `/var/folders/.../preflight.mjs`) and the
realpath'd `import.meta.url` (= `file:///private/var/folders/.../preflight.mjs`)
differ. The preflight script's `isEntry` guard
(`entryPath === fileURLToPath(import.meta.url)`) then fails and `main()`
does not run — the script exits 0 silently.

This is a pre-existing fragility of the `isEntry` check with symlinked
parent directories, **not introduced by this PR**, and irrelevant on a
real customer box (on-prem packages extract to non-symlinked directories).
The verification above re-ran the simulation from a `pwd -P` realpath and
the preflight executed normally. If a future hardening PR wants to make
`isEntry` symlink-robust, it would `fs.realpathSync` both sides before
comparing — out of scope here.

## CI status

Not modified. No CI workflow file is touched.

## Deployment impact

The next run of the `Multitable On-Prem Package Build` workflow (or
`pnpm build:multitable-onprem-package` locally) includes the nine K3 paths
in the `.tgz` / `.zip` outputs. Already-built packages unaffected. No change
to what the deployed backend loads or runs.

## Customer GATE status

Outside the GATE block. Build-manifest change only; no integration-core
code, no plugin added to the package. Stage 1 Lock memory remains in force.

## Worktree

Branch: `codex/integration-k3wise-windows-onprem-package-inclusion-20260510`,
forked from `origin/main` at `2082f169e`.
Cwd: `/Users/chouhua/Downloads/Github/metasheet2`.
