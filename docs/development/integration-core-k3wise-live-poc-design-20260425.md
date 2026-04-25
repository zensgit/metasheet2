# Integration Core K3 WISE Live PoC Design - 2026-04-25

## 1. Purpose

This document defines the first live PoC after the mock PLM to K3 WISE MVP.

The goal is to prove that `plugin-integration-core` can read real PLM material data, clean and validate it through the integration pipeline, write a very small Save-only payload into a K3 WISE test account, and write ERP feedback back into MetaSheet staging.

This PoC is not a production rollout. It must not write to a production K3 account, must not auto-submit or auto-audit by default, and must not directly update K3 core SQL Server business tables.

## 2. Scope

In scope:

- Yuantus PLM or third-party PLM read path through the PLM wrapper or a documented HTTP/DB read adapter.
- K3 WISE WebAPI/K3API write path for material master data.
- Optional K3 WISE SQL Server channel for read-only reconciliation, or for customer-approved middle-table writes.
- Integration staging sheets, mapping, transform, validator, idempotency, watermark, dead letter, run log, and ERP feedback.
- One simple BOM PoC after material Save-only succeeds.

Out of scope for this PoC:

- Production K3 writes.
- Default Submit/Audit automation.
- Direct writes to `t_ICItem`, `t_ICBOM`, `t_ICBomChild`, or other K3 core business tables.
- High-concurrency sync, multi-account orchestration, replacement materials, complex BOM effectivity, and production compensation transactions.
- M3 UI. The UI phase starts only after the live backend path passes.

## 3. GATE Before Work Starts

M2 live PoC must not start until the customer returns this checklist.

| Area | Required answer | Why it matters |
|---|---|---|
| K3 WISE version | Exact version and patch level | K3API/WebAPI payloads and response codes vary by deployment. |
| K3 API endpoint | Internal/external URL, network path, TLS policy | Confirms MetaSheet can reach the test account. |
| Test account | `acctId`, organization/account-set scope, write permission | Ensures all writes stay outside production. |
| Credentials | Named test user, permission scope, expiry policy | Required for controlled `testConnection` and Save-only run. |
| PLM access | API/table/view, auth method, sample material and BOM records | Defines source adapter and field mapping. |
| Material fields | K3 field code list for item create/update | Prevents blind payload construction. |
| BOM fields | K3 BOM header/child field code list | Needed before BOM PoC. |
| Submit/Audit policy | Save-only, Submit, Audit, or customer manual audit | Default is Save-only unless explicitly approved. |
| SQL Server scope | Read-only, middle table writable, stored procedures allowed, forbidden tables | Keeps SQL channel safe. |
| Middle database | Database/table names and ownership if available | Preferred over direct K3 business-table access. |
| Rollback SOP | How test items/BOMs are cleaned or marked invalid | Required before live write. |
| Evidence owner | Customer contact who confirms K3 result | Avoids ambiguous acceptance. |

## 4. Runtime Topology

Recommended live topology:

```text
PLM API/table/view
  -> plugin-integration-core adapter: plm:yuantus-wrapper or http/db source
  -> integration pipeline
  -> staging sheets: materials, bom, exceptions, run logs
  -> transform + validation + idempotency + watermark
  -> erp:k3-wise-webapi target
  -> K3 WISE test account Save-only
  -> erp feedback writeback
```

Optional SQL Server channel:

```text
K3 WISE SQL Server
  -> erp:k3-wise-sqlserver
  -> read-only reconciliation, duplicate checks, feedback lookup
```

The SQL Server channel can write only to a customer-approved integration database or middle table. Direct writes to K3 core business tables are not part of this PoC.

## 5. External System Configuration

Use redacted credentials in documentation and PRs.

Before creating these records manually, generate a local preflight packet from the customer GATE answers:

```bash
node scripts/ops/integration-k3wise-live-poc-preflight.mjs \
  --input /tmp/k3wise-live-gate.json \
  --out-dir artifacts/integration-live-poc/customer-test
```

The preflight packet does not call PLM or K3. It only validates that the execution package stays non-production, Save-only, and free of committed secrets.

PLM source example:

```json
{
  "name": "customer-plm-test",
  "type": "plm:yuantus-wrapper",
  "tenantId": "tenant-test",
  "workspaceId": "workspace-test",
  "config": {
    "baseUrl": "https://plm.example.test",
    "defaultProductId": "PRODUCT-TEST-001",
    "pageSize": 50
  },
  "credentials": {
    "username": "<redacted>",
    "password": "<redacted>"
  }
}
```

K3 WISE target example:

```json
{
  "name": "k3-wise-test",
  "type": "erp:k3-wise-webapi",
  "tenantId": "tenant-test",
  "workspaceId": "workspace-test",
  "config": {
    "baseUrl": "https://k3.example.test/K3API",
    "loginPath": "/login",
    "materialSavePath": "/material/save",
    "bomSavePath": "/bom/save",
    "autoSubmit": false,
    "autoAudit": false,
    "timeoutMs": 30000
  },
  "credentials": {
    "username": "<redacted>",
    "password": "<redacted>",
    "acctId": "<test-acct-id>"
  }
}
```

SQL Server read-only channel example:

```json
{
  "name": "k3-wise-sql-readonly",
  "type": "erp:k3-wise-sqlserver",
  "tenantId": "tenant-test",
  "workspaceId": "workspace-test",
  "config": {
    "server": "10.0.0.10",
    "database": "AIS_TEST",
    "mode": "readonly",
    "allowedTables": ["t_ICItem", "t_MeasureUnit"]
  },
  "credentials": {
    "username": "<redacted>",
    "password": "<redacted>"
  }
}
```

## 6. Pipeline Design

Material pipeline:

```json
{
  "name": "plm-material-to-k3-wise-test",
  "mode": "manual",
  "sourceSystem": "customer-plm-test",
  "targetSystem": "k3-wise-test",
  "objectType": "material",
  "batchSize": 10,
  "dryRunFirst": true,
  "options": {
    "writeMode": "saveOnly",
    "advanceWatermarkOnPartialFailure": false
  }
}
```

Required material transforms:

- `trim` and `upper` for material code.
- `dictMap` for unit, material group, and ERP classification.
- `defaultValue` for customer-approved defaults.
- `toNumber` for numeric quantity or weight fields.
- `toDate` only where the customer provides a stable source format.

Required validations:

- Material code is required and matches the K3 naming rule.
- Material name is required.
- Unit exists in the approved K3 unit dictionary.
- Material group exists in the approved K3 group dictionary.
- Idempotency key is stable: source system, object type, source id, revision, target system.
- Save-only response must include a K3 business status or diagnostic error.

BOM pipeline:

- Run only after material Save-only succeeds.
- `productId` must come from PLM external system `config.defaultProductId` or from direct adapter `filters.productId`.
- Do not use legacy `pipeline.options.source.productId`.
- Start with one parent item and one or two child rows.

## 7. Execution Phases

1. Gate intake
   - Archive customer answers and sample payloads.
   - Confirm test account and rollback owner.

2. Connectivity smoke
   - Run `testConnection` for PLM and K3 WISE WebAPI.
   - Run SQL Server test only if the customer approved the channel.

3. Staging installation
   - Create or verify integration staging sheets.
   - Confirm required fields and ERP feedback fields exist.

4. Material dry-run
   - Read 1-3 PLM material records.
   - Run mapping, transform, validation, and preview.
   - Confirm no K3 write occurs.

5. Material Save-only live run
   - Write 1-3 test material records to K3 WISE test account.
   - Keep `autoSubmit=false` and `autoAudit=false`.
   - Capture K3 response and ERP feedback.

6. Failure and replay validation
   - Intentionally fail one validation or dictionary mapping.
   - Confirm dead letter, run log, and no watermark advance for failed rows.
   - Fix mapping and replay.

7. Simple BOM PoC
   - Run one parent and one or two children.
   - Confirm K3 response and feedback.

8. Evidence package
   - Produce the verification MD with redacted request/response IDs, run IDs, K3 bill numbers, screenshots if available, and residual gaps.

## 8. Safety Guardrails

- Use test account only.
- Default to Save-only.
- Keep Submit/Audit disabled unless the customer explicitly approves it in writing.
- Never log plaintext credentials.
- Never return plaintext credentials from REST APIs.
- Redact tokens, passwords, session IDs, and SQL Server usernames in evidence.
- Keep dead-letter payload access admin-only.
- Do not advance watermark on partial failure.
- Prefer middle database or API write paths over direct K3 table writes.
- Keep rollback steps documented before the first live write.

## 9. Acceptance Criteria

The live PoC passes only if all items below are true:

- PLM `testConnection` passes against the customer-approved test source.
- K3 WISE WebAPI `testConnection` passes against the test account.
- Material dry-run cleans and validates at least one real PLM row without writing to K3.
- Save-only writes 1-3 material rows to the K3 WISE test account.
- ERP feedback is written back with sync status, K3 external id or bill number when available, response code, response message, and sync timestamp.
- A controlled failure enters dead letter and can be replayed after correction.
- Watermark does not advance for failed rows.
- Simple BOM PoC succeeds or produces a documented K3 business error that can be converted into an adapter hardening task.
- Customer evidence owner confirms the K3 test-account result.

## 10. Rollback

Before live write:

- Record the exact PLM source IDs and intended K3 material codes.
- Confirm the K3 test-account cleanup owner.
- Confirm whether test records should be deleted, disabled, or left as audit samples.

After live write:

- Export run log and K3 response.
- Mark test records in K3 according to the customer rollback SOP.
- Reset or document the watermark if the test must be repeated.
- Keep dead-letter rows for audit unless the customer requests cleanup.

## 11. Follow-Up Rules

- If connectivity fails, do not change pipeline behavior first. Fix network, auth, version, or endpoint mismatch.
- If K3 rejects payload shape, add adapter hardening in M2-LIVE-PR2.
- If field mapping is incomplete, update mapping and dictionaries before retrying.
- If Save-only succeeds, M3 UI can begin. If Save-only does not succeed, M3 UI remains blocked.
