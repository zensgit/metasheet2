# DF-T3a — reference-mapping sheet template manifest (schema-only, latent) — development verification (2026-05-29)

> Slice in the DF-T (template-composition) line. Implements the **manifest** layer of the DF-T3
> design ([#2036](docs/development/data-factory-df-t3-reference-mapping-sheet-templates-design-20260529.md)).
> **Latent contract** — mirrors the DF-T1A / DF-T2a pattern: a pure module + tests, wired to no
> route, no runtime, no resolver, no multitable write.

## Locked scope (very narrow — owner-set)

In:
- Built-in **schema-only** reference-mapping sheet templates covering **every** reference field in the
  K3 Material customer profile — **5 BY_NUMBER** (`unit`, `unit-group`, `account`, `warehouse`,
  `manager`; identifier **FNumber**) + **7 BY_ID** (`category`, `use-state`, `track`,
  `planning-strategy`, `order-strategy`, `inspection-level`, `inspection-mode`; identifier **FID**) =
  **12 templates**.
- A strict **normalizer** (`normalizeReferenceMappingTemplate`) that validates a manifest and
  **fails closed** on customer content / secret-shaped names / bad identifier·completeness / missing
  required column.
- A pure **create-from-template** builder (`buildSheetStructureFromTemplate`) that returns the empty
  sheet's **structure descriptor** (columns only, `rows: []`).

Explicitly **out** (each a later, separately-gated opt-in):
- ❌ No resolver / lookup (DF-T3b — byte-parity-gated, its own opt-in).
- ❌ No change to `from_reference_table` runtime, the Save body, or any K3 write.
- ❌ No real multitable sheet is provisioned — `buildSheetStructureFromTemplate` returns a **descriptor
  only**; it performs no multitable write. Actual sheet creation is a later runtime slice.
- ❌ No route, no frontend, no OpenAPI surface (latent, like T2a).
- ❌ No customer rows/values anywhere.

## What shipped

- `plugins/plugin-integration-core/lib/reference-mapping-templates.cjs` (new):
  - `K3_REFERENCE_MAPPING_TEMPLATES` — 12 frozen built-in templates, each self-validating at module load.
  - `normalizeReferenceMappingTemplate(input)` → normalized `{ id, domain, identifier, completeness,
    columns[, label] }` via an **allow-list projection** (the real safety net — see below).
  - `buildSheetStructureFromTemplate(template)` → `{ domain, identifier, completeness, columns, rows: [] }`.
  - `ReferenceMappingTemplateError`, `REFERENCE_MAPPING_IDENTIFIERS`, `COLUMN_TYPES`, `__internals`.
- `plugins/plugin-integration-core/__tests__/reference-mapping-templates.test.cjs` (new).
- `plugins/plugin-integration-core/package.json`: added to the `test` chain (after
  `connector-template-derive`) + a `test:reference-mapping-templates` script.

## Column / identifier vocabulary — grounded, not asserted

Columns match the design doc JSON example byte-for-byte: `sourceCode` (text, required, **key**) ·
`fNumber`|`fID` (text, required) · `fName` (text, required) · `enabled` (checkbox) · `notes` (text).

Per-domain identifier is grounded against the **actual K3 Material field reference definitions** in
`lib/adapters/k3-wise-document-templates.cjs` (rule at its line 173: *numbered base data →
`{FNumber,FName}`; enum/category → `{FID,FName}`*):

| Domain | Backing K3 field(s) | `reference` const | identifier | completeness |
|---|---|---|---|---|
| unit / unit-group | `FUnitID`, `FSaleUnitID`, `FStoreUnitID`, `FUnitGroupID` | `K3_REFERENCE_BY_NUMBER` | FNumber | require-fnumber-fname |
| account | `FAcctID`, `FSaleAcctID`, `FCostAcctID` | `K3_REFERENCE_BY_NUMBER` | FNumber | require-fnumber-fname |
| warehouse | `FDefaultLoc` | `K3_REFERENCE_BY_NUMBER` | FNumber | require-fnumber-fname |
| manager | `FDSManagerID` | `K3_REFERENCE_BY_NUMBER` | FNumber | require-fnumber-fname |
| category | `FErpClsID` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |
| use-state | `FUseState` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |
| track | `FTrack` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |
| planning-strategy | `FPlanTrategy` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |
| order-strategy | `FOrderTrategy` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |
| inspection-level | `FInspectionLevel` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |
| inspection-mode | `FProChkMde`, `FWWChkMde`, `FSOChkMde`, `FWthDrwChkMde`, `FStkChkMde`, `FOtherChkMde` | `K3_REFERENCE_BY_ID` | FID | require-fid-fname |

The built-in set is **the full customer-profile reference coverage** — every `K3_REFERENCE_BY_NUMBER`
and `K3_REFERENCE_BY_ID` field in `k3-wise-document-templates.cjs` (lines 200–226) has a domain sheet.
This **deliberately goes beyond** the design's prose line-64 list (`unit / unit-group / account /
warehouse / manager / category`), which under-named the BY_ID family the design's own domain table
(§ line 31) calls out (use-state, track, planning/order strategy, inspection levels & modes). Shipping
them now keeps T3b from discovering "category works, but half the customer-profile BY_ID fields have no
domain sheet." The six `FxxChkMde` context fields (production/outsourcing/sales/receipt/stock/other
inspection mode) share **one** `inspection-mode` dictionary — they are the same K3 inspection-method
enum applied in different contexts, so one mapping sheet, not six.

The precise *material-field → domain-sheet* binding (which field reads which sheet, incl. the six
`FxxChkMde` → `inspection-mode` fan-in) is a **T3b resolver** concern, not pinned here — this slice only
fixes the per-domain identifier/completeness.

## Safety properties

- **No customer content can ride in.** Two layers: (1) the normalizer **rejects** any of
  `rows`/`records`/`data`/`values`/`content` on the manifest and any column carrying a `value`/`default`;
  (2) more fundamentally, output is an **allow-list projection** — only `{id,domain,identifier,
  completeness,columns,label}` survive, so *any* unanticipated key (incl. a capital-`Data:` envelope
  that the lowercase reject-list would miss) is silently dropped. The guarantee rests on the whitelist,
  not on enumerating every bad key name.
- **Schema-only column names** — a secret-shaped column name is rejected (shared `scrubSecretStringValue`).
- **Fail-closed** on bad identifier (must be `FNumber`|`FID`), completeness mismatch, missing required
  column, or `sourceCode` not the key.
- **Always zero rows** — `buildSheetStructureFromTemplate` returns `rows: []` unconditionally.

## Tests + negative controls

`node __tests__/reference-mapping-templates.test.cjs` → green. Asserts: 12 built-ins (the full domain
set locked via a sorted `deepEqual` — 5 BY_NUMBER + 7 BY_ID), required columns
present, identifier/completeness mapping (FNumber base data vs FID category), zero rows in structure,
and the reject paths (customer-content keys, column value/default, secret-shaped name, bad
identifier/completeness, missing column, sourceCode-not-key, bad column type), plus the **whitelist
safety net** (a `Data`/`extraJunk` key on input is dropped from both `normalize` and structure output).

Two negative controls (Edit-revert, never `git checkout`):
1. Disabled the `FORBIDDEN_CONTENT_KEYS` loop → the content-key reject assertions failed (expected throw,
   got none) → restored.
2. Made `normalize` spread `...input` into output → the whitelist assertion failed with its exact
   message (`normalize whitelists output (drops unanticipated keys)`) → restored.

Siblings unaffected: `connector-template-derive`, `connector-action-contracts`, `payload-redaction` green.

## Next (gated, separate opt-in)

- **DF-T3b** — the resolver runtime (bulk-read the mapping sheet, in-app `sourceCode` index, compose
  the full reference object through the existing `applyReferenceShape`, fail-closed on 0/2+ rows). Per
  the design this is **byte-parity-gated** and its own explicit opt-in. Not started.
- DF-T3c — manifest import/export.
