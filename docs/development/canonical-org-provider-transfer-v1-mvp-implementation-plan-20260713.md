# Canonical Org & Provider Transfer v1 — MVP Implementation Sequencing Plan

Date: 2026-07-13
Milestone: **Canonical Org & Provider Transfer v1** (the SECOND milestone — distinct from DingTalk
Sync Hardening v1, which is a runtime-closeout milestone tracked by the DT-CLOSE tickets).
Baseline: `origin/main` (post-#4215 / #3944).
Status: **implementation-sequencing plan. Not started. Starts only after Hardening v1 is closed
(DT-CLOSE-01…05 done + owner go).**

This plan does NOT re-design anything — the design is already ratified-by-merge:

- **Wave 3 substrate**: `docs/development/local-directory-provider-canonical-org-anchor-development-plan-20260709.md` (#4215, merge `66c7459a8`).
- **Wave 4 transfer engine**: `docs/development/provider-org-transfer-development-plan-20260709.md` Rev 3 (#3944, merge `65ed5ef62`).
- **Wave 0 guard already on main**: `corp_id` immutable once set (#4181, merge `0e088d3b1`) — the transfer engine is the *only* supported way to change a set tenant.

It sequences those designs into shippable MVP increments, each with a done-gate, so the org line
lands incrementally (approval-routing parity first) instead of as a big-bang migration.

## 0. Two non-negotiable ordering constraints

1. **Hardening v1 must close first.** The org line depends on a healthy, observable directory sync
   (DT-CLOSE-01 restored that) and on the switch ledger (DT-CLOSE-04) being resolved — don't start
   org-substrate impl on an unclosed hardening milestone.
2. **Canonical Org MVP before Transfer MVP.** The transfer engine (Wave 4) rebinds provider handles
   *under* a stable local anchor; that anchor (the `provider='local'` substrate) must exist and have
   at least one real consumer (approval routing) proven at real-DB parity before any transfer code.

## 1. Canonical Org MVP (Milestone B, Part 1)

Owner scope: local integration + local departments/members/manager; department-binding table with
single-org FKs; explicit `(org, purpose)` routing with read-only preview; **approval routing reaches
local/DingTalk real-DB equivalence FIRST — do not migrate all consumers at once**; external
departments only produce reconciliation *suggestions*, and when they disappear only mark the binding
`stale` (never deactivate the local department).

| # | Increment | Builds on (#4215 §) | Done-gate | Risk / model |
| --- | --- | --- | --- | --- |
| **B1** | **Local provider bootstrap** — get-or-create one `provider='local'` integration per org; `corp_id = local:<org_id>` (immutable); the **at-most-one-active-local** partial unique index; no external creds, no scheduler | §5.1 | DB has exactly-cap-one enforced; two concurrent bootstraps can't both create; audit event on create | migration + service — Sonnet, Opus gate |
| **B2** | **Local departments + accounts + memberships** — CRUD on `directory_departments`/`directory_accounts`/`directory_account_departments` under the local integration; archive-not-delete; explicit primary department | §5.2–5.4 | membership idempotency; archive keeps history; NO manager in `raw` | Sonnet |
| **B3** | **Normalized manager relation** — the owner-ruled first-class `is_manager`/head relation (NOT `raw.leader_in_dept`); `ApprovalDirectoryOrg` reads it | §5.4 | approval routing resolves manager from the normalized relation; a real-DB test proves it | **Opus** (routing-core) |
| **B4** | **Department binding table** — `directory_department_bindings` with the **buildable FK chain** (binding carries both integration ids; `(dept,integration)`→`departments(id,integration)` + `(integration,org)`→`integrations(id,org)`, both sides; provider-role via trigger/redundant FK) | §5.5 | a cross-org binding is **impossible to insert** (FK rejects); real-DB test | **Opus** (data-integrity) |
| **B5** | **`(org, purpose)` routing policy + read-only preview** — stored policy; resolver picks canonical integration per purpose fail-closed; **preview shows before/after impacted approval/permission/attendance surfaces before any switch** | §6 | resolver never "array[0]"; fail-closed on unset; preview is read-only | **Opus** (governance) |
| **B6** | **Approval-routing local/DingTalk real-DB equivalence** (the FIRST consumer, not all) | §10.1 | seeded equivalent data → `provider='local'` produces the SAME requester dept/title/manager outputs as DingTalk; in-flight approvals keep baked routing; new ones follow the selected policy | **Opus** (parity proof) |
| **B7** | **External-provider reconciliation (suggest-only)** — DingTalk departments propose bindings; disappearance marks binding `stale`, never deactivates the local department | §9, §5.5 | stale-binding-not-inactive real-DB test; ambiguous match cannot auto-apply | Sonnet |

**Canonical Org MVP done-gate:** an org can run editable local org management on `directory_*`; approval
routing reads the local provider at proven real-DB parity with DingTalk; no other consumer is forced to
migrate; external providers are projections that suggest, not overwrite.

## 2. Transfer MVP (Milestone B, Part 2 — after Part 1)

Owner scope: transfer schema/API; source freeze; two-corp coexistence proof; single-transaction user
rebind; group-destination rebind/drop; admin workbench. **Never a direct `corp_id` edit** (the Wave 0
guard already forbids it). Feishu/WeCom drivers deferred until a named customer case.

| # | Increment | Builds on (#3944 §) | Done-gate | Model |
| --- | --- | --- | --- | --- |
| **T1** | **Schema + API skeleton** — `provider_org_transfers` + `provider_org_transfer_decisions` migrations; admin-only create/read/scan/dry-run/apply/cancel; **no-op adapter** + contract tests | §7, §6.3 | new tables + admin API; no real writes yet; audit on lifecycle | Sonnet, **Opus** gate |
| **T2** | **Source freeze** — freeze the source integration's sync while a transfer is active (the §12.2 deferral this unblocks) | §12.2 | an active transfer blocks the destructive absence sweep; real-DB test | **Opus** (sync-core) |
| **T2-Gate** | **Two-corp coexistence proof** — stage two DingTalk corps, one overlapping person; prove whether `directory_accounts(provider, external_key)` collides (unionId is union-scoped ⇒ expected to collide ⇒ tenant-scoped key `(provider, tenant_key, external_key)` almost certainly required) | §3.4 | **owner/ops + staging** — sandbox cannot create real corps; DB-level collision mechanism can be shown, the production proof cannot | — (gated) |
| **T3** | **Single-transaction user rebind** — clear source link WITHOUT deleting the identity, upsert the one `user_external_identities` row in place source→target, enable grant, link target — NOT public unbind+bind | §9.3 | real-DB atomic-rewrite mutation test; a target identity row exists after rebind (no next-login wait) | **Opus** (identity-core) |
| **T4** | **Group-destination rebind/drop** — rebind webhook+secret keeping `destinationId` stable; drop = disable | §10 | automation rule keeps `destinationId`; drop disables without touching the form | Sonnet |
| **T5** | **Admin workbench** — transfer list/detail, source/target selector, decision worklist, dry-run, apply progress | §13 | UI over the backend; dry-run required before apply | Sonnet + FE |

**Transfer MVP done-gate:** a tenant move is resumable, idempotent, auditable, reversible, and never a
direct `corp_id` edit; the two-corp key strategy is proven in staging; identity rebind is atomic.

## 3. What is explicitly deferred (YAGNI)

- **Feishu / WeCom directory drivers** — only on a named customer case; no premature plugin SPI.
- **Migrating every consumer** (permission scopes, member-group projection, attendance, automation) to
  the local anchor — Canonical Org MVP proves *approval routing* only; the rest follow per-purpose via
  the routing policy (§B5), not in one migration.

## 4. Model selection (per the goal)

- **Fable 5** — low-stakes drafting (this plan's prose, status docs).
- **Sonnet 5** — well-specified impl (bootstrap, CRUD, schema skeleton, group adapter, UI).
- **Opus 4.8** — every data-integrity / routing-core / identity-core / parity increment (B3–B6, T2, T3)
  and every adversarial gate. Rationale: the org anchor and the transfer's identity rewrite are the
  load-bearing correctness surfaces; gate them with the strongest reviewer.

## 5. How this runs (the goal loop, repeatable)

Each increment: recon → parallel model-by-difficulty lanes → adversarial Opus gate (refute-first,
load-bearing mutation) → land behind a done-gate → update this plan's status. Nothing lands without a
gate; nothing is claimed verified without a real-DB proof; the two milestones stay named separately.
