# ADR — Spike 1: Principal lifecycle for service / non-human principals

- Status: DRAFT (design spike — not wiring)
- Date: 2026-08-20
- Baseline: main @ `c5a4a94f7` (frozen)
- Scope: data model + pure authorization logic for non-human principals (automation, integration, connector, system_migration, generic service). **No application code modified.**

---

## 1. Context

### 1.1 What exists today (grounded in the frozen baseline)

**Identity is a free-form string with no lifecycle, no table, no tenant binding.**

- `DataSourceManager.assertAccess(id, ownerId)` — `packages/core-backend/src/data-adapters/DataSourceManager.ts:380` — compares **only** `scope.ownerId !== ownerId`. The scope object also carries `workspaceId` (set at `:371` `this.scopes.set(id, { ownerId, workspaceId: workspaceId ?? null })`) but `assertAccess` **never reads it**. So the tenant/workspace dimension is *stored but unenforced* — a principal string alone is the entire access decision.
- `requirePrincipal(principal)` — `packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:149` — is fail-closed on the *presence* of a principal string but treats it as an opaque `string`. It explicitly refuses to substitute a default/system/tenant/admin identity (`:150-158`). There is **no notion that a principal can be revoked** — a string that was valid yesterday is valid forever.
- `field_permissions` — `packages/core-backend/src/db/migrations/zzzz20260411140100_create_field_permissions.ts:18` — models subjects as `subject_type CHECK (subject_type IN ('user', 'role'))` + `subject_id text`. There is **no `service`/`principal` subject kind**; a non-human actor can only masquerade as a `user`.
- `meta_record_revisions.actor_id text` — `packages/core-backend/src/db/migrations/zzzz20260430172000_create_meta_record_revisions.ts:15` — is a **nullable free-text column with no foreign key**. `automation-executor.ts` writes it as `context.actorId ?? null` (e.g. `:2430`, and OD-3 note at `:2422-2423`: "NEVER a fabricated system actor for an actor-less trigger"). Historical audit rows therefore point at an actor id by *value*, not by reference.
- Tenancy today = **two overlapping notions**, neither a hard column on business objects:
  - `workspace_id text` (nullable) on `meta_bases` (`zzzz20260318110000...:11`) and `data_sources` (`20251206000001_create_data_sources_table.ts` `owner_id text NOT NULL`, `workspace_id text` nullable).
  - `tenantId: string` used only for **shard routing** via `AsyncLocalStorage` — `packages/core-backend/src/db/sharding/tenant-context.ts:20`. It never lands in a table column or a constraint.
- Revoke pattern that DOES exist: `multitable_api_tokens` (`zzzz20260414100002...:16-17`) has `revoked boolean NOT NULL DEFAULT false` + `revoked_at timestamptz`. This is the closest existing precedent and we mirror it.

### 1.2 The gap

There is no first-class, tenant-scoped, revocable **principal** entity. Non-human actors (an automation runner, a connector, a migration job) are represented only as bare `actorId` / `ownerId` strings. Consequences:

1. **No tenant safety.** Because the identity is a bare string and `assertAccess` ignores `workspaceId`, nothing at the DB layer prevents a grant in tenant A from naming a principal that "belongs" to tenant B. Cross-tenant confusion is possible today and can only be caught (imperfectly) in app code.
2. **No revocation.** Killing a compromised connector means find-and-replace on strings; historical audit and live grants can't be told apart.
3. **Audit ambiguity.** `actor_id` is a value with no anchor. If an id were ever reused, old revisions would silently re-attribute to a new subject.

---

## 2. Decision

### 2.1 One unified `service_principals` table (reverse-FK), NOT per-object subtype tables

Create a **single** `service_principals` table with a `kind` discriminator (`automation | integration | connector | system_migration | service`). Business/binding objects point **into** it (reverse FK: the grant/binding holds `principal_id`), rather than each principal-bearing object owning its own subtype table.

Chosen name: **`service_principals`** (rejected `non_human_principals` as clumsy in SQL/joins, and `automation_principals` as too narrow — the subjects explicitly include integration, connector, and system_migration, per the task).

### 2.2 Tenant consistency is enforced by the database, not the app

- Every principal row carries a non-null `tenant_id`.
- `service_principals` declares a **composite unique key `UNIQUE (id, tenant_id)`** in addition to its `PRIMARY KEY (id)`. The composite key is redundant for uniqueness (id is already unique) but exists **solely to be the target of a composite foreign key**.
- Every binding/grant object (here: `writer_grants`) carries **both** `principal_id` and its own `tenant_id`, and declares a **composite FK `(principal_id, tenant_id) REFERENCES service_principals (id, tenant_id)`**.
- Result: a row in tenant A cannot reference a principal whose `tenant_id` is B — the composite FK has no matching parent row, so **PostgreSQL rejects the INSERT/UPDATE**. Cross-tenant grant is impossible at the storage layer, independent of any application check. This is the same shape recommended for `meta_bases`/`data_sources` once they gain a real `tenant_id`.

### 2.3 Ownership / binding rules (1:1)

- **A binding resolves to exactly one principal** (`writer_grants.principal_id` is `NOT NULL`, single-valued).
- **A principal MAY back multiple bindings** (1 principal : N grants) — a connector legitimately holds several writer grants. So "shared" means *shared across grants*, never *shared across tenants* (forbidden by 2.2) and never *re-pointable* (see rebinding below).
- **Rebinding a grant to a different principal is FORBIDDEN for security principals.** `principal_id` on `writer_grants` is immutable: enforced by a `BEFORE UPDATE` trigger that raises if `NEW.principal_id <> OLD.principal_id`. To "move" a grant you revoke the old grant and create a new one — preserving an auditable break instead of a silent re-attribution.

### 2.4 Delete / revoke / audit rules

- **Delete-binding = revoke, never physical delete.** A grant is retired by stamping `revoked_at timestamptz` (mirrors `multitable_api_tokens.revoked_at`). Rows are never `DELETE`d in normal operation. Same for principals: a principal is retired via `service_principals.revoked_at`, not `DELETE`.
- **Historical revisions still resolve the original principal.** Because principals are never physically deleted and ids are never reused, `meta_record_revisions.actor_id` (free text, no FK — kept that way deliberately so old audit rows never break) can always be resolved back to the *original* `service_principals` row, revoked or not. Revocation changes **authorization**, not **identity/history**.
- **Revoke invalidates live authority.** A revoked principal (or grant) must fail every *new* write/authorization decision. This is the core of the pure function in §Prototype: `revoked_at IS NOT NULL` ⇒ deny, regardless of grant validity.
- **Principal id is never reused.** Ids are `gen_random_uuid()`; retirement is a soft state. Reuse would let a new subject inherit a retired subject's audit trail — forbidden. (A partial unique index / documented invariant records this; UUIDs make accidental reuse effectively impossible, and we never recycle deliberately.)

---

## 3. Alternatives considered

### A. Per-object subtype tables (`automation_principals`, `connector_principals`, …) — REJECTED
- **Pros:** each subtype can carry bespoke columns; no discriminator column.
- **Cons:** every consumer (grants, revisions, field_permissions, audit) would need a polymorphic union or N nullable FKs to reference "some principal". The composite-tenant-FK trick (§2.2) would have to be duplicated per table. `actor_id` resolution would fan out across tables. Adding a new subject kind = new table + new migration + new join everywhere. Poor fit for the reverse-FK requirement.

### B. Extend `field_permissions.subject_type` to add `'service'` and stop there — REJECTED
- **Pros:** minimal; reuses an existing table.
- **Cons:** `field_permissions` is *field-scoped access*, not an identity registry. It has no lifecycle (no `revoked_at`), no tenant column, no place to record `kind`. It answers "what can subject X see", not "does subject X still exist / is it revoked". Does not solve revoke, tenant-FK, or audit resolution.

### C. Reuse `multitable_api_tokens` as the principal — REJECTED
- **Pros:** already has revoke/`revoked_at`, `created_by`.
- **Cons:** a token is a *credential*, not an *identity*. A principal outlives and owns many tokens (§Spike relationship). Tokens rotate; the principal must not. Conflating them means rotating a token would orphan history. Tokens also lack `tenant_id` and `kind`.

### D. Unified table, single-column FK only (no composite tenant FK) — REJECTED
- **Pros:** simpler schema.
- **Cons:** tenant consistency would rely entirely on application code — exactly the class of bug the spike targets (`assertAccess` already ignores `workspaceId`). The composite FK moves the guarantee into the engine, where it cannot be forgotten.

---

## 4. Consequences

**Positive**
- Cross-tenant grants become a DB-level impossibility (composite FK), not an app convention.
- Revocation is uniform and reversible-safe: authority dies, identity/history survives.
- One place to add a new non-human subject kind (a `kind` enum value), no new tables.
- `meta_record_revisions.actor_id` stays untouched (still free text, no FK) so no historical row can be broken by a principal state change — resolution is a *lookup*, not a *constraint*.

**Negative / costs**
- Introduces a real `tenant_id` on the new tables while the rest of the schema still uses `workspace_id`/shard `tenantId`. A follow-up is needed to reconcile (is `tenant_id` == `workspace_id`? == shard tenant?). Flagged as open question.
- Composite FKs require both columns indexed on the parent; slightly more storage.
- The immutability trigger on `principal_id` adds write-path surface (a trigger) — must be covered by tests.
- Existing bare-string `ownerId`/`actorId` call sites are NOT migrated by this spike; a later slice must backfill/adapt (out of scope, no app code touched).

---

## 5. Open questions

1. **Tenant identity source of truth.** Does `service_principals.tenant_id` map to `meta_bases.workspace_id`, to the shard `tenantId` (`tenant-context.ts:20`), or a new canonical tenant table? The migration draft treats it as an opaque `text` NOT NULL; the reconciliation is deferred.
2. **`actor_id` resolution contract.** Should there be a nullable *advisory* FK-less index/view (`actor_id -> service_principals.id`) for fast audit joins, accepting that human actors and legacy strings won't resolve? Prototype assumes a plain lookup that may return "unresolved".
3. **Human vs non-human unification.** Do human users eventually share this table (with `kind='user'`) or stay separate? Spike scopes to non-human only.
4. **Grant → token relationship.** Should `writer_grants` reference `multitable_api_tokens` so revoking a principal cascades a token-invalidation flag, or is token invalidation a separate projection off `revoked_at`? Spike models revocation state on the principal; token cascade is left as an app-layer projection.
5. **Rebinding for non-security principals.** The immutability trigger forbids rebinding for all kinds; do low-sensitivity kinds (e.g. `system_migration`) ever need rebind? Currently: no — revoke+recreate for everyone.
