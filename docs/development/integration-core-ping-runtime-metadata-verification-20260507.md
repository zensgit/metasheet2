# Integration Core Ping Runtime Metadata Verification - 2026-05-07

## Local Verification

Worktree:

`/private/tmp/ms2-http-status-capabilities`

Branch:

`codex/integration-http-status-capabilities-20260507`

Baseline:

`origin/main` at `02cee56861e18c88f67a3b49366cc29e2b6e3ffd`

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

- communication `ping().version` follows `plugin.json`.
- communication `ping().phase` is `integration-core-mvp`.

Updated `host-loader-smoke.test.mjs` to verify the same metadata through the
real `PluginLoader` activation path.

## Environment Note

The temporary worktree initially lacked local `node_modules`, so tests that load
`tsx` could not start. After `pnpm install --frozen-lockfile`, the host-loader
and full plugin test commands completed successfully.
