# Attendance v1 — Acceptance Closeout Status + Operator Runbook (2026-07-13)

> **Scope:** the *acceptance* closeout of the attendance v1 line (#189 strict prod gate + #3317
> AE-4 + the five-window staging smokes), distinct from the 2026-07-07 *code-dev* closeout
> (`attendance-closeout-verification-20260707.md`, #3841). This MD is the line-level status +
> turnkey operator runbook. It does **not** claim acceptance that has not happened — the "已验收"
> column is deliberately narrow.

## 0. TL;DR

- **#189 UI import-commit 60s timeout: FIXED and PROVEN green.** Root cause was a verify-script
  gap (the "确认覆盖导入" modal intercepting the commit), not deploy/auth/advanced-panel. Fixed in
  **PR #4238** (merged `491a6567c`); strict-gate **run 29265492036 on merged main = overall
  SUCCESS**, Gate 4 (Playwright Prod) green, run twice. See §2.
- **No autonomous code/design gap remains on this line.** Every remaining item is *execution*
  gated on the owner/ops: a high-risk unified-SHA deploy, running the five staging smokes with
  real credentials, a **manual** AE-3 modal browser probe that cannot be automated, backfilling
  stamps, and closing #3317 / #189 + tagging a release. The harnesses and per-smoke runbooks all
  already exist (§3). This document is the runbook to execute them.

## 0a. Errata (2026-07-14, owner review findings)

1. **[P2] #3317 was mis-closed by this document's own PR.** #4243's body contained the literal
   prose "close #3317 / close #189" inside its runbook sequence — GitHub parsed them as closing
   keywords and auto-closed #3317 one second after merge (17:31:17Z), while this very document
   states AE-4 / manual AE-3 / five smokes / residue=0 are NOT executed. #3317 has been
   **reopened** with a mis-trigger record; both PR bodies' keywords are defused. Lesson: the
   closing-keyword pattern fires anywhere in a body, prose included.
2. **[P2] The original 长期-OUT column was stale.** S2 requirePhoto (#4016), S3 annual-accrual
   scheduler (#4008), S4 WeCom channel (#4028), S6 bulk balance adjust (#4023) were ALL delivered
   2026-07-10 with verification MDs, and E4 真机 was completed & closed (#3843, 2026-07-09).
   The table below is corrected against the main tracker
   (`attendance-dingtalk-benchmark-target-and-tracker-20260601.md`); genuinely-out items are only
   S7 (owner-gated) and the non-WeCom notification channels.
3. **[P3] #189 closure timing.** #189 was auto-closed at 15:59:57Z (1s after #4238's merge, same
   keyword mis-trigger) — ~13 minutes BEFORE the proving strict-gate run 29265492036 started. The
   evidence subsequently landed green (both run-twice artifacts: all five gates PASS,
   owner-re-verified), so #189 stays closed on merit with a timing note on the issue.
4. **Framing correction (owner):** the remaining acceptance items are NOT "physically impossible"
   — the accurate statement is they require **owner authorization, credentials, and human
   observation**, and must not be executed autonomously off a background hook. With explicit owner
   authorization and a preserved login session, the deploy, the five smoke scripts, and the
   in-browser AE-3 evidence run can all be executed in-session; credentials and release
   permission remain with the owner.

## 1. Four-column ledger — CORRECTED 2026-07-14 (see §0a errata)

| 已交付 (code shipped to main) | 已验收 (independently verified) | 待验收 / vNext (pending owner-authorized acceptance) | 长期 OUT |
|---|---|---|---|
| #189 verify-flow override-modal fix (#4238); #4096 strict verifier gate; #4135 empty-worker guard; all five staging smoke harnesses + companion unit tests; AE-4/MP-6/HMR-5/RD/OT runbooks + design-locks; **S2 requirePhoto #4016 `0e118283b` · S3 annual-accrual scheduler #4008 `e837c508f` · S4 WeCom channel #4028 `fd242899c` · S6 bulk balance adjust #4023 `dbf23627a`** (each with its own verification MD, tracker §"能力补齐") | **#189 prod strict gate: 6/6 gates green on `491a6567c` (run 29265492036), Gate 4 ×2 — both run-twice artifacts owner-re-verified `playwrightProd: PASS`**; **E4 真机 done & closed (#3843, 2026-07-09; help page #3966)**; every smoke *harness* passes its own unit test in CI | **AE-4** result-edit staging smoke (`AE4_RESULT_EDIT_STAGING_SMOKE_PASS`) + **manual AE-3 modal browser evidence**; **RD-4/5**, **OT-bank v1-8**, **MP-6**, **HMR-5** staging smokes on one unified `DEPLOY_SHA` per the window bundle (`attendance-staging-window-bundle-20260702.md`); residue=0; strict-gate rerun on the release SHA; 关闭 issue-3317; release tag | S7 approver resolver (owner-gated on A1-live 手感); SMS / native push / email notification channels (tracker: 后续 channel,不进 C5 v1) |

## 2. #189 fix — verification evidence

- **PR:** #4238 — `fix(attendance): confirm override-import modal in prod/full verify flows` — merged
  squash `491a6567c` on `main`.
- **Root cause:** default `importMode` is `override`; `importModeRequiresConfirm('override')===true`,
  so `requestRunImport()` opens the "确认覆盖导入" modal instead of committing — the commit `POST` only
  fires after the ack checkbox + Confirm. The prod verify script clicked "Import" then waited 60s for a
  commit that never dispatched. Only Gate 4 drives the real UI commit (API-smoke uses direct API;
  desktop/mobile commit path gated off by `REQUIRE_IMPORT_JOB_RECOVERY=false`) → only Gate 4 failed.
- **Fix (verify tooling only, zero product runtime change):** `confirmImportOverrideModalIfPresent`
  in both `verify-attendance-production-flow.mjs` and `verify-attendance-full-flow.mjs` (no-op on the
  direct-commit path); contract test `scripts/ops/attendance-import-override-confirm-contract.test.mjs`
  (5/5) wired into the strict gate; guard comment on the sync-only `isImportCommitUrl` matcher.
- **Redeploy-independent:** the strict gate checks out the merged repo and runs the verify script
  against already-deployed prod — no prod redeploy was needed for the fix to take effect.
- **Proof:** strict-gate **run 29265492036** on `491a6567c` → **overall SUCCESS** (the prior 8
  consecutive runs failed on pre-fix `f67606971`). Gate 4 runs inside the "Run strict gates twice
  (remote)" step (success) + gate-summary contract/schema validations (success). The flow asserts a
  real commit response + `batchId` + ≥1 batch row, so PASS ⇒ the commit genuinely fired through the
  modal-confirm path (not a skip). Diagnosis detail: `attendance-189-prod-flow-import-override-modal-fix-20260713.md`.
- **Deferred (blocked only by a transient GitHub API rate limit):** attach the literal
  `playwrightProd: PASS` line from run 29265492036's `gate-summary.json` artifact once the limit resets.

## 3. Operator runbook — the five-window smoke sequence (owner/ops-gated)

**Precondition (Phase 2, high-risk, owner-confirm before triggering):** deploy exactly **one** unified
release SHA so all five smokes run against the same build. Record it as `DEPLOY_SHA`/`BASE_URL`. The
`#189` fix is verify-tooling only, so the unified SHA can be any current `main` tip that carries the
attendance feature set; do **not** add new attendance changes into the release once the sequence starts.

**Run serially, backfilling each PASS stamp before the next.** Commands (fill `BASE_URL`, tokens, and
per-smoke user IDs from the staging/prod admin; each harness fails closed if a required env is missing):

1. **AE-4** — anomaly result-edit API/DB chain + stamp:
   ```
   BASE_URL=<base> DATABASE_URL=<pg> DEPLOY_SHA=<sha> ADMIN_TOKEN=<tok> \
     node scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs
   ```
   Then the **manual AE-3 modal browser probe** (cannot be automated) per
   `attendance-ae4-anomaly-result-edit-staging-smoke-runbook-20260701.md` — the harness explicitly
   refuses to claim the AE-3 UI PASS. Both the harness `AE4_RESULT_EDIT_STAGING_SMOKE_PASS` **and**
   the manual AE-3 evidence are required before closing AE-4.
2. **RD-4/5** — report digest:
   ```
   ATTENDANCE_REPORT_DIGEST_ENABLED=true TOKEN=<tok> ADMIN_USER_ID=<id> MEMBER_USER_ID=<id> \
     INACTIVE_USER_ID=<id> node scripts/ops/staging-attendance-report-digest-rd45-smoke.mjs
   ```
3. **OT-bank v1-8** — overtime bank cases (`CASE` selects each of the 8):
   ```
   TOKEN=<tok> ADMIN_USER_ID=<id> DORMANT_USER_ID=<id> MUSTPAY_USER_ID=<id> CASE=<v1..v8> \
     node scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs
   ```
4. **MP-6** — makeup punch (runbook `attendance-makeup-punch-mp6-staging-smoke-runbook-20260703.md`):
   ```
   TOKEN=<tok> ADMIN_USER_ID=<id> SUBJECT_USER_ID=<id> \
     node scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs
   ```
5. **HMR-5** — manual missed-punch reminder (runbook
   `attendance-manual-missed-punch-reminder-hmr5-staging-runbook-20260626.md`):
   ```
   TOKEN=<tok> ADMIN_USER_ID=<id> OUTSIDE_USER_ID=<id> SCOPED_USER_ID=<id> WORKER_USER_ID=<id> \
     node scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs
   ```

Each harness has a companion `*.test.mjs` (unit test of the harness itself, already green in CI) — that
is **not** the smoke; the smoke is the live run above. Synthetic seed rows are `STAMP`-scoped and cleaned
up (LIKE-free) so residue stays 0.

**Backfill (single source of truth):** record each PASS stamp in the tracker
`attendance-dingtalk-benchmark-target-and-tracker-20260601.md` — one place, not scattered notes.

## 4. Close-out sequence (owner-ruled 2026-07-14)

1. ✅ Reopen #3317, correct this document's ledger, defuse both PR bodies' closing keywords (§0a).
2. Freeze one `DEPLOY_SHA` and deploy it (staging stack per the window bundle §2 — staging deploys
   are operator-run over SSH; CI's deploy job targets the prod-track stack only).
3. Serially run AE-4 → RD-4/5 → OT-bank v1-8 → MP-6 → HMR-5 per
   `attendance-staging-window-bundle-20260702.md` §4 (one smoke fully done — settings restored &
   verified — before the next starts; a failed restore blocks the window).
4. Complete the AE-3 modal manual evidence in the in-session browser (screenshots), backfill every
   PASS stamp into the tracker, confirm unified residue=0.
5. Rerun the strict gate on the same release SHA, update the final verification MD, 关闭
   issue-3317, and tag the release.

Convert this MD's "待验收" column to "已验收" only as each item actually passes.

## 5. Why these were not executed autonomously (framing per §0a.4)

- **Unified-SHA deploy** — touches live infra, owner-gated per the tracker ("触发前确认"). Not needed to
  prove #189 (that was redeploy-independent); needed only to give the five smokes one common build.
- **Running the five staging smokes** — need real staging/prod admin credentials + a deployed target.
- **Manual AE-3 modal browser evidence** — requires a real logged-in browser session and human-
  reviewable screenshots; executable in-session once the owner provides/preserves the login state.
- **Closing #189 / #3317 and tagging the release** — owner decisions; the tag rides on the smoke
  sequence. An automated Stop-hook prompt is not owner authorization to cross any of these gates.
