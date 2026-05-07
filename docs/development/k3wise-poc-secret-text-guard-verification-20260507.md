# K3 WISE PoC Secret Text Guard - Verification - 2026-05-07

## Commands

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

## Result

Passed.

## Coverage Added

- Preflight rejects `k3Wise.apiUrl` with URL credentials and `access_token`.
- Preflight rejects `plm.baseUrl` with a signed secret query.
- Evidence rejects `gate.archivePath` containing `access_token`.
- Evidence rejects `requestId` containing a `Bearer` token.
- Existing bool, numeric ID, status synonym, and CLI redaction tests remain
  green.

## Residual Risk

The text detector is intentionally conservative around common secret carriers.
If a customer uses a vendor-specific signed URL format with unusual parameter
names, add that parameter to the detector before accepting it into evidence.
