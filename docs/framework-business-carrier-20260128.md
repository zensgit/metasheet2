# Business Carrier Framework (PLM/ECO + Attendance) (2026-01-28)

This note explains how to build **generic framework capabilities** first, then layer business modules (Attendance, PLM/ECO) as carriers. The goal is to minimize bespoke logic and maximize reuse.

## 1) Framework Layers
### A. Data Plane
- **Unified schema**: core identity (`orgId`, `userId`, `workDate`, `assetId`, `processId`).
- **Import adapters**: CSV/JSON/API mapping to canonical fields.
- **Mapping registry**: `sourceField -> targetField` mapping per org.

### B. Rule & Policy Engine
- **Rule sets** for domain behavior (attendance policies, ECO approval rules).
- **Policy DSL** for org-specific overrides (roles, shifts, calendar types).
- **Metric processors** (minutes, counts, KPIs).

### C. Workflow & Approvals
- Shared approval pipeline for:
  - Attendance adjustments
  - ECO reviews
  - PLM change control
- **Role-based routing** and audit log.

### D. Reporting & Payroll/Costing
- Rollup APIs (daily -> monthly -> cycle).
- CSV/Excel exports.
- Configurable cycle windows (cross-month support).

### E. UI Assembly
- Reusable layout slots: Summary, Calendar, Requests, Admin Console.
- Module sections registered as **plugins**.

### F. Security & Audit
- Tenant isolation, `orgId` scoping.
- Per-module permissions (read/admin/export).
- Audit events for imports and approval steps.

## 2) Applying to Attendance
- Import adapters ingest DingTalk/CSV.
- Rule sets apply: work minutes, late/early, leave, overtime.
- Payroll cycles aggregate cross-month windows.
- Admin UI manages policies and templates.

## 3) Applying to PLM/ECO
- Same import + mapping layer for BOM/parts.
- Rule sets for approval thresholds, risk scoring.
- Approval pipeline is identical to attendance adjustments.
- Reporting layer reuses summary/exports.

## 4) What Is "Core" vs "Carrier"
### Core (Platform)
- Schema, import, mapping, workflow, policy DSL, reporting, audit.

### Carrier (Business Module)
- Attendance rules, PLM/ECO schemas, UI pages, custom KPIs.

## 5) Recommended Next Steps
1. Consolidate common mapping + policy DSL docs across modules.
2. Add module registration metadata (menus + permissions).
3. Expand import adapters (DingTalk, Feishu, SAP).
4. Add KPI formula registry (reused by Attendance + PLM).
