# Wave M-Feishu-1 Delivery — 2026-04-26

## Wave scope

First wave of multitable对标飞书 (Feishu Bitable parity), planned in
`docs/development/multitable-feishu-gap-analysis-20260426.md`. 3 of 4
originally proposed lanes shipped this wave; MF4 (`send_email` automation
action) deferred pending SMTP transport policy decision.

| Lane | PR | Merge commit | Tests | LoC |
|------|----|--------------|-------|-----|
| **MF1** | [#1178](https://github.com/zensgit/metasheet2/pull/1178) ✅ | `e5f8118f7` | 14/14 ✓ | +697/-13 |
| **MF2** | [#1179](https://github.com/zensgit/metasheet2/pull/1179) ✅ | `67b9a7191` | 51/51 ✓ | +802/-8 |
| **MF3** | [#1180](https://github.com/zensgit/metasheet2/pull/1180) ✅ | `2b765035e` | 64/64 ✓ | ~+1100 |

**ALL THREE MERGED 2026-04-26.** main is at `2b765035e`. Total **129
tests passing**, **~+2.6k LoC additive** across the wave. Open PR queue
**empty**.

All baselined from `origin/main = 25202478c`. Pre-merge rebases:
- #1178 — merged by user before automation reached it (out-of-band).
- #1179 — local rebase + force-push to `3aa6a8dd8` → CI green → squash-
  merge --admin.
- #1180 — local rebase + force-push to `0267b39e1` → CI green → squash-
  merge --admin.

MF1 backend follow-up (xlsx route layer) remains the only deferred work
from this wave — pending `xlsx` dep policy lift on `packages/core-
backend/package.json`.

## Lane details

### MF1 — Excel `.xlsx` import/export (frontend-only)

**Scope shipped:**
- `apps/web/src/multitable/import/xlsx-mapping.ts` — pure helpers (191
  LoC) for parse / build / column-mapping. Accepts `xlsx` module via DI
  so future backend lane can reuse verbatim.
- `MetaImportModal.vue` extended: `.xlsx` / `.xls` accept, parse branch,
  truncation warning slot.
- `MetaToolbar.vue`: 「Export XLSX」 button + `export-xlsx` event.
- `MultitableWorkbench.vue`: `onExportXlsx()` mirroring existing CSV path.

**Backend deferred:** `xlsx` is not a backend dep, and adding it was
explicitly blocked at the user-policy level (Edit on
`packages/core-backend/package.json` denied). Per the task spec STOP
clause, the `packages/core-backend/src/multitable/xlsx-service.ts` +
`POST/GET /api/multitable/sheets/:sheetId/{import,export}-xlsx` are
documented as a deferred follow-up.

**Compatibility:** the gap analysis (line 255) explicitly noted "后端无
改动（CSV 路径已通）" — the frontend parses `.xlsx` into the same import
payload shape the existing CSV backend already accepts. Round-trip works
without backend changes for files within browser memory.

**Resume path** (when dep policy lifts):
1. Add `xlsx` to backend `package.json`.
2. Wrap import via `loadXlsx()` mirror of existing `loadMulter()`.
3. Add routes that call `resolveSheetCapabilities` + `RecordService` for
   writes and `queryRecordsWithCursor` for reads.
4. The pure helper `xlsx-mapping.ts` requires no changes — already DI-
   friendly.

### MF2 — Field types batch 1 (6 types)

**Types added:** currency, percent, rating, url, email, phone — all
hardcoded in the canonical `MetaFieldType` union; `field-type-registry.ts`
left as dead code per the architectural decision documented in the dev
MD.

**Backend additions:**
- `field-codecs.ts` (+177): `URL_REGEX` / `EMAIL_REGEX` / `PHONE_REGEX`
  + per-type validators + coercers + `coerceBatch1Value` dispatcher.
- `record-service.ts` / `record-write-service.ts` /
  `routes/univer-meta.ts`: routing through dispatcher in create/patch
  validation paths.

**Frontend additions:**
- Type union extended (+6 variants) in `apps/web/src/multitable/types.ts`.
- `field-config.ts` / `field-display.ts` for options + formatting.
- `MetaCellRenderer` / `MetaCellEditor` / `MetaFormView` /
  `MetaFieldManager` integrate render + edit + admin config.

**Storage:** all 6 reuse existing JSON value column — **no migration
required**.

**One regex follow-up fix during recovery:** the agent's initial
`PHONE_REGEX = /^[+\d][\d\s\-().]{4,23}$/` rejected `(02) 1234 5678`
(Australian-style fixed line with leading paren). Relaxed to
`/^[+\d(][\d\s\-().]{4,23}$/`. All 51 tests pass after the fix.

### MF3 — Conditional formatting

**Backend additions:**
- New `multitable/conditional-formatting-service.ts` with pure
  `evaluateRule` + `evaluateConditionalFormattingRules` (first-match-wins
  per cell + applyToRow row-style composition).
- Per-view JSONB rules persisted alongside view config.
- GET / PATCH routes added in `routes/univer-meta.ts`. Cap of 20 rules
  per view.

**Frontend additions:**
- `ConditionalFormattingDialog.vue` — admin rule management
  (field/operator/value/style picker, drag-to-reorder via up/down).
- `MetaGridTable.vue` + `MetaViewManager.vue` evaluate rules per row on
  render and apply inline cell/row styles.
- `apps/web/src/multitable/utils/conditional-formatting.ts` — frontend
  twin of the backend pure evaluator (so cell rendering can compute
  styles client-side without round-trip).

**Operators:** number ranges (gt/lt/between), text (contains/eq/empty),
select (eq/contains), date (is_today/in_last_n_days/is_overdue), boolean
(is_true/is_false). 39 backend + 25 frontend tests cover all branches.

## Cross-lane file overlap (additive-only, merge-clean verified)

The 3 lanes are **not strictly file-disjoint** — a correction to the
earlier "fully disjoint" claim. Three shared files have additive-only
touches at non-overlapping sections:

| File | Touched by | Nature |
|------|-----------|--------|
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | MF1 + MF3 | MF1 adds `export-xlsx` event handler; MF3 adds conditional-formatting trigger entry. Different code paths. |
| `apps/web/src/multitable/types.ts` | MF2 + MF3 | MF2 extends `MetaFieldType` enum (+6 variants); MF3 adds `ConditionalFormattingRule` type definitions. Different sections of the file. |
| `packages/core-backend/src/routes/univer-meta.ts` | MF2 + MF3 | MF2 adds field-type validation path in field-create/update; MF3 adds GET/PATCH `/conditional-formatting-rules` routes. Different route handlers. |

**Verified merge-clean** via temp-worktree simulation against `MF2 → MF1
→ MF3` order — git auto-merge succeeds with zero conflicts on all three
shared files. The "additive on different lines" pattern is what allows
parallel ship without the lanes blocking each other.

**MF1-owned**: `apps/web/src/multitable/import/`, `MetaImportModal.vue`,
`MetaToolbar.vue`.

**MF2-owned**: field-codecs / record-service / record-write-service /
field-type cell components / field-config + field-display utils.

**MF3-owned**: `MetaGridTable.vue`, `MetaViewManager.vue`,
`ConditionalFormattingDialog.vue`, conditional-formatting service +
frontend evaluator twin.

## Rate-limit recovery story

MF2 and MF3 agents both hit the Anthropic usage limit ("resets 8:40am
Asia/Shanghai") mid-flight. Recovery executed in foreground (not new
agents) since the agents had already done 80-90% of the work:

1. Both worktrees had **substantial WIP** but **zero commits** (HEAD ==
   origin/main).
2. Foreground re-ran typecheck + targeted tests:
   - MF2: backend tsc clean, vue-tsc clean, 50/51 tests passing initially
     (1 phone-regex test failed; relaxed regex; 51/51 after fix).
   - MF3: all green first try (39 backend + 25 frontend = 64/64).
3. For MF2, agent had not yet written dev/verify MDs — written manually
   based on diff inspection. MF3's MDs were already drafted by the agent
   (in the untracked working tree).
4. All 3 lanes committed locally. None pushed.

## What this closes (and what's still open)

**Closes (from gap analysis P0/P1):**
- ✅ Excel xlsx import/export (frontend; backend deferred)
- ✅ Currency, percent, rating, url, email, phone field types
- ✅ Conditional formatting rules

**Still open in P0/P1 (future waves):**
- Field type batch 2: auto-number, created-time, modified-time,
  multi-select-advanced (~5 人天)
- Formula editor + Chinese function docs (4 人天)
- `send_email` automation (deferred, blocked on SMTP transport policy)
- Person field native type migration (product call)

## Roadmap-stage compliance

✅ no new战线 (multitable existing capability domain)
✅ no `plugins/plugin-integration-core/*` touched
✅ no platform-化 work
✅ pure 内核打磨 on a shipped product domain

The K3 PoC path is untouched. Customer GATE waiting status unchanged.

## Final merge sequence (executed)

The wave was merged in `MF1 → MF2 → MF3` chronological order (MF1 was
merged out-of-band by the user before automation reached it; remaining
two merged sequentially per plan). Each subsequent rebase used
`git rebase origin/main` (no `--onto` surgery needed — these branches
are not stacked, just baselined on the same wave-baseline).

For #1180 (MF3), rebasing onto `MF1+MF2`-merged main produced **zero
conflicts**, validating the user's earlier "additive-only,
merge-clean" simulation: even though MF3 shares 3 files with the merged
predecessors (`MultitableWorkbench.vue`, `types.ts`, `univer-meta.ts`),
the additions are at non-overlapping positions and git's auto-merge
handles them cleanly.

## Beyond this wave (deferred follow-ups)

- **MF1 backend route layer** — `POST/GET /api/multitable/sheets/:sheetId/{import,export}-xlsx`
  using the pre-prepared `xlsx-mapping.ts` helper. Blocked on backend
  `xlsx` dep policy lift.
- **MF4 (`send_email` automation action)** — pending SMTP / email
  transport decision (no SMTP transport in repo today; `nodemailer` /
  managed-sender dep policy needed).
- **Field-type batch 2** — auto-number / created-time / modified-time /
  multi-select advanced (~5 人天 per gap analysis).
- **Formula editor + Chinese function docs** — 4 人天 (engine works,
  editor missing).
- **Person field native type migration** — product call (currently
  "link to hidden People sheet" pattern).

## Files in this delivery

- `docs/development/wave-m-feishu-1-delivery-20260426.md` (this file)
- Lane MF1 worktree: `apps/web/.../xlsx-mapping.ts` + dev/verify MDs +
  `MetaImportModal.vue` + `MetaToolbar.vue` + `MultitableWorkbench.vue`
  changes.
- Lane MF2 worktree: 11 modified files + 1 new test + 2 dev/verify MDs.
- Lane MF3 worktree: 5 modified + 7 new files (component, service, util,
  tests, dev/verify MDs).
