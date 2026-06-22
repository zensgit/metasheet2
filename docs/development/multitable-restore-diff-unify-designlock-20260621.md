# Restore Diff Unification — DESIGN-LOCK / IMPL NOTE (pure extract, reconciliation record)

> Owner-ratified follow-up (T6 P3). Collapse the diff logic in the THREE restore routes (`/restore`,
> `restore-preview` T5-2, `restore-execute` T6-2) onto ONE shared helper. **This is a RECONCILIATION record, not
> a dedup record:** `/restore` predates the other two, which were independently *mirrored* — so the three are not
> copies, they are three implementations that mostly agree. "Zero behavior change" is therefore not literally
> achievable; the one place they disagree is named below and resolved to a declared canonical, proven by the
> existing goldens staying green on reachable inputs.

## 1. The three locked constraints (owner)

1. **The helper is a DIFF PRODUCER, never a permission authority.** It computes the canonical raw diff from
   already-resolved inputs; it makes no permission decision and reads no permission state.
2. **schema-drift, row-deny, and the write/field gate stay at each route's existing layer** — the helper does NOT
   absorb them. (Refinement, per review: the helper produces ONLY the raw diff — there is NO "masked diff"
   variant in the helper, because masking is exactly where permission lives. Each route computes its own allowed
   set and filters the raw diff itself: `restore-preview`/`restore-execute` via `loadAllowedFieldIds` +
   `maskStoredRecordFieldIds`; `/restore` via `fieldIds`-selection + `canSeeField` + the `hasForbidden` gate.
   With no mask in the helper, constraints #1 and #2 hold by construction, and the `changesHash` stays computed
   over the route's own masked set.)
3. **Behavioral equivalence is PROVEN, not asserted** — by the existing goldens (unchanged assertions) + an
   end-to-end golden. No "while I'm in here" fixes beyond the one declared canonicalization in §3.

## 2. Reconciliation diff (all shared pieces compared, char-for-char)

| piece | `/restore` | `restore-preview` (T5-2) | `restore-execute` (T6-2) | verdict |
|---|---|---|---|---|
| non-restorable set | `NON_RESTORABLE_TYPES` (11) | `NON_RESTORABLE` (11) | `NON_RESTORABLE` (11) | **identical** (same 11 members, same spelling) |
| scalar equality | `sameValue` | `sameVal` | `sameVal` | **identical** (`JSON.stringify(a ?? null) === …`) |
| loop body | button-skip → link-branch → non-restorable-skip → inSnap set / inCur unset | same | same | **identical** logic/ordering |
| link equality | `sameLinkSet` — `.every()` set-compare | `sameLinks` — `.sort().join(' ')` | `sameLinks` — `.sort().join(' ')` | **DIVERGES → §3** |
| change shape | full `RecordChange` `{recordId,fieldId,value,expectedVersion,op}` | `{fieldId,op,value}` | full `RecordChange` | projection only (not behavior) |

## 3. The ONE canonicalization — link equality

`sameLinks` (`[...a].sort().join(' ') === [...b].sort().join(' ')`) has a **delimiter collision**, but ONLY for
EQUAL-LENGTH sets (the leading `a.length === b.length` short-circuits unequal ones — so the first-cut example
`['a b']` vs `['a','b']` is *not* actually a collision, it's caught by the length check). The real case is two
distinct same-size sets whose space-joins coincide: `['a','b c']` and `['a b','c']` (both length 2) both serialize
to `'a b c'`. This requires a link id that itself contains a space — latent/defensive rather than common, since
generated record ids have none, but reachable via a legacy `normalizeLinkIds` parse of `'a,b c'` → `['a','b c']`
vs `'a b,c'` → `['a b','c']`. `/restore`'s `sameLinkSet` (length check + sorted `.every()`) has no collision.

- **Canonical = `/restore`'s `sameLinkSet` (robust set-equality).** Rationale: (a) it leaves the SHIPPED
  destructive write path byte-identical — only the two newer paths converge, minimizing blast radius where it is
  worst; (b) it is the correct one; (c) on every input the common path produces, `.every()` and `.join(' ')` are
  identical, so it is behavior-preserving on the reachable, golden-covered space.
- **Declared delta:** `restore-preview` + `restore-execute` change behavior ONLY for a link value containing a
  space-bearing id, where they previously could mis-report two ids as equal. Bounded: a wrong preview "would
  change"; a real `restore-execute` write hits the spine's link-target validation and fails closed. This is the
  single declared behavior change of this slice — surfaced, not silently applied.

## 4. The helper (raw-diff producer)

`packages/core-backend/src/multitable/record-restore-diff.ts`:
```
computeRecordRestoreDiff(args: {
  fieldById, rawTypeById, targetSnapshot, currentData, recordId, currentVersion
}): RecordChange[]
```
Produces the canonical raw diff (`RecordChange[]`, the full shape). Pure (no I/O, no permission). The shared
`NON_RESTORABLE_TYPES`, `isRestorableType`, `sameValue`, and the canonical `sameLinkSet` move into this module.
Call sites: `/restore` uses the result directly; `restore-execute` uses it directly; `restore-preview` maps each
`RecordChange` to its `{fieldId, op, value}` projection (drop `recordId`/`expectedVersion`) before hashing/masking.

## 5. Acceptance (the gate — equivalence is proven, not asserted)

- The existing goldens stay green with **UNCHANGED assertions**: `/restore` **35/35**, `restore-preview` **6/6**,
  `restore-execute` **7/7**. (A required assertion edit = a behavior change = STOP.)
- The **end-to-end** preview→execute golden (T6-2) stays green (the cross-path consistency the helper must preserve).
- **One new golden** on the helper: the canonical `sameLinkSet` distinguishes `['a b']` from `['a','b']` — pins
  the §3 choice + blocks a future "simplification" back to `.join(' ')`.
- `tsc` 0; no migration; no route behavior change beyond the §3 declared delta.

## 6. Out of scope (NOT this slice)

Per-field-through-preview; batch/scope identity; any change to schema-drift / row-deny / write-gate / field-mask /
expectedVersion / return codes. The helper is extraction-only; everything permission-bearing stays in the routes.
