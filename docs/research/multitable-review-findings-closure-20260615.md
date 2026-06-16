# Multitable — Review-Findings Closure: Per-Field Restore Oracle + Comment-Reaction CI

Date: 2026-06-15

> **STATUS UPDATE (post-merge reconciliation).** The per-field-restore oracle described
> in §1.1 was fixed by THIS session as PR **#2676** (uniform 403 strategy) — but a parallel
> session independently fixed the same oracle as PR **#2677** with a different, more complete
> strategy (hidden/unknown selected field → **200 no-op**, indistinguishable; + schema-drift
> scope + link-reorder no-op). **#2677 is canonical; #2676 was CLOSED.** §1.1 below documents
> #2676's (now-retired) approach and its adversarial verification — kept as the analysis record,
> not the landed fix. §1.3 (comment-reactions CI wiring, PR #2679) is independent and stands.
> The record-restore M1–M4 coverage tests were deferred to land on top of #2677 once it merges.
>
> **FINAL LANDING LEDGER (2026-06-16) — all merged to main:**
> - **#2677** `73fd154c4` — canonical per-field oracle fix (200-noop + schema-drift + link-reorder). MERGED.
> - **#2679** `cdab2cb2f` — comment-reactions keystone wired into CI + permission negatives. MERGED.
> - **#2685** `2b5e6ea3` — `mapRowToComment` read field-drop fix (5 read/emit surfaces) + `makeCommentRow` fixture top-up. MERGED.
> - **#2686** `788050554` — record-restore M1–M4 coverage (T22–T25, CI-executed via the real-DB step). MERGED.
> - **#2676** — this session's superseded oracle fix (uniform 403). CLOSED (replaced by #2677).
> - **#2693** `8f7ac052c` — trailing polish: swept remaining comment test helpers to carry canonical container/target ids (fully closes the fixture-vs-wire drift). MERGED.
> - Production bug surfaced + fixed in #2685: `mapRowToComment` dropped `containerId`/`targetId`/`targetFieldId` across five comment read/emit surfaces.

Scope: documents this session's closure work on confirmed findings from two review MDs against
merged multitable code (#2672 per-field restore, #2673 comment emoji reactions).

---

## 1. What was closed

### 1.1 #2672 follow-up — per-field-restore change-timeline oracle (security fix)

- PR: https://github.com/zensgit/metasheet2/pull/2676 (draft, base `main`)
- Branch: `fix/multitable-per-field-restore-oracle-20260615`
- Commit: `4bdc278c28012cc6c5751456b7d87552c5c077dc`
- Files:
  - `packages/core-backend/src/routes/univer-meta.ts`
  - `packages/core-backend/tests/integration/multitable-record-restore.test.ts`

What changed — the bug was live on merged #2672 (confirmed not already fixed on main). The route's per-field forbidden gate ran over `selectedDiff` (caller `fieldIds` ∩ changed fields), so a selection naming a `visible=false` / read-only field returned `403 RESTORE_FORBIDDEN` when that field changed at the target version, but `200` no-op when it had not changed. That status delta is an exact per-field oracle that recovers the modification timeline of a column whose revision history #2144's `redactRecordRevisionEntry` is designed to mask.

Fix (`univer-meta.ts` ~:5797–5828): the forbidden gate now runs over

```
const gatedFieldIds = fieldIds ?? selectedDiff.map(ch => ch.fieldId)
```

i.e. in per-field mode it checks the caller-SELECTED `fieldIds` independent of whether they changed, using the SAME predicate the route already applies (static guard `!hidden && !readOnly` ∧ layer-3 `perm.visible !== false && perm.readOnly !== true`). Any selected forbidden id ⇒ constant generic `403` regardless of diff ⇒ the two oracle cases become byte-identical ⇒ oracle closed; M2 (selection-not-a-bypass) holds. Full-restore mode (no `fieldIds`) falls back to `selectedDiff.map(...)` and is byte-for-byte unchanged (gate still over the changed diff). The 403 body stays a static literal; no forbidden id is echoed into `skippedFieldIds`.

Verification: `tsc` 0 errors; 29/29 record-restore integration tests green against local PG; T18 proven non-vacuous via a buggy-gate revert that reproduces the 403-vs-200 oracle signature.

Note: T18 was strengthened mid-task — switched from `FLD_SECRET` (read-only-but-visible, already unmasked in the history endpoint) to a dedicated `visible=false FLD_HIDDEN`, the column #2144 actually masks, so the test exercises the precise mask-defeating case the PR claims to fix.

### 1.2 Record-restore property suite (ships in PR #2676)

The third named closure — the record-restore M-series property tests — lands in the SAME PR as the oracle fix (#2676), in `multitable-record-restore.test.ts`. These exercise the per-field restore gate end-to-end against real PG:

- T15 / T16 / T17 — selection semantics: `fieldIds` restores ONLY the selected fields (unselected untouched); per-field lets you restore a writable picked field even when another diff field is forbidden; selecting an unchanged WRITABLE field is a clean no-op.
- T18 — oracle keystone: a NEW `visible=false` field `FLD_HIDDEN` + a `field_permissions` row (`visible=false, read_only=false`) for `USER_RO` — the exact column #2144 masks. Asserts IDENTICAL status + body whether the field changed or not, generic 403, id absent from body and `skippedFieldIds`, atomic.
- T19 (#2672 M2) — selection-not-a-bypass: write-denied selection ⇒ clean 403, atomic, id excluded, never a silent bypass.
- T20 — regression: writable per-field restore still works; full-restore atomic-reject (changed-forbidden) and pass-through (unchanged-forbidden) unchanged.

(The task's "M1–M4" shorthand maps to this record-restore property suite; the file labels only M2 explicitly at T19. Suite referenced generically rather than inventing per-test M-labels not present in the source.)

Verification: `tsc` 0 errors; 29/29 record-restore integration tests green against local PG; T18 non-vacuity proven via buggy-gate revert (403-vs-200 oracle signature).

### 1.3 #2673 — comment emoji-reaction keystone CI wiring

- PR: https://github.com/zensgit/metasheet2/pull/2679 (draft)
- Branch: `test/multitable-comment-reactions-ci-20260615`
- Commit: `13f84b129dfe2dc8d1875a35ecab7d65416f4b59`
- Files:
  - `packages/core-backend/tests/integration/comment-reactions.api.test.ts` (new)
  - `packages/core-backend/tests/integration/comments.api.test.ts`
  - `packages/core-backend/vitest.config.ts`
  - `.github/workflows/plugin-tests.yml`

What changed — closed the invisible-debt trap: the #2673 B6 emoji-reaction keystone ran in NO CI workflow (excluded from the default unit run at `vitest.config.ts:32`, absent from every integration allowlist).

1. CI wiring: extracted the keystone + permission negatives into a new self-contained `comment-reactions.api.test.ts` and wired it as a WHOLE FILE into a dedicated `Run comment-reaction keystone (real wire, real PG)` step in `plugin-tests.yml` (Node 20, real Postgres, every PR). Whole-file (not a `-t "reaction"` name filter) is deliberate: a name filter matching zero tests exits 0/green (silent no-op gate = reintroduced invisible debt), while a whole-file run exits 1 on missing/renamed file (`No test files found`) and on unreachable DB.
2. Fail-loud (#1435/#1436): `beforeAll` asserts `canListen` + `address.port` (no `if (!baseUrl) return` escape hatch). Same fail-loud + DDL applied to the still-excluded `comments.api.test.ts` harness.
3. DDL align: string id/timestamp columns now mirror real migration shapes (`text` + `timestamptz` for users / meta_bases / meta_sheets / meta_views / meta_comment_reads / meta_comment_reactions). `meta_comments` intentionally stays `varchar(50)` + plain `timestamp` because its earliest-ordered `formalize` migration wins the CREATE-IF-NOT-EXISTS race.
4. Negatives (real wire): userA's DELETE is self-scoped and cannot remove userB's reaction (DB-row survival + `reactedByMe:true` as B); a reader-only token (`roles=viewer&perms=comments:read`, no `comments:write`) is denied 403 on add AND remove; deleting the comment cascades away its reactions.

Verification: `tsc --noEmit` clean; `js-yaml` parses `plugin-tests.yml` (reaction step present, run command targets the whole new file); new file against fresh migrated PG = 2 passed (no skips, no name-filter coupling). Fail-loud verified 3 ways: bad `DATABASE_URL` ⇒ exit 1; missing/renamed file ⇒ exit 1; `-t` no-match anti-pattern ⇒ exit 0 (the fragility the dedicated-file approach avoids). No lint exposure (core-backend has no lint script; test files are eslint-ignored).

Verified deviation: rather than wire the whole `comments.api.test.ts` (RED — 8 pre-existing real-wire failures, baseline 8 failed | 3 passed on fresh DB, all from `CommentService.mapRowToComment` dropping `containerId` / `targetId` / `targetFieldId` for `getComment` AND `getComments`), the keystone + negatives moved into the dedicated file. The 8-test `mapRowToComment` field-drop is surfaced in the PR body as separate, tracked debt needing its own opt-in fix (production code, out of scope here).

---

## 2. Oracle fix — adversarial verification verdict

VERDICT: PASS. The per-field-restore change-timeline oracle is closed.

| Check | Result |
|---|---|
| `oracleClosed` | VERIFIED |
| `selectionBypassClosed` | VERIFIED |
| `fullRestorePreserved` | VERIFIED |
| `noSkippedLeak` | VERIFIED (structurally) |

- oracleClosed — `univer-meta.ts:5817` `gatedFieldIds = fieldIds ?? selectedDiff.map(...)`. The zod schema (`:5655`) is `z.array(z.string().min(1)).min(1).optional()`, so a present `fieldIds` is a non-empty truthy array ⇒ `gatedFieldIds === fieldIds` (the FULL caller selection, not selection∩changed). The gate (`:5818–5824`) fires on a selected forbidden field regardless of whether it changed. Both oracle cases hit the literal 403 at `:5829` BEFORE the no-op (`:5835`) / success (`:5861`) returns ⇒ identical status + identical static body. Every pre-gate return enumerated — VERSION_CONFLICT (`:5703`), VERSION_NOT_FOUND/EXPIRED (`:5727/:5730`), RESTORE_UNSUPPORTED (`:5734`), SNAPSHOT_UNAVAILABLE (`:5737`), SCHEMA_DRIFT (`:5762`) — none keys off the forbidden field's VALUE-change; all key off version existence / snapshot keys / field EXISTENCE, identical across both oracle cases. T18 (`~:611`) asserts `resDiff.body` deepEquals `resSame.body`, both 403, non-vacuous (was 403-vs-200 pre-fix).
- selectionBypassClosed — gate predicate (`:5821–5823`) returns forbidden when `!staticOk || !layer3Ok`. `fieldById` is built over ALL fields (`buildFieldMutationGuardMap`, `:3107–3128`) so the guard is defined for any real id; `fieldPermissions` is built over visible-property fields (`buildRecordPatchContext :3216–3223` → `deriveFieldPermissions`, `permission-derivation.ts:76–101`) which densely populates every visible field and drops property-hidden ones. Forbidden selected field (`visible=false` ⇒ perm absent OR `scope.visible=false` ⇒ `layer3Ok=false`; read-only ⇒ `!staticOk`/`!layer3Ok`) ⇒ 403. UNKNOWN id ⇒ guard undefined ⇒ `staticOk=false` ⇒ 403 (no silent no-op). The spine-level `ServiceFieldForbiddenError` catch (`:5866`) is defense-in-depth, reached only after the gate passes. T18/T19 confirm.
- fullRestorePreserved — with no `fieldIds`, `:5817` falls to `selectedDiff.map(...)` (= changed diff, since `selectedDiff===diff` at `:5800`), so the gate runs over the CHANGED diff exactly as before — atomic reject if a changed field is forbidden, unchanged-forbidden does not block. Diff-build (`:5766–5795`) and downstream apply (`:5846–5859`) untouched. T20(ii) confirms.
- noSkippedLeak — VERIFIED structurally. The 403 body (`:5829`) is a static literal `{ ok:false, error:{ code:'RESTORE_FORBIDDEN', message:'Not permitted to restore one or more fields in this revision' } }` with NO `data` object ⇒ no `skippedFieldIds` channel on the forbidden path. On success/no-op paths (`:5835`, `:5861`) `skippedFieldIds` is hardcoded `[]`. The forbidden id is never echoed. T18 asserts `JSON.stringify(body)` excludes `FLD_HIDDEN` and `body.data?.skippedFieldIds ?? []` excludes it.

Intentional, non-defect behavior change (fail-safe direction): selecting an UNKNOWN field id in per-field mode now returns 403 (gate sees undefined guard) whereas pre-fix #2672 it was a no-op (unknown ids never entered `selectedDiff`). Knowingly accepted — old T17 "unchanged/unknown → no-op" renamed to "unchanged WRITABLE → no-op", unknown-id case dropped. This STRENGTHENS closure: a hidden id is indistinguishable from a garbage id ⇒ no field-enumeration oracle. Regression premise holds — `deriveFieldPermissions` default-allows writable fields (`visible=true, readOnly=false` when no deny scope), so an unchanged writable selected field passes the gate and reaches the 200 no-op branch.

---

## 3. Residual / deferred (not addressed in these changes)

- LOW — pre-existing spine-forbidden message echo (out of scope). The spine-level catch at `univer-meta.ts:5866–5868` maps `ServiceFieldForbiddenError` to a 403 echoing `(err as Error).message`, which could in principle contain a field id. Reachable only AFTER the pre-gate passes (i.e. only on a gate/spine divergence, a defense-in-depth split) ⇒ cannot fire in the closed oracle scenario (a forbidden selection 403s generically at `:5829` first). No action required for this fix; flagged so it is not assumed clean by omission. Optional hardening (separate change): generalize the `:5867` spine-forbidden message to the same static string used at `:5829`, so even a gate/spine divergence cannot echo a derived field id.
- DEBT — `CommentService.mapRowToComment` field-drop (8 real-wire failures). `getComment` and `getComments` drop `containerId` / `targetId` / `targetFieldId`. Production code, out of scope; surfaced in PR #2679's body as separately tracked debt requiring its own opt-in fix. The keystone CI step is isolated in the dedicated file, so this debt cannot run red in the new gate.

---

## 4. Closure note

These two PRs close confirmed findings from the two review MDs on merged code — #2676 closes the per-field-restore change-timeline oracle (review of merged #2672), #2679 closes the un-gated emoji-reaction keystone (review of merged #2673). Both are additive (test + CI + a scoped route-gate change), non-colliding with main, and shipped as draft PRs pending opt-in merge.
