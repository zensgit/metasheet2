# Integration Core Runtime Status Refresh Design - 2026-05-07

## Context

`plugin-integration-core` has moved beyond the original M0 runtime spike. The
runtime now wires:

- external system registry
- adapter registry
- pipeline registry
- pipeline runner
- ERP feedback writer
- staging installer
- dead-letter list and replay control surface

The health route and communication `getStatus()` payload still reported
`M0-spike`, which is stale and misleading for deployment checks, future frontend
plugins, and operations scripts.

## Change

This slice refreshes the runtime metadata in
`plugins/plugin-integration-core/index.cjs`:

- derive `version` from `plugin.json` instead of a hard-coded string.
- replace the stale `M0-spike` marker with `integration-core-mvp`.
- add `phase` to both health and communication status responses.
- add a shared `capabilities` object to both health and communication status.
- keep the existing flat readiness fields on `getStatus()` for compatibility.

## Response Shape

`GET /api/integration/health` now reports:

```json
{
  "ok": true,
  "plugin": "plugin-integration-core",
  "version": "0.1.0",
  "phase": "integration-core-mvp",
  "milestone": "integration-core-mvp",
  "capabilities": {
    "externalSystems": true,
    "adapters": ["http", "plm:yuantus-wrapper", "erp:k3-wise-webapi", "erp:k3-wise-sqlserver"],
    "pipelines": true,
    "runner": true,
    "erpFeedback": true,
    "deadLetters": true,
    "deadLetterReplay": true,
    "staging": true
  }
}
```

`communication.call('integration-core', 'getStatus')` returns the same phase and
capability object while preserving the previous top-level readiness fields.

## Compatibility

No field was removed. The existing `milestone` key remains present, but now
matches the current runtime phase. Consumers that already read flat booleans
such as `runner`, `staging`, or `deadLetterReplay` continue to work.

## Files Changed

- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs`
- `plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs`
- `docs/development/integration-core-runtime-status-refresh-design-20260507.md`
- `docs/development/integration-core-runtime-status-refresh-verification-20260507.md`
