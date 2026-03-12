# Federation Integration Status And Offline Contracts

## Scope

This note closes the offline-complete portion of weekly tasks `4` and `7` for the current window:

- add contract fixtures/tests for `PLM query/mutate/detail` and `Athena query/detail`
- make adapter capability visibility explicit for real vs stub integrations

## What Changed

### 1. Integration status endpoint

`GET /api/federation/integration-status`

The endpoint lives in:

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/federation.ts`

It reports adapter runtime visibility separately from business-system registration state. Each item returns:

- `id`
- `implementation`: `real | stub | missing`
- `configured`
- `connected`
- `healthSupported`
- `supportedOperations`
- `systemStatus`
- `baseUrl`
- `authType`

This gives the UI and operators a clear signal when an integration is only backed by a placeholder adapter.

### 2. Clearer stub behavior in the container

Default non-PLM adapters in:

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/di/container.ts`

now expose a richer runtime contract instead of acting like silent empty objects. The stub now has:

- connection lifecycle methods: `isConnected`, `connect`, `disconnect`, `healthCheck`
- runtime visibility: `getRuntimeStatus`
- normalized no-op methods for PLM/Athena style query/mutation calls

This prevents route-level crashes when a stub is injected and makes the status endpoint meaningful.

## Offline Contract Coverage

Fixtures:

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/fixtures/federation/contracts.ts`

Tests:

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/federation.contract.test.ts`

Covered flows:

- `GET /api/federation/integration-status`
- `POST /api/federation/plm/query`
  - `products`
  - `approval_history`
  - `bom_compare`
- `POST /api/federation/plm/mutate`
  - `substitutes_add`
  - `approval_reject`
- `GET /api/federation/plm/products/:id`
- `GET /api/federation/plm/products/:id/bom`
- `POST /api/federation/athena/query`
  - `documents`
- `GET /api/federation/athena/documents/:id`

## Intended Usage

- Daily frontend and backend development should target these normalized federation contracts, not upstream raw payloads.
- Real upstream PLM/Athena validation still belongs in later integration and regression runs.
- The integration-status endpoint should be treated as the canonical runtime signal for "real adapter vs stub adapter" visibility.
