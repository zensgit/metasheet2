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

# ECM core health
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/actuator/health
```

## Result
- Keycloak OpenID config: `200`
- Token retrieval: `tmp/admin.access_token` written (unified-portal client)
- ECM core health: `000` (connection refused) → ECM core not reachable

## Next
- Start ECM core (docker-compose / service) and re-run health + a protected API (e.g. `GET /api/v1/users`).
- If using `ecm-api` client, include `KEYCLOAK_CLIENT_SECRET` in token request.
