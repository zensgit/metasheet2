# B3-07 — Approval attachment upload pipeline · DESIGN-LOCK

**Status: PROPOSED** (doc-only; awaits owner ratify). No runtime code ships with this document.
Implementation is a **later, separately-opted-in** change and MUST land behind the default-OFF flag
defined in §9. Until ratify + implementation, the B2-28 honest-disable stopgap (§1) stays exactly as
it is.

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

- **`StorageServiceImpl`** (`services/StorageService.ts`) — local-FS default, S3-capable, size-limited
  (`uploadLimit`), with `upload/download/delete`. This is orthogonal to any permission model; forking it
  would duplicate a security-relevant code path. Reuse it.
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
- **Generic unauthenticated-by-object file router.** `routes/files.ts` (`GET /api/files/:id/download`) serves
  any stored blob by id with only `authenticate` (no per-object authz). Approval blobs MUST be stored under
  the segregated attachment storage path and MUST NOT be reachable via that router; the serialized DTO MUST
  expose only the approval-scoped download URL and MUST NOT echo the raw `storageUrl`.

---

## 3. Data model — new `approval_attachments` table

New, additive, sequentially-numbered migration. Shape (final column list decided at ratify; proposed):

```
approval_attachments (
  id                text PRIMARY KEY,          -- 'aatt_<uuid>'
  instance_id       text REFERENCES approval_instances(id) ON DELETE CASCADE,  -- NULL while unbound (draft)
  field_id          text NOT NULL,             -- the attachment field id in the template form schema (string, not FK)
  storage_file_id   text NOT NULL,             -- StorageService blob id
  storage_path      text NOT NULL,
  storage_provider  text NOT NULL DEFAULT 'local',
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

---

## 4. Endpoint contracts + authorization

All endpoints are **authenticated** (existing approval auth middleware) and are **no-ops / 404 when the
feature flag is OFF** (§9).

### 4.1 Upload — `POST /api/approvals/attachments` (multipart, field name `file`)

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
- Blob bytes are read via the reused `StorageService.download`; the raw storage URL is never exposed.

### 4.3 Delete — `DELETE /api/approvals/attachments/:id`

- **Unbound:** the `uploaded_by` uploader may delete their own draft attachment (soft-delete row +
  best-effort blob delete).
- **Bound:** an attachment frozen into a submitted instance is **immutable** and is NOT deletable via this
  endpoint (the snapshot is frozen; there is no "edit the submitted form"). Instance-level cascade
  (`ON DELETE CASCADE`) handles instance deletion/purge only.

### 4.4 Bind at create (server, inside the create-instance transaction)

- After `pruneHiddenFormData` + `validateApprovalFormData`, for each attachment field the normalized value is
  an array of attachment ids. The server: (a) validates each id per §4.1; (b) `UPDATE approval_attachments
  SET instance_id=…, bound_at=now() WHERE id=… AND instance_id IS NULL AND uploaded_by=…` (atomic
  unbound→bound, one-shot); (c) writes the **frozen id array** into `form_snapshot` (§8). All within the same
  transaction that inserts the instance, so a half-bound state is impossible.

---

## 5. Allowed size / type + validation (reject-by-default)

- **Size cap:** approval-specific, `APPROVAL_ATTACHMENT_MAX_SIZE` (env), **proposed default 20 MB** (smaller
  than the 100 MB multitable cap — approvals are form attachments, not data-lake blobs). Enforced by multer
  `fileSize` AND re-checked server-side against the stored byte length.
- **Count caps:** proposed **max 10 files per attachment field** and a **per-submission total-bytes cap**
  (proposed 50 MB). Reject-by-default over cap → `413`.
- **Type allowlist (reject-by-default, `415` otherwise):** an explicit MIME **and** extension allowlist, both
  must pass. Proposed starter set — documents/spreadsheets/slides (`pdf`, `doc/docx`, `xls/xlsx`, `ppt/pptx`,
  `csv`, `txt`), images (`png`, `jpg/jpeg`, `gif`, `webp`), archives (`zip`). **Explicitly rejected:**
  `svg`, `html/htm`, `xml`, and any executable/script type — these are stored-XSS or execution vectors.
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
- **Scan hook seam (default no-op).** v1 defines a `scanHook(attachment) → 'clean'|'infected'` seam and the
  `scan_state` column, **default pass-through** and flag-gated, so an AV engine (e.g. a ClamAV sidecar) can be
  wired later without re-opening this lock. Until a scanner is wired, the standing mitigations are: the
  reject-by-default allowlist, the size cap, no-inline serving, and non-execution. A `scan_state = 'infected'`
  row is never bindable (§4.4) and never downloadable.

---

## 7. Migration / rollout

- **Default-OFF flag `APPROVAL_ATTACHMENTS_ENABLED`** (env, default `false`). While OFF: upload/download/delete
  endpoints return `404`/`403`; attachment stays honestly-disabled — **B2-28 UI, `stripAttachmentFields`, the
  authoring lock, and the prefill/draft skips all remain UNCHANGED.**
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
  scheduled sweep soft-deletes + blob-deletes unbound (`instance_id IS NULL`) rows older than
  `APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS` (proposed 24 h), so abandoned drafts don't accumulate blobs.

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
- **Mobile parity.** The mobile detail surface renders the resolved refs through the same helper as desktop
  (pure, Element-Plus-free resolver in `apps/web/src/approvals/`), so the two surfaces cannot drift.

---

## 9. Feature flag summary

| Flag / env | Default | Effect |
|---|---|---|
| `APPROVAL_ATTACHMENTS_ENABLED` | `false` | Master gate. OFF ⇒ endpoints 404/403, field honestly-disabled, authoring locked. |
| `APPROVAL_ATTACHMENT_MAX_SIZE` | 20 MB (proposed) | Per-file size cap. |
| `APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS` | 24 (proposed) | GC TTL for abandoned unbound draft attachments. |
| `APPROVAL_ATTACHMENT_SCAN_ENABLED` | `false` | Enables the AV scan hook; default no-op pass-through. |

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
   is stored for integrity/future use only).
9. **Chunked / resumable / async large-file upload** — single synchronous multipart within the size cap.

---

## 11. Acceptance gates (implementation must satisfy ALL)

- **G1 — Flag fail-closed.** With `APPROVAL_ATTACHMENTS_ENABLED=false`, upload/download/delete return
  404/403 and the B2-28 UI + strip + authoring lock are byte-unchanged.
- **G2 — Upload authorization.** Only an authenticated actor can upload; the row is created unbound and
  owned by the uploader. A non-attachment `fieldId` is rejected.
- **G3 — Reject-by-default validation.** Over-size → 413; disallowed MIME/extension (incl. `svg`, `html`,
  executables) → 415; MIME/magic-byte mismatch → 415; over count/total caps → 413.
- **G4 — Bind integrity.** Create-instance binds only ids that are unbound + owned-by-actor + field-matched +
  not `infected`; any failing id fails the whole create (no partial bind); binding is one-shot (a bound id
  cannot rebind).
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
- **G10 — GC.** Unbound attachments past the retention TTL are swept (row soft-deleted + blob deleted); bound
  attachments are never swept by the sweep.

## 12. RED-before test list (write these FAILING first, then implement)

Backend (`packages/core-backend/tests/integration/`, `.api.test.ts` / `.db.test.ts`):

1. `approval-attachment-flag-fail-closed` — flag OFF ⇒ all three endpoints 404/403; B2-28 behavior unchanged.
2. `approval-attachment-upload-auth` — unauthenticated 401; non-attachment field 400; happy path creates an
   unbound, uploader-owned row.
3. `approval-attachment-validation` — oversize 413; disallowed MIME (svg/html/exe) 415; magic-byte mismatch
   415; count/total-bytes caps 413.
4. `approval-attachment-bind-at-create` — binds owned+unbound+field-matched ids; refuses foreign/rebound/
   infected id (whole create fails); one-shot bind (rebind refused).
5. `approval-attachment-download-visibility` — no-access reader 404; initiator/approver/CC/admin 200; unbound
   readable only by uploader.
6. `approval-attachment-hidden-redaction` — field hidden at active node ⇒ snapshot echo strips ids AND
   download refuses ids (same active-node set); non-hidden ⇒ both present. (Extends the existing
   `approval-bridge-redaction-regression` shape.)
7. `approval-attachment-serving-headers` — asserts `Content-Disposition: attachment`, `nosniff`, `CSP`,
   and absence of `storageUrl` in the body.
8. `approval-attachment-frozen-snapshot` — post-submit source mutation/soft-delete does not change the
   rendered resolution; tombstone on soft-delete.
9. `approval-attachment-gc-retention` — unbound past TTL swept; bound never swept.

Frontend (`apps/web/tests/`, `.spec.ts` / `.test.ts`):

10. `approval-attachment-uploader.spec` — with flag ON, the disabled placeholder is replaced by a working
    uploader that posts to the endpoint and stores the returned id (not a raw `File`); with flag OFF, the
    B2-28 placeholder + strip persist.
11. `approval-attachment-detail-render.test` — a pure resolver renders frozen ids → filename/size/download
    link on desktop and mobile via the same helper (parity); tombstone for a missing/soft-deleted ref;
    hidden-field ref is absent from the rendered snapshot.
12. `approval-attachment-authoring.test` — after rung 4, `attachment` is an `AuthorableFieldType` and the
    template authoring form is no longer whole-locked by an attachment field.

---

## 13. Open questions for owner at ratify

1. **Size + count caps** — confirm 20 MB/file, 10 files/field, 50 MB/submission, or set your own.
2. **Type allowlist contents** — confirm the proposed MIME/extension set (and the hard rejects: svg/html/xml/
   executables).
3. **Prod storage backend** — local FS (default) vs S3 for the deploy host; and the unbound-retention TTL.
4. **Approver-uploaded attachments** — v1 recommends **out of scope** (initiator-only). Confirm.
5. **AV scan now or defer** — wire a scanner in v1, or ship the no-op hook + allowlist mitigations and defer?
6. **Table shape** — confirm the new `approval_attachments` table over any alternative (the lock rejects
   extending `multitable_attachments`).
7. **Download delivery** — always-proxied through the authenticated endpoint (recommended) vs short-lived
   signed URLs (adds a bypass surface to the visibility gate — not recommended for v1).
