# Data Factory issue #651 C1/C3 UI fix - development - 2026-05-16

## Goal

Close the two remaining on-prem UI verification gaps reported in issue #651
after Gate A/B, C2, and C4 had already passed:

- C1: operators could not find the true staging multitable `+ New Record`
  path and tried `/grid` or `/spreadsheets/<objectId>` instead.
- C3: the Project ID warning/normalize affordance was not consistently visible
  from the K3 WISE preset page.

This is a frontend/ops slice only. It does not touch
`plugins/plugin-integration-core`, database migrations, backend routes, or K3
runtime behavior.

## C1 design

The true record-create path is the generated multitable route:

```text
/multitable/<sheetId>/<viewId>?baseId=<baseId>
```

The generic `/grid` route is not a staging sheet entry and
`/spreadsheets/<objectId>` is not a direct sheet route. To remove the guesswork:

- Workbench staging cards now label their open link as
  `打开多维表（新建记录入口）`.
- If descriptors are loaded but no openLink has been returned yet, each card
  exposes `生成打开链接`, which reuses the idempotent staging install endpoint to
  obtain the backend-generated `/multitable/...` links.
- Each staging card states explicitly not to hand-write `/grid` or
  `/spreadsheets/<objectId>`.

This keeps the verification path inside existing APIs and does not invent a
new route.

## C3 design

#1595 added Project ID scope warning/normalize to the generic Workbench. The
field feedback from #651 shows the same expectation on the K3 WISE preset page,
where operators often start.

The K3 setup page now uses the same helper functions as Workbench:

- blank Project ID stays quiet and resolves to `tenant:integration-core` at
  install time;
- already-scoped values stay quiet;
- plain values such as `project_default` show a warning and a one-click
  `规范化为 integration 作用域` button;
- clicking the button rewrites the field to
  `project_default:integration-core` and clears the warning.

## Package gate

`scripts/ops/multitable-onprem-package-verify.sh` now also checks the built web
bundle for:

- `新建记录入口`, proving the C1 route guidance shipped;
- `normalize-k3-setup-project-id`, proving the K3 setup normalize button
  shipped.

## Stage 1 Lock

Held. This change only updates frontend UI copy/behavior, package verification,
and runbook guidance for already-shipped features.
