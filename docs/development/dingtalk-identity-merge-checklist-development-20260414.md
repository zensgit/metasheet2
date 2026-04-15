# DingTalk Identity Merge Checklist

Date: 2026-04-14
Branch: `codex/dingtalk-identity-integration-20260414`

## PR Order

1. runtime
   - <https://github.com/zensgit/metasheet2/pull/new/codex/dingtalk-identity-runtime-20260414>
2. frontend
   - <https://github.com/zensgit/metasheet2/pull/new/codex/dingtalk-identity-frontend-20260414>
3. integration/docs
   - <https://github.com/zensgit/metasheet2/pull/new/codex/dingtalk-identity-integration-20260414>

## Runtime PR Checklist

- confirm branch head is `80864ac61`
- confirm changed scope is backend/runtime only
- confirm `GET /api/auth/dingtalk/launch?probe=1` returns structured runtime status
- confirm `/api/admin/users/:userId/dingtalk-access` contains `server`
- confirm launch/callback success path is unchanged
- attach verification commands from:
  - `dingtalk-runtime-status-verification-20260414.md`

## Frontend PR Checklist

- confirm branch head is `7060a2f30`
- confirm base branch is runtime PR or `main` after runtime merge
- confirm login page hides DingTalk entry when `available !== true`
- confirm login page shows an unavailable reason hint
- confirm user management page shows server runtime status, corpId, and allowlist
- attach verification commands from:
  - `dingtalk-runtime-status-frontend-verification-20260414.md`

## Integration / Docs PR Checklist

- confirm stack verification doc is present
- confirm stack handoff docs are present
- confirm PR draft docs are present
- confirm PR package docs are present
- keep this PR docs-only

## Reviewer Notes

- main worktree currently contains unrelated local DingTalk/admin changes and should not be used as evidence for these isolated lanes
- runtime lane should merge first because frontend consumes the new backend `server` payload
