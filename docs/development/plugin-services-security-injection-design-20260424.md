# Plugin Services Security Injection Design — 2026-04-24

## Context

`PluginServices.security` is declared as a required runtime service in `packages/core-backend/src/types/plugin.ts`, but the active CommonJS plugin runtime path in `MetaSheetServer.createPluginContext()` only injected notification, automation registry, RBAC provisioning, and platform app instance services.

That meant a plugin written against the published type contract could pass TypeScript but receive `context.services.security === undefined` at runtime.

This is the last kernel gap recorded by `plugins/plugin-integration-core/SPIKE_NOTES.md` after the plugin route and communication teardown fixes.

## Decision

Add a small host-backed adapter: `packages/core-backend/src/security/plugin-runtime-security-service.ts`.

The adapter is intentionally not a direct `SecurityServiceImpl` singleton:

- `SecurityServiceImpl` creates a cleanup timer and needs explicit lifecycle cleanup.
- Without an injected key, `SecurityServiceImpl` uses a process-random encryption key, which is unsafe for persisted plugin credentials.
- The runtime need for M1 integration-core is stable credential encryption, not VM sandbox execution.

Instead, `PluginRuntimeSecurityService` reuses the existing platform secret helpers from `security/encrypted-secrets.ts`:

- `encrypt()` returns the existing `enc:` AES-256-GCM storage format.
- `decrypt()` accepts `enc:` values and preserves the existing plaintext passthrough behavior.
- Per-call custom encryption keys are rejected explicitly to avoid introducing a second plugin-local key semantic.
- `hash()`, `verify()`, `verifyHash()`, `generateToken()`, audit log, rate-limit, resource monitoring, and threat scanning are implemented in-memory.
- `createSandbox()` returns a safe runtime stub whose `execute()` rejects with a clear error; the CJS runtime does not claim VM sandbox execution support.

## Runtime Wiring

`MetaSheetServer` now owns one `PluginRuntimeSecurityService` instance:

```ts
private pluginRuntimeSecurityService = new PluginRuntimeSecurityService()
```

`createPluginContext()` injects it into:

```ts
context.services.security
```

This keeps the fix scoped to the active CJS plugin path and does not change the enhanced plugin service factory path.

## Compatibility

`plugin-integration-core` keeps its current self-contained `v1:` credential-store format for now. The new host service creates a safe migration target for M1, but the migration should be backward-compatible:

- Read old `v1:` values.
- Write new `enc:` values through `context.services.security`.
- Avoid one-shot destructive rewrites until staging has a credential migration plan.

## Deferred

- Full VM sandbox execution remains out of scope for this runtime adapter.
- Production fail-fast for missing `ENCRYPTION_KEY` / `ENCRYPTION_SALT` is not introduced here because existing platform helpers currently fall back to defaults; changing that would be a broader operational behavior change.
- Migrating `plugin-integration-core/lib/credential-store.cjs` from `v1:` to `enc:` is left for M1.
