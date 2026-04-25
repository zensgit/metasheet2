# Integration Core K3 WISE Live PoC Preflight Design - 2026-04-25

## Objective

Add a local preflight packet generator for M2 live PoC.

The generator turns a customer GATE answer JSON into a redacted execution packet for a K3 WISE test-account PoC. It does not call PLM, K3, SQL Server, or MetaSheet APIs. Its job is to catch unsafe live-test inputs before an operator creates external systems or pipelines.

## New Files

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`

The existing live PoC docs remain the operator runbook:

- `docs/development/integration-core-k3wise-live-poc-design-20260425.md`
- `docs/development/integration-core-k3wise-live-poc-verification-20260425.md`

## Input Contract

The input is a JSON object with these required sections:

- `tenantId`
- `workspaceId`
- `k3Wise`
- `plm`
- `rollback`
- `fieldMappings.material`

Required K3 WISE values:

- `k3Wise.version`
- `k3Wise.apiUrl`
- `k3Wise.acctId`
- `k3Wise.environment`

Required PLM values:

- `plm.readMethod`
- optional `plm.defaultProductId` or `plm.config.defaultProductId` for BOM PoC

Required rollback values:

- `rollback.owner`
- `rollback.strategy`

## Safety Rules

The preflight fails fast when:

- `k3Wise.environment` is not a non-production value: `test`, `testing`, `uat`, `sandbox`, `staging`, `dev`, or `development`.
- `k3Wise.autoSubmit` or `k3Wise.autoAudit` is `true`.
- SQL Server channel is configured to write K3 core business tables such as `t_ICItem`, `t_ICBOM`, or `t_ICBomChild`.
- BOM PoC is enabled but no `bom.productId`, `plm.defaultProductId`, or `plm.config.defaultProductId` is provided.
- `fieldMappings.material` is empty.

The generated packet always sets K3 target options to Save-only:

```json
{
  "autoSubmit": false,
  "autoAudit": false,
  "writeMode": "saveOnly"
}
```

## Output Contract

The CLI writes two files:

- `integration-k3wise-live-poc-packet.json`
- `integration-k3wise-live-poc-packet.md`

The JSON packet contains:

- redacted GATE summary;
- external system payload drafts;
- material and optional BOM pipeline drafts;
- safety flags;
- operator checklist.

The Markdown packet is a human-reviewable summary for the live PoC evidence folder.

## Secret Handling

The generator scans input keys matching password, secret, token, session, credential, API key, or authorization. Generated output must not contain those values. Credential fields are replaced with `<set-at-runtime>` and `requiredCredentialKeys`.

This protects PRs and evidence docs from accidentally committing customer credentials.

## Operator Flow

1. Collect the customer GATE answers outside Git.
2. Save them as a local JSON file, for example `/tmp/k3wise-live-gate.json`.
3. Run:

   ```bash
   node scripts/ops/integration-k3wise-live-poc-preflight.mjs \
     --input /tmp/k3wise-live-gate.json \
     --out-dir artifacts/integration-live-poc/customer-test
   ```

4. Review the generated packet.
5. Use the packet to create external systems and pipelines in MetaSheet.
6. Execute the live PoC checklist from the verification document.

## Sample Input

Generate a template with:

```bash
node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample
```

The sample is intentionally non-production and keeps credentials as placeholders.

## Non-Goals

- No real PLM/K3 connectivity.
- No database migration.
- No new integration-core runtime feature.
- No M3 UI.
- No production write support.
