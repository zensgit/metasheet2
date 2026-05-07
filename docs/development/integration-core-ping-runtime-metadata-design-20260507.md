# Integration Core Ping Runtime Metadata Design - 2026-05-07

## Context

After the runtime status refresh, `GET /api/integration/health` and
`communication.call('integration-core', 'getStatus')` report the current
integration-core version and phase. The lightweight communication `ping()`
method still returned only `ok`, `plugin`, and `ts`.

That made plugin startup probes choose between:

- using `ping()` and losing version/phase context, or
- calling full `getStatus()` just to confirm runtime identity.

## Change

`ping()` now returns:

```json
{
  "ok": true,
  "plugin": "plugin-integration-core",
  "version": "0.1.0",
  "phase": "integration-core-mvp",
  "ts": 1234567890
}
```

The method remains intentionally lightweight. It does not include the full
capability object because `getStatus()` is still the readiness and diagnostics
surface.

## Compatibility

This is additive. Existing callers that only check `ok`, `plugin`, or `ts`
continue to work.

## Files Changed

- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs`
- `plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs`
- `docs/development/integration-core-ping-runtime-metadata-design-20260507.md`
- `docs/development/integration-core-ping-runtime-metadata-verification-20260507.md`
