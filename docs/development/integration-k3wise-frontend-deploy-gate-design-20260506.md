# K3 WISE Frontend Deploy Gate - Design

Date: 2026-05-06
Branch: `codex/erp-plm-deploy-gate-frontend-readiness-20260506`

## Goal

Make the K3 WISE setup page answer a practical operator question:

> After deploying MetaSheet to a physical machine, which K3 WISE / ERP-PLM PoC fields can I fill in the frontend, and which items still require customer GATE input or backend/API preparation?

## Scope

Files changed:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Design

The setup helper now exposes a pure readiness model:

- `buildK3WiseDeployGateChecklist(form)`
- `summarizeK3WiseDeployGateChecklist(items)`

The checklist is intentionally frontend-only and does not call the network. It classifies the current form into four statuses:

- `ready`: the page already has enough information for that step.
- `missing`: the operator can fill this on the deployed page before continuing.
- `warning`: the step is allowed, but needs operator attention.
- `external`: the page can reference the value, but cannot create it by itself.

The page renders this checklist in the left rail above saved systems. It gives immediate feedback for:

- tenant/project scope;
- tenant-only configuration save readiness;
- project-scoped staging installation readiness;
- K3 WISE WebAPI endpoint and credentials;
- save-only versus Submit/Audit policy;
- SQL Server read channel and write boundary;
- PLM source system readiness;
- staging multitable installation readiness;
- pipeline template, dry-run, and live-run readiness.

## Important Boundary

Deploying the app lets an operator fill many K3 WISE fields directly in the frontend:

- K3 WISE version/environment/base URL;
- acctId, username, password;
- Save/Submit/Audit paths;
- optional SQL Server channel fields;
- project/base/staging/pipeline fields;
- dry-run/live-run toggles.

It does **not** remove the customer GATE dependency. These still need customer input or backend/API/script preparation:

- third-party PLM source external system creation;
- complete customer field mapping and dictionary rules;
- rollback/evidence owner and signoff;
- SQL Server executor/proxy for real SQL connectivity;
- live K3/PLM connectivity credentials and network allowlist.

This keeps the UI honest: internal deployment smoke and frontend setup can proceed before the customer answers, but true live PoC PASS still waits for the customer GATE packet.

## Why This Slice

The backend/mock PoC path already has control-plane and postdeploy smoke scripts. The practical gap was operator visibility on the deployed page. This change lowers deployment-test friction without inventing vendor abstraction or pretending the customer GATE is solved.
