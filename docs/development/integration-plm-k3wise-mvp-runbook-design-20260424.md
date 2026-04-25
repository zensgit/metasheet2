# Integration PLM K3 WISE MVP Runbook Design - 2026-04-24

## Context

M2 now has mock implementation coverage for:

- Yuantus PLM wrapper source adapter.
- K3 WISE WebAPI target adapter.
- K3 WISE SQL Server channel skeleton.
- ERP feedback writeback.
- mock PLM -> mock K3 WISE -> feedback E2E.

The remaining M2-T06 deliverable is an operator/customer runbook that explains
how to turn this into a controlled customer PoC without confusing mock coverage
with live production readiness.

## Added Document

```text
packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md
```

## Design Goals

The runbook is written for three audiences:

- implementation engineers configuring the plugin.
- customer IT/K3 administrators reviewing permissions and network access.
- operators who need dry-run, run, dead-letter replay, and rollback steps.

It deliberately avoids private implementation details and focuses on the
operational contract:

```text
PLM source -> staging/cleanse -> K3 WISE target -> feedback writeback
```

## Required Sections

The runbook includes:

- scope and non-goals.
- current adapter/runtime capability.
- M2 customer GATE checklist.
- recommended deployment topology.
- external-system examples for PLM, K3 WISE WebAPI, and K3 WISE SQL Server.
- material pipeline example.
- BOM pipeline example.
- staging and ERP feedback field mapping.
- deployment steps.
- run steps.
- mock/test-account/production acceptance checklists.
- troubleshooting for PLM, K3, SQL Server, and feedback.
- rollback strategy.
- production hardening limits.
- validation commands.
- related file index.

## Key Decisions

- K3 target is explicitly K3 WISE, not K3 Cloud/星空.
- Submit/Audit default to disabled.
- SQL Server writes are limited to approved middle tables.
- Feedback defaults to staging camelCase fields, with configurable snake_case
  mapping for customer schemas.
- Live customer work is blocked by the GATE checklist.
- The kernel `PLMAdapter.ts` remains in place.

## Deferred

The runbook does not add runtime behavior. The following remain future work:

- live K3 WISE connection validation.
- live SQL Server executor implementation.
- frontend configuration UI.
- production error-code dictionary.
- high-concurrency compensation and retry policy.
