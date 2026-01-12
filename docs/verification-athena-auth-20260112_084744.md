# Verification: Athena Auth Smoke - 20260112_084744

## Environment
- Keycloak: http://localhost:8180
- Realm: ecm
- Client: unified-portal
- Athena base: http://localhost:7700

## Token
- Status: ok

## Endpoints
- Health (/actuator/health): HTTP 200
- Authenticated ping (/api/v1/health): HTTP 404

## Notes
- Provide KEYCLOAK_CLIENT_SECRET if using a confidential client (e.g. `ecm-api`).
