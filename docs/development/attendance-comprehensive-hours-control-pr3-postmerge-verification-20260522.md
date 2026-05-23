# Attendance Comprehensive Working Hours Control PR3 Post-Merge Verification

Date: 2026-05-22
Branch checked: `origin/main`
Merge commit: `29d01e65f477b5d876b9672ac5d85ee4b6febce4`

## Summary

PR3 (`#1777`, admin read-only comprehensive-hours preview UI) is merged to `main`.
The code and image-build portions are verified, but remote runtime deployment and
live UI smoke are **not** closed because the deploy host SSH path is currently
unavailable.

## Verified

| Check | Result |
| --- | --- |
| `#1777` PR state | `MERGED` |
| Merge commit in `origin/main` | PASS: `29d01e65f...` is `origin/main` HEAD at verification time. |
| PR checks before merge | PASS: Node 18, Node 20, coverage, e2e, contracts, after-sales, DingTalk P4, K3 WISE all green; Strict E2E skipped by rule. |
| Docker image build/push | PASS inside run `26319033603`: backend and frontend build/push steps both succeeded. |
| `Deploy to Production` workflow | PASS for run `26319033530`, but this workflow is a minimal/stub deployment gate and is not sufficient as runtime deployment evidence. |

## Not Verified

| Check | Result |
| --- | --- |
| Real remote deploy through `Build and Push Docker Images` | FAIL/BLOCKED: run `26319033603` failed in deploy job before remote deploy. |
| Failure point | `Sync deploy host files` failed: `ssh: connect to host *** port 22: Connection timed out` in GitHub Actions. |
| Direct health probe | Inconclusive: `http://142.171.239.56:8081/api/health` and `:8082` returned `Empty reply from server`; HTTPS timed out. |
| Local SSH probe | Failed: `Connection closed by 142.171.239.56 port 22`. |
| Live admin UI smoke | Not run; no verified running host containing `29d01e65f...` was reachable. |

## Operational Follow-Up

Before claiming production runtime evidence for PR3:

1. Restore/confirm deploy-host SSH reachability from GitHub Actions or rerun the deploy from an allowed network path.
2. Rerun the `Build and Push Docker Images` workflow for a commit that includes `29d01e65f...`.
3. Confirm remote runtime image/tag includes the PR3 merge commit.
4. Run an admin UI smoke:
   - open Attendance admin
   - navigate to `Scheduling -> Comprehensive hours`
   - enter one known sample `userId`
   - preview both `planned` and `actual`
   - confirm read-only result rendering and no Save/Apply/Enforce write controls

This is a deployment/connectivity gap, not a PR3 code regression.
