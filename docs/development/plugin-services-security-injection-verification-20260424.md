# Plugin Services Security Injection Verification — 2026-04-24

## Scope

Verify that the active `MetaSheetServer` CommonJS plugin runtime injects a usable `context.services.security` service and that the adapter does not regress the previously fixed runtime teardown path.

## Commands Run

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-security.test.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-security.test.ts tests/unit/plugin-runtime-teardown.test.ts --reporter=dot
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
```

## Results

- `plugin-runtime-security.test.ts`: 3/3 passed.
- Backend TypeScript compile: passed.
- Runtime security + teardown regression: 6/6 passed.
- `plugin-integration-core` package tests: passed.
- Plugin manifest validation: 13 valid, 0 invalid. Existing warnings remain unrelated.

## Covered Behaviors

- Real activation path injects `context.services.security`.
- `encrypt()` returns an `enc:` payload.
- `decrypt()` round-trips `enc:` payloads.
- Plaintext decrypt passthrough remains compatible with existing helper behavior.
- Tampered encrypted payloads throw.
- Per-call custom encryption keys are rejected explicitly.
- `hash()` and `verify()` work through the injected runtime service.
- Threat scanning detects critical `require()` and `process.*` usage.
- Threat scans write audit events retrievable by plugin and event filter.
- Rate-limit helper allows first request and rejects the second over limit.
- `createSandbox()` registers a sandbox record, validates allowed API prefixes, and rejects code execution explicitly.
- `destroy()` on the sandbox removes it from the service registry.

## Follow-Up

- Migrate `plugin-integration-core` credential-store to host-backed `services.security` in a separate M1 slice with backward-compatible `v1:` reads.
