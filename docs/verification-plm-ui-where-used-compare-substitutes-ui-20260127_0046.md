# Verification - PLM UI Where-Used / BOM Compare / Substitutes (2026-01-27)

## Environment
- Yuantus PLM: http://127.0.0.1:7910
- MetaSheet core-backend: http://127.0.0.1:7778
- MetaSheet web: http://127.0.0.1:8899
- Core-backend env:
  - PLM_API_MODE=yuantus
  - PLM_BASE_URL=http://127.0.0.1:7910
  - PLM_TENANT_ID=tenant-1
  - PLM_ORG_ID=org-1
  - PLM_USERNAME=admin
  - PLM_PASSWORD=admin
  - RBAC_TOKEN_TRUST=true (dev-only)

## Data
- P1: 65b77bcc-9a45-41e5-aeda-029519be9dc9
- P2: ed88f795-fc5d-40bd-9c49-cd579a0ddd30
- C1: 073d4add-4b86-418a-8e74-9476acdb5930
- C2: 3b8804bf-1e11-4c7c-afef-ddca36ed1f0e
- S1: 2b80cca5-700c-4385-931e-6db6c8000849
- S2: e5463d2b-a877-4baa-97b6-89817e3aaaab
- BOM line P1 -> C1: 34816b5e-3da5-48df-9b54-effd5382bd63

## UI Availability
- `GET http://127.0.0.1:8899/plm` => 200
- Chrome DevTools MCP unavailable (Transport closed). UI automation not executed; federation API validation used instead.

## Federation Validation (Proxy for UI calls)

Where-Used:
- Request: `operation=where_used` for C1 (recursive=true, maxLevels=3)
- Result:
  - count=2
  - parents include P1 + P2

BOM Compare:
- Schema line_fields=8
- Compare summary: added=0, removed=1, changed=1, changed_major=1

Substitutes:
- before count=1
- add substitute S2 => substitute_id=8333b84e-1887-415e-99f9-c20b0a74ee8e
- after count=2
- remove ok=true

## Outcome
Federation endpoints returned expected payloads for where-used, BOM compare, and substitutes. UI page is reachable; automated UI interaction was skipped due to DevTools MCP transport failure.
