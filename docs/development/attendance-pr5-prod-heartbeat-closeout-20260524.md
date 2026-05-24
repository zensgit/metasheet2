# PR5 Production Heartbeat Closeout — 2026-05-24

**Status:** closed. The 24 h observation window concluded **PASS** — 4
iterations, no post-iter-2 ALERT, no fingerprint regression, no bundle
rollback. This document records the observation evidence, the live
read-only probes that companion-verify the PR5 + #1804 runbook surfaces,
the explicit not-done list for the heartbeat window, the candidate
next-round items (none executing without a separate opt-in), and the
lessons / unverified findings surfaced during the window.

This is the canonical closeout for the comprehensive-hours + advanced
scheduling chain's production-runtime observation window opened against
PR #1796 (PR5 strong-control runtime) and PR #1804 (advanced-scheduling
workbench operator runbook).

---

## 1. PR5 production bundle observation window

**Target:** `http://23.254.236.11:8081/attendance` (production frontend).

**Monitor task:** `b4oaxwetb` (Monitor tool, `persistent: true`, self-terminating after 24 h wall-clock).

**Window:** 2026-05-23T17:24Z → 2026-05-24T17:24Z (24 h, 6 h interval, 4 iterations).

### Iteration results

| Iteration | Timestamp (UTC) | Bundle asset | PR5 fingerprints | PR4 fingerprints | Disposition |
| --- | --- | --- | --- | --- | --- |
| iter=1 | 2026-05-23T17:24:00Z | `/assets/index-CWe-UNpc.js` | `1/1/2` (toggle label / block state / selector) | `1/2` (weak advisory / selector) | **OK — baseline** |
| iter=2 | 2026-05-23T23:24:44Z | n/a (HTML extraction failed) | n/a | n/a | **ALERT triaged → transient probe-side flake** (HTML or asset-tag extraction timed out; live re-probe at 02:48Z showed bundle still serving correctly with full fingerprints; iter=3 confirmed forward) |
| iter=3 | 2026-05-24T05:24:49Z | `/assets/index-DX_EUprZ.js` | `1/1/2` | `1/2` | **OK — bundle hash changed (forward deploy), fingerprints intact** |
| iter=4 | 2026-05-24T11:25:30Z | `/assets/index-DX_EUprZ.js` | `1/1/2` | `1/2` | **OK — same forward-deploy bundle as iter=3, fingerprints intact** |
| HEARTBEAT_DONE | 2026-05-24T17:24:01Z | n/a (terminator line) | n/a | n/a | **PASS — 24 h elapsed, iterations=4, initial_bundle=`/assets/index-CWe-UNpc.js`; no new ALERT after iter=2's transient probe-side flake** |

### Bundle hash change explanation — `CWe-UNpc` → `DX_EUprZ` is FORWARD, not rollback

The asset hash flipped between iter=1 (Wed 17:24Z) and iter=3 (Thu 05:24Z) because two non-frontend-runtime PRs were merged in between:

| Time (UTC, approx) | Event |
| --- | --- |
| 2026-05-23 ~17:24 | iter=1 — bundle `CWe-UNpc` (built from main at SHA `6c4bf1f82` lineage at that moment) |
| 2026-05-24 ~04:09 | `#1804` merged: `docs(attendance): add advanced-scheduling workbench operator runbook` (docs-only, no frontend code touched) |
| 2026-05-24 ~ (window) | `#1802` and `#1791` merged: `docs(attendance): add advanced scheduling benchmark matrix` and `fix(attendance): adapt strict smoke to current overview` (docs + ops smoke scripts; no frontend runtime code) |
| 2026-05-24 ~05:24 | iter=3 — bundle `DX_EUprZ` (built from current main after those merges) |

Because Vite content-hashes the asset filename precisely, a build re-runs of even an unchanged frontend source tree can yield a new hash if the build environment timestamps or compaction order differ slightly. More importantly: independent maintainer re-check at the moment of bundle swap also confirmed all PR5 + PR4 fingerprints non-zero on `DX_EUprZ`. The fingerprint persistence is the load-bearing check; the asset hash is informational.

### Per-fingerprint persistence

| Fingerprint | Required ≥ | Iter=1 | Iter=3 | Iter=4 | DONE |
| --- | ---: | ---: | ---: | --- | --- |
| `Save-time strong control` (PR5 EN toggle label) | 1 | 1 | 1 | 1 | ✓ PASS |
| `strong-control: save blocked` (PR5 EN block-state advisory) | 1 | 1 | 1 | 1 | ✓ PASS |
| `attendance-comprehensive-hours-save-block-mode` (PR5 selector + id) | 1 | 2 | 2 | 2 | ✓ PASS |
| `Saving is still allowed in this stage` (PR4 EN weak advisory) | 1 | 1 | 1 | 1 | ✓ PASS |
| `data-attendance-comprehensive-hours-assignment-advisory` (PR4 selector) | 1 | 2 | 2 | 2 | ✓ PASS |

Zero regressions across the three completed `OK` iterations (iter=1, iter=3, iter=4).

---

## 2. Live read-only advanced-scheduling workbench probe — PASS

Run separately at 2026-05-24T09:27:19Z, as a companion to #1804 runbook. Evidence at `/tmp/attendance-advanced-scheduling-workbench-live-probe-20260524.md`.

| Case | HTTP | Result |
| --- | --- | --- |
| Positive 1 — empty range (full snapshot) | 200 / 0.65 s | `readOnly=true`, `source=attendance_advanced_scheduling_workbench`, all counters 0, `truncation.assignmentLimit=500`, `truncated=false`, no diagnostics |
| Positive 2 — bounded range `2026-05-01..2026-05-31` | 200 / 1.62 s | Range echoed back identically; same baseline; same truncation defaults |
| Negative 1 — malformed `from=not-a-date` | 400 / 1.81 s | `VALIDATION_ERROR / Invalid "from" date. Use YYYY-MM-DD.` |
| Negative 2 — inverted range | 400 / 1.29 s | `VALIDATION_ERROR / "from" must be on or before "to".` |
| Negative 3 — unauthenticated | 401 / 0.81 s | `UNAUTHORIZED / Missing Bearer token` |

All 5 cases match the runbook §1 + §6 contract verbatim. The tenant has zero scheduling data, so diagnostic-emission paths could not be live-exercised; those remain locked by the unit test `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts:94-98`.

---

## 2.5. Live login-form end-to-end test — PASS

Driven at ~2026-05-24T04:58Z (UTC) via headless Playwright. Single careful attempt — no retry — credentials in a 0600 `/tmp/.ms2-login-creds.env` file, deleted after the run. Password never printed, never written to any persistent file other than the 0600 temp file, never captured in any screenshot (pre-fill screenshot only captures the blank login form; post-redirect screenshot is on `/attendance` where the password field no longer exists).

Account used: `main-admin-admin@example.com` (production).

| Step | Result | Evidence |
| --- | --- | --- |
| 1. Auth guard — `/attendance` without token | **PASS** | Redirected to `/login?redirect=/attendance` |
| 2. Login form renders | **PASS** | `<input type="text" placeholder="Email, mobile, or username">` + `<input type="password">` + `<button class="login-submit" type="submit">Sign in</button>` |
| 3. POST `/api/auth/login` | **PASS** | HTTP 200, response url `/api/auth/login` |
| 4. Redirect after submit | **PASS** | URL flipped `/login?redirect=/attendance` → `/attendance` |
| 5. Token + features persisted to storage | **PASS** | `auth_token` (324 chars), `jwt`, `metasheet_features`, `user_permissions`, `metasheet_product_mode = platform` all populated; token value never read into the chat |
| 6. `/api/auth/me` confirms admin | **PASS** (see "Step 5 false negative" note in §3.5 below) | `status=200`, `success=true`, `role=admin`, `email=main-admin-admin@example.com`, `features.attendanceAdmin=true`, `features.mode=platform`, 5 explicit permissions |
| 7. Admin gating activates | **PASS** | `Admin Center` button visible; both `#attendance-admin-comprehensive-hours-preview` and `#attendance-admin-advanced-scheduling-workbench` sections exist in DOM |

Combined with the earlier JWT-injected UI-acceptance run, the auth surface is now verified along **both** authentication paths:

| Path | Method | Verified at | Outcome |
| --- | --- | --- | --- |
| JWT-injected (preInit `localStorage`) | Inject token; SPA accepts it on first load | 11:25Z — UI acceptance run | PASS for all 4 acceptance points (toggle / default off / strong-control copy / workbench read-only) |
| Real login form (no token preInit) | Fill `/login` form → POST `/api/auth/login` → redirected to `/attendance` | 04:58Z — login-form end-to-end run | PASS for steps 1-7 above |

The JWT path proves "given a valid admin token, the UI renders correctly". The login-form path proves "the actual sign-in chain produces a valid admin token and lands the admin in the correct place". Together they cover both halves of the auth surface.

Logout: see §3.6 unverified-finding note.

---

## 3. Items explicitly NOT done in this observation window

The closeout reaffirms the boundary discipline that has held across the entire comprehensive-hours + advanced-scheduling chain:

- ❌ **PR6 (reporting / multitable snapshot)** — remains deferred per the prohibited-actions list in `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md`. No design lock authored, no settings-row, no migration, no snapshot writer.
- ❌ **Scheduling write paths** — no grid edit, no Excel import, no temporary shift, no dispatch, no shift swap. All locked under the K3 PoC stage-1 lock.
- ❌ **LIMIT 500 truncation handling** — the `ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT = 500` cap is documented in the runbook §2.5 + §3 of `pr0-pr5-closeout-20260523.md`, but no code change has been made to surface a stronger truncation warning, aggregate-rewrite, or page-through. Eligible as a future kernel-polish slice; not in this window.
- ❌ **Fixture writes on production or staging** — neither environment had attendance scheduling fixtures created to exercise the diagnostic-emission paths live; that would be a production state change and was explicitly out of scope.
- ❌ **Frontend or backend runtime code changes** — entire window is observation + ops-script + docs-only; no `apps/web/`, `packages/core-backend/`, `plugins/`, or `migrations/` touched.
- ❌ **Logout investigation / fix** — see §3.6 below; deferred until after HEARTBEAT_DONE, separate from the heartbeat window.

### 3.5. Lesson recorded — step 5 admin assertion was over-strict

The `/tmp/ms2-ui-login-form-test-20260524.mjs` script's step 5 check required `permissions.includes('attendance:admin')` as a literal token in the permission array. For the `main-admin-admin@example.com` account, this returned `false` — but the user IS effectively an attendance admin because:

| Signal | Value | What grants admin |
| --- | --- | --- |
| `data.user.role` | `'admin'` | Top-level role |
| `data.features.attendanceAdmin` | `true` | Feature-flag derivation from role + tenant settings |
| `data.user.permissions[]` | 5 entries (no literal `'attendance:admin'`) | Explicit permission list; on this account, `attendance:admin` is implied by role/feature, not enumerated |

Step 6 directly proved the gating activates: both admin-only sections rendered.

**Recorded for any future reuse of the /tmp login script** (NOT being changed now — script is in /tmp only, not in repo): the admin assertion should be a disjunction such as

```js
const isAttendanceAdmin =
  meResp.role === 'admin' ||
  (Array.isArray(meResp.permissions) && meResp.permissions.includes('attendance:admin')) ||
  meResp.attendanceAdmin === true
```

so that any of the three signal channels is sufficient. Not blocking; not patched in this window.

### 3.6. Unverified finding — logout did NOT clear the browser session

The login-form script's step 7 found and clicked a button matching `button:has-text("Sign out")`, but after the click:

- URL stayed at `/attendance?tab=admin` (did not redirect to `/login`)
- `localStorage.auth_token` and `localStorage.jwt` both still present

Possible explanations (none investigated this turn):

1. The matched "Sign out" element was inside an inactive submenu / collapsed user-menu that needed to be opened first; the click fired on a hidden element with no handler bound
2. The SPA exposes logout under a different affordance label or a multi-step flow (e.g., confirm dialog) the script didn't traverse
3. There is a real logout regression in the SPA

**Disposition:** unverified. NOT a blocker for the heartbeat window. NOT fixed in this window. Per maintainer direction:

- No logout work during the heartbeat window
- After HEARTBEAT_DONE, if a follow-up is desired, do a **logout-only Playwright reproduction** that:
  - Discovers the real logout affordance (snapshot the user-menu / dropdown structure first)
  - Verifies whether the bug is "wrong selector in the script" or "real logout bug in the SPA"
  - Touches no other feature surface

---

## 4. Next-round optional items — RANKED, NOT EXECUTING

These are candidate kernel-polish slices to consider **after** HEARTBEAT_DONE. Each is read-only or docs-only. None will start without an explicit user opt-in per `[[staged-opt-in-lineage]]`.

### Ranking criteria

- Smaller scope > larger scope
- Pre-prepared evidence > greenfield
- Diagnostic / audit > new user-facing surface
- Closer to existing kernel-polish lane > new front

### Candidates (ranked low-risk → high-risk)

| Rank | Option | Description | Scope | Risk | Notes |
| --- | --- | --- | --- | --- | --- |
| **1** | **C. Live read-only workbench evidence into repo (docs-only)** | Promote `/tmp/attendance-advanced-scheduling-workbench-live-probe-20260524.md` to a `docs/development/...` MD via a small docs-only PR. Pairs the operator runbook (#1804) with a live evidence record. | 1 new MD; no code | Lowest | Companion to merged #1804; evidence already prepared; identical hygiene pattern to #1795. |
| **2** | **A. Scheduling operation log read-only filtering** | Add a read-only filter / search affordance to the existing scheduling operation log (if one exists at the admin surface). Pure diagnostic enhancement, no writes. Needs a code-archaeology pass first to confirm the existing log surface and filter wiring. | Frontend filter UI + maybe small typed predicate; no backend | Low-medium | Sits in kernel-polish lane; requires confirming existing log surface before scoping. |
| **3** | **B. Rotation calendar preview / audit read-only preview** | Add a read-only preview that renders the rotation rule's resolved day-by-day calendar for an audit purpose. New surface but read-only and downstream of existing resolver code. | New Vue section + read API consumption; possibly new GET route | Medium | Larger than A; needs design lock MD first (similar to #1778 / pr5 design MD pattern). Could surface unintended write affordances if not bounded. |
| **4** | **D. PR6 reporting / multitable snapshot** | The deferred slice originally sketched in the comprehensive-hours closeout doc. | New persistence, new snapshot writer, multitable record sync | **High — must remain deferred** | Listed for completeness only. Crosses into write paths and persistence; not eligible for autonomous start. |
| **(addendum)** | **E. Logout-only Playwright reproduction** | Single-purpose investigation: discover the real logout affordance (open user-menu dropdown / inspect structure), determine whether §3.6's "session not cleared" is a script selector miss or a real logout regression. **Read-only probing of the UI only — no fix, no code change in this step.** | New /tmp investigation script + evidence MD; no repo change | Very low | Standalone, scoped to "diagnose only". If diagnosis yields "real bug", any fix is a separate code-change opt-in, not part of this slice. Listed at the bottom to make explicit that it is NOT being elevated above C / A / B. |

### Recommendation (not action)

If maintainer wants to land one more small win before fully closing the attendance lane, **C is the cleanest**: evidence already exists in `/tmp/`, identical hygiene pattern to PR #1795, no code or runtime change, no risk to the heartbeat window. **A is the next-smallest read-only enhancement** if a code touch is acceptable. **B is materially larger** and would benefit from a design-lock MD first. **D stays deferred.**

The closeout PR itself (this draft promoted to repo) is the obvious "one more small win" alongside C — both are docs-only and could be combined or kept separate as you prefer.

---

## 5. Decision tree at HEARTBEAT_DONE

```
HEARTBEAT_DONE (~17:24Z)
├── all iterations OK (incl. iter=4)
│   └── promote this draft to docs/development/... with iter=4 + DONE slots filled
│       └── open small docs-only PR (similar shape to #1801, #1795)
│           └── stop and await maintainer review
│
└── ANY iteration after iter=2 reports ALERT (bundle path missing / fingerprint=0 / fetch fail)
    └── classify alert: probe-side flake (continue) vs production regression (escalate)
        ├── if probe flake → log + keep window open until 24h ends
        └── if production regression → STOP all forward planning; surface to maintainer immediately;
            this draft does NOT get promoted; closeout work pauses until the regression is resolved
            and a fresh observation window opens
```

---

## 6. Final-state line — recorded at HEARTBEAT_DONE

```
[2026-05-24T17:24:01Z] HEARTBEAT_DONE 24h elapsed iterations=4 initial_bundle=/assets/index-CWe-UNpc.js — review ALERT lines above for any regression; absence of ALERT = PASS
```

**Disposition:** **PASS.** Observation window completed cleanly with 4 iterations over 24 h. The single ALERT (iter=2) was a transient probe-side flake that was independently verified non-regressive at 02:48Z (live re-probe showed bundle + fingerprints intact) and corroborated by the subsequent two OK iterations on the new bundle hash `DX_EUprZ`. No post-iter-2 ALERT, no fingerprint regression, no rollback. PR5 strong-control runtime is live and stable on `http://23.254.236.11:8081/attendance`.

---

## 7. Cross-references

- `[[k3-poc-stage1-lock-no-new-fronts]]` — chain stays in kernel-polish lane; no new fronts
- `[[staged-opt-in-lineage]]` — each next link is an explicit user opt-in
- `[[review-auto-md]]` — review pattern used across this chain
- `[[staging-8082-jwt-and-deploy-lane]]` — staging E2E preflight discipline
- `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` — establishes PR6 deferred posture (merged via #1801)
- `docs/operations/attendance-advanced-scheduling-workbench-runbook.md` — companion runbook (merged via #1804)
- `/tmp/attendance-advanced-scheduling-workbench-live-probe-20260524.md` — live probe evidence
- Monitor task ID: `b4oaxwetb` — currently running, two events remaining
