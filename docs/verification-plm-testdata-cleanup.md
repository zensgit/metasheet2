# PLM Test Data Cleanup

Date: 2026-01-06

## Environment
- PLM backend: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1

## Deleted Records
- Parent item id: d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a
- Child item id: fdd72a36-be6e-4967-b697-13069e93f59f
- BOM line id: 027384a6-aea1-4b54-ae1b-0ada996ab9ca

## Results
- DELETE /api/v1/bom/{parent}/children/{child} => ok=true
- AML delete child => status=deleted
- AML delete parent => status=deleted
