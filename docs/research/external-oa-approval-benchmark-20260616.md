# External OA Approval Benchmark For MetaSheet2 (2026-06-16)

Status: research / decision reference, not backlog. Do not start a slice from
this file alone; each implementation still needs owner selection, a scoped
design-lock when runtime or data semantics change, and an independent opt-in.

Source: public external OA approval handbook pages, fetched 2026-06-16.
Vendor-specific source identifiers and raw extraction artifacts are retained
locally and intentionally kept out of this repository.

Local extraction artifacts were used for this research only and are not committed.

Copyright boundary: this document summarizes product capabilities and
implementation implications. It intentionally does not copy vendor prose,
screenshots, or image assets into the repository.

---

## 0. TL;DR

The reviewed OA approval product is not just a workflow engine. It is a packaged approval
product made of:

1. a template/form center;
2. a form designer with field rules and print/display settings;
3. a flow designer with approval, handler, cc, condition, and parallel nodes;
4. a runtime approval center for initiators, approvers, handlers, cc recipients,
   and data managers;
5. data management, export, audit, dashboards, cross-organization approval, and
   open integration options.

MetaSheet2 already has much of the engine foundation: approval templates,
immutable published definitions, approval graph execution, auto-approval,
assignee resolver, parallel/any-sign/countersign semantics, approval center
routes, template authoring MVP, WorkflowJob automation, `start_approval`,
completion events, and read-only BPMN compile-preview.

The benchmark gap is therefore mostly productization, not a new runtime.

Recommended next ladder:

| Rank | Slice | Why now | Shape |
|---|---|---|---|
| 1 | Approval template center polish | The source product's first impression is template/category/search/start; MetaSheet has routes and backend, but the center can become the real product front door. | Frontend-first, low runtime risk. |
| 2 | Field permission authoring | The source product's form power is per-node editable/read-only/hidden fields. MetaSheet has visibility/fail-closed foundations, but authoring is still narrow. | Contract-first; start with safe subset. |
| 3 | Approval operation surface | The source product emphasizes approve/reject/transfer/return/add-sign/comment/agent. MetaSheet has core approve/reject and several engine features, but user-facing operation parity is incomplete. | Split by operation; do not bundle. |
| 4 | Approval data management | The source product separates data manager role, scopes, filters, export/delete, and operation records. MetaSheet has approval center and metrics; data-governance views can be added without changing runtime. | Admin/data-manager UI + scoped APIs. |
| 5 | W7 result backwrite | High value only when a concrete record-write use case exists and W6 deployed smoke is accepted or explicitly unlocked. | Runtime-gated; business-write risk. |

Do not chase live BPMN runtime, cross-organization approval, or generic
open-platform integration as v1 closure work. Keep them as explicit owner
decisions.

---

## 1. Source Map

The OA overview page links to public sub-pages. The extracted corpus covered
these first-party sections:

| ID | Page | Text lines | Images |
|---|---|---:|---:|
| 01 | OA approval quick-start handbook | 177 | 33 |
| 02 | OA approval operation interface | 108 | 8 |
| 03 | OA approval administrator handbook | 399 | 54 |
| 04 | OA approval initiator handbook | 91 | 46 |
| 05 | OA approval operator handbook | 118 | 22 |
| 06 | OA approval data manager handbook | 47 | 10 |
| 07 | Cross-organization approval | 10 | 5 |
| 08 | OA approval process-center open solution | 34 | 2 |
| 09 | Value-added capabilities | 9 | 1 |
| 10 | Old OA approval operation handbook | 28 | 6 |
| 11-29 | Release/update notes and feature spotlights | mostly short | varied |

Important source-derived feature keywords include: form templates, form controls,
control groups, approver settings, cc nodes, handler nodes, condition branches,
parallel branches, initiator self-selection, roles, supervisors, department
owners, form contact fields, editable/read-only/hidden field permissions,
sequential approval, countersign, any-sign, empty-assignee fallback, transfer,
return, add-sign, comments, proxy approver, data management, export, deletion,
operation records, efficiency dashboards, cross-organization approval, open
integration, linked forms, cascading controls, custom titles, and custom
summaries.

---

## 2. The reviewed OA approval product Capability Map

### 2.1 Product Shell

| Capability | Source product shape | MetaSheet relevance |
|---|---|---|
| OA approval home | Form entry, approval center, management entry, settings/help/update logs. | MetaSheet should treat Approval Center + Templates as one product surface, not scattered pages. |
| Template categories | Templates grouped for quick launch and admin management. | MetaSheet already has template categories and routes; polish discovery and start flow. |
| Role-specific entry | Admin, initiator, approver/handler/cc, data manager. | We should make role boundaries visible in navigation and permissions. |
| Mobile/desktop parity | Handbooks show both channels. | MetaSheet web-first is fine, but responsive authoring/start/detail flows should be checked before broad rollout. |

### 2.2 Template And Form Authoring

| Capability | Source product shape | MetaSheet relevance |
|---|---|---|
| Create from template or blank | Admin can preview/enable a template or create from scratch. | Template center should support obvious create/clone/publish/start actions. |
| Control library | Basic fields, options, numbers, dates, contact/department, amount, cascading, linked forms. | MetaSheet approval form schema has a subset. Prioritize fields that map cleanly to existing formSchema and assignee resolver. |
| Control groups | Leave/overtime/personnel/finance/legal groups tie approval data to business systems. | Do not clone this wholesale. Our equivalent is vertical templates backed by multitable/domain modules. |
| Field settings | Title, placeholder, default value, required, print visibility. | Required/default/print visibility should be explicit authoring items; print is lower priority unless customers need PDFs. |
| Custom title/summary | Approval card/detail can show business-specific summary text. | Good low-risk product polish: improves approval center scanability. |
| Linked forms / data forms | Approval can copy or reference other business form data. | MetaSheet can use multitable lookup/link primitives rather than create a separate OA data-form model. |

### 2.3 Flow Authoring

| Capability | Source product shape | MetaSheet state / implication |
|---|---|---|
| Start node | Configures who can submit and which fields are editable. | MetaSheet has start/new approval path; field permission authoring is the gap. |
| Approval node | Approve/reject plus runtime operations. | Core approval exists; operation parity should be split. |
| Handler node | Non-decision task that submits/handles work. | Not required for v1 closeout; possible later as a distinct task node, not just approval. |
| CC node | Read/comment-only recipient. | MetaSheet should model cc as first-class read/comment task only when notification/read tracking is ready. |
| Condition branch | Branch rules; at most one matching condition branch executes in source docs. | MetaSheet automation has `condition_branch`; approval graph also has branching foundations. Keep semantics explicit per runtime. |
| Parallel branch | Multiple paths run simultaneously. | MetaSheet has approval and automation parallel foundations; join-any/cancel remains separately gated. |
| Branch condition groups | AND within group, OR across groups. | MetaSheet condition builders should avoid flattening richer conditions. Existing fail-closed authoring patterns apply. |
| Node field permissions | Editable/read-only/hidden by node/person role. | This is one of the highest ROI gaps for approval authoring. |

### 2.4 Assignee Resolution

| Source type | Source product shape | MetaSheet implication |
|---|---|---|
| Fixed members | Flow designer chooses users. | Already supported in some form. |
| Initiator / requester | Current requester can participate. | MetaSheet auto-approval/requester semantics already exist; expose carefully. |
| Initiator self-selection | Initiator chooses approver at submission time, with selection range and single/multi choices. | High-value but needs form/runtime contract and validation. |
| Role | Role members approve; role changes help maintain processes. | MetaSheet has role resolver foundations; verify product authoring surface. |
| Supervisor / department owner / multi-level chain | Uses org hierarchy. | Valuable, but depends on organization model completeness. Gate on customer need. |
| Form contact field | Approver comes from a submitted contact/user field. | MetaSheet already proved `form_field_user` start compatibility; authoring and UX should surface it clearly. |
| Empty assignee policy | Auto-pass, auto-reject, transfer to admin or configured user. | MetaSheet has empty-assignee semantics; productize policies cautiously. |

### 2.5 Runtime Operations

| Operation | Source product shape | MetaSheet priority |
|---|---|---|
| Agree / reject | Core handling. | Must stay solid; already foundational. |
| Transfer | Current handler transfers the node to another member. | High domestic OA expectation; implement as its own runtime PR if needed. |
| Return to previous/initiator | Request missing info and re-enter approval chain. | High value but graph-state-sensitive; scope separately. |
| Add-sign | Pre-add or post-add extra approver. | Already recognized as a later approval item; needs ADR/migration and careful audit. |
| Comment / approval opinion | Comments mixed with approval node timeline; processing may require opinion. | Likely low-to-medium UI/runtime slice; should avoid conflating with chat. |
| Proxy approver | User sets temporary proxy by time/template/type. | Product-useful but separate from core graph; needs audit and scope. |
| Revoke/modify completed or in-progress approval | Initiator can revoke/modify based on admin policy. | High risk; separate policy/runtime work. |
| Share link / QR / print records | Detail distribution and audit. | Mostly product polish; print/share requires permission review. |

### 2.6 Data Management And Analytics

| Capability | Source product shape | MetaSheet implication |
|---|---|---|
| Data manager role | Non-admin can view/export/delete within configured scope. | A distinct permission layer is useful; do not overuse platform admin. |
| Data scopes | Own, all company, same level, subordinates, custom departments/users. | Needs organization hierarchy; can start with safer scopes we already support. |
| Filters | Template name, status, initiator, approval number, start/end time. | Approval data center can be built as read-only first. |
| Export / delete | Export to table/local file, delete records by permission. | Export is safer than delete; delete needs audit and retention policy. |
| Operation records | Export/print/delete/template-sync logs. | Strong audit value; pairs with redaction doctrine. |
| Efficiency dashboard | People/department/efficiency diagnostics, weekly/monthly reports. | Optional analytics layer; not part of v1 engine closure. |

### 2.7 Open Integration

The source product describes several integration modes: third-party process + page,
source OA process + page, third-party process rendered through the source product
approval UI, and custom app integration. For MetaSheet, the durable mapping is
simpler:

- Keep our approval runtime and automation runtime bridged by typed events and
  WorkflowJob steps.
- Keep BPMN as compile-preview / modeling, not a live fourth runtime by default.
- Use explicit APIs for template creation, approval start, completion events,
  and result backwrite rather than a generic process-center abstraction.

---

## 3. MetaSheet2 Current Mapping

| Source product layer | MetaSheet current state | Gap |
|---|---|---|
| Template center | Routes exist: `/approval-templates`, create/edit/detail. Template category and clone work exist. | Product polish: search/filter/start affordances, template cards, status visibility, UAT guide. |
| Template authoring | Frontend create/edit/save/publish MVP landed; unsupported graphs fail closed. | Richer field/control authoring, field permission authoring, policy controls. |
| Start approval | `/approvals/new/:templateId` and backend start path exist; real-DB UAT proved create/publish/start for the MVP path. | Deployed browser smoke remains an operator concern where environment routing matters. |
| Approval center | Approval center routes and pending/count/metrics features exist. | Role-specific tabs and data-manager views can be clearer. |
| Approval graph runtime | ApprovalGraphExecutor supports DAG-style approval semantics and prior phase work. | Runtime operations such as transfer/return/add-sign/proxy remain separate opt-ins. |
| Assignee resolver | Static user/role/requester/form-field-user foundations exist. | Product authoring for self-selection, supervisor chain, department/role scopes is partial or absent. |
| Workflow automation bridge | `start_approval`, completion events, WorkflowJob suspend/resume, branches/parallel, and read-only BPMN compile-preview have landed. | W6 deployed smoke and optional W7 result backwrite remain gated. |
| Data management | Admin/metrics/read views exist in pieces. | Data-manager role, scoped export/delete, operation records, and offboarded-user filters are not a complete product surface. |
| Cross-organization approval | Not a current target. | Treat as a separate product decision, not part of v1. |
| Open process center | Our equivalent is explicit APIs + automation bridge + compile-preview. | Avoid a generic process-center abstraction until real integration demand appears. |

---

## 4. Recommended Development Ladder

### P0 - Product Front Door Polish

Goal: make the already-landed approval authoring and start path feel like a
coherent OA approval product.

Scope:

- template list cards with category, status, updated time, owner/admin
  visibility;
- obvious actions: create, edit, clone if permitted, publish state, start
  approval;
- search/filter by category/status/name;
- no runtime semantics change.

Why first: it makes the existing MVP usable and discoverable without touching
graph execution.

### P1 - Field Permission Authoring

Goal: expose a safe subset of per-node field permissions:
editable/read-only/hidden.

Scope:

- design-lock first;
- start with start node + approval node only;
- preserve unknown richer permissions and unsupported graphs read-only;
- prove backend pruning/validation order: hidden fields must not leak through
  errors or writes;
- frontend tests for save/load and fail-closed edit.

Why: the source product's admin handbook treats field permissions as core, not a power-user
extra. It is also already aligned with MetaSheet's existing field-visibility
work.

### P2 - Runtime Operation Parity, Split By Operation

Do not bundle these.

Suggested order:

1. approval opinion / required comment on action;
2. transfer current task;
3. return to initiator or previous node;
4. add-sign;
5. proxy approver.

Each needs a small scope gate because each changes graph state, audit,
notifications, and retry semantics differently.

### P3 - Approval Data Center

Goal: data-manager experience without turning every data user into an admin.

Scope:

- read-only data-management view first;
- filters: template, status, initiator, approval number/id, start/end time;
- scoped permissions: start with admin and template manager; add data-manager
  scopes later;
- export only after filters and redaction are stable;
- delete only after audit/retention policy is scoped.

### P4 - W7 Approval Result Backwrite

Only after one of these is true:

1. W6 operator smoke is accepted, and product owner names a concrete writeback
   mapping; or
2. owner explicitly unlocks W7 before W6 smoke closes.

Use the existing scope gate:
`docs/development/automation-approval-result-backwrite-scope-gate-20260611.md`.

Example acceptable demand signal:

> Purchase approval approved -> write `approved_by`, `approved_at`, and
> `approval_status` to the triggering multitable record.

Not acceptable:

> Let's implement result backwrite because the benchmark product has data integration.

---

## 5. Explicit Non-Goals

These should not be smuggled into approval productization PRs:

- live BPMN runtime;
- replacing ApprovalGraphExecutor with BPMNWorkflowEngine;
- cross-organization approval;
- generic process-center open platform;
- broad external app rendering inside approval detail;
- copying vendor screenshots, prose, templates, or visual assets;
- auto-enabling W7 result backwrite for existing `start_approval` rules;
- adding generic hidden data dumps into approval output or automation logs.

---

## 6. Suggested First Three PRs

### PR A - Template Center Product Polish Scout

Type: docs-only scope gate or small frontend implementation plan.

Questions:

1. Which template list fields already exist in API responses?
2. Does clone/category status already cover the intended card UI?
3. What is the minimum start action from a published template?
4. What is read-only for users without `approval-templates:manage`?

### PR B - Field Permission Authoring Scope Gate

Type: docs-only, because it touches hidden-field security.

Questions:

1. Which field permission model is already persisted in template graph/form
   schema?
2. Which node types can be safely edited in v1?
3. How do hidden fields interact with start form validation, approval detail
   rendering, and action submission?
4. What tests prove no hidden-field validation oracle?

### PR C - Approval Operation Matrix Closeout

Type: research-to-development bridge.

Output:

- one table listing agree/reject/comment/transfer/return/add-sign/proxy/revoke/
  modify;
- current backend state;
- current frontend state;
- recommended independent slice per operation;
- explicit non-bundling rule.

This avoids the familiar trap: implementing add-sign while accidentally changing
return/revoke semantics.

---

## 7. Evidence Notes

This benchmark was extracted from the public OA approval overview page and linked
public handbook pages. The corpus included 29 source pages. The largest source
sections were:

- quick-start handbook: 177 extracted text lines, 33 images;
- admin handbook: 399 extracted text lines, 54 images;
- initiator handbook: 91 extracted text lines, 46 images;
- operator handbook: 118 extracted text lines, 22 images;
- data manager handbook: 47 extracted text lines, 10 images.

The images were used only to understand page structure and UX flow. They are not
committed and should not be reused as product assets.
