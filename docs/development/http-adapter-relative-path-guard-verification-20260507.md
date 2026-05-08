# HTTP Adapter Relative Path Guard - Verification - 2026-05-07

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:http-adapter
```

## Result

Passed.

## Coverage Added

- `testConnection()` rejects absolute HTTP paths.
- `testConnection()` rejects protocol-relative paths.
- `testConnection()` rejects non-HTTP scheme paths.
- `testConnection()` rejects backslash and control-character paths.
- `read()` rejects protocol-relative object paths before fetch.
- `upsert()` rejects scheme-bearing upsert paths before fetch.

## Residual Risk

This protects the generic HTTP adapter. Vendor-specific adapters should keep
their own path guards because their URL composition can differ.
