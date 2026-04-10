# E2E Tests

Browser-level regression tests for federated PLM user journeys.

## Prerequisites

These tests require **three servers running externally**:

1. **Yuantus** on `http://127.0.0.1:7910`
2. **Metasheet backend** on `http://localhost:7778`
3. **Metasheet frontend** on `http://127.0.0.1:8899`

Tests auto-skip if any server is unreachable.

## Quick start

```bash
# Terminal 1: Yuantus
cd /path/to/Yuantus
./.venv/bin/uvicorn yuantus.api.app:create_app --factory --host 127.0.0.1 --port 7910

# Terminal 2: Metasheet backend
cd /path/to/metasheet2/packages/core-backend
PLM_BASE_URL=http://127.0.0.1:7910 PLM_API_MODE=yuantus PLM_TENANT_ID=tenant-1 \
  PLM_ORG_ID=org-1 PLM_USERNAME=phase0-test PLM_PASSWORD=phase0pass PLM_ITEM_TYPE=Part \
  npx tsx src/index.ts

# Terminal 3: Metasheet frontend
cd /path/to/metasheet2/apps/web
npx vite --host 127.0.0.1 --port 8899

# Terminal 4: Run E2E
cd /path/to/metasheet2/packages/core-backend
npx playwright test --config tests/e2e/playwright.config.ts
```

## Test data

Tests use the B demo object:

- Part `b5ecee24-5ce8-4b59-9551-446e1c50b608` (Doc UI Product)
- Has 1 file attachment + 1 AML related document (Doc UI Doc)
- Has 1 ECO (DOCUI-ECO-1768357216, state=progress)

Metasheet user: `phase0@test.local` / `Phase0Test!2026` (role=admin)

## What's tested

- `handoff-journey.spec.ts`: source product → documents → open AML doc → return → roundtrip
