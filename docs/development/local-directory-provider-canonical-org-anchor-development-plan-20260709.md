# Local Directory Provider and Canonical Org Anchor Development Plan

Date: 2026-07-09 (committed 2026-07-12)
Status: development plan — **Wave 3 substrate** of the owner org-transfer roadmap
Baseline: `origin/main @ f676069716b6f980f65e418af17a48b61d39291d`
Primary goal: make MetaSheet's own organization model stable while keeping
DingTalk, WeCom, and Feishu as external directory providers.

**Roadmap position (owner review, 2026-07-12).** This is the **Wave 3** milestone —
the local canonical-org substrate — of the two-milestone org-transfer roadmap:
*DingTalk Sync Hardening v1* (Waves 0–2) then *Canonical Org & Provider Transfer v1*
(Waves 3–4). Wave 0 already delivered the stop-the-bleeding guard that protects the
anchors this plan builds on: `corp_id` is now **immutable once set** on a directory
integration, delivered in **PR #4181 (open, pending owner re-review — not yet on main)**.
The **Wave 4** org-transfer engine that consumes this substrate is specified in
`docs/development/provider-org-transfer-development-plan-20260709.md` (Rev 3). Brought
into committed docs per the Wave 0 task "bring the local-org plan into committed docs".

## 1. Executive Decision

MetaSheet should own a stable organization anchor, but it should not introduce a
second organization model outside the existing `directory_*` architecture.

The correct shape is:

1. Add an editable local directory provider using `provider = 'local'`.
2. Store local departments, memberships, and manager metadata in the same
   `directory_integrations`, `directory_departments`, `directory_accounts`, and
   `directory_account_departments` model.
3. Treat DingTalk, WeCom, and Feishu as external provider projections that can
   bind to the local organization anchor.
4. Move business consumers toward the local anchor when they need stable
   approval, permission, attendance, and automation semantics.

This extends the existing roadmap principle:

- preserve `directory_*` as the single organization source;
- do not build a second department tree;
- use `provider = 'local'` for future local org charts.

## 2. Why This Matters

Without a stable local organization anchor, every external provider becomes a
potential owner of business truth. That creates problems:

- switching DingTalk corp can break approval routing;
- adding WeCom or Feishu can duplicate organization concepts;
- historical approvals and attendance records can drift when an external
  department tree changes;
- access decisions become provider-specific instead of product-specific;
- form, automation, and member-group bindings cannot survive a provider switch
  cleanly.

With a local directory provider:

- local users, local departments, approval products, forms, sheets, and
  automation rules stay stable;
- DingTalk, WeCom, and Feishu identities are bindings, not the source of
  product truth;
- organization transfer becomes a reconciliation over bindings instead of a
  destructive rewrite;
- providers can coexist without forcing business logic to pick one provider's
  department IDs as canonical.

## 3. Existing Decisions To Preserve

The current documents already establish important constraints.

### 3.1 No Second Organization Model

The DingTalk hardening roadmap says:

- `directory_*` remains the organization source for DingTalk-backed approval
  routing.
- Future local org charts should use `provider = 'local'` on the same directory
  model.
- Replacing `directory_*` or building a separate organization tree is out of
  scope.

This plan keeps that rule.

### 3.2 Member Group Projection Still Has Value

Older DingTalk directory work intentionally projected selected DingTalk
departments into platform member groups instead of inventing a second local org
tree.

That remains useful for operational cohorts and permission groups. The local
directory provider does not replace member groups. Instead:

- local departments model the organization hierarchy;
- member groups model reusable access cohorts;
- projections can be generated from either local departments or external
  provider departments, depending on the configured source.

### 3.3 Org Transfer Uses Stable Anchors

The provider-agnostic org-transfer plan already treats local users, forms,
automation rules, approval products, sheets, and orgs as stable anchors. This
plan adds the missing organization anchor: local departments and memberships.

The Wave 0 corp_id-immutable guard (PR #4181, open) is the near-term protection for
the *external* side of that anchor: it forbids re-tagging a synced integration's
`corp_id` in place, so an org change cannot silently mass-deactivate the previous
organization before this substrate and the Wave 4 transfer engine exist. Once the
local anchor here is canonical, an external provider disappearing (or being
transferred) is a binding change, not a loss of product truth.

## 4. Design Model

Use three layers.

Local directory provider:

- editable `directory_integrations` row with `provider = 'local'`;
- local department rows in `directory_departments`;
- local user/account rows in `directory_accounts`;
- local membership rows in `directory_account_departments`;
- manager/head metadata in a shape compatible with approval routing.

External provider mirrors:

- DingTalk, WeCom, and Feishu integrations remain mirrored directories;
- their departments and accounts are snapshots of provider state;
- sync writes provider projection tables, not product truth directly.

Binding/reconciliation layer:

- maps external departments to local departments;
- maps external accounts to local users through existing account links;
- records decisions and confidence;
- supports provider switch and coexistence.

## 5. Data Model Proposal

### 5.1 Local Integration

Use `directory_integrations`:

```text
provider = 'local'
org_id = current local org id
corp_id = 'local:<org_id>'   # REQUIRED — directory_integrations.corp_id is NOT NULL
name = 'Local organization' or an admin-defined name
status = active
sync_enabled = false
config = { "mode": "editable", "source": "local" }
```

**`corp_id` for a local integration (owner design fix, Wave 3).** `directory_integrations.corp_id`
is `NOT NULL`, so a `provider='local'` row must supply one. Set it to an **immutable, deterministic
`local:<org_id>`** — never null, never a real external corp. This (a) satisfies the column, (b) is
compatible with a future tenant-scoped directory key `(provider, tenant_key, external_key)` where
`tenant_key = corp_id`, keeping local accounts in their own key space, and (c) inherits the same
immutability the Wave 0 guard enforces (PR #4181): once set it is never edited. The value is derived,
not admin-entered.

Rules:

- **exactly one active local integration per org — enforced in the DB, not by service convention:**
  a partial unique index
  `CREATE UNIQUE INDEX one_active_local_integration_per_org ON directory_integrations(org_id) WHERE provider='local' AND status='active';`
  (so two concurrent bootstraps cannot both create one);
- no external API credentials;
- no scheduler sync;
- local edit APIs own mutations.

### 5.2 Local Departments

Use `directory_departments` rows under the local integration.

Suggested field mapping:

```text
integration_id = local integration id
external_department_id = generated stable local department key
external_parent_department_id = parent local department key
name = department display name
order_index = admin-defined sort order
is_active = true/false
raw = {
  "source": "local",
  "metadata": {}
}
```

**Manager is NOT stored in `raw` (owner design fix — consistent with §5.4).** The department
head / manager link is the **normalized manager relation** described in §5.4, not
`raw.managerLocalUserIds` or a provider-shaped blob. Storing it in `raw` here would reproduce the
exact `raw.leader_in_dept` anti-pattern §5.4 rules out. `raw` on a local department carries only
provenance/metadata; the head is a first-class relation approval routing reads directly.

The term `external_department_id` is awkward for local rows, but reusing the
existing field avoids introducing a parallel tree. The value should be immutable
and generated by the app, for example `local:<uuid>`.

### 5.3 Local Accounts

Use `directory_accounts` rows under the local integration.

Suggested field mapping:

```text
integration_id = local integration id
provider = 'local'
external_user_id = local user id
external_key = <org_id>:<local_user_id>
name/email/mobile/title = copied from local user profile or editable local org profile
is_active = mirrors local org membership state
raw = {
  "source": "local",
  "localUserId": "..."
}
```

**No `leader_in_dept` in `raw` (owner design fix).** The account's manager/head status per
department lives in the **normalized manager relation** on the membership (§5.4), not a
`raw.leader_in_dept` array — for exactly the reason §5.4 rules out parsing a provider's raw JSON.
`raw` on a local account carries only provenance.

Then link the local directory account to the real platform user via
`directory_account_links`.

Important:

- Do not create `user_external_identities` for `provider = 'local'`; local users
  already authenticate through the normal local login/session path.
- Use `external_key = <org_id>:<local_user_id>` rather than only `local_user_id`
  so the unique `(provider, external_key)` index can support multi-org users.

### 5.4 Local Memberships

Use `directory_account_departments`.

Rules:

- one row per local account/local department membership;
- preserve or extend the existing `is_primary` semantics;
- primary department must be explicit, not inferred from array order;
- **the manager relationship is a normalized field/relation, not raw provider
  metadata.** Owner ruling (Wave 3, 2026-07-12): the manager/department-head link must
  not remain hidden inside DingTalk `raw.leader_in_dept`; it becomes a first-class,
  provider-neutral relation on the local membership (a typed `is_manager`/head flag on
  `directory_account_departments`, or a dedicated manager-relation row), so approval
  routing reads product truth rather than parsing a provider's raw JSON. It must stay
  compatible with `ApprovalDirectoryOrg` until that resolver is generalized to read the
  normalized relation. See §14 Q4 (now resolved).

### 5.5 Department Bindings

Add a small binding table for external provider departments.

Suggested table:

```sql
CREATE TABLE directory_department_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  local_department_id uuid NOT NULL REFERENCES directory_departments(id),
  external_integration_id uuid NOT NULL REFERENCES directory_integrations(id),
  external_department_id uuid NOT NULL REFERENCES directory_departments(id),
  provider text NOT NULL,
  binding_status text NOT NULL DEFAULT 'pending',
  match_strategy text NOT NULL DEFAULT 'manual',
  confidence numeric,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_department_id),
  UNIQUE (local_department_id, external_integration_id, external_department_id)
);
```

`binding_status` values:

- `pending`
- `linked`
- `ignored`
- `conflict`
- `stale`

**Single-org integrity — enforced in the DB, not by service convention (owner design fix).**
A binding is only meaningful within one org: the `local_department`, the `external_department`, and
**both** their integrations must all share the binding's `org_id`. That cannot be left to the service
layer. Enforce it structurally:

- `directory_departments` and `directory_integrations` both carry `org_id`; add composite foreign
  keys so the binding references `(local_department_id, org_id)` and
  `(external_department_id, org_id)` against `directory_departments(id, org_id)`, and
  `(external_integration_id, org_id)` against `directory_integrations(id, org_id)` — this makes a
  cross-org binding **impossible to insert**, not merely discouraged. (Requires the referenced
  tables to expose `UNIQUE (id, org_id)`, which is trivially true since `id` is already unique.)
- Equivalently, a `BEFORE INSERT/UPDATE` trigger asserting all four `org_id`s match — but composite
  FKs are preferred (declarative, no trigger drift).

This pairs with the **one-active-local-integration-per-org** partial unique index from §5.1: together
they guarantee an org has exactly one local anchor and that every external→local department binding
stays inside that org's boundary.

Why a binding table is needed:

- `directory_account_links` already maps provider accounts to local users.
- There is no equivalent for provider departments to local departments.
- Org transfer and multi-provider coexistence need explicit department mapping.

## 6. Read Model and Routing Policy

Adding `provider = 'local'` creates multiple possible organization providers in
one org. Business consumers must not guess.

**Owner ruling (Wave 3, 2026-07-12): routing is by explicit `(org, purpose)` policy,
never "take array[0]" / "first linked account wins" / "latest active integration".**
When more than one directory integration exists for an org, the canonical source for
each purpose (approval routing, permission scope, attendance expansion, member-group
projection, automation recipient resolution) is chosen by stored policy, resolved
fail-closed with an operator-visible error if unset — not by array position.

Add an explicit routing policy:

```text
org_directory_routing_policy
  org_id
  purpose
  canonical_integration_id
  fallback_integration_id
  mode
```

Possible `purpose` values:

- `approval_routing`
- `permission_scope`
- `attendance_expansion`
- `member_group_projection`
- `automation_recipient_resolution`

Initial mode:

- `dingtalk` remains current behavior;
- `local` can be enabled per purpose after parity tests pass.

This avoids accidental "first linked account wins" or "latest active
integration" behavior.

## 7. API Surface

Suggested admin routes:

```http
POST /api/admin/directory/local/integration
GET  /api/admin/directory/local/tree
POST /api/admin/directory/local/departments
PATCH /api/admin/directory/local/departments/:departmentId
POST /api/admin/directory/local/departments/:departmentId/archive
POST /api/admin/directory/local/memberships
PATCH /api/admin/directory/local/memberships/:membershipId
GET  /api/admin/directory/department-bindings
PATCH /api/admin/directory/department-bindings/:bindingId
GET  /api/admin/directory/routing-policy
PATCH /api/admin/directory/routing-policy/:purpose
```

All routes must be admin-only and audit logged.

No local org edit route should call DingTalk, WeCom, or Feishu directly.

## 8. UI Surface

Phase 1 UI should be practical, not a full HR suite.

Views:

- local org tree editor;
- member list for selected department;
- manager/department-head assignment;
- external department binding review;
- routing-policy settings;
- diff preview before applying external-provider suggestions.

UI principles:

- show local department name and provider department name side by side;
- never auto-link ambiguous departments;
- preserve local departments when provider departments disappear;
- archive, do not hard delete;
- show impacted approval/permission/attendance surfaces before routing-policy
  changes.

## 9. Provider Reconciliation

External providers should propose bindings, not silently rewrite local
organization structure.

Suggested matching signals:

- exact department name under same parent;
- normalized department path;
- manually stored provider external id;
- stable historical binding;
- admin-selected match.

Do not auto-match on name alone when multiple candidates exist.

Decision outcomes:

- link external department to local department;
- create new local department from external department;
- ignore external department;
- mark conflict;
- leave pending.

For accounts, reuse `directory_account_links` and existing user binding
workflows.

## 10. Consumer Migration Plan

### 10.1 Approval Routing

Current DingTalk approval routing reads `directory_accounts`,
`directory_departments`, and raw manager metadata.

Migration:

1. Keep DingTalk as the default canonical integration.
2. Add routing policy support.
3. Add tests proving `provider = 'local'` produces the same requester
   department/title/manager outputs as DingTalk for seeded equivalent data.
4. Switch orgs purpose-by-purpose.

Important:

- in-flight approvals keep baked routing snapshots;
- new approvals use the selected canonical routing policy;
- historical approval instances are not rewritten.

### 10.2 Permission Scopes

Delegated admin scopes already reference `directory_departments`.

Migration:

- allow scopes to target local provider departments;
- preserve existing DingTalk department scopes;
- add a migration helper that proposes local equivalents through
  `directory_department_bindings`;
- do not silently rewrite permission scopes.

### 10.3 Member Groups

Current DingTalk department-to-member-group projection should remain available.

New behavior:

- local departments can also project to member groups;
- external provider projections should prefer local bindings when present;
- direct DingTalk-to-member-group projection stays as compatibility mode.

### 10.4 Attendance

Attendance expansion should move toward local departments for stability.

Rules:

- a schedule group can target local departments;
- provider department targets remain supported through bindings;
- external provider disappearance does not delete local attendance targets.

### 10.5 Automation

Automation recipient resolution should prefer local users/groups, with provider
delivery adapters used only at send time.

Example:

- rule targets local department "Sales";
- DingTalk delivery resolves Sales members to DingTalk user IDs through current
  account bindings;
- later WeCom delivery can use the same local target and a different provider
  binding.

## 11. Development Phases

### Phase 0: Design Lock

Deliverables:

- ratify `provider = 'local'` as the canonical org anchor strategy;
- confirm no new parallel org tree tables;
- inventory all consumers that read `directory_departments` directly;
- decide which purpose switches first, likely approval routing or member-group
  projection.

Exit criteria:

- owner-approved design doc;
- no unresolved conflict with the DingTalk hardening roadmap or org-transfer
  plan.

### Phase 1: Local Provider Bootstrap

Deliverables:

- create/get local directory integration per org;
- create/update/archive local departments;
- create/update local account rows for existing local users;
- create/update local memberships and primary department;
- audit events for all mutations.

Tests:

- migration/upsert tests;
- local integration uniqueness;
- archive does not delete historical rows;
- membership idempotency.

### Phase 2: Department Binding Table

Deliverables:

- `directory_department_bindings` migration;
- binding repository/service;
- manual bind/unbind/ignore endpoints;
- review list for unmapped external departments.

Tests:

- one external department maps to at most one local department;
- stale external department does not delete local department;
- ambiguous match stays pending.

### Phase 3: Routing Policy

Deliverables:

- routing-policy storage;
- resolver that selects canonical integration per purpose;
- read-only preview for each purpose before switching.

Tests:

- approval routing reads the selected canonical integration;
- fallback behavior is explicit;
- missing local provider fails closed with an operator-visible error.

### Phase 4: Consumer Adoption

Deliverables:

- approval routing local-provider parity;
- delegated scope support;
- member-group projection from local departments;
- attendance target expansion from local departments;
- automation recipient resolution using local anchors.

Tests:

- seeded DingTalk/local equivalent data produces equivalent approval outputs;
- permission scope previews show before/after impacted users;
- attendance expansion remains stable after external provider deactivation;
- automation target remains stable across provider delivery switch.

### Phase 5: External Provider Reconciliation

Deliverables:

- DingTalk department-to-local suggestions;
- WeCom and Feishu provider drivers can reuse the same binding table;
- provider switch/transfer consumes local department bindings.

Tests:

- external provider disappearance marks binding stale, not local department
  inactive;
- provider transfer preserves local department IDs;
- ambiguous provider mapping cannot auto-apply.

## 12. Safety Invariants

- Never hard delete local departments in normal admin flows.
- Never let provider sync directly rewrite local department hierarchy without a
  review decision.
- Never let a disappeared external provider department deactivate the local
  department.
- Never select a canonical directory integration implicitly when more than one
  provider exists.
- Keep drop behavior reversible: disable/archive, do not delete.
- Keep audit logs secret-safe and provider-neutral.

## 13. Verification Matrix

| Area | Required evidence |
| --- | --- |
| Local provider bootstrap | Integration + route tests |
| Local department CRUD | Unit + API tests, archive not delete |
| Local account/membership | Real DB membership tests |
| Department bindings | Migration + uniqueness + conflict tests |
| Routing policy | Resolver unit tests + route tests |
| Approval parity | Real DB seeded DingTalk/local equivalence test |
| Permission scopes | Preview and no-silent-rewrite tests |
| Member group projection | Local department projection test |
| Attendance expansion | Stable local target test |
| Automation recipients | Local target, provider delivery adapter test |
| Provider disappearance | Stale binding, local anchor preserved test |

## 14. Open Questions

1. Should every org get a local directory integration automatically, or only when
   the admin enables local org management?
2. Should local departments be editable only by platform admins, or can delegated
   org admins edit scoped subtrees?
3. Should title/position live on local directory accounts, users HR profile, or a
   separate local employment profile?
4. ~~How should local manager assignment be represented long term?~~ **Resolved
   (owner ruling, Wave 3, 2026-07-12):** a normalized, provider-neutral field/relation
   on the local membership — not raw provider metadata (`raw.leader_in_dept`). See §5.4.
   Remaining sub-choice (typed flag column vs. dedicated relation row) is an
   implementation detail for Phase 1's schema PR.
5. Which purpose switches first: approval routing, member-group projection,
   permission scopes, attendance, or automation?

## 15. Acceptance Criteria

The first production-ready local directory provider release is acceptable when:

1. An org can create an editable `provider = 'local'` directory integration.
2. Admins can manage local departments and memberships without touching DingTalk,
   WeCom, or Feishu.
3. Local departments and accounts use the existing `directory_*` tables.
4. External provider departments can be manually bound to local departments.
5. Business consumers select the canonical organization source through explicit
   routing policy.
6. At least one consumer, preferably approval routing or member-group projection,
   reads from the local provider with real DB parity tests.
7. External provider sync cannot delete or silently rewrite local organization
   anchors.
8. Provider transfer can preserve local department IDs while changing external
   provider bindings.
