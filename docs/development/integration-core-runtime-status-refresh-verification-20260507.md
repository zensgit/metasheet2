# Integration Core Runtime Status Refresh Verification - 2026-05-07

## Local Verification

Worktree:

`/private/tmp/ms2-comm-status-refresh`

Branch:

`codex/integration-comm-status-refresh-20260507`

Baseline:

`origin/main` at `8d3e5df1f5b7b4f7f4673e82d0c0eb0f9da790ec`

Commands:

```bash
node plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs
pnpm install --frozen-lockfile
node --import tsx plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs
pnpm -F plugin-integration-core test
pnpm validate:plugins
git diff --check
```

Results:

- `plugin-runtime-smoke`: passed.
- `pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `host-loader-smoke`: passed.
- `pnpm -F plugin-integration-core test`: passed.
- `pnpm validate:plugins`: 13/13 valid, 0 errors.
- `git diff --check`: passed.

## Regression Coverage

Updated `plugin-runtime-smoke.test.cjs` to verify:

- health `version` follows `plugin.json`.
- health `phase` and `milestone` are `integration-core-mvp`.
- health `capabilities` reports registry, runner, and dead-letter replay
  readiness.
- communication `getStatus()` version follows `plugin.json`.
- communication `getStatus()` phase and milestone are `integration-core-mvp`.
- communication `getStatus().capabilities` mirrors the existing flat readiness
  fields.

Updated `host-loader-smoke.test.mjs` to verify the same phase and capability
fields through the real `PluginLoader` activation path.

## Environment Note

The temporary worktree initially lacked local `node_modules`, so tests that load
`tsx` could not start. After `pnpm install --frozen-lockfile`, the host-loader
and full plugin test commands completed successfully.
