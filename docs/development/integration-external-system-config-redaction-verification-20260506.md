# Integration External System Config Redaction Verification - 2026-05-06

## Commands

```bash
pnpm -F plugin-integration-core test:external-systems
pnpm -F plugin-integration-core test:payload-redaction
git diff --check
```

## Result

- `external-systems`: registry + credential boundary tests passed.
- `payload-redaction`: sensitive key redaction tests passed.
- `git diff --check`: passed.

## Coverage Added

- Public `upsertExternalSystem()` redacts config `accessToken`, nested `password`, and `headers.Authorization`.
- Public `listExternalSystems()` redacts sensitive config fields.
- Public `getExternalSystem()` redacts sensitive nested config fields.
- `getExternalSystemForAdapter()` still returns raw config and decrypted credentials for adapter execution.

## Residual Risk

The redaction dictionary is key-based. Unknown vendor-specific secret field names that do not normalize to the existing sensitive-key set may still need to be added as they appear in live vendor fixtures.

