# Data Factory issue #1526 relationship mapping GATE-front contract - verification - 2026-05-17

Companion to
`data-factory-issue1526-relationship-gate-contract-design-20260517.md`.

## Verification matrix

| Check | Evidence | Result |
| --- | --- | --- |
| Stage 1 Lock held | PR adds documentation only; no `plugins/plugin-integration-core`, migration, route, API, adapter, pipeline-runner, or frontend runtime changes. | PASS |
| Current PLM BOM source fields grounded | Static inspection of `plm-yuantus-wrapper.cjs` confirms normalized BOM line fields include `sourceId`, `parentCode`, `childCode`, `quantity`, `uom`, `sequence`, `revision`, and optional IDs. | PASS |
| Current staging fields grounded | Static inspection of `staging-installer.cjs` confirms `bom_cleanse` fields and absence of explicit relationship-resolution fields. | PASS |
| Current K3 BOM target fields grounded | Static inspection of `k3-wise-document-templates.cjs` confirms flat BOM target fields `FParentItemNumber`, `FChildItemNumber`, `FQty`, `FUnitID`, `FEntryID`. | PASS |
| Existing transform guardrail preserved | Static inspection of `transform-engine.cjs` confirms fixed transform list and no user JavaScript execution. | PASS |
| Customer blockers enumerated | Design doc defines R1-R7 and operations manifest gives sample cases required before runtime. | PASS |
| Runtime acceptance path defined | Design doc defines relationship-specific error codes and post-GATE test categories. | PASS |
| Secret hygiene | New docs use placeholders only; no customer token, authority code, bearer header, password, JDBC URL, or SQL connection string. | PASS |

## Static inspection commands

```bash
rg -n "bom|BOM|relationship|unresolved|parentCode|childCode|FParent|FChild|FEntryID|FQty|standard_materials|bom_cleanse" \
  plugins/plugin-integration-core/lib \
  plugins/plugin-integration-core/__tests__ \
  apps/web/src/services/integration \
  apps/web/src/views/IntegrationWorkbenchView.vue \
  -S

nl -ba plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs | sed -n '1,180p'
nl -ba plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs | sed -n '1,230p;340,430p'
nl -ba plugins/plugin-integration-core/lib/staging-installer.cjs | sed -n '1,120p'
nl -ba plugins/plugin-integration-core/lib/transform-engine.cjs | sed -n '1,235p'
```

## Local regression commands

This PR is docs-only, but the following existing tests cover the code surfaces
that the contract is grounded in:

```bash
node plugins/plugin-integration-core/__tests__/transform-validator.test.cjs
node plugins/plugin-integration-core/__tests__/plm-yuantus-wrapper.test.cjs
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
git diff --check origin/main...HEAD
```

## Secret-shape check

```bash
rg -n "AdminPass|eyJ[A-Za-z0-9_-]+\\.|Bearer [A-Za-z0-9_-]{20,}|authorityCode\\s*[:=]|access_token\\s*[:=]|postgres://[^[:space:]]+:[^[:space:]@]+@" \
  docs/development/data-factory-issue1526-relationship-gate-contract-design-20260517.md \
  docs/development/data-factory-issue1526-relationship-gate-contract-verification-20260517.md \
  docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md \
  | rg -v "^docs/development/data-factory-issue1526-relationship-gate-contract-verification-20260517\\.md:[0-9]+:rg -n "
```

Expected result: no matches after filtering the command-line self-reference.

## PR result

Fill this section before opening the PR:

| Command | Result |
| --- | --- |
| `node plugins/plugin-integration-core/__tests__/transform-validator.test.cjs` | PASS |
| `node plugins/plugin-integration-core/__tests__/plm-yuantus-wrapper.test.cjs` | PASS |
| `node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| Secret-shape check | PASS: no matches after filtering the command-line self-reference |

## Post-GATE acceptance matrix

When customer R1-R7 evidence arrives and runtime work is allowed, the eventual
runtime PR should prove:

| Case | Expected behavior |
| --- | --- |
| Resolved flat BOM line | K3 payload preview contains confirmed BOM body shape and relationship identity. |
| Resolved tree BOM payload | Tree is flattened or preserved according to R1; output is deterministic. |
| Missing parent code | dead letter `RELATIONSHIP_PARENT_MISSING`; no K3 write. |
| Missing child code | dead letter `RELATIONSHIP_CHILD_MISSING`; no K3 write. |
| Parent material unresolved | dead letter `RELATIONSHIP_PARENT_UNRESOLVED` or parent-BOM block per R5. |
| Child material unresolved | dead letter `RELATIONSHIP_CHILD_UNRESOLVED` or parent-BOM block per R5. |
| Duplicate identity | dead letter `RELATIONSHIP_DUPLICATE_IDENTITY`. |
| Unconfirmed K3 body shape | fail fast with `RELATIONSHIP_BOM_SHAPE_UNCONFIRMED`; no K3 write. |

## Issue #1526 status after this PR

This PR does not close #1526. It narrows finding #3 into a GATE-blocked runtime
contract, matching the already documented treatment for K3 WebAPI read/list and
SQL executor wiring.
