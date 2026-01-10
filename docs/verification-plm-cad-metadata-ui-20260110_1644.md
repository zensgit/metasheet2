# Verification: PLM UI CAD Metadata Panel - 2026-01-10 16:44

## Goal
Validate the PLM UI CAD metadata panel and federation endpoints for Yuantus CAD operations.

## Environment
- UI: http://localhost:8899/plm
- Core backend: http://127.0.0.1:7779
- PLM adapter: mock mode (no external PLM configured)

## Steps
1. Start core-backend with Yuantus federation envs enabled.
2. Start the web dev server.
3. Load `/plm` and set `auth_token` in localStorage.
4. In the Documents table, click `主` to set a CAD file ID.
5. Click `刷新 CAD` to load properties/view state/review/history/mesh stats.
6. Update properties and view state via the JSON editors, then submit review state.
7. Set `对比 File ID` and click `加载` under 差异.

### API verification (mock mode)
```bash
BASE_URL=http://127.0.0.1:7779
TOKEN=$(curl -s "$BASE_URL/api/auth/dev-token?roles=admin&perms=federation:read,federation:write&expiresIn=1h" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

for op in cad_properties cad_view_state cad_review cad_history cad_mesh_stats; do
  curl -s "$BASE_URL/api/federation/plm/query" \
    -H "content-type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"operation\":\"$op\",\"fileId\":\"file-001\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])'
done

curl -s "$BASE_URL/api/federation/plm/query" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"operation":"cad_diff","fileId":"file-001","otherFileId":"file-002"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])'
```

## Results
- API verification (mock mode):
  - cad_properties: ok
  - cad_view_state: ok
  - cad_review: ok
  - cad_history: ok
  - cad_mesh_stats: ok
  - cad_diff: ok
- UI verification: not run yet.
