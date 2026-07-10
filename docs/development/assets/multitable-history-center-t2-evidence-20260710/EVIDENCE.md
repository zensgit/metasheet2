# R10-C evidence — Global History Center browser screenshots (T2 acceptance debt)

Date: 2026-07-10 · Lane: evidence (no lane PR — final archival landed via **#4064** `5d8b96487`) · Repo: zensgit/metasheet2 @ origin/main `9dba447fb`
Debt item: `docs/development/multitable-time-machine-plus-todo-20260619.md:102` — T2 tests: "browser Path A screenshot for dense timeline layout" (never captured), plus §3 rule (line 314): "Browser evidence is required for the global history center timeline before calling the UI slice complete."
Captured after R9 landed record titles + typed link/person diffs + click-through, so the evidence also covers those.

## Files (all in /tmp/lane-evidence-out/)

| File | What it proves (vs T2/T3 checklist) |
|---|---|
| `00-workbench-grid.png` | Baseline: workbench at `/multitable/:sheetId/:viewId?baseId=…` with the seeded "Launch Tasks" sheet — 7 rows, person chips (Alice Chen / Bob Wu / Carol Li), link chips with names (Realtime Sync, Audit Log, …). Confirms the grid's link/person summary caches are populated before History is opened (precondition for name rendering in diffs). |
| `01-history-center-dense-timeline.png` | **The T2 debt shot.** History Center modal over the workbench with a DENSE timeline: ~22 visible batch rows (Delete / Create / Update), per-batch record·field counts, actor display name "Alice Chen" (not raw id), source label "Manual" (rest), timestamps, full filter bar (search / actor / source / action / date range / field / all-tables) — 27 batches in the active-sheet scope, 33 in the base. |
| `02-history-batch-expanded-link-diff.png` | **Record TITLE + typed link diff.** Field filter = "Related Feature"; expanded batch reads: `Update — Write launch spec — 1 field(s)`, diff row `Related Feature: ~~Realtime Sync~~ → Realtime Sync, Audit Log`. Record chip shows the record's title (T2 "no raw record ids when a visible title exists") and the link diff renders linked-record NAMES, not id JSON. |
| `03-record-chip-clickthrough-drawer.png` | **Click-through.** Clicking the `Write launch spec` chip (`[data-test="hist-rec-label"]`) closed the modal and opened the Record Detail drawer for that record (URL gains `#recordId=rec_655e505a-…`), showing Task Name / Owner / Related Feature "Realtime Sync, Audit Log" / Status Done. |
| `04-history-batch-expanded-person-diff.png` | Bonus: typed PERSON diff. Field filter = "Owner"; expanded batch `Update — Update user docs`, diff `Owner: ~~e0546c94-…~~ → Carol Li`. After-side renders the person NAME. **Observed nuance (honest):** the before-side fell back to the raw user id even though Bob Wu is still assigned elsewhere in the loaded grid — person-summary cache hit resolves names per side only on full coverage; a miss shows the id. Same family of fallback exists for links (an unlinked before-side rendered as "1 linked record" count in another batch). Not a blocker for T2 (the link diff in `02` renders names on both sides); worth a look if per-side person hydration should widen. |

Also in this dir: `seed.mjs` + `seed-continue.mjs` (API seeding), `capture.mjs`/`capture2.mjs`/`capture3.mjs` (Playwright), `seed-output.txt` (ids), `.token` (expired dev JWT).

## Steps to reproduce

1. Worktree: `git -C ~/Downloads/Github/metasheet2 worktree add /tmp/lane-evidence origin/main && cd /tmp/lane-evidence && pnpm install` (node 20.20.2).
2. Throwaway PG: `docker run -d --name lane-evidence-pg -p 5544:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=metasheet_evidence postgres:16-alpine`.
3. Migrate: `MIGRATION_EXCLUDE=<exact list from plugin-tests.yml "Run DB migrations" step> DATABASE_URL=postgresql://postgres:postgres@localhost:5544/metasheet_evidence pnpm --filter @metasheet/core-backend db:migrate` — all migrations green.
4. Backend: `DATABASE_URL=… PORT=8900 NODE_ENV=development JWT_SECRET=<any> RBAC_TOKEN_TRUST=true pnpm --filter @metasheet/core-backend dev:core`. (`RBAC_TOKEN_TRUST` is required because a registered user's DB role `user` otherwise overrides the dev-token's `admin` claim → 403 on `POST /api/multitable/bases`. Dev-only flag, ignored in production.)
5. Web: `apps/web/.env.local` with `VITE_API_URL=http://127.0.0.1:8900`, then `pnpm --filter @metasheet/web dev` (port 8899).
6. Auth/seed: register 3 users via `POST /api/auth/register`; grant them `multitable:read/write` in `user_permissions` (register only grants spreadsheet/attendance perms, and person-field write validation requires assignees to be sheet-member-eligible = holding a multitable perm); mint `GET /api/auth/dev-token?userId=<alice-uuid>&roles=admin`; run `seed.mjs` then `seed-continue.mjs` → base "Product Launch Hub", sheets "Features" (5 records) + "Launch Tasks" (9 records), fields string/person/link/string/string, 33 REST mutations (creates, status/title updates, 5 link-field diffs incl. add/swap/set/clear/re-set, 3 person diffs, 2 deletes) → 33 `meta_record_revisions` batches.
   - Person fields default `limitSingleRecord=true` (multi-user assignment 400s) — seed uses single-user values.
7. Capture: headless Chromium (repo's playwright 1.57.0), set `localStorage.auth_token`/`jwt` to the dev token on the origin, open `/multitable/<taskSheetId>/<viewId>?baseId=<baseId>`, wait for grid rows (populates link/person summaries), click `[data-action="open-history"]`, screenshot; select `[data-test="hist-filter-field"]` → apply → expand `[data-test="hist-batch"]` rows → screenshot; click `[data-test="hist-rec-label"]` → screenshot.
   - Note: Playwright's own `page.screenshot()` hung indefinitely on this page ("waiting for element to be stable" / post-fonts stall — the grid keeps a continuous rAF/layout loop); screenshots were taken via raw CDP `Page.captureScreenshot`, which is instant. Relevant for any future browser-verify CI lane on this view.

## Cleanup performed

Backend + vite dev servers stopped, `lane-evidence-pg` container removed, `/tmp/lane-evidence` worktree removed (evidence PNGs live in `/tmp/lane-evidence-out/`, outside the worktree).
