# DingTalk Final Closeout — Post-Merge Deploy Snapshot

- Date: 2026-05-09 (UTC, immediately after PR #1443 squash-merge)
- Companion docs (already on `main` after merge):
  - `docs/development/dingtalk-final-closeout-development-20260508.md`
  - `docs/development/dingtalk-final-closeout-verification-20260508.md`
  - `docs/development/dingtalk-final-closeout-execution-design-20260508.md`
  - `docs/development/dingtalk-final-closeout-execution-verification-20260508.md`
- Reviewer: Claude (Opus 4.7, 1M context), interactive harness
- Redaction policy: this document contains no real DingTalk webhook,
  robot `SEC...`, admin JWT, bearer token, app secret, Agent ID value,
  recipient user id, or temporary password. All probes are unauthenticated
  or row-count only.

## Merge Recap

| Field | Value |
| --- | --- |
| PR | #1443 `fix(dingtalk): notify rule creator on group delivery failure` |
| PR head before merge | `937da2e2574f1a5447400b8aef76c3a7c98799ca` |
| Merge method | `gh pr merge 1443 --squash --admin --delete-branch` (admin override; `enforce_admins=false` permits) |
| Merge commit (squash) | `f5cbe9947b276db1493e7957ee329574e0cd6e05` |
| Merged at | `2026-05-09T03:45:53Z` |
| New `origin/main` HEAD | `f5cbe9947b276db1493e7957ee329574e0cd6e05` |
| PR state | `MERGED` |
| Remote head branch | deleted on origin (`--delete-branch` succeeded server-side) |
| Local cleanup | a stray worktree at `/private/tmp/metasheet2-dingtalk-final-closeout-20260508` still held the deleted branch ref; not a merge issue |

## Post-Merge CI

| Workflow | Conclusion |
| --- | --- |
| Build and Push Docker Images | success |
| Deploy to Production | success |
| Phase 5 Production Flags Guard | success |
| Observability E2E | success |
| `.github/workflows/monitoring-alert.yml` | success |
| Plugin System Tests | in_progress at observation time (non-deploy gate) |

## 142 Image Flip

| Field | Pre-merge value (observed earlier) | Post-merge value |
| --- | --- | --- |
| backend image | `ghcr.io/zensgit/metasheet2-backend:c74c15a2bf31f33acee702389cc80db3358b0789` | **`ghcr.io/zensgit/metasheet2-backend:f5cbe9947b276db1493e7957ee329574e0cd6e05`** |
| web image | `ghcr.io/zensgit/metasheet2-web:c74c15a2bf31f33acee702389cc80db3358b0789` | **`ghcr.io/zensgit/metasheet2-web:f5cbe9947b276db1493e7957ee329574e0cd6e05`** |
| backend container start | n/a | `2026-05-09T03:47:45.471885355Z` |
| web container start | n/a | `2026-05-09T03:47:45.932803166Z` |

Container restart latency from merge → image flip ≈ **1m 52s** end-to-end.
The intermediate SHA `c74c15a2b…` corresponds to PR #1446 (multitable RC
archive) which had landed between sessions; it is not part of this
closeout.

## Health Probes On New Image

```
backend /api/health                                = 200
web /                                              = 200
admin /api/admin/directory/dingtalk/work-notification (unauth probe) = 401
backend /api/auth/me (unauth probe)                = 401
```

All four probes pass on `f5cbe9947b…`. Unauth `401` on the two
authenticated routes confirms the gate is still active and the routes
are present in the new image.

## DingTalk Delivery Tables (counts only, no PII)

```
dingtalk_group_deliveries  total = 71
dingtalk_person_deliveries total = 10
```

Counts unchanged from the pre-merge snapshot — expected, since no live
DingTalk traffic has flowed against the new image yet. The
failure-alert path introduced by PR #1443 has not been exercised; that
is Codex's next step.

## Verification Matrix Status After Merge

Source of truth remains
`docs/development/dingtalk-final-closeout-verification-20260508.md` on
`main`. Status delta after this snapshot:

| # | Gate | New status | Owner |
| --- | --- | --- | --- |
| 1 | 142 backend `/api/health=200` | **PASS** (re-confirmed on `f5cbe9947b…`) | Claude |
| 2 | 142 web `/=200` | **PASS** | Claude |
| 3 | `main` CI green for the deployed SHA | **PASS** (Build / Deploy / Phase 5 / Obs E2E / monitoring-alert all `success`) | Claude |
| 4–7 | Backlog PR CI green | unchanged | n/a |
| 8 | Admin work-notification route 401 unauth | **PASS** | Claude |
| 9 | Agent ID `--save` real round-trip | **PENDING** | Codex |
| 10 | Agent ID real-send work notification | **PENDING** | Codex |
| 11 | A/B group robot at-least-one delivered | **PENDING** | Codex |
| 12 | Failure-alert code path covered by unit test | **PASS** (already from PR) | n/a |
| 13 | Failure-alert end-to-end on 142 | **PENDING** | Codex |
| 14 | `public` / `dingtalk` / `dingtalk_granted` form paths live | **PENDING** | Codex |
| 15 | No secret leakage in branch code/docs | **PASS** | n/a |
| 16 | "Must merge" PR set merged | **PASS for #1443**; remaining must-merge backlog still pending | Human reviewer |
| 17 | Final secret scan over populated session packet | **PENDING** | Codex |

## Codex Handoff

Run on 142 (or in the trusted operator environment), in this order. All
private inputs stay outside git and outside this document.

```bash
# (3) Agent ID save (private files, no values printed)
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file <private-admin-token-file> \
  --agent-id-file   <private-agent-id-file> \
  --save

# (4) real-send work notification
node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file       <private-admin-token-file> \
  --agent-id-file         <private-agent-id-file> \
  --recipient-user-id-file <private-recipient-user-id-file>

# (5) live smoke session + final closeout wrapper
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir       output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir   docs/development \
  --date              20260509

# (6) failure-alert E2E — the regression case introduced by this PR
#   - Trigger a real send_dingtalk_group_message automation step that fails
#     (e.g., temporarily de-authorize one bound robot or target an
#     unreachable group).
#   - Confirm:
#       * new dingtalk_group_deliveries row with success=false
#       * new dingtalk_person_deliveries row for the rule creator with
#         step.output.failureAlert shape
#       * rule creator receives a DingTalk work notification on a real device
#       * the original group step still ends 'failed' (alert never masks it)
#   - Roll back the temporary fault injection.

# (7) final secret scan over the populated packet
#   - Strict scan of artifacts/dingtalk-staging-evidence-packet/142-final/
#   - Expect: clean modulo redactor/scan code and dummy fixtures.
```

After completion, Codex flips matrix items 9–14, 17 in
`dingtalk-final-closeout-verification-20260508.md` from PENDING to PASS,
records `f5cbe9947b…` as the deployed `main` SHA, and declares the
DingTalk feature delivery **CLOSED**.

## Local Cleanup (cosmetic only)

The merge command's `--delete-branch` failed locally because a worktree
held the deleted branch ref. Resolve at your convenience:

```bash
git worktree remove /private/tmp/metasheet2-dingtalk-final-closeout-20260508
git branch -D codex/dingtalk-final-closeout-20260508
```

Origin's branch is already deleted; this is purely local hygiene.

## Redaction Audit On This Document

- No real DingTalk webhook URL, robot `SEC...`, JWT, bearer token, app
  secret, Agent ID value, recipient user id, temporary password, or
  `.env` content appears.
- All `<...>` placeholders in the Codex command block remain
  placeholders.
- Strict value-pattern secret scan run after writing this file: 0
  matches against `SEC[a-zA-Z0-9]{30,}` / `Bearer\s+[A-Za-z0-9._-]{20,}` /
  JWT three-segment / `oapi.dingtalk.com/robot/send?access_token=` /
  `access_token=[A-Za-z0-9]{20,}` / `app_secret=[A-Za-z0-9]{20,}`.

## Verdict

- **可试用但仍非 CLOSED** — pre-merge to deploy plumbing is healthy on
  `f5cbe9947b…`. The matrix items that depend on private credentials
  and on real failure-alert end-to-end (9–14, 17) are still PENDING and
  cannot be flipped to PASS without Codex execution. Until those land,
  the DingTalk feature delivery remains officially **NOT CLOSED** per
  the closeout policy on `main`.
- This document is intended to be appended to the existing closeout
  package on `main` after Codex completes the live acceptance, or kept
  as a standalone Claude-side handoff record if Codex authors a fresh
  verification doc instead.
