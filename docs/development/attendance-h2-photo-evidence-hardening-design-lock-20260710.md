# Attendance H2 — Photo-Evidence Hardening (P3-1 magic-byte sniffing + P3-2 orphan-row cleanup) — Design Lock

- Date: 2026-07-10
- Status: **RATIFIED** (coordinator decision recorded below; this doc is the implementation-landing record)
- Scope: two review-driven hardening fixes to the S2 outdoor-punch photo-evidence contract
  (`attendance-outdoor-require-photo-s2-design-lock-20260710.md` / #4016). Both close gaps in the `files`
  table substrate that S2 introduced — neither changes `punchPolicy.outdoor.requirePhoto` semantics, G1/G3/G4
  wire contracts, or default-off posture.

---

## P3-1 — photo evidence magic-byte sniffing

**Defect**: the `files` row's `meta.contentType` is client-asserted — `POST /api/files/upload` (multer) trusts
whatever the multipart part's `Content-Type` header claims, with no verification against the actual bytes.
S2's G2 check (`plugins/plugin-attendance/index.cjs` punch handler, outdoor branch) reads that same
client-asserted value and accepts anything starting with `image/`. A client can declare `Content-Type:
image/png` on an arbitrary non-image body and pass G2 — the "photo evidence" contract has no evidence that
the uploaded bytes are actually a photo.

**Fix — sniff on upload, consume the sniffed value in G2**:

| Site | Change |
|---|---|
| `packages/core-backend/src/services/imageMagicBytes.ts` (new, pure module) | `sniffImageContentType(buffer)` — ~20-line inline magic-byte match against PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), GIF (`GIF8`), WEBP (`RIFF….WEBP`), BMP (`BM`). No new dependency. Returns the detected `image/*` string, or `undefined` on no match (including short/empty buffers — never throws). |
| `packages/core-backend/src/routes/files.ts` upload success path | Sniffs `file.buffer` before the `files` INSERT and writes into `meta`: `sniffed: true` **unconditionally** (a path marker — see AMENDMENT below) and `sniffedContentType: <detected mime>` **only on a magic-byte hit**. `meta.contentType` (the client-asserted value) is unchanged. The route does **not** reject a sniff miss — `POST /api/files/upload` is a general-purpose upload endpoint (attachments, exports, etc. all flow through it); rejecting non-image uploads here would change its existing semantics for every caller, not just attendance evidence. |
| `plugins/plugin-attendance/index.cjs` punch handler, G2 (`~L24852`) | Consumption is now conditioned on the path marker: **`meta.sniffed === true`** → the row went through the sniff-aware upload path → the check requires `meta.sniffedContentType` to be present **and** start with `image/`, else `422 OUTDOOR_PHOTO_INVALID`. **`meta.sniffed` absent** → the row predates this slice (or was written by some other path) → falls back to the pre-existing `meta.contentType` check, byte-for-byte. Old evidence is never retroactively invalidated. |

---

## AMENDMENT — the sniff-write / G2-fallback contradiction found during implementation, and the coordinator's ruling

While implementing, a direct contradiction surfaced between two clauses of the original decree, both applied
to the exact same scenario the deliverable's own test matrix requires:

- **Sniff-write rule** (as originally worded): "a magic-byte miss on a new upload writes no `sniffedContentType`
  key."
- **G2 fallback rule** (as originally worded): "no sniff value present → fall back to `meta.contentType`
  (old-row-compat behavior)."

Walking the required forged-MIME test (multipart declares `image/png`, body is plain text) through both rules
literally: the sniff misses (rule 1) → no `sniffedContentType` written → G2 sees no sniff value (rule 2) →
falls back to `meta.contentType` = `'image/png'` (client-asserted, untouched) → **passes**. That is byte-for-
byte the same `meta` shape as the required old-row-compat test (a directly-inserted legacy row with only
`contentType` set, no `sniffedContentType`). One test demands `422`, the other demands pass-through, and — as
originally worded — there was no way to tell "this row went through the new sniff path and missed" apart from
"this row predates sniffing entirely," because both leave exactly the same absence of `sniffedContentType`.

**Two candidate resolutions were raised, both a controlled deviation from "a miss writes no key":**

- **(A) Path-marker field** (chosen): write `meta.sniffed = true` unconditionally on every upload through the
  new path; `meta.sniffedContentType` keeps its original pure meaning (present + `image/*` only on an actual
  hit). G2 branches on `sniffed`, not on `sniffedContentType`'s presence.
- **(B) Sentinel value**: write `meta.sniffedContentType` on every upload — the detected type on a hit, `null`
  (key present with a null value) on a miss — and have G2 branch on key-presence-including-null.

**Coordinator ruling: (A).** Reasons recorded for the record: (B)'s "key present but value `null`" is a
classic JSON-wire footgun — `'k' in obj`, `obj.k !== undefined`, and `obj.k != null` disagree with each other
across serialization boundaries (a driver or intermediate layer that drops null-valued keys silently turns it
back into (A)'s ambiguity), whereas (A)'s boolean path marker is unambiguous under any JSON round-trip and is
explicit enough for a future consumer of the `files` table to reuse without re-deriving this reasoning. (A)
also keeps `sniffedContentType`'s own meaning pure ("what did we detect," nothing else), which the original
decree's own wording for that field already committed to.

---

## P3-2 — `DELETE /api/files/:id` orphan row

**Defect**: `DELETE /api/files/:id` deleted only the storage object (`storage.delete(id)`); the `files` row
(written on upload since S2 #4016 — `id`/`url`/`owner_id`/`meta`/`created_at`) was left behind. Besides
accumulating orphan rows, this meant a punch could cite a `photoFileId` whose underlying storage object no
longer existed but whose `files` row — and therefore G2's existence/ownership/content-type check — still
looked valid: **dangling evidence** that G2 could not detect.

**Fix**: after `storage.delete(id)` succeeds, `DELETE FROM files WHERE id = $1` (parameterized via Kysely's
`sql` tag, consistent with the existing INSERT in the same file). A missing row is not an error — the delete
route is a no-op on a row that doesn't exist (an object that predates the S2 writer, or a second delete of the
same id) — matching SQL `DELETE`'s natural semantics; no new error branch was added.

**Out of scope (unchanged)**: no ownership check was added to the delete route (none existed before this
slice; adding one is a separate authorization decision, not a photo-evidence-hardening concern) and no
approval-time fault tolerance was added — historical `photoFileId` values already embedded in
`attendance_requests.metadata` are point-in-time audit records and are never rewritten by a later delete.

---

## OUT of scope (explicit)

- **Does not reject non-image uploads.** `POST /api/files/upload` remains a general-purpose file-upload route;
  a sniff miss is recorded, not enforced, at the upload layer. Enforcement is entirely on the attendance G2
  consumer side.
- **Does not retroactively rewrite or invalidate historical evidence.** Rows written before this slice (no
  `sniffed` key) and `photoFileId` values already embedded in past `attendance_requests.metadata` are left
  exactly as they were.
- **No new dependency.** The sniffing module is ~40 lines of hand-written byte comparisons; no `file-type` (or
  similar) package was added, and `pnpm-lock.yaml` is untouched by this slice.
- **No delete-route ownership/authorization change.** Pre-existing behavior (any authenticated caller may
  delete any file by id) is unchanged; this slice only makes the delete also remove the substrate row G2 reads.

---

## Test evidence (local, real DB)

`packages/core-backend/tests/integration/attendance-outdoor-punch.test.ts` — **29/29 pass** on a freshly
migrated DB (`db:migrate` against an empty Postgres, same migration set CI uses). New/changed cases:

- `S2-photo E2E` (existing, extended): real PNG upload asserts `meta.sniffed === true` and
  `meta.sniffedContentType === 'image/png'` in addition to the pre-existing owner/contentType assertions —
  regression coverage for the sniff-write path on a genuine image.
- `H2 P3-1: forged Content-Type` (new): multipart declares `image/png`, body is plain text → uploaded row has
  `meta.contentType === 'image/png'` (client claim, untouched) + `meta.sniffed === true` + no
  `sniffedContentType` key → punch with that `photoFileId` → `422 OUTDOOR_PHOTO_INVALID`.
- `H2 P3-1: legacy files row` (new): directly-inserted row (`meta = {contentType:'image/png'}`, no `sniffed`
  key) → punch passes (`202`), `metadata.outdoorPunch.photoFileId` set — proves the fallback path is intact.
- `H2 P3-2: delete removes the files row` (new): upload → `DELETE /api/files/:id` (`200`) → direct `SELECT`
  confirms the row is gone → punching with that now-deleted `photoFileId` → `422 OUTDOOR_PHOTO_INVALID`
  (dangling evidence rejected, not silently accepted).

Typecheck: `packages/core-backend` `tsc --noEmit` clean.

No FE surface in this slice (no UI change) — nothing new needed in `attendance-web-guard.yml`;
`attendance-outdoor-punch.test.ts` is already wired into `plugin-tests.yml`'s attendance integration gate.

## Mutation self-check (3 cuts, each reverted after observing red)

1. **G2 sniff-marker consumption removed** (`photoMeta.sniffed === true` branch deleted, always falls back to
   `meta.contentType`) → `H2 P3-1: forged Content-Type` turns **red** (`422` expected, upload's client-claimed
   `image/png` now passes → `202` observed).
2. **`DELETE FROM files` removed** from the delete route → `H2 P3-2: delete removes the files row` turns
   **red** at the post-delete `SELECT` assertion (row still present).
3. **Sniff-write removed** (`sniffImageContentType` call / `meta.sniffed`+`meta.sniffedContentType` deleted
   from the INSERT) → `S2-photo E2E`'s new `fileRow.meta.sniffed`/`sniffedContentType` assertions turn **red**
   (both `undefined`).

Each cut was applied to the working tree, the corresponding test observed red, then reverted before the next
cut (see PR body for the exact commands/output).
