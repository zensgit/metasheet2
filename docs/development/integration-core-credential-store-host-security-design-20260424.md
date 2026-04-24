# Integration Core Credential Store Host Security Design — 2026-04-24

## Context

`plugin-integration-core` originally used a self-contained credential store with AES-256-GCM and an `INTEGRATION_ENCRYPTION_KEY` deployment key. That was necessary while the active CJS plugin runtime did not inject `context.services.security`.

PR #1143 closed the host gap by injecting a `PluginRuntimeSecurityService` whose `encrypt()` and `decrypt()` use the platform `enc:` secret format. The plugin can now stop writing new credentials with its private `v1:` format without breaking already stored rows.

## Decision

`plugins/plugin-integration-core/lib/credential-store.cjs` now supports two modes:

- Host-backed mode: `createCredentialStore({ logger, security })` when `security.encrypt/decrypt` exist.
- Legacy fallback mode: `createCredentialStore({ logger })` when no host security service is available.

Host-backed mode:

- `store.source === 'host-security'`
- `store.format === 'enc'`
- `encrypt()` delegates to `security.encrypt()` and writes `enc:` values.
- `decrypt('enc:...')` delegates to `security.decrypt()`.
- `decrypt('v1:...')` still uses the legacy AES-GCM key path for backward compatibility.
- `fingerprint()` uses `security.hash()` when available and truncates to 16 hex chars.

Legacy fallback mode:

- Keeps the old `v1:<iv>:<tag>:<data>` format.
- Keeps production fail-fast when `INTEGRATION_ENCRYPTION_KEY` is absent.
- Keeps deterministic dev fallback only outside production.

## Runtime Wiring

`plugins/plugin-integration-core/index.cjs` creates the credential store during plugin activation:

```js
credentialStore = createCredentialStore({
  logger,
  security: context.services && context.services.security,
})
```

The communication `getStatus()` method exposes only non-secret operational metadata:

```json
{
  "credentialStore": {
    "source": "host-security",
    "format": "enc"
  }
}
```

No plaintext decrypt API is exposed through HTTP or plugin communication.

## Compatibility

Existing database rows in `integration_external_systems.credentials_encrypted` can contain either:

- `enc:` for new host-backed writes.
- `v1:` for legacy plugin-encrypted values.

The migration comment was updated to make this mixed-format period explicit. A future maintenance migration can re-encrypt `v1:` rows to `enc:` after staging confirms the host-backed path in real pipeline flows.

## Trade-Off

The credential-store API is now async because host `security.encrypt/decrypt/hash` are async. This is a deliberate tightening. There are no production plugin callers yet; tests now await the methods so future DB writes do not accidentally persist unresolved Promises.

## Deferred

- Bulk re-encryption of existing `v1:` rows to `enc:`.
- A pipeline/admin API that writes real external system credentials.
- Production fail-fast for missing platform `ENCRYPTION_KEY` / `ENCRYPTION_SALT`; that belongs to the shared platform secret helper, not this plugin slice.
