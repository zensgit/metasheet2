# Button Arc (#2645 / #2648 / #2653 / #2657) — Independent Adversarial Audit

Date: 2026-06-15 · Scope: read-only against `origin/main` · Method: 4-lens audit
(exclusion-matrix / executor-seam / shadow-copy / test-vacuity) → adversarial
refutation of every high/medium finding → this synthesis (the workflow's synth
step rate-limited; reconstructed by hand from the journal).

## Headline verdict

**The merged button arc is sound *today* — every value-leak is LATENT.** There is
no path on `origin/main` to create a `button` field at all: `MULTITABLE_FIELD_INPUT_TYPES`
omits `'button'`, and all field-create sinks (POST/PATCH `/fields`, people-sheet
preset, provisioning) reject it. So no button cell can hold a value, and the
"value-less" exclusions can't be exercised yet.

But the audit found a real, coherent **spec-gap pattern**: the button write-less
invariant (design-lock §2's #1 hard constraint) is enforced **inconsistently across
3+ divergent field serializers / write paths**. These become **LIVE the instant
B1-c wires `'button'` into field creation** — so they are a precise **B1-c gate
checklist**, and design-lock §2 explicitly mandates each be closed (backend guard
+ fail-first test) in that same PR. One finding (AUDIT-1) is a spec divergence in
the *already-merged* route, live now.

All items are in already-merged code (a parallel session owns this arc); this is a
**handoff checklist**, not a PR from this session.

## The write-exclusion asymmetry (the core pattern)

| Path | Button write-less enforced? | Where |
|---|---|---|
| Bulk UPDATE (`record-write-service.validateChanges`) | ✅ explicit type clause | `record-write-service.ts:444` (formula/lookup/rollup/**button**) |
| Read / serialize (field-codecs) | ✅ injects `readOnly:true` | `field-codecs.ts:429` |
| Single-record CREATE (`RecordService.createRecord`) | ❌ **no button rejection** | `record-service.ts:222` local `mapFieldType` drops button→`'string'`; sole guard `isFieldAlwaysReadOnly` (`:480`) omits button |
| Field create/patch + button-route read (univer-meta) | ❌ **no button branch** | `univer-meta.ts:1595-1714` `sanitizeFieldPropertyByType` falls to `return obj`, no `readOnly` injection |

So the load-bearing WRITE exclusion covers only the bulk path; the CREATE path and
the route-layer sanitizer diverge.

## Confirmed findings (ranked; all re-verified on origin/main, then reachability-graded)

1. **LEAK-1 — CREATE path can write a real value into a button cell** (raw high → adversarially **latent/medium**). `RecordService.createRecord` uses a third, untracked `mapFieldType` (`record-service.ts:222`) with no button case (→`'string'`) and `isFieldAlwaysReadOnly`-only backstop (omits button). The bulk-path rejection (#2648) doesn't cover create. *Latent until button creation wired.* **Fix:** add `'button'` to `isFieldAlwaysReadOnly` (`permission-derivation.ts:58`) by TYPE — covers create+update+patch+xlsx in one gate.

2. **LEAK-2 — export emits raw button cell value + a header column** (raw high → **latent/low**). xlsx export (`univer-meta.ts:7488-7508`) iterates all visible fields with no button exclusion; harmless only while the cell is empty (LEAK-1 breaks that premise). Header column already appears (minor §2 "不进列" deviation). **Fix:** drop `field.type==='button'` from the export field/column set (mirror the formula/lookup taint-drop at `:7447`).

3. **AUDIT-1 — button/run route writes no durable audit row** (medium, **live**). Design-lock §5.2 + ledger §3 require best-effort `AutomationLogService.record()` (redacted, queryable). The merged route (`multitable-button.ts:108-113`) only does `logger.info('[multitable.button.run]', …)` — no durable execution record. (Note: this session's superseded B1-a1 build *did* use the real log service — more spec-compliant on this axis, but #2657 is what merged.) **Fix:** wire the route audit through `AutomationLogService.record()` best-effort in try/catch, or amend the spec if an app-log line is intentionally sufficient for the inert first action.

4. **EXCL-1 / SHADOW-1 (permission-derivation)** — `isFieldAlwaysReadOnly` omits `'button'` (medium → **latent/low**). The single fix in LEAK-1 closes this too — it's the same type-gate.

5. **SHADOW-1 (univer-meta sanitizer)** — route-layer `sanitizeFieldPropertyByType` has no button branch (`:1595-1714`), so a created/patched button field's property is passed through with no `readOnly` injection and arbitrary keys (medium → **latent/low**). **Fix:** add a button branch mirroring `field-codecs.ts:422-443`, or have the route delegate to field-codecs' sanitizer for button (one shared sanitizer).

6. **TEST-1 — 5+ exclusion rows have neither guard nor test** (medium → **latent/low**). Only 3 of the §2 rows are covered (bulk-write, aggregation-numeric, codec round-trip); query/sort/filter, conditional-format, automation-conditions, xlsx, field-validation, record-create have zero button tests. LEAK-1 slipped through because the one write test used a **hand-built `type:'button'` fixture** (wire-vs-fixture drift). **Fix:** per uncovered §2 row, a fail-first test driving a REAL serialized button field (created via the actual field-create sanitizer, read via the actual loaders) — the create-rejection test is the one that catches LEAK-1.

## Single highest-leverage fix

Add `'button'` to `isFieldAlwaysReadOnly` (`permission-derivation.ts:58`) as a
TYPE-level always-readonly (alongside formula/lookup/rollup). That one change makes
create + update + patch + field-permission + xlsx reject button by type — closing
LEAK-1, EXCL-1, and the SHADOW write-leak together, independent of any injected
property flag. Then: button branch in univer-meta's sanitizer, button drop in
export, and the per-row fail-first tests.

## Note on INFO-1 (superseded)

The originally-suspected gap (univer-meta `mapFieldType` lacking a button case) was
**already fixed by #2657** (`univer-meta.ts:1399`). Recorded as resolved, not a
finding.
