# Local PLM Integration Environment (Yuantus + MetaSheet)

This note captures the stable local setup used by the PLM UI verification scripts.

## Goals
- Run Yuantus PLM locally with isolated data
- Point MetaSheet core-backend to that local PLM
- Avoid "where-used returns empty" caused by mismatched PLM base URLs

## Yuantus (local, isolated DB)
Use a dedicated SQLite DB so tests do not conflict with other runs.

```bash
cd /Users/huazhou/Downloads/Github/Yuantus

export YUANTUS_DATABASE_URL=sqlite:///./tmp/yuantus_verify.db
export YUANTUS_TENANCY_MODE=db-per-tenant-org

./.venv/bin/yuantus start --host 127.0.0.1 --port 7911
```

Seed identity + meta (use the same env values):

```bash
YUANTUS_DATABASE_URL=sqlite:///./tmp/yuantus_verify.db \
YUANTUS_TENANCY_MODE=db-per-tenant-org \
./.venv/bin/yuantus seed-identity --tenant tenant-1 --org org-1 --username admin --password admin --roles admin --superuser

YUANTUS_DATABASE_URL=sqlite:///./tmp/yuantus_verify.db \
YUANTUS_TENANCY_MODE=db-per-tenant-org \
./.venv/bin/yuantus seed-meta --tenant tenant-1 --org org-1
```

## MetaSheet (PLM integration env)
`PLM_URL` is required because core-backend resolves `plm.url` from the environment.
Without it, old defaults (e.g. `http://127.0.0.1:7910`) can be used and cause empty where-used results.

```bash
export PLM_BASE_URL=http://127.0.0.1:7911
export PLM_URL=$PLM_BASE_URL
export PLM_API_MODE=yuantus
export PLM_TENANT_ID=tenant-1
export PLM_ORG_ID=org-1
export PLM_USERNAME=admin
export PLM_PASSWORD=admin
```

## Verification

```bash
# BOM tools seed + UI regression
PLM_BASE_URL=$PLM_BASE_URL bash scripts/verify-plm-ui-full.sh

# BOM tools only
PLM_BASE_URL=$PLM_BASE_URL bash scripts/verify-plm-bom-tools.sh
```

## Notes
- If Docker has a PLM on `:7910`, prefer `:7911` locally to avoid conflicts.
- If you change ports, update both `PLM_BASE_URL` and `PLM_URL`.
