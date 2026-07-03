# T1-4 — Node field-permissions authoring · BUILD-SPEC (RATIFIED — SHIPPED #3505) · 2026-07-03

> **Status: RATIFIED — SHIPPED by `#3505` (`df8d43bf9`).** The second-batch ballot adopted the owner steer:
> expose the hidden/readonly/editable authoring surface while keeping readonly/editable runtime-inert until a
> later edit-form-at-node slice. #3505 also shipped the malformed `fieldPermissions` fail-closed guard so
> invalid entries become unsupported/read-only rather than silently flattening on save.

## 1. What's already shipped (contract layer, P1-C)

`NodeFieldAccess = 'editable' | 'readonly' | 'hidden'` and `NodeFieldPermission { fieldId, access }` exist
(`types/approval-product.ts:51`); a node's `fieldPermissions` array is normalized shape-only
(`ApprovalProductService.ts:921`) and cross-referenced — every `fieldPermissions[].fieldId` must exist on the
form (`:1021`). So the **data model + validation is done**; the gaps are (a) an authoring UI to set it and
(b) runtime enforcement.

## 2. Shipped reconcile (Q1/Q2 + owner steer)

- **Register Q1 default:** defer edit-form-at-node — readonly/editable stay **runtime-inert** this rung; a
  later **T1-4b** builds mid-flow form editing + readonly/editable enforcement.
- **Register Q2 default:** expose **only `hidden`** in the authoring UI (don't offer readonly/editable while
  they have no runtime effect).
- **Owner steer (2026-07-02):** start from the **hidden/readonly configurable** authoring surface.
- **Shipped Q2 decision:** expose hidden + readonly + editable as configurable authoring states. Readonly is
  persisted but runtime-inert in this slice and remains explicitly deferred to T1-4b.

## 3. Shipped scope

- **Authoring UI** (linear-steps editor only — Q3; complex-graph `fieldPermissions` stay preserved/read-only):
  per approval node, a per-form-field access selector offering `hidden` + `readonly` (+ implicit default
  `editable`). Persists `node.config.fieldPermissions`. Readonly carries a non-blocking "enforced in a later
  slice" hint.
- **Runtime — `hidden` ONLY this rung:** a hidden field is **echo-redacted** from the node's form view
  (Q4: redaction is echo-only — it does NOT affect assignee resolution or condition routing; show a
  non-blocking hint when a hidden field also drives routing). Readonly/editable = **runtime-inert** (deferred
  to T1-4b).
- **Do NOT build:** mid-flow form editing, write-back to `form_snapshot`, readonly/editable enforcement,
  complex-graph authoring.

## 4. Build contract (reviewer-note guards)

- Authoring UI **never flattens** an unsupported/complex loaded shape — preserve + re-emit verbatim (mirror
  the condition_branch/parallel_branch read-only-never-flatten precedent).
- Hidden redaction is applied at the **read/echo boundary** only; a real-wire test asserts a hidden field is
  absent from the node form echo AND that assignee resolution / condition routing still see the value.
- Hiding a routing-driver field is **allowed** (Q4) with a visible authoring hint; a test asserts routing is
  unchanged when the driver is hidden.
- readonly persisted round-trips through save/load unchanged while producing **no runtime effect** (a test
  asserts a readonly field is still editable/echoed at runtime this rung).

## 5. Verification plan (fail-first)

RED-before: a hidden `fieldPermission` does not redact the node form echo. Green-after: hidden field absent
from the echo; assignee/condition paths still read it; readonly is persisted but runtime-inert; complex-graph
fieldPermissions preserved on round-trip. FE: authoring selector renders per node/field, offers hidden +
readonly, blocks nothing, and round-trips.

## 6. Status / next step

Build-spec **RATIFIED — SHIPPED** by #3505. The second-batch ballot entry is now a closed decision record.
T1-4b remains a separate future slice for edit-form-at-node plus readonly/editable runtime enforcement.
