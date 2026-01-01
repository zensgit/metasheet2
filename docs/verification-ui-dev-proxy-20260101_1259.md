# UI dev proxy smoke (2026-01-01 12:59 CST)

## Scope
- Dev server bring-up (web)
- Core backend health
- Vite proxy to `/api/univer-meta/views`

## Commands
```bash
# Start backend (core)
nohup pnpm --filter @metasheet/core-backend dev:core > /tmp/metasheet-core-dev.log 2>&1 &

# Wait for startup, then probe health
curl -s -o /dev/null -w "health:%{http_code}\\n" http://127.0.0.1:7778/health

# Start web dev server
nohup env NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter @metasheet/web dev -- \
  --host 127.0.0.1 --port 8899 > /tmp/metasheet-web-dev.log 2>&1 &

# Frontend + proxy probes
curl -s -o /dev/null -w "web:%{http_code}\\n" http://127.0.0.1:8899/
curl -s -o /dev/null -w "proxy:%{http_code}\\n" \
  "http://127.0.0.1:8899/api/univer-meta/views?sheetId=univer_demo_meta"
```

## Result
- Backend health: `200` (after ~20s warmup)
- Web dev server: `200`
- Vite proxy to `/api/univer-meta/views`: `401`

## Notes
- Backend logs show DB connection timeouts for workflow engine init; server still responds to `/health`.
- `401` on `/api/univer-meta/views` is expected without auth; use `Dev Login` UI or attach a valid token to test data endpoints.
- Logs captured at:
  - `/tmp/metasheet-core-dev.log`
  - `/tmp/metasheet-web-dev.log`
