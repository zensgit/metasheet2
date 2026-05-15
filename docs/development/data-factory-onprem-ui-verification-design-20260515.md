# Data Factory on-prem UI verification - design - 2026-05-15

## Goal

The user's next action is "deploy/test latest main package; verify #1590 +
#1595 on the physical-machine UI" via a freshly built on-prem/Windows package.
This slice makes that verification deterministic and re-runnable without
opening any integration-core feature work.

## Why this shape

#1590 and #1595 are merged frontend changes. The risk is a **false negative**:
the on-prem package bundles `apps/web/dist`, but if the package is built from a
stale `main` (or the web bundle is not rebuilt), or if an unrelated schema gap
on the box returns a silent 401, the operator would wrongly conclude the fixes
"don't work".

Two guards address this:

1. **Bundle-content gate (automated).** `multitable-onprem-package-verify.sh`
   already greps `apps/web/dist` for required Data Factory copy. Adding the
   #1595 unique strings to that existing function turns "is the P2 UX actually
   in this package" into a pre-deploy pass/fail instead of a manual eyeball.
2. **Runbook with the Deploy SOP gate.** A focused runbook that puts the
   migration-diff + auth round-trip gate *before* the UI checks, so a schema
   401 is attributed to the deploy, not to #1590/#1595.

## #1590 is behavioral-only (deliberate non-assertion)

#1590 is a one-line wiring change: it routes the existing `grid.error` value
into the existing toast path after toolbar `createRecord()`. It introduces no
unique static string, so it **cannot** be asserted by a dist grep. The design
explicitly documents this and routes #1590's proof to the live UI check (C1),
rather than inventing a brittle/fake assertion.

## #1595 assertions chosen

Two strings, each unique to #1595, covering both touched views:

- `规范化为 integration 作用域` - the Workbench one-click normalize button.
- `否则会触发 plugin-scope 警告` - the K3 setup Project ID scope hint.

Confirmed absent in pre-#1595 source (parent of merge `e77a04117`), so the new
assertions are a real gate: a pre-#1595 bundle would `die()`.

## Scope

- `scripts/ops/multitable-onprem-package-verify.sh` - 2 added
  `search_fixed_string` lines in the existing
  `verify_generic_integration_workbench_contract`.
- `docs/operations/data-factory-onprem-ui-verification-runbook-20260515.md` -
  the runbook (build -> Gate A -> Gate B -> 4 UI checks -> result table).
- This design MD + a verification MD.

## Out of scope / Stage 1 Lock

- No `plugins/plugin-integration-core`, no DB migration, no API runtime, no
  route change. Verifier change is ops hygiene on shipped features (permitted
  under the lock).
- Not implementing or deploying anything to the physical machine; this slice
  produces the gate + runbook + local build evidence. The operator runs the
  physical-machine UI steps.
