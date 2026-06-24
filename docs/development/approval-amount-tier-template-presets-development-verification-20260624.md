# Amount-tier approval presets - development + verification report

Scope: close out the amount-tier approval template line after the design lock and Gate-A editor landed.
This document records what is already on `main`, how it is wired, what evidence protects it, and the
remaining boundaries that should not be silently expanded.

## Landed chain

- `#3111` shipped the basic common approval presets.
- `#3114` ratified the amount-tier design lock.
- `#3120` restored the review fixes: applicant-entered amount is a known control limitation, the
  reimbursement higher-tier node defaults to `dept_head`, and the non-goals clarify that this is not a
  tamper-proof financial control.
- `#3124` shipped Gate-A / G-5: approval-node sources inside preserved complex graphs are editable
  without changing topology.
- `#3132` shipped the amount-tier runtime presets and backend acceptance coverage.
- `#3141` added the sentinel-role UI hint so the draft explains why a placeholder role must be
  configured before publish.
- `#3146` and `#3147` shipped the topology engine, bridge, clickable surface, canvas, live validity,
  and toggle work that make the advanced graph authoring surface usable.

## What shipped

### High-amount reimbursement

Implementation: `apps/web/src/approvals/commonTemplatePresets.ts`.

- Preset id: `reimbursement_amount_tier`.
- Form schema reuses the reimbursement preset fields, including top-level `amount`.
- Graph shape:
  - `start -> direct_manager approval -> amount_gate`.
  - `amount >= 5000` goes to `dept_head` higher-tier approval, then `end`.
  - default branch goes straight to `end`.
- Admin-tunable surfaces:
  - condition threshold through the condition-node editor;
  - higher-tier assignee source through the Gate-A approval-node editor.

### High-amount purchase

Implementation: `apps/web/src/approvals/commonTemplatePresets.ts`.

- Preset id: `purchase_amount_tier`.
- Form schema reuses the purchase preset fields, including top-level `amount` and `budget_owner`.
- Graph shape:
  - `start -> budget_owner approval -> amount_gate`.
  - low branch goes to direct-manager approval, then `end`.
  - `amount >= 20000` goes to a parallel fork with `joinMode: 'all'` and `joinNodeKey: 'end'`.
- The high branch intentionally uses two distinct assignment types:
  - `manager_at_level` level 2, which resolves to a user assignment;
  - `static_role` with `APPROVAL_ROLE_CONFIGURE_SENTINEL`, which resolves to a role assignment after
    admin configuration.
- This avoids the user-vs-user dynamic collision risk that would exist if both branches could resolve
  to the same person.

## Safety gates

### Preserved graph, not flattened

The amount-tier presets are complex graphs and must remain complex graphs. They are loaded as
`preservedGraph`, not projected into the linear step editor. The save path re-emits the preserved graph
so condition and parallel topology cannot be silently flattened.

### Draft creation allowed, publish guarded

The purchase amount-tier preset deliberately starts with a placeholder role. Draft creation is allowed
so admins can open and retune the preset, but publishing the untouched template is rejected by
`assertNoUnconfiguredPlaceholderRoles` in `packages/core-backend/src/services/ApprovalProductService.ts`.

The frontend sentinel in `apps/web/src/types/approval.ts` must byte-match the backend sentinel. The
real-DB preset acceptance test locks that match and verifies that publish fails with
`APPROVAL_ROLE_PLACEHOLDER_NOT_CONFIGURED` until the role is replaced.

### Terminal parallel join preserved

The purchase high branch joins directly at the terminal `end` node. Backend normalization must preserve
`joinNodeKey: 'end'`; rewriting it to a synthetic join node would change runtime semantics. The real-DB
acceptance test asserts the create -> normalize round trip keeps that terminal join.

### No W7 coupling

The presets only choose approval routing. They do not write approval results back into table fields.
Approval-result write-back remains gated on a separate W7 scenario.

## Verification evidence

### Frontend preset shape

`apps/web/tests/approval-common-template-presets.test.ts` covers:

- the preset list includes the three basic presets plus both amount-tier presets;
- basic presets remain linear and editable through the original step editor;
- amount-tier presets contain condition nodes, load as preserved complex graphs, and round-trip through
  `buildApprovalGraph` without flattening;
- reimbursement gates on `amount >= 5000`;
- purchase gates to a parallel `joinMode: 'all'`, `joinNodeKey: 'end'` shape;
- purchase uses one user-resolving branch plus one `static_role` branch and explicitly avoids the old
  `dept_head + manager_at_level` user-collision shape.

### Backend real-DB acceptance

`packages/core-backend/tests/integration/approval-common-template-presets.api.test.ts` covers:

- every common preset posts through the real create-template route and returns `201 + draft`;
- purchase amount-tier preserves `joinNodeKey: 'end'` through backend normalization;
- untouched purchase amount-tier cannot publish because the sentinel role is still configured.

### Parallel runtime guard

`packages/core-backend/tests/integration/approval-wp1-parallel-gateway.api.test.ts` covers the terminal
parallel join runtime path: both high-amount branches can resolve, join at `end`, and complete the
instance. It also protects the dynamic-conflict model that made the distinct assignment-type preset
shape necessary.

### Visual authoring surface

The complex-graph authoring chain is documented in
`docs/development/approval-visual-authoring-dev-verification-20260624.md`:

- topology operations are covered by pure tests;
- the draft bridge preserves config edits and graph topology;
- clickable topology controls and the canvas use the same engine;
- live validity is advisory, with the backend still the final arbiter on save.

## Known limits

- The amount gate reads the applicant-entered top-level `amount`. Until detail-row auto-sum or a
  server-side total check exists, this is an authoring/routing aid, not a tamper-proof financial
  control.
- No `job_title` or `rank` resolver was added. Teams that need title-like approval should model it as
  a configured role.
- Topology add/remove is available through the explicit visual-authoring tools; the amount-tier preset
  itself does not imply arbitrary topology mutation at creation time.
- The raw mouse-drag gesture remains a manual/E2E polish tail; the graph operations underneath are
  unit-covered.

## Definition of done

This line is complete when all of the following hold on `main`:

- both amount-tier presets are available as draft creators;
- admins can edit condition rules, parallel mode, and approval-node sources before publish;
- create-template real-DB acceptance passes for every preset;
- untouched purchase amount-tier publish fails closed on the placeholder role;
- terminal parallel join runtime is covered;
- the design lock and this report both name the applicant-entered amount limitation.

All of those conditions are satisfied by the landed chain above.

## Follow-up triggers

Open a new design-lock before expanding any of these:

- auto-summing detail rows or server-validating the submitted amount total;
- adding job-title / rank based assignee resolution;
- adding approval-result write-back for these presets;
- making the canvas interaction library-grade with raw drag-to-position / draw-edge gestures.
