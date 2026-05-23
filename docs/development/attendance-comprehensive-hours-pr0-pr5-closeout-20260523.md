# Attendance comprehensive-hours PR0-PR5 closeout - 2026-05-23

## Purpose

Records the closure of the comprehensive working-hours control (综合工时制) RFC
chain from the original PR0 specification through PR5 strong-control's
production runtime PASS. Establishes PR6 (reporting / multitable snapshot) as
an **explicit deferred slice** that does NOT advance without a new opt-in.

This document is the chain-of-evidence index. Each numbered PR cell links to
the canonical design / verification / smoke artifact for that slice.

## Lineage table

| Slice | PR | Merge SHA | Date (UTC) | Type | Status | Canonical artifact |
| --- | --- | --- | --- | --- | --- | --- |
| PR0 | — (in-tree) | `attendance-comprehensive-hours-control-rfc-20260522.md` | 2026-05-22 | RFC | merged | `docs/development/attendance-comprehensive-hours-control-rfc-20260522.md` |
| PR1 helpers | [#1770](https://github.com/zensgit/metasheet2/pull/1770) | — | 2026-05-22 | runtime | merged | core helpers `resolveAttendanceComprehensiveHoursMetric` / `Enforcement` (defensive defaults — internal callers only) |
| PR2 preview route | [#1774](https://github.com/zensgit/metasheet2/pull/1774) | — | 2026-05-22 | runtime | merged | `POST /api/attendance/comprehensive-hours/preview` (admin-only, read-only) |
| PR2.5 invalid-enum reject | [#1776](https://github.com/zensgit/metasheet2/pull/1776) | `9516f5222` | 2026-05-23 | runtime hardening | merged | strict normalizers `normalizeAttendanceComprehensiveHoursMetricInput` / `EnforcementInput` — route-level reject with `INVALID_METRIC` / `INVALID_ENFORCEMENT`; helpers retain defensive defaults |
| PR3 admin preview UI | [#1777](https://github.com/zensgit/metasheet2/pull/1777) | `29d01e65f` | 2026-05-23 | runtime | merged | `attendance-admin-comprehensive-hours-preview` section: admin-only read-only preview consumer of the PR2 route |
| PR4 design lock | [#1778](https://github.com/zensgit/metasheet2/pull/1778) | `4939cf9b8` | 2026-05-22 | docs-only | merged | `attendance-comprehensive-hours-control-pr4-warning-design-20260522.md` — 8 Hard Boundaries + 6 test requirements for PR4 runtime |
| PR4 runtime weak-control | [#1790](https://github.com/zensgit/metasheet2/pull/1790) | `39258df83` | 2026-05-23 | runtime | merged | `attendance-comprehensive-hours-control-pr4-warning-development-20260523.md` + `attendance-comprehensive-hours-control-pr4-warning-verification-20260523.md` — shift+rotation save-time advisory (3 vitest) |
| PR4 production runtime smoke | (smoke) | n/a | 2026-05-23 | docs | local artifact preserved | `attendance-comprehensive-hours-pr4-warning-runtime-smoke-verification-20260523.md` |
| PR4 staging E2E | [#1795](https://github.com/zensgit/metasheet2/pull/1795) | `6eae5b2d8` | 2026-05-23 | docs-only | merged | `attendance-comprehensive-hours-pr4-warning-staging-e2e-verification-20260523.md` — staging fixture + real save-chain trace |
| **PR5 runtime strong-control** | [#1796](https://github.com/zensgit/metasheet2/pull/1796) | `014fa5078` | 2026-05-23 | runtime | **merged + production PASS** | `attendance-comprehensive-hours-pr5-strong-control-design-20260523.md` + `attendance-comprehensive-hours-pr5-strong-control-verification-20260523.md` — `comprehensiveHoursSaveBlockMode` toggle + 7 vitest |
| **PR5 production runtime closeout** | (this doc) | n/a | 2026-05-23 | docs | local | this file |
| PR6 reporting / multitable snapshot | — | — | — | — | **DEFERRED** | requires new explicit opt-in |

## What "the chain" delivers (functional summary)

The end-to-end behavior delivered by PR0 through PR5, observable on
production at the time of writing:

1. An **admin-only read-only preview route**
   `POST /api/attendance/comprehensive-hours/preview` (PR2) accepts a
   `policyDraft` + `scope` + `period` + `metric` + `enforcement` body, returns
   `aggregate.status ∈ {ok, warning, violation}` plus per-user `rows`. Strict
   input validation rejects unknown enums with `INVALID_METRIC` /
   `INVALID_ENFORCEMENT` (PR2.5). The route never writes — `readOnly: true` is
   asserted in the response.
2. An **admin read-only preview UI** (PR3) consumes that route and surfaces
   the aggregate and per-row breakdown in `Admin Center →
   Comprehensive hours`. Status text reads `Read-only preview refreshed. No
   policy was saved.`
3. A **weak-control save-time advisory** (PR4) runs the same preview route
   immediately before every shift and rotation assignment save with a narrow
   single-user payload (`metric: planned`, `enforcement: warn`,
   `scope: { userId }`, `period.type: custom_range`, no `allUsers`). The
   advisory displays a `warn`-kind message on `warning` / `violation` /
   `degraded`, an `error`-kind message on preview HTTP/parse failure, and the
   original save endpoint is **always** called regardless.
4. An **opt-in strong-control save guard** (PR5) adds a single new ref
   `comprehensiveHoursSaveBlockMode` (default `false`) wired to a checkbox in
   the admin preview section. When enabled, the preview payload's
   `enforcement` becomes `block`, and a preview return of
   `aggregate.status === 'violation'` (excluding `degraded: true`) causes the
   save handler to early-return without calling the save endpoint. The UI
   shows a `block`-kind advisory that explicitly tells the admin how to
   override (toggle the checkbox off). Preview errors and degraded data
   **never** block save in either mode.

PR4 weak behavior is preserved byte-for-byte when the PR5 toggle is `false`
(its default). The deployed bundle proves the regression discipline holds.

## PR5 production runtime PASS — evidence

### Bundle

| Item | Value |
| --- | --- |
| Production URL | `http://23.254.236.11:8081/attendance` |
| Frontend image (post-rerun) | `ghcr.io/zensgit/metasheet2-web:014fa50783cd0805486b28104efae95bd04daecc` |
| Backend image (post-rerun) | `ghcr.io/zensgit/metasheet2-backend:014fa50783cd0805486b28104efae95bd04daecc` |
| Bundle asset served | `/assets/index-CWe-UNpc.js` (1,360,915 bytes) |
| Bundle pulled time | 2026-05-23T16:42:04Z (web) / 16:42:35Z (backend) |

Note: the bundle content hash `CWe-UNpc` is identical to the hash served by
the previous successful build at `cd06f15749` because PR #1797 (which
intervened between PR #1796 and PR #1798) touched only `packages/core-backend`
and made no frontend changes. The frontend bundle is therefore byte-for-byte
identical between `:014fa5078` and `:cd06f15749`.

### PR5 fingerprints — all required strings present

| Fingerprint | Count | Required |
| --- | ---: | --- |
| `Save-time strong control` (EN toggle label) | 1 | ≥1 ✓ |
| `strong-control: save blocked` (EN block-state advisory) | 1 | ≥1 ✓ |
| `attendance-comprehensive-hours-save-block-mode` (toggle id + data attr) | 2 | ≥1 ✓ |
| `保存时强管控` (ZH toggle label) | 1 | bonus ✓ |
| `综合工时强管控` (ZH block-state advisory) | 1 | bonus ✓ |

### PR4 fingerprints — all preserved (regression discipline)

| Fingerprint | Count | Required |
| --- | ---: | --- |
| `Saving is still allowed in this stage` (EN weak-mode advisory) | 1 | ≥1 ✓ |
| `data-attendance-comprehensive-hours-assignment-advisory` (selector) | 2 | ≥1 ✓ |
| `当前阶段仍允许保存` (ZH weak-mode advisory) | 1 | bonus ✓ |
| `Comprehensive-hours advisory` (preview-error prefix) | 1 | bonus ✓ |
| `comprehensive-hours/preview` (route URL) | 1 | bonus ✓ |

### Banned-language scan — all zero (no PR5 contract drift)

| Pattern | Count | Required |
| --- | ---: | --- |
| `Comprehensive-hours.*cannot save` | 0 | 0 ✓ |
| `Comprehensive-hours.*policy enforced` | 0 | 0 ✓ |
| `Comprehensive-hours.*violation prevented` | 0 | 0 ✓ |
| `综合工时.*禁止保存` | 0 | 0 ✓ |

The single word `blocked` appears only in the legitimate block-state advisory
string `strong-control: save blocked because planned minutes exceed the cap.
Disable strong-control to override.` Designed copy from `pr5-strong-control-design-20260523.md` §"UX copy" allows this exact phrasing.

## GHCR transient-flake diagnosis (closes 014fa5078 build failure)

### What happened

PR #1796 merged to `main` at SHA `014fa50783...` at 2026-05-23T14:26:03Z.
The `Build and Push Docker Images` workflow (run
[26335197148](https://github.com/zensgit/metasheet2/actions/runs/26335197148))
triggered and **failed** at the backend manifest write step:

```
14:27:08-29  c904.../e379.../e6359.../6db58.../f598... layers all "Pushed" successfully (12 of 13)
14:27:30     unauthorized: unauthenticated: User cannot be authenticated with the token provided.
##[error]Process completed with exit code 1.
```

The frontend `Build and push frontend` step was then skipped because the
backend step in the same job had failed; the `deploy` job was also skipped.

### Why this is a transient flake, not a systemic permission problem

The same workflow, same secrets, same `GITHUB_TOKEN` / `packages:write` scope,
same `actions/checkout@v4`, same runner image succeeded:

- 2026-05-23T16:19:46Z on `cd06f15749` (PR #1797 merge) — both backend AND
  frontend pushed cleanly.
- 2026-05-23T~16:40Z on the **rerun** of run 26335197148 itself — both backend
  AND frontend pushed cleanly, deploy ran cleanly.
- All other `main` builds today (39258df83 / 6e1216767 / dc24a793d /
  2c0fc78c4 / 6eae5b2d8 / 675afd560).

The signature — 12 of 13 layers pushed in successive seconds, then the
**manifest write** at second 22 returning `unauthenticated` — matches the
canonical GHCR token-refresh race that occasionally affects long-running
backend image pushes. No GitHub Actions / package settings change was
required. A single `gh run rerun ... --failed` was sufficient.

### Resolution sequence

| Time (UTC) | Event |
| --- | --- |
| 14:26:03 | PR #1796 merged at 014fa5078 |
| 14:26:06 | Build run 26335197148 starts |
| 14:27:30 | Backend manifest write fails; build job marked failure, deploy skipped |
| 16:19:46 | PR #1797 merge triggers Build run 26337633362 at `cd06f15749`; succeeds (PR #1796's frontend code carried forward by ancestry) and deploy pulls cd06f15749 images to production — production already running PR5 frontend at this point |
| ~16:40 | `gh run rerun 26335197148 --failed` issued by Claude under explicit user instruction; both backend and frontend pushed cleanly; deploy job ran and pulled `:014fa50783...` images to production |

The 014fa5078 build is now reattainable: both
`ghcr.io/zensgit/metasheet2-backend:014fa5078...` and
`ghcr.io/zensgit/metasheet2-web:014fa5078...` exist in GHCR.

## PR6 — explicitly deferred

PR6 covers **reporting and multitable snapshot** for comprehensive-hours
results. The scope sketched in the PR5 design doc (§"Deferred to PR6 or later")
is:

- Per-org / per-tenant default for the strong-control toggle.
- Persistence of the toggle across sessions (DB-backed or settings-row-backed).
- Time-bound or role-bound auto-enforcement (e.g., HR-director auto-on).
- Block-state escalation hook (require approval to override).
- Strong-control on bulk / multi-user save flows.
- Block-state metrics / audit trail.
- Multitable snapshot of preview results for downstream reporting analysis.

**PR6 is NOT a queued or in-flight slice.** It is deferred indefinitely
pending an explicit user opt-in. The PR5 toggle delivers the minimum viable
strong-control surface; reporting and persistence are a separate load-bearing
problem.

### What "deferred" means operationally

The following actions are **prohibited until the user explicitly opens PR6**:

- No new ref / settings-row / DB migration adding persisted enforcement modes.
- No `attendance_report_*` snapshot writer for comprehensive-hours preview
  output.
- No multitable record sync of comprehensive-hours results.
- No bulk-save preview API.
- No backend route that returns historical preview classifications.
- No PR-6-shaped design lock MD authored as an autonomous next step.

Per memory `[[staged-optin-lineage]]`, each next link in the chain is a
separate explicit opt-in. PR6's surface (reports + multitable snapshot) is
materially larger than any of PR1-PR5 individually and must not be auto-started.

## Local-state housekeeping (this turn)

| Action | Status |
| --- | --- |
| Closeout MD written | this file |
| `.worktrees/multitable-issue-1780-closure-20260523/` worktree | scheduled for removal — branch merged via #1798 |
| Local branch `runtime/multitable-issue-1780-closure-20260523` | scheduled for removal — merged into `main` at `2d50cc51d` |
| Local branch `frontend/attendance-comprehensive-hours-pr5-strong-control-20260523` | scheduled for removal — merged into `main` at `014fa5078` |
| Pre-existing main-worktree dingtalk dirty docs (8 files under `docs/development/dingtalk-*`) | **untouched** — not in this lane |
| Pre-existing main-worktree `.tmp-*.mjs` scratch files (12 files) | **untouched** — not in this lane |

The cleanup is recorded here for traceability but executed in a separate
operation; this MD is the docs-only artifact.

## References

- RFC: `docs/development/attendance-comprehensive-hours-control-rfc-20260522.md`
- PR1 helpers: [#1770](https://github.com/zensgit/metasheet2/pull/1770)
- PR2 route: [#1774](https://github.com/zensgit/metasheet2/pull/1774)
- PR2.5 reject: [#1776](https://github.com/zensgit/metasheet2/pull/1776)
- PR3 admin UI: [#1777](https://github.com/zensgit/metasheet2/pull/1777)
- PR4 design lock: [#1778](https://github.com/zensgit/metasheet2/pull/1778)
- PR4 runtime: [#1790](https://github.com/zensgit/metasheet2/pull/1790)
- PR4 staging E2E: [#1795](https://github.com/zensgit/metasheet2/pull/1795)
- PR5 runtime: [#1796](https://github.com/zensgit/metasheet2/pull/1796)
- Memory: `[[k3-poc-stage1-lock-no-new-fronts]]` (this chain sat in the kernel-polish lane).
- Memory: `[[staged-optin-lineage]]` (PR6 opt-in discipline).
- Memory: `[[staging-8082-jwt-and-deploy-lane]]` (staging E2E preflight that unblocked PR4 #1795).
- Memory: `[[skip-when-unreachable]]` (anti-fake test discipline observed across PR4/PR5 specs).
- Memory: `[[review-enum-validation-strictness]]` (origin of PR2.5).
- Memory: `[[review-auto-md]]` (review pattern used across this chain).
- Memory: `[[pr-review-fetch-before-grep]]` (review discipline that caught all PR-HEAD-vs-local-checkout drift).
- Memory: `[[parallel-session-worktree-hazard]]` (worktree hygiene; relevant to housekeeping above).
