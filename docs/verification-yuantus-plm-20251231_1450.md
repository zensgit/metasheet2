# Yuantus PLM verification (2025-12-31 14:50 CST)

## Scope
- Run `scripts/verify-yuantus-plm.sh` against local PLM endpoint

## Environment
- PLM_BASE_URL: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1
- Username: admin / admin
- Item ID: de7471da-0a5c-4436-971c-65ed64418df0
- BOM root ID: fc5ff0f7-3dc2-42ac-b95f-347fcbe476f1

## Command
```bash
PLM_ITEM_ID=de7471da-0a5c-4436-971c-65ed64418df0 \
PLM_BOM_ITEM_ID=fc5ff0f7-3dc2-42ac-b95f-347fcbe476f1 \
  scripts/verify-yuantus-plm.sh
```

## Result
```
curl: (7) Failed to connect to 127.0.0.1 port 7910: Couldn't connect to server
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

## Notes
- PLM service was not reachable on port 7910 during this run.
- Re-run after starting PLM or updating PLM_BASE_URL to a reachable instance.
