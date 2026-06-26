# Requester / org-attribute formula conditions — Design Lock

Status: RATIFIED — RUNTIME NOT BUILT. Owner decisions RESOLVED 2026-06-26 + a SCOPE CORRECTION 2026-06-26
(see bottom): RA-1a ships **`requester.department` ONLY** — `requester.level` is DEFERRED because the
directory has no seniority-level source (Decision 2). `level`/`role`/`title`/`in`/array literals/unknown
attr all parse/publish fail-closed in RA-1a; seniority (`title` vs `level`) and `role` follow in their own
locks.

Grounding: formula conditions (shipped FC-1..FC-5) let a branch route on **form fields** and **detail
aggregates** — all applicant-controlled, submitted values. This lock adds the next layer: routing on
**trusted requester org attributes** (`requester.level`, `requester.department`, …) so a template can
express "高于 5 级走更高审批" or "财务部门走专属路径". It is the closest answer to "can authors set approval
conditions more freely", higher value than further amount-line polish, and safer than W7 rejection /
cross-base because it stays a **routing decision** — no cross-table write.

## The spine
- **Server-resolved, not applicant-controlled.** Requester attributes come from the directory, resolved
  server-side and FROZEN into the requester snapshot at `createApproval` — exactly the machinery
  `ApprovalDirectoryOrg` already runs to bake `managerId` / `deptHeadId` / `managerChainIds` from
  `directory_*.raw`. This is the whole point: unlike a form field (which the applicant types and can
  fabricate), `requester.level` is what the org's directory says, so a formula on it is tamper-resistant.
- **Backend is still the sole arbiter; the FE may preview, never decide.**

## Locked decisions

### 0. Reserved `requester.*` namespace, distinct from form fields
`requester.<attr>` is a reserved formula token, separate from `{field}` form refs and `SUM({detail.x})`
aggregates. e.g. `requester.level >= 5`, `requester.department == "财务" AND {amount} >= 5000`. The parser
resolves `requester.*` from the frozen snapshot, never from `formData` — so a form field literally named
`requester` can never shadow or spoof it.

### 1. Snapshot source = the existing org-relation freeze, extended
The v1 attributes are lifted from `directory_accounts.raw` / `directory_departments.raw` by
`ApprovalDirectoryOrg` (the existing read-only SELECT seam) and frozen into the requester snapshot at
create, alongside the org relations already baked there. No new write path, no live lookup at eval time.

### 2. Fail-closed = a PUBLISH-validate / RUNTIME-reject SPLIT (the centerpiece)
"Missing → fail closed" is a footgun unless two missing-cases are separated — this is the same split the
amount total-check already ships (validate-at-publish vs reject-at-runtime):
- **Structural absence — attribute not supported / not synced for this org/provider.** Caught at
  **TEMPLATE PUBLISH**: validate every referenced `requester.*` attribute resolves against the directory
  schema / provider capability before the template can publish. The author fixes it where they authored
  it. A template referencing an attribute the org cannot supply MUST fail publish — NOT brick every
  requester's create.
  - **RA-1a deviation (recorded 2026-06-26):** RA-1a does the ATTRIBUTE half at publish (the `{department}`
    allowlist parse/publish-rejects `level`/`role`/`title`/unknown) but DEFERS the org-DATA half (does this
    org's directory actually carry department names) to RA-2 — that check needs the org's directory context
    at publish, which the form-schema validator lacks. Safe for `department`: an org with no department
    names has `requester.department` formulas fail-closed at RUNTIME (reject the create, never
    phantom-route), just caught later than this paragraph's general promise. RA-2 adds the publish-time
    org-capability check.
- **Row-level absence — attribute supported, but absent for THIS requester.** That is the **runtime
  fail-closed**: reject this `createApproval` rather than route on a phantom value (never default-to-0,
  never silently take `defaultEdgeKey` — error vs no-match, same as the FC-1 evaluator).
Without this split a `requester.level >= 5` template would block approval creation for every requester
whose directory record lacks a level — an outage, not a safety property. With it, it is correct.

### 3. Per-attribute type + comparison semantics (pin it, or cut it)
An author needs to know the type + comparison, or the formula is guesswork. Candidate v1 attributes:
- **`requester.level`** — ORDINAL number, **higher = more senior** (locked convention), **provider-native
  scale** in v1 (the author must know their directory's level scale; not normalized). Numeric ops only.
- **`requester.department`** — STRING, the department **name**, exact-match (`==`/`!=`/`in`). (Owner sub-
  decision: name vs a stable dept id — name is readable but mutable; id is stable but opaque. v1 default:
  name, with the mutability caveat documented.)
- **`requester.role`** — MULTI-VALUED. Comparison is **membership**, not `==`: an author writes
  `requester.role in ["finance_approver","admin"]` meaning "the requester holds one of these". A bare
  `requester.role == "x"` is rejected at publish (ambiguous on a set).
- **`requester.managerLevel`** — DEFER / owner-define. Ambiguous (depth-in-chain? manager tier?). Do NOT
  ship until its meaning + scale are pinned; flagged here, not built.
- **`requester.orgPath`** — **CUT from v1.** Its format (display string vs stable-id path) and match mode
  (exact vs subtree-prefix) vary by provider and cannot be pinned cleanly now; ship it ambiguous and
  every author guesses. Revisit as its own decision (subtree routing) later.

### 4. Frozen-at-create staleness is INTENTIONAL
A requester promoted mid-approval still routes by their **create-time** level/department. This is the
right call — deterministic, auditable, matches the org-relation freeze — and is stated so nobody later
"fixes" it into a live lookup (which would make routing non-reproducible and add per-eval directory load).

### 5. Permission boundary
Authoring a `requester.*` formula needs the template-authoring permission (same as any condition edit).
The snapshot resolution is the **server's** directory read (`ApprovalDirectoryOrg`'s read-only SELECTs) —
no applicant-facing capability widens. Reading the requester's own attributes to route the requester's
own approval is appropriate; no new consent surface. (The attributes are not echoed back to the applicant
or the form — they live only in the frozen snapshot the evaluator reads.)

## Build Gates (for the SEPARATE runtime opt-in)
- **RA-1 — snapshot + evaluator namespace.** Extend `ApprovalDirectoryOrg` to lift the chosen attributes
  into the frozen snapshot; extend the FC-1 evaluator to resolve `requester.*` from the snapshot (never
  formData); reuse the FC-1 narrow-evaluator discipline (no eval, bounded, fail-closed).
- **RA-2 — the publish/runtime split.** Publish-time: reject a template whose `requester.*` refs the org
  can't supply. Runtime: reject a create whose required attribute is absent for that requester. Tests for
  BOTH branches + the membership semantics + ordinal direction.
- **RA-3 — no trust regression.** A `requester.*` formula reads only the frozen server snapshot; a form
  field named `requester` cannot spoof it; the FE preview is non-authoritative.

## Non-Goals (hard, not "maybe later")
- **Resolver invocation inside a formula** (calling the dept-head / manager-chain resolver from formula
  eval). v1 is ATTRIBUTE-READ-ONLY — static frozen values, no resolver fan-out inside evaluation. This is
  the single biggest risk reducer; keep it out.
- Cross-requester or approver attributes (only the requester's own).
- Live (non-frozen) directory lookup at eval time.
- `requester.orgPath` subtree routing (cut, §3).
- Normalizing level scales across providers (v1 is provider-native).

## Owner Decisions — RESOLVED 2026-06-26
The owner delegated these to the implementer with the recommendations below; recorded here as the durable
decision of record (was "Before Build"; resolved before RA-1a starts).
1. **Target set = a seniority attribute + `requester.department` + `requester.role` (membership).**
   `managerLevel` deferred, `orgPath` cut. **SCOPE CORRECTION 2026-06-26: RA-1a ships `requester.department`
   ONLY** — see Decision 2 for why `level` defers and how seniority lands.
2. **`requester.level` = DEFERRED (SCOPE CORRECTION 2026-06-26 — no current directory source).** The
   pre-build code investigation found `directory_accounts` carries `name / nick / email / mobile /
   job_number / title / avatar_url / is_active / raw` — **no numeric seniority level** (the `level` fields
   in the codebase are sync-alert severity + department tree-depth, both unrelated). So `requester.level
   >= 5` has nothing to read and would fail publish for every DingTalk org. A numeric level needs a
   `title→rank` mapping or a real rank sync field FIRST. `requester.title` (string `==`/`!=`, a real
   directory source) is the leading seniority candidate — both go to a **separate title-vs-level
   design-lock**, NOT RA-1a.
3. **`requester.department` = name** (readable authoring — `requester.department == "财务"` is writable, an
   id is not). Rename-mutability is the accepted tradeoff; a stable-id variant is a future option.

## RA-1a / follow-on slice boundary (SCOPE-CORRECTED 2026-06-26)
- **RA-1a — `requester.department` ONLY.** `department`: `==` / `!=` ONLY, sourced from the
  directory-resolved primary department **name** (NOT the JWT/session `actor.department`).
- **Everything else fails closed at PARSE/PUBLISH — never silent runtime-absent:**
  - `requester.level`, `requester.role`, `requester.title`, and any attr ∉ {`department`} →
    **parse/publish reject** ("unknown/unsupported requester attribute"). None reach runtime as
    absent-in-context or silently ignored.
  - `requester.department in [...]`, the `in` operator, and array literals → **parse reject** (the grammar
    has none yet).
- **After RA-1a, in their own locks (NOT mixed with department):**
  - a **title-vs-level design-lock** — `requester.title` (string `==`/`!=`, real source) is the leading
    seniority candidate; numeric `requester.level` needs a `title→rank` map or a real rank sync field.
  - **RA-1b** — `requester.role` membership + the `in` operator + array literals.
  Until each lands, its tokens parse/publish fail-closed.
