# Cross-base deepen — slice (a): read-only cross-base mirror v1 — dev & verification (2026-06-27)

> Status: built + verified (real-DB fail-first proven). Grounding: `origin/main` @ `027aafd19`. The "surpass"
> axis of the **cross-base deepen** arc (after slices (b) relation-agg perm-fix #3300 and (c) dangling-link
> repair #3306). Security-sensitive (a cross-base READ change that un-defers an owner-ratified §7.2 hold) —
> advisor-reviewed before implementation; explicit owner GO ("只读 mirror，开，就是现在") with batch
> boundaries + acceptance criteria recorded below.

## 1. Scope — what this slice opens, and what it deliberately does NOT

A **bidirectional (twoWay) link** has a forward side (a real `meta_links` edge) and a derived **mirror** side
(`mirrorOf` set, forced read-only by the codec) that is a *read-time reverse projection* of that one edge — no
materialized mirror row, no write-back. Until now a twoWay pairing was forced **same-base**: the field-create
wall blanket-rejected any cross-base twoWay pairing (design §7.2 deferral).

This slice lifts **only** that blanket reject so a twoWay pairing may span bases on the **same** terms as a
one-way cross-base link — i.e. iff it carries a valid `foreignBaseId` opt-in claim. The mirror side stays
**read-only by codec** (`mirrorOf ⇒ readOnly`), so this opens a cross-base reverse **read projection only**.

Explicitly OUT of this slice (each a separate, separately-governed follow-up):
- **No editable mirror** — the derived side is codec read-only; no cross-base write path is introduced.
- **No `evaluateCrossBaseWrite` wiring** — the cross-base write-authority/quota path is untouched.
- **No cross-base realtime mirror push** — deferred to a read-time recompute (see §3, site 3).

## 2. The three changes (the "3-change shape")

### Site 1 — `validateLinkFieldConfig` (`routes/univer-meta.ts`): lift the twoWay cross-base reject
Removed the `if (linkCfg.twoWay === true) return <reject>` block inside the cross-base branch. A cross-base
pairing (one-way **or** twoWay) now falls through to the **unchanged** ②b opt-in short-circuit: allowed iff
`claimed !== null` after the `claim == truth` gate above it (a wrong claim is already rejected; a null/legacy
foreign base can never opt in). No-claim / wrong-claim / one-way-no-claim therefore still **fail closed**.

### Site 2 — `maskDerivedMirrorFieldIds` (`routes/univer-meta.ts`): add a cross-base base-read gate (SECURITY)
The raw `data[mirrorField]` reverse-id wire was gated only at **sheet** level (`resolveReadableSheetIds`). With
cross-base mirrors now possible, a sheet-readable-but-base-unreadable actor could enumerate a foreign base's
record ids/count via the reverse projection. Added gate (2): resolve the source base (from a new `sourceSheetId`
param, parity with `applyLookupRollup`), and for each **distinct cross-base** mirror foreign sheet require
`resolveBaseReadable(foreignBase)` — deny → empty the projection. This is a **strict add** on top of the sheet
gate (only reduces visibility; same-base mirrors never reach gate (2)), parity with the existing
`resolveForeignFieldReadability` §3.2 Sink A and `buildLinkSummaries` Sink B-1 patterns. All four call sites
(view-list, form-context echo, write-echo PATCH, single-record GET) updated to pass their sheet id.

**Two-wire note (advisor):** the mirror reverse projection surfaces on **two independent wires** — the raw
`data[mirrorField]` array (site 2) and the inline `linkSummaries` (gated independently by `buildLinkSummaries`
Sink B-1, which already base-gates **every** link field in `idsBySheet`, mirror included). Both must hold; the
goldens cover each separately and the fail-first proves they are genuinely independent (see §4).

### Site 3 — `collectMirrorInvalidation` (`multitable/record-write-service.ts`): defer cross-base realtime push
A **cross-base** forward write does not fan a mirror-invalidation broadcast to the foreign-base sheet. The
cross-base determination compares the **actual** sheet bases — pre-transaction we resolve `this sheet` vs each
twoWay-mirror forward field's `foreignSheetId` base (one `SELECT id, base_id FROM meta_sheets WHERE id = ANY(…)`,
skipped entirely when the sheet has no twoWay-mirror field) into a `crossBaseMirrorForeignSheetIds` set, and the
closure defers iff `crossBaseMirrorForeignSheetIds.has(cfg.foreignSheetId)`.

> **[P2 review correction]** The first cut used `if (cfg.foreignBaseId != null) return` as the discriminator —
> **wrong**: claim presence is *not* cross-base. `validateLinkFieldConfig` only rejects a *false* claim
> (`claimed !== actualForeignBaseId`), so a **same-base** link may legally carry a **truthful own-base**
> `foreignBaseId` (semantic lock: `multitable-cross-base-link-optin` **XB-3b**). Under the old predicate such a
> same-base twoWay link would wrongly skip its mirror push — a same-base realtime-push regression not covered by
> C1–C9. The fix resolves real bases instead of inferring from the claim. Regression-locked by
> `C-SB-TRUTHFUL-CLAIM` (RED under the old predicate: `expected 0 to be greater than 0`).

This is a **deliberate v1 behavior, not a missed-push bug**: the reverse mirror is recomputed + base-masked on
every fetch (`loadLinkValuesByRecord` + `maskDerivedMirrorFieldIds` / `buildLinkSummaries`), so a cross-base
mirror still reads **correctly** on the next read — it only forgoes a live realtime nudge. Same-base fan-out
(including a same-base link with a truthful own-base claim) is **unchanged**. Site-3 truth table:
same-base/no-claim → fan-out (`C3`); same-base/truthful-claim → fan-out (`C-SB-TRUTHFUL-CLAIM`); cross-base →
defer (`C-XB-NOFANOUT`).

## 3. Acceptance criteria → evidence (all met)

| Owner acceptance condition | Evidence |
|---|---|
| Old C5 "cross-base pairing rejected" **changed** to the new allow semantics (not added beside) | `C5` rewritten in place → asserts 2xx |
| Golden proves base-read have / not-have × mirror read-only (three states) | `C-XB-MASK` (denied→`[]`, permitted→`[REC_A1]`) + `C-XB-RO` (mirror PATCH rejected, no edge) |
| Regression: same-base twoWay/mirror unchanged | `C1`–`C9` all green |
| Regression: same-base twoWay realtime push unchanged incl. **truthful own-base claim** (P2) | `C-SB-TRUTHFUL-CLAIM` (same-base + truthful `foreignBaseId` still fans the mirror event) |
| Regression: one-way cross-base still goes through the foreignBaseId gate | `C5d` (one-way, no claim → 400) |
| Regression: no-claim / wrong-claim still fail closed | `C5b` (no claim → 400), `C5c` (wrong claim → 400) |
| Create path exercised end-to-end (not only SQL-seeded) | `C5-CREATE` (forward SA→SX **and** mirror SX→SA both create; mirror returns read-only) |
| No editable mirror / no `evaluateCrossBaseWrite` / no cross-base push | `C-XB-RO` (read-only) + `C-XB-NOFANOUT` (push deferred) |

## 4. Fail-first proof (site 2 is necessary; the two wires are independent)

Temporarily disabled gate (2) (`… || (false && crossBaseDeniedForeignSheetIds.has(…))`) and ran `C-XB-MASK`:

```
× C-XB-MASK (/view raw)     — AssertionError: expected [ 'rec_bdl_a1_…' ] to deeply equal []   (RAW WIRE LEAKS)
× C-XB-MASK (single-GET raw) — AssertionError: expected [ 'rec_bdl_a1_…' ] to deeply equal []   (RAW WIRE LEAKS)
✓ C-XB-MASK (linkSummaries)  — still green (buildLinkSummaries gates this wire independently)
```

The raw wires go RED (the leak site 2 closes); the linkSummaries wire stays green — proving it is a genuinely
**separate** wire already covered by `buildLinkSummaries`, exactly as the two-wire analysis predicted. Gate (2)
restored; all green (§5).

**P2 site-3 fail-first.** Temporarily reverted site 3 to the old `if (cfg.foreignBaseId != null) return` and ran
`C-SB-TRUTHFUL-CLAIM` → RED (`expected 0 to be greater than 0` — the same-base mirror event was dropped because
the truthful own-base claim tripped the imprecise predicate). Restored the actual-base resolution → green.

## 5. Verification results

- **Target file (real DB):** `multitable-bidirectional-mirror-links.test.ts` → **22/22 passed** (C1–C9 +
  C5/C5b/C5c/C5d/C5-CREATE + C-XB-MASK ×3 + C-XB-RO + C-XB-NOFANOUT + **C-SB-TRUTHFUL-CLAIM**).
- **Adjacent cross-base suites + XB-3b lock + #3306 mock canary (real DB):**
  `multitable-crossbase-relation-aggregation`, `multitable-cross-base-write-quota`,
  `multitable-cross-base-automation-delete-lock`, `multitable-dangling-link-sweep`,
  `multitable-cross-base-link-optin` (contains the **XB-3b** same-base-truthful-claim lock), `multitable-context.api`
  → **72/72 passed**. No regression; the canary + the new pre-transaction base-resolution query (skipped when the
  sheet has no twoWay-mirror field) don't break any strict mock.
- **Typecheck:** `tsc --noEmit` on `@metasheet/core-backend` → exit 0, clean.

## 6. Boundaries honored

`validateLinkFieldConfig` change is **only** the twoWay-reject removal; the `foreignBaseId` claim==truth gate is
untouched. `maskDerivedMirrorFieldIds` only **adds** the base-read gate (the sheet/field gate is never
loosened); a base-denied reader sees an **empty** mirror, not a 403/diff error. Cross-base realtime push is
deferred with the v1 rationale documented in code + here. No editable mirror, no `evaluateCrossBaseWrite`, no
cross-base realtime push.
