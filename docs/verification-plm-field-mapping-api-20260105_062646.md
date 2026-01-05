# Verification: PLM Field Mapping API - 2026-01-05 06:26

## Goal
Validate PLM mapping output with an item that has revision and documents.

## Environment
- API_BASE: http://127.0.0.1:7778
- PLM_BASE_URL: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- PLM_USERNAME: admin
- PLM_PASSWORD: admin
- PLM_ITEM_ID: 4a826410-120b-40b3-8e8a-b246f56fdb05
- PLM_ITEM_TYPE: Part

## Command
```bash
PLM_ITEM_ID=4a826410-120b-40b3-8e8a-b246f56fdb05 \
  PLM_ITEM_TYPE=Part \
  scripts/verify-plm-field-mapping.sh http://127.0.0.1:7778
```

## Results
- Products returned: 1
- Documents returned: 1
- Approvals returned: 0
- Artifact: artifacts/plm-field-mapping-api-20260105_062646.json
