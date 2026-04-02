# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260319_214459

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8901/plm
- API: http://127.0.0.1:7779
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260319_2139.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260319_214459-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260319_214459.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1773927558
- Product ID: 5867a12c-a8df-49e2-8f10-de1d4ff2fa98
- Where-used child ID: 8f5246bd-867c-4e92-93c8-dbd9fe29f7d8
- Where-used expect: R0
- BOM child ID: 8f5246bd-867c-4e92-93c8-dbd9fe29f7d8
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-03-19T21:44
- BOM filter: 010
- BOM compare left/right: 5867a12c-a8df-49e2-8f10-de1d4ff2fa98 / 942e0f26-c273-44cb-acaa-05f466f87df7
- BOM compare expect: UI Child Z
- Substitute BOM line: 9a990e40-5ab0-43a2-9e63-db9b7e623d98
- Substitute expect: UI Substitute
- Document name: UI-DOC-1773927558.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1773927558
- Approval product number: UI-CMP-A-1773927558
- Item number-only load: UI-CMP-A-1773927558

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
- Approval action controls visible (approve 1, reject 1).
- Approval history panel loaded with no table.
- Screenshot: artifacts/plm-ui-regression-20260319_214459.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260319_214459.json
