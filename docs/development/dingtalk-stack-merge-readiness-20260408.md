# DingTalk Stack Merge Readiness

Date: 2026-04-08
Stack:

- PR1 `#725` `feat(dingtalk): add oauth login foundation`
- PR2 `#723` `feat(dingtalk): add directory sync admin slice`
- PR3 `#724` `feat(dingtalk): harden attendance sync and add robot notifications`

## Recommended review and merge order

1. Review and merge `#725`
2. Rebase `#723` if needed, then review and merge `#723`
3. Rebase `#724` if needed, then review and merge `#724`

Reason:

- `#723` builds on the shared DingTalk client and auth foundation from `#725`
- `#724` is intentionally narrower, but it sits at the top of the same stack and should be reviewed after the lower layers are accepted

## PR1 readiness

Status:

- review-ready

What is solid:

- narrow write set relative to `main`
- backend auth state handling and callback flow covered by unit tests
- frontend callback route covered by targeted tests
- backend build and frontend type-check already passed

Residual risks to call out during review:

- live DingTalk tenant login was not executed
- `DINGTALK_AUTH_AUTO_LINK_EMAIL` defaults to enabled, so production rollout should confirm email authority inside the tenant
- no admin-facing grant management yet

Blocking issue found in local review:

- none

## PR2 readiness

Status:

- review-ready

What is solid:

- minimal service/route/UI slice instead of replaying the historical featureline
- current-main directory tables are reused without new migrations
- backend route tests and frontend view tests cover the intended entry path

Residual risks to call out during review:

- no live DingTalk tenant sync was executed
- `directory-sync.ts` does not yet have deep persistence-path unit coverage
- admin access still relies on the existing admin gate rather than a dedicated `directory:*` permission family

Blocking issue found in local review:

- none

## PR3 readiness

Status:

- review-ready after follow-up fix `811d6b0cd`

What is solid:

- attendance DingTalk requests now use timeout and retry/backoff
- partial user-level failures no longer abort the full sync
- failed attendance runs are written back as `failed` instead of staying `running`
- real DingTalk robot notification channel is implemented
- additive `partialErrors` response field is documented
- targeted notification tests plus attendance integration regression passed

Residual risks to call out during review:

- notification verification still uses mocked fetch rather than a live DingTalk robot endpoint
- attendance hardening still lives inside the large `plugins/plugin-attendance/index.cjs` file
- no live tenant validation yet for attendance or notifications

Follow-up issue found and fixed before review:

- non-retryable DingTalk robot `HTTP 400` failures were being retried by the shared notification retry wrapper
- fixed in `811d6b0cd fix(dingtalk): avoid retrying non-retryable robot failures`

## Overall stack recommendation

Recommended gate before marking the stack ready for production:

1. one real DingTalk browser login in staging
2. one real directory credential test and manual sync in staging
3. one real attendance sync against a staging dataset
4. one real DingTalk robot notification send to a staging group

Recommended gate before changing the PRs from draft:

1. reviewers acknowledge the stacked order
2. staging owner confirms the callback URI and DingTalk app credentials are available
3. rollout owner decides whether email auto-link should stay enabled in production

## Claude parallel review note

Claude CLI was assigned a read-only findings pass for the stacked PRs during this readiness sweep.

The implementation and final readiness judgment in this document are based on the local code, test runs, and direct git/PR inspection in the current worktrees.
