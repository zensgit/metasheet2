# Integration Core PR2 Adapter Shared File Slicing Design - 2026-04-25

## Context

PR2 introduces the plugin-local adapter contract and the generic HTTP adapter.
It should build on PR1 external systems, but it should not include pipeline,
REST control plane, K3 WISE, PLM, or ERP feedback code.

The current working tree is stacked beyond PR2, so the main risk is again in
shared runtime files:

```text
plugins/plugin-integration-core/index.cjs
plugins/plugin-integration-core/package.json
plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs
plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs
```

## PR2-Owned Files

Include these new files:

```text
plugins/plugin-integration-core/lib/contracts.cjs
plugins/plugin-integration-core/lib/adapters/http-adapter.cjs
plugins/plugin-integration-core/__tests__/adapter-contracts.test.cjs
plugins/plugin-integration-core/__tests__/http-adapter.test.cjs
docs/development/integration-core-adapter-contracts-design-20260424.md
docs/development/integration-core-adapter-contracts-verification-20260424.md
```

## Shared-File Include Rules

### `index.cjs`

Include:

- `createAdapterRegistry`.
- `createHttpAdapterFactory`.
- module state: `adapterRegistry`.
- `getStatus().adapters`.
- communication method: `listAdapterKinds()`.
- activation wiring:

```js
adapterRegistry = createAdapterRegistry({ logger })
  .registerAdapter('http', createHttpAdapterFactory())
```

- deactivate cleanup: `adapterRegistry = null`.
- milestone may move to an adapter-contract milestone such as
  `M1-adapter-contracts`.

Exclude:

- Yuantus PLM wrapper registration.
- K3 WISE WebAPI or SQL Server adapter registration.
- pipeline registry.
- dead-letter, watermark, run-log, runner.
- ERP feedback writer.
- integration REST route registration beyond health.
- pipeline CRUD, run, dry-run, dead-letter replay communication methods.

### `package.json`

Include:

```text
test:adapter-contracts
test:http-adapter
```

The main `test` script may include those two tests once PR2 lands.

Exclude later scripts until their own PRs land:

```text
test:pipelines
test:transform-validator
test:runner-support
test:pipeline-runner
test:http-routes
test:k3-wise-adapters
test:erp-feedback
test:plm-yuantus-wrapper
test:e2e-plm-k3wise-writeback
test:payload-redaction
```

### Shared Smoke Tests

The shared smoke tests should remain generic:

- require the health route and communication namespace.
- require PR1 external-system communication methods.
- if `getStatus().adapters` is non-empty, require `listAdapterKinds()` and
  assert it equals `getStatus().adapters`.
- do not hard-code `['http']` in the generic smoke tests.
- do not assert K3, PLM, pipeline, runner, REST route count, or ERP feedback in
  the generic smoke tests.

The exact `http` adapter behavior is covered by `adapter-contracts.test.cjs`
and `http-adapter.test.cjs`.

For a PR2-only branch, add a PR2-specific assertion that the runtime adapter
list includes exactly `http` if the branch does not already have another focused
runtime wiring check. Keep that assertion local to PR2 staging so later stacked
branches can extend the list without rewriting the generic smoke contract.

## Runtime Boundary

PR2 may expose the adapter registry through status and communication, but it
must not execute adapter reads or writes from runtime routes. Execution belongs
to the later runner and REST control-plane slices.

## Verification Strategy

For the current stacked working tree:

```bash
pnpm -F plugin-integration-core test:adapter-contracts
pnpm -F plugin-integration-core test:http-adapter
pnpm -F plugin-integration-core test:runtime
pnpm -F plugin-integration-core test:host-loader
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

For a PR2-only branch after hunk staging:

```bash
pnpm -F plugin-integration-core test:adapter-contracts
pnpm -F plugin-integration-core test:http-adapter
pnpm -F plugin-integration-core test:runtime
pnpm -F plugin-integration-core test:host-loader
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

## Notes

- Do not include `output/delivery/*` or `docs/development/parallel-delivery-*`.
- Do not include K3 WISE or PLM adapter files in PR2.
- Do not include the pipeline runner or REST control-plane files in PR2.
