# Verification: Smoke + PLM UI Regression - 2026-01-05 21:21

## Goal
Run smoke verification with PLM UI regression enabled.

## Command
```bash
RUN_PLM_UI_REGRESSION=true bash scripts/verify-smoke.sh
```

## Environment
- API_BASE: http://127.0.0.1:7778
- WEB_BASE: http://127.0.0.1:8899
- PLM_BASE_URL: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1

## Results
- Smoke checks: OK (api.health, dev-token, univer-meta.*, web.home).
- PLM UI regression: OK.
  - Report: `docs/verification-plm-ui-regression-20260105_212131.md`
  - Screenshot: `artifacts/smoke/plm-ui-regression-20260105_212131.png`
