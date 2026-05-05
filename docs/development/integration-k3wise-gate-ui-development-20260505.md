# K3 WISE GATE UI Readiness Development - 2026-05-05

## Scope

This slice extends the existing K3 WISE integration setup page so operators can prepare the customer GATE packet and run the same PoC chain from a visible UI contract.

It does not add live customer connectivity and does not execute local Node scripts from the browser.

## Files

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Design

The K3 WISE setup form now includes the fields required by `scripts/ops/integration-k3wise-live-poc-preflight.mjs`:

- `operator`
- PLM source kind, read method, base URL, default product ID, and credential placeholders
- rollback owner and strategy
- BOM PoC enablement and product ID

The service layer builds a redacted GATE JSON draft from the form:

- K3 and PLM password values are never emitted into the generated JSON preview or download.
- `autoSubmit` and `autoAudit` are forced to `false` for the live PoC draft.
- production K3 environments are blocked.
- non-readonly SQL modes are blocked if their allowed table list includes K3 core business tables.
- BOM PoC requires a product scope from `bomProductId` or `plmDefaultProductId`.

The page adds a PoC readiness panel with:

- GATE JSON copy and download actions.
- visible preflight, offline mock, and evidence commands.
- inline blocking issues before an operator can copy/download the GATE packet.

## Operator Flow

1. Fill K3 WISE WebAPI and optional SQL Server settings.
2. Fill PLM source and rollback fields in `客户 GATE / PLM Source`.
3. Use `PoC 准备` to copy or download the redacted GATE JSON.
4. Fill real credentials outside Git if needed.
5. Run the displayed preflight command.
6. Run `pnpm run verify:integration-k3wise:poc` before customer live execution.

## Boundary

This is a readiness/UI slice. Real live validation still requires customer GATE answers, customer PLM access, and a K3 WISE test account set to Save-only.
