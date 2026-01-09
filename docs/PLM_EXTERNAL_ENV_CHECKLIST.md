# PLM External Environment Checklist

## Goal
Prepare an external Yuantus PLM environment so MetaSheet integration tests can run without manual fixes.

## Required Inputs
- `PLM_BASE_URL` (e.g. `https://plm.example.com`)
- `PLM_TENANT_ID`
- `PLM_ORG_ID`
- Auth (choose one)
  - `PLM_API_TOKEN` (Bearer token)
  - `PLM_USERNAME` + `PLM_PASSWORD`

## Network Requirements
- MetaSheet host can reach `PLM_BASE_URL` on HTTPS/HTTP.
- `/api/v1/health` returns 200.
- `/api/v1/auth/login` reachable if using username/password.

## Data Prerequisites
Ensure the external PLM environment includes:
- A product with a multi-level BOM (depth >= 2).
- A BOM line with at least one substitute.
- An item that is used by multiple parents (where-used count >= 1).
- Optional but recommended: document attachments + ECO approvals for full UI coverage.

## Environment Template
```bash
export PLM_BASE_URL=https://plm.example.com
export PLM_TENANT_ID=tenant-1
export PLM_ORG_ID=org-1
export PLM_USERNAME=admin
export PLM_PASSWORD=admin
# Optional: isolate seed fixture per environment
# export PLM_SEED_ENV=staging
# Or use a token:
# export PLM_API_TOKEN=...
```

## Verification Scripts
Read-only (preferred for shared envs):
- `scripts/verify-yuantus-plm.sh`
  - Requires: `PLM_ITEM_ID`, `PLM_BOM_ITEM_ID`

Write-enabled (creates sample parts/BOM/substitutes):
- `scripts/verify-plm-bom-tools.sh`
- `scripts/verify-plm-substitutes-mutation.sh`
- `scripts/seed-plm-substitutes-fixture.sh`
  - Uses `PLM_SEED_ENV` to isolate fixtures (`MS-PLM-SUBS-<env>`).
  - Uses `aml/apply` to create parts and BOM relationships.
  - Use only in a test tenant or isolated environment.

UI regression (requires seeded data from BOM tools or manual IDs):
- `scripts/verify-plm-ui-regression.sh`
- `scripts/verify-plm-ui-deeplink.sh`
- `scripts/verify-plm-ui-substitutes-mutation.sh`

Unified regression:
- `scripts/verify-plm-regression.sh`

## CI Notes
- GitHub Actions `smoke-verify` can run PLM regression without external secrets.
- Enable `run_plm_regression=true` to start Yuantus PLM via docker compose, then seed `tenant-1/org-1/admin/admin`.
- Override the seed suffix with `plm_seed_env` (defaults to `ci`).

## Token Retrieval Example
```bash
PLM_API_TOKEN=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -H "x-tenant-id: $PLM_TENANT_ID" \
  -H "x-org-id: $PLM_ORG_ID" \
  -d "{\"tenant_id\":\"$PLM_TENANT_ID\",\"org_id\":\"$PLM_ORG_ID\",\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])')
export PLM_API_TOKEN
```

## Common Failures
- `401 Unauthorized`: tenant/org mismatch or expired token.
- `404 Not Found`: wrong base URL or missing reverse proxy path.
- Empty results: missing test data; seed BOMs or provide known IDs.
