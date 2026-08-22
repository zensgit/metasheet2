# Factory-A customer-pack install rehearsal

Stacked on `feat/stock-prep-customer-pack-p0` (#5065). Values-free: schema ids, business
column labels and published dictionary samples only — no hosts, no credentials, no tenant data.

## What the rehearsal is

#5065 shipped the contract (`normalizeCustomerPack`) and the installer
(`installCustomerPack`), each with its own unit battery. Neither answers the question a
deployer actually has:

> Does **one config object** regenerate the whole sheet my factory works in — and after
> that, does a PLM refresh still leave my people's cells alone?

`__tests__/stock-preparation-customer-pack-rehearsal.test.cjs` is that question, executed.
It drives the real installer against an in-memory fake of the host multitable provisioning
API, in five acts:

| act | what it proves |
| --- | --- |
| a | the 21-column rehearsal pack normalizes; `preserveOnRefresh` is derived from ownership on every column |
| b | install run #1 on a table already carrying the frozen 25 canonical columns yields **46 logical columns**, each ownership-stamped |
| c | install run #2 creates nothing, destroys nothing, and submits a byte-identical descriptor set, option patch and view descriptor |
| d | **refresh-preservation proof** — a PLM refresh projected through the ownership filter *derived from the installed field properties* leaves all 16 human cells byte-identical; the negative control (same payload, no filter) destroys all 16 |
| e | the whole summary + log stream is values-free, against a denylist proven to bite |

Hermetic: no DB, no network, no clock, no filesystem writes. Dependency-free `node` script,
matching every other suite in the package.

## The 46-column shape

`lib/customer-packs/factory-a.rehearsal.cjs` is a full-shape pack: structurally real
(derived from the real customer sheet's shape), synthetically valued.

| band | canonical (frozen template) | pack `ext_` | total |
| --- | --- | --- | --- |
| `plm_system` — a refresh overwrites | 17 | 13 | **30** |
| `human_preserved` — a refresh must not touch | 8 | 8 | **16** |
| **total** | **25** | **21** | **46** |

Pack `plm_system` (13): `ext_parentDrawingNo` 父组件图号, `ext_parentName` 父组件名称,
`ext_spec` 规格, `ext_nameAndSpec` 名称及规格, `ext_standard` 标准, `ext_designer` 设计者,
`ext_createdSource` 创建来源, `ext_legacyRowId` 旧系统ID, `ext_parentLegacyId` 父级旧ID,
`ext_supplementId` 补充信息ID, `ext_parentSortNo` 父组件排序号 (number),
`ext_componentSortNo` 当前组件排序号 (number), `ext_materialCode` 物料ID (string — see open
decision 1).

Pack `human_preserved` (8): `ext_stockPrepDate` 备料日期 (date), `ext_pickingNode` 领料节点
(select, 6 options), `ext_handoverSection` 交接工段 (select, 15 options), and
`ext_blankLength` / `Width` / `Thickness` / `Quantity` / `Mass` 毛胚长度/宽度/厚度/数量/质量
(number).

Five option sets: the two `ext_` selects plus the three canonical selects. Three role views:
`production` 生产备料视图, `procurement` 采购跟进视图, `warehouse` 仓库跟进视图.

## Findings

**F1 — canonical-field option sets ARE accepted, and the rehearsal uses them.**
`normalizeOptionSets` resolves `fieldId` against the FULL catalog (`buildFieldCatalog`:
template fields + pack fields) and gates only on `target.type !== 'select'`. There is no
`ext_`-only guard. The normalized set carries `fieldSource: 'template' | 'pack'`, and the
installer's `resolveOptionSource` keeps the template's OWN declared `optionSource` for a
canonical column, so an install cannot silently re-label where a canonical dictionary comes
from. The rehearsal therefore ships dictionaries for `materialType` / `blankType` /
`stockPreparationStatus` too — leaving them out would have regenerated a landing sheet whose
材质 / 毛胚类型 / 备料状态 dropdowns are empty, which is not the full shape.
*Deviation from the brief, which anticipated 2 option sets and a "not accepted" finding: the
rehearsal asserts 5 (2 `pack` + 3 `template`).*

**F2 — the #5065 installer mock's property merge is SHALLOW; the real host's is RECURSIVE.**
This is the one finding with teeth. `stock-preparation-customer-pack-installer.test.cjs`
merges `{ ...row.property, ...patch }`, which REPLACES `property.stockPreparation` wholesale —
so in that mock, syncing options onto a select column wipes `ownership`,
`preserveOnRefresh`, `extension` and the pack provenance off it. The real host
(`packages/core-backend/src/multitable/provisioning.ts`, `mergeJsonObject`) recurses, and
`sanitizeFieldProperty` for `select` is a `{ ...obj, options }` passthrough, so the option
stanza lands BESIDE the ownership stanza and the classification survives.

The installer is correct against the real host. But #5065's suites cannot see the
difference, because they assert on the descriptor that was *submitted*, never on the row as
*stored* after the option patch. The rehearsal reads ownership back off the stored row, so
it had to mirror the host's recursive merge — and it now asserts explicitly that the
ownership classification survives an option sync on all five select columns. A mutation
that restores the shallow merge turns the suite red.

**F3 — `preserveOnRefresh` and `ownership` are redundant on a machine-written sheet.**
They agree on all 46 columns, so a guard written as
`ownership !== 'human_preserved' && !preserveOnRefresh` has one clause doing nothing —
until a person edits the sheet. The rehearsal covers the divergent case directly: a column
whose stored `preserveOnRefresh` was pinned true without restating ownership must drop out
of the writable set. Both clauses are now load-bearing under mutation.

**F4 — today's refresh path is safe by OMISSION, not by ownership. — IMPLEMENTED.**
`stock-preparation-conflict-planner.cjs` derived its writable set from the frozen template
(`plmRefreshFieldIds`), so pack `ext_` columns were untouched simply because the template had
never heard of them. That held, but it was not the property anyone wants to rely on: the
moment a refresh becomes pack-aware, safety has to come from ownership. The rehearsal's guard
was deliberately written in the test rather than in `lib/` — a specification, not a shipped
one.

It is now shipped. `derivePackAwarePlmWritableFields({ templateFields,
installedFieldProperties })` in the conflict planner projects both bands from the
`property.stockPreparation` stanza the installer stamped, and the planner and the apply
writer both consume it. A pack column joins the WRITABLE band only on the full triple —
`ownership: 'plm_system'` **and** `extension: true` **and** no `preserveOnRefresh` pin — so an
unstamped, unknown, missing or malformed classification is fail-closed to neither band and
surfaces a values-free reason. The more important half is the other one: an `ext_` human
column now joins the HUMAN band, so `assertNoHumanFields` rejects it **by name** at both the
planner and the writer rather than by its absence from the template. The frozen template still
governs its own 25 columns — an installed property can never re-classify one. The projection
is passed in, never fetched: the planner stays pure, and a caller that supplies nothing gets
the pre-pack writable set byte for byte (pinned by a digest captured from the pre-change
planner, and by eight mutations in
`__tests__/stock-preparation-pack-aware-refresh.test.cjs`). The rehearsal's local guard stays
where it is, now pinned to the production function so the two cannot drift.

*Legacy posture, unchanged and deliberate:* the HTTP dry-run/apply route still supplies no
projection, because nothing can enumerate a sheet's installed columns yet — multitable
provisioning exposes only per-field `getObjectField`, and no pack-installation registry
records which `ext_` ids to ask for. Those routes therefore keep the template-only bands,
which is exactly today's behaviour. `installedFieldProperties` is the seam they plug into once
a pack registry or a fields-listing primitive lands; see Open decisions.

**F5 — installer API friction, for the CLI/HTTP entry point.**
Small, all shape rather than semantics:
- `installCustomerPack` returns `createdFields` / `skippedFields` as flat id arrays with no
  per-field ownership. A CLI that wants to print "13 PLM / 8 human columns added" has to
  re-normalize the pack and re-join. A `fields: [{ id, ownership, created }]` projection
  would make the summary self-describing at no cost to values-freeness.
- Ownership banding for views is all-or-nothing (`hideOwnerships`), which turned out to be
  the wrong tool on this sheet — every role both reads PLM columns and writes human ones, so
  all three rehearsal views hide by NAME. Ownership is the **refresh** boundary; it is not
  the **visibility** boundary. Worth saying out loud before a UI leans on it.
- The canonical target is a precondition (`CUSTOMER_PACK_TARGET_ABSENT`). Correct, but it
  means a CLI needs a two-step flow (ensure canonical → install pack) and should say so in
  its own error text rather than surfacing the plugin code raw.
- There is no dry-run. Everything needed for one exists
  (`summarizeCustomerPackForEvidence` plus the derived `hiddenFieldIds`); a
  `planCustomerPackInstall` that stops before the first host call would let a deployer review
  the 46-column diff before it lands.

## Open decisions

**1. Material dictionary carrier — `ext_materialCode` 物料ID.**
The real dictionary is 203 entries; `MAX_OPTIONS_PER_FIELD` is 200. The column therefore
cannot be a `select` at any pack version — and the cap is the right signal, not an obstacle:
a 203-entry vocabulary is reference data, not field metadata. Patching 203 option literals
onto a field property on every install would also make the pack diff unreadable.

*Recommendation:* a dedicated material dictionary SHEET plus a link field — a table the
customer can maintain, diff and search. Ship v1 as `type: 'string'` (what the rehearsal
does, so the shape stays honest about today), and migrate to the link additively. The pack
contract needs no change for v1; the link migration needs a `link` field type on the pack's
`type` vocabulary, which is a frozen-template change and belongs in its own review.

**2. Satellite-sheet folding.**
`STOCK_PREPARATION_MVP_TABLE_TEMPLATES` carries satellite tables alongside the main table,
while a customer pack targets `plm_stock_preparation_main` only
(`targetObjectId` is hard-derived from the main template). A factory whose sheet spans
satellites cannot express that in one pack today.

*Recommendation:* do not generalize the pack to N objects yet. The one-object constraint is
what makes `assertExtensionFieldIdValid` a single, checkable collision gate against a single
frozen catalog; multi-object packs would need per-object catalogs and a per-object install
plan, and nothing in the factory-A shape needs it. Revisit when a second customer actually
lands columns on a satellite — and if so, prefer a pack *bundle* (a list of single-object
packs sharing a `packId`) over widening the pack itself.

## Verification

```
node __tests__/stock-preparation-customer-pack-rehearsal.test.cjs   OK
node __tests__/stock-preparation-customer-pack.test.cjs             OK
node __tests__/stock-preparation-customer-pack-installer.test.cjs   OK
node __tests__/test-chain-completeness.test.cjs      164 suites, all chained
node __tests__/sealed-export-package-provenance.test.cjs            OK
```

11 targeted mutations were each caught by the new suite: a human column mis-declared as
`plm_system`; the fake's merge reverted to #5065's shallow semantics; the ownership filter
dropped entirely; the `preserveOnRefresh` clause dropped; the negative control neutered; an
option set silently retargeted; the production view banding out the human band it must fill;
id-noise banding dropped from a role view; `extension: true` dropped from the installer's
property; `preserveOnRefresh` authored as a constant in the normalizer; and an IPv4-shaped
string leaked into the install log.

Invariants held: additive-only (no `.ensureObject(` call — #5065's grep still passes, and
this suite additionally poisons `deleteObjectField` / `removeObjectField` / `deleteView`);
frozen templates untouched; zero external writes; no new env flags. `package.json` gained
one chain segment, which moved `runtimeFiles.pluginPackageJson`; that ONE pin was recomputed
with `computePackageProvenancePinSet` and confirmed to be the only drifted entry.
