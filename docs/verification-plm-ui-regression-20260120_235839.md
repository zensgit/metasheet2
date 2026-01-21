# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_235839

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_235839.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: n/a
- Error response: n/a
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1768924727
- Product ID: 78f9ae74-dcdb-4613-bfd6-fd4dc8ddbe6f
- Where-used child ID: db0bbb1a-195e-4914-8f52-81a3cd051501
- Where-used expect: R0
- BOM child ID: db0bbb1a-195e-4914-8f52-81a3cd051501
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T23:58
- BOM filter: 010
- BOM compare left/right: 78f9ae74-dcdb-4613-bfd6-fd4dc8ddbe6f / 7b316314-ca3c-4520-a2c2-7d4fe294efbe
- BOM compare expect: UI Child Z
- Substitute BOM line: d1a74b33-c391-44bc-bba8-81ea45b8536e
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768924727.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768924727
- Approval product number: UI-CMP-A-1768924727
- Item number-only load: UI-CMP-A-1768924727

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- BOM child actions executed (copy + switch).
- BOM detail validation executed (find_num/refdes + depth/effective + filter).
- BOM/Where-Used filter presets import/export/share/group/clear/conflict dialogs validated.
- BOM tree view renders with expandable nodes.
- BOM expand-to-depth button is enabled.
- BOM tree export button is enabled.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata and extended columns.
- Approvals table loads with expected approval metadata and extended columns.
- Screenshot: artifacts/plm-ui-regression-20260120_235839.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_235839.json
