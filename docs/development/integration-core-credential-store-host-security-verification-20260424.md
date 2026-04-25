# Integration Core Credential Store Host Security Verification — 2026-04-24

## Scope

Verify the M1 credential-store migration for `plugin-integration-core`:

- New writes use host `context.services.security` and produce `enc:` values.
- Existing `v1:` values remain readable.
- Legacy fallback behavior remains intact when no host security service exists.
- Plugin activation reports the host-backed credential-store mode without exposing secrets.

## Commands Run

```bash
pnpm -F plugin-integration-core test
node plugins/plugin-integration-core/__tests__/credential-store.test.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-security.test.ts --reporter=dot
node --import tsx scripts/validate-plugin-manifests.ts
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-security.test.ts tests/unit/plugin-runtime-teardown.test.ts --reporter=dot
```

## Results

- `plugin-integration-core` package tests: passed.
- `credential-store.test.cjs`: 10 scenarios passed.
- Backend runtime security focused test: 3/3 passed.
- Plugin manifest validation: 13 valid, 0 invalid. Existing warnings remain unrelated.
- Backend TypeScript compile: passed.
- Runtime security + teardown regression: 6/6 passed.

## Coverage

- Dev fallback still creates `v1:` values with a warning.
- Production without host security and without `INTEGRATION_ENCRYPTION_KEY` still refuses to create a legacy store.
- Production legacy env key still round-trips multiple payloads.
- Legacy `v1:` tamper and malformed ciphertext rejection still work.
- Host-backed mode delegates `encrypt/decrypt/hash` to `services.security`.
- Host-backed mode writes `enc:` values.
- Host-backed mode decrypts old `v1:` payloads without calling host decrypt.
- Bad host security service shape is rejected.
- `plugin-runtime-smoke` and `host-loader-smoke` both assert `getStatus().credentialStore` is `{ source: 'host-security', format: 'enc' }`.

## Notes

`pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-security.test.ts --reporter=dot` logs local database connection warnings because this machine has no default `chouhua` Postgres database. The target test file still passes.

## Not Covered

- Applying migration 057 against a live Postgres instance.
- Real admin UI/API credential writes, because that API is not part of this slice.
- Bulk migration of existing `v1:` rows.
