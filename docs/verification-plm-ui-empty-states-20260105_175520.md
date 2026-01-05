# Verification: PLM UI Empty States - 2026-01-05 18:02

## Goal
Validate UI empty-state hints for BOM/documents/approvals when the product has no linked data.

## Environment
- UI: http://localhost:8899/plm
- Core backend: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1

## Data
- Product ID: a338fc4f-bcc6-43b6-971d-a5e3c2a08e6b

## Observations
- BOM panel shows "暂无 BOM 数据（可在 PLM 关联 BOM 行后刷新）".
- Documents panel shows "暂无文档（可先在 PLM 关联文件或设置文档角色过滤）".
- Approvals panel shows "暂无审批数据（可调整状态筛选或创建 ECO 流程）".
- Where-used panel shows "暂无 where-used 数据（输入子件 ID 后查询）".
- BOM compare panel shows "暂无对比数据（填写左右 ID 后对比）".
- Substitutes panel shows "暂无替代件数据（填写 BOM Line ID 后查询）".

## Evidence
- Screenshot: `artifacts/plm-ui-empty-hints-20260105_180232.png`

## Notes
- Related UI runs:
  - `docs/verification-plm-ui-20260105_174643.md`
  - `docs/verification-plm-ui-regression-20260105_175324.md`
