# UI verification via MCP (2026-01-01 23:53 CST)

## Scope
- Attempt to access local dev UI from MCP browser
- Document accessibility limits and manual fallback

## Environment
- Web dev server: `http://127.0.0.1:8899` (Vite, host 0.0.0.0)
- Core backend: `http://127.0.0.1:7778`

## Attempts
```text
http://localhost:8899/plm       -> ERR_CONNECTION_REFUSED
http://127.0.0.1:8899/plm       -> ERR_CONNECTION_REFUSED
http://10.8.8.170:8899/plm      -> ERR_CONNECTION_REFUSED
http://172.18.0.1:8899/plm      -> ERR_EMPTY_RESPONSE
http://host.docker.internal:8899/plm -> ERR_NAME_NOT_RESOLVED
```

## Result
- MCP browser cannot reach local dev server due to network isolation.
- Backend and web processes are running locally and reachable from the host.

## Manual verification fallback
On the host machine:
1. Open `http://127.0.0.1:8899/plm` in Chrome.
2. Click **Dev Login** (top-right).
3. Use Product ID `0245efd6-9e98-4960-8f59-c232c842f2d2` and verify:
   - Product details load
   - BOM shows at least 1 line item

## Notes
- If you want MCP/UI automation, run the dev server on a network interface reachable by the MCP runtime.
