# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_204826

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_204826.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_204826-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_204826.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1768913312
- Product ID: e4aae619-2de0-4a20-a7a7-1e882015a525
- Where-used child ID: 77014cee-abc8-40f0-bb93-84145b4924d5
- Where-used expect: R1,R2
- BOM child ID: 77014cee-abc8-40f0-bb93-84145b4924d5
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T20:48
- BOM filter: 010
- BOM compare left/right: e4aae619-2de0-4a20-a7a7-1e882015a525 / a6b5123d-2db7-43a6-9363-76d56636907c
- BOM compare expect: UI Child Z
- Substitute BOM line: 739c1ab2-15d4-4c57-b6bb-a9c063623b00
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768913312.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768913312
- Approval product number: UI-CMP-A-1768913312
- Item number-only load: UI-CMP-A-1768913312

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
- Screenshot: artifacts/plm-ui-regression-20260120_204826.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_204826.json
