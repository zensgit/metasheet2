# PLM UI Dev DB Auto-Start Report

## Goal
Allow PLM UI regression scripts to auto-start the local dev PostgreSQL when `AUTO_START=true` and the DB port is not reachable.

## Changes
- `scripts/verify-plm-bom-tools.sh`
  - Add a lightweight `ensure_smoke_db` helper that starts `docker/dev-postgres.yml` if needed.
- `scripts/verify-plm-ui-regression.sh`
  - Add the same helper and call it before starting the core backend.

## Behavior
- Only triggers when `AUTO_START=true` and `SMOKE_DATABASE_URL` points to `localhost/127.0.0.1`.
- Skips auto-start for remote DBs.
- Fails fast if Docker is unavailable or the compose file is missing.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_093613.md`
  - `docs/verification-plm-ui-full-20260120_093613.md`
- Artifacts:
  - `artifacts/plm-bom-tools-20260120_093613.json`
  - `artifacts/plm-bom-tools-20260120_093613.md`
  - `artifacts/plm-ui-regression-20260120_093613.png`

Status: PASS
