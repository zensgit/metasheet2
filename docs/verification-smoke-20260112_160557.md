# Verification: Smoke Suite - 20260112_160557

## Command
```bash
RUN_PLM_UI_READONLY=true SMOKE_SKIP_MIGRATE=true pnpm verify:smoke
```

## Environment
- API base: `http://127.0.0.1:7778`
- Web base: `http://127.0.0.1:8899`
- PLM base: `http://127.0.0.1:7910`
- Tenant/org: `tenant-1/org-1`

## Results
- Core smoke report: `artifacts/smoke/smoke-report-20260112_160557.json`
- PLM UI readonly regression:
  - `docs/verification-plm-ui-regression-20260112_160557.md`
  - `docs/verification-plm-ui-full-20260112_160557.md`
  - Screenshot: `artifacts/smoke/plm-ui-regression-20260112_160557.png`

## Notes
- `SMOKE_SKIP_MIGRATE=true` due to missing historical migration in local DB.
