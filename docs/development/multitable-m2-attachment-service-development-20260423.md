# Multitable M2 Attachment Service — Development Notes (2026-04-23)

> Document type: development / status
> Date: 2026-04-23
> Branch: `codex/multitable-m2-attachment-service-20260423`
> Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/m2-attachment`
> Baseline: `d1f35edf6` (= `origin/main` HEAD)
> Roadmap reference: `docs/development/multitable-service-extraction-roadmap-20260407.md` section 5.3 (M2 slice 1), section 10 (hard rules)
> M0 precedent: `docs/development/multitable-m0-extraction-development-20260421.md`

## TL;DR

M2 slice 1 is done: the attachment write/read/delete/summary helpers and the three route
handlers (`POST/GET/DELETE /api/multitable/attachments`) now delegate to a new
`packages/core-backend/src/multitable/attachment-service.ts` module. Pure extraction — no
HTTP response shape changed, no storage semantic changed, no permission check moved.

`record-service.ts` (M2 slice 2) and `query-service.ts` (M3) remain deferred per the
roadmap.

---

## 1. Scope

### 1.1 What was extracted

Seven exports in the new `packages/core-backend/src/multitable/attachment-service.ts`
module (lines cited are post-extraction locations in the new module):

| Export | Service-module L# | Origin in `routes/univer-meta.ts` (pre-extraction) | Purpose |
|---|---|---|---|
| `normalizeAttachmentIds` | L194 | L878 `normalizeAttachmentIds` + L847 `normalizeLinkIds` | Parses attachment id column values (arrays, JSON, CSV). Copy of `normalizeLinkIds` — intentionally duplicated to keep the service self-contained (see §2.1). |
| `serializeAttachmentRow` | L239 | L3048 `serializeAttachmentRow` + L3027 `buildAttachmentUrl` + L3044 `isImageMimeType` | HTTP response serializer for a single attachment row. `buildAttachmentUrl` pulled inside as a private helper. |
| `serializeAttachmentSummaryMap` | L269 | L3402 `serializeAttachmentSummaryMap` | Flattens nested `Map<recordId, Map<fieldId, Attachment[]>>` to plain-object form. |
| `ensureAttachmentIdsExist` | L289 | L3220 `ensureAttachmentIdsExist` | Validates `field_id` scoping and existence. Returns the same error strings verbatim. |
| `buildAttachmentSummaries` | L322 | L3339 `buildAttachmentSummaries` | Bulk summary builder used by record GET/list/form GET responses. |
| `storeAttachment` | L386 | L7528–L7585 inline in `POST /attachments` handler | Uploads via storage adapter, inserts `multitable_attachments` row, best-effort cleans up binary on DB error. |
| `readAttachmentMetadata` | L448 | L7615–L7620 inline `SELECT` inside `GET /attachments/:id` | Fetches the column subset the download flow needs. |
| `readAttachmentBinary` | L475 | L7635 `storage.download` call | Thin wrapper over the storage adapter. |
| `readAttachmentForDelete` | L487 | L7667–L7672 inline `SELECT` inside `DELETE /attachments/:id` | Fetches the column subset the delete flow needs for authorisation + cleanup. |
| `softDeleteAttachmentRow` | L519 | L7737–L7740 inline `UPDATE multitable_attachments SET deleted_at = now()` | Designed to run inside a tx-scoped `query`, so the route can keep the record-data patch in the same transaction. |
| `deleteAttachmentBinary` | L546 | L7743–L7748 inline `storage.delete` + try/catch | Swallows storage errors to preserve the pre-existing "best-effort cleanup" behavior. |

### 1.2 Route-layer changes (`packages/core-backend/src/routes/univer-meta.ts`)

Net diff: `-215` / `+61` LoC (`git diff --stat`).

- **Imports added (L43–L56)** — 11 named imports from the new
  `../multitable/attachment-service`, plus the shared `MultitableAttachment` type
  aliased as `SharedMultitableAttachment`.
- **Type alias** `MultitableAttachment` (L219) now re-exports `SharedMultitableAttachment`.
- **Delegating wrappers** (preserving the legacy positional-argument signatures that the
  `RecordWriteService` helpers expect):
  - `normalizeAttachmentIds` (L869) — `const normalizeAttachmentIds = normalizeAttachmentIdsShared`.
  - `serializeAttachmentRow` (L3029) — `const serializeAttachmentRow = serializeAttachmentRowShared`.
  - `ensureAttachmentIdsExist` (L3207) — 4-arg wrapper that builds the options object.
  - `buildAttachmentSummaries` (L3330) — 5-arg wrapper that builds the options object.
  - `serializeAttachmentSummaryMap` (L3334) — re-exported reference.
- **Route handler bodies** (lines refer to the post-edit file):
  - `POST /attachments` (L7363): auth/permission checks preserved; storage+DB code replaced
    with `await storeAttachmentShared(...)`.
  - `GET /attachments/:attachmentId` (L7466): metadata SELECT replaced with
    `readAttachmentMetadataShared(...)`; binary download replaced with
    `readAttachmentBinaryShared(...)`. Response headers and 401/403/404 logic unchanged.
  - `DELETE /attachments/:attachmentId` (L7508): pre-delete SELECT replaced with
    `readAttachmentForDeleteShared(...)`; soft-delete UPDATE inside the tx replaced with
    `softDeleteAttachmentRowShared({ query, attachmentId })`; post-tx storage cleanup
    replaced with `deleteAttachmentBinaryShared(...)`. Permission checks, record-data
    patch (still inside the same tx), and realtime publish unchanged.

- **Inline definitions removed**:
  - `buildAttachmentUrl` (was L3027) — moved into service as a private helper.
  - Local copies of the upload SQL (L7447–L7468), download SELECT (L7615–L7620), delete
    SELECT (L7667–L7672), soft-delete UPDATE (L7737–L7740), and storage cleanup try/catch
    (L7743–L7748).

### 1.3 Hard-rule compliance

Per roadmap §10:

1. ✅ No plugin depends on the new service — exports are internal to
   `packages/core-backend/src/multitable/`.
2. ✅ `univer-meta.ts` no longer carries inline attachment SQL.
3. ✅ The `attachment-orphan-retention.ts` module is left untouched.
4. ✅ The pre-existing `multitable/access.ts`, `multitable/loaders.ts`,
   `multitable/provisioning.ts` modules are not modified.
5. ✅ New unit-test file accompanies the new module
   (`tests/unit/multitable-attachment-service.test.ts`, 24 tests).

---

## 2. Deliberate non-choices

### 2.1 `normalizeAttachmentIds` duplicated rather than imported

The route still has its own `normalizeLinkIds` used by link-field handling. Cross-importing
the route helper into the service would reverse the dependency direction. The 27 lines of
the parsing helper are duplicated verbatim inside the new module. Future consolidation
belongs with `record-service.ts` (M2 slice 2), which is the natural owner of link-field
normalization.

### 2.2 `deleteAttachment` not unified into a single function

The brief suggested an atomic `deleteAttachment({ query, attachmentId })` that removes
binary + row transactionally. **That is not what the route does today** — today the
`meta_records.data` patch + `multitable_attachments.deleted_at` mutation run inside one
transaction owned by the route; the storage `delete()` runs **after** the transaction, is
best-effort, and swallows errors. To keep this a pure extraction:

- `softDeleteAttachmentRow({ query, attachmentId })` accepts a tx-scoped `query` so the
  route keeps ownership of the transaction and can continue to bundle the record-data
  patch with the row update.
- `deleteAttachmentBinary({ storage, storageFileId })` runs **outside** the tx, best-effort,
  matching the pre-existing semantic.

The record-data patch (`UPDATE meta_records SET data = data || $1::jsonb ...`) stays in
the route because that is record-service (M2 slice 2) territory. Extracting it now would
cross a scope line the roadmap draws in §6.

### 2.3 `listAttachmentsForRecord` not exposed

The brief listed `listAttachmentsForRecord({ query, recordId })`, but no such single-record
helper exists inline in `univer-meta.ts`. The only bulk lookup used across the route is
`buildAttachmentSummaries`, which operates over *multiple records × multiple attachment
fields*. Adding a new per-record helper would be scope creep beyond pure extraction. No
caller needs it today.

### 2.4 Record-service (M2 slice 2) remains deferred

The record PATCH/POST handlers still directly call
`normalizeAttachmentIds`/`ensureAttachmentIdsExist` via the `RecordWriteService` helper
bag. That coupling is not a problem today — the bag now passes the re-exported functions
from the new service instead of the inline copies — but the full record write path remains
in `record-write-service.ts` as before. Moving it is the next slice.

### 2.5 Query-service (M3) remains deferred

The GET /records list, view resolver, and all lookup/rollup calls remain in
`univer-meta.ts`. `buildAttachmentSummaries` is the last of those that has been extracted;
the rest wait for M3.

### 2.6 Permission-service (M4) not considered

The route still owns every call to `resolveSheetCapabilities`, `ensureRecordWriteAllowed`,
`loadRecordCreatorMap`, and `sendForbidden`. Moving them into the attachment service would
tangle access-control policy with storage helpers. Per roadmap §5.5 the permission service
is deferred.

### 2.7 `attachment-orphan-retention.ts` not merged

The existing cron-based orphan cleanup in `multitable/attachment-orphan-retention.ts` has
its own retention-hours/batch-size policy knobs, reads
`MULTITABLE_ATTACHMENT_CLEANUP_*` env vars, and uses the package-level `query` from
`db/pg` rather than a per-request pool. It is a cron module, not a request-scoped service.
Leaving it as a sibling under `multitable/` satisfies the brief's "leave it alone if it
already exists" clause. Consolidation would require coordinating the retention schedule
with test fixtures — orthogonal to this slice.

---

## 3. Surprises and design notes

### 3.1 `buildAttachmentUrl` stayed private inside the service

The route used `buildAttachmentUrl` only via `serializeAttachmentRow`. Making it an
exported surface would encourage callers to build URLs directly and reinvent the url
scheme. It is a file-local helper inside the service; the service takes a structural
`AttachmentUrlRequestLike` type (not the full Express `Request`) so tests can inject a
minimal stand-in.

### 3.2 Route still keeps `isImageMimeType`

Used at line 7488 in the GET handler to set `Content-Disposition: inline` for image
downloads — outside the serializer. Duplicating `isImageMimeType` between the route and
the service was cheaper than adding another tiny exported util.

### 3.3 `storeAttachment`'s id generator

The route generates attachment ids via the local `buildId('att').slice(0, 50)` helper
(which uses `randomUUID` and a prefix). The service exposes an `idGenerator?: () =>
string` hook to keep that contract. Default is `att_${randomUUID()}.slice(0, 50)` to match.

### 3.4 Userid coercion edge case

`req.user?.id` is typed `string | number`. The old code passed it to a PG string column
via JS implicit conversion. The new `storeAttachment` signature is strictly typed
(`uploaderId: string`), so the route now does an explicit `String(x)` coerce when
`req.user.id` is numeric. Observable behavior is the same.

### 3.5 Integration-test log noise is expected

`tests/integration/multitable-attachments.api.test.ts` contains two scenarios where the
backing storage blob is deliberately missing (the DB row has a fabricated
`storage_file_id` and the LocalStorageProvider.delete throws "File not found"). The route
still returns 200 because `deleteAttachmentBinary` swallows the error. Both tests pass;
the error log from `StorageService` is the intended behavior under test, not a
regression.

---

## 4. Verification

See `docs/development/multitable-m2-attachment-service-verification-20260423.md` for the
full command list + pass counts.

Summary:

| Command | Result |
|---|---|
| `tsc --noEmit --pretty false` (core-backend) | clean |
| `vitest run tests/unit/multitable-attachment-service.test.ts` | 24 tests pass |
| `vitest run tests/unit` (core-backend) | 127 files / 1643 tests pass (was 126/1619 at baseline; +1 file / +24 tests is the new module) |
| `vitest run tests/integration/multitable-attachments.api.test.ts` | 10 tests pass |
| `vitest run tests/integration/after-sales-installer-provisioning.api.test.ts` | 3 tests pass (unchanged from baseline) |

The `tests/integration/multitable-sheet-realtime.api.test.ts` file has 3 failures that are
**pre-existing at baseline (`origin/main@d1f35edf6`)** — verified by stashing this branch's
changes and re-running. They are unrelated to this extraction.

---

## 5. Follow-up slices

| Slice | Owner | Status |
|---|---|---|
| M2 slice 2 — `record-service.ts` | same roadmap | deferred (next PR) |
| M3 — `query-service.ts` | roadmap §5.4 | deferred |
| M4 — `permission-service.ts` | roadmap §5.5 | deferred |
| Attachment orphan cleanup consolidation | cross-cutting | optional follow-up |

---

## 6. References

- Roadmap: `docs/development/multitable-service-extraction-roadmap-20260407.md`
- M0 precedent: `docs/development/multitable-m0-extraction-development-20260421.md`
- New module: `packages/core-backend/src/multitable/attachment-service.ts`
- New unit tests: `packages/core-backend/tests/unit/multitable-attachment-service.test.ts`
- Route under extraction: `packages/core-backend/src/routes/univer-meta.ts`
- Sibling orphan cleanup (untouched): `packages/core-backend/src/multitable/attachment-orphan-retention.ts`
