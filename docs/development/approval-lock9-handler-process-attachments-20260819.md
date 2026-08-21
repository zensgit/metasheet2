# Lock-9 — Approver-Side Process Attachments (审批过程附件) (2026-08-19)

**Status:** RATIFIED 2026-08-21 — §4 records the decision under owner-directed, execute-by-reference
provenance, and §5 records the disposition of the independent review that preceded it. Design authority
ONLY: this document authorizes, enables, and implements NOTHING — no runtime code, no migration, no flag
change, no tenant UAT, no deployment, and no completion label. The ratification is reversible before any
dependent implementation lands. Each contract below still needs its own PR, required checks, an
independent adversarial gate, and a ledger row.
**Baseline:** `origin/main@2a3b8033f5dc25a87e5bb3098ddc467f2f26cd63` (`git rev-parse origin/main` at
draft time; do not hand-expand the abbreviated form). Every anchor below was READ AT THIS BASELINE — line
numbers are exact here and may differ from other documents' own citations. The repository is not shallow,
so the ancestry statements are trustworthy. Unqualified `:NNNN` anchors are
`packages/core-backend/src/services/ApprovalProductService.ts` (APS); `types/*` anchors resolve to
`packages/core-backend/src/types/*` (e.g. `types/approval-product.ts` =
`packages/core-backend/src/types/approval-product.ts`); `ATT-*` anchors are the attachment pipeline files
named inline.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) — **M9** ("Action attachments
are a capability, not dialog chrome", `:233-238`) is the authorizing provision for this entire document
and is quoted in §1.0; M8 (`:226-231`) and M11 (`:246-249`) govern the honesty language.
`approval-lock7-field-edit-enforcement-20260817.md` (RATIFIED) — its **OD-L7-3** deferred exactly the
attachment/record-link handler write ("`record-link` / `attachment` writes need binding+authz that
Lock-7's named validators do NOT cover", APS `:10489-10493`); this document is the named-next-slice for
the *attachment* half of that deferral, and it does NOT re-open Lock-7's other ODs. Its §L7-A "Do not
mint a fourth participant predicate" and D-4 are cited, not re-adjudicated.
`approval-attachment-pipeline-design-lock-20260709.md` (RATIFIED, code-complete, flag-gated OFF) — the
#4195 pipeline this document REUSES; its slices ①–⑥ are cited as shipped anchors, never re-designed.
**Non-effects:** the handler node itself is Lock-3's; per-node operation / action policy is Lock-5's; the
requester-side form attachment field is the #4195 pipeline's and is explicitly NOT reused as a carrier
here (§1.0, M9's "Form attachments are not implicitly reused"). Instance-detail read scope (who may fetch
an instance at all) remains the OPEN owner question Lock-7 §2.7 D-5 left external and is not settled here.

## 0. Corpus, and one honesty note about it

The Feishu administrator handbook the Lock-7 line cites (`feishu/6933484342190538780.txt`) is **not
present at this baseline** — a `find` for it under the worktree returns nothing. Per the program's
empty-read discipline ("an absent file is not evidence of anything") this document therefore does **not**
invent handbook line numbers for a process-attachment feature. The competitor-parity claim rests instead
on the master lock's own already-ratified reading of that corpus, **M9** (`:233-238`), which is on main
and is quoted verbatim in §1.0. Per **M11** the language throughout is "the reference corpus, as distilled
by master M9, evidences a separate action-attachment capability" — never "Feishu has feature X" from
memory. If a later editor restores the handbook, the corpus rows may be cited directly and this note
retired; until then M9 is the sole corpus authority and the argument also stands entirely on shipped
anchors read at this baseline.

## 1. Contracts

### 1.0 The authorizing provision (master M9), quoted

Master M9 (`approval-parity-master-design-lock-20260817.md:233-238`) reads:

> **M9 - Action attachments are a capability, not dialog chrome.** The first unified action dialog
> standardizes title, reason, validation, focus, and buttons. Image or file attachments require a
> separate action-attachment contract covering upload ownership, binding, authorization, retention,
> download, audit, and failure semantics. Form attachments are not implicitly reused.

Two things follow and bind this document. First, M9 makes a **standalone action-attachment contract** the
ratified-parent position, not this document's preference — so OD-L9-1's [R] is M9 executed, and the
rejected "reuse the form field" arm is refused by M9's own last sentence. Second, M9 is this document's
**completeness checklist**: the seven named surfaces — upload ownership, binding, authorization,
retention, download, audit, failure semantics — are each discharged by a contract below (L9-A … L9-G) and
re-swept in §2's blast-radius table. "Reusing the pipeline" (the `approval_attachments` table, the object
store, the validators, the GC) is NOT "reusing the form attachment field"; §1.1 keeps that line crisp.

### 1.1 The gap — where a handler-node attachment write is refused today

Lock-7 landed the handler field-write surface but fenced three field types out of it. At APS
`:10507-10508`:

```ts
if (field.type === 'record-link' || field.type === 'attachment' || field.type === 'explanation') {
  throw new ServiceError('Field type is not writable at a handler node yet', 400,
    'APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE', { nodeKey, fieldId })
}
```

The comment immediately above it (`:10489-10493`) names the reason and the owner: *"`record-link` /
`attachment` writes need binding+authz that Lock-7's named validators do NOT cover … the approval-node
write surface (OD-L7-3's named next slice) carries the binding surfaces."* That deferral is Lock-7
OD-L7-3, and this document is the *attachment* half of it. The one-line refusal is the **legacy
(flag-OFF) behavior this document preserves**: with `APPROVAL_ATTACHMENTS_ENABLED` unset, a handler-node
attachment field-write stays a values-free 400 exactly as shipped (OD-L9-11).

The framing correction the deferral invites, and which OD-L9-1 makes: the refused path is a handler
writing an **attachment-typed FORM field** — i.e. mutating requester form data. That is the wrong shape
for "the approver adds a file while handling." It drags in Lock-7's own can-of-worms (an approver writing
requester form fields, the create-time record-link confused-deputy authz, the immutable-snapshot binding)
for a capability that is conceptually a **process/comment attachment**, separate from the form, exactly as
M9 states. This document therefore does NOT unfence line `:10507`; it adds a standalone process-attachment
carrier that rides an approval action, and leaves the form-field refusal in place.

### L9-A — Binding: a standalone process attachment on the AUDIT record, not a form field (OD-L9-1, OD-L9-2)

**Locked model.** A process attachment is bound to the **audit event** the approver's action creates —
the tuple `(instance_id, node_key, actor_id, action_record_id)` — never to a `formSchema` field. The
requester's `form_snapshot` is untouched: no `merge[fieldId]`, no field-revision row, no unfencing of APS
`:10507`. This keeps requester data and approver additions distinct (M9), and it sidesteps the entire
Lock-7 authz surface: there is no form field to authorize a write against, so
`projectRecordLinkFormSnapshotForViewer` and the `form_snapshot` in-place UPDATE (OD-L7-6) are simply not
on this path.

**Storage shape — minimal reuse of `approval_attachments`, via new columns (OD-L9-2).** The shipped table
(`ATT-migration = packages/core-backend/src/db/migrations/zzzz20260715210000_create_approval_attachments.ts`)
already carries `status ∈ {unbound,bound,deleted}` (`:41-42`), the `instance_id` FK with `ON DELETE
CASCADE` (`:29-30`), the row-delete → purge-intent trigger (`:103-118`), and the per-file 20 MB CHECK
(`:39-40`). Reuse it, adding a discriminator and the audit-binding columns:

- `bind_kind text NOT NULL DEFAULT 'form_field' CHECK (bind_kind IN ('form_field','process'))` — a **pure
  column ADD**: every existing row is `form_field` by the default, so this column is additive and
  legacy-inert. (The `field_id` relaxation below is NOT — see the DDL hazard note.)
- `field_id` **must become nullable-when-process, and this is a CONSTRAINT MUTATION, not an additive
  change.** Today `field_id text NOT NULL CONSTRAINT approval_att_field_nonblank CHECK (field_id ~ '[!-~]')`
  (ATT-migration `:31-32`) and `AttachmentRowForAuth.fieldId: string` (ATT-storage `:218`, non-optional)
  are both mandatory. A process attachment has **no** form field, so the migration must (i) `ALTER COLUMN
  field_id DROP NOT NULL`, and (ii) `DROP CONSTRAINT approval_att_field_nonblank` then re-`ADD` it
  re-expressed as `CHECK (bind_kind = 'process' OR field_id ~ '[!-~]')`. Dropping and re-adding a **named,
  shipped** constraint is the crux the download gate rests on (L9-C): a process row's `field_id` is
  genuinely `NULL`, which makes the hidden-gate skip an **explicit `bind_kind` branch**, not an accidental
  sentinel pass. The type surface widens in lock-step: `AttachmentRowForAuth.fieldId` becomes `string |
  null` and gains `bind_kind`, and the two inline SELECTs that read `field_id` — the `/download` route's
  row type (ATT-routes `:255-270`) and the `/refs` bound-metadata row type (ATT-routes `:408-423`) — must
  each SELECT `bind_kind` and type `field_id` as `string | null`; missing any one leaves the accidental
  pass live on that surface (NIT-1).
- `node_key text` and `action_record_id text` (FK to `approval_records(id)`), populated only for
  `bind_kind='process'` and only at commit (L9-D). `actor_id` reuses the existing `uploader_id` column —
  for a process attachment the uploader IS the acting approver, so no new actor column is minted.
- `staged_instance_id text` — the upload-time target instance, kept SEPARATE from `instance_id` (see L9-D
  / OD-L9-5); `instance_id` continues to mean "committed to a submission" for BOTH kinds.

**DDL hazard — a new migration, ordered late, one-way-once-ON (OD-L9-2, task item 4).** The changes land in
a NEW migration file `packages/core-backend/src/db/migrations/zzzz<ts>_approval_attachments_process_binding.ts`
whose `<ts>` MUST sort **after** both the table-creation migration `zzzz20260715210000` AND the current
latest migration `zzzz20260818120000` (so `<ts> > 20260818120000`) — a `field_id` column that is still
`NOT NULL` when the first NULL-`field_id` write runs is a hard INSERT failure, so the relaxation is a
**deploy precondition**: it must land BEFORE `APPROVAL_ATTACHMENTS_ENABLED` may be turned ON in any
environment. The idempotent shape to follow already lives in this very table's own migration — the
`DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT …` pair (ATT-migration `:79-80`) and the `IF NOT EXISTS
(SELECT 1 FROM pg_constraint WHERE conname = …)` guard (`:91-93`); reuse that shape, do not invent one.
**Rollback is the unstated half:** a `down` that re-adds `field_id NOT NULL` / re-adds the original
`approval_att_field_nonblank` **fails if any `bind_kind='process'` row exists**, so the relaxation is
effectively **one-way once the flag has been ON** — a genuine rollback requires purging all
`bind_kind='process'` rows first. The migration's `down` must state this (either refuse when process rows
exist, or document the purge-first precondition), not silently fail mid-deploy. A gate pins the ordering
and the re-expressed CHECK (§3 G-14).

**Rejected — a new table** (`approval_process_attachments`). It would re-implement, byte for byte, the
storage-key derivation (`deriveStorageKey`, ATT-storage `:39-45`), the scope-prefix partition
(`APPROVAL_STORAGE_PREFIX`, `:36`), the org-pin/containment auth, the GC TTL sweep, the purge-intent state
machine (ATT-migration `:55-118`), and the reconciler — the exact "second narrower artifact = contract
narrowing" the program's own discipline flags. The discriminator-column arm reuses all of it and adds only
what a process binding genuinely needs. Rejected on the reuse principle, cited to the pipeline lock's §2
"the approval line adds NO transport of its own" (ATT-storage `:130-146`).

### L9-B — Who may upload: the acting approver at the active node, enforced at TWO points (OD-L9-3)

Only the principal who could commit the action may stage its attachment. The seat authorization is the
**action's own authorization** — the seat predicate `actorCanAct` — evaluated server-side, never the
request body. It is enforced at two distinct points that must not be conflated:

1. **Bind-time (LOAD-BEARING, genuine REUSE).** The process bind runs INSIDE `dispatchAction`, where
   `actorCanAct` (APS `:8249`) is already computed and already throws `APPROVAL_ASSIGNMENT_REQUIRED` (403)
   at `:8252-8253` for a non-acting caller (`request.action !== 'revoke' && !actorCanAct`). Because the
   bind is a WHERE-guarded UPDATE inside that same transaction (L9-D), an attachment can only ever bind on
   an action the seat check already authorized — the sole guarantee the security rests on. This reuses the
   shipped seat check unchanged; it is the anchor Lock-7 §L7-A named for "the actor's node."
2. **Upload-time (NEW surface, defense-in-depth — NOT a reuse of a callable).** `actorCanAct` is a **local
   `const` inside `dispatchAction`** (APS `:8249`, `= actorAssignments.length > 0`), **not** a callable
   primitive, and the shipped upload route
   (`packages/core-backend/src/routes/approval-attachments.ts:186-246`) has **no seat check at all** — it
   gates on `approvals:write` (`hasApprovalsWrite`, ATT-routes `:170`) plus template visibility
   (`templateVisible`) plus `resolveAttachmentField`, and *requires* `fieldId`+`templateId`. A
   process-upload seat check is therefore genuinely **NEW**: the implementing slice must EXTRACT/re-derive
   the seat computation (`currentNodeAssignments` `:8244`, `actorAssignments` `:8247`,
   `assignmentMatchesActor`, `actorCanAct` `:8249`) into a reusable server-side helper, or run the
   equivalent seat query at the upload surface. This is a fail-fast surface only; correctness does not
   depend on it (point 1 does). The process-upload scope is `approvals:act` (`types/approval-product.ts:4`,
   the action's own scope) — deliberately DIFFERENT from the shipped form-upload gate's `approvals:write`
   — plus the re-derived active-seat check; the readback asymmetry this creates (`approvals:act` to upload,
   `approvals:read` to download/refs) is settled in OD-L9-14.

Identity (`actor_id`/`uploader_id`, `org_id`) is server-derived from the session/JWT, mirroring the
pipeline's own rule that a body-supplied `org_id` is a cross-tenant forgery (ATT-routes `:43-48`). The
upload targets a `staged_instance_id`; the **active node is server-derived from that instance** for the
seat check — the durable `node_key` is NOT written at upload (it is stamped only at commit, L9-A/L9-D), so
there is no upload-time `node_key` to forge. **Rejected — arbitrary-participant upload** (any
`isInstanceParticipant` viewer may attach): it would let a CC recipient or a past actor at a distant node
inject "process" evidence they have no standing to add, and it breaks the audit tuple's meaning (the
committed attachment would claim a `node_key`/`actor` the uploader never acted at). Rejected; the upload
authority is the active-seat check, not participation.

### L9-C — Read authz on BOTH surfaces: reuse the participant predicate, DROP the hidden-field gate (OD-L9-4, OD-L9-13)

Two read surfaces serve attachment data and they authorize **independently** — the slice must EXTEND both,
not just `authorizeAttachmentDownload`:

- the **byte path** `/download` (ATT-routes `:247-303`), which delegates to `authorizeAttachmentDownload`;
- the **metadata path** `/refs` bound mode (`handleRefs`, ATT-routes `:365-454`), which does **NOT** call
  `authorizeAttachmentDownload` — it re-implements gate 1 (`isInstanceParticipant`, `:405-407`) and gate 2
  (`isFieldHiddenAtActiveNode` per distinct `field_id`, `:427-434`) INLINE, and echoes `fileName` to the
  caller (`:441`).

**Byte path (`authorizeAttachmentDownload`).** It runs gate 0 org-pin (`:260-263`), gate 1
instance-visibility (`:264-280`), gate 2 hidden-field redaction (`:281-292`), gate 3 lifecycle/scan
(`:293-297`). For a process attachment:

- **Gate 0 + gate 1 are reused unchanged.** A bound process row has a real `instance_id`, so gate 1 takes
  the `else` arm (`:272-279`) and calls `isInstanceParticipant`. That predicate
  (`ATT-runtime = packages/core-backend/src/services/approval-attachment-runtime.ts:201-244`) is reused
  **without modification** — Lock-7 §L7-A "Do not mint a fourth participant predicate" (D-4) binds here
  too. Its org-pin `EXISTS (SELECT 1 FROM approval_attachments att WHERE att.instance_id = i.id AND
  att.org_id = $4)` (`:219-222`) is **self-satisfied by the process row itself** once bound, so an
  instance carrying only process attachments still resolves participants correctly with **no change** to
  the predicate. This is non-obvious; it is stated so an implementer does not "fix" a predicate that is
  already correct (OD-L9-13). **SCOPED at ratification:** this argument holds only because the process
  attachment row is *itself* the row the `EXISTS` clause finds, so it is confined to the ATTACHMENT
  surfaces (`/download`, `/refs`) — for an instance carrying zero attachment rows the same predicate
  returns false for EVERYONE, so it must not be cited as authorizing reuse of `isInstanceParticipant` on
  comment or other text surfaces (see OD-L9-13's scope clause, and the Non-effects note that
  instance-detail read scope, Lock-7 §2.7 D-5, is not settled here).
- **Gate 2 (hidden-field) is DROPPED for `bind_kind='process'`, by an explicit branch.** A process
  attachment is not a form field; there is no `access` matrix entry for it and its `field_id` is `NULL`.
  The gate becomes: `if (row.bind_kind === 'form_field' && row.instanceId) { …existing hidden check… }`.
  **The trap this avoids** (and the reason a sentinel `field_id` is rejected in OD-L9-2): if a process row
  carried a fake non-blank `field_id`, `isFieldHiddenAtActiveNode` (ATT-runtime `:252-268`) would be
  called with a field id that is in no node's matrix, `hidden.has(sentinel)` would return `false`, and
  gate 2 would **pass by accident** — "the criterion is the vulnerability." The `bind_kind` branch makes
  the skip a design decision the test can pin, not an emergent side effect of a sentinel value.
- **Gate 3 unchanged**; deleted/infected still tombstone (410) only after authorization (no oracle).

**Metadata path (`/refs` bound mode) needs the SAME explicit branch — this is an EXTEND, not a REUSE.**
Its inline gate 2 loops `isFieldHiddenAtActiveNode(instanceId, field_id)` over each distinct `field_id`
(ATT-routes `:427-434`). Verified against the shipped primitive: `isFieldHiddenAtActiveNode` (ATT-runtime
`:252-268`) does **NOT** throw for a fieldless row on a live instance — it loads the instance and returns
`hidden.has(field_id)`, and for `field_id = NULL` that is `hidden.has(null) === false` (NULL is absent from
the hidden-field-id set). So the `.catch(() => true)` fail-closed arm is **never reached**; the process
row's metadata (including `fileName`) renders by the **same accidental pass** the byte path condemns. The
fix is identical: an explicit `if (row.bind_kind === 'process') { …render without a hidden evaluation… }`
branch, not reliance on the NULL `field_id` traversing the form gate. Without it, `/refs` leaks process
metadata regardless of the byte-path branch — the two surfaces must be fixed together. (This confirms the
review's leak direction; it is not a fail-closed drop.)

Failure remains the pipeline's values-free 404 for every authorization denial and 410 for a post-authz
tombstone (ATT-routes `:284-289`), so a process attachment discloses no more than a form one. **Who** a
bound process attachment is readable BY — every participant, versus approvers-only or node-scoped — is a
confidentiality value-call the form path's hidden gate no longer bounds for process rows; it is settled
explicitly in OD-L9-14, not by omission here.

### L9-D — Lifecycle: bound inside the action transaction, immutable after, orphans to GC (OD-L9-5, OD-L9-6, OD-L9-7)

**Bind atomicity mirrors `bindAttachmentsOnSubmit`, but is a NEW function (OD-L9-7).** The pipeline's
form-freeze `bindAttachmentsOnSubmit`
(`ATT-reconciler = packages/core-backend/src/services/approval-attachment-reconciler.ts:64-112`) keys its
UPDATE on `field_id = $3` (`:88`) and cannot serve a process bind (a process row has no field). So a
process bind is a **new** function of the same shape — a single `UPDATE … SET status='bound',
instance_id=$1, node_key=$2, action_record_id=$3, bound_at=now() WHERE id = ANY($4) AND uploader_id=$5 AND
org_id=$6 AND bind_kind='process' AND status='unbound' AND staged_instance_id=$1 AND scan_state <>
'infected'`, with the same **rowCount-equality → throw → whole-action rollback** contract
(ATT-reconciler `:93-100`). It runs INSIDE the approval action's transaction (the same transaction that
inserts the `action_record_id` audit row), so the attachment binds if and only if the action commits;
any bind failure rolls back the action (fail-closed), and a crashed/abandoned action leaves the row
`unbound`. **Advance-race (closes P3-2's node question):** if the instance advances between staging and
commit, `actorCanAct` in `dispatchAction` re-authorizes the caller at the NEW current node before the bind
runs — a stale-seat bind is impossible, and the durable `node_key` is stamped from the action that
actually committed, so it always records where the approver truly acted (never the upload-time guess).

**The bind branch is itself flag-gated (closes P3-1).** The bind runs in the **always-registered**
`dispatchAction`, not in the flag-gated router — so "no-op when OFF" is NOT automatic here. With
`APPROVAL_ATTACHMENTS_ENABLED` unset, `dispatchAction` MUST NOT read `attachmentIds` at all: an action that
happens to carry an `attachmentIds` field is dispatched EXACTLY as it is today (a plain `comment` still
succeeds), never routed into the rowCount-equality bind that would 400 a previously-succeeding action. The
flag gate wraps the bind branch, not merely the upload route; a gate pins it (§3 G-12).

**`staged_instance_id` in the WHERE is the OD-L9-5 fix.** Do **not** stamp `instance_id` at upload:
`authorizeAttachmentDownload` branches on `!row.instanceId` (ATT-storage `:269-271`) — no instance ⇒
uploader-only, instance present ⇒ participant — and the `approval_att_bound_needs_instance` CHECK
(ATT-migration `:46-47`) would happily permit an early `instance_id`. Stamping it at upload would make a
**staged-but-uncommitted** approver attachment downloadable by every participant before the action
commits. So the upload records `staged_instance_id` (a NEW column, gate-1-invisible), leaving
`instance_id` `NULL` until commit; the bind UPDATE's `staged_instance_id = $1` predicate then prevents an
approver staging against instance A and binding to B. Rejected arm — **stamp `instance_id` at upload**:
breaks the `!row.instanceId` uploader-only semantics and leaks staged bytes to participants.

**Immutable after commit; orphans fall to the existing GC.** Once bound, a process attachment is
**audit** — no edit, no delete surface is added (a bound row is already frozen against the GC; ATT-gc
`packages/core-backend/src/services/approval-attachment-gc.ts` sweeps `status='unbound'` only, `:34-36`).
The shipped uploader-retract DELETE (ATT-routes `:320-343`) is `status='unbound'` **only** and so **cannot
reach a bound row** — it strengthens, not contradicts, this immutability: an approver may retract their own
*staged* process upload before commit (identical to the form path), but no route can delete a *bound*
process attachment. This adds no new delete surface; L9 introduces none.
Unbound orphans (uploaded, action abandoned) are swept by the **existing** `sweepUnboundAttachments` at
the ratified `UNBOUND_ATTACHMENT_TTL_HOURS = 168` (ATT-gc `:22`, `:29-50`) and their blobs drained by
`drainPurgeIntents` — process rows are `unbound` like any other, so the TTL sweep needs **no change**. The
reconciler's blob⇄row drift sweep (ATT-reconciler `:174-265`) likewise covers process blobs unchanged
(same scope prefix). Rejected — **a post-commit approver delete/edit**: it would make the audit record
mutable, defeating the point of binding to the audit tuple; retraction, if ever wanted, is a separate
owner decision, not a v1 affordance.

### L9-E — Validation and caps: reuse the validators, a SEPARATE per-action budget (OD-L9-8, OD-L9-9)

**Validation is reused verbatim (OD-L9-9).** Upload runs `validateApprovalAttachments`
(`ATT-validation = packages/core-backend/src/services/approval-attachment-validation.ts:100-141`):
`APPROVAL_ATTACHMENT_LIMITS` (20 MB/file, `:30-34`), the v1 MIME allowlist (PDF/JPEG/PNG/TXT/CSV, `:37-43`),
the extension⇄MIME cross-check, and the magic-byte content-signature check (`:21-28`, `:124-135`). No new
validator is added; the DB `approval_att_mime_v1` CHECK (ATT-migration `:37-38`) and `approval_att_size_bounds`
CHECK (`:39-40`) apply to process rows as defense in depth, unchanged.

**Caps are a SEPARATE per-action budget, NOT the shared instance envelope (OD-L9-8).** The form path's
bind re-checks `SELECT sum(size_bytes) … WHERE instance_id=$1 AND status='bound'` against
`maxSubmissionBytes` (50 MB) (ATT-reconciler `:104-109`). If process rows shared that envelope, an
approver's upload would be blocked by the **requester's** form-attachment budget — a coupling that makes
no sense for an independent capability. So the process bind evaluates its own budget over `bind_kind =
'process'` rows only: a ratified **per-action count cap** (recommend **5 files/action**, below the form
path's 10/field so a process rider stays lightweight) and a **per-action byte cap** (recommend **25 MB/
action**), both re-checked at bind (defense against raced parallel uploads, mirroring the form path's
bind-time re-check rationale). Rejected — **share the instance's 50 MB envelope**: couples approver
uploads to the requester's budget and lets one side starve the other. The exact numeric caps are the
owner's to set; the *shape* (separate budget, process-scoped) is what is locked.

### L9-F — Blast radius: ride an existing action, do NOT mint a verb (OD-L9-10)

A process attachment is a **rider on an action the approver already takes**, not a new action verb. The
tightest form: the shipped `comment` action is already node-type-agnostic and requires no schema change,
so a comment-borne process attachment needs **zero** verb change; `handle` and `approve` can carry the
rider identically. The attachment id(s) travel as an OPTIONAL request field on the existing action
payload, bound at that action's commit (L9-D).

**Rejected — a new action verb** (e.g. `attach`). The cost is concrete and triple:

1. The `handle` precedent shows a verb touches **three coordinated sites at minimum**: the
   `APPROVAL_ACTION_TYPES` const (`types/approval-product.ts:60-73`, comment `:69-71` names the trio), the
   route dispatch guard, and a DB `approval_records_action_check` migration.
2. The `add_*_action` CHECK-migration lineage is **five migrations deep already**
   (`add_created_action`, `add_remind_action`, `add_jump_action`, `add_handle_action`,
   `add_policy_denied_action` under `packages/core-backend/src/db/migrations/`) — every verb has cost a
   migration.
3. `ACTION_POLICY_KEYS` is a `Record` over the FULL `ApprovalActionType` union
   (`types/approval-product.ts:275-276`, `:290`), so a new verb forces a Lock-5 node-operation-policy
   disposition for it — the memory-noted verb-union blast radius that also reaches the attendance P26
   union, the bootstrap version pin, and the admin-jump tests. None of that is incurred by riding
   `comment`/`handle`/`approve`. Rejected on blast radius; the rider is an action field, not a verb.

### L9-G — Values-free, scoped to error and audit surfaces (OD-L9-12)

The pipeline is "values-free" only on its **error/reject** payloads — it deliberately stores `file_name`
and echoes it to AUTHORIZED viewers (`Content-Disposition`, ATT-routes `:295`; `/refs` `fileName`, `:441`).
The claim this document makes is therefore **scoped**: (a) upload/download/bind **error and reject**
payloads carry no filename, uploader id, or size (as shipped, ATT-routes runUpload `:124-140`,
authorization 404s `:284-289`); and (b) the **audit surface** the process bind writes carries only the
attachment **id** on the `approval_records`/revision surface — an id is an identifier, not a value,
consistent with Lock-7 OD-L7-7's "field ids, never values" split. Filenames served to an authorized
participant on the download/`/refs` path are unchanged and are NOT in scope of the values-free claim. An
unqualified "values-free" is rejected as an over-broad absolute claim; the scoped form is what is locked.

## 2. Cross-cutting and blast radius

Master M9's seven surfaces, each mapped to a contract and to the shipped anchors the implementing slice
executes against. EXTEND = a new arm is added; REUSE = shipped behavior consumed unchanged; NEW = a fresh,
narrowly-scoped surface.

| M9 surface | Contract | Anchor(s) | Disposition |
|---|---|---|---|
| upload ownership | L9-B | bind-time seat `actorCanAct` APS `:8249,:8252-8253`; upload-time re-derive `APS:8244-8249`; scope `approvals:act` `types/approval-product.ts:4` | REUSE (bind-time, load-bearing) — the action's own `actorCanAct`; NEW (upload-time) — seat re-derived (`actorCanAct` is a local const, not callable; shipped upload gate is `approvals:write`+visibility, no seat); identity server-derived (ATT-routes `:43-48`) |
| binding | L9-A, L9-D | ATT-migration `:29-47`; ATT-reconciler `:64-112` (shape, NOT called) | NEW columns `bind_kind`/`node_key`/`action_record_id`/`staged_instance_id` (field_id relaxation = constraint MUTATION, new migration `> zzzz20260818120000`); NEW process-bind fn |
| authorization (read) | L9-C | byte: `authorizeAttachmentDownload` ATT-storage `:254-298`; metadata: `/refs` inline gates ATT-routes `:405-434`; participant ATT-runtime `:201-244` | REUSE gate 0/1/3 + participant predicate; EXTEND gate 2 with a `bind_kind='process'` skip branch on BOTH surfaces (`/download` AND `/refs`'s own inline gate 2) |
| retention | L9-D | GC `sweepUnboundAttachments` ATT-gc `:22`,`:29-50`; reconciler ATT-reconciler `:174-265` | REUSE — process rows are `unbound` like any other; no GC change |
| download | L9-C | ATT-routes `/download` `:247-303` | REUSE — same auth-proxied byte path, values-free 404/410 |
| metadata (`/refs`) | L9-C | ATT-routes `handleRefs` `:365-454` | EXTEND — inline gate 2 needs the `bind_kind='process'` branch (else `hidden.has(null)=false` renders `fileName`); readback scope `approvals:read` (OD-L9-14) |
| audit | L9-A, L9-G | `approval_records`; `action_record_id` FK | NEW binding tuple; audit carries attachment **id** only (OD-L9-12) |
| failure semantics | L9-D, L9-E | rowCount-equality rollback ATT-reconciler `:93-109`; validators ATT-validation `:100-141` | REUSE — bind failure rolls back the action; upload validation verbatim |

Additional shipped facts the implementing slice depends on and must NOT silently change:

- **The gap line stays fenced.** APS `:10507-10508` (`APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE`) is NOT
  unfenced by this document; a handler writing an attachment-typed FORM field remains a 400 (L9-A). A gate
  asserts it (§3 G-9).
- **The FE flag is the shipped one.** `apps/web/src/stores/featureFlags.ts:29`, default `false` at `:80`.
  No new FE flag (OD-L9-11).
- **Legacy default — TWO independent gates, not one.** (a) With `APPROVAL_ATTACHMENTS_ENABLED` unset the
  router factory returns `null` (ATT-routes `isApprovalAttachmentsEnabled :106-108`,
  `createApprovalAttachmentRouter :111-112`), so the process-upload route is never registered and the 400
  at APS `:10508` stays. (b) But the process BIND lives in the **always-registered** `dispatchAction`, so
  the same flag MUST also gate the bind branch there (L9-D): OFF, `dispatchAction` ignores `attachmentIds`
  and a `comment`/`handle`/`approve` dispatches byte-for-byte as today. "No-op when OFF" is only true once
  BOTH gates hold — the router gate alone does not cover the dispatch path. Pinned by §3 G-12.

## 3. Acceptance gates

Every absence assertion carries a positive control; every mutation names the test it turns red and
asserts the anchor was hit. These are the gates the implementing slice(s) must pass; ratifying this
document authorizes none of them to run.

| # | Gate | Assertion | Positive control / mutation |
|---|---|---|---|
| G-1 | Process binding never touches `form_snapshot` | a process-attachment action commits with the requester's `form_snapshot` byte-identical and zero field-revision rows | a form-field write in the same fixture DOES change `form_snapshot` — the isolation is process-selected, not a dead path |
| G-2 | `bind_kind` discriminator is load-bearing | a `bind_kind='process'` row has `field_id IS NULL` and the CHECK `(bind_kind='process' OR field_id ~ '[!-~]')` accepts it; a `form_field` row with NULL `field_id` is REJECTED by the same CHECK | dropping the `bind_kind='process'` disjunct reds a named test; a sentinel non-blank `field_id` on a process row is asserted ABSENT (OD-L9-2 trap) |
| G-3 | Download hidden-gate skip is explicit, not accidental | a bound process attachment downloads for a participant with NO field-hidden evaluation; flipping the skip to a sentinel `field_id` path reds a named test | a `form_field` attachment at a HIDDEN node still serves no bytes (gate 2 intact for forms) — the skip is `bind_kind`-selected |
| G-4 | Participant predicate reused unchanged | an instance carrying ONLY process attachments resolves participants correctly via the shipped `isInstanceParticipant` (org-pin self-satisfied by the process row) | mutating `isInstanceParticipant` reds the process-download test too — proving no fourth predicate was minted (OD-L9-13) |
| G-5 | Upload authority is the active seat, not participation | a CC recipient / past actor at another node is REFUSED upload (403 `APPROVAL_ASSIGNMENT_REQUIRED`); the acting approver at the current node is allowed | neutering the `actorCanAct` gate lets the CC recipient upload — asserted on the 403, so the gate is proven live |
| G-6 | Bind atomicity + staged-instance integrity | forcing a failure at the action commit leaves the process row `unbound` with `instance_id IS NULL`; an approver who staged against instance A cannot bind to instance B (rowCount-equality → rollback) | the success path binds all staged rows and inserts the audit row — the rollback test is not passing against a no-op; a cross-instance bind attempt reds a named test |
| G-7 | Staged rows are uploader-only until commit | a staged (uncommitted) process attachment is downloadable ONLY by its uploader, NOT by other participants; after commit it is participant-scoped | stamping `instance_id` at upload (OD-L9-5 rejected arm) reds this test by leaking the staged blob to a participant |
| G-8 | Caps are process-scoped, not the shared envelope | an approver's process upload is bound by the per-action count/byte budget over `bind_kind='process'` rows only, independent of the requester's 50 MB form envelope | a full requester form-attachment budget does NOT block a process upload, and vice versa — the budgets are asserted independent |
| G-9 | The form-field refusal stays fenced | with the flag ON, a handler writing an attachment-TYPED form field is STILL 400 `APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE` (APS `:10508`) — the process path is a different surface | removing the `field.type === 'attachment'` disjunct at `:10507` reds a named test — proving the gap line is untouched |
| G-10 | No new action verb | `APPROVAL_ACTION_TYPES` (`types/approval-product.ts:60-73`) is byte-identical after the slice; the process attachment rides `comment`/`handle`/`approve` | adding a verb to the const reds an exact-set census test (OD-L9-10) — the rider is an action field, not a verb |
| G-11 | Values-free scoped correctly | upload/download/bind ERROR payloads carry no filename/uploader/size; the audit surface carries the attachment ID only; an AUTHORIZED download still serves the real `file_name` | a filename leaked into a 404/413/415 body reds a named test; an audit row carrying a filename reds another (OD-L9-12) |
| G-12 | Legacy OFF is a byte-for-byte no-op on BOTH gates | with `APPROVAL_ATTACHMENTS_ENABLED` unset: (a) no process-upload route registers and APS `:10508` stays 400; AND (b) an action carrying `attachmentIds` through the always-registered `dispatchAction` dispatches identically to today — a `comment` still succeeds, the bind branch is never entered | flipping the flag ON registers the route (proving OFF is inert, not absent); AND with the flag OFF an action carrying `attachmentIds` that previously succeeded as a `comment` STILL succeeds (mutation: an ungated bind branch would 400 it on rowCount-equality — reds this positive control) |
| G-13 | GC/reconciler reuse | an abandoned (unbound) process attachment is swept at 168 h by the UNCHANGED `sweepUnboundAttachments`; its blob drains via the existing purge-intent worker | a bound process attachment is NEVER swept (bound-frozen) — the sweep is status-selected, unchanged from the form path |
| G-14 | DDL relaxation + ordering + rollback | the new migration sorts after `zzzz20260818120000`; after it, a `bind_kind='process'` row with `field_id IS NULL` is ACCEPTED and a `form_field` row with NULL `field_id` is still REJECTED by the re-expressed `CHECK (bind_kind='process' OR field_id ~ '[!-~]')`; the `down` refuses (or documents purge-first) when any process row exists | running the ON-path write BEFORE the relaxation migration reds a named test (INSERT fails on `NOT NULL`) — proving the relaxation is a deploy precondition, not additive; a `down` that re-adds `NOT NULL` with a process row present is asserted to fail/refuse |
| G-15 | `/refs` metadata skip is explicit, not accidental | a bound process attachment renders in `/refs` bound mode via an explicit `bind_kind='process'` branch with NO field-hidden evaluation; a `form_field` ref at a HIDDEN node still renders NO metadata (inline gate 2 intact for forms) | removing the `/refs` `bind_kind` branch and relying on `isFieldHiddenAtActiveNode(instanceId, null)` reds a named test — proving the skip is `bind_kind`-selected, not the `hidden.has(null)=false` accidental pass (the leak the byte-path branch alone would leave live) |
| G-16 | Read scope is a decided posture (OD-L9-14) | a bound process attachment is readable by the SAME participant set the form path resolves (all participants, gate 1) on BOTH `/download` and `/refs`; an approver holding only `approvals:act` (not `approvals:read`) is REFUSED readback (values-free 404) — the upload/read asymmetry is asserted, not accidental | narrowing readback to approvers-only would require a new predicate — asserted ABSENT (Lock-7 D-4); an `approvals:act`-only principal's `/download` returns 404 while a participant with `approvals:read` succeeds |

## 4. Owner ratification block

```text
Decision: RATIFY
Owner: zensgit — on 2026-08-21 the executing session enumerated its recommendations to the owner; item
  (c) of that list was "Lock-9 #5011: ratify as drafted (13 ODs, ratify-ready)". The owner replied
  「按建议执行」, authorizing execution BY REFERENCE to that enumerated list. The recommendation text was
  authored by the EXECUTING SESSION, not by the owner: the owner's own authored text is 「按建议执行」 and
  nothing else in this block is owner prose. Recorded by the executing session with that provenance;
  reversible before dependent implementation lands.
Date: 2026-08-21
Document SHA: drafted a201b83a44 (§0-§4); independent-review fold b7858709da (§5). Both commits were
  REBASED onto origin/main@c473a079b5ff6389b98f4919bb88607a0baa913b for this ratification, which lands on
  top. The baseline note above records the anchors as READ AT origin/main@2a3b8033f5 — that remains a
  truthful historical read-point, and the anchors have NOT been re-verified at the rebase head. Every
  implementing slice must re-verify its own anchors at its own head before relying on a line number.
Count erratum: the enumerated recommendation said "13 ODs". The document AS DRAFTED carries FOURTEEN,
  OD-L9-1 … OD-L9-14. The cause is dated: the count was taken against the pre-fold draft a201b83a44, and
  the review fold b7858709da then ADDED OD-L9-14 to close review finding P2-4 (§5). The authorization is
  "ratify as drafted", by reference to this document, so all FOURTEEN are ratified. OD-L9-14 is retained
  deliberately: it is the one explicit owner value-call (who may read a process attachment back), and
  dropping it to match a stale count would leave the confidentiality posture unratified while slices
  proceed as if it were settled.
Decisions recorded: all FOURTEEN per this document's recommendations —
  OD-L9-1   (a) a STANDALONE process attachment bound to the audit tuple (instance_id, node_key,
            actor_id, action_record_id); the requester's form_snapshot is untouched and APS :10507 is
            NOT unfenced. Arm (b) — reusing the requester form attachment FIELD — is refused by master
            M9 :238 "Form attachments are not implicitly reused".
  OD-L9-2   (a) minimal reuse of approval_attachments via new columns bind_kind ('form_field'|'process'),
            node_key, action_record_id, staged_instance_id (pure ADDs, legacy-inert), PLUS the field_id
            relaxation, which is recorded as a CONSTRAINT MUTATION and not an additive change: ALTER
            field_id DROP NOT NULL, DROP the named shipped constraint approval_att_field_nonblank, and
            re-ADD it as CHECK (bind_kind='process' OR field_id ~ '[!-~]'), in a NEW migration whose zzzz
            timestamp sorts AFTER zzzz20260818120000. The relaxation is a DEPLOY PRECONDITION (it must
            land before the flag may go ON) and is ONE-WAY once ON (a down re-adding NOT NULL fails while
            any process row exists, so rollback requires purge-first). A sentinel non-blank field_id on a
            process row is rejected under both arms. Pinned by G-14.
  OD-L9-3   (a) upload authority is ONLY the acting approver/handler at the ACTIVE node, enforced at TWO
            points: (i) LOAD-BEARING at BIND time, the action's own actorCanAct inside dispatchAction
            (APS :8249, 403 APPROVAL_ASSIGNMENT_REQUIRED) — a genuine reuse; (ii) fail-fast at UPLOAD
            time, which is NEW CODE, not a reuse — actorCanAct is a local const and the shipped upload
            route has no seat check, so the slice re-derives the seat. Process-upload scope is
            approvals:act, deliberately different from the shipped form-upload's approvals:write;
            identity is server-derived, never the body; node_key is stamped only at commit.
  OD-L9-4   (a) reuse read gates 0/1/3 unchanged and DROP gate 2 (hidden-field) via an EXPLICIT
            bind_kind='process' branch on BOTH read surfaces: /download's authorizeAttachmentDownload
            AND /refs bound mode's own inline gate 2, which does not route through it — /refs is an
            EXTEND, not a reuse. Arm (b), keeping gate 2 with a sentinel or NULL field_id, is rejected as
            a verified LEAK: isFieldHiddenAtActiveNode does not throw and hidden.has(null) is false, so
            both gates would pass BY ACCIDENT and /refs would echo fileName. Failure stays values-free
            404 / post-authz 410; the type surface widens in lock-step. Pinned by G-3 and G-15.
  OD-L9-5   (a) record staged_instance_id in a NEW column at upload and leave instance_id NULL until
            commit, preserving authorizeAttachmentDownload's uploader-only branch; the bind UPDATE keys
            staged_instance_id, so a row staged against instance A cannot bind to instance B. Arm (b),
            stamping instance_id at upload, is rejected: it exposes a staged-but-uncommitted approver
            file to every participant before the action commits.
  OD-L9-6   (a) immutable audit after commit: no edit and no delete surface is added (bound rows are
            already GC-frozen); unbound orphans fall to the existing 168 h TTL sweep. Arm (b),
            post-commit approver delete/edit, is rejected as making the audit record mutable.
  OD-L9-7   (a) a NEW process-bind function MIRRORING bindAttachmentsOnSubmit's single-UPDATE
            rowCount-equality → throw → whole-action rollback, running inside the action's transaction
            alongside the audit-row insert. Arm (b), extending bindAttachmentsOnSubmit itself, is
            rejected: its WHERE keys on field_id and cannot serve a fieldless process bind.
  OD-L9-8   (a) a SEPARATE per-action budget over bind_kind='process' rows only, re-checked at bind,
            rather than sharing the instance's 50 MB form envelope (arm (b), rejected: either side can
            starve the other). What is RATIFIED is the process-scoped SHAPE; the recommended 5 files and
            25 MB per action are NOT locked by this ratification and remain the owner's numbers to set.
  OD-L9-9   (a) reuse validateApprovalAttachments verbatim — the 20 MB per-file limit, the v1 MIME
            allowlist (PDF/JPEG/PNG/TXT/CSV), the extension-MIME cross-check and the magic-byte
            signature — with the DB CHECKs as defense in depth. Arm (b), a widened process-only MIME set,
            is rejected: D6 narrowed the allowlist pending AV scanning and a process rider is not the
            place to reopen it.
  OD-L9-10  (a) RIDE an existing action verb — tightest is comment, already node-type-agnostic, with
            handle and approve carrying it identically; the attachment id is an OPTIONAL action field,
            NOT a verb, and APPROVAL_ACTION_TYPES stays byte-identical. Arm (b), a new 'attach' verb, is
            rejected on its >=3 coordinated sites, the Lock-5 ACTION_POLICY_KEYS disposition it would
            force, and the pinned-copy blast radius. Pinned by G-10.
  OD-L9-11  (a) gated behind the ALREADY-SHIPPED APPROVAL_ATTACHMENTS_ENABLED (backend) and
            approvalAttachments (frontend), both default OFF, with NO sub-flag — a process attachment is
            the same capability, gated once; with the flag OFF the current 400 at APS :10508 stays.
            Arm (b), a dedicated sub-flag, is rejected as a second vocabulary for one capability.
            Ratifying this POSTURE authorizes no flag change; see Runtime authorization below.
  OD-L9-12  (a) the values-free claim is SCOPED, mechanically: no filename, uploader, or size in
            error/reject payloads, and the audit surface carries the attachment ID only (an identifier,
            not a value). Filenames served to AUTHORIZED viewers on download and /refs are unchanged and
            explicitly OUT of scope. Arm (b), an unqualified "values-free", is rejected as false.
  OD-L9-13  (a) reuse isInstanceParticipant UNCHANGED — no fourth participant predicate is minted
            (Lock-7 §L7-A / D-4) — its org-pin EXISTS clause being self-satisfied by the bound process
            row itself. RATIFIED AS AMENDED: the scope clause added to OD-L9-13 at ratification is part
            of what is ratified. It confines arm (a) to the ATTACHMENT surfaces and forbids quoting it as
            authorization for comment or other TEXT surfaces (for a zero-attachment instance the same
            predicate returns false for everyone), and it records that the per-instance readability
            predicate is being ruled separately in the S1 lock resolving Lock-7 §2.7 D-5, which Lock-9's
            attachment reads may adopt once it lands.
  OD-L9-14  (a) post-commit read scope is ALL INSTANCE PARTICIPANTS, via the reused gate-1 predicate on
            BOTH /download and /refs — the same set that reads a comment. The exposure is ratified as
            stated, not as a side effect: the requester and any CC recipients CAN read a file an approver
            attached at a node they never saw. Arms (b) approvers-only and (c) node-scoped are rejected
            because each would require minting a new participant/scope predicate that Lock-7 D-4 forbids.
            The SCOPE ASYMMETRY is ACCEPTED as ratified: upload requires approvals:act while readback
            requires approvals:read, so an act-only principal can upload a process attachment it cannot
            read back. Pinned by G-16.
Wording correction made AT ratification, before the decision: OD-L9-13(a) and the matching §L9-C bullet
  now carry the scope clause quoted in the OD-L9-13 line above. The pre-correction wording ("reuse
  isInstanceParticipant UNCHANGED; its org-pin EXISTS is self-satisfied by the process row once bound")
  is TRUE inside the attachment scope but FALSE if cited for a comment or other text surface — an
  executed probe returns false for EVERYONE on a zero-attachment instance. Recorded so the OD cannot be
  quoted out of scope; it is aligned with, and does not disturb, the Non-effects statement that
  instance-detail read scope (Lock-7 §2.7 D-5) is not settled here.
Independent review: an independent Opus refute-first review of PR #5011 returned REQUEST-CHANGES at
  draft head a201b83a44 with 4 P2, 2 P3, and 2 NITs. All are folded into the text above and
  dispositioned in §5, which also records the ONE correction made TO the review (its "no delete route
  exists" prose is inaccurate; the finding set is unaffected). Nothing was rebutted as a false positive.
  This field RECORDS the review; the decision above is the owner-directed ratification, not a review
  verdict.
Runtime authorization: NONE. Design authority ONLY. No runtime code, no migration run, no feature-flag
  change, no tenant UAT, no deployment, and no completion label is authorized by this document. Every
  contract above still needs its own PR, the repository's required checks, an independent adversarial
  gate, and a ledger row. The gap line APS :10507-10508 stays fenced; the requester form attachment field
  is NOT reused as a carrier; instance-detail read scope (Lock-7 §2.7 D-5) remains external.

Decisions required ([R] = this document's recommendation; rejected options carry their citation so they
are not re-proposed):

  OD-L9-1  Binding model — (a)[R] a STANDALONE process attachment bound to the audit tuple
           (instance_id, node_key, actor_id, action_record_id), form_snapshot untouched, APS :10507
           NOT unfenced · (b) reuse the requester form attachment FIELD / extend the handler field-write
           to attachment type [rejected §1.1 + master M9 :238 "Form attachments are not implicitly
           reused": it forces an approver to WRITE requester form fields and drags in Lock-7 OD-L7-3's
           create-time record-link confused-deputy authz + immutable-snapshot binding (APS :10489-10493)]
  OD-L9-2  Storage shape — (a)[R] minimal reuse of approval_attachments via new columns bind_kind
           ('form_field'|'process'), node_key, action_record_id, staged_instance_id (pure ADDs,
           legacy-inert), PLUS a field_id relaxation that is a CONSTRAINT MUTATION not an additive change:
           ALTER field_id DROP NOT NULL + DROP the named shipped CONSTRAINT approval_att_field_nonblank +
           re-ADD it as CHECK (bind_kind='process' OR field_id ~ '[!-~]') (ATT-migration :31-32), in a NEW
           migration whose zzzz timestamp sorts AFTER zzzz20260818120000 (the current latest) and follows
           the in-repo idempotent DROP…ADD / pg_constraint-guard shape (ATT-migration :79-80,:91-93). The
           relaxation is a DEPLOY PRECONDITION (must land before the flag may go ON — a NOT NULL field_id
           hard-fails the first NULL-field_id INSERT) and is ONE-WAY once ON (a down that re-adds NOT NULL
           fails while any bind_kind='process' row exists ⇒ rollback requires purge-first) · (b) a new
           approval_process_attachments table [rejected §L9-A: re-implements deriveStorageKey/scope-prefix/
           GC/purge state machine — the "second narrower artifact" narrowing]. A sentinel non-blank
           field_id on a process row is rejected under BOTH arms (OD-L9-4 trap). Pinned by G-14
  OD-L9-3  Upload authority — (a)[R] ONLY the acting approver/handler at the ACTIVE node, enforced at TWO
           points: (i) LOAD-BEARING at BIND time — the action's own actorCanAct inside dispatchAction
           (APS :8249, 403 APPROVAL_ASSIGNMENT_REQUIRED :8252-8253), a genuine REUSE the security rests on;
           (ii) fail-fast at UPLOAD time — a NEW surface: actorCanAct is a LOCAL const (APS :8249), not a
           callable, and the shipped upload route has NO seat check (it gates on approvals:write +
           templateVisible + resolveAttachmentField, ATT-routes :170,:186-246), so the slice must
           re-derive the seat (currentNodeAssignments :8244 / actorAssignments :8247 /
           assignmentMatchesActor / actorCanAct :8249). Process-upload scope is approvals:act
           (types/approval-product.ts:4), DELIBERATELY DIFFERENT from the shipped form-upload's
           approvals:write; identity server-derived, never the body; node_key NOT persisted at upload
           (active node server-derived from staged_instance_id), stamped only at commit · (b) any instance
           participant may upload [rejected §L9-B: a CC recipient/past actor has no standing to add process
           evidence and would falsify the audit tuple's node_key]. NOT a reuse of a callable seat primitive
           — the upload-time check is new code; corrects the draft's "REUSE actorCanAct" overclaim
  OD-L9-4  Read authz on BOTH surfaces — (a)[R] reuse gates 0/1/3 unchanged and DROP gate 2 (hidden-field)
           via an explicit bind_kind='process' branch on BOTH read surfaces, not just the byte path:
           (i) /download's authorizeAttachmentDownload gate 2 (ATT-storage :281-292); AND (ii) /refs bound
           mode's OWN inline gate 2 (isFieldHiddenAtActiveNode loop, ATT-routes :427-434) which does NOT
           route through authorizeAttachmentDownload — corrects the draft's "download REUSE unchanged"
           overclaim, /refs is an EXTEND · (b) keep gate 2 with a sentinel/NULL field_id [rejected §L9-C:
           isFieldHiddenAtActiveNode does NOT throw for a live instance; for field_id=NULL it returns
           hidden.has(null)=false ⇒ BOTH gates pass BY ACCIDENT and /refs echoes fileName — the criterion
           becomes the vulnerability; verified leak direction, not a fail-closed drop]. Failure stays
           values-free 404 / post-authz 410 (ATT-routes :284-289). Type surface widens in lock-step:
           AttachmentRowForAuth.fieldId → string|null + bind_kind (ATT-storage :218), and the /download and
           /refs inline SELECTs + row types (ATT-routes :255-270, :408-423) each SELECT bind_kind. Pinned by
           G-3 (byte) + G-15 (/refs)
  OD-L9-5  Upload-time instance stamping — (a)[R] record staged_instance_id in a NEW column; leave
           instance_id NULL until commit so authorizeAttachmentDownload's !row.instanceId uploader-only
           branch (ATT-storage :269-271) is preserved; the bind UPDATE keys staged_instance_id=$1 so
           A-staged cannot bind to B · (b) stamp instance_id at upload [rejected §L9-D: makes a
           staged-but-uncommitted approver attachment downloadable by EVERY participant before the action
           commits; approval_att_bound_needs_instance CHECK :46-47 would permit it]
  OD-L9-6  Post-commit lifecycle — (a)[R] immutable audit after commit: no edit, no delete surface added
           (bound rows are already GC-frozen, ATT-gc :34-36); unbound orphans fall to the existing 168 h
           TTL sweep (UNBOUND_ATTACHMENT_TTL_HOURS, ATT-gc :22) · (b) allow an approver post-commit
           delete/edit [rejected §L9-D: makes the audit record mutable, defeating the audit-tuple binding]
  OD-L9-7  Bind mechanism — (a)[R] a NEW process-bind function MIRRORING bindAttachmentsOnSubmit's
           single-UPDATE rowCount-equality → throw → whole-action rollback (ATT-reconciler :93-100),
           running inside the action's transaction alongside the audit-row insert · (b) extend/reuse
           bindAttachmentsOnSubmit directly [rejected §L9-D: its WHERE keys on field_id=$3 (:88) and
           cannot serve a fieldless process bind]
  OD-L9-8  Caps — (a)[R] a SEPARATE per-action budget over bind_kind='process' rows only (recommend
           5 files/action, 25 MB/action), re-checked at bind · (b) share the instance's 50 MB
           maxSubmissionBytes envelope (ATT-reconciler :104-109) [rejected §L9-E: couples approver uploads
           to the requester's form budget; either side can starve the other]. The exact numbers are the
           owner's to set; the process-scoped SHAPE is what is locked
  OD-L9-9  Validation — (a)[R] reuse validateApprovalAttachments verbatim: APPROVAL_ATTACHMENT_LIMITS
           20 MB/file (ATT-validation :30-34), the v1 MIME allowlist PDF/JPEG/PNG/TXT/CSV (:37-43),
           extension-MIME cross-check + magic-byte signature (:124-135); DB CHECKs apply as defense in
           depth · (b) a widened process-only MIME set [rejected: D6 narrowed the allowlist pending AV
           scanning; a process rider is not the place to reopen it]
  OD-L9-10 Action verb — (a)[R] RIDE an existing action (tightest: comment, already node-type-agnostic,
           zero verb change; handle/approve carry it identically); the attachment id is an OPTIONAL action
           field, NOT a verb · (b) a new 'attach' verb [rejected §L9-F: a verb costs >=3 coordinated sites
           (APPROVAL_ACTION_TYPES const + route dispatch guard + approval_records_action_check migration,
           types/approval-product.ts:69-71), extends the 5-deep add_*_action migration lineage, and forces
           a Lock-5 disposition via ACTION_POLICY_KEYS' Record-over-the-full-union (:275-276, :290) plus
           the attendance P26 union / bootstrap-version / admin-jump pinned-copy blast radius]
  OD-L9-11 Flag — (a)[R] behind the shipped APPROVAL_ATTACHMENTS_ENABLED (BE, ATT-routes :106-108) +
           approvalAttachments (FE, featureFlags.ts:29,80), both default OFF; NO sub-flag — a process
           attachment is the same capability, gated once; legacy OFF = the current 400 at APS :10508
           stays · (b) a dedicated APPROVAL_PROCESS_ATTACHMENTS_ENABLED sub-flag [rejected: a second flag
           for one capability is the second-vocabulary move; the pipeline is already one gate]
  OD-L9-12 Values-free scope — (a)[R] the claim is SCOPED to error/reject payloads (no filename/uploader/
           size) and the audit surface (attachment ID only — an identifier, not a value, per Lock-7
           OD-L7-7); filenames served to AUTHORIZED viewers on download/refs (ATT-routes :295, :441) are
           unchanged and out of scope · (b) an unqualified "values-free" [rejected §L9-G: the pipeline
           deliberately stores + echoes file_name to authorized viewers; an absolute claim is false and
           the discipline requires a mechanical scope]
  OD-L9-13 Participant predicate — (a)[R] reuse isInstanceParticipant UNCHANGED; its org-pin EXISTS clause
           (ATT-runtime :219-222) is self-satisfied by the process row itself once bound, so an
           attachment-only instance resolves participants with no change · (b) mint a process-specific
           predicate [rejected: Lock-7 §L7-A / D-4 "Do not mint a fourth participant predicate"].
           SCOPE, ADDED AT RATIFICATION (2026-08-21): the self-satisfaction argument holds ONLY because
           the process attachment row is itself the row the EXISTS clause finds, so arm (a) is confined
           to the ATTACHMENT surfaces (/download and /refs) and MUST NOT be quoted as authorizing reuse
           of isInstanceParticipant on comment or any other TEXT surface — an executed probe shows that
           for an instance carrying zero attachment rows the same predicate returns FALSE for EVERYONE,
           which is exactly why this document's Non-effects note leaves instance-detail read scope
           (Lock-7 §2.7 D-5) unsettled here. That per-instance readability predicate is being ruled
           SEPARATELY, in the S1 lock resolving Lock-7 §2.7 D-5; Lock-9's attachment reads will be able
           to adopt it once it lands, and until then arm (a) authorizes nothing beyond attachments.
  OD-L9-14 Post-commit read scope — a bound process attachment has NO form-field hidden gate (dropped in
           OD-L9-4), so "who may read it back" is a confidentiality value-call this document must decide,
           not leave to omission (Lock-7 D-5 "who may fetch the instance" does NOT cover it). (a)[R] ALL
           instance participants, via the reused gate-1 participant predicate on BOTH /download and /refs —
           the same set that reads a comment; exposure stated plainly: the requester and any CC recipients
           can read a file an approver attached at a node they never saw. Approvers-only and node-scoped are
           the rejected arms BECAUSE each would require minting a new participant/scope predicate that
           Lock-7 D-4 forbids · (b) approvers-only · (c) node-scoped [both rejected: new predicate, D-4].
           SCOPE ASYMMETRY folded here: readback requires approvals:read (the shipped /download and /refs
           gate, ATT-routes :251,:402) while upload requires approvals:act (OD-L9-3) — an act-only principal
           can upload a process attachment they cannot read back; ACCEPTED (an approver ordinarily also
           holds read; the alternative widens the upload gate to read, coupling two scopes). Pinned by G-16.
           This is an owner value-call surfaced explicitly for ratification, [R]=(a)

Runtime authorization: NONE. Ratifying this document authorizes DESIGN ONLY. Each contract still needs
its own PR, required checks, an independent adversarial gate, and a ledger row. No flag change, no UAT,
no deployment, no completion label. The gap line APS :10507-10508 stays fenced; the requester form
attachment field is NOT reused as a carrier; instance-detail read scope (Lock-7 D-5) remains external.
```

## 5. Independent-review disposition (2026-08-19)

An independent Opus refute-first review of PR #5011 at baseline `origin/main@2a3b8033f5` returned
REQUEST-CHANGES with four P2s, two P3s, and two NITs. All are folded above; each was re-verified against
the baseline code before folding.

**P2 (ratify-blocking) — all closed:**

- **P2-1** (upload ownership "REUSE actorCanAct" infeasible-as-stated). CONFIRMED: `actorCanAct` is a local
  `const` inside `dispatchAction` (APS `:8249`), not a callable; the shipped upload route has no seat check
  (gates on `approvals:write`+visibility). Fixed by splitting L9-B / OD-L9-3 into bind-time REUSE
  (load-bearing) and upload-time NEW (re-derived seat), and correcting the §2 table row.
- **P2-2** (`/refs` ignored; "REUSE unchanged" false). CONFIRMED: `/refs` bound mode (ATT-routes
  `:365-454`) has its own inline gate 2 not routed through `authorizeAttachmentDownload`; for a NULL
  `field_id`, `isFieldHiddenAtActiveNode` (ATT-runtime `:252-268`) returns `hidden.has(null)=false` (a leak,
  not a fail-closed drop — verified) and echoes `fileName`. Fixed by adding the `/refs` EXTEND to L9-C,
  OD-L9-4, the §2 table (new metadata row), and gate G-15; scope mismatch (`act` upload vs `read` readback)
  settled in OD-L9-14.
- **P2-3** (DDL/deploy-ordering hazard unstated). CONFIRMED: `field_id` is `NOT NULL` under the named
  shipped constraint `approval_att_field_nonblank`; the relaxation is a constraint mutation. Fixed by
  rewriting the L9-A storage bullet + OD-L9-2 with the new migration name/ordering
  (`> zzzz20260818120000`), the in-repo idempotent shape, the deploy precondition, the one-way-once-ON
  rollback hazard, and gate G-14.
- **P2-4** (post-commit read-scope settled silently). CONFIRMED as an omission. Fixed by adding OD-L9-14
  (an explicit owner value-call, [R]=all-participants, rejected arms cited to Lock-7 D-4) and gate G-16.

**P3 — both closed:**

- **P3-1** ("byte-for-byte no-op OFF" proven only for the router). CONFIRMED: the bind runs in the
  always-registered `dispatchAction`. Fixed by flag-gating the bind branch (L9-D), the §2 legacy-default
  fact (two gates), and G-12 (positive control: an OFF action carrying `attachmentIds` still succeeds as a
  `comment`).
- **P3-2** (node_key internal inconsistency: written at commit vs upload "targets" it). CONFIRMED. Fixed by
  removing the upload-time `node_key` (active node server-derived from `staged_instance_id`; durable
  `node_key` stamped only at commit) and adding the advance-race resolution in L9-D.

**NITs — both closed:**

- **NIT-1** (`AttachmentRowForAuth.fieldId` line + type). CONFIRMED `:218` (not `:217`), non-optional.
  Fixed: L9-A / OD-L9-4 now enumerate every type-widening site (`fieldId → string|null` + `bind_kind` in
  the interface `:218` and the `/download` `:255-270` and `/refs` `:408-423` inline SELECTs/row types).
- **NIT-2** (`types/approval-product.ts` unresolvable from root). CONFIRMED. Fixed by defining the `types/*`
  anchor prefix (`= packages/core-backend/src/types/*`) in the baseline note.

**Review's survived-attack prose — one factual error noted, no doc change (not a finding):** the review's
"no delete route exists" is inaccurate — a shipped `router.delete` (ATT-routes `:320-343`) retracts an
uploader's own `status='unbound'` row. It cannot reach a bound row, so OD-L9-6's post-commit immutability is
unaffected and in fact strengthened; L9-D now cites it as supporting evidence. This is an erratum in the
review's favourable prose, not a P-level finding against the design.

**Nothing rebutted as a false-positive:** every P1/P2/P3/NIT reproduced against the baseline. §4 was BLANK
(ratify-ready) at the time this section was written; it is now FILLED — see §4 for the 2026-08-21
ratification, its owner-directed execute-by-reference provenance, the fourteen recorded ODs, and the count
erratum explaining why this fold's addition of OD-L9-14 makes the total fourteen rather than the thirteen
the recommendation text quoted. This document remains DESIGN-ONLY and authorizes no implementation: each
slice still needs its own PR, required checks, an independent adversarial gate, and a ledger row.
