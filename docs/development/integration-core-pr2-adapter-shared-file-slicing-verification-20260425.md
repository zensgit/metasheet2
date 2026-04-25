# Integration Core PR2 Adapter Shared File Slicing Verification - 2026-04-25

## Scope

Verify that the PR2 adapter-contract slice has a documented split boundary and
that the current stacked implementation still passes targeted and full plugin
checks after the shared smoke tests were made layer-friendly.

## Assertions

- PR2-owned files are documented.
- Shared-file include/exclude rules are documented for `index.cjs`,
  `package.json`, and smoke tests.
- Generic smoke tests do not hard-code `['http']` or the final stacked adapter
  list.
- Generic smoke tests check adapter status self-consistency when adapters are
  present.
- Generic smoke tests do not assert pipeline or runner communication methods.
- Adapter contract tests pass.
- HTTP adapter tests pass.
- Runtime and host-loader smoke tests pass.
- Full plugin tests pass.
- Plugin manifests remain valid.
- The diff has no whitespace errors.

## Commands

```bash
rg -n "PR2-Owned Files|createAdapterRegistry|createHttpAdapterFactory|listAdapterKinds|Exclude|do not hard-code|test:adapter-contracts|test:http-adapter" \
  docs/development/integration-core-pr2-adapter-shared-file-slicing-design-20260425.md

rg -n "comm api adapter kinds match status|status\\.adapters|listAdapterKinds|erp:k3-wise|plm:yuantus-wrapper|\\['http'\\]" \
  plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs \
  plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs \
  docs/development/integration-core-adapter-contracts-verification-20260424.md

pnpm -F plugin-integration-core test:adapter-contracts
pnpm -F plugin-integration-core test:http-adapter
pnpm -F plugin-integration-core test:runtime
pnpm -F plugin-integration-core test:host-loader
pnpm -F plugin-integration-core test

node --import tsx scripts/validate-plugin-manifests.ts

git diff --check
```

## Results

### Document Shape

Passed.

`rg` confirmed the design document includes:

- PR2-owned files.
- `createAdapterRegistry`.
- `createHttpAdapterFactory`.
- `listAdapterKinds`.
- explicit PR3+ exclusions.
- PR2 validation commands for `test:adapter-contracts` and `test:http-adapter`.

### Smoke Test Shape

Passed.

`rg` confirmed:

- generic smoke tests compare adapter status with `listAdapterKinds()`.
- generic smoke tests do not hard-code the final K3/PLM adapter list.
- the adapter-contract verification document now states that a PR2-only branch
  should evaluate to `['http']`, while the generic smoke test remains
  self-consistency based for stacked branches.

After the parallel review, shared smoke tests were further tightened so
pipeline and runner communication assertions are no longer present in generic
runtime smoke files.

### Targeted PR2 Tests

Passed.

Commands:

```bash
pnpm -F plugin-integration-core test:adapter-contracts
pnpm -F plugin-integration-core test:http-adapter
pnpm -F plugin-integration-core test:runtime
pnpm -F plugin-integration-core test:host-loader
```

Results:

- `adapter-contracts`: passed.
- `http-adapter`: passed.
- `plugin-runtime-smoke`: passed.
- `host-loader-smoke`: passed.

### Full Plugin Test Suite

Passed.

Command:

```bash
pnpm -F plugin-integration-core test
```

Result:

- `plugin-runtime-smoke`: passed.
- `host-loader-smoke`: passed.
- `credential-store`: passed, 10 scenarios.
- `db.cjs`: passed.
- `external-systems`: passed.
- `adapter-contracts`: passed.
- `http-adapter`: passed.
- `plm-yuantus-wrapper`: passed.
- `k3-wise-adapters`: passed.
- `erp-feedback`: passed.
- `pipelines`: passed.
- `transform-validator`: passed.
- `runner-support`: passed.
- `payload-redaction`: passed.
- `pipeline-runner`: passed.
- `e2e-plm-k3wise-writeback`: passed.
- `http-routes`: passed.
- `staging-installer`: passed.
- `migration-sql`: passed.

### Manifest Validation

Passed.

Command:

```bash
node --import tsx scripts/validate-plugin-manifests.ts
```

Result:

- found 16 plugin directories.
- 13 manifests valid.
- 0 invalid manifests.
- 0 errors.
- 10 warnings from unrelated existing plugins.
- `plugin-integration-core`: valid.

### Diff Check

Passed.

Command:

```bash
git diff --check
```

Result: no whitespace errors.

## Parallel Review Notes

A read-only parallel review confirmed the PR2 split:

- include only `contracts.cjs`, `http-adapter.cjs`, their tests, and the PR2
  adapter docs.
- in shared files, include only adapter registry wiring, HTTP adapter
  registration, `getStatus().adapters`, `listAdapterKinds()`, PR2 test scripts,
  and adapter self-consistency smoke checks.
- exclude PLM, K3 WISE, pipeline registry, dead-letter, watermark, run-log,
  runner, ERP feedback, REST control plane, and their tests/scripts.
- for a PR2-only branch, add or preserve a focused runtime assertion that the
  adapter list is exactly `['http']`.
