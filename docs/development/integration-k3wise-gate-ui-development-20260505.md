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
- customer-returned GATE JSON import.
- visible authenticated postdeploy smoke, postdeploy summary, preflight, offline mock, and evidence commands.
- a redacted deploy environment template for `METASHEET_BASE_URL`, `METASHEET_AUTH_TOKEN_FILE`, and `METASHEET_TENANT_ID`.
- a redacted deploy signoff bundle that combines env setup, authenticated postdeploy smoke, and summary rendering.
- one-click copy controls for each displayed PoC/deploy command.
- inline blocking issues before an operator can copy/download the GATE packet.

## Customer GATE Import

The PoC readiness panel now accepts a pasted customer GATE JSON packet and applies it back into the setup form.

Import behavior is intentionally conservative:

- The operator must click `导入 GATE JSON`; paste/input alone does not mutate the form.
- Empty JSON, malformed JSON, and array JSON are rejected before any form update.
- K3 WISE, PLM, SQL Server, rollback, and BOM public fields are normalized into the setup form.
- Boolean variants are accepted for common customer hand-edits: `true/false`, `0/1`, `yes/no`, `on/off`, and Chinese `是/否/启用/禁用/开启/关闭`.
- SQL Server mode aliases normalize to `readonly`, `middle-table`, or `stored-procedure`.
- PLM read method aliases normalize to `api`, `database`, `table`, `file`, or `manual`.
- Unsupported environment/read-method/mode values fall back conservatively and surface import warnings.
- Secret-like keys such as `password`, `token`, `secret`, `sessionId`, and private/access key fields are never copied into the form. The three password fields are cleared on import to prevent stale credential carryover.

## Operator Flow

1. Fill K3 WISE WebAPI and optional SQL Server settings.
2. Fill PLM source and rollback fields in `客户 GATE / PLM Source`.
3. Use `PoC 准备` to copy or download the redacted GATE JSON.
4. Fill real credentials outside Git if needed.
5. Copy the deploy signoff bundle, replace the base URL and token file path outside Git, and keep `METASHEET_TENANT_ID` aligned with the form.
6. Before customer live execution, run the displayed postdeploy smoke and summary commands, or run the copied signoff bundle.
7. Run the displayed preflight command.
8. Run `pnpm run verify:integration-k3wise:poc` before customer live execution.

For a customer-returned packet:

1. Paste the JSON into `导入客户 GATE JSON`.
2. Click `导入 GATE JSON`.
3. Review import warnings, especially ignored secret fields and unsupported aliases.
4. Re-enter any required credentials through the credential form, not through pasted JSON.
5. Re-run the visible GATE validation before copying/downloading a corrected packet.

## UI Regression Coverage

The view exposes stable test selectors for the customer GATE import path:

- `data-testid="k3-wise-gate-import-textarea"`
- `data-testid="k3-wise-gate-import-button"`
- `data-testid="k3-wise-gate-import-warnings"`
- `data-testid="k3-wise-gate-copy-button"`
- `data-testid="k3-wise-gate-download-button"`
- `data-testid="k3-wise-gate-commands"`
- `data-testid="k3-wise-status"`

`apps/web/tests/k3WiseSetupView.spec.ts` mounts the real setup page, mocks the integration API bootstrap calls, pastes a customer-style GATE JSON payload, clicks the explicit import button, and verifies:

- visible K3, PLM, SQL Server, rollback, and BOM form fields are populated.
- Chinese/numeric customer variants normalize in the rendered controls.
- all visible password inputs are cleared after import.
- ignored secret-like fields appear as warnings in the page.

The same spec also covers the outbound copy and download paths:

- visible form fields can make the GATE draft ready.
- the page renders a redacted deploy environment template with the current tenant ID and no bearer token value.
- the page renders a redacted deploy signoff bundle with env setup, authenticated postdeploy smoke, and summary commands.
- the page renders authenticated postdeploy smoke and summary commands before customer live execution commands.
- the deploy environment template can be copied without exposing a token.
- the deploy signoff bundle can be copied without exposing a token.
- each displayed command can be copied without selecting shell text manually.
- the copy button writes the generated JSON to `navigator.clipboard`.
- the download button writes the same generated JSON into a Blob-backed download.
- submitted K3/PLM password values are redacted as `<fill-outside-git>`.
- outbound JSON preserves public usernames and scope fields.
- the hidden download anchor is removed immediately after click.
- the object URL is released through a deferred `URL.revokeObjectURL()` call after the browser has had a chance to consume the download URL.

## Boundary

This is a readiness/UI slice. Real live validation still requires customer GATE answers, customer PLM access, and a K3 WISE test account set to Save-only.
