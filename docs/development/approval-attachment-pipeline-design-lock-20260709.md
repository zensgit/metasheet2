# B3-07 — Approval attachment upload pipeline · DESIGN-LOCK

**Status: RATIFIED 2026-07-15 (owner).** The design is ratified — this lock's contracts are the implementation acceptance bar. Landing order: merges after #4196; once all four locks are on main, P2 durable-delivery runtime is authorized to start, and the attachment feature plus every related flag stay **OFF** until the full implementation + 8-scenario acceptance pass. **This document is still the design contract (no runtime code ships with it).** History: was PROPOSED (doc-only; awaiting owner ratify).
Implementation is a **later, separately-opted-in** change and MUST land behind the default-OFF flag
defined in §9. Until ratify + implementation, the B2-28 honest-disable stopgap (§1) stays exactly as
it is.

**Rev 2 (2026-07-12): owner architecture decisions folded in — see §0-bis.** Six owner decisions
(object storage, dedicated table, initiator-upload, auth-proxied download, default-OFF, narrowed v1
MIME allowlist) resolve five of the seven §13 ratify questions; the remainder were collected in
§13.2 「待 owner 裁决」.

**Rev 3 (2026-07-14): the four remaining §13.2 ratify items (O1–O4) are now owner-DECIDED, and two
new owner-P1 concurrency/cleanup contracts are folded in — see §14.** Owner confirmed: **O1** caps
= 20 MB/file + 10 files/field + 50 MB/submission; **O2** unbound-retention TTL = **7 days** (168 h)
plus stale-reference detection on draft-restore; **O3** production requires an S3-compatible
object-store provider and a local-FS provider in production **fail-closes** uploads (503); **O4**
`svg`/`html`/`xml`/executables are **permanently rejected** (even post-AV). The two new contracts
are the **bind↔GC claim-then-delete race guard** (§7) and the **object-store cascade cleanup** on
instance deletion (§3/§7). Status remains **PROPOSED** — these revisions prepare the lock for
ratify, they do not ratify it. The feature stays **default-OFF** and **owner-ratify-gated**.

**Rev 4 (2026-07-14): owner-P1 correction — the Rev 3 object-store cleanup was NOT crash-safe. See
§7.** Rev 3 had the GC do **both** the claim (soft-delete) **and** the blob-delete synchronously,
with a residual note that a crash between the two left "a recoverable orphan blob, re-swept on the
next pass." **That claim was WRONG:** once the GC commits `deleted_at` and crashes before the
blob-delete, the next sweep only scans `deleted_at IS NULL`, so that row is **never re-processed** —
a **permanent blob leak**, not a recoverable orphan. Rev 4 decouples claim from purge through a
**durable blob-purge intent** (§3 new table) written in the **same transaction as, and gated on, the
conditional claim's non-empty `RETURNING`**, plus an **idempotent lease-worker** (modeled on
`AttendanceNotificationDeliveryWorker`) that is the **sole blob-deleter** and scans the **intent
queue, not `deleted_at IS NULL`**. Path-independent delete paths (instance cascade, admin purge,
retention hard-delete, test cleanup) enqueue the same intent via a **DB trigger on
`approval_attachments` row-delete**. The §7 bind↔GC symmetric guarantee is preserved by construction
(no intent is written unless the GC's conditional UPDATE actually doomed the blob). Four crash
windows + durable-intent recovery tests are added (§11 G11/G12/G14, §12). Status remains
**PROPOSED**, **default-OFF**, **owner-ratify-gated** — doc-only.

**Rev 5 (2026-07-14): five adversarial-review residuals folded into §7/§11/§12.** (1) **Upload-crash
orphan** — a hard kill between blob-write and row-commit leaves an object with no row and no intent,
invisible to both GC and worker; closed by a **periodic bucket-reconciler** (grace window > max
upload→commit latency), new **G15** + test 17. (2) **Over-claim qualified** — the trigger fires on
every **`DELETE`-statement** path (cascade included), NOT `TRUNCATE` / `session_replication_role=replica`
/ disabled-triggers (zero prod risk; test cleanup must use `DELETE` or an ephemeral store) — stated
precisely to avoid the same species of over-claim as the corrected "recoverable orphan." (3)
**Bound-row raw-delete asymmetry** — the trigger also fires on a raw single-row delete of a bound row
of a **live** instance (a misuse outside §4.3); sanctioned bound-row deletion is **only via cascade**.
(4) **Purge-worker dead-letter** — a persistent non-not-found error moves the intent to terminal
`dead_letter` after a bounded `attempts` cap + alert seam (not-found stays terminal-success), test 18.
(5) **Line-refs verified against `origin/main`** (`StorageProvider` interface `StorageService.ts:55`,
`'File not found'` throws `:231`/`:285`/`:310`, `LocalStorageProvider` class `:83` / export `:633`,
`deleteLocalAttachment` `attachment-orphan-retention.ts:46`). **Correction to an intermediate Rev-5 draft
(caught by adversarial review):** that draft had re-numbered these against a **stale local checkout** and,
worse, deleted a citation to `deleteByKey` as "non-existent" — **`deleteByKey` is real** at
`StorageService.ts:268` (interface `:69`, `StorageServiceImpl` `:532`), is the idempotent, ENOENT-as-success,
**cross-process-safe** delete (`:61-68`), and is now correctly named as the method the separate-process purge
worker MUST reuse (§7). Status remains **PROPOSED**, **default-OFF**.

**Rev 6 (2026-07-14): five owner load-bearing corrections folded in.** (1) **Download path symmetry (P1)** —
§4.2 reads blobs via `downloadByKey(storage_path)` (cross-process-reliable, `:250`/`:506`), NOT the
index-based `download(fileId)` (`:228`/`:491`, silently fails in a non-uploader process); symmetric with the
delete side. (2) **Reconciler scope (P1)** — the bucket-reconciler is confined to a dedicated approval bucket
or an unbypassable `approval-attachments/` prefix and may only delete within it, with a mandatory positive
control (a non-approval blob in the same shared store is NEVER deleted) — closes the "would delete other
products' blobs" risk on the shared `StorageService`. (3) **Purge state machine (P2)** — §3-bis now defines
the full `pending | in_progress | done | dead_letter`, `attempts` incremented ATOMICALLY at claim (not at
failure-record, so an always-crash-after-claim poison still reaches `dead_letter`), and every durable write is
a `fence`-CAS. (4) **Raw-delete contract unified with #4239 (P2)** — mechanism (trigger fires on every
`DELETE`-statement) vs policy (bound-row deletion sanctioned only via cascade) stated once so the two docs
agree. (5) **One-blob-per-attachment invariant (owner ruling)** — §10 item 8 pins that `storage_file_id` is
UNIQUE and there is no content-addressed reuse, which is WHY refcount-aware purge is unnecessary in v1.
Status remains **PROPOSED**, **default-OFF**.

> Closes the audit follow-up flagged by B2-28: approval forms declare an `attachment` field type, but
> there is no upload pipeline, so the field is honestly disabled at the form layer and stripped from the
> payload. This lock specifies **what turns that off safely** — the storage decision, the endpoint
> contracts and their authorization, reject-by-default validation, how attachment references enter the
> frozen `form_snapshot`, how detail/mobile render them, how the existing hidden-field redaction and
> egress posture extend to attachments, and the exact acceptance gates + RED-before test list an
> implementation must satisfy.

---

## 0. Terms and existing anchors (grounded, not assumed)

| Anchor | Where | What it does today |
|---|---|---|
| **B2-28 stopgap** | `apps/web/src/views/approval/ApprovalNewView.vue` (`approval-new__attachment-disabled`, `data-testid="approval-attachment-disabled"`, `stripAttachmentFields`) | Attachment fields render a disabled placeholder ("附件上传功能即将支持…"). `formRules` excludes attachment fields (a `required` attachment can never block submit). `stripAttachmentFields()` removes attachment-typed keys from BOTH the create payload and the persisted draft. |
| **Attachment not authorable** | `apps/web/src/approvals/templateAuthoring.ts` (`AuthorableFieldType = Exclude<FormFieldType,'attachment'>`); `TemplateAuthoringView.vue` locks the whole form when an attachment field is present; dry-run skips attachment sample values | The template authoring UI cannot create an attachment field today. |
| **Prefill skips attachment** | `apps/web/src/approvals/prefillFromSnapshot.ts`, `formDraft.ts` | Resubmit/prefill and draft drift-guard always skip attachment fields. |
| **`form_snapshot` freeze** | `packages/core-backend/src/services/ApprovalProductService.ts` — `pruneHiddenFormData(formSchema, request.formData) → normalizedFormData → validateApprovalFormData → INSERT … form_snapshot` | The submitted form is frozen into the instance's `form_snapshot` JSONB at create. Read paths read `toNullableRecord(row.form_snapshot)`; the runtime executor and detail/list DTOs both read the FROZEN snapshot. |
| **Hidden-field redaction** | `packages/core-backend/src/services/approval-form-redaction.ts` — `redactHiddenFormFields(formSnapshot, runtimeGraph, activeNodeKeys)` | Strips fields marked `access: 'hidden'` from the echoed snapshot, keyed on the instance's **active node(s)** (NOT the viewer). Every reader at a hiding node sees the same redacted snapshot. |
| **Multitable attachment infra** | `packages/core-backend/src/multitable/attachment-service.ts`, `services/StorageService.ts`, `routes/univer-meta.ts` (`POST/GET/DELETE /api/multitable/attachments`), table `multitable_attachments`, `multitable/attachment-orphan-retention.ts` | The existing attachment substrate for the collaborative-sheet product. Analyzed in §2. |
| **Egress / SSRF governance** | `packages/core-backend/src/multitable/webhook-ssrf-guard.ts` + `webhook-pinned-fetch.ts` (R1-A/R1-B: default-closed guard/classifier/pinned dispatcher) | Governs **outbound** author-supplied webhook URLs — https-only, block internal/loopback/metadata, resolve-then-pin against DNS rebinding. |

---

## 0-bis. Owner architecture decisions — 2026-07-12

The owner stated six architecture decisions for B3-07. They are recorded here verbatim-in-substance
and folded into the body sections below (each fold-in is marked "owner decision 2026-07-12, D*n*").
They answer five of the seven §13 open questions; the mapping is in §13.1.

| # | Decision | Rationale stated by owner | Folded into |
|---|---|---|---|
| **D1** | **Storage backend = object storage, NOT local filesystem.** | The deploy host is under disk pressure (issue #159 — storage-health alert fired at `df_used_pct=100`, `FS_USAGE_TOO_HIGH`); a local-FS design is unacceptable for production. | §2, §3, §7, §13.1-Q3 |
| **D2** | **Dedicated `approval_attachments` table** — do not overload an existing table. | Confirms the lock's §2/§3 analysis (FK / authorization / lifecycle mismatches vs `multitable_attachments`). | §3, §13.1-Q6 |
| **D3** | **Initiator (发起人) uploads** the attachment. | Confirms v1 scope: initiator-only, own-draft, pre-submit; approver/CC upload stays OUT OF SCOPE (§10.1). | §4.1, §13.1-Q4 |
| **D4** | **Auth-proxied download (鉴权代理下载)** — every download goes through the authorization-checking proxy endpoint; never a direct public object-store URL, never a signed URL in v1. | Keeps the download gate on the **existing approval-visibility authorization** (§4.2 gate 1 — the same predicate the detail read path enforces). No new permission model is introduced. | §4.2, §13.1-Q7 |
| **D5** | **Default OFF** — the feature ships disabled behind the flag. | Confirms the §7/§9 posture already locked (`APPROVAL_ATTACHMENTS_ENABLED` default `false`; B2-28 stopgap byte-unchanged while OFF). | §7, §9 |
| **D6** | **v1 MIME allowlist NARROWED to: PDF, JPEG, PNG, TXT, CSV.** Office documents / ZIP / archives are **deferred until antivirus (AV) scanning is integrated** — they are NOT in v1. | AV integration is the named prerequisite for the v2 MIME expansion; it is not delivered by this lock. | §5, §6, §13.1-Q2/Q5 |

**Substrate correction surfaced while folding in D1** (grounded 2026-07-12): `StorageService.ts` is
today **local-FS only** — the S3 skeleton code was removed as dead code in F6 (refs #3925; see the
file header comment). The original §2 text described it as "S3-capable"; that is stale. Consequence:
D1 requires an **object-store `StorageProvider` implementation** (behind the existing
`StorageProvider` interface, `StorageService.ts:55`) as a named implementation prerequisite —
see §7. Note (re-grounded 2026-07-14): that interface is today **module-private** — `interface
StorageProvider` at `StorageService.ts:55` is NOT exported (only `LocalStorageProvider` is, `:633`),
so "implement behind the existing interface" is not literally possible from outside the module.
**Exporting (or otherwise externally defining) the `StorageProvider` interface is part of the
object-store provider prerequisite.** This does not change the reuse verdict (reuse `StorageService`
as the single blob substrate); it changes what "reuse" must build first.

---

## 1. Problem statement

Approval templates can declare an `attachment` field (`FormFieldType` includes `'attachment'` in both
`apps/web/src/types/approval.ts` and `packages/core-backend/src/types/approval-product.ts`). No pipeline
exists to accept, store, authorize, freeze, or render an uploaded file, so B2-28 disabled the field
honestly rather than shipping a fake uploader that silently `JSON.stringify`-dropped the raw `File` to
`{}`. This lock defines the pipeline that lets attachment authoring + upload be turned on **without
weakening any existing guard**.

---

## 2. Storage decision — REUSE the blob substrate; do **NOT** reuse the multitable row model or endpoints

### Verdict: **HYBRID reuse.** Reuse `StorageService` (the blob substrate) and the attachment-service helper *patterns*; introduce an **approval-scoped attachment table + approval-scoped endpoints** that enforce the approval permission model. Do **not** persist approval attachments in `multitable_attachments`, and do **not** route approval uploads/downloads through `/api/multitable/attachments`.

**Reuse (blob substrate — permission-agnostic, security-relevant, must not fork):**

- **`StorageServiceImpl`** (`services/StorageService.ts`) — size-limited (`uploadLimit`), with
  `upload/download/delete` behind a `StorageProvider` interface. This is orthogonal to any permission
  model; forking it would duplicate a security-relevant code path. Reuse it.
  **Correction (Rev 2):** the service is today **local-FS only** — the S3 skeleton was removed as dead
  code in F6 (refs #3925). Per **owner decision 2026-07-12 D1**, production storage for approval
  attachments is **object storage, NOT local FS** (deploy host disk pressure, issue #159). An
  object-store `StorageProvider` implementation behind the existing interface is therefore a **named
  implementation prerequisite** for this pipeline (§7); approval blobs never land on the deploy host's
  filesystem in production. Local-FS remains acceptable **only** for dev/test.
- **The write-then-insert-with-cleanup pattern** from `storeAttachment` (write binary → `INSERT … RETURNING`
  → best-effort blob cleanup on DB failure to avoid orphan blobs) and the read/soft-delete helpers. An
  approval attachment service SHOULD wrap the same `StorageService` and mirror this pattern (own table).
- **The orphan-retention pattern** (`attachment-orphan-retention.ts`) for GC of abandoned unbound draft
  attachments (see §7).

**Do NOT reuse (three hard mismatches):**

1. **FK mismatch.** `multitable_attachments.sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE
   CASCADE`, with `record_id → meta_records`, `field_id → meta_fields`. An approval form is **not** a
   `meta_sheet`; an approval instance is **not** a `meta_record`. Bolting approval attachments onto this
   table would require forging a synthetic sheet/record (leak of concerns, orphan sheets) or nulling a
   `NOT NULL` FK — both are worse than a dedicated table.
2. **Authorization mismatch (the security core).** The multitable download guard
   `ensureAttachmentDownloadReadable` authorizes on **sheet capabilities** (`resolveSheetReadableCapabilities`
   → `canRead`), row-level read-deny, and field-level allowed-field sets. Approval visibility is a **different
   model**: initiator / current+past approver / CC / admin, plus **active-node hidden-field redaction**.
   Reusing the multitable endpoint would apply the WRONG authorization and could egress an approval
   attachment to anyone holding global `multitable:read`. This is disqualifying.
3. **Lifecycle mismatch.** An approval attachment is **frozen into an immutable `form_snapshot`** at submit
   and must resolve by a frozen reference forever after. A multitable attachment tracks a **live mutable**
   `record.data` column. The two lifecycles cannot share one row model without one corrupting the other's
   invariants.

**Gaps in the multitable substrate the approval pipeline must NOT inherit as-is:**

- **No MIME/type allowlist.** The multitable upload enforces only a size cap (`ATTACHMENT_MAX_SIZE`, default
  100 MB) via multer; it accepts any content type. Approvals MUST add a reject-by-default MIME + extension
  allowlist (§5).
- **Inline image serving.** The multitable download serves images/thumbnails with
  `Content-Disposition: inline` (and `image/svg+xml` is in the content-type map → a stored SVG would render
  inline = stored-XSS vector). Approvals MUST serve **`attachment` disposition always** + `nosniff` + a
  locked-down CSP (§4.2). (This is a stricter approval-line posture, not a change to multitable behavior.)
- **Generic file router carries the WRONG authorization model** *(claim re-grounded 2026-07-13: the
  original "only `authenticate` (no per-object authz)" wording is STALE)*. `routes/files.ts`
  (`GET /api/files/:id/download`) is now **ACL-gated per the F1 files-acl-tombstone design-lock
  (2026-07-10)**: owner-or-admin, else 404 (anti-enumeration), and tombstoned rows are 404 for everyone
  including admin (F3 G7) — see `routes/files.ts:246-258`. That gate is real, but it authorizes on the
  **files-row owner** — which for an approval attachment would be the uploader, not the approval-visibility
  set (initiator / current+past approver / CC / admin + active-node hidden-field redaction). Routing
  approval downloads through it would therefore still apply the WRONG predicate (an approver could not
  fetch what the detail view shows them; hidden-field redaction would not apply at all). The requirement
  stands unchanged: approval blobs MUST be stored under the segregated attachment storage path and MUST
  NOT be reachable via that router; the serialized DTO MUST expose only the approval-scoped download URL
  and MUST NOT echo the raw `storageUrl`.

---

## 3. Data model — new `approval_attachments` table

**CONFIRMED by owner decision 2026-07-12 D2:** a dedicated `approval_attachments` table; no
overloading of `multitable_attachments` or any other existing table (§13.1-Q6 closed).

New, additive, sequentially-numbered migration. Shape (final column list decided at ratify; proposed):

```
approval_attachments (
  id                text PRIMARY KEY,          -- 'aatt_<uuid>'
  instance_id       text REFERENCES approval_instances(id) ON DELETE CASCADE,  -- NULL while unbound (draft)
  field_id          text NOT NULL,             -- the attachment field id in the template form schema (string, not FK)
  storage_file_id   text NOT NULL,             -- StorageService blob id
  storage_path      text NOT NULL,
  storage_provider  text NOT NULL,             -- records the actual backend; prod = object store (D1). No 'local' default (Rev 2)
  filename          text NOT NULL,
  original_name     text,
  mime_type         text NOT NULL,
  size              bigint NOT NULL DEFAULT 0,
  checksum_sha256   text,                      -- integrity + future dedupe
  scan_state        text NOT NULL DEFAULT 'unscanned',  -- 'unscanned' | 'clean' | 'infected' (scan hook, §6)
  uploaded_by       text NOT NULL,             -- local user id of the uploader (the draft initiator)
  created_at        timestamptz NOT NULL DEFAULT now(),
  bound_at          timestamptz,               -- set when the attachment is frozen into a submitted instance
  deleted_at        timestamptz
)
```

- **Two states:** *unbound* (`instance_id IS NULL`, `bound_at IS NULL`) — a file a draft initiator uploaded
  but has not yet submitted; and *bound* — frozen into a submitted instance. Unbound rows are readable only
  by their `uploaded_by` uploader and are GC'd by retention (§7). A row transitions unbound→bound **once**,
  atomically, inside the create-instance transaction; a bound row is immutable (no replace/edit — see §10).
- `field_id` is a **string** matching the template form-schema field id, deliberately **not** an FK
  (approval field ids live in the versioned form schema JSON, not a `meta_fields` row).
- Indexes: `(instance_id)`, `(uploaded_by, instance_id)`, `(storage_file_id)` unique, `(created_at DESC)`.

### 3-bis. Durable blob-purge intent — new `approval_attachment_blob_purge` table (owner P1, folded Rev 4)

Blob deletion is **decoupled** from the row-dooming transition and moved into an idempotent worker
(§7). Every transition that dooms a blob writes a **durable purge intent** row; the worker is the
**sole blob-deleter** and scans this **intent queue**, never `deleted_at IS NULL`. Shape (final
column list decided at ratify; proposed):

```
approval_attachment_blob_purge (
  id                text PRIMARY KEY,          -- 'aabp_<uuid>'
  storage_file_id   text NOT NULL,             -- the doomed StorageService blob id
  storage_path      text NOT NULL,
  storage_provider  text NOT NULL,             -- which backend holds the blob (prod = object store, D1)
  state             text NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'done' | 'dead_letter'
  lease_expires_at  timestamptz,               -- short worker lease (like AttendanceNotificationDeliveryWorker)
  fence             bigint NOT NULL DEFAULT 0,  -- monotonic, bumped on every claim/reclaim (fences a zombie worker)
  attempts          int  NOT NULL DEFAULT 0,    -- incremented ATOMICALLY at claim (see below), NOT at failure-record
  created_at        timestamptz NOT NULL DEFAULT now(),
  done_at           timestamptz
)
```

- **State machine is the full `pending | in_progress | done | dead_letter` (owner P2 — the column comment
  and the prose now agree; the earlier `'pending' | 'done'`-only comment was self-inconsistent with the
  `in_progress`/`dead_letter` the worker uses).** `pending` = enqueued, not claimed; `in_progress` = claimed
  under a live lease; `done` = blob deleted (or confirmed already-gone, terminal-success); `dead_letter` =
  bounded `attempts` exhausted on a persistent non-not-found error (terminal, operator-gated, alert-seam
  fired, shielded from the reconciler per §7).
- **`attempts` increments ATOMICALLY at CLAIM, not at failure-record (owner P2).** The claim is a single
  `UPDATE … SET state='in_progress', attempts = attempts + 1, fence = fence + 1, lease_expires_at = now()+…
  WHERE id=$1 AND (state='pending' OR (state='in_progress' AND lease_expires_at < now())) RETURNING fence`.
  Because the increment is part of the claim (committed BEFORE the blob-delete is attempted), a worker that
  **crashes after claiming but before recording an outcome** still consumed an attempt — so a poisoned intent
  that crashes every worker mid-attempt STILL reaches `dead_letter` after the bounded count. Incrementing
  only at failure-record would let an always-crash-after-claim loop grow `attempts` never, defeating the
  bound. On exhaustion the claim transitions to `dead_letter` instead of `in_progress`.
- **Every durable write is a fence-CAS** (`WHERE id=$1 AND fence=$claimedFence`): a zombie worker whose lease
  expired and was reclaimed carries a stale `fence`, so its `state='done'`/`dead_letter` write affects 0 rows
  and it aborts — the reclaimer's fence is authoritative. (Same fencing contract as #4203 Layer-1; the purge
  intent row IS a reclaimable lease row, so it carries the fence — distinct from #4196's terminal claim table,
  which does not.)
- Unique on `(storage_file_id)` **`ON CONFLICT DO NOTHING`** on insert — a blob may be enqueued more
  than once (e.g. a soft-deleted row later hard-deleted fires the trigger again); a duplicate intent
  is harmless and de-duped.
- The intent is written from exactly two places: (a) the GC / explicit-unbound-delete **conditional
  claim**, in the SAME txn and **gated on that claim's non-empty `RETURNING`** (§7); (b) the DB
  **row-delete trigger** below, for every path that hard-deletes a row without running application
  claim code.

> **Note — DB `ON DELETE CASCADE` does NOT delete object-store blobs; enqueue via a row-delete
> trigger (owner P1, corrected Rev 4).** `instance_id … REFERENCES approval_instances(id) ON DELETE
> CASCADE` deletes the `approval_attachments` **rows** when an instance is deleted/purged, but a DB
> cascade can never reach into the object store to delete the **blobs** those rows pointed at (and the
> multitable sweeper's `deleteLocalAttachment`, `attachment-orphan-retention.ts:46`, is **local-FS
> only** — it cannot delete an object-store object either). So instance deletion via cascade alone
> would leave **orphan blobs** in the bucket. **Rev 4 correction:** the Rev 3 remedy ("an explicit
> app-side cleanup leg that enumerates that instance's bound attachments and deletes their blobs")
> is **path-dependent** — a bare `ON DELETE CASCADE` also fires on admin purge, retention
> hard-delete, and test cleanup, none of which run that application enumerate-then-delete code, so
> those paths would silently leak. **Chosen mechanism:** a **DB trigger on `approval_attachments`
> row-delete that INSERTs a `approval_attachment_blob_purge` intent** for the deleted row's storage
> id — so the cascade **and every other delete path** enqueue the purge automatically, and the
> idempotent worker (§7) does the actual blob-delete. (Alternative considered: drop the FK
> `ON DELETE CASCADE` and force **all** instance/attachment deletion through an application path that
> enqueues explicitly. Rejected — it re-introduces the same path-dependence the trigger removes and
> is easy to bypass with a raw `DELETE`.) DB cascade handles the rows; the trigger + worker handle
> the object store — see the cascade-cleanup contract in §7.

---

## 4. Endpoint contracts + authorization

All endpoints are **authenticated** (existing approval auth middleware) and are **no-ops / 404 when the
feature flag is OFF** (§9).

### 4.1 Upload — `POST /api/approvals/attachments` (multipart, field name `file`)

**CONFIRMED by owner decision 2026-07-12 D3:** the initiator (发起人) uploads (§13.1-Q4 closed —
approver/CC upload stays OUT OF SCOPE, §10.1).

- **Who may upload:** the **initiator, to their own draft, pre-submit only.** The uploaded row is created
  **unbound** (`instance_id NULL`, `uploaded_by = actor`, `field_id` = the target attachment field). There is
  no instance yet, so there is no approver/CC to authorize against — ownership is the uploader identity.
  **Approvers do NOT upload to the form** in v1 (see OUT OF SCOPE §10).
- **Request:** `multipart/form-data` with `file` + body `{ templateId, fieldId }`. Server validates
  `fieldId` is an `attachment`-typed field in that template's form schema; else `400`.
- **Validation (reject-by-default, §5):** size cap, MIME+extension allowlist, per-request single file.
- **Response:** `201 { ok:true, data:{ attachment:{ id, filename, mimeType, size, uploadedAt } } }` — the
  **approval-scoped download URL only**, never `storageUrl`.
- **Binding happens at SUBMIT, not here.** The create-instance payload references uploaded attachment ids in
  the attachment field value (an array of ids). The create path (§4.4) validates each referenced id: exists,
  still unbound, `uploaded_by === actor`, `field_id` matches, `scan_state != 'infected'`. Any failing id →
  the whole create is refused (fail-closed) — a request can never bind an attachment it did not upload.

### 4.2 Download — `GET /api/approvals/attachments/:id`

**CONFIRMED by owner decision 2026-07-12 D4:** auth-proxied download (鉴权代理下载) — every byte is
served through this authorization-checking endpoint. No direct public object-store URL, no
presigned/signed download URL in v1 (§13.1-Q7 closed). The authorization below **reuses the existing
approval-visibility predicate**; D4 introduces no new permission model.

- **Authorization (fail-closed, two gates):**
  1. **Instance-visibility gate.** The actor must be able to READ the owning instance — i.e. initiator,
     a current-or-past assignee/approver, a CC recipient, or an admin. This reuses the **same** visibility
     predicate the approval detail read path already enforces (single source of truth; wire-vs-fixture: the
     download gate and the detail-read gate must not drift). An **unbound** attachment is readable **only** by
     its `uploaded_by` uploader.
  2. **Hidden-field redaction gate.** The attachment's `field_id` participates in `redactHiddenFormFields`
     exactly like any other field. If the field is `access:'hidden'` at the instance's active node(s), the
     download is refused (404, same "not found" shape the snapshot redaction produces) for **every** reader,
     mirroring how the snapshot value itself is stripped. Attachments on hidden fields **inherit** hidden-field
     redaction — no separate code path may serve a byte the snapshot would hide.
- **Response headers (locked):** `Content-Disposition: attachment; filename="…"` **always** (never
  `inline`), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`,
  `Content-Type` = the stored MIME. No inline rendering of any attachment, ever.
- **Blob bytes are read via `downloadByKey(storage_path)`, NOT the index-based `download(fileId)`** (owner
  P1 — symmetric with the delete side's `deleteByKey`). On current `origin/main`, `download(fileId)`
  (`StorageService.ts:228`/`:491`) resolves the object through an **in-memory disk-scan index keyed by
  `md5(relpath)`** that is rebuilt per process — so it **silently fails to locate the object in any process
  other than the uploader's** (JSDoc `:62-65`); `downloadByKey(storageKey)` (`:250`/`:506`) reads by the
  **deterministic storage key**, the only cross-process- and restart-reliable read (the symmetric read-side
  counterpart to `deleteByKey`, F5). The auth-proxied download endpoint runs in a separate process from the
  uploader, so it MUST call `downloadByKey(row.storage_path)`. The raw storage URL is never exposed.

### 4.3 Delete — `DELETE /api/approvals/attachments/:id`

- **Unbound:** the `uploaded_by` uploader may delete their own draft attachment. The endpoint does a
  **conditional claim** of the row (soft-delete under row lock) and, **gated on that claim's non-empty
  `RETURNING`, in the same txn, writes a `approval_attachment_blob_purge` intent** (§3-bis) — it does
  **not** blob-delete inline. The idempotent worker (§7) purges the blob from the intent queue. (This
  is the same claim-then-enqueue shape as the GC sweep, §7, so a crash between claim and purge cannot
  leak the blob.)
- **Bound:** an attachment frozen into a submitted instance is **immutable** and is NOT deletable via this
  endpoint (the snapshot is frozen; there is no "edit the submitted form"). Instance-level cascade
  (`ON DELETE CASCADE`) handles instance deletion/purge only — but the DB cascade drops only the **rows**;
  the object-store **blobs** are enqueued for purge by the **row-delete trigger** (§3-bis) and deleted by
  the worker (§7). DB cascade alone leaves orphan blobs.

### 4.4 Bind at create (server, inside the create-instance transaction)

- After `pruneHiddenFormData` + `validateApprovalFormData`, for each attachment field the normalized value is
  an array of attachment ids. The server: (a) validates each id per §4.1; (b) `UPDATE approval_attachments
  SET instance_id=…, bound_at=now() WHERE id=… AND instance_id IS NULL AND deleted_at IS NULL AND
  uploaded_by=…` (atomic unbound→bound, one-shot); (c) writes the **frozen id array** into `form_snapshot`
  (§8). All within the same transaction that inserts the instance, so a half-bound state is impossible.
  **The `AND deleted_at IS NULL` clause is load-bearing for the bind↔GC race (§7):** it makes the bind and
  the GC's conditional soft-delete *symmetric* — a row the GC claimed (set `deleted_at`) first binds **0
  rows**, so the create fails closed on that id rather than binding a row whose blob the GC is about to
  delete. Without it, a GC-won-first interleaving would soft-delete-then-blob-delete a row whose
  `instance_id` is still NULL, and the bind (checking only `instance_id IS NULL`) would proceed → "bound but
  blob gone" — see §7.
- **One-shot atomicity must be proven with a CONSTRUCTED CONCURRENT race, not sequentially.** The
  guarded-`UPDATE` argument above is a sequential argument; TOCTOU claims are worthless without a
  constructed race. The RED test list therefore REQUIRES a concurrent double-submit test (§12 item 4):
  two create-instance requests racing to bind the SAME unbound id ⇒ exactly one create succeeds and
  binds; the loser's create fails whole (no partial bind, no double-bind, no two instances referencing
  one bound row).

---

## 5. Allowed size / type + validation (reject-by-default)

- **Size cap:** approval-specific, `APPROVAL_ATTACHMENT_MAX_SIZE` (env), **owner-DECIDED 20 MB** (Rev 3, O1;
  smaller than the 100 MB multitable cap — approvals are form attachments, not data-lake blobs). Enforced by
  multer `fileSize` AND re-checked server-side against the stored byte length.
- **Count caps (owner-DECIDED, Rev 3, O1):** **max 10 files per attachment field** and a **per-submission
  total-bytes cap of 50 MB**. Reject-by-default over cap → `413`.
- **Type allowlist (reject-by-default, `415` otherwise) — NARROWED by owner decision 2026-07-12 D6.**
  An explicit MIME **and** extension allowlist, both must pass. **v1 set (exhaustive, five types):**

  | Type | Extension(s) | MIME |
  |---|---|---|
  | PDF | `pdf` | `application/pdf` |
  | JPEG | `jpg`, `jpeg` | `image/jpeg` |
  | PNG | `png` | `image/png` |
  | Plain text | `txt` | `text/plain` |
  | CSV | `csv` | `text/csv` |

  **Deferred to v2, gated on AV-scanning integration (D6):** Office documents (`doc/docx`, `xls/xlsx`,
  `ppt/pptx`), ZIP/archives, and the other image formats from the original proposal (`gif`, `webp`).
  These return `415` in v1 like any other non-allowlisted type; the v2 expansion is a **separate
  opt-in whose named prerequisite is a wired AV scanner** (§6) — this lock does not deliver it.
  **PERMANENTLY rejected (NOT AV-gated) — owner-DECIDED (Rev 3, O4):** `svg`, `html/htm`, `xml`, and
  any executable/script type stay rejected **even after AV integration**. The owner decided this on
  **stored-XSS / execution-vector** grounds: AV scanning detects malware signatures, not
  markup-rendering or execution vectors — an AV-clean SVG/HTML/XML can still carry active script that
  renders/executes in a viewer, so AV does **not** mitigate the reason these are rejected. They are
  therefore never in scope for the v2 AV-gated expansion; they return `415` in v1 and remain `415`
  post-AV. (The no-inline serving headers of §4.2 are defense-in-depth, not a substitute for this
  reject.)
- **Content sniff:** verify the file's magic bytes are consistent with the declared MIME where a signature
  exists (reject on mismatch). At minimum, extension ∩ MIME allowlist both hold.
- **Filename:** store `original_name` verbatim for display but never use it as a filesystem path; the storage
  path is a server-generated UUID (as the reused substrate already does). Display uses `encodeURIComponent`.

---

## 6. Egress / malware posture

- **No new outbound egress.** Uploaded files are **inbound** binaries stored via `StorageService`. The
  pipeline **never fetches a user-supplied URL** to obtain, preview, or transform an attachment. It therefore
  does not touch the R1-A/R1-B webhook SSRF surface at all — that governance is for **outbound**,
  author-supplied webhook URLs (`webhook-ssrf-guard.ts` / `webhook-pinned-fetch.ts`), and this lock does not
  weaken, alter, or bypass it.
- **Hard rule (no-oracle):** no attachment-handling code may issue an outbound request on a user-controlled
  URL. If a future capability (remote ingestion, external scan/preview) needs egress, it MUST route through
  the existing default-closed pinned dispatcher (resolve-then-pin), never a raw `fetch`, and MUST come back
  through this lock (new opt-in), not ride in on B3-07.
- **No inline rendering of untrusted content** — `attachment` disposition + `nosniff` + `CSP default-src
  'none'` (§4.2). This is the primary stored-XSS mitigation (covers the SVG/HTML vector the multitable inline
  path leaves open).
- **Scan hook seam (default no-op) — AV DEFERRED per owner decision 2026-07-12 D6 (§13.1-Q5 closed).**
  v1 ships **without** a real AV engine: it defines the `scanHook(attachment) → 'clean'|'infected'` seam and
  the `scan_state` column, **default pass-through** and flag-gated, so an AV engine (e.g. a ClamAV sidecar)
  can be wired later without re-opening this lock. The compensating v1 mitigations are: the **narrowed
  five-type allowlist (§5, D6)**, the size cap, no-inline serving, and non-execution. **AV integration is
  the named prerequisite for the v2 MIME expansion** (Office/ZIP/archives, §5) — a future, separately
  opted-in change, not part of this lock. A `scan_state = 'infected'` row is never bindable (§4.4) and
  never downloadable.

---

## 7. Migration / rollout

- **Default-OFF flag `APPROVAL_ATTACHMENTS_ENABLED`** (env, default `false`) — **CONFIRMED by owner
  decision 2026-07-12 D5.** While OFF: upload/download/delete endpoints return `404`/`403`; attachment
  stays honestly-disabled — **B2-28 UI, `stripAttachmentFields`, the authoring lock, and the
  prefill/draft skips all remain UNCHANGED.**
- **Storage prerequisite (D1 + owner-DECIDED O3, Rev 3).** Production **requires an S3-compatible
  object-store `StorageProvider`**; a local-FS provider in production is **not allowed** — approval
  attachment blobs never land on the deploy host's local filesystem (issue #159 disk pressure). Before
  rung 2 can be exercised outside tests, that object-store `StorageProvider` must exist behind the
  `StorageProvider` interface — which must first be **exported** (it is module-private today,
  `StorageService.ts:55`; the S3 skeleton was removed in F6 refs #3925 — §0-bis correction).
  **Prod fail-close (owner-DECIDED, O3):** when `APPROVAL_ATTACHMENTS_ENABLED=true` and
  `NODE_ENV=production`, upload **fail-closes (`503`)** unless a non-local, S3-compatible storage
  provider is configured — a local-FS provider in production returns `503`, never silently writes to
  the deploy host disk. Local-FS remains acceptable **only** for dev/test.
- **Staged, each rung separately opted-in** (staged-opt-in lineage discipline):
  1. **Contract + table** — migration for `approval_attachments`; types; flag scaffolding (OFF). No behavior.
  2. **Backend** — upload/download/delete + create-time bind + validation + redaction gate + tests (RED-first).
     Still OFF by default; exercised only in tests / behind the flag.
  3. **Frontend** — replace the B2-28 disabled placeholder with a real uploader in `ApprovalNewView`; resolve
     & render frozen refs in detail/list/mobile (§8). Gated on the same flag.
  4. **Flip authorability + retire B2-28** — make `attachment` an `AuthorableFieldType`, unlock the template
     authoring form, remove the `stripAttachmentFields` defensive strip and the disabled placeholder. **Only
     after** the flag is ratified ON and rungs 1–3 have landed.
- **B2-28 disable is REMOVED only at rung 4**, and only under owner ratify. Nothing in rungs 1–3 changes the
  submit/authoring behavior a user sees while the flag is OFF.
- **Unbound-attachment GC:** reuse the orphan-retention pattern (`attachment-orphan-retention.ts`) — a
  scheduled sweep targets unbound (`instance_id IS NULL`) rows older than
  `APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS` (**owner-DECIDED 168 h = 7 days**, Rev 3 O2), so
  abandoned drafts don't accumulate blobs but a genuine multi-day draft survives. **Rev 4: the sweep
  does NOT blob-delete inline.** It **conditionally claims** each due row (soft-delete under row lock)
  and, gated on that claim, **enqueues a `approval_attachment_blob_purge` intent** (§3-bis); the
  idempotent worker (below) is the sole blob-deleter. See the crash-safety contract next.
- **Bind↔GC race + crash safety — CLAIM-THEN-ENQUEUE-INTENT, worker purges (owner P1, corrected
  Rev 4).** The multitable sweeper this GC mirrors is **racy** as written: `attachment-orphan-retention.ts`
  SELECTs unbound rows (`WHERE record_id IS NULL`, `:92-99`), then **blob-deletes first**
  (`storage.delete`, `:108`), and only **then** soft-deletes the row (`:123-131`) — and that soft-delete
  re-checks only `deleted_at IS NULL`, **not** that the row is still unbound. Two defects follow, and Rev 4
  fixes **both** by decoupling the claim from the blob-delete:
  - **Defect 1 — bind↔GC race (Rev 3's fix, retained).** With no row lock and no re-check of the unbound
    predicate at blob-delete time, an approval GC copying that shape would RACE §4.4 bind: sweeper reads a
    row as unbound → a concurrent create-instance binds it (sets `instance_id`/`bound_at`) → sweeper
    blob-deletes → **"bound but blob gone."** The GC MUST **conditionally claim under row lock** —
    `UPDATE approval_attachments SET deleted_at=now() WHERE id=$1 AND instance_id IS NULL AND bound_at IS NULL AND deleted_at IS NULL RETURNING …` —
    and act **only if that UPDATE claimed a row** (`RETURNING` non-empty). For this to serialize, the two
    UPDATEs must guard on the **same predicate in both directions** — the §4.4 bind UPDATE therefore MUST
    also carry `AND deleted_at IS NULL`
    (`SET instance_id=…, bound_at=now() WHERE id=… AND instance_id IS NULL AND deleted_at IS NULL AND uploaded_by=…`).
    Then bind and the GC's conditional UPDATE **serialize on the same row → exactly one wins, in EITHER
    interleaving**: (i) **bind won first** → the GC's conditional UPDATE matches **0 rows** (no longer
    `instance_id IS NULL`) ⇒ GC does nothing, blob survives; (ii) **GC won first** → the GC set
    `deleted_at`, so the bind UPDATE matches **0 rows** (no longer `deleted_at IS NULL`) ⇒ that id **fails
    to bind** and the whole create fails closed on it (§4.1/§4.4). Omitting `AND deleted_at IS NULL` from the
    bind breaks case (ii): the GC-claimed row still has `instance_id IS NULL`, so the bind would proceed and
    produce "bound but blob gone."
  - **Defect 2 — crash-safety of the blob-delete (Rev 3's residual note was WRONG; this is the P1).**
    Rev 3 had the GC do the blob-delete **synchronously after** the claim, with a residual note that a crash
    between the two left "a recoverable orphan blob, re-swept on the next pass." **That was false.** Once the
    GC commits `deleted_at` and crashes **before** the blob-delete, the next sweep scans only
    `instance_id IS NULL` **and** `deleted_at IS NULL` — the crashed row is soft-deleted, so it is **never
    re-processed**, and its blob leaks **permanently**. Rev 4 fixes this by making the GC **claim-then-enqueue,
    never blob-delete inline**: gated on the conditional claim's non-empty `RETURNING`, **in the SAME
    transaction as the claim**, the GC INSERTs a `approval_attachment_blob_purge` intent (§3-bis). The
    **idempotent lease-worker** below is the sole blob-deleter and scans the **intent queue, not
    `deleted_at IS NULL`** — so a crash after the claim-commit leaves a **durable, still-`pending` intent**
    the worker completes on restart. The leak is closed.
  - **CRITICAL INVARIANT (preserves the §7 bind↔GC symmetric guarantee).** The purge intent for a blob is
    written **iff the conditional claim that dooms that blob won** — i.e. the intent INSERT lives in the
    **same transaction as, and is gated on, the `UPDATE … RETURNING` returning a non-empty row**, NOT the
    candidate SELECT (which is stale — a bind can win between SELECT and UPDATE). Because the intent is
    gated on the **same** `RETURNING` that already decides whether the GC acts, symmetry holds **by
    construction**: if **bind won** (case i), the GC's conditional UPDATE returns 0 rows ⇒ **no intent is
    written** ⇒ the now-bound blob is **never enqueued and never purged**; if **GC won** (case ii), the
    intent is written and durable, and the bind fails closed. A bound blob is thus never purged, and the
    purge is now durable — both guarantees from one gated write.
- **Idempotent blob-purge worker — modeled on `AttendanceNotificationDeliveryWorker`
  (`services/AttendanceNotificationDeliveryWorker.ts`).** A scheduled worker claims due
  `approval_attachment_blob_purge` rows with a **short lease** (`FOR UPDATE SKIP LOCKED`, `attempts`,
  `state pending→in_progress→done|dead_letter`, `attempts` incremented + `fence` bumped AT CLAIM per §3-bis —
  the same outbox/lease shape as `claimDueDeliveries`), calls the object-store
  provider's `delete` for each, and marks the intent `done`. It is the **only** code that deletes an
  approval blob. **Reuse `deleteByKey`, the idempotent cross-process-safe delete — NOT the index-based
  `delete(fileId)`.** `StorageService` exposes two deletes: the index-based `delete(fileId)`
  (`StorageService.ts:518`, provider impl `:282`) throws `'File not found'` on a missing blob
  (`StorageService.ts:285`) and is **not** safe to call from a process other than the uploader; and
  **`deleteByKey(storageKey)`** (interface `StorageService.ts:69`, `StorageServiceImpl` `:532`, provider impl
  `:268`) which the interface comment (`:61-68`) documents as *"the ONLY safe way to physically delete an
  object outside the process that uploaded it"* and which is **idempotent — deleting an already-gone key
  (ENOENT) resolves as success** (`:265-274`, the single ENOENT-as-success decision point). The purge worker
  runs in a separate process from the uploader, so it MUST call **`deleteByKey`** — matching the reuse-the-blob-
  substrate principle (§2) and the existing `deleteLocalAttachmentByKey` orphan-sweep path
  (`attachment-orphan-retention.ts:200` `deleteLocalAttachmentByKey`, whose body calls `storage.deleteByKey`
  at `:245`). **Not-found is therefore
  TERMINAL-SUCCESS by the provider's own contract** (the worker never needs to inspect an error code), so a
  missing blob marks the intent `done`, never looping. Any **other** error (transient network/permission)
  leaves the intent `pending` for a later attempt. The worker scans the **INTENT QUEUE**, never `deleted_at IS NULL`.
  - **Bounded attempts + dead-letter (adversarial-review catch).** Not-found is terminal-success, but a
    **persistent non-not-found error** (a permission denial, a malformed `storage_path`, a provider
    misconfiguration) must **not** re-lease forever. The intent carries a **bounded `attempts` cap**;
    on exhaustion it moves to a terminal **`dead_letter`** state (no further auto-reclaim) and raises an
    **alert seam** (the same operational-visibility posture as the delivery worker's failure path), so a
    permanently-failing purge surfaces to an operator instead of spinning. This is distinct from the
    not-found terminal-success path (which is a *success*, not a failure) and from the never-orphan
    guarantee (a `dead_letter` blob is a **known, surfaced** leak awaiting operator action, not a silent one).
- **Four crash windows — all covered by the durable intent (owner P1, Rev 4).** Every transition that
  dooms a blob writes the intent **before** any blob-delete, so a crash **after the intent-commit but
  before the blob-delete** is always recovered by the worker on restart. The four windows, each a RED
  test with a positive control (§12), are: **(i) unbound GC sweep** — the retention claim (above);
  **(ii) bind↔GC loser** — the same GC conditional claim, when it wins the race (case ii); **(iii)
  instance cascade delete** — the `ON DELETE CASCADE` row-delete fires the §3-bis **trigger**, which
  enqueues the intent; **(iv) explicit unbound delete** — the `DELETE /api/approvals/attachments/:id`
  claim (§4.3). For each: kill the process **after the intent-commit, before the blob-delete** ⇒ assert
  the worker **purges the blob on restart** (intent → `done`, blob gone); and assert a **bound blob of a
  surviving (live) instance is NEVER enqueued or purged** (§7 symmetry — the gated intent write and the
  trigger only fire for a row that is actually being removed/doomed, never for a live-instance bound row).
  Note window (iii) legitimately purges the **deleted** instance's bound blobs (the instance is gone) —
  the negative assertion there is that a **co-existing live instance's** bound blob is untouched. Serialization
  (Defect 1, both interleavings) and durability (these four windows) are **orthogonal** and BOTH tested.
  See gates G11/G14 and §12 items 13, 16.
- **Object-store cascade cleanup on instance deletion — via the trigger + worker (owner P1, corrected
  Rev 4).** `ON DELETE CASCADE` (§3) deletes the `approval_attachments` **rows** when an instance is
  deleted/purged but **never** the object-store **blobs** (and the multitable `deleteLocalAttachment`,
  `attachment-orphan-retention.ts:46`, is local-FS only — it cannot reach the object store). Rev 3
  proposed an **app-side enumerate-then-delete cleanup leg**; Rev 4 **rejects** that as path-dependent —
  cascade, admin purge, retention hard-delete, and test cleanup all bypass application code. **Chosen
  mechanism:** the §3-bis **DB trigger on `approval_attachments` row-delete** enqueues a purge intent for
  every removed row's storage id, so **every** delete path (cascade included) auto-enqueues, and the
  idempotent worker deletes the blobs. Relying on `ON DELETE CASCADE` alone still leaves orphan blobs in
  the bucket; the trigger closes that. See gate G12 and §12 item 14.
- **Trigger fires on DELETE statements only — precise, not "path-independent" (adversarial-review catch; the
  same species of over-claim as the earlier-corrected "recoverable orphan, re-swept next pass," so stated
  precisely here).** A row-level `DELETE` trigger fires on every **`DELETE`-statement** path — cascade, admin
  purge, retention hard-delete, and the explicit endpoint — but does **NOT** fire on `TRUNCATE`, under
  `session_replication_role = replica`, or with triggers disabled. In production this is a **zero-risk**
  qualification: every instance/attachment removal path is a `DELETE`-based cascade, none uses `TRUNCATE` or
  replica-role. The one place the distinction bites is **test cleanup**, which commonly `TRUNCATE`s: tests
  that must exercise the purge path MUST delete via `DELETE` (or use an ephemeral object store), or the
  trigger will not fire and the blob will not be enqueued. The claim is therefore precisely **"every
  `DELETE`-statement path (cascade included)"**, not the looser "every deletion path."
- **Raw-delete contract — MECHANISM vs POLICY, stated once so #4195 and #4239 agree (owner P2 — unify the
  contract).** These two statements are BOTH true and must not be read as contradictory: **(mechanism)** the
  row-delete trigger fires on **every `DELETE`-statement path**, including a raw single-row `DELETE` of a
  bound row — it *cannot* distinguish a legitimate cascade from an illegitimate raw delete, so it *will*
  enqueue a purge for whatever row is deleted; **(policy)** **bound-row deletion is SANCTIONED only via
  instance cascade** (where the purge is correct — the instance is gone). A raw single-row `DELETE` of a
  **bound row of a *live* instance** is therefore a **misuse** (admin/test foot-gun): the §4.3 endpoint
  refuses it, and if some out-of-band path does it anyway, the trigger will purge a blob a live frozen
  snapshot still references (→ permanent tombstone). So: **#4239's "only bound-row cascade enqueues" is the
  POLICY** (the only sanctioned way a bound blob is purged is instance deletion), and **#4195's "the trigger
  fires on any bound-row `DELETE`" is the MECHANISM** (why the policy must be enforced by never issuing a raw
  bound-row delete, not by hoping the trigger discriminates). **#4239 is aligned to this same
  mechanism-vs-policy framing in the SAME landing (#4239 §4 item ⑦, Rev 9)** — the two docs are co-edited to
  agree; if read before that co-edit lands, #4239 may still show the older "cascade-only enqueues" phrasing,
  which this landing replaces.
- **Upload-crash orphan — the one leak the doom-path intent does NOT cover; closed by a bucket-reconciler
  (adversarial-review catch, a real leak on the NORMAL path).** The upload writes the blob to the object store
  **before** the `approval_attachments` row `INSERT` commits (the reused best-effort cleanup covers an `INSERT`
  *failure*, but a hard process kill **between** blob-write and row-commit leaves a blob with **no row and no
  purge-intent**). Such an object is invisible to **both** the GC (which scans unbound *rows*) **and** the purge
  worker (which scans the *intent queue*) — there is no doom transition, so no intent is ever written. **Backstop
  contract:** a **periodic bucket-reconciler** lists object-store objects, cross-checks each against
  `approval_attachments` rows **and** `approval_attachment_blob_purge` intents, and deletes any object
  that has **no row AND no intent in ANY state AND is older than a grace window** — where the grace window MUST
  exceed the maximum plausible upload→row-commit latency (so an object mid-upload/mid-commit is never mistaken
  for an orphan).
  - **The reconciler MUST be SCOPED to approval-owned storage only — never the whole shared store (owner
    P1).** `StorageService` is a **shared substrate** (multitable attachments, the files product, approval
    attachments all live behind it). A reconciler that enumerates the entire store and deletes "any object
    with no `approval_attachments` row" would **delete every other product's blobs** (which have no approval
    row by definition). The reconciler's `list` MUST be confined to either a **dedicated approval bucket** or
    an **unbypassable `approval-attachments/` storage-key prefix** (the same prefix every approval upload is
    written under, enforced server-side so no approval object can land outside it and no non-approval object
    can land inside it). It may cross-check against `approval_attachments`/intents **only** for objects within
    that scope, and it may delete **only** within that scope. **Positive controls (two, both mandatory):**
    (i) seed a non-approval object (a multitable/files blob) in the SAME underlying store OUTSIDE the approval
    prefix and assert the reconciler **never deletes it** — proving the scope confinement, not just "deletes
    orphans"; (ii) assert the **server-side write-path enforcement** that no non-approval object can be written
    INTO the `approval-attachments/` prefix (and no approval object outside it) — because the whole scope
    guarantee rests on the prefix being an unbypassable partition, not merely on the reconciler reading it. **The intent check is "no intent in any state", NOT "no *pending* intent":** an object with a
  `dead_letter` intent is a **known, operator-gated** residual (the worker exhausted its attempts and surfaced
  it) — the reconciler MUST NOT silently re-purge it (that would race the operator and re-hide a leak the alert
  seam deliberately surfaced); it is left for operator action. The reconciler only sweeps objects with **no
  intent row at all** (the upload-crash case, where no doom transition ever ran). This is the store-side
  reconciliation the doom-path intent structurally cannot provide. New gate
  (G15) + RED test (§12 item 17): kill between blob-write and row-commit ⇒ the reconciler purges the orphan
  past the grace window; **positive control** — a legitimately committed row's blob (and an in-flight upload
  younger than the grace window) are **never** purged by the reconciler.

---

## 8. References into `form_snapshot` + detail / mobile rendering

- **Freeze as durable ids.** At submit, an attachment field's value in `form_snapshot` is an **ordered array
  of `approval_attachments.id` strings**, frozen into the instance's immutable JSONB alongside every other
  field. The snapshot stores **references, not blobs, not live pointers.**
- **Resolve by the FROZEN reference.** Detail / list / mobile read paths resolve each frozen id → attachment
  metadata (`filename`, `size`, `mimeType`, approval-scoped download URL) via a **batched lookup keyed on the
  frozen ids** (mirroring `buildAttachmentSummaries`' batch shape). Rendering resolves **by the frozen id**,
  never by re-deriving from a mutable source. Consequence: after submit, deleting/replacing the underlying
  file cannot change what a reader sees — the frozen id resolves to the same immutable blob, and a
  soft-deleted row renders as a tombstone (e.g. "附件已删除"), never a silent swap to a different file.
- **Redaction is one source of truth.** The attachment `field_id` flows through `redactHiddenFormFields`
  identically to any other field. When hidden at the active node, the id array is stripped from the echoed
  snapshot AND the download endpoint (§4.2) refuses those ids. There is exactly one active-node hidden set;
  the snapshot echo and the byte-serving path both read it.
- **Stale-reference detection on draft-restore (owner-DECIDED, Rev 3, O2).** A saved draft can hold
  **unbound** attachment-id references; those unbound rows are GC-swept once they pass the 7-day TTL
  (§7). When a draft is restored / prefilled (`prefillFromSnapshot.ts`, `formDraft.ts`), the pipeline
  MUST **detect attachment-id references whose rows were GC-swept** — an id whose `approval_attachments`
  row no longer resolves (deleted/absent) — and surface it as **STALE**: drop it or flag it to the
  user, **never** silently keep a dangling id in the restored draft and never resolve it to a deleted
  blob. A restore that carried a swept id forward unmodified would let a create-instance reference an
  attachment that no longer exists; the detection makes the staleness explicit at restore time. This
  mirrors the frozen-snapshot tombstone behavior above (a deleted **bound** ref renders as a tombstone;
  a swept **unbound** draft ref is surfaced as STALE). See gate G13 and §12 item 15.
- **Mobile parity.** The mobile detail surface renders the resolved refs through the same helper as desktop
  (pure, Element-Plus-free resolver in `apps/web/src/approvals/`), so the two surfaces cannot drift.

---

## 9. Feature flag summary

| Flag / env | Default | Effect |
|---|---|---|
| `APPROVAL_ATTACHMENTS_ENABLED` | `false` (confirmed — D5) | Master gate. OFF ⇒ endpoints 404/403, field honestly-disabled, authoring locked. |
| `APPROVAL_ATTACHMENT_MAX_SIZE` | 20 MB (owner-DECIDED — O1) | Per-file size cap. |
| `APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS` | 168 = 7 days (owner-DECIDED — O2) | GC TTL for abandoned unbound draft attachments. |
| `APPROVAL_ATTACHMENT_SCAN_ENABLED` | `false` | Enables the AV scan hook; default no-op pass-through. |

**Storage-provider prod guard (owner-DECIDED — O3, not a tunable flag).** When
`APPROVAL_ATTACHMENTS_ENABLED=true` and `NODE_ENV=production`, upload **fail-closes (`503`)** unless a
non-local, **S3-compatible** object-store provider is configured; a local-FS provider in production is
**not allowed** and returns `503` rather than writing to the deploy host disk (§7, issue #159).
Additional owner-DECIDED count caps (O1): **10 files/attachment-field** and **50 MB/submission**
(§5); over cap → `413`.

---

## 10. OUT OF SCOPE for v1 (explicit)

1. **Approver / CC-uploaded attachments** — files attached during an approval action or comment. v1 is
   **initiator-only, own-draft, pre-submit.**
2. **URL-based / remote attachment ingestion** — the server never fetches a user-supplied URL (§6).
3. **Inline preview / thumbnails / in-browser office preview** — all attachments download-only.
4. **Real AV engine integration** — only the `scanHook` seam + `scan_state` column are defined.
5. **Presigned direct-to-storage client uploads** — uploads proxy through the authenticated endpoint.
6. **Editing / replacing / versioning an attachment after submit** — the snapshot is frozen; resubmit
   re-uploads fresh files.
7. **Attachment fields inside `detail` sub-forms** — `DETAIL_LEAF_FIELD_TYPES` excludes `attachment`; it
   stays excluded.
8. **Cross-instance attachment reuse / content-dedupe** — each submission uploads its own files (`checksum`
   is stored for integrity/future use only). **v1 INVARIANT (owner ruling — this is what makes shared-blob
   refcounting unnecessary): one attachment row = one independent blob; NO content-addressed reuse.** Every
   upload gets a unique UUID storage key and `storage_file_id` is `UNIQUE` (§3), so **no two attachment rows
   ever reference the same blob** — deleting one attachment's blob can never affect another's. This is why the
   purge worker and the cascade cleanup do NOT need refcounting: with the one-blob-per-attachment invariant, a
   purge is always safe (no other row references the blob). Any future content-dedupe would break this
   invariant and MUST re-open refcount-aware purge as a new decision — it is explicitly OUT for v1.
9. **Chunked / resumable / async large-file upload** — single synchronous multipart within the size cap.

---

## 11. Acceptance gates (implementation must satisfy ALL)

- **G1 — Flag fail-closed.** With `APPROVAL_ATTACHMENTS_ENABLED=false`, upload/download/delete return
  404/403 and the B2-28 UI + strip + authoring lock are byte-unchanged.
- **G2 — Upload authorization.** Only an authenticated actor can upload; the row is created unbound and
  owned by the uploader. A non-attachment `fieldId` is rejected.
- **G3 — Reject-by-default validation.** Over-size → 413; any type outside the v1 five-type allowlist
  (§5, D6) → 415 — including the owner-DECIDED permanent-reject `svg`/`html`/`xml`/executables (O4) AND
  the AV-deferred Office/`zip`/`gif`/`webp`; MIME/magic-byte mismatch → 415; over count/total caps → 413.
- **G4 — Bind integrity.** Create-instance binds only ids that are unbound + owned-by-actor + field-matched +
  not `infected`; any failing id fails the whole create (no partial bind); binding is one-shot (a bound id
  cannot rebind) — and one-shot is **proven by the constructed concurrent double-submit race** (§4.4,
  §12 item 4), not by a sequential rebind-refused check alone.
- **G5 — Frozen snapshot.** After submit, the attachment field in `form_snapshot` is the frozen id array;
  detail/list/mobile resolve by frozen id; a post-submit source mutation does not change what a reader sees;
  a soft-deleted bound row renders as a tombstone, never a swap.
- **G6 — Download visibility gate.** A user with NO read access to the instance gets 404 on the attachment;
  initiator/approver/CC/admin get 200; unbound attachment readable only by its uploader.
- **G7 — Hidden-field redaction inheritance.** When the attachment field is hidden at the active node, BOTH
  the snapshot echo strips the ids AND the download endpoint refuses them — proven against the same
  active-node hidden set, no drift.
- **G8 — Safe serving headers.** Every download carries `Content-Disposition: attachment`, `nosniff`, and
  `CSP default-src 'none'`; no inline path exists; the raw `storageUrl` is never in any response body.
- **G9 — No new egress.** No attachment code path issues an outbound request on a user-controlled URL; the
  webhook SSRF guard is untouched and unweakened.
- **G10 — GC.** Unbound attachments past the retention TTL (**7 days**, O2) are swept (row soft-deleted +
  blob deleted); bound attachments are never swept by the sweep.
- **G11 — Bind↔GC race (claim-then-enqueue, symmetric guard).** The GC does a **conditional soft-delete
  under row lock** (`… WHERE id=$1 AND instance_id IS NULL AND bound_at IS NULL AND deleted_at IS NULL
  RETURNING`) and, gated on that non-empty `RETURNING`, writes a purge intent **in the same txn** (never a
  synchronous inline blob-delete); the §4.4 bind UPDATE carries the symmetric `AND deleted_at IS NULL`
  guard. Proven by a **constructed GC↔submit concurrency test** (§7, §12 item 13) exercising **both**
  interleavings: **(i)** a sweep in flight while a bind commits ⇒ the just-bound row's **blob SURVIVES**, the
  row is **NOT** soft-deleted, and **no purge intent is written** for it; **(ii)** a bind in flight against a
  row the sweep already claimed ⇒ the create **fails closed** on that id and **no** "bound but blob gone"
  row results. Positive control = a genuinely-abandoned unbound row IS claimed + enqueued + purged (blob +
  row gone). A sequential argument does NOT satisfy G11.
- **G12 — Object-store cascade cleanup (trigger + worker).** Deleting/purging an instance with bound
  attachments enqueues a purge intent for each removed row via the §3-bis **row-delete trigger**, and the
  idempotent worker deletes the **object-store blobs** (§7) — not merely the DB rows — so no orphan blob
  remains in the bucket after cascade. An **app-side enumerate-then-delete** leg does NOT satisfy G12
  (path-dependent — the trigger must fire on the raw cascade/purge path too).
- **G13 — Stale draft-reference detection.** Restoring/prefilling a draft (`prefillFromSnapshot.ts`,
  `formDraft.ts`) whose unbound attachment refs were GC-swept surfaces them as **STALE** (dropped/flagged),
  never silently kept as a dangling id and never resolved to a deleted blob (§8, O2).
- **G14 — Durable blob-purge across all four crash windows.** For each of the four blob-dooming
  transitions — (i) unbound GC sweep, (ii) bind↔GC loser, (iii) instance cascade delete (trigger),
  (iv) explicit unbound delete — a crash **after the intent-commit but before the blob-delete** is
  recovered: on restart the idempotent worker (scanning the **intent queue, not `deleted_at IS NULL`**)
  purges the blob and marks the intent `done`; a not-found blob is **terminal-success** (never
  retry-forever). Positive control per window = the doomed blob IS purged after restart; negative =
  a **bound blob of a surviving live instance** is never enqueued or purged. Satisfies the Rev 4
  correction (the Rev 3 "recoverable orphan, re-swept next pass" claim is FALSE — a soft-deleted crashed
  row is never re-swept). Proven by §12 items 13 + 16. **Purge-worker dead-letter:** a persistent
  non-not-found error moves the intent to terminal `dead_letter` after a bounded `attempts` cap (with an
  alert seam), never an unbounded retry — proven by §12 item 18 (positive control: a transient error
  succeeds on a later attempt).
- **G15 — Upload-crash orphan reconciler.** The one leak the doom-path intent cannot cover — a hard kill
  **between blob-write and row-commit** leaves a blob with no row and no intent — is closed by a **periodic
  bucket-reconciler** that purges objects with no `approval_attachments` row AND no purge-intent **in any
  state** (a `dead_letter` intent shields its object — operator-gated, not re-purged) AND
  older than a grace window exceeding the max upload→commit latency. Positive control: a committed row's blob
  and an in-flight upload younger than the grace window are NEVER purged. Proven by §12 item 17.

## 12. RED-before test list (write these FAILING first, then implement)

Backend (`packages/core-backend/tests/integration/`, `.api.test.ts` / `.db.test.ts`):

1. `approval-attachment-flag-fail-closed` — flag OFF ⇒ all three endpoints 404/403; B2-28 behavior unchanged.
2. `approval-attachment-upload-auth` — unauthenticated 401; non-attachment field 400; happy path creates an
   unbound, uploader-owned row.
3. `approval-attachment-validation` — oversize 413; disallowed MIME 415 for BOTH the owner-DECIDED
   permanent rejects (svg/html/xml/exe — O4) AND the v1-deferred types (docx/zip — D6); each of the five
   allowlisted types accepted (positive control); magic-byte mismatch 415; count/total-bytes caps 413.
4. `approval-attachment-bind-at-create` — binds owned+unbound+field-matched ids; refuses foreign/rebound/
   infected id (whole create fails); one-shot bind (rebind refused); **plus a constructed CONCURRENT
   double-submit leg (§4.4)**: two create-instance requests racing on the same unbound id ⇒ exactly one
   binds, the other create fails whole — sequential rebind-refused alone does NOT satisfy G4.
5. `approval-attachment-download-visibility` — no-access reader 404; initiator/approver/CC/admin 200; unbound
   readable only by uploader.
6. `approval-attachment-hidden-redaction` — field hidden at active node ⇒ snapshot echo strips ids AND
   download refuses ids (same active-node set); non-hidden ⇒ both present. (Extends the existing
   `approval-bridge-redaction-regression` shape.)
7. `approval-attachment-serving-headers` — asserts `Content-Disposition: attachment`, `nosniff`, `CSP`,
   and absence of `storageUrl` in the body.
8. `approval-attachment-frozen-snapshot` — post-submit source mutation/soft-delete does not change the
   rendered resolution; tombstone on soft-delete.
9. `approval-attachment-gc-retention` — unbound past TTL (7 days) swept; bound never swept.
13. `approval-attachment-gc-bind-race` — **constructed GC↔submit concurrency** (like item 4, not
    sequential), **both interleavings**: **(i)** a sweep mid-flight while a create-instance bind commits ⇒
    assert the just-bound row's **blob SURVIVES**, the row is **NOT** soft-deleted, and **no purge intent is
    written** for it (bind won); **(ii)** a create-instance bind against a row the sweep already claimed
    (`deleted_at` set) ⇒ assert the create **fails closed** on that id and **no** "bound but blob gone" row
    results (GC won). Positive control = a genuinely-abandoned unbound row IS claimed + enqueued + purged
    (blob + row gone). Satisfies G11.
14. `approval-attachment-cascade-blob-cleanup` — delete/purge an instance that has bound attachments ⇒
    assert the §3-bis **row-delete trigger** enqueues a purge intent per row and the worker deletes the
    **object-store blobs** (not just the DB rows); no orphan blob remains. Positive control = a co-existing
    **live** instance's bound blob is NOT enqueued/purged. Satisfies G12.
16. `approval-attachment-purge-crash-recovery` — **durable-intent recovery across the four crash windows**
    (§7): for each of (i) unbound GC sweep, (ii) bind↔GC loser, (iii) instance cascade delete (trigger),
    (iv) explicit unbound delete, simulate a **crash after the intent-commit but before the blob-delete**
    (e.g. the intent row is `pending` with the blob still present) ⇒ assert the idempotent worker, scanning
    the **intent queue (NOT `deleted_at IS NULL`)**, purges the blob on restart and marks the intent `done`;
    assert a **missing/not-found blob is terminal-success** (`StorageService.delete` throws 'File not found'
    — the worker marks `done`, never loops); positive control per window = the doomed blob IS purged;
    negative = a **bound blob of a surviving live instance** is never enqueued/purged. Proves the Rev 3
    "re-swept next pass" claim is false (a soft-deleted crashed row is never re-swept). Satisfies G14.
17. `approval-attachment-upload-crash-reconciler` — **store-side reconciliation for the upload-crash orphan**
    (§7): write a blob to the store, then simulate a hard kill **before** the `approval_attachments` row
    `INSERT` commits ⇒ a blob with no row and no purge-intent. Advance past the reconciler grace window and
    run the reconciler ⇒ assert the orphan object IS purged. **Positive controls (two):** (a) a legitimately
    committed row's blob is NEVER purged; (b) an in-flight upload **younger** than the grace window is NEVER
    purged (proves the reconciler distinguishes an orphan from a not-yet-committed upload, not "purges any
    row-less object"). Satisfies G15.
18. `approval-attachment-purge-worker-deadletter` — a purge intent whose blob-delete raises a **persistent
    non-not-found error** (permission denied / malformed path) ⇒ after the bounded `attempts` cap the intent
    is terminal `dead_letter` (no further auto-reclaim) + alert seam fired. **Positive control:** a **transient**
    error on the first attempt succeeds on a later attempt (proves the cap distinguishes persistent from
    transient, not "gives up on first error"); and not-found stays terminal-**success**, never dead-letter.

Frontend (`apps/web/tests/`, `.spec.ts` / `.test.ts`):

10. `approval-attachment-uploader.spec` — with flag ON, the disabled placeholder is replaced by a working
    uploader that posts to the endpoint and stores the returned id (not a raw `File`); with flag OFF, the
    B2-28 placeholder + strip persist.
11. `approval-attachment-detail-render.test` — a pure resolver renders frozen ids → filename/size/download
    link on desktop and mobile via the same helper (parity); tombstone for a missing/soft-deleted ref;
    hidden-field ref is absent from the rendered snapshot.
12. `approval-attachment-authoring.test` — after rung 4, `attachment` is an `AuthorableFieldType` and the
    template authoring form is no longer whole-locked by an attachment field.
15. `approval-attachment-stale-draft-restore.test` — restoring/prefilling a draft
    (`prefillFromSnapshot.ts` / `formDraft.ts`) whose unbound attachment refs were GC-swept surfaces them
    as **STALE** (dropped/flagged), never silently kept as a dangling id and never resolved to a deleted
    blob; a still-present unbound ref restores normally (positive control). Satisfies G13 / O2.

---

## 13. Ratify state (Rev 3, 2026-07-14) — all questions answered / owner-DECIDED

The original lock listed seven open questions. The 2026-07-12 owner decisions (§0-bis) answered five of
them; the **2026-07-14 owner decisions (Rev 3)** answer the remaining ratify items O1–O4. **All §13.1
questions and all former §13.2 items are now ANSWERED / owner-DECIDED — §13.2 is empty.** Status remains
**PROPOSED**: the design is decided, but the lock is not ratified and no runtime ships until the owner
ratifies the lock as a whole and turns the default-OFF flag ON.

### 13.1 Answered by owner decisions (D1–D6 2026-07-12, O1–O4 2026-07-14)

| Original question (2026-07-09) | Status | Resolution |
|---|---|---|
| **Q1. Size + count caps** (20 MB/file, 10 files/field, 50 MB/submission) | ✅ **DECIDED — O1 (2026-07-14)** | Owner confirmed **20 MB/file, 10 files/attachment-field, 50 MB/submission** (§5, §9). |
| **Q2. Type allowlist contents** | ✅ **DECIDED — D6 + O4** | v1 allowlist = **PDF, JPEG, PNG, TXT, CSV** (exhaustive, §5); Office/ZIP/archives deferred until AV integration (D6). `svg`/`html`/`xml`/executables are **owner-DECIDED PERMANENTLY rejected even post-AV** on stored-XSS/execution-vector grounds (O4, §5). |
| **Q3. Prod storage backend + unbound-retention TTL** | ✅ **DECIDED — D1 + O2 + O3** | Backend = **S3-compatible object storage, NOT local FS** (D1/O3, #159); a local-FS provider in prod **fail-closes (503)** (O3, §7). Unbound-retention TTL = **7 days (168 h)** (O2, §7/§9), with **stale-reference detection on draft-restore** (O2, §8). |
| **Q4. Approver-uploaded attachments** | ✅ **ANSWERED — D3** | **Initiator (发起人) uploads**; approver/CC upload confirmed OUT OF SCOPE for v1 (§10.1). |
| **Q5. AV scan now or defer** | ✅ **ANSWERED — D6** | **Defer.** v1 ships the no-op `scanHook` seam + narrowed allowlist; a wired AV scanner is the named prerequisite for the v2 MIME expansion (§6). |
| **Q6. Table shape** | ✅ **ANSWERED — D2** | Dedicated **`approval_attachments`** table (§3); no overloading of existing tables. |
| **Q7. Download delivery** | ✅ **ANSWERED — D4** | **Auth-proxied download** through the authenticated endpoint, reusing the existing approval-visibility authorization (§4.2). No public object-store URLs, no signed URLs in v1. |

(Default-OFF was not one of the seven questions but is likewise **CONFIRMED by D5** — §7/§9.)

### 13.2 待 owner 裁决 — remaining ratify items: **NONE**

All former §13.2 items are now owner-DECIDED (folded into §5/§7/§8/§9); recorded here for the ratify audit trail:

- **O1 — Size + count caps** (was Q1) — **DECIDED (2026-07-14):** **20 MB/file, 10 files/attachment-field,
  50 MB/submission** (§5, §9). No longer open.
- **O2 — Unbound-retention TTL + stale-ref detection** (was the unanswered half of Q3) — **DECIDED
  (2026-07-14):** TTL = **7 days (168 h)** (§7/§9); PLUS the pipeline MUST **detect stale references on
  draft-restore** — a restored/prefilled draft whose unbound refs were GC-swept surfaces them as STALE
  (§8, G13, §12 item 15). No longer open.
- **O3 — Object-store deployment shape + prod fail-closed guard** — **DECIDED (2026-07-14):** production
  requires an **S3-compatible object-store provider**; a local-FS provider in production is **not allowed**
  and **fail-closes uploads (503)** (§7, §9). Bucket names/credentials remain ops env config (never
  committed); the provider code is target-agnostic behind the S3-compatible API.
- **O4 — Post-AV fate of `svg`/`html`/`xml`/executables** — **DECIDED (2026-07-14):** **permanently
  rejected, even after AV integration**, on stored-XSS / execution-vector grounds (AV detects malware
  signatures, not markup-rendering/execution vectors; the no-inline headers are defense-in-depth, not a
  substitute). They return `415` in v1 and remain `415` post-AV (§5). No longer open.

**Owner-P1 concurrency/cleanup contracts (not ratify questions — design contracts the implementation MUST
satisfy).** Folded in Rev 3 and **corrected in Rev 4**: the **bind↔GC race guard** (§7, G11, §12 item 13)
and the **object-store cleanup on instance deletion** (§3-bis/§7, G12, §12 item 14). **Rev 4 correction:**
Rev 3 had the GC blob-delete synchronously and asserted a crash left "a recoverable orphan, re-swept next
pass" — that was **WRONG** (a soft-deleted crashed row is never re-swept ⇒ permanent leak). Rev 4 decouples
claim from purge via a **durable `approval_attachment_blob_purge` intent** (§3-bis) written gated on the
conditional claim's non-empty `RETURNING`, a **row-delete trigger** enqueuing every path-independent delete,
and an **idempotent lease-worker** as the sole blob-deleter (§7, G14, §12 item 16). Four crash windows are
covered.

No new authorization path is required by any of the above — D4 keeps downloads on the existing
approval-visibility predicate. If implementation ever finds that predicate insufficient for some
reader class, that is a **new 待裁决 item to bring back here**, not something to design in-line.

---

## 14. Document history

- **2026-07-09** — initial DESIGN-LOCK, **PROPOSED**, with seven open ratify questions (original §13).
- **2026-07-12 (Rev 2)** — folded in owner architecture decisions D1–D6 (§0-bis): object storage (not
  local FS, refs #159), dedicated `approval_attachments` table, initiator-upload, auth-proxied
  download, default-OFF, v1 allowlist narrowed to PDF/JPEG/PNG/TXT/CSV with Office/ZIP deferred until
  AV integration. Corrected the stale "S3-capable" substrate claim (S3 skeleton removed in F6, refs
  #3925) and named the object-store `StorageProvider` as an implementation prerequisite. Restructured
  §13 into answered (13.1) vs 待 owner 裁决 (13.2). **Status remains PROPOSED — awaiting owner ratify**
  on §13.2 and the lock as a whole.
- **2026-07-13 (review corrections)** — per independent adversarial review: re-grounded the §2
  `routes/files.ts` gap (the router is now F1 ACL-gated owner-or-admin-else-404, not authenticate-only;
  the disqualifier is the wrong-predicate argument, unchanged conclusion); reclassified the §5
  svg/html/xml/executables permanent-reject-post-AV as a doc-proposed v2 default 待 owner 确认
  (new §13.2-O4 — D6 covered only the v1 narrowing + Office/ZIP→AV deferral); required a constructed
  concurrent double-submit race test for §4.4/G4 one-shot bind; noted the `StorageProvider` interface
  is module-private and its export is part of the D1 prerequisite. **Status remains PROPOSED.**
- **2026-07-14 (Rev 3)** — folded in the four owner decisions that close the former §13.2 open items:
  **O1** size/count caps owner-DECIDED (20 MB/file, 10 files/attachment-field, 50 MB/submission — §5/§9);
  **O2** unbound-retention TTL owner-DECIDED **7 days (168 h)** and added a **stale-reference-detection on
  draft-restore** contract (§8, G13, test 15); **O3** production storage owner-DECIDED **S3-compatible
  object-store only**, local-FS provider in prod **fail-closes (503)** (§7/§9); **O4** `svg`/`html`/`xml`/
  executables owner-DECIDED **permanently rejected even post-AV** on stored-XSS/execution-vector grounds
  (§5). Also folded in two owner-P1 concurrency/cleanup contracts: the **bind↔GC claim-then-delete-blob
  race guard** (§7, G11, test 13 — a constructed GC↔submit race asserting a just-bound blob survives) and
  the **object-store cascade cleanup on instance deletion** (§3/§7, G12, test 14 — DB `ON DELETE CASCADE`
  drops rows but never the object-store blobs, so an explicit cleanup leg is required). §13 now records
  **all questions answered / owner-DECIDED with §13.2 empty**. **Status remains PROPOSED — default-OFF,
  owner-ratify-gated; no runtime ships with this revision.**
- **2026-07-14 (Rev 4)** — **owner-P1 correction: Rev 3's object-store cleanup was not crash-safe.** Rev 3
  had the GC do the claim (soft-delete) **and** the blob-delete synchronously, with a residual note that a
  crash between them left "a recoverable orphan blob, re-swept on the next pass." **That claim was WRONG:**
  after the GC commits `deleted_at` and crashes before the blob-delete, the next sweep scans only
  `deleted_at IS NULL`, so the row is **never re-processed** — a **permanent blob leak**. Rev 4 decouples
  claim from purge: a new **`approval_attachment_blob_purge` durable-intent table** (§3-bis) whose row is
  written **in the same transaction as, and gated on, the conditional claim's non-empty `RETURNING`**
  (preserving the §7 bind↔GC symmetric guarantee by construction — no intent unless the GC actually doomed
  the blob); a **DB trigger on `approval_attachments` row-delete** that enqueues the same intent for every
  path-independent delete (instance cascade, admin purge, retention hard-delete, test cleanup — chosen over
  dropping the FK cascade and forcing all deletes through the app); and an **idempotent lease-worker**
  modeled on `AttendanceNotificationDeliveryWorker` (`services/AttendanceNotificationDeliveryWorker.ts`) as
  the **sole blob-deleter**, scanning the **intent queue, not `deleted_at IS NULL`**, reusing the idempotent
  cross-process-safe **`deleteByKey`** (`StorageService.ts:268`; ENOENT-as-success by contract) so not-found is
  **terminal-success**. Removed
  the wrong "recoverable orphan, re-swept" §7 note; added the **four crash windows** (unbound GC sweep /
  bind↔GC loser / instance cascade / explicit unbound delete) each with RED test + positive control;
  updated **G11/G12**, added **G14**, added **§12 item 16**. Serialization (§12 item 13's both-interleavings
  race) and durability (item 16's crash windows) are orthogonal and both retained. **Status remains
  PROPOSED — default-OFF, owner-ratify-gated; no runtime ships with this revision.**
