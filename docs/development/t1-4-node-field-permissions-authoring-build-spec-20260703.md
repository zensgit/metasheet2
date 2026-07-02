# T1-4 — Node field-permissions authoring · BUILD-SPEC (vote-ready) · 2026-07-03

> **Status: awaiting the T1-4 per-rung votes** in `approval-automation-second-batch-ballot-20260702.md`.
> This spec folds the owner steer (2026-07-02): **start from the hidden/readonly configurable authoring
> surface; do NOT take on the full mid-flow runtime semantics in one slice.** It reconciles that steer with
> the register's Q2 hidden-only default (below) so the rung is one vote from build. **No runtime until voted.**

## 1. What's already shipped (contract layer, P1-C)

`NodeFieldAccess = 'editable' | 'readonly' | 'hidden'` and `NodeFieldPermission { fieldId, access }` exist
(`types/approval-product.ts:51`); a node's `fieldPermissions` array is normalized shape-only
(`ApprovalProductService.ts:921`) and cross-referenced — every `fieldPermissions[].fieldId` must exist on the
form (`:1021`). So the **data model + validation is done**; the gaps are (a) an authoring UI to set it and
(b) runtime enforcement.

## 2. The reconcile the vote must settle (Q1/Q2 + owner steer)

- **Register Q1 default:** defer edit-form-at-node — readonly/editable stay **runtime-inert** this rung; a
  later **T1-4b** builds mid-flow form editing + readonly/editable enforcement.
- **Register Q2 default:** expose **only `hidden`** in the authoring UI (don't offer readonly/editable while
  they have no runtime effect).
- **Owner steer (2026-07-02):** start from the **hidden/readonly configurable** authoring surface.
- **The one vote decision (Q2):** ✏️ **expose hidden + readonly (persisted, readonly runtime-inert with a
  "takes effect in a later slice" hint)**, OR ✅ **hidden-only UI** (readonly stays persist-able via API but
  unexposed). Recommend the ✏️ path per the steer — it makes the config authorable now without shipping the
  heavy runtime — provided the UI clearly marks readonly as not-yet-enforced.

## 3. Scope (on the ✏️ reconcile)

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

Vote-ready. On the T1-4 rung voted GO (with the Q2 reconcile decided), build in **Lane B**
(`ApprovalProductService.ts` authoring/validation + the template-authoring FE), fail-first + real-DB/vue-tsc,
PR-for-review. Until then, no runtime.
