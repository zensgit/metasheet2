# Data Factory issue #1526 relationship mapping GATE-front contract - design - 2026-05-17

## Status

GATE-front design only. **No runtime implemented in this PR.**

This document covers #1526 finding #3: relationship mapping and unresolved-link
handling for the PLM -> multitable cleansing -> K3 WISE BOM path. The purpose is
to lock the post-GATE contract before touching `plugins/plugin-integration-core`.

## Why this slice is docs-only

The K3 PoC Stage 1 Lock is still in force. Runtime relationship handling would
touch the integration plugin's PLM source adapter, transform/pipeline behavior,
or K3 BOM target path. That should not happen until customer GATE evidence
answers the relationship-shape questions below.

This slice therefore does three low-risk things:

1. ground the current code shape;
2. define the customer questions and redacted sample cases needed before
   implementation;
3. define post-GATE acceptance criteria so the eventual runtime PR is
   mechanical rather than speculative.

## Current code shape

### PLM source side

`plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs` already
normalizes BOM reads to line-shaped records:

| Field | Current meaning |
| --- | --- |
| `sourceId` | PLM BOM line id or synthesized `parentCode:childCode` |
| `parentId` | PLM parent material id, optional |
| `parentCode` | required parent material code |
| `childId` | PLM child material id, optional |
| `childCode` | required child material code |
| `quantity` | required numeric quantity |
| `uom` | optional unit |
| `sequence` | optional line sequence |
| `revision` | optional revision |
| `updatedAt` | optional timestamp |

The wrapper accepts both flat BOM lines and tree-style BOM payloads, then
flattens tree payloads before normalizing records.

### Multitable cleansing side

`plugins/plugin-integration-core/lib/staging-installer.cjs` provisions
`bom_cleanse` with these user-facing fields:

```text
parentCode, childCode, quantity, uom, sequence, revision,
validFrom, validTo, status
```

There is currently no explicit `parentId`, `childId`, `parentResolved`,
`childResolved`, `relationshipStatus`, or `relationshipError` field in the
cleansing table. This is acceptable for material+BOM v1 only if customer data
already carries K3-ready material codes.

### K3 target side

The backend K3 WISE BOM document template currently emits flat target fields:

```text
FParentItemNumber, FChildItemNumber, FQty, FUnitID, FEntryID
```

The K3 setup GATE draft helper has also used an array-shaped draft mapping:

```text
FChildItems[].FItemNumber, FChildItems[].FQty
```

That means the actual K3 BOM Save body shape must be confirmed before runtime:
flat-line payload and header-with-child-array payload are not interchangeable.

## Relationship contract to confirm before runtime

| ID | Customer/vendor question | Why it blocks |
| --- | --- | --- |
| R1 | Is the PLM BOM source flat lines, a tree, or both? | Determines whether the source adapter should flatten tree nodes or preserve hierarchy metadata. |
| R2 | Are `parentCode` and `childCode` already the K3 WISE material `FNumber` values? | If yes, BOM mapping can stay code-based. If no, a material-code lookup/alias table is required before BOM write. |
| R3 | Which fields uniquely identify a BOM relationship line? | Idempotency currently uses `sourceId + revision`; customer may require parent/child/sequence/effectivity instead. |
| R4 | Does K3 BOM Save expect one line per request or a header body with `FChildItems[]`? | The current backend template is flat; the GATE draft showed array-shaped child items. Runtime must choose one confirmed shape. |
| R5 | What is the required failure policy for unresolved parent/child materials? | We need to know whether to dead-letter only the row or block the whole parent BOM. |
| R6 | Are units, sequence, valid-from/to, and revision required by the customer's K3 BOM setup? | Optional fields in MetaSheet may be mandatory in the customer's K3 customization. |
| R7 | Should BOM lines be written only after material Save-only confirms parent and child material existence? | Prevents writing BOM rows that K3 rejects due to missing material references. |

These questions are mirrored in the customer sample manifest:
`docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md`.

## Proposed post-GATE runtime design

### Data model

No new database table is required for the first runtime PR. Use existing JSON
surfaces:

- pipeline `fieldMappings` for source -> target field mapping;
- pipeline `options.relationships` for relationship policy;
- dead letters for unresolved parent/child/material relationship failures.

Candidate `options.relationships` shape:

```jsonc
{
  "bom": {
    "identity": ["sourceId", "revision"],
    "parentCodeField": "parentCode",
    "childCodeField": "childCode",
    "requireKnownMaterials": true,
    "onUnresolved": "dead-letter-row",
    "k3BodyShape": "flat-line" // or "child-array", customer-confirmed
  }
}
```

This stays inside existing pipeline JSON and avoids migration work.

### Resolution behavior

Post-GATE runtime should classify relationship failures with dedicated codes:

| Condition | Proposed code | Behavior |
| --- | --- | --- |
| missing `parentCode` | `RELATIONSHIP_PARENT_MISSING` | dead letter; do not write row |
| missing `childCode` | `RELATIONSHIP_CHILD_MISSING` | dead letter; do not write row |
| parent material not found in staging/K3-read cache | `RELATIONSHIP_PARENT_UNRESOLVED` | dead letter or block parent BOM per R5 |
| child material not found in staging/K3-read cache | `RELATIONSHIP_CHILD_UNRESOLVED` | dead letter or block parent BOM per R5 |
| unsupported K3 BOM body shape | `RELATIONSHIP_BOM_SHAPE_UNCONFIRMED` | fail fast before write |
| duplicate relationship identity | `RELATIONSHIP_DUPLICATE_IDENTITY` | dead letter duplicate row |

These errors must not be reported as generic transform errors or K3 Save
failures. If K3 rejects a confirmed, resolved BOM payload, that remains a K3
write error. If MetaSheet cannot resolve the relationship before Save, it is a
relationship error.

### Transform boundary

The existing transform engine only supports fixed functions and no user
JavaScript. Relationship resolution should preserve that boundary:

- allowed transforms remain fixed (`trim`, `upper`, `toNumber`, `dictMap`, etc.);
- no user-provided JavaScript;
- no raw SQL;
- no ad-hoc network lookup from transform expressions.

Relationship lookup belongs in pipeline/runtime policy, not inside a transform
function.

### Write safety

Default remains Save-only. Submit/Audit must not be enabled by relationship
resolution. Runtime order should be:

1. read/prepare material rows;
2. dry-run relationship resolution;
3. dead-letter unresolved links;
4. preview K3 BOM payload;
5. Save-only only when all required relationship policy checks pass.

## Post-GATE implementation plan

1. Add customer-confirmed `options.relationships.bom` policy parsing in the
   pipeline runner or a small helper module.
2. Add a relationship resolver that can work from cleaned staging material rows
   first; optionally use K3 read/list only after that runtime is implemented.
3. Add dead-letter codes listed above.
4. Add tests for:
   - resolved parent/child codes;
   - missing parent/child code;
   - unknown parent/child material;
   - duplicate line identity;
   - flat-line vs child-array body-shape guard.
5. Update the Workbench/K3 setup page only after the backend policy is stable,
   so the UI does not promise a relationship mode the runner cannot enforce.

## Explicit non-goals

- No runtime code in this PR.
- No K3 live write.
- No Submit/Audit change.
- No SQL executor.
- No WebAPI read/list implementation.
- No migration.
- No package change.
- No customer secret, K3 token, authority code, SQL connection string, or
  bearer token in docs or fixtures.

## Recommendation

Leave #1526 open after this PR. Once this docs-only contract lands, the issue's
remaining runtime items are explicitly:

- K3 WebAPI read/list runtime after customer O1-O6 answers;
- SQL executor wiring on the bridge machine;
- relationship resolver runtime after customer R1-R7 answers.
