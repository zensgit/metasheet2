# HTTP Adapter Query Reserved Guard - Verification - 2026-05-07

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:http-adapter
```

## Result

Passed.

## Coverage Added

- `limit: 50000` is capped to `10000`.
- `options.query.limit = 999999` cannot override the normalized cap.
- `options.query.cursor = "evil-cursor"` cannot override the top-level cursor.
- Non-reserved query keys such as `vendorFlag` still pass through.

## Residual Risk

This protects the generic HTTP adapter read boundary. If a future vendor needs
custom pagination parameter names, those should be modeled explicitly in object
configuration instead of reusing reserved `limit`/`cursor`.
