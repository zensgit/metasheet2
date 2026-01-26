# Verification - PLM UI Where-Used / BOM Compare / Substitutes (2026-01-26)

## Environment
- Yuantus PLM: http://127.0.0.1:7910 (health 200)
- MetaSheet core-backend: http://127.0.0.1:7778
- Core-backend env:
  - PLM_API_MODE=yuantus
  - PLM_BASE_URL=http://127.0.0.1:7910
  - PLM_TENANT_ID=tenant-1
  - PLM_ORG_ID=org-1
  - PLM_USERNAME=admin
  - PLM_PASSWORD=admin
  - RBAC_TOKEN_TRUST=true

Note: core-backend DB connection failed (metasheet user auth), but RBAC token trust allowed federation requests.

## Test Data (Yuantus)
Created items (Part):
- P1 = 65b77bcc-9a45-41e5-aeda-029519be9dc9 (PLM-UI-P1-1769443481)
- P2 = ed88f795-fc5d-40bd-9c49-cd579a0ddd30 (PLM-UI-P2-1769443481)
- C1 = 073d4add-4b86-418a-8e74-9476acdb5930 (PLM-UI-C1-1769443481)
- C2 = 3b8804bf-1e11-4c7c-afef-ddca36ed1f0e (PLM-UI-C2-1769443481)
- S1 = 2b80cca5-700c-4385-931e-6db6c8000849 (PLM-UI-S1-1769443481)
- S2 = e5463d2b-a877-4baa-97b6-89817e3aaaab (PLM-UI-S2-1769443514)

BOM relationships:
- P1 -> C1: 34816b5e-3da5-48df-9b54-effd5382bd63
- P1 -> C2: 658f277a-401f-4273-b6a3-4905ad2c08e2
- P2 -> C1: a1df7cc0-32af-4592-8a76-1c42a4eb4349

Initial substitute (direct Yuantus):
- Substitute ID: fac4d2c0-a95f-4c1d-8c51-1e98b120ebf2

## Federation Calls

### 1) Where-Used
Request:
```bash
curl -s http://127.0.0.1:7778/api/federation/plm/query \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MS_TOKEN>' \
  -d '{"operation":"where_used","itemId":"073d4add-4b86-418a-8e74-9476acdb5930","recursive":true,"maxLevels":3}'
```
Result:
- count = 2
- parents include P1 + P2

### 2) BOM Compare Schema
Request:
```bash
curl -s http://127.0.0.1:7778/api/federation/plm/query \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MS_TOKEN>' \
  -d '{"operation":"bom_compare_schema"}'
```
Result:
- line_fields = 8

### 3) BOM Compare
Request:
```bash
curl -s http://127.0.0.1:7778/api/federation/plm/query \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MS_TOKEN>' \
  -d '{"operation":"bom_compare","leftId":"65b77bcc-9a45-41e5-aeda-029519be9dc9","rightId":"ed88f795-fc5d-40bd-9c49-cd579a0ddd30","maxLevels":3,"includeSubstitutes":true,"includeEffectivity":true}'
```
Result summary:
- added=0, removed=1, changed=1, changed_major=1

### 4) Substitutes (query/add/remove)
Query:
```bash
curl -s http://127.0.0.1:7778/api/federation/plm/query \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MS_TOKEN>' \
  -d '{"operation":"substitutes","bomLineId":"34816b5e-3da5-48df-9b54-effd5382bd63"}'
```
Result:
- count before add = 1

Add (S2):
```bash
curl -s http://127.0.0.1:7778/api/federation/plm/mutate \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MS_TOKEN>' \
  -d '{"operation":"substitutes_add","bomLineId":"34816b5e-3da5-48df-9b54-effd5382bd63","substituteItemId":"e5463d2b-a877-4baa-97b6-89817e3aaaab","properties":{"rank":2,"note":"alt-2"}}'
```
Result:
- substitute_id = f5a485e6-3985-4d76-8d8f-85fae2d723d3
- count after add = 2

Remove:
```bash
curl -s http://127.0.0.1:7778/api/federation/plm/mutate \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MS_TOKEN>' \
  -d '{"operation":"substitutes_remove","bomLineId":"34816b5e-3da5-48df-9b54-effd5382bd63","substituteId":"f5a485e6-3985-4d76-8d8f-85fae2d723d3"}'
```
Result:
- ok = true

## Outcome
All federation endpoints returned expected data for where-used, BOM compare, and substitutes.
