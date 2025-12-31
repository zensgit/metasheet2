# Yuantus PLM verification (2025-12-31 15:07 CST)

## Scope
- Health
- Search (GET)
- AML get item
- BOM tree
- Where-used
- BOM compare
- BOM substitutes (non-empty)

## Environment
- PLM_BASE_URL: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1
- User: admin / admin
- Item ID (AML get): 528168dc-c95a-4af7-b542-363f02075727
- BOM root ID: 528168dc-c95a-4af7-b542-363f02075727
- Where-used item: 346e9c5d-a640-48a4-9fb6-889d05093a10
- BOM line ID: 537c9c7b-14a7-4cb3-888e-a26f27e0b5f5
- BOM compare left/right: 528168dc-c95a-4af7-b542-363f02075727 / eeaf9fb0-df30-4123-bba4-22487ba44ada

## Setup (data seeded in PLM)
- Seeded identity + meta schema via `yuantus seed-identity` / `yuantus seed-meta`.
- Created Parts A/B/C and BOM relationships A->B, B->C.
- Created a temporary substitute part and attached to BOM line for non-empty substitutes check.

## Command
```bash
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
PLM_ITEM_ID=528168dc-c95a-4af7-b542-363f02075727 \
PLM_BOM_ITEM_ID=528168dc-c95a-4af7-b542-363f02075727 \
PLM_WHERE_USED_ITEM_ID=346e9c5d-a640-48a4-9fb6-889d05093a10 \
PLM_BOM_LINE_ID=537c9c7b-14a7-4cb3-888e-a26f27e0b5f5 \
PLM_BOM_COMPARE_LEFT_ID=528168dc-c95a-4af7-b542-363f02075727 \
PLM_BOM_COMPARE_RIGHT_ID=eeaf9fb0-df30-4123-bba4-22487ba44ada \
  scripts/verify-yuantus-plm.sh
```

## Result
```
Token OK (len=195)
== Health ==
{'ok': True, 'service': 'yuantus-plm', 'version': '0.1.0', 'tenant_id': None, 'org_id': None, 'tenancy_mode': 'single', 'schema_mode': 'migrations', 'audit_enabled': False}
== Search (GET) ==
keys: ['hits', 'total']
total: 73
hits_len: 2
== AML Apply (get item) ==
items_len: 1
item_keys: ['id', 'properties', 'state', 'type']
== BOM Tree ==
root_keys: ['id', 'item_type_id', 'config_id', 'generation', 'is_current', 'state', 'current_state', 'current_version_id', 'created_by_id', 'created_on', 'modified_by_id', 'modified_on', 'owner_id', 'permission_id', 'source_id', 'related_id', 'name', 'item_number', 'children']
children_len: 1
== Where Used ==
item_id: 346e9c5d-a640-48a4-9fb6-889d05093a10
count: 2
parents_len: 2
== BOM Compare ==
summary: {'added': 1, 'removed': 2, 'changed': 0, 'changed_major': 0, 'changed_minor': 0, 'changed_info': 0}
== BOM Substitutes ==
bom_line_id: 537c9c7b-14a7-4cb3-888e-a26f27e0b5f5
count: 1
subs_len: 1
== Done ==
```

## Cleanup
- Removed temporary substitute relation and substitute part.
