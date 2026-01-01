# Athena Keycloak auth smoke (2025-12-31 17:40 CST)

## Scope
- Keycloak availability
- Token retrieval (unified-portal)
- ECM core reachability

## Checks
```bash
# Keycloak OpenID config
curl -s -o /dev/null -w "%{http_code}" http://localhost:8180/realms/ecm/.well-known/openid-configuration

# Token retrieval
cd /Users/huazhou/Downloads/Github/Athena
bash scripts/get-token.sh admin admin
cat tmp/admin.access_token

# ECM core health (current stack exposes 7700 -> 8080)
curl -s -o /dev/null -w "%{http_code}" http://localhost:7700/actuator/health

# ECM core auth probe
TOKEN="$(cat /Users/huazhou/Downloads/Github/Athena/tmp/admin.access_token)"
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" http://localhost:7700/api/v1/users
```

## Result
- Keycloak OpenID config: `200`
- Token retrieval: `tmp/admin.access_token` written (unified-portal client)
- ECM core health: `200` (reachable on port 7700)
- Auth probe: `401` (issuer mismatch)

## Next
- Align Keycloak issuer and ECM resource server config:
  - Keycloak currently sets `KC_HOSTNAME=localhost` → tokens use `iss=http://localhost:8080/realms/ecm`.
  - ECM core expects `iss=http://keycloak:8080/realms/ecm` (default).
  - Fix options:
    1) Set Keycloak `KC_HOSTNAME=keycloak` and restart, or
    2) Override ECM core env: `SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:8080/realms/ecm`.
- After aligning, re-run `/api/v1/users` with the same token.
