# DingTalk Deploy Image Tag Reconcile Development - 2026-04-20

## Summary

Fixed the production deploy workflow drift where:

- running containers were recreated with the new `github.sha` image tag
- but the host repo `.env` file still kept the old `IMAGE_TAG`

That left production in a misleading state: live runtime was current, but the persisted compose configuration was stale.

## Root Cause

`docker-build.yml` was deploying with inline environment overrides only:

- `IMAGE_OWNER=...`
- `IMAGE_TAG=...`

Those values were passed directly into:

- `docker compose pull backend web`
- `docker compose up -d --no-deps --force-recreate backend web`

So compose used the correct image tag for that process, but nothing wrote the same values back into the host repo `.env`.

## Code Change

Updated `.github/workflows/docker-build.yml` in the remote deploy command sequence.

New behavior before preflight/deploy:

1. open or create the repo-root `.env`
2. preserve existing non-image entries and comments
3. upsert:
   - `IMAGE_OWNER`
   - `IMAGE_TAG`
4. write the file back to disk

This keeps the persisted compose environment aligned with the image tag that the workflow is actually deploying.

## Production Reconcile Performed

Before the workflow fix is merged, I manually reconciled the live production host config:

- host: `142.171.239.56`
- file: `~/metasheet2/.env`

Updated values:

- `IMAGE_OWNER=zensgit`
- `IMAGE_TAG=88a45881821f0792e4a54c1161588f603a59e34b`

This removes the current drift immediately, without changing already-running containers.

## Notes

- No app runtime code changed.
- No database migration changed.
- This is a deploy workflow and production-config consistency fix.
