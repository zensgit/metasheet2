# Data Factory on-prem UI verification runbook (#1590 + #1595) - 2026-05-15

## Purpose

Verify, on a **freshly built on-prem / Windows package from latest `main`**,
that two merged Data Factory fixes actually take effect in the deployed UI:

- **#1590** (`fix(multitable): surface required create validation feedback`):
  `+ New Record` on a required-field staging sheet surfaces the server
  validation message via toast instead of failing silently.
- **#1595** (`fix(integration): clarify staging project ID scope`, #1526 P2):
  blank Project ID guidance is correct; a plain Project ID warns and offers a
  one-click normalize; the K3 setup page copy is no longer misleading.

This runbook does **not** re-document install. Follow the canonical docs for
the deploy mechanics and only use this for the #1590/#1595-specific gates:

- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md` (install)
- `docs/deployment/multitable-onprem-package-layout-20260319.md` (layout)
- `docs/operations/integration-k3wise-internal-trial-runbook.md` (post-deploy
  authenticated smoke - the exact `authenticated=true` / `auth-me` checks)
- `docs/operations/staging-deploy-sop.md` (deploy SOP)

## Build the package from latest main

Either the official `Multitable On-Prem Package Build` GitHub workflow on the
latest `main`, or locally:

```bash
BUILD_WEB=1 BUILD_BACKEND=1 INSTALL_DEPS=0 \
  bash scripts/ops/multitable-onprem-package-build.sh
# -> output/releases/multitable-onprem/<pkg>-vX.Y.Z-<date>.zip (+ .sha256, .json)
```

The package bundles `apps/web/dist` (the built frontend) and
`packages/core-backend/dist`. #1590/#1595 are frontend changes, so they ship
inside `apps/web/dist` only when the package is built from a `main` that
contains both merges (verify the merge commits are in the build's `main`).

## Gate A - bundle content (automated, BEFORE touching the box)

```bash
bash scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/<pkg>.zip
```

This must exit `0`. It now includes assertions that the **#1595** P2 strings
are present in the bundled `apps/web/dist`:

- `规范化为 integration 作用域` (Workbench one-click normalize)
- `否则会触发 plugin-scope 警告` (K3 setup project ID scope hint)
- `新建记录入口` (staging multitable open-link copy; prevents operators from
  testing `/grid` or `/spreadsheets/<object>` by mistake)
- `normalize-k3-setup-project-id` (K3 setup now has the same one-click
  normalize affordance as Workbench)

If Gate A fails on these strings, the package was built from a `main` that does
**not** contain #1595 (or the web bundle was not rebuilt) - stop and rebuild;
do not proceed to UI checks.

> **#1590 has no static-string assertion.** It is a one-line wiring change that
> routes the existing `grid.error` value into the existing toast path - there
> is no unique copy string to grep. #1590 can therefore only be confirmed by
> the live UI behavior in Check C1 below, never by Gate A.

## Gate B - Deploy SOP (on the box, BEFORE concluding any UI result)

Per the Deploy SOP: an image/package deploy MUST diff pending migrations and
verify an auth round-trip before trusting the UI. #1590/#1595 add no
migrations, but **latest `main` accumulated other merges** since this box was
last deployed; a schema-gap can yield a silent `401` that makes every UI check
look broken (a false negative wrongly blamed on #1590/#1595).

1. List pending migrations against the box DB; apply them. Confirm count goes
   to zero.
2. Bootstrap / confirm an admin and perform an authenticated round-trip
   (`auth-me` returns 200, not 401) exactly as in
   `integration-k3wise-internal-trial-runbook.md` "Required Signoff Evidence".
3. Only if Gate B passes do the UI checks below carry signal. If C1 fails AND
   auth-me was 401, the fault is Gate B (schema), not #1590 - fix Gate B and
   re-run.

## UI checks (run after Gate A + Gate B pass)

| ID | Route | Steps | Expected (PASS) | FAIL |
| --- | --- | --- | --- | --- |
| C1 (#1590) | `/integrations/workbench` -> staging card `打开多维表（新建记录入口）` -> generated `/multitable/<sheetId>/<viewId>?baseId=...` link | If the staging card does not yet show an open link, click `生成打开链接` / `创建清洗表` first. Then open the generated `/multitable/...` link and click `+ New Record` without filling required fields. | A toast appears carrying the server field-validation message (e.g. `Material Code is required`) | Testing `/grid` or `/spreadsheets/<objectId>` instead of the generated `/multitable/...` link, or no toast/no row/no console error from the true multitable toolbar path |
| C2 (#1572+#1595) | `/integrations/workbench` | Leave staging **Project ID** blank | Field copy reads optional + states blank auto-uses `tenant:integration-core`; **no** `必填` wording; no scope warning shown | Copy still implies Project ID is required, or warns while blank |
| C3 (#1595 + #651) | `/integrations/workbench` **and** `/integrations/k3-wise` | Type a plain Project ID, e.g. `project_default` | Inline warning `Project ID「project_default」不是 integration 作用域 ...`; a `规范化为 integration 作用域` button is shown; clicking it sets the field to `project_default:integration-core` and the warning clears; status line confirms the normalized value | No warning for the plain value, or normalize button missing/no-op on either page |
| C4 (#1595) | `/integrations/k3-wise` (K3 WISE setup) | Inspect the **Project ID** field hint | Hint states: blank -> auto `tenant:integration-core`; custom must end with `:integration-core`, else triggers plugin-scope warning. Deploy-gate "Staging" item is `ready` when blank, `warning` for a plain value (not `missing`) | Old copy that tells the user they must fill Project ID (the pre-#1572 misleading text) |

## Result recording

| Check | PASS / FAIL | Notes |
| --- | --- | --- |
| Gate A (package-verify) | | exit code |
| Gate B (migrations + auth-me 200) | | pending count -> 0; auth-me status |
| C1 #1590 toast | | server message shown? |
| C2 #1595 blank guidance | | |
| C3 #1595 plain warn + normalize | | normalized value observed |
| C4 #1595 K3 setup copy + gate | | staging gate status for blank vs plain |

On any FAIL, capture: the package version/SHA (from the `.json` sidecar), the
`main` commit the package was built from, Gate B auth-me status, and a
screenshot of the failing UI state. Triage order: Gate A -> Gate B -> the
specific check. A C1 failure with a 401 in Gate B is a Gate B defect, not
#1590.

## Boundary / Stage 1 Lock

This is verification of already-merged frontend work plus an ops-only
assertion in the package verifier. No `plugins/plugin-integration-core`, no DB
migration, no API runtime, no route change. The customer GATE is not affected.
