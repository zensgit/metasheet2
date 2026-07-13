# Provider-Agnostic Organization Transfer Development Plan

Date: 2026-07-09
Status: development plan, Rev 3
Rev 3 (2026-07-12): owner's permanent-immutable `corp_id` rule absorbed (§12.1, no probe, no escape hatch); local-canonical-org substrate formalized (§4.1, `org_id` as anchor).
Baseline: `origin/main @ 8c15b8bf80ac0c6107615d6db73ce9e37dd66d6c`
Primary provider: DingTalk
Future providers: WeCom, Feishu

## 1. Executive Decision

Organization transfer is feasible, but it must not be implemented as an in-place
`corp_id` edit on an integration. Once `corp_id` is non-empty on a
`directory_integrations` row it is permanently immutable (§12.1) —
unconditionally, from the instant it is first set, with no escape hatch — so a
transfer can only ever be a workflow across rows, never an edit of one row.

The correct model is a first-class transfer workflow:

1. Keep local product entities as the stable anchors.
2. Build an inventory of provider-scoped bindings that currently point at the
   old tenant.
3. Ask an admin to decide, item by item, whether each binding should be rebound,
   dropped, or left pending.
4. Apply those decisions idempotently with audit records, dry-run output, and
   rollback-friendly behavior.

For DingTalk, this means the local user, form, automation rule, approval product,
sheet, and org remain stable. Only the external handles change: DingTalk user
identity, group webhook, work-notification credential, approval-card target,
department projection, and member group projection.

The same transfer engine can later support WeCom and Feishu. The shared part is
the reconciliation engine and decision model. The provider-specific part is a
thin driver that knows how to discover identities, validate credentials, and
describe provider-native handles.

## 2. Why Not Edit `corp_id` Directly

At the Rev 2 baseline the code allowed `corp_id` to be updated on a directory
integration:

- `packages/core-backend/src/directory/directory-sync.ts`
  - `updateDirectoryIntegration`
  - SQL update includes `corp_id = $4`

(Rev 3: the guardrail branch closes this path — `corp_id` is permanently
immutable once set, see §12.1.)

That is dangerous for any integration — whether or not it has synced records —
because several downstream behaviors assume the integration represents one
stable external tenant.

Known hazards:

1. Directory sync marks accounts and departments inactive when they are not seen
   in the latest sync window.
2. Existing local users may still hold old provider identities.
3. Group destinations have no provider tenant identity and cannot be auto-mapped.
4. Approval and notification routing may continue to point at stale provider
   handles.
5. A partial sync failure can leave a mixed old/new tenant state.

The transfer workflow should treat tenant change as a controlled migration, not
as ordinary integration configuration editing.

## 3. Current Code Facts

This section captures the facts the implementation must preserve.

Anchor-freshness note (Rev 3): the code citations in this plan were captured at
the Rev 1/Rev 2 baseline; main has since moved roughly 266 commits, and the
`corp_id` guardrail branch landed in parallel. File/function facts below remain
directionally correct, but re-verify specific anchors against current main
before implementing against them.

### 3.1 Provider-Tagged User Identity Already Exists

The following tables are already provider-aware:

- `directory_integrations`
- `directory_accounts`
- `user_external_identities`
- `user_external_auth_grants`

Important uniqueness rules:

- `directory_accounts` has a unique provider/external-key index.
- `user_external_identities` has a unique provider/external-key index.
- `user_external_identities` also has a unique local-user/provider constraint.

This means the schema already supports one local user owning identities from
multiple providers. The transfer substrate should preserve that direction and
avoid a DingTalk-only engine.

### 3.2 Directory Bind Already Writes Login Identity

`bindDirectoryAccount` does more than link a directory account. It delegates to
`applyDirectoryAccountBindInTransaction`, which can update or insert
`user_external_identities` and enable `user_external_auth_grants`.

Design consequence:

- The existing bind path proves the target DingTalk login identity can be
  created before the next login.
- A transfer adapter must not call the public bind path while the user is still
  linked to the source account, because that bind path rejects another linked
  account for the same local user/provider.
- The transfer adapter should reuse the bind path's identity-key construction,
  conflict checks, profile shape, and grant upsert semantics inside a dedicated
  transfer transaction.
- The transfer plan must not assume the target login identity is only recreated
  lazily on first login.
- Accounts that lack usable `open_id` or `union_id` remain blocked or require a
  provider-specific fallback.

### 3.3 Directory Unbind Removes Old Identity

`unbindDirectoryAccount` removes the old `user_external_identities` record,
optionally disables the external auth grant, and resets the local directory link
to `unmatched`.

Design consequence:

- A clean user transfer must not naively compose public unbind and bind calls.
- Public unbind deletes the identity row; public bind refuses to run while the
  source account is still linked.
- The transfer engine needs a dedicated single-transaction rebind primitive that
  clears the source link, rewrites the one provider identity row from source to
  target, and links the target account atomically.

### 3.4 Directory Account External-Key Collision Needs Proof

Directory account sync currently derives `external_key` from:

1. `unionId`
2. `openId`
3. `userId`

Because `directory_accounts` is unique on `(provider, external_key)`, two active
DingTalk corp integrations could collide if the same person has the same
provider-level identity in both corps.

Design consequence:

- Before implementing cross-corp coexistence in production, run a staging proof
  with two DingTalk corps.
- If collisions occur, the directory-account key strategy must become tenant
  scoped, for example `(provider, tenant_key, external_key)`.
- Do not rely on this assumption silently.

### 3.5 Group Destinations Are Local Anchors, Not Provider Identities

`dingtalk_group_destinations` stores local destination configuration such as:

- `id`
- `name`
- `webhook_url`
- `secret`
- `enabled`
- `created_by`
- `sheet_id`
- `org_id`
- timestamps/status fields

It does not store:

- provider
- corp id
- integration id
- provider-native group id
- cross-org group identity

Automation rules keep a local `destinationId` in the action config.

Design consequence:

- A group destination cannot be automatically moved to a new DingTalk corp.
- Admins must either paste a new webhook/secret and rebind the same local
  destination, or drop it by disabling the destination.
- The local destination row should usually remain the anchor so existing
  automation rules do not need to be rewritten.

## 4. Product Model

The transfer workflow is a reconciliation process over bindings.

Core terms:

- Provider: `dingtalk`, later `wecom` or `feishu`.
- Tenant: a provider-side organization, for example a DingTalk corp.
- Source integration: the current integration connected to the old tenant.
- Target integration: the prepared integration connected to the new tenant.
- Local anchor: a local entity that should survive the transfer.
- Binding: a provider-scoped handle attached to a local anchor.
- Decision: admin choice for one binding.
- Apply: idempotent execution of one or more decisions.

Decision states:

- `pending`: no decision yet.
- `rebind`: attach the local anchor to a target-tenant handle.
- `drop`: disable the provider binding without deleting the local anchor.
- `blocked`: cannot be applied until missing information is supplied.

Apply states:

- `pending`
- `applying`
- `applied`
- `skipped`
- `failed`

Default behavior should be conservative:

- Unknown bindings default to `pending`, not `rebind`.
- Destructive-looking operations are implemented as disable/unlink, not delete.
- Bulk apply requires a dry-run summary.

### 4.1 Local-Canonical-Org Substrate: `org_id` Is the Anchor (Rev 3)

The true stable anchor above any provider/corp binding is the local canonical
org: `org_id`. The schema already enforces this direction —
`directory_integrations` carries a unique index on `(org_id, provider, name)`
(`idx_directory_integrations_org_provider_name`), so every integration row is
born scoped to exactly one permanent local org.

With `corp_id` permanently immutable per row (§12.1), each
`directory_integrations` row becomes a single-tenant-for-life, corp-pinned
satellite of one permanent `org_id`. The row's identity — "this org's window
into that specific corp" — is fixed at creation for the row's whole life.

Consequences:

- A transfer can NEVER be "edit the row". The only shape a transfer can take
  is: stand up a new satellite row (bound to the new corp), reconcile bindings
  from the old satellite to the new one, retire the old satellite.
- "Transfer" is therefore reconciliation-over-satellites, not
  mutation-of-anchor. The anchor — `org_id` and the local entities hanging off
  it — never moves; only which satellite rows orbit it changes.
- This should inform §7: `provider_org_transfers` keys on `org_id` (the
  `org_id` column in the proposed schema is not incidental — it is the primary
  scoping key). A transfer is scoped to one canonical local org, which is
  meaningful even before any provider integration exists for that org, and is
  not merely derived from the source/target integration ids.

## 5. Functional Scope

### 5.1 Phase 1 Scope

Phase 1 should support two high-value binding types:

1. User identity transfer.
2. DingTalk group destination transfer.

These cover the highest user-visible risks:

- Users losing login/access after corp change.
- Existing automation rules continuing to send to old group webhooks.

### 5.2 Later Scope

Later binding adapters:

- Work-notification app credentials.
- Approval-card delivery configuration.
- Approval route materialized handles.
- Department projections.
- Member group projections.
- Provider-specific attendance or HR handles.

### 5.3 Non-Goals

Do not implement a full plugin SPI before a second provider is real.

Do not try to infer every target binding automatically. Some resources,
especially group webhooks, require explicit admin confirmation because the old
provider handle has no stable identity in the new tenant.

Do not delete local anchors during transfer.

## 6. Architecture

### 6.1 Components

The implementation should be split into four layers.

Transfer service:

- Owns transfer lifecycle.
- Owns scan, decision, dry-run, and apply flows.
- Enforces idempotency and status transitions.
- Emits audit records and operational metrics.

Binding adapters:

- One adapter per binding kind.
- Know how to discover affected bindings.
- Know how to validate a proposed target.
- Know how to apply `rebind` or `drop`.

Provider driver:

- Thin provider-specific facade.
- DingTalk first.
- Later WeCom and Feishu.
- Should not contain transfer state machine logic.

Admin API/UI:

- Creates transfer plans.
- Displays binding inventory.
- Collects decisions.
- Runs dry-run/apply.
- Shows apply progress and errors.

### 6.2 Suggested Backend Shape

New module:

```text
packages/core-backend/src/directory-transfer/
  transfer-service.ts
  transfer-types.ts
  transfer-repository.ts
  providers/
    dingtalk-transfer-driver.ts
  adapters/
    user-identity-adapter.ts
    dingtalk-group-destination-adapter.ts
  routes.ts
```

The route module should be mounted under an admin-only directory namespace, for
example:

```text
/api/admin/directory/org-transfers
```

### 6.3 Suggested API

Create transfer:

```http
POST /api/admin/directory/org-transfers
```

Request:

```json
{
  "provider": "dingtalk",
  "sourceIntegrationId": "uuid",
  "targetIntegrationId": "uuid"
}
```

Read transfer:

```http
GET /api/admin/directory/org-transfers/:transferId
```

Scan bindings:

```http
POST /api/admin/directory/org-transfers/:transferId/scan
```

Update decision:

```http
PATCH /api/admin/directory/org-transfers/:transferId/decisions/:decisionId
```

Request examples:

```json
{
  "decision": "rebind",
  "target": {
    "directoryAccountId": "uuid"
  }
}
```

```json
{
  "decision": "rebind",
  "target": {
    "webhookUrl": "https://oapi.dingtalk.com/robot/send?...",
    "secret": "submitted-once-and-encrypted-immediately"
  }
}
```

For group-destination decisions, the raw secret is accepted only at PATCH time.
The handler must immediately encrypt it through the existing destination
credential path, or through an explicitly encrypted pending-secret column if one
is introduced. `proposed_target` stores only a masked summary and stable
references. Plaintext secrets must never be stored in the decision JSON.

Dry-run apply:

```http
POST /api/admin/directory/org-transfers/:transferId/apply?dryRun=true
```

Apply:

```http
POST /api/admin/directory/org-transfers/:transferId/apply
```

Cancel:

```http
POST /api/admin/directory/org-transfers/:transferId/cancel
```

## 7. Data Model Proposal

Use explicit transfer records rather than deriving state from ad hoc JSON in
integration rows.

### 7.1 `provider_org_transfers`

Suggested columns:

```sql
CREATE TABLE provider_org_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  provider text NOT NULL,
  source_integration_id uuid NOT NULL REFERENCES directory_integrations(id),
  target_integration_id uuid NOT NULL REFERENCES directory_integrations(id),
  source_tenant_key text,
  target_tenant_key text,
  status text NOT NULL DEFAULT 'draft',
  freeze_source_sync boolean NOT NULL DEFAULT true,
  dry_run_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz,
  applied_at timestamptz,
  cancelled_at timestamptz,
  last_error text
);
```

Required constraints:

- Provider must be a known provider.
- Source and target integrations must be different.
- Source and target integrations must belong to the same local org boundary.
- Only one active transfer should exist for the same source/target pair.
- Only one active transfer should exist for a given source integration.

### 7.2 `provider_org_transfer_decisions`

Suggested columns:

```sql
CREATE TABLE provider_org_transfer_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES provider_org_transfers(id) ON DELETE CASCADE,
  binding_kind text NOT NULL,
  source_anchor_type text NOT NULL,
  source_anchor_id text NOT NULL,
  source_handle jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_target jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision text NOT NULL DEFAULT 'pending',
  apply_status text NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  applied_at timestamptz,
  apply_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, binding_kind, source_anchor_type, source_anchor_id)
);
```

`source_handle` and `proposed_target` should contain masked provider metadata.
Never store raw secrets in these JSON fields. Store encrypted secrets only in the
owning credential/destination table or in a purpose-built encrypted pending
secret field. For group rebind, PATCH must persist the encrypted secret
immediately and leave only masked metadata in `proposed_target`.

## 8. Binding Adapter Contracts

Each adapter should implement the same conceptual contract.

```ts
export interface TransferBindingAdapter {
  readonly kind: TransferBindingKind;

  scan(ctx: TransferContext): Promise<TransferDecisionSeed[]>;

  validateDecision(
    ctx: TransferContext,
    decision: TransferDecisionInput,
  ): Promise<TransferDecisionValidation>;

  applyDecision(
    ctx: TransferApplyContext,
    decision: TransferDecisionRecord,
  ): Promise<TransferApplyResult>;
}
```

Adapter requirements:

- `scan` must be deterministic and safe to rerun.
- `validateDecision` must not mutate provider or local state.
- `applyDecision` must be idempotent.
- Every adapter must support `dryRun`.
- Every adapter must describe what it did in audit-safe language.

## 9. User Identity Adapter

### 9.1 Scan

The adapter should find local users that are bound to source integration
directory accounts and classify them:

- Target account confidently matched.
- Multiple target candidates.
- No target candidate.
- Source account lacks login identity material.
- Existing target identity conflict.

Candidate matching can use:

- verified email
- mobile phone
- provider union id/open id only when safe; for cross-corp DingTalk transfer,
  these identifiers are expected to be new and normally cannot match the old
  corp identity
- admin-selected target account

Do not silently match on display name alone.

### 9.2 Decision

Supported decisions:

- `rebind`: move the local user to a target directory account.
- `drop`: remove or disable old provider grant without binding a target account.
- `pending`: leave untouched.
- `blocked`: missing identity material or conflict.

### 9.3 Apply

Recommended implementation is a dedicated single-transaction rebind. Do not
compose public `unbindDirectoryAccount` and `bindDirectoryAccount` calls.

Why a special primitive is required:

- The public bind path rejects a local user that is still linked to another
  account for the same provider.
- The public unbind path deletes the current identity row.
- Therefore "bind target first, then unbind source" throws, while "unbind source
  first, then bind target" creates an externally visible no-identity window if
  the operations are not one atomic transaction.

Apply sequence:

1. Validate the target account still exists and belongs to the target
   integration.
2. Validate the target account has enough identity material for login binding.
   If `open_id`/`union_id` cannot produce a DingTalk identity key, mark the
   decision `blocked` before apply.
3. Start one database transaction and lock the local user, source account link,
   target account link, and existing provider identity row.
4. Re-check that the source account is still linked to this local user and that
   the target account is not linked to a different local user.
5. Re-check that the target identity key is not already bound to another local
   user.
6. Set the source account link to `unmatched`, but do not delete the current
   `user_external_identities` row and do not disable the grant.
7. Update the single `user_external_identities(provider, local_user_id)` row in
   place from the source corp identity to the target corp identity, using the
   same profile and conflict semantics as the existing bind path. Insert only if
   the row does not already exist.
8. Upsert the external auth grant as enabled when the decision requires login
   continuity.
9. Set the target account link to `linked`.
10. Commit, then emit an audit event. Audit failure should be visible but must
    not roll back already committed local state.

Important invariant:

- The user must never be externally visible without a working provider identity
  unless the decision is explicitly `drop`. Inside the transaction, rollback
  restores the source identity/link and commit exposes only the completed target
  identity/link.

Resolved design point:

- The current unique local-user/provider constraint should remain strict. A
  local user does not need two DingTalk identities during the transfer window;
  the transfer transaction rewrites the one provider identity row in place.

### 9.4 Tests

Required tests:

- Rebind creates or updates `user_external_identities` for the target corp.
- Rebind enables the external auth grant.
- Rebind clears the source link and writes the target identity/link atomically.
- If target validation or identity upsert fails, rollback leaves the source
  identity/link intact.
- Drop disables/removes the provider identity without deleting the local user.
- Repeated apply is idempotent.
- Conflicting target identity blocks apply.

Mutation checks:

- Disable or corrupt the in-transaction identity upsert and prove the target
  identity assertion fails.
- Delete the current identity before the target identity rewrite and prove the
  no-empty-window/rollback test fails.

## 10. DingTalk Group Destination Adapter

### 10.1 Scan

The adapter should find enabled `dingtalk_group_destinations` that are in scope
for the transferred org/sheets and are referenced by automation rules.

Scope includes both:

- org-scoped destinations where `org_id` is the transferred local org
- sheet-scoped destinations where `sheet_id` belongs to a sheet in the
  transferred local org

Because the table has no corp id or provider-native group id, the adapter cannot
prove which DingTalk corp a webhook belongs to. It should classify existing
destinations as requiring admin decision.

### 10.2 Decision

Supported decisions:

- `rebind`: admin supplies a new webhook/secret for the target DingTalk corp.
- `drop`: disable the local destination.
- `pending`: leave unresolved.

### 10.3 Apply

Recommended rebind behavior:

- Keep the same local destination row.
- Replace webhook/secret using the existing credential encryption path.
- Keep `destinationId` stable so existing automation rules continue to work.
- Reset delivery status fields as appropriate.
- Emit an audit event with masked old/new endpoint summaries.

Recommended drop behavior:

- Set `enabled = false`.
- Do not delete the row.
- Do not rewrite automation rules.
- Surface impacted automation count in the dry-run summary.

### 10.4 Tests

Required tests:

- Rebind preserves destination id.
- Rebind updates encrypted credential material.
- Automation rule still resolves the same destination id after rebind.
- Drop disables destination and blocks future delivery.
- Drop does not delete destination row or automation config.
- Repeated apply is idempotent.

Mutation checks:

- Delete the row on drop and prove tests fail.
- Change destination id on rebind and prove automation continuity tests fail.

## 11. Provider-Agnostic Design

The engine should be provider-neutral from the start, but the provider interface
should stay thin.

Recommended provider driver shape:

```ts
export interface OrgTransferProviderDriver {
  readonly provider: DirectoryProvider;

  getTenantKey(integration: DirectoryIntegration): string | null;

  describeIdentityHandle(handle: ProviderIdentityHandle): MaskedProviderHandle;

  validateTargetIntegration(
    source: DirectoryIntegration,
    target: DirectoryIntegration,
  ): Promise<ProviderTransferValidation>;
}
```

Do not build a broad provider plugin framework yet. The current schema already
uses provider tags in the important identity tables. A small driver seam is
enough for DingTalk now and keeps the migration path open for WeCom and Feishu.

Later provider adapters can add:

- WeCom department/member discovery.
- WeCom app message credential validation.
- Feishu tenant/user identity discovery.
- Feishu bot or chat destination validation.

The transfer engine, decision table, audit model, and UI worklist should remain
unchanged.

## 12. Safety Guardrails

### 12.1 Permanent-Immutable `corp_id` (Rev 3 — supersedes "Block Active In-Place Corp Switch")

Owner rule: once `corp_id` is non-empty on a `directory_integrations` row, it
can never be changed to a different non-empty value through any ordinary edit
path, for the life of the row.

Allowed transitions:

- Initial set: empty → value.
- Clear: value → empty, before any sync has run (a setup-time correction).
- Same value: value → identical value (no-op).

Rejected:

- value → different non-empty value, always, with `409`. No synced-records
  probe, no active/inactive distinction, no escape hatch.

Why the Rev 2 design ("block only if the integration has synced accounts",
with an env escape hatch) is provably unsafe — TOCTOU:

During the FIRST sync there is a window where `corp_id` is set but zero
`directory_accounts`/`directory_departments` rows have been written yet. An
interleaved PUT in that window swaps `corp_id` before any row exists to trip a
synced-records probe — the conditional guard passes, the tenant silently
changes, and the next sync re-arms the mass-deactivation hazard (every record
from the old corp is "not seen" in the new corp's sync window and swept
inactive). Any guard conditioned on integration state has this
time-of-check/time-of-use race. Only unconditional immutability from the
moment `corp_id` is first set is race-free.

There is deliberately NO production escape hatch of any kind — not env-gated,
not admin-gated. The only way to point an org at a new tenant is the transfer
workflow in this plan: stand up a new integration row and reconcile (§4.1).

Ordinary edits that do not touch tenant identity remain allowed, and the
rejection error should tell the admin to start a transfer instead.

### 12.2 Freeze or Guard Source Sync

During transfer, source sync should not be allowed to apply a destructive
absence sweep unexpectedly.

Options:

1. Freeze sync for the source integration while transfer is active.
2. Allow read-only scan but skip inactive marking.
3. Add a separate guard around the absence sweep if freezing is not possible.
   The deprovision/mass-departure breaker is not sufficient by itself because
   it protects the local-user deprovision executor, not the unconditional
   `directory_accounts` and `directory_departments` inactive marking sweep.

The first implementation should use the simplest safe behavior: freeze source
sync during active transfer unless an explicit admin override is supplied.

### 12.3 Dry-Run Required

Apply should require a recent dry-run.

Dry-run summary should include:

- users to rebind
- users to drop
- blocked users
- group destinations to rebind
- group destinations to disable
- automation rules affected
- identities/grants changed
- source records left untouched

### 12.4 Audit Required

Audit events should record:

- transfer created
- scan completed
- decision changed
- dry-run completed
- decision applied
- transfer completed/cancelled

Secrets must be masked. Audit failure should be visible, but after local state
commits it should not falsely mark a successful transfer as failed.

### 12.5 Approval Route Consistency

Approval route behavior is eventually consistent at the per-user transfer level.
In-flight approval instances keep the manager or destination handles baked when
they were created. New instances should use the target identity after each user
rebind decision applies. The transfer engine should document this behavior and
avoid rewriting historical approval instances unless a separate product decision
requires it.

## 13. Admin UI

The first UI can be utilitarian and admin-focused.

Recommended flow:

1. Select source and target integrations.
2. Run preflight checks.
3. Scan bindings.
4. Review grouped decision lists.
5. Enter target handles for group destinations.
6. Run dry-run.
7. Apply.
8. Review completion/errors.

Decision worklist columns:

- binding type
- local anchor name
- source handle summary
- target candidate
- decision
- validation status
- impact
- last error

Filters:

- pending
- blocked
- rebind
- drop
- failed
- by binding type

Bulk actions:

- mark selected as drop
- mark selected as pending
- accept confident user matches

Avoid a single "transfer everything" button. The UI should make the blast radius
visible before apply.

## 14. Development Phases

### Phase 0: Design Lock and Current PR Correction

Deliverables:

- Correct the current corp-switch assessment so it states that directory bind
  already writes `user_external_identities`.
- Correct the group destination description so it says the table has local scope
  fields but no corp/integration/provider/cross-org group identity.
- Add this development plan as the implementation baseline.

Exit criteria:

- The planning docs no longer imply that target login identity is created only
  on next login.
- The docs clearly state the transfer workflow is a reconciliation engine, not
  a `corp_id` edit.

### Phase 1: Guardrails

Deliverables:

- Backend guard making `corp_id` permanently immutable once set on directory
  integrations (§12.1) — no synced-records probe, no escape hatch.
- Transfer-aware source-sync freeze.
- Admin-visible error explaining how to start a transfer.

Tests:

- Editing non-tenant fields still works.
- Editing `corp_id` once set is blocked unconditionally, including the
  pre-first-sync window (`corp_id` set, zero synced account/department rows).
- Dedicated real-DB regression proving zero-row-mutation on rejection —
  `directory-tenant-change-immutable.db.test.ts` already exists on the
  guardrail branch; cite/extend it rather than re-prove.
- Active transfer prevents destructive source sync.

### Phase 2: Transfer Schema and API Skeleton

Deliverables:

- `provider_org_transfers` migration.
- `provider_org_transfer_decisions` migration.
- Repository and service lifecycle methods.
- Admin-only create/read/scan/dry-run/apply/cancel routes.
- No-op adapter for contract tests.

Tests:

- Migration up/down.
- Status transition validation.
- Decision uniqueness.
- Idempotent scan.
- Admin authorization.

### Phase 2 Gate: Two-Corp Coexistence Proof

This is a hard gate before Phase 3 user rebind apply.

Deliverables:

- Stage two DingTalk corp integrations that contain at least one overlapping
  natural person.
- Sync both integrations and prove whether
  `directory_accounts(provider, external_key)` collides.
- If collision occurs, implement the key-strategy migration before Phase 3. The
  likely shape is tenant-scoped directory-account uniqueness, for example
  `(provider, tenant_key, external_key)`.

Exit criteria:

- Phase 3 has a proven directory-account key strategy for source and target corp
  coexistence.

### Phase 3: User Identity Adapter

Deliverables:

- Scan source-bound users.
- Match target accounts.
- Decision validation.
- Rebind/drop apply.
- Audit events.

Tests:

- Existing bind/unbind semantics are reused safely without composing the public
  unbind and bind calls.
- Target identity is present after rebind.
- Source link, target identity, target grant, and target link are applied in one
  transaction.
- Idempotent reapply.
- Conflict cases block.

### Phase 4: DingTalk Group Destination Adapter

Deliverables:

- Scan group destinations and impacted automation rules.
- Rebind with new webhook/secret.
- Drop by disabling destination.
- Dry-run impact summary.

Tests:

- Destination id remains stable.
- Automation rule remains attached.
- Rebound credential is encrypted.
- Disabled destination is not used for delivery.

### Phase 5: Admin UI

Deliverables:

- Transfer list/detail page.
- Source/target selector.
- Preflight panel.
- Decision worklist.
- Dry-run summary.
- Apply progress/error surface.

Tests:

- Decision edits persist.
- Blocked rows cannot be applied.
- Dry-run required before apply.
- Failed rows remain retryable.

### Phase 6: Provider Expansion

Deliverables:

- Extract minimal provider driver interface.
- Add WeCom or Feishu proof adapter only when there is a real customer case.
- Reuse the same transfer tables and decision workflow.

Exit criteria:

- No new transfer engine for each provider.
- Provider-specific logic stays in drivers/adapters.

## 15. PR Split

Recommended PR order:

1. Docs correction and development plan.
2. Guard `corp_id` edit (permanent immutability once set, §12.1).
3. Transfer schema and repository.
4. Transfer service and admin API skeleton.
5. Two-corp coexistence proof or directory-account key-strategy migration.
6. User identity adapter.
7. DingTalk group destination adapter.
8. Admin UI.

Keep implementation PRs narrow. Do not combine schema, user rebind, group rebind,
and UI into one large PR.

## 16. Verification Matrix

| Area | Evidence required |
| --- | --- |
| Tenant edit guard | Unit + route integration tests + real-DB zero-row-mutation regression (`directory-tenant-change-immutable.db.test.ts`) |
| Source sync freeze | Sync integration test with active transfer |
| Transfer lifecycle | Repository/service unit tests |
| Decision idempotency | Repeated scan/apply tests |
| User rebind | Real DB integration test |
| User identity continuity | Mutation test proving atomic identity rewrite |
| Group rebind | Unit + integration tests around automation resolution |
| Group drop | Delivery path test proving disabled destination is skipped |
| Audit | Audit event assertions with masked secret checks |
| Staging coexistence | Two-corp DingTalk sync proof |

## 17. Open Questions

1. If directory-account external keys collide across DingTalk corps, should the
   key become tenant-scoped globally or only for new integrations?
2. Should group destination rebind overwrite the existing row, or create a new
   row and retarget automation rules? This plan recommends overwriting the row
   to preserve `destinationId`.
3. Which resources are in Phase 1 customer-critical beyond users and group
   destinations?
4. Should transfer apply be synchronous for Phase 1, or use a job runner from
   the start?

## 18. Acceptance Criteria

The first production-ready release is acceptable when:

1. `corp_id` edits can no longer mutate an integration into a new tenant —
   immutability is unconditional from the instant `corp_id` is non-empty (no
   synced-records condition, no active/inactive distinction, no escape hatch).
2. Admins can create a DingTalk transfer from source integration to target
   integration.
3. The system scans users and group destinations into explicit decisions.
4. User rebind atomically rewrites the single provider identity to the target
   corp, creates/enables the target grant, and preserves local user continuity.
5. Group rebind preserves automation continuity by keeping the local destination
   id stable.
6. Drop decisions disable provider bindings without deleting local anchors.
7. Dry-run summarizes the blast radius before apply.
8. Apply is idempotent and audit logged.
9. Source sync cannot mass-deactivate records while transfer is active.
10. The same transfer schema and service can host a future WeCom or Feishu
    adapter without rewriting the workflow.
