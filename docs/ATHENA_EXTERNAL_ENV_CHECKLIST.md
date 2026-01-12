# Athena External Environment Checklist

## Goal
Provide a minimal, repeatable baseline to validate Athena auth + health before deeper integrations.

## Required Inputs
- `ATHENA_BASE_URL` (e.g. `http://localhost:8081`)
- Keycloak auth inputs (choose one)
  - Public client: `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_USER`, `KEYCLOAK_PASSWORD`
  - Confidential client: also set `KEYCLOAK_CLIENT_SECRET`

## Default Template
```bash
export ATHENA_BASE_URL=http://localhost:8081
export KEYCLOAK_URL=http://localhost:8180
export KEYCLOAK_REALM=ecm
export KEYCLOAK_CLIENT_ID=unified-portal
export KEYCLOAK_USER=admin
export KEYCLOAK_PASSWORD=admin
```

## Docker Port Note
If you are running the Athena ECM core container from docker-compose, the exposed port may be `7700` (host) → `8080` (container). In that case:
```bash
export ATHENA_BASE_URL=http://localhost:7700
```

## Quick Verification
```bash
bash scripts/verify-athena-auth.sh
```

## Optional Overrides
- `ATHENA_HEALTH_PATH` (default: `/actuator/health`)
- `ATHENA_PING_PATH` (default: `/api/v1/categories`)
  - Use a read-only authenticated GET; `/api/v1/health` is not exposed on ECM core.
  - Set to empty if the endpoint is not exposed: `ATHENA_PING_PATH=`

## Common Failures
- `token missing`: wrong client/secret or username/password
- `401`: token expired or wrong realm
- `404` health: incorrect Athena base URL
