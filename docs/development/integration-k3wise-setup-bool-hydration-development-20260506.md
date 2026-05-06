# K3 WISE Setup Boolean Hydration Development - 2026-05-06

## Context

The K3 WISE setup page hydrates saved external-system config back into the
operator form. Backend and script-side K3 WISE hardening already accept boolean
variants such as `"true"`, `"false"`, numeric `0`/`1`, and common Chinese
operator inputs.

The setup form only restored `autoSubmit` and `autoAudit` when the saved value
was the literal boolean `true`. Saved config imported from older rows, fixtures,
or hand-edited JSON could contain `"true"`, `1`, or `是`; the page would display
those as unchecked.

## Change

`apps/web/src/services/integration/k3WiseSetup.ts` now normalizes saved
`autoSubmit` / `autoAudit` values when applying an external system to the setup
form.

Accepted true variants:

- `true`
- `1`
- `"true"`, `"1"`, `"yes"`, `"y"`, `"on"`, `"enable"`, `"enabled"`
- `"是"`, `"启用"`, `"开启"`

Accepted false variants:

- `false`
- `0`
- `"false"`, `"0"`, `"no"`, `"n"`, `"off"`, `"disable"`, `"disabled"`
- `"否"`, `"禁用"`, `"关闭"`

Unknown, missing, object, array, and non-`0/1` numeric values hydrate to
`false`. This keeps the UI safety-biased and prevents a truthy checkbox from a
previously selected system leaking into the newly loaded system.

## Files

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Non-Goals

- This does not change how new K3 WISE setup payloads are saved.
- This does not make the test button evaluate unsaved draft fields. The current
  API still tests the persisted external-system row; that is tracked as a
  separate UX/contract hardening candidate.
