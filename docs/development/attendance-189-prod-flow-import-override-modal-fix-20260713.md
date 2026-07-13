# #189 Strict-Gate Gate-4 (Playwright Prod) timeout — diagnosis + fix (2026-07-13)

> **Status: fix landed in verify tooling; Gate-4 root cause = a verify-script gap, NOT a deploy/auth issue.**
> Fixes the 8-consecutive strict-gate failures where Gate 4 (Playwright Prod) timed out 60s at the import commit.

## 1. Symptom
`#189` strict gate: **Gate 4 (Playwright Prod) = FAIL**, all others (API smoke, provisioning, desktop, mobile) PASS.
Exact error (`gate-playwright-production-flow.log`): `page.waitForResponse: Timeout 60000ms exceeded while waiting for
event "response"` at `clickImportAndWaitForCommitResponse (verify-attendance-production-flow.mjs:329)`. Flow log:
`17 Preview import / 18 Preview API ok: items=1 / 19 Commit import / 20 Failed: waitForResponse timeout`.

## 2. Hypotheses ruled out (with evidence)
- **NOT auth.** The stale CI-secret token failed, but the workflow's deploy-host fallback minted a fresh valid
  token (AUTH_SOURCE=token, HTTP 200); the SAME token/API_BASE was reused by all gates and 4/5 downstream gates
  (incl. admin-only) PASSED with it → token conclusively valid.
- **NOT stale/unhealthy deploy.** Prod runs `f0ce863ea` (#4218), only **1 commit behind main**, 41 ahead of #4096;
  deploy pipeline healthy (7/8 recent deploys success, host 35.8 GB free / 52%). Same import flow, same target.
- **NOT the old advanced-panel bug** (#4096 fixed that; the script already expands the panel — screenshot
  `04-import-preview.png` shows the Import button rendered, enabled, clickable).
- **NOT an env/target difference.** `attendance-strict-gates-prod.yml` has no local build; Gates 4/5/6 all hit the
  same deployed target. The asymmetry is a **script coverage difference** (below).

## 3. Root cause
The app added a **"确认覆盖导入" (Confirm override import) modal** as a safety guard (AttendanceView §2/§4
design-lock). `requestRunImport()` (`AttendanceView.vue:19585`) does **not** commit directly when the import mode
requires confirmation — it opens the modal (`[data-import-override-confirm]`); the commit POST fires only after the
acknowledgement checkbox is checked and **确认** (`[data-import-override-confirm-submit]`, disabled until checked) is
clicked (`importOverrideConfirm.onConfirm → runImport()`).

The prod-flow verify script clicks "Import" and immediately `waitForResponse` for `/api/attendance/import/commit`
(or legacy `/api/attendance/import`) — but the modal intercepts, **no POST ever fires**, so it hits the full 60s
timeout. Only **Gate 4** exercises the live UI commit: the API smoke commits via direct API (no modal, `elapsedMs=83`),
and desktop/mobile don't drive the real commit (their commit-click path is gated off by `REQUIRE_IMPORT_JOB_RECOVERY=false`).
→ The backend is fine; the verify script never learned to confirm the modal.

## 4. Fix (verify tooling only — no product runtime change)
- `scripts/verify-attendance-production-flow.mjs`: new `confirmImportOverrideModalIfPresent(page)` — after clicking
  "Import", if `[data-import-override-confirm]` becomes visible, check the ack checkbox and click confirm-submit,
  THEN await the commit response (armed before the click, so it catches the POST whenever it fires). No-op when no
  modal appears (non-override direct-commit path).
- `scripts/verify-attendance-full-flow.mjs`: same helper on the override recovery path (`assertImportJobRecoveryFlow`,
  `mode:'override'`) — gated off by default but future-proofed for when `REQUIRE_IMPORT_JOB_RECOVERY=true`.
- **Contract test** `scripts/ops/attendance-import-override-confirm-contract.test.mjs`: cross-checks the app renders
  the modal hooks AND both scripts target them in the right order — so the fix can't silently drift from the app.
- Wired into the strict-gate contract case (`attendance-run-gate-contract-case.sh`, strict) alongside #4096's.

## 5. Verification
- `node --check` on all three files: OK.
- Contract test: **5/5 pass** (app renders modal + ack checkbox + confirm-submit; both scripts define the helper with
  the app's exact selectors; production-flow confirms the modal *between* the Import click and the response await;
  full-flow confirms after the import click).
- **Next real proof**: a fresh `#189` strict-gate run against current prod should flip **Gate 4 → PASS** (the commit
  POST now dispatches after the modal is confirmed). That rerun is the acceptance evidence.

## 6. Where this sits in the attendance closeout
This unblocks closeout step 2 ("fix #189, get prod/desktop/mobile/API green"). Remaining (sequenced, some owner/ops-gated):
pick a release SHA → five-window smokes (AE-4 incl. **manual AE-3 modal**, RD-4/5, OT-bank v1-8, MP-6, HMR-5) on the
same SHA → backfill stamps + residue=0 + close #3317 → close #189 + final four-column closeout MD + release tag.
