# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_154958

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_154958.json

## Data
- Search query: UI-CMP-A-1768895403
- Product ID: b15abb8b-ce89-4fb0-8523-20aea627261e
- Where-used child ID: f6029f9b-2b3e-4107-b983-379ddd9ffd23
- Where-used expect: R1,R2
- BOM child ID: f6029f9b-2b3e-4107-b983-379ddd9ffd23
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T15:50
- BOM filter: 010
- BOM compare left/right: b15abb8b-ce89-4fb0-8523-20aea627261e / e17a8870-b546-493a-a0f4-3c9d2e1a71bc
- BOM compare expect: UI Child Z
- Substitute BOM line: 101d1cdc-3cb3-4fa3-970b-78de7870340c
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768895403.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768895403
- Approval product number: UI-CMP-A-1768895403
- Item number-only load: UI-CMP-A-1768895403

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
- Screenshot: artifacts/plm-ui-regression-20260120_154958.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_154958.json
