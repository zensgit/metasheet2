# Data Factory Onboarding Readiness Development - 2026-05-14

## Goal

Close the first high-value gap from issue #1542 without expanding the backend
surface: a user opening Data Factory should understand where to start, why a
source list may be empty, and why payload preview is not the same as a full
pipeline dry-run.

This slice keeps the existing route `/integrations/workbench` and does not add
new migrations, new integration APIs, a SQL executor, or a connection-builder
wizard.

## Problem

The Data Factory workbench already had the underlying pieces for K3 preset
configuration, external-system discovery, staging descriptors, template
preview, pipeline save, dry-run, and Save-only execution. The issue was the
first-run experience:

- an empty source selector did not tell the operator what to do next;
- K3 WISE preset configuration was not discoverable enough from the workbench;
- the connection inventory count was passive text rather than a usable overview;
- SQL Server source connections could look selectable even when the deployed
  backend had no allowlisted `queryExecutor`;
- the page let users reach the dry-run button without clearly listing missing
  prerequisites.

## Implementation

### Connection onboarding

`IntegrationWorkbenchView` now adds an onboarding block above the source/target
selectors:

- `使用 K3 WISE 预设` links to `/integrations/k3-wise`;
- `连接新系统` opens the inventory overview and explains the current first step;
- `查看 SQL / 高级连接` reveals advanced connectors and makes SQL source limits
  explicit.

This is intentionally a UX guide, not a new connection manager. The K3 preset
remains the production-ready entry point for this stage.

### Inventory overview

The existing loaded counts are now clickable. Expanding the overview shows:

- configured external systems, their roles, kinds, and connection states;
- available adapters, including whether each is advanced;
- staging multitable descriptors and whether each has an `打开多维表` link.

When a configured system has a known runtime blocker, the overview shows it
inline instead of letting the operator infer it from a failed dry-run.

### Source empty state

If no readable source system is available, the source selector now renders an
actionable empty state:

- tells the user to connect PLM, HTTP API, or SQL read channel;
- offers the K3 WISE preset path;
- offers the SQL advanced-connector reveal action.

The page keeps K3 WebAPI as a target-only connection; it does not pretend a
target adapter can be used as a source.

### SQL runtime blocker

The workbench detects the known `queryExecutor` missing condition from
`lastError` and shows:

`SQL 连接已配置，但当前部署未注入 SQL 执行器；可保留为高级连接，暂不能作为可读 source 执行 dry-run。`

For K3 SQL Server source connections with error status, it also explains that
the allowlisted `queryExecutor` must be deployed before the channel can read
samples or execute as a source.

This keeps SQL as an advanced capability without implying it is ready on every
deployment package.

### Dry-run readiness checklist

The pipeline panel now lists the concrete prerequisites for dry-run:

- readable source system;
- source dataset;
- target system;
- target dataset/template;
- at least one mapping rule;
- idempotency fields;
- saved pipeline ID.

The checklist distinguishes K3 payload preview from pipeline dry-run with the
message:

`Payload 预览通过不等于 pipeline dry-run；请先保存 pipeline。`

The dry-run button and Save-only button are disabled until the checklist is
complete. Save-only still also requires explicit operator opt-in.

### Review hardening

Reviewer feedback tightened this slice in three places:

- selected source and target systems must be `active` before they can satisfy
  dry-run readiness;
- error-state systems show their actual connection status instead of a generic
  selected-state message;
- SQL executor-missing guidance is only applied to K3 SQL Server connections
  whose error text specifically indicates a missing executor/injection issue.

The visible field-count labels in the Data Factory cards and inventory overview
were also normalized to Chinese copy.

## Files Changed

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/data-factory-onboarding-readiness-development-20260514.md`
- `docs/development/data-factory-onboarding-readiness-verification-20260514.md`

## Non-Goals

- No SQL execution implementation.
- No staging-table-as-source backend fallback.
- No new connection wizard.
- No K3 live Save / Submit / Audit change.
- No database migration.
- No new backend route.

## Deployment Impact

Frontend-only. Existing deployments keep the same routes:

- `/integrations/workbench`
- `/integrations/k3-wise`

The change makes a missing backend executor visible, but it does not change
runtime execution behavior.
