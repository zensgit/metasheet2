# Yuantus PLM verification (2025-12-31 14:58 CST)

## Scope
- Health
- Search (GET)
- AML get item
- BOM tree
- BOM substitutes

## Environment
- PLM_BASE_URL: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1
- User: admin / admin
- Item ID (AML get): 528168dc-c95a-4af7-b542-363f02075727
- BOM root ID: 528168dc-c95a-4af7-b542-363f02075727
- Auto-detected BOM line ID: 537c9c7b-14a7-4cb3-888e-a26f27e0b5f5

## Setup (data seeded in PLM)
- Seed identity + meta schema via `yuantus seed-identity` / `yuantus seed-meta` in the PLM API container.
- Created Parts A/B/C and BOM relationships A->B, B->C.

## Command
```bash
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
PLM_ITEM_ID=528168dc-c95a-4af7-b542-363f02075727 \
PLM_BOM_ITEM_ID=528168dc-c95a-4af7-b542-363f02075727 \
  scripts/verify-yuantus-plm.sh
```

## Result
```
Token OK (len=195)
== Health ==
{'ok': True, 'service': 'yuantus-plm', 'version': '0.1.0', 'tenant_id': None, 'org_id': None, 'tenancy_mode': 'single', 'schema_mode': 'migrations', 'audit_enabled': False}
== Search (GET) ==
keys: ['hits', 'total']
total: 70
hits_len: 2
== AML Apply (get item) ==
items_len: 1
item_keys: ['id', 'properties', 'state', 'type']
== BOM Tree ==
root_keys: ['id', 'item_type_id', 'config_id', 'generation', 'is_current', 'state', 'current_state', 'current_version_id', 'created_by_id', 'created_on', 'modified_by_id', 'modified_on', 'owner_id', 'permission_id', 'source_id', 'related_id', 'name', 'item_number', 'children']
children_len: 1
Auto-detected BOM line id: 537c9c7b-14a7-4cb3-888e-a26f27e0b5f5
== Where Used == (skipped)
== BOM Compare == (skipped)
== BOM Substitutes ==
bom_line_id: 537c9c7b-14a7-4cb3-888e-a26f27e0b5f5
count: 0
subs_len: 0
== Done ==
```
