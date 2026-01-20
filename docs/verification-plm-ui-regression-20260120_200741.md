# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_200741

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_200741.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_200741-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_200741.json

## Data
- Search query: UI-CMP-A-1768910866
- Product ID: a713a9a8-fa73-4f02-a17f-7ac0db4320d9
- Where-used child ID: bcffcc3c-a236-4e5b-ac1b-9e14a690d7d1
- Where-used expect: R1,R2
- BOM child ID: bcffcc3c-a236-4e5b-ac1b-9e14a690d7d1
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T20:07
- BOM filter: 010
- BOM compare left/right: a713a9a8-fa73-4f02-a17f-7ac0db4320d9 / e1d19c5a-973a-4b1e-9d8c-d84d6f3c28fe
- BOM compare expect: UI Child Z
- Substitute BOM line: 266030b2-bc55-47e4-92f9-264fe7f5d228
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768910866.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768910866
- Approval product number: UI-CMP-A-1768910866
- Item number-only load: UI-CMP-A-1768910866

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
- Screenshot: artifacts/plm-ui-regression-20260120_200741.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_200741.json
