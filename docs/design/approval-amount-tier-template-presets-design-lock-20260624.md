# Amount-Tier Approval Template Presets — Design Lock

Status: RATIFIED — RUNTIME NOT BUILT

Grounding: approval authoring can create/edit linear approval templates, preserve complex graphs,
edit condition-node rules, edit parallel `joinMode` (`all` / `any`), and edit cc targets. The common
template preset slice creates basic reimbursement/purchase drafts. This design locks the next
advanced preset family: amount-tier reimbursement and amount-tier purchase.

## Goal

Provide template starters for business flows where the approval path changes when the total amount
crosses configured thresholds, for example:

- reimbursement amount below a threshold → normal manager approval;
- reimbursement amount at or above a threshold → higher-level approval;
- purchase amount at or above a higher threshold → multiple approvers in parallel, using either
  all-must-approve (`joinMode='all'`) or any-one-approves (`joinMode='any'`).

The result is still a template draft. It is not an auto-published policy and it does not perform
approval-result write-back.

## Decisions

1. Use amount fields that already exist in the preset form schema.

   The branch condition reads the top-level total field (`amount`). Detail-row amounts are not
   auto-summed in v1; the applicant-entered total remains the branch input. Auto-sum/calculated
   total is a separate form-field capability, not hidden inside this template slice.

2. Use existing assignee sources first.

   V1 amount-tier presets may use:

   - `direct_manager`;
   - `dept_head`;
   - `manager_at_level`;
   - `continuous_managers`;
   - `static_user`;
   - `static_role`;
   - `form_field_user`.

   This is enough to model "higher-level person/role participates when amount >= X" without adding
   new resolver kinds.

3. Job title / rank is a separate later capability.

   Do not ship a fake `job_title` / `rank` selector in this preset work. A real implementation
   needs directory-sync evidence, snapshot fields, resolver semantics, authoring UI, and fail-closed
   tests. Until then, teams that need a title-like approver should model it as an explicit role.

4. The advanced presets require editable approval nodes inside preserved complex graphs.

   Current complex-graph authoring can edit condition rules and parallel join mode, but approval
   nodes inside a complex graph are displayed as read-only summaries. That is not enough for a
   reusable amount-tier preset because administrators must be able to tune "which role/person/source
   approves at this threshold".

   Therefore implementation order is:

   1. add a complex-graph approval-node editor for approval nodes in a preserved graph;
   2. then add the amount-tier reimbursement/purchase presets.

5. Keep topology fixed in preset v1.

   Presets may ship with a fixed topology: condition fork(s), approval nodes, optional parallel
   join, and end. The admin may edit condition rules, approval-node sources, and `joinMode`. Adding
   or removing branches/edges remains out of scope until topology editing is explicitly designed.

6. Parallel semantics are explicit.

   - `joinMode='all'` means all active branches must complete.
   - `joinMode='any'` means the first completed branch wins and remaining branches are cancelled by
     runtime parallel-any behavior.

   The preset copy should use business wording such as "会签" / "或签", but the stored graph must
   use the existing `joinMode` contract.

## Proposed Presets

### High-Amount Reimbursement

Form fields reuse the basic reimbursement preset:

- `expense_type`;
- `expense_date`;
- `amount`;
- `expense_items`;
- `reason`.

Graph v1:

```mermaid
flowchart TD
  start["Start"] --> manager["Direct Manager"]
  manager --> amountGate{"amount >= high threshold?"}
  amountGate -->|no| end["End"]
  amountGate -->|yes| higher["Manager At Level / Department Head"]
  higher --> end
```

Default threshold proposal: `5000`. The value is editable in the condition-node rule.

### High-Amount Purchase

Form fields reuse the basic purchase preset:

- `purchase_type`;
- `supplier`;
- `amount`;
- `budget_owner`;
- `purchase_items`;
- `reason`.

Graph v1:

```mermaid
flowchart TD
  start["Start"] --> budget["Budget Owner"]
  budget --> amountGate{"amount >= high threshold?"}
  amountGate -->|no| manager["Direct Manager"]
  amountGate -->|yes| fork["Parallel Approval"]
  fork --> managerHigh["Higher-Level Manager"]
  fork --> roleHigh["Configured Role / Person"]
  managerHigh --> join["Join"]
  roleHigh --> join
  manager --> end["End"]
  join --> end
```

Default threshold proposal: `20000`. `joinMode` defaults to `all` for purchase control, with
`any` editable for teams that explicitly want 或签.

## Build Gates

### Gate A — Complex Approval-Node Editor

Before shipping the advanced presets, the authoring UI must let an admin edit approval-node sources
inside preserved complex graphs without changing topology.

Required invariants:

- editing one approval node changes only that node's approval config;
- all condition nodes, parallel nodes, cc nodes, non-edited approval nodes, and all edges remain
  deep-equal;
- legacy unsupported approval-node config still fails closed rather than being flattened;
- the existing linear step editor remains unchanged;
- approval-web-guard runs the new helper/spec.

### Gate B — Preset Backend Acceptance

Every advanced preset must post through the real backend create-template route in the approval
real-DB lane and assert `201 + draft`. This mirrors the common-template preset smoke and prevents a
future preset edit from becoming a click-time 400.

### Gate C — No W7 Coupling

Amount-tier presets only choose approval routing. They do not write approval results back to table
fields. W7 remains gated on a concrete write-back scenario.

## Non-Goals

- No job-title/rank resolver in this slice.
- No automatic detail-row sum.
- No topology add/remove UI.
- No generic rule builder outside approval template authoring.
- No approval-result write-back.
