# Integration External System Config Redaction Development - 2026-05-06

## Context

`integration_external_systems.credentials_encrypted` was already write-only on public reads. The remaining exposure risk was `config`: operators can accidentally place tokens, passwords, authorization headers, or other secrets in adapter config while setting up a third-party ERP, PLM, or database connection.

Public registry responses returned `row.config` directly, so those accidental config secrets could leak through create/list/get API responses.

## Design

- Apply `sanitizeIntegrationPayload()` only in `rowToPublicExternalSystem()`.
- Keep `rowToAdapterExternalSystem()` unchanged so runtime adapters still receive the raw private config they need for connection behavior.
- Reuse the existing redaction dictionary from `payload-redaction.cjs` instead of creating a second sensitive-key list.
- Preserve non-sensitive config fields such as `baseUrl`, request IDs, and visible labels.
- Continue to omit plaintext credentials from all public responses.

## Files Changed

- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/__tests__/external-systems.test.cjs`

## Behavior

- Public create response redacts sensitive config keys.
- Public list response redacts sensitive config keys.
- Public get response redacts sensitive nested config keys.
- Adapter-private load still receives raw config and decrypted credentials.

