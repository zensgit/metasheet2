# Attendance benchmark line — RD-3 / MP / AE development & verification

**Date:** 2026-06-27 · **Author:** Claude (Fable, ultracode) · **Status:** ✅ RD-3 + MP + AE-1 all built, adversarially reviewed, and landed on main.

This documents the three remaining attendance developments the owner asked to complete — the report-digest producer (RD-3), the makeup-punch runtime (MP-2/MP-3), and the anomaly-result-edit route (AE-1) — plus the ratification decisions made along the way (for owner confirmation) and how each was verified.

---

## 0. Summary

| Feature | What it adds | Status | Validation |
|---|---|---|---|
| **RD-3** | Scheduler producer that writes per-subject report-digest rows to the C5 outbox (no direct send) | ✅ on main (#3313) | adversarial review (10/10 locks) + 12 real-DB tests in `test (20.x)` |
| **MP-2/MP-3** | Makeup-punch quota/window/type/reason/attachment enforcement + per-write snapshot + approval audit on the request write path | ✅ on main (#3314) | adversarial review (disabled=byte-identical holds, all locks PASS) + 14 real-DB tests |
| **AE-1** | Audited admin route to correct anomaly results + immutable audit table + idempotency + closed-cycle 409 guard | ✅ on main (#3316) | adversarial review (9/9 locks, no P1) + 9 real-DB tests in `test (20.x)` |

**Every runtime is default-OFF / gated.** RD-3 needs `ATTENDANCE_REPORT_DIGEST_ENABLED` + policy enabled; MP enforces only when `makeupPunchPolicy.enabled`; AE-1's edit policy defaults enabled but the route is admin-only and a no-op until used. None sends/mutates for an existing customer without explicit opt-in.

**Prerequisite ratifications landed first** (design-lock-first): RD §11 (#3275), MP §9 (#3276) + config (#3280), AE §9 + §3.5a (#3274).

---

## 1. RD-3 — report-digest scheduler producer (#3313)

**Scope.** Each scheduler tick, for every enabled+due cadence, compute the *completed* period (reuses landed `resolveAttendanceReportDigestPeriod`), iterate active org members, build the small payload (reuses `buildAttendanceReportDigestPayload`), resolve recipients, and `INSERT status='pending'` C5 outbox rows. The existing delivery worker stays the sole sender.

**Key design decision — source_key grain (§4-vs-§6 fix).** The design's §4 `source_key` template omitted the subject id, but §6's dedup grain is per-subject. Shipped as §4 literally, one manager of two employees would get only ONE digest (the 2nd dropped by `ON CONFLICT`). **Resolution:** inject `:subject:{subjectUserId}:` into the key — `attendance_report_digest:{org}:{cadence}:{periodKey}:subject:{subjectUserId}:{recipientRole}:{recipientUserId}:channel:{channel}`. Proven by the one-manager-two-subjects collision test.

**Locks (all PASS in adversarial review):** no-direct-send (INSERT pending only); idempotency (`ON CONFLICT (org_id, source_key) DO NOTHING` + advisory xact lock); channel stamped from policy (never raw input); self→`subject`, owner/sub_owner resolved by the producer (worker never fans out); fail-soft per role (missing manager skips that role, still writes self, counts the skip); disabled→zero rows (env ∧ policy ∧ cadence ∧ due); active-membership only; completed-period only.

**Verification.** Adversarial review confirmed the producer correct on every lock. The review *also* found 3 test expectations were wrong (managers are also active org members → also digest subjects); corrected to the reviewer's real-Postgres-measured values + a multi-group fixture restructure. `test (20.x)` ran the suite on real DB and merged green.

**Deferred (non-blocking, documented):** hourly read-amplification short-circuit (has a mid-period correctness trade-off, so not the naive version); env-gate-before-getSettings micro-purity; per-cadence error isolation; cosmetic double-cadence token in the key.

---

## 2. MP-2 / MP-3 — makeup-punch runtime enforcement (#3314)

**Scope.** Enforce the ratified `makeupPunchPolicy` (quota / window / type / future-date / reason / attachment) on create+edit of the 3 makeup request types, fail-close cross-user PUT, persist a per-write policy snapshot, and have final approval audit that snapshot.

**#1 lock — disabled = byte-identical (verified holds).** All enforcement gates behind `policy.enabled===true` AND a makeup request type. Non-makeup types add **zero** queries (the settings read itself is gated behind a request-type check). Cross-user block is enabled-gated; the approval-audit append is gated on snapshot *presence* (never live policy), so enabling the policy later can't retro-rewrite a pending row's audit. The `adjusted`-record approval write is byte-for-byte untouched. The keystone test asserts the negatives (no snapshot in metadata/event-meta, cross-user admin PUT still 200, adjusted record still written).

**Locks (all PASS):** quota counts the **subject** (`attendance_requests.user_id`, not the actor) in the workDate cycle window (calendar_month, short-month clamp), excludes self on update; check order future→window→type→reason→attachment→quota (future must precede window); type-gate fail-closed (static §4.4 table ∩ org allow-list ∩ **server-derived** facts via `deriveMakeupAnomalyFacts` — never client prefill; unclassifiable→422); snapshot recomputed fresh per write (proven by a discriminating tighten-then-edit test); approval reads the persisted snapshot only and grandfathers no-snapshot rows; enforcement inside the txn after the request lock. Six policy codes + `MAKEUP_PUNCH_CROSS_USER_FORBIDDEN`, all **422**.

**Verification.** Adversarial review: APPROVE-WITH-NITS, disabled=byte-identical genuinely holds, no P1. 14 real-DB tests; the build agent caught that the new file wasn't in `plugin-tests.yml`'s explicit list (a false-green risk) and registered it. Merged green.

**Owner-aware notes / deferred (tracked in #3315):** quota TOCTOU is ratified accepted-slack (per-`(org,user,workDate,requestType)` lock vs cycle-spanning count — bounded over-count of a soft quota); the no-record fact path (the primary "forgot to punch entirely" case) is code-correct but untested (non-deterministic without controlling the default rule); `missing_check_out`/`late_early` and severe/absence tier facts untested. All fail-closed-leaning, off-by-default.

---

## 3. AE-1 — anomaly-result-edit route (#3274 design + AE-1 #3316)

**Scope.** `POST /api/attendance/anomaly-result-edits` (`attendance:admin`): correct one confirmed anomaly record to an explainable status with a required reason + optional evidence, an immutable before/after audit row keyed by a client idempotencyKey, an edit window, and a fail-closed closed-payroll-cycle guard. AE-2 (notify) / AE-3 (UI) / AE-4 (staging) are separate later slices.

**The load-bearing design decision — §3.5a metric table (ratified, see §4).** The design said "apply a normalization table" but didn't specify it. Locked: anomaly metrics normalized per target status; `work_minutes` preserved by default (no fabricated hours; admin `overrideMetrics` wins per-field); meta tiers always recomputed via `computeAttendanceRecordUpsertValues` (never a naked status UPDATE); `absent→normal` keeps `work_minutes=0` unless the admin supplies `overrideMetrics.workMinutes`.

**Verification.** Adversarial review: **APPROVE-WITH-NITS**, all 9 ratified locks hold, **no P1**. (The reviewer self-retracted a first-pass P1 it had read off a stale working tree — the same 508-behind trap — then re-verified against `git show origin/branch`.) Confirmed: §3.5a applied exactly — **no naked status UPDATE** (routes through `computeAttendanceRecordUpsertValues`); `statusOverride` shadows `computeMetrics` so a no-punch `absent→normal` can't re-derive 'absent'; meta tiers recomputed. Idempotency (key required→400, `UNIQUE(org,key)` NOT NULL, same-payload→alreadyApplied, diff→409, 23505 backstop); closed-cycle 409 fail-closed (schema-error→503, not bypassable); editable-source guard; org boundary→404; evidence HTTPS-only; edit-window tz fail-closed; audit immutable (no FK cascade, written in the same txn). Migration auto-registers + runs before the suite in CI; 9 real-DB tests, CI-registered, fail-loud.

**Owner-decisions + follow-ups → issue #3317:** the `403 disabled` route gate (§9 didn't spec one — keep as a kill-switch, or make `enabled` a frontend hint?); `overrideMetrics` not in the idempotency fingerprint (narrow — the UI uses a fresh key per open); cross-org write defense relies on `attendance:admin` being org-scoped in RBAC; **[P2-a] corrected-fact durability** — a later recompute (re-import / auto-absence / approved-request) without `statusOverride` re-derives the original status from the preserved punches and silently clobbers the correction (spec-accepted; AE-1's closed-cycle freeze is the *first* such guard — a future slice should generalize it). Test gaps (503, 403, overrideMetrics-same-key, absent-tiers, edit-window-tz) also tracked there.

---

## 4. Ratification decisions (for owner confirmation)

All design decisions made during this work, transcribed into the committed design-locks for the record:

**RD §11 (#3275, ratified 2026-06-27):** period = previous-complete (daily=prev day, weekly=prev Mon–Sun, monthly=prev month); default all-off; default recipients self-only (owner/sub_owner opt-in, resolved by the producer); channels work_notification + email_smtp (email send worker/env-gated); UI = a config card by notification/delivery, no mass-send button. *(Config defaults were drifted from the doc's own prose — aligned to ratified values before landing.)*

**MP §9 (#3276, ratified 2026-06-27):** quota 3/cycle (1..99); window 30 calendar-days (0..180, 0=today-only); cycleStartDay 1..31 short-month-clamped; count pending+approved (rejected/cancelled release); normal-correction default-off; delegated/admin-submit OUT for v1 (+ cross-user-PUT fail-closed); workday-window deferred to MP-v2. #3280's config encoded these exactly.

**AE §9 + §3.5a (#3274, ratified 2026-06-27):** editWindowDays 180 (1..366); target vocab incl `adjusted`; evidence = attachmentId/text + HTTPS-only URL allowlist; closed/archived cycle always 409 fail-closed; notify default-on + skipped-reason audited; source-not-editable = 422; **§3.5a metric table = my proposed normalization (work_minutes preserved by default; `absent→normal` no auto-fill)** — flagged for your confirmation; say if you'd rather `absent→normal` auto-fill a scheduled workday.

---

## 5. Verification method

Each runtime followed the same pipeline: **detailed spec** (parallel design-readers produced a full build plan per feature) → **worktree build agent** (strong model, incremental commit+push) → **independent adversarial review agent** (lock-by-lock, write-path bug hunt, test-integrity check) → **fix** (corrections applied, re-verified) → **land via real-DB CI** (the landing loop gates on `test (20.x)`, the *required* check that runs the real-Postgres integration suite). The reviews caught real issues — RD-3's wrong test counts, MP's CI-registration gap — before landing. No runtime merged without its real-DB tests executing green.

---

## 6. Landing mechanics (contended main)

`main` requires up-to-date branches and `test (20.x)` (~8.5 min) is required, while parallel sessions (multitable/approval) merge every ~10 min — a BEHIND race. Solution: a bounded retry loop that rebases onto current main, polls **only the 5 required checks** (`gh pr checks --required`), and merges the instant they're green; stacked PRs use `git rebase --onto`. The RD config (#3281) and MP config (#3280) both append to the shared settings-block structures (`DEFAULT_SETTINGS`/`normalizeSettings`/`mergeSettings`/`settingsSchema`) + the integration test file, so #3280 needed a manual additive conflict resolution (keep both policy keys, reconstruct the two wire tests) — resolved and CI-verified.

---

## 7. Deferred / owner-decision items

- **RD-3 / MP / AE runtime env flags stay OFF** — RD-3's outbox path and any production enablement are separate owner go-aheads.
- **MP test gaps** → issue #3315 (no-record path, fact tiers).
- **AE-1 owner-decisions** (from the build, pending the review): the `403 disabled` gate (§9 didn't spec one — keep as gate, or make `enabled` a frontend hint?); `overrideMetrics` not in the idempotency fingerprint (same key + different overrideMetrics returns the first result); and the **consistency gap** — AE-1's closed-cycle freeze is the *first* such guard; punch/import/auto-absence paths still write into closed cycles (a future generalization slice).
- **AE-2 / AE-3 / AE-4** (notify / UI / staging), **MP-4/5/6** (UI / UX / staging), **RD-4 / RD-5** (UI / staging) — all separate later slices, each owner-gated.
