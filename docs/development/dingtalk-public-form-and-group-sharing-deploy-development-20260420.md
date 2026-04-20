# DingTalk Public Form And Group Sharing Deploy Development - 2026-04-20

## Summary

Merged and deployed the two pending DingTalk follow-ups:

- `#935` `feat(auth): support no-email DingTalk user admission`
- `#936` `feat(dingtalk): share group destinations across sheet managers`

This rollout did not require a manual hotfix. Both changes were released through the repository's main-branch automation:

- `Build and Push Docker Images` run `24659314048`
- `Deploy to Production` run `24659314034`

## Scope Delivered

### `#935`

- admin-side DingTalk admission can create and bind local users without email
- `users.email` is now nullable
- optional `users.username` is available as a non-email identifier
- login and onboarding flows support `email | username | mobile`

### `#936`

- `dingtalk_group_destinations` gained nullable `sheet_id`
- newly created DingTalk group destinations can be shared at sheet scope
- sheet managers can reuse destinations created by other managers on the same sheet
- legacy destinations remain private by owner when `sheet_id` is null

## Release Path

1. Confirmed both PRs were merged into `main`.
2. Confirmed `origin/main` moved to:
   - `97995e6af8f48d79c086f7584748bfd38843aada` for `#935`
   - `88a45881821f0792e4a54c1161588f603a59e34b` for `#936`
3. Waited for main-branch automation instead of forcing a second manual deploy.
4. Verified the build workflow finished successfully and actually performed remote deployment.
5. Verified production runtime and schema over SSH.

## Important Operational Finding

The production runtime is on the correct image tag:

- backend: `ghcr.io/zensgit/metasheet2-backend:88a45881821f0792e4a54c1161588f603a59e34b`
- web: `ghcr.io/zensgit/metasheet2-web:88a45881821f0792e4a54c1161588f603a59e34b`

But the host-side `.env` still contains:

- `IMAGE_TAG=71e29327d052f4976dff549e46d34aa96f398667`

So the deployment is successful, but the host configuration is now drifting from the live containers. This is not a runtime blocker today, but it is operational debt and should be cleaned up in the deploy workflow or a follow-up ops change.

## Notes

- No new application code was written for this rollout step; the work was merge, deploy, and production validation.
- The public domain could not be resolved from the current local shell environment, so production HTTP validation was executed through SSH against `127.0.0.1` on the host.
