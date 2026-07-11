# Attendance Outdoor-Punch Photo-Evidence Contract + `requirePhoto` Enforcement — Design Lock (S2)

- Date: 2026-07-10
- Status: **RATIFIED** (design裁量已定；本 doc 为实现落地记录)
- Scope: opens the previously-latent `punchPolicy.outdoor.requirePhoto` knob into a real, server-verifiable
  photo-evidence contract for the outdoor-punch approval flow. Mirrors the existing `requireNote`
  enforcement shape exactly (S3 lock `attendance-outdoor-approval-s3-design-lock-20260605.md` / #2304 / #2308).
- Predecessor state: S3 shipped `punchPolicy.outdoor.{requireApproval,requireNote,approvalFlowId}` as
  wire-settable and left `requirePhoto` **latent** (normalized on read via `bool(...)`, but NOT wire-settable
  and with no attachment contract behind it — "no fake security"). This slice removes that latency by giving
  a `photoFileId` a real server-side verification path.

---

## 原锁 (ratified gates)

| Gate | Requirement | Landing site (symbol · approx. line) |
|---|---|---|
| **G1** | `punchSchema` gains `photoFileId: z.string().min(1).optional()` — a `files`-row id (from core `POST /api/files/upload`), never a free-form URL/meta blob. | `plugins/plugin-attendance/index.cjs` punchSchema (`~L22001`) |
| **G2** | Any supplied `photoFileId` is verified against the `files` table with three checks — **row exists**, **`owner_id === punching user`**, **`meta.contentType` starts with `image/`** — else `422 OUTDOOR_PHOTO_INVALID`. Verification is **presence-triggered** (runs whenever a `photoFileId` is supplied, regardless of `requirePhoto`), so a supplied-but-invalid photo is always rejected. | punch handler outdoor branch (`~L24660`) |
| **G3** | Enforcement point mirrors `requireNote` **exactly** — nested inside the accepted-outdoor-candidate branch (`requireApproval=true` precondition): `requirePhoto === true && !photoFileId → 422 OUTDOOR_PHOTO_REQUIRED`. No separate enforcement path is opened for the `requireApproval=false` case (an outside-fence punch already `403`s `LOCATION_RESTRICTED` there — there is no accepted outdoor punch to attach evidence to). | punch handler, immediately after `OUTDOOR_NOTE_REQUIRED` (`~L24660`) |
| **G4** | `requirePhoto: z.boolean().optional()` opened in the settings `punchPolicy.outdoor` zod object + the `:21789` "latent" comment updated to reflect the now-live contract. **Enum-strict**: a non-boolean `requirePhoto` is rejected at the settings gate (`400 VALIDATION_ERROR`), never silently coerced. | settings `punchPolicy` schema (`~L21804`) |
| **G5** | Admin `outdoorForm` gains a `requirePhoto` toggle (checkbox + hint) with load (`applyOutdoorToForm`) and save (`saveOutdoorApproval` PUTs it explicitly) wiring; the save payload PUTs **only** `punchPolicy.outdoor`, so the backend per-key merge preserves siblings. | `apps/web/src/views/AttendanceView.vue` |
| **G6** | **Hero punch flow and `punchOutcome.ts` are byte-for-byte untouched** (red line). Verified: `git diff origin/main -- apps/web/src/views/attendance/punchOutcome.ts` is empty. | — |
| **G7** | `photoFileId` lands in `draft.metadata.outdoorPunch.photoFileId` **only when a verified photo is supplied** (conditional write), so `requirePhoto=false` + no photo produces the pre-slice `metadata.outdoorPunch` shape byte-for-byte (9 keys, no null-valued key added). | punch handler metadata construction (`~L24729`) |

**Error taxonomy** (values-free — code/enum only, no user-value echo):
`OUTDOOR_PHOTO_REQUIRED` (422), `OUTDOOR_PHOTO_INVALID` (422), `VALIDATION_ERROR` (400, non-bool requirePhoto).

**Disabled = byte-identical**: `requirePhoto=false` is a strict no-op on the punch path — no new metadata key, no
new 4xx branch reachable, no change to the existing settings round-trip beyond the (opt-in, default-false) field.

---

## AMENDMENT — three pre-existing substrate defects fixed to make G2 real (coordinator-ratified 2026-07-10)

The G2 verification requires a `files` table that is actually written (so a `photoFileId` maps to a real
owner + content-type) and actually present on a migrated DB. Three pre-existing defects blocked that. All
three fixes are **surgical** (they change nothing about the routes' externally-observable behavior beyond the
new INSERT), and each is proven empirically.

### Fix A — zombie `files` table → real writer (Option A INSERT)

- **Defect**: `files` (migration `035_create_files`) had **zero writers anywhere** — `POST /api/files/upload`
  wrote only an in-memory storage index and never a row, so no `photoFileId` could ever be verified.
- **Fix**: on the upload success path, `INSERT INTO files (id, url, owner_id, meta, created_at)` (meta carries
  `contentType`/`filename`/`size`). If the INSERT fails, the **upload as a whole fails** (storage object is
  rolled back via `storage.delete`, `5xx` returned) — never "success with no row". No other route behavior
  changed. Site: `packages/core-backend/src/routes/files.ts` upload handler.
- **Empirical proof**: `S2-photo E2E` integration test uploads a real image → asserts a real `files` row
  exists with `owner_id === uploader` and `meta.contentType === 'image/png'`, then punches with that
  `photoFileId` → `202` pending with `metadata.outdoorPunch.photoFileId === <uploaded id>`. Mutation cut ④
  (neuter the INSERT) turns this test red.

### Fix B — `files.ts` userId resolution was the whole-repo outlier → family alignment

- **Defect**: both `userId` resolutions in `files.ts` read `req.user?.sub || req.user?.userId || 'anonymous'`
  — missing the primary `.id`, the whole-repo outlier (every other of the ~15 sites tries `.id` first). With
  the JWT carrying identity in `.id` (dev-token payload `{ id: userId }`), this always resolved to
  `'anonymous'`, so an owner check `owner_id === punching user` could never match a real uploader.
- **Fix**: changed both sites to the whole-repo family pattern `req.user?.id ?? req.user?.userId ?? req.user?.sub`,
  byte-aligned with `packages/core-backend/src/routes/approvals.ts:111`, keeping the `?? 'anonymous'` fallback
  (fail-closed: an unauthenticated `'anonymous'` upload can never satisfy an authenticated punch's ownership
  check, so the fallback has no exploit surface). No header fallback was added (that would be resolution
  semantics beyond the dictated pattern — out of scope). The plugin punch handler resolves the same identity
  via `getUserId(req)` = `user?.id ?? ...` — both prioritize `.id`, so they agree for any real authenticated user.
- **Empirical proof**: the `S2-photo E2E` round-trip (`owner_id === u`) passes only because upload + punch now
  resolve the same identity. Mutation cut ⑤ (revert to `.sub || .userId`) turns the E2E red.

### Fix C — `035_create_files` superseded with no successor → bridge migration

- **Defect**: `035_create_files` is in `migration-provider.ts`'s `SUPERSEDED_LEGACY_SQL_MIGRATIONS` list, so on
  a fresh install it replays as a **no-op** and the `files` table is **never created** — the Option-A INSERT and
  G2 read would both hit a missing table.
- **Fix**: new bridge migration `packages/core-backend/src/db/migrations/zzzz20260710120000_create_files.ts`
  — the modern successor. Mirrors 035's table + index exactly (`id/url/owner_id/meta/created_at` + `idx_files_owner`),
  following the `must_change_password` bridge precedent. **Hard requirement — byte-exact no-op on old DBs that
  already have the table**: `up()` early-returns on `checkTableExists(db, 'files')` (a true no-op that touches
  nothing) and additionally guards every DDL with `IF NOT EXISTS`; `down()` drops with `IF EXISTS` — both
  directions idempotent. The `SUPERSEDED_LEGACY_SQL_MIGRATIONS` list itself is **not touched**.
- **Empirical proof**: fresh migrated DB (`db:migrate` on an empty database, CI's exact `MIGRATION_EXCLUDE`)
  yields a `files` table matching 035's structure (`\d files` verified: same columns + `idx_files_owner`), and
  the whole integration suite (26/26) runs natively on it with **no direct table-insert scaffolding**. Old-DB
  no-op verified by deleting the migration ledger row on a DB that already has a seeded `files` table and
  re-running `up()` → the seeded row survives untouched (see PR body for the exact command trace).

---

## 可达性诚实声明 (reachability honesty statement — 原样保留)

This slice wires and enforces `requirePhoto`, but it does **not** change what is reachable through the current
web UI. The web hero-punch flow never produces an outdoor candidate (`outsideGeofence || outdoorMarker`) — see
`apps/web/src/views/attendance/punchOutcome.ts` / UI-P0 #3806 §4 — so the admin `requirePhoto` toggle alone
cannot cause a *web* punch to actually require a photo. `requirePhoto` takes effect only for punch clients that
submit a location or an outdoor marker (i.e. the mobile / outdoor punch experience). That the web outdoor branch
is not reachable through the current hero-punch UI is a **pre-existing state**, and this slice deliberately does
**not** change that reachability — the reachable outdoor-punch client experience is the owner-deferred item
(T2 §3.1), out of scope here. This slice makes the contract *correct and enforceable* for the clients that do
reach it; it does not claim to make the web hero-punch flow exercise it.

---

## Test evidence (local, real DB)

- Backend integration + E2E: `tests/integration/attendance-outdoor-punch.test.ts` — **26/26 pass** on a
  freshly-migrated DB (Fix C proven natively). New cases: settings round-trip (not stripped), `422 REQUIRED`,
  `422 INVALID` × 3 (forged id / real non-image upload / another user's photo), E2E happy-path (real upload →
  punch → metadata), `requirePhoto=false` byte-identical (exact 9-key set), non-bool `requirePhoto` → `400`.
- FE spec: `apps/web/tests/attendance-admin-regressions.spec.ts` — **116/116 pass** (new requirePhoto-toggle
  save-payload assertion + 3 pre-existing outdoor-payload assertions updated to the now-always-sent field).
  Wired in `attendance-web-guard.yml` (both path-filters + vitest run list).
- Typecheck: backend `tsc --noEmit` clean; web `vue-tsc -b` clean.
- Mutation self-check (5 cuts): see PR body for red/green trace per cut.
