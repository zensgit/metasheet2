# Files ACL + Tombstone (F1 + F2) — Design Lock

- Date: 2026-07-10
- Status: **RATIFIED** (owner + main-loop decree, recorded below as the implementation-landing
  record). This doc is the source of truth for the F1/F2 implementation on
  `claude/files-acl-tombstone-f1f2-20260710`.
- Scope: two owner-mandated fixes reopened against H2 (#4044, `7a94997e5`) by owner's PR review of
  the Wave-2 hardening closeout. Both live entirely in `packages/core-backend/src/routes/files.ts`
  and its immediate consumer (`plugins/plugin-attendance/index.cjs` G2 check) — one branch, two
  commits, per coordinator instruction.

## Owner review — verbatim excerpt (via #4051, `attendance-dingtalk-benchmark-target-and-tracker-20260601.md`)

> **P3 硬化小刀池 → Wave-2 两刀已合,但 owner 审阅（2026-07-10）REOPEN 硬化池,「已收口」口径作废**:
> H1 #4045 `4c0e11e2e` 判定成立 ✅;H2 #4044 `7a94997e5` 已合但暴露两个后续必修项——
> **F1〔P1〕文件资源级授权缺失**:files.ts 的 list/info/download/delete 只有 authenticate,任何登录用户可
> 枚举/读取/删除他人考勤照片。属既有平台缺口,但 S2/H2 把敏感照片证据接入后**不得再作 OUT 排除**;
> owner 已明示授权开安全刀（至少 owner/org/业务 ACL 锁住四端点）。
> **F2〔P2〕删除顺序重造悬挂证据**:H2 的 delete 先 storage.delete 后删行——存储删成/DB 删败时二进制
> 已消失而 files 行仍被 G2 当有效证据,恰是 H2 声称消灭的状态;改为 DB tombstone/失效**先行**,存储对象
> 异步/补偿删除,并补 DB 删除失败注入测试。
> **硬化池在 F1/F2 落地并复审通过前保持 OPEN**。

Owner's explicit authorization for F1 (this is a permission-layer change, called out separately
since the coordinator's own operating rules normally require a per-PR explicit unlock for anything
touching authorization):

> 单独开文件资源授权安全刀，至少锁住 list/info/download/delete 的 owner/org/业务 ACL。

## F2 — tombstone-first delete (P2)

**Defect**: `DELETE /api/files/:id` (as landed by H2 #4044) deleted the storage object first, then
the `files` row (`await storage.delete(id)` → `DELETE FROM files WHERE id = $1`). If the storage
delete succeeded but the row delete failed (partial failure, connection drop, etc.), the two split:
the binary is gone but the `files` row — and therefore G2's existence/ownership/content-type
check — still reads as valid evidence. That is exactly the dangling-evidence state H2 P3-2 was
supposed to close, just reached from the opposite direction.

**Fix — tombstone before touching storage, never hard-delete the row**:

1. New migration `packages/core-backend/src/db/migrations/zzzz20260710130000_add_files_deleted_at.ts`:
   adds `files.deleted_at TIMESTAMPTZ NULL`. Guarded by `checkTableExists` + `checkColumnExists`
   (mirrors `zzzz20260627150000_add_approval_usable_to_roles.ts`) — idempotent in both directions.
   **Must sort after** `zzzz20260710120000_create_files.ts` in filename order (`130000` >
   `120000`) — on a fresh DB the `files` table doesn't exist until that migration runs; if this one
   ran first its table-exists guard would no-op and the column would never land. Verified on a
   freshly-migrated DB (`\d files` shows the column after `db:migrate`).
2. `DELETE /api/files/:id` new order, gated on an active (`deleted_at IS NULL`) row existing:
   1. `UPDATE files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`. Throws → **5xx**,
      storage is never touched (the `try` around this step returns before the storage block runs).
   2. `storage.delete(id)`. Throws → **200** anyway + `logger.warn` with the file id. Reasoning: the
      row is already tombstoned, so evidence integrity holds regardless of what happens to the
      physical blob — every consumer (G2, this file's own info/download/list) already treats the id
      as gone. The blob's removal becomes a compensating cleanup (retry / manual sweep), explicitly
      **out of scope** for this slice (see OUT below) — not retried inline, not surfaced as a
      client-facing failure.
   3. The row is **never hard-deleted**. A tombstoned row is a permanent audit record + a
      compensating-delete pointer, not an orphan.
   - **No `files` row for this id** (legacy object predating the S2 writer, or an id whose only row
     was already tombstoned): unaffected by the above — falls through to the pre-F2 behavior
     (`storage.exists` → 404 if missing → `storage.delete`). Reaching this branch already required
     admin (see F1 below); a non-admin caller with no matching row is rejected by the ACL gate
     before ever reaching here.
3. **Every consumption path filters `deleted_at IS NULL`**, so a tombstoned row is uniformly
   invisible, not just to G2:
   - `plugins/plugin-attendance/index.cjs` G2 (`~L24852`): `SELECT id, owner_id, meta FROM files
     WHERE id = $1 AND deleted_at IS NULL LIMIT 1`.
   - `files.ts` info / download / delete: `loadActiveFileOwner(id)` (`SELECT owner_id FROM files
     WHERE id = $1 AND deleted_at IS NULL`), also doubling as F1's ACL row lookup.
   - `files.ts` list: `WHERE deleted_at IS NULL` in both the admin and non-admin branches.
4. **Injected-failure test coverage** (design-lock item 4, DI/spy per the repo's existing
   mocked-`db`-module route-test convention — see `tests/unit/plm-workbench-routes.test.ts`):
   - `tests/unit/files-delete-tombstone-order.test.ts` — route mounted standalone with `kysely`'s
     `sql` export mocked (files.ts only ever uses the raw `sql` tag, never the builder chain, so
     mocking `sql` itself — rather than `db.updateTable(...)` — is the direct equivalent here) and
     `StorageServiceImpl` mocked. Covers: (a) tombstone UPDATE throws → 500, `storage.delete` never
     called; (b) `storage.delete` throws → 200 + `logger.warn` call containing the id, but the
     tombstone UPDATE call is observed **before** the storage-delete call (ordering assertion — a
     reverted implementation flips this and also fails (a), since storage would run unconditionally
     before the UPDATE); normal path; cross-user 404 short-circuits before either call; no-row +
     non-admin → 404, no storage call.
   - Real-DB downstream consequences (a tombstoned row's punch-rejection and download-404) don't
     need failure injection — they follow from a *successful* tombstone, which a real Postgres can
     produce natively — so those are covered by real-DB integration tests instead (see below), not
     duplicated in the mocked unit test.

## F1 — resource-level ACL on list/info/download/delete (P1)

**Defect**: all four endpoints ran only `authenticate` (valid JWT, any user). Any logged-in caller
could `GET /api/files` to enumerate ids, then read or delete any other user's uploaded file —
including attendance outdoor-punch photo evidence, which S2 (#4016) and H2 (#4044) gave real
evidentiary weight by wiring it into the G2 punch check. Pre-photo-evidence this was a latent
platform gap; post-photo-evidence it is not acceptable to leave OUT, per owner's explicit
authorization quoted above.

**Fix — owner-or-admin, fail-closed**:

1. **New pure module** `packages/core-backend/src/services/filesAcl.ts`:
   - `getFilesRequestUserId(req)` — centralizes the existing `req.user?.id ?? req.user?.userId ??
     req.user?.sub ?? 'anonymous'` derivation (previously duplicated inline in upload/delete);
     stringifies a numeric `id` claim (functionally identical after the TEXT-column round-trip).
   - `isFilesRequestAdmin(req)` — `hasLegacyAdminClaim(req) || await isRbacAdmin(userId)`. The
     legacy-claim check (`role === 'admin'` / `roles.includes('admin')` / `perms` includes
     `'*:*'`/`'admin:all'`) is a byte-identical local copy of the pattern used by
     `routes/admin-users.ts`'s `ensurePlatformAdmin`/`hasLegacyAdminClaim` and `routes/events.ts`'s
     inline router-level gate; `isRbacAdmin` is `rbac/service.ts`'s exported `isAdmin` (same import
     used by `routes/permissions.ts`, `routes/events.ts`). Neither `admin-users.ts` nor `events.ts`
     exports its own copy of the claim check, so this file keeps its own too — matching the existing
     convention rather than introducing a new shared export.
   - `filesAclAllowsAccess({ admin, callerId, row })` — the single **pure** decision function (no
     I/O), unit-tested directly with plain objects in `tests/unit/filesAcl.test.ts`:
     - admin → always allowed.
     - `row === null` (no active row: never existed, predates the S2 writer, or already tombstoned)
       → **denied** for non-admins.
     - `row.ownerId === 'anonymous'` (the sentinel written when no identity claim was present at
       upload time) → **denied** even if the caller's own derived id also resolves to `'anonymous'`
       — that sentinel means "nobody attributable," never "this caller happens to also be
       anonymous."
     - otherwise → `row.ownerId === callerId`.
2. **list** (`GET /api/files`): rewritten to query the `files` DB table instead of
   `storage.listFiles` (the storage-provider disk-scan index has no owner attribution at all — a
   filesystem scan cannot know who uploaded a file — so it was structurally incapable of
   ACL-scoping; querying the DB row, which the ACL requirement needs anyway for info/download/delete,
   is the only source of truth available). Non-admin: `WHERE deleted_at IS NULL AND owner_id =
   $callerId`. Admin: `WHERE deleted_at IS NULL` (all owners). Response shape changed accordingly
   (DB-row-derived: `id/filename/size/contentType/url/ownerId/createdAt`, dropping the old
   `path`/`prefix` filter concept, which has no equivalent on a `files` row — see "no known
   consumers" below for why this is judged safe).
3. **info / download / delete**: owner-or-admin, else **404** (never 403 — a 403 would confirm the
   id exists to a caller not allowed to see it, which is exactly the enumeration this fix closes;
   404 is indistinguishable from a genuinely nonexistent id, including the storage-existence 404
   that already existed pre-F1).
4. **The no-DB-row case — an explicit ruling, not a silent default.** `files` had no INSERT writer
   at all before S2 (#4016) — every file uploaded before that slice, plus anything reaching storage
   through the (effectively unused) presign flow, has no `files` row and therefore no attributable
   `owner_id`. Two readings were possible: (a) no-row → admin-only (fail-closed, matching the
   anonymous-owner treatment), or (b) no-row → preserve pre-F1 behavior (any authenticated caller),
   scoping the ACL to only rows that actually carry a real owner. **Ruling: (a).** Determining
   factor: grepped the entire codebase (frontend `apps/web/src`, all backend routes, all plugins)
   for any caller of these four HTTP endpoints outside this file's own upload/delete usage inside
   the attendance test suite — **zero references found**. `GET /api/files`, `GET /api/files/:id`,
   `GET /api/files/:id/download`, and (until H2/F2) `DELETE /api/files/:id` have no in-repo
   consumer, so there is no backward-compatibility cost to the fail-closed reading, and it matches
   the owner's "at least lock down ACL" mandate more directly than a narrower carve-out would. If a
   real external consumer of these endpoints for legacy no-row objects surfaces later, that is a new,
   separate decision (a compat exception, or backfilling `owner_id` for those objects) — not
   assumed here.
5. **plugin G2's direct SQL read is unaffected by F1** — it already does its own owner_id comparison
   (`photoRow.owner_id !== userId` → `422`) inside the plugin's own query, never goes through these
   HTTP routes, and is a strictly stronger check than 404-vs-not (422 with a reason code, appropriate
   for a same-request server-side validation rather than a separate resource-access request).
6. **Named follow-up (explicitly OUT, not silently deferred)**: an approval-scoped read grant so an
   approver reviewing an outdoor-punch request can preview the submitter's photo evidence without
   being its owner or a platform admin. Today an approver who is neither gets **404** on
   info/download — this slice is deliberately fail-closed and does not attempt to guess at an
   approval-linkage grant; that is a distinct authorization decision for a future slice once there
   is a concrete approval-review-UI need for it.
7. **Test coverage** — `tests/integration/attendance-files-acl.test.ts` (real DB, real running
   server, real attendance plugin loaded), file-level fixture namespace (`NS = filacl-<ts>-<rand>`,
   per-test random suffixes) to avoid the shared-DB fixture-collision failure mode:
   - owner (non-admin) → 200 on info/download/delete of their own file.
   - cross-user (non-owner, non-admin) → 404 on info/download/delete, never 403; the file remains
     intact for the real owner afterward (the stranger's failed delete had no side effect).
   - admin (non-owner) → 200 on info/download/delete of another user's file.
   - list: non-admin sees only their own active files (containment-checked against the specific ids
     planted by the test, not an exact-count/exact-array assertion, since the integration gate runs
     many describeDb suites against one shared Postgres); admin's list is a superset containing every
     planted id across owners.
   - anonymous-owner legacy row (owner_id literally `'anonymous'`, backed by a real upload so the
     underlying storage object genuinely exists — otherwise even an ACL-allowed caller would 404 on
     the route's separate storage-existence check): a random non-admin → 404; a caller whose own
     derived id is *also* literally `'anonymous'` → still 404 (the sharp edge this rule exists for);
     admin → 200.
   - S2 punch regression: owner uploads a real PNG, owner punches with `photoFileId` → 202 pending —
     proves the new ACL gate does not interfere with the existing owner-upload + owner-punch flow
     (G2 never touches these HTTP routes, but this is exercised end-to-end rather than assumed).
   - `tests/unit/filesAcl.test.ts` — pure-function coverage of every `filesAclAllowsAccess` branch
     (admin bypass, no row, anonymous sentinel override, owner match, owner mismatch, defensive null
     ownerId) plus `getFilesRequestUserId` derivation order and the anonymous-sentinel fallback.

## OUT of scope (explicit)

- **Approval-scoped photo-evidence read grant** — named above (F1 item 6). Fail-closed until a
  concrete approval-review UI need exists; not guessed at here.
- **Blob compensating-delete for a failed `storage.delete` after a successful tombstone** — F2's
  `logger.warn` is the only signal today; no retry queue, no scheduled sweep. The row itself is
  already safe (tombstoned, invisible to every consumer) regardless of whether the underlying blob
  is ever actually removed from storage. A future slice could add a scheduled reconciliation job
  that lists `deleted_at IS NOT NULL` rows and retries `storage.delete`; not attempted here.
- **Upload (`POST /api/files/upload`) and presign (`POST /api/files/presign`) semantics are
  untouched** — this slice is delete-order (F2) and read/list/delete ACL (F1); upload's INSERT
  behavior, magic-byte sniffing (H2 P3-1), and the presign flow are unmodified. The only upload-route
  change is a mechanical refactor (`getFilesRequestUserId(req)` replacing the inline `??`-chain
  extraction it used already) with no behavior change.
- **No compat shim for the `list` response shape change** — see F1 item 2 and item 4's "no known
  consumers" finding. If this assumption is later found wrong, that is a new bug report, not a
  silent regression this slice is aware of and ignoring.
- **`disabled = byte-identical`** does not apply here — F1/F2 are unconditional security/integrity
  fixes explicitly authorized by the owner, not an opt-in feature; there is no env flag, and none was
  added.

## Test evidence (local, real DB)

- Fresh Postgres 16 (`docker run postgres:16-alpine`), `pnpm db:migrate` end-to-end clean, including
  the new `zzzz20260710130000_add_files_deleted_at` migration (`\d files` confirms `deleted_at
  timestamptz` present, correctly ordered after `zzzz20260710120000_create_files`).
- `tests/integration/attendance-outdoor-punch.test.ts` — **29/29 pass** (includes the H2 P3-2 test,
  rewritten to assert tombstone semantics: row persists with `deleted_at` set rather than being
  absent, plus a new download-404 assertion, plus the pre-existing delete-then-punch 422).
- `tests/integration/attendance-files-acl.test.ts` — **6/6 pass** (new file, F1 ACL matrix + S2
  punch regression).
- `tests/unit/filesAcl.test.ts` — **9/9 pass** (new file, pure predicate coverage).
- `tests/unit/files-delete-tombstone-order.test.ts` — **5/5 pass** (new file, F2 ordering coverage).
- Full `packages/core-backend` unit suite (`vitest run tests/unit`): **350 files / 4688 tests
  pass** (no regressions from the `files.ts` rewrite touching a widely-imported route file).
- `tsc --noEmit` (packages/core-backend): clean.
- No frontend changes — nothing added to `attendance-web-guard.yml` (matches H2's own "no FE
  surface" note; this slice is backend-only).

## Mutation self-check (4 cuts, each reverted after observing red)

1. **Tombstone-first order reverted** (storage.delete moved before the `UPDATE ... SET deleted_at`)
   in `files.ts`'s delete route → `tests/unit/files-delete-tombstone-order.test.ts`: cut (a) went red
   (500 expected became a false-500-for-wrong-reason path — storage now called first, unconditionally
   deletes, then the UPDATE fails, still 500 but storage WAS touched, failing the
   `storage.delete not called` assertion), cut (b) went red (200/ordering assertion failed — storage
   ran before the tombstone UPDATE), and the normal-path ordering assertion went red too (3/5 red).
2. **G2's `deleted_at IS NULL` filter removed** from `plugins/plugin-attendance/index.cjs`'s photo
   lookup query → `attendance-outdoor-punch.test.ts`'s tombstone test went red (delete-then-punch
   returned `202` instead of the expected `422 OUTDOOR_PHOTO_INVALID` — a tombstoned row read as
   valid evidence again).
3. **Download route's ACL gate removed** in `files.ts` → `attendance-files-acl.test.ts`'s cross-user
   test went red (`200` instead of `404` for a stranger downloading another user's file).
4. **List route's owner filter removed** (both branches collapsed to the admin query) in `files.ts`
   → `attendance-files-acl.test.ts`'s list-scoping test went red (a non-admin's list included another
   owner's file id).

All four cuts were applied to the working tree, observed red, then reverted precisely (verified via
`git diff` showing no residue) before moving to the next.
