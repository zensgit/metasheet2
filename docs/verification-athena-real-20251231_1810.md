# Athena real API verification (2025-12-31 18:10 CST)

## Scope
- ECM core availability + auth
- Endpoints used by `AthenaAdapter`:
  - Health
  - Folders (roots)
  - Search
  - Node detail
  - Document pipeline status

## Environment
- ECM core: `http://localhost:7700` (athena-ecm-core-1)
- Keycloak: `http://localhost:8180`
- Token: generated via `scripts/get-token.sh admin admin` (unified-portal client)
- Issuer fix applied in `Athena/docker-compose.yml`:
  `SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:8080/realms/ecm`

## Commands
```bash
BASE=http://localhost:7700
TOKEN=$(cat /Users/huazhou/Downloads/Github/Athena/tmp/admin.access_token)

curl -s -o /dev/null -w "%{http_code}" $BASE/actuator/health
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/users
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/folders/roots
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/search?q=doc"
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/documents/pipeline/status

# Sample node detail (document ID from search)
DOC_ID=40b28665-6cb0-4cfe-9e67-59c1a3668049
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/nodes/$DOC_ID | head -c 400
```

## Result
- Health: `200`
- Users: `200`
- Folder roots: `200`
  - Example root folder: `d47a22e5-4aae-4bae-a9b1-8b045ba8f2a0` (`/uploads`)
- Search: `200`
  - Example document ID: `40b28665-6cb0-4cfe-9e67-59c1a3668049`
- Node detail: `200`
- Pipeline status: `200` (`ACTIVE`)

## Notes
- ECM core was previously unreachable on 8081; current stack exposes 7700.
- Issuer mismatch fixed by setting `SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI`.
