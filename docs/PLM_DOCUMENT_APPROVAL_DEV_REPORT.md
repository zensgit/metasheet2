# PLM Document + Approval Verification Dev Report

## Goal
Add PLM document/approval coverage to UI regression and route those operations to real PLM (Yuantus).

## Changes
- `scripts/verify-plm-bom-tools.sh`: seed a document attachment + ECO, emit document/approval fixtures in JSON and report.
- `scripts/verify-plm-ui-regression.sh`: parse document/approval expectations and validate UI tables.
- `packages/core-backend/src/routes/federation.ts`: handle PLM `documents` and `approvals` operations (no mock fallback).

## Verification
- `docs/verification-plm-ui-regression-20260115_173732.md`
- `docs/verification-plm-ui-full-20260115_173732.md`

## Notes
- Yuantus PLM base: `http://127.0.0.1:7910`
- MetaSheet API/UI: `http://127.0.0.1:7788` / `http://127.0.0.1:8899`
