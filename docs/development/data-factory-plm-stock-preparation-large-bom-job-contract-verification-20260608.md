# Data Factory #2342 - large-BOM job contract verification (2026-06-08)

## Scope

This verification covers the latent #2342 large-BOM job contract helper:

- `plugins/plugin-integration-core/lib/stock-preparation-large-bom-jobs.cjs`
- `plugins/plugin-integration-core/__tests__/stock-preparation-large-bom-jobs.test.cjs`

No runtime route, worker, UI, dry-run path, apply path, package, MetaSheet row
write, PLM write, external database write, or K3 path is changed.

## What the helper locks

- C3 background expansion status tokens.
- C4 checkpointed apply status tokens.
- Values-free public evidence projection for background expansion progress.
- Values-free public evidence projection for checkpointed apply progress.
- A small fail-closed guard that only treats `status='completed'` plus
  `authoritative=true` as a future large-BOM applyable expansion artifact.

## Local verification

Commands run:

```sh
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
git diff --check
```

All commands passed.

The full plugin test chain was attempted from the isolated temporary worktree,
but that worktree did not have workspace `node_modules`; it failed before the
new test area at the existing host-loader smoke step with `ERR_MODULE_NOT_FOUND`
for `tsx`. The targeted Node tests above do not require that package and ran
successfully. CI is expected to run the full plugin test chain in the normal
dependency environment.

## Values-free scan

The new helper and test were scanned for project/component-shaped values,
target ids, credentials, bearer tokens, and raw-payload markers. The scan
returned no matches.

## Boundary

This slice is a contract scaffold only. It does not authorize background
expansion runtime, checkpointed apply, or another Apply.
