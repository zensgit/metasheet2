# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_204129

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_204129.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_204129-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_204129.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1768912894
- Product ID: 9e79144d-fb3f-4885-941b-6add305f81cb
- Where-used child ID: 3a8cb925-9463-47b7-8073-d7332aa7f3e2
- Where-used expect: R0
- BOM child ID: 3a8cb925-9463-47b7-8073-d7332aa7f3e2
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T20:41
- BOM filter: 010
- BOM compare left/right: 9e79144d-fb3f-4885-941b-6add305f81cb / 16be7b05-7d25-411f-81f4-96bccc617280
- BOM compare expect: UI Child Z
- Substitute BOM line: 6143b025-4923-4a62-b78c-77a03748ff0a
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768912894.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768912894
- Approval product number: UI-CMP-A-1768912894
- Item number-only load: UI-CMP-A-1768912894

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
- Screenshot: artifacts/plm-ui-regression-20260120_204129.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_204129.json
