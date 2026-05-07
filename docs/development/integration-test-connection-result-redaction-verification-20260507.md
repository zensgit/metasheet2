# Integration Test Connection Result Redaction - Verification - 2026-05-07

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:http-routes
```

## Result

Passed.

## Coverage Added

- Mock adapter returns `raw.credentials.password`, debug `headers`, URL
  credentials, `access_token`, and `Bearer` token text.
- REST response does not include `raw` or debug `headers`.
- Serialized response does not include the raw password, Authorization token, or
  bearer token.
- Response message redacts `access_token` and `Bearer`.
- Persisted status update `lastError` does not contain the secret token text.

## Residual Risk

This PR sanitizes the integration test-connection route. General REST error
detail redaction is tracked separately and should remain a broader API concern.
