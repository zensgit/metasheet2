# Attendance Upload Limit Update - Verification Report (2026-01-31)

## Change
- Added `client_max_body_size 50m` in `docker/nginx.conf`.
- Mounted `docker/nginx.conf` into the web container via `docker-compose.app.yml`.

## Server Deployment
- Updated server worktree and recreated the `metasheet-web` container to pick up the new Nginx config.
- Verified in container: `/etc/nginx/conf.d/default.conf` includes `client_max_body_size 50m`.

## Verification
- Replayed a large preview payload that previously triggered `413 Request Entity Too Large`.
- Request: `POST /api/attendance/import/preview` with 1526 rows (`/tmp/attendance-rows-filtered.json`).
- Result: `ok: true`, `data.total: 1526`.

## Notes
- The preview payload is still large; if future imports exceed 50m, raise the limit further.
