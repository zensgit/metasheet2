# K3 WISE relationship mapping customer sample manifest

## Purpose

Use this manifest to collect the minimum redacted customer evidence needed
before implementing PLM/K3 BOM relationship mapping runtime for #1526. Do not
include real credentials, tokens, authority codes, SQL connection strings,
server passwords, or private network secrets.

## Questions to answer

| ID | Required answer |
| --- | --- |
| R1 | Is the PLM BOM response flat lines, a tree, or both? |
| R2 | Are PLM `parentCode` and `childCode` already K3 WISE material `FNumber` values? |
| R3 | Which fields uniquely identify one BOM relationship line? |
| R4 | Does K3 BOM Save expect one line per request or a header body with `FChildItems[]`? |
| R5 | If one child material is unresolved, should MetaSheet dead-letter only that row or block the whole parent BOM? |
| R6 | Are unit, sequence, effectivity, or revision mandatory in the customer's K3 BOM setup? |
| R7 | Must material Save-only be confirmed before BOM Save-only can run? |

## Redacted sample case A - flat PLM BOM lines

Provide 2-3 rows. Replace real IDs with stable fake values that preserve shape.

```json
{
  "case": "flat-bom-lines",
  "records": [
    {
      "sourceId": "plm-bom-line-001",
      "parentId": "plm-parent-001",
      "parentCode": "FG-001",
      "childId": "plm-child-001",
      "childCode": "MAT-001",
      "quantity": 2,
      "uom": "PCS",
      "sequence": 1,
      "revision": "A"
    },
    {
      "sourceId": "plm-bom-line-002",
      "parentId": "plm-parent-001",
      "parentCode": "FG-001",
      "childId": "plm-child-002",
      "childCode": "MAT-002",
      "quantity": 4,
      "uom": "PCS",
      "sequence": 2,
      "revision": "A"
    }
  ]
}
```

## Redacted sample case B - tree PLM BOM

Only include the smallest tree that preserves parent/child nesting.

```json
{
  "case": "tree-bom",
  "root": {
    "id": "plm-parent-001",
    "code": "FG-001",
    "revision": "A",
    "children": [
      {
        "id": "plm-child-001",
        "code": "MAT-001",
        "quantity": 2,
        "uom": "PCS",
        "sequence": 1
      }
    ]
  }
}
```

## Redacted sample case C - unresolved material reference

Show exactly how a missing, obsolete, or not-yet-created child material appears.

```json
{
  "case": "unresolved-child-material",
  "record": {
    "sourceId": "plm-bom-line-003",
    "parentCode": "FG-001",
    "childCode": "MAT-NOT-IN-K3",
    "quantity": 1,
    "uom": "PCS",
    "sequence": 3,
    "revision": "A"
  },
  "expectedCustomerPolicy": "dead-letter-row"
}
```

## Redacted sample case D - K3 BOM Save body shape

Provide the shape only. Do not include real K3 session/token values.

Option 1 - flat line:

```json
{
  "Data": {
    "FParentItemNumber": "FG-001",
    "FChildItemNumber": "MAT-001",
    "FQty": 2,
    "FUnitID": "Pcs",
    "FEntryID": 1
  }
}
```

Option 2 - header with child array:

```json
{
  "Data": {
    "FParentItemNumber": "FG-001",
    "FChildItems": [
      {
        "FItemNumber": "MAT-001",
        "FQty": 2,
        "FUnitID": "Pcs",
        "FEntryID": 1
      }
    ]
  }
}
```

Mark which option is accepted by the customer's K3 WISE WebAPI. If neither is
correct, provide the smallest redacted accepted body.

## Do not include

- K3 token, session id, authority code, or cookie.
- SQL Server host, database password, JDBC URL, or raw connection string.
- Private IPs if the customer considers them sensitive.
- Real supplier/customer/product names unless already approved for sharing.

## Acceptance before runtime implementation

Runtime work should start only when:

- R1-R7 are answered;
- cases A-D are present and redacted;
- K3 live policy still says Save-only, no Submit/Audit;
- unresolved relationship policy is explicit;
- the accepted K3 BOM body shape is confirmed.

## Machine check before runtime

After the customer returns R1-R7 and cases A-D, include those relationship files
in the same local GATE contract packet used for WebAPI read/list. If the packet
does not exist yet, initialize it outside Git first:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --init-template /path/outside-git/k3wise-gate-contract
```

Then replace the relationship placeholders and the four relationship sample
files with redacted customer-approved evidence. When the packet is filled, run:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --input /path/outside-git/k3wise-gate-contract/k3wise-gate-contract-packet.template.json \
  --out-dir artifacts/integration-k3wise/gate-contract-check
```

The checker must return `PASS` before relationship resolver runtime work starts.
It verifies that R1-R7 are answered, the sample shapes are parseable, the K3 BOM
body shape is explicit, and no token/password/connection-string shaped values
were included. It is a pre-runtime evidence gate only; it does not contact K3
WISE and does not enable Save/Submit/Audit.
