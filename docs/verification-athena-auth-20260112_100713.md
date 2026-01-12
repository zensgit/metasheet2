# Verification: Athena Auth Smoke - 20260112_100713

## Environment
- Keycloak: http://localhost:8180
- Realm: ecm
- Client: unified-portal
- Athena base: http://localhost:7700

## Token
- Status: ok

## Endpoints
- Health (/actuator/health): HTTP 200
- Authenticated ping (/api/v1/categories): HTTP 200

## Notes
- Provide KEYCLOAK_CLIENT_SECRET if using a confidential client (e.g. `ecm-api`).
