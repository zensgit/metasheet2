# Data Factory Issue 651 C1/C3 UI Closeout - Verification

Date: 2026-05-17

## Local Regression Tests

Run from `/Users/chouhua/Downloads/Github/metasheet2`.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false
```

Result:

- 2 test files passed
- 24 tests passed

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/integrationWorkbench.spec.ts --watch=false
```

Result:

- 2 test files passed
- 62 tests passed

## 142 Page-Level Verification

Test path:

- SSH tunnel: local `127.0.0.1:18081` to 142 `127.0.0.1:8081`
- Browser automation: Playwright Chromium
- Auth: temporary admin JWT from deploy-host fallback, injected into browser storage without printing the value in test summaries

### C3 Project ID Scope UI

Page:

```text
http://127.0.0.1:18081/integrations/k3-wise
```

Observed:

- Blank Project ID status: `当前将使用 default:integration-core`
- Plain Project ID `project_default` shows the non-integration-scope warning.
- Clicking normalize updates the value to `project_default:integration-core`.
- Normalized status: `当前将使用 project_default:integration-core`

Result: PASS

Screenshot:

```text
/tmp/ms2-issue651-c1-c3-artifacts/c3-project-id-normalized.png
```

### C1 Multitable Required-Field Toast

Page:

```text
http://127.0.0.1:18081/multitable/sheet_239b80c4c1482191eb3ba802/view_ac391563230dd8e667b51765?baseId=base_legacy
```

Target sheet:

- `Standard Materials`
- Required fields confirmed through `/api/multitable/view`:
  - `Material Code`
  - `Material Name`
  - `Status`

Action:

- Click `+ New Record` with no field values.

Observed toast:

```text
Material Code is required
```

Result: PASS. The UI now surfaces a field-level required error instead of the old generic `Failed to create meta record` / internal-error path.

Screenshot:

```text
/tmp/ms2-issue651-c1-c3-artifacts/c1-required-toast.png
```

## Secret Hygiene

The verification summary intentionally contains no JWT, bearer token, database URL, password, or K3 credential value. Screenshots only capture UI labels and validation messages.

## Final Decision

No additional runtime fix is needed for #651 C1/C3 on current main. The 142 deployment has the relevant UI behavior and the local frontend tests cover the regression paths.
