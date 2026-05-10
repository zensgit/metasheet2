# DingTalk Final Closeout — Status Correction (2026-05-09)

- Date: 2026-05-09 (UTC)
- Author: Claude (Opus 4.7, 1M context), interactive harness; reviewed by operator
- Corrects: matrix item #3 wording in
  `docs/development/dingtalk-final-closeout-verification-20260508.md`
  and the over-broad "main CI green" line in
  `docs/development/dingtalk-final-closeout-post-merge-deploy-20260509.md`
- Current `origin/main` HEAD: `818b9a7e30399a353593938284d9c9d34657a0e8`
- Redaction policy: this document contains no real DingTalk webhook,
  robot `SEC...`, admin JWT, bearer token, app secret, Agent ID value,
  recipient user id, temporary password, or `.env` content. Workflow
  failure text is quoted only at the redaction-safe level the workflow
  itself emits.

## Why this correction exists

The post-merge deploy snapshot stated matrix item #3 as
"`main` CI green for the deployed SHA (Build / Deploy / Phase 5 / Obs E2E /
monitoring-alert all success)". That is true for the **deploy-gate**
workflows but is **not** a complete statement of CI health on the
deployed SHA: a scheduled monitor workflow has been failing continuously,
and the closeout package must not present "all green" without that
caveat.

## Corrected matrix item #3

> **Item #3 — `main` CI for the deployed SHA**
>
> - **PASS for deploy gates**: `Build and Push Docker Images`,
>   `Deploy to Production`, `Phase 5 Production Flags Guard`,
>   `monitoring-alert`, `Plugin System Tests`, `Observability E2E` —
>   all `success` on `818b9a7e30399a353593938284d9c9d34657a0e8`.
> - **FAIL on scheduled `DingTalk OAuth Stability Recording (Lite)`**:
>   the scheduled monitor run on this SHA (`run 25616359070` and the
>   runs before it) ends in `failure`. The failure is **not** an
>   application-health failure — the stability check itself reports
>   `Health: status=ok`. The failing path is the Alertmanager
>   self-heal step:
>   - `Alertmanager webhook is not configured`
>   - `No supported GitHub webhook secret was available for Alertmanager self-heal`
> - **Nature: non-regression / pre-existing ops config gap.** The same
>   workflow has been failing since at least `2026-05-08` on SHA
>   `08c60362…` — i.e. before PR #1443 merged. It is not introduced by
>   the DingTalk closeout work, the failure-alert path, or the
>   must-merge backlog.
> - **Impact:** does not block `B` (live acceptance). For a CLOSED
>   declaration it must either be fixed (Alertmanager webhook + GitHub
>   webhook secret configured) or be carried in the final verification
>   doc as an explicit **non-blocking ops follow-up**, not silently
>   dropped.

## Evidence — scheduled monitor failure timeline

`DingTalk OAuth Stability Recording (Lite)`, scheduled event, recent runs
(time descending, all `failure`):

| When (UTC) | SHA | Note |
| --- | --- | --- |
| 2026-05-10 01:15 | `818b9a7e` | post-A current `main` (run 25616359070) |
| 2026-05-09 22:28 | `818b9a7e` | |
| 2026-05-09 20:29 | `818b9a7e` | |
| 2026-05-09 18:35 | `818b9a7e` | |
| 2026-05-09 16:33 | `818b9a7e` | |
| 2026-05-09 14:35 | `33a406d5` | after #1248 |
| 2026-05-09 12:36 | `33a406d5` | |
| 2026-05-09 10:34 | `33a406d5` | |
| 2026-05-09 08:49 | `1e35b2ad` | #1450 |
| 2026-05-09 06:59 | `1e35b2ad` | |
| 2026-05-09 05:24 | `1e35b2ad` | |
| 2026-05-09 03:24 | `c74c15a2` | |
| 2026-05-09 01:08 | `ff0a11ef` | K3 GATE package |
| 2026-05-08 22:34 | `08c60362` | **before PR #1443 merged** |
| 2026-05-08 20:36 | `08c60362` | |

The failure predates the closeout work by at least five commits, which
is the basis for the `non-regression` classification.

## Adjacent finding (separate root cause, not part of #3)

| Workflow | SHA | Conclusion | Note |
| --- | --- | --- | --- |
| `Phase 5 Nightly Validation (with Regression)` | `818b9a7e` | failure (job `validate`) | Single observed occurrence on this SHA. Sibling scheduled jobs `Phase 5 Nightly Validation` and `Phase 5 Nightly Validation (External Metrics)` both `success`, so the failure is in the regression suite itself, not the base nightly. Not folded into matrix item #3 — requires a separate ops diagnosis outside this closeout. |

## Confirmed (no change)

- 13/13 "must merge" PRs landed on `main` (PR #1443 + the 12 backlog PRs
  + the 3 rebased conflict PRs #1269 / #1274 / #1366). Matrix item #16
  is now PASS for the full set.
- 142 currently runs
  `ghcr.io/zensgit/metasheet2-{backend,web}:818b9a7e30399a353593938284d9c9d34657a0e8`.
- 142 health probes (read-only, redacted):
  - backend `/api/health` = `200`
  - web `/` = `200`
  - `/api/admin/directory/dingtalk/work-notification` (unauth) = `401`
  - `/api/auth/me` (unauth) = `401`
- Matrix items 1, 2, 8, 12, 15, 16 = PASS.
- Matrix items 9, 10, 11, 13, 14, 17 = PENDING (Codex live acceptance,
  blocked on missing private credential files).

## Ops follow-ups (parallel, owner-side)

| # | Item | Owner | Blocks |
| --- | --- | --- | --- |
| O1 | Place 5 private credential files and `chmod 600`: `~/.config/yuantus/dingtalk-admin-token`, `~/.config/yuantus/dingtalk-agent-id`, `~/.config/yuantus/dingtalk-recipient-user-ids`, `~/.config/metasheet/admin-token`, `~/.config/metasheet/dingtalk-agent-id` | operator | **B (live acceptance)** |
| O2 | Configure Alertmanager webhook for the DingTalk OAuth stability self-heal path | ops | not B; required for a clean CLOSED, else carried as non-blocking ops follow-up |
| O3 | Provide the GitHub webhook secret used by the Alertmanager self-heal step | ops | same as O2 |
| O4 | Diagnose `Phase 5 Nightly Validation (with Regression)` failure on `818b9a7e` | ops | outside this closeout |

## Disposition for CLOSED

When Codex completes live acceptance (matrix 9–14, 17 → PASS), the
CLOSED declaration in the final verification doc must include either:

- **O2 + O3 resolved** → matrix #3 can read "all scheduled and gate CI
  green on the deployed SHA"; or
- **O2 + O3 still open** → matrix #3 stays as the corrected wording
  above, listed as a **known non-blocking ops follow-up**, and the
  CLOSED note explicitly references this correction document.

Either way, this correction supersedes the earlier "main CI green for
deployed SHA" phrasing in the post-merge deploy snapshot.
