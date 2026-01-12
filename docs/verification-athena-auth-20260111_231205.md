# Verification: Athena Auth Smoke - 20260111_231205

## Environment
- Keycloak: http://localhost:8180
- Realm: ecm
- Client: unified-portal
- Athena base: http://localhost:8081

## Token
- Status: ok

## Endpoints
- Health (/actuator/health): HTTP 000
- Authenticated ping (/api/v1/health): HTTP 000

## Notes
- Provide KEYCLOAK_CLIENT_SECRET if using a confidential client (e.g. `ecm-api`).
