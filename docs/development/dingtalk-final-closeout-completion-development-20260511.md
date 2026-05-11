# DingTalk Final Closeout Completion - Development

- Date: 2026-05-11
- Scope: DingTalk group robot delivery, work-notification Agent ID, public-form access, directory no-email admission, and 142 production closeout.
- Current main SHA: `ca70e340ad8a8c1482b68c723e86fd6ce99324de`
- Deployed 142 images:
  - Backend: `ghcr.io/zensgit/metasheet2-backend:ca70e340ad8a8c1482b68c723e86fd6ce99324de`
  - Web: `ghcr.io/zensgit/metasheet2-web:ca70e340ad8a8c1482b68c723e86fd6ce99324de`
- Verdict: **CLOSED for DingTalk delivery**, with the non-blocking deferrals listed below.

## What Closed

The DingTalk delivery line is now closed against the production 142 deployment:

- Failure-alert runtime path landed via PR #1443 and is deployed through the current main image.
- The must-merge closeout backlog landed before final acceptance; the later #1453 regression fix restored the ops regression gate.
- The no-email DingTalk directory admission edge case was fixed via PR #1460 and is deployed.
- The final remote smoke generated redacted development and verification docs:
  - `docs/development/dingtalk-final-remote-smoke-development-20260511.md`
  - `docs/development/dingtalk-final-remote-smoke-verification-20260511.md`
- The final evidence packet is on 142 at:
  - `artifacts/dingtalk-staging-evidence-packet/142-live-20260510-final`

## Product Capability State

The following capabilities are present in the deployed image:

- DingTalk group robot destinations for two real groups, including signed webhook validation and manual test-send.
- Group automation delivery with protected form links.
- Work-notification Agent ID configuration and real person notification path.
- Failure-alert fallback from failed group delivery to the rule creator's DingTalk work notification.
- Public form access modes `public`, `dingtalk`, and `dingtalk_granted`, including selected-user/member-group authorization behavior.
- DingTalk directory sync account binding and no-email local-user admission.
- Admin directory page at `/admin/directory` and its authenticated API routes.

## Final Remote Smoke

The final 142 remote smoke completed strict closeout:

- Required checks passed: `8/8`
- Remaining checks: `0`
- Manual evidence issues: `0`
- Secret findings: `0`
- Session status: `pass`
- Final strict status: `pass`
- Smoke status: `release_ready`
- Handoff status: `pass`
- Publish status: `pass`

The remote smoke explicitly live-proved the protected `dingtalk_granted` path, A/B group robot delivery, authorized submit, unauthorized denial, delivery history, and no-email `ddzz` account create/bind. The broader `public` and standard `dingtalk` form access modes are covered by merged automated tests and the current verification run.

## 142 Runtime State

142 is running the final main image:

```text
head=ca70e340ad8a8c1482b68c723e86fd6ce99324de
web=ghcr.io/zensgit/metasheet2-web:ca70e340ad8a8c1482b68c723e86fd6ce99324de
backend=ghcr.io/zensgit/metasheet2-backend:ca70e340ad8a8c1482b68c723e86fd6ce99324de
```

Runtime probes:

```text
/                         200
/admin/directory          200
/api/health               200
/api/admin/directory/dingtalk/work-notification unauthenticated probe 401
```

The `401` response is expected for the unauthenticated admin route probe: it proves the route exists and the auth gate is active.

## Non-Blocking Deferrals

These remain intentionally outside this closeout:

- Shared organization-level group robot catalog expansion.
- Row/column-level fill task assignment.
- Finer DingTalk organization governance UI.
- Screenshot-only evidence archive beyond the already accepted operator screenshots and redacted packet.
- Optional summary-polish PRs that do not affect runtime acceptance.

## Security Notes

- No DingTalk webhook URL, robot secret, JWT, app secret, temporary password, Agent ID value, or recipient user id is recorded in this document.
- Raw evidence packet files should remain restricted to the release team unless separately reviewed.
- The final public documents should continue to use redacted identifiers only.
