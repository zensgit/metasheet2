# Data Factory issue #1526 GATE contract checker design - 2026-05-18

## Purpose

#1526 still has three real runtime tracks: K3 WISE WebAPI read/list, SQL
read-only sample preview, and relationship resolver runtime. The first and third
are already narrowed into GATE-front contracts, but until now the customer
answers were only described in Markdown.

This slice adds a machine-checkable intake gate for those contracts. It lets the
operator answer a concrete question before touching `plugin-integration-core`:

> Did the customer return enough redacted evidence to start the post-GATE
> runtime PR without guessing?

## Scope

Added:

- `scripts/ops/integration-k3wise-gate-contract-check.mjs`
- `scripts/ops/integration-k3wise-gate-contract-check.test.mjs`
- `verify:integration-k3wise:gate-contract`
- a short machine-check section in the WebAPI read/list customer manifest
- a short machine-check section in the relationship mapping customer manifest

Not changed:

- no `plugins/plugin-integration-core`
- no DB migration
- no backend route/API
- no frontend runtime
- no K3 WISE network call
- no Save/Submit/Audit behavior

## Packet model

The checker accepts one local JSON packet outside Git:

```jsonc
{
  "webapiReadList": {
    "answers": {
      "O1-MAT": "/K3API/Material/List",
      "O1-MAT-M": "POST",
      "O1-BOM": "/K3API/BOM/List",
      "O1-BOM-M": "POST",
      "O2-P": "PageIndex/PageSize",
      "O2-T": "Total",
      "O2-C": "100",
      "O3-F": "number, modifiedSince",
      "O3-M": "ModifiedSince",
      "O4-MAT": "FNumber,FName,FModel,FBaseUnitID",
      "O4-BOM": "FParentItemNumber,FChildItemNumber,FQty,FUnitID,FEntryID",
      "O6": "same token as Save"
    },
    "samples": {
      "materialList": "sample-material-list.redacted.json",
      "materialDetail": "sample-material-detail.redacted.json",
      "bomList": "sample-bom-list.redacted.json",
      "bomDetail": "sample-bom-detail.redacted.json"
    }
  },
  "relationshipMapping": {
    "answers": {
      "R1": "flat lines",
      "R2": "yes",
      "R3": "parentCode + childCode + sequence",
      "R4": "header with FChildItems[]",
      "R5": "dead-letter-row",
      "R6": "unit and sequence are mandatory",
      "R7": "yes"
    },
    "samples": {
      "flatBomLines": "relationship-flat-bom-lines.redacted.json",
      "treeBom": "relationship-tree-bom.redacted.json",
      "unresolvedChild": "relationship-unresolved-child.redacted.json",
      "k3BomSaveShape": "relationship-k3-bom-save-shape.redacted.json"
    }
  }
}
```

Sample paths are resolved relative to the packet file. This keeps the customer
answer bundle portable between the bridge machine, a developer laptop, and CI
artifact folders without committing customer evidence.

## Decisions

### Exit codes

| Exit | Decision | Meaning |
| --- | --- | --- |
| `0` | `PASS` | Required answers and sample shapes are present; no secret-shaped values were found. |
| `1` | `FAIL` | Safety violation or malformed unsafe input, such as absolute endpoint URL or secret-shaped sample value. |
| `2` | `GATE_BLOCKED` | Customer packet is incomplete, missing sample files, or sample shape is insufficient. |

This mirrors existing K3 preflight behavior: incomplete customer input is not a
product regression, but it still blocks runtime work.

### WebAPI read/list checks

The checker validates:

- all O1-O6 answer IDs are present;
- Material/BOM methods are `GET` or `POST`;
- read/list endpoints are relative paths, not absolute URLs;
- endpoint paths do not contain secret-looking query parameters;
- four redacted sample files exist and parse;
- Material samples contain at least one material-like number/name row;
- BOM samples contain parent, child, and quantity information.

It does not assert a final K3 envelope. That remains the runtime PR's job after
O1-O6 are confirmed.

### Relationship mapping checks

The checker validates:

- all R1-R7 answers are present;
- flat BOM sample contains `records[]` with `parentCode`, `childCode`, and
  `quantity`;
- tree BOM sample contains `root.children[]`;
- unresolved child sample contains `record` and `expectedCustomerPolicy`;
- K3 BOM Save body shape contains `Data` and is either flat or
  `Data.FChildItems[]`.

### Secret hygiene

The checker recursively scans answers and sample files for:

- JWT/Bearer-shaped values,
- credentialed database URLs,
- secret-looking URL query parameters,
- secret-looking keys such as `password`, `token`, `api_key`, `session_id`,
  `sign`, or `authorization` with non-redacted values.

Reports intentionally include issue IDs and generic messages, not raw sample
values. Evidence can therefore be shared internally without leaking the exact
string that triggered a failure.

## Stage 1 Lock

This is allowed under the Stage 1 Lock because it is an ops/documentation gate.
It makes future runtime work safer but does not implement runtime behavior.

Runtime remains blocked until:

- customer GATE is PASS;
- this checker returns `PASS` for O1-O6/R1-R7 evidence;
- the operator explicitly starts a post-GATE runtime PR.
