# Cross-base deepen — slice 1: relation-aggregation authorized-reader read gate — dev & verification (2026-06-27)

> Status: built + verified (real-DB fail-first proven). Grounding: `origin/main` @ `77333c28e`. First slice of the
> **cross-base deepen** arc selected by the benchmark refresh audit
> (`docs/research/multitable-vs-feishu-benchmark-refresh-20260627.md`). Security-sensitive (a cross-base permission
> change) — advisor-reviewed before implementation.

## 1. The bug
`RELSUMIF` / `RELCOUNTIF` / `RELLOOKUP` / `RELVALUES` over a **cross-base** link returned `#PERM!` (and the
formula-consumed value was taint-dropped) for **every** actor — including one fully authorized to read the foreign
base + the target/criteria fields. Cross-base relation-aggregation was effectively dead for authorized readers.

Root cause: two **blanket** `crossBase` bails, both labelled "out of scope at lock time", that pre-empted the
per-field permission gate:
- `resolveRelationAggregation` (`univer-meta.ts`): `if (readability.get(foreignSheetId)?.crossBase) return REL_AGG_PERM_SENTINEL` — fired at *materialize* (writer context), storing `#PERM!`.
- the formula-taint sink (`resolveTaintedFormulaFieldIds`): `readability.get(foreignSheetId)?.crossBase ||` in the taint test — fired at *read*, dropping the field per-reader.

Both ran **before** the per-field `shouldMaskForeignField(target)` / `(criteria)` checks.

## 2. Why removing them is safe (not a read hole)
The per-field machinery **already** handles cross-base correctly — the blanket bails were redundant:
- `resolveForeignFieldReadability` computes the actor's readable foreign-field set, then **empties it** for a
  cross-base sheet when `!resolveBaseReadable(foreignBaseId)` (②b §3.2 coarse base-read gate).
- `shouldMaskForeignField` returns `false` (readable) **first** for a field in that set, and only then masks
  `crossBase` fields not in it. So: cross-base + base unreadable → set empty → every field masked → `#PERM!`;
  cross-base + base + field readable → not masked → flows.

So the fix routes cross-base relation-agg through the **same** base-read + field-read + row-deny gate that
lookup/rollup/view/export already use. Every fail-closed guarantee the original author feared is preserved by
`shouldMaskForeignField`; the only behavior change is that an **authorized** cross-base reader is no longer
blanket-denied.

## 3. The fix (two sites, symmetric)
Removed the blanket `crossBase` bail at both sites; the per-field `shouldMaskForeignField` checks (unchanged) now
gate cross-base. Comments updated to document the symmetry (the materialize gate and the read-taint gate must agree,
so the formula-consumed value matches the standalone field). No new permission primitive; no change to
`resolveForeignFieldReadability` / `shouldMaskForeignField` / `resolveBaseReadable`.

## 4. Verification — `multitable-crossbase-relation-aggregation.test.ts` (real DB, CI-wired)
Permission matrix, mutation-proven fail-first (stash the src fix → the fix-dependent cases go RED, the fail-closed
case stays green; restore → all green):

- **1399 materialize:** an authorized cross-base reader **stores the real aggregate (30), not `#PERM!`** (RED before).
- **(a) authorized reader** (base-read + target + criteria readable) → `RELSUMIF` = 30, `RELLOOKUP` = 'paid' (RED
  before — `undefined`; proves BOTH the materialize gate and the read-taint gate).
- **(b) no base-read** on the foreign base → field **dropped** (fail-closed preserved; green both ways).
- **(c) target field unreadable** (`field_permissions` deny on the foreign SECRET) → dropped for the denied reader,
  visible (300) to the authorized one.
- **(d) criteria field unreadable** → dropped — the **side-channel** the original author feared (a count over a
  denied field would leak its distribution).

**Local `metasheet_test`:** new golden 6/6. Regression: same-base relation-agg + cross-base link-optin **32/32**;
taint-chokepoint structural guard **3/3** (call-graph unchanged — the edit is inside the resolver, not a new sink).
`tsc` clean.

## 5. Arc context — cross-base deepen, remaining slices
This closes depth gap **(b)** from the audit (cross-base conditional relation-aggregation — a real bug). Remaining
deepen candidates, each a separate slice: **(c)** referential integrity / delete cascade (no FK on `meta_links`;
dangling edges only reported, not repaired); **(a)** cross-base two-way/mirror link sync (mirror is same-base only
today); **(d)** cross-base view filter/sort by a foreign field (`query-service` has no foreign traversal). Order TBD
with the owner.
