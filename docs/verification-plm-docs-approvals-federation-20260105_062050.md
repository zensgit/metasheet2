# Verification: PLM Documents & Approvals (Federation) - 2026-01-05 06:20

## Goal
Verify federation query for PLM documents and approvals against Yuantus.

## Environment
- API_BASE: http://127.0.0.1:7778 (core-backend auto-start)
- PLM_BASE_URL: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- PLM_USERNAME: admin
- PLM_PASSWORD: admin
- PLM_ITEM_ID: a338fc4f-bcc6-43b6-971d-a5e3c2a08e6b

## Command
```bash
AUTO_START=true API_BASE=http://127.0.0.1:7778 \
  PLM_ITEM_ID=a338fc4f-bcc6-43b6-971d-a5e3c2a08e6b \
  scripts/verify-plm-docs-approvals.sh
```

## Results
- Documents: ok=true, items=0
- Approvals: ok=true, items=0
- Notes: sample item has no documents/approvals; response shape verified.
