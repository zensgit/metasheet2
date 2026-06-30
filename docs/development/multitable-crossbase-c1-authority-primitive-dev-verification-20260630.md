# Cross-base Slice 1 — C1: shared write-authority primitive extraction — dev & verification (2026-06-30)

> Status: built + verified (regression byte-identical, tsc clean). Branch `claude/multitable-crossbase-c1-authority-primitive-20260630`
> off current main. First runtime slice of the **RATIFIED** design-lock
> `multitable-crossbase-twoway-editable-mirror-slice1-designlock-20260629.md` (§3 + §10/I-3). **Pure
> refactor-extraction — NO new behavior, NO mirror-write.**

## 1. What was extracted
A new context-agnostic module **`packages/core-backend/src/multitable/cross-base-write-authority.ts`** owns the
two-part cross-base write-authority decision on a write into a canonical-owner base:
0. **null target base** — a sheet's `base_id` can be null at runtime (legacy/unresolved) even where the call site
   narrows to `string`, so `targetBaseId` is typed `string | null` and a null base — which can neither be claimed nor
   written — is rejected **up front** as `{ ok:false, reason:'claim_mismatch' }`, before `resolveBaseWritable` is
   consulted. Behaviour-identical to the extracted source (there a null target made `claimed !== targetBaseId` fire →
   same reason); now explicit so no caller can treat the target as guaranteed-non-null.
1. **claim == truth** — `declaredBaseClaim === targetBaseId` (explicit opt-in), else `{ ok:false, reason:'claim_mismatch' }`.
2. **base-write authority** — `resolveBaseWritable(actorId, queryFn, targetBaseId)`, else `{ ok:false, reason:'not_writable' }`.

Signature: `resolveCrossBaseWriteAuthority({ actorId, targetBaseId: string | null, declaredBaseClaim, queryFn }) → { ok:true } | { ok:false, reason }`.
Order is load-bearing (null-target → claim → authority) — identical to the extracted source.

`AutomationExecutor.evaluateCrossBaseWrite` is now a **thin adapter**: it keeps its automation-flavoured parts
(ExecutionContext unpack, same-sheet/no-claim fast-path, `resolveSheetBaseId` soft-deleted-target check, same-base
short-circuit, and the per-target-base **quota** step) and delegates ONLY the claim+authority decision to the
primitive, mapping the structured `reason` back to the **exact, unchanged** `CrossBaseWriteGate` error strings.

## 2. Byte-identical mapping (reason → preserved error string)
| primitive result | adapter `CrossBaseWriteGate` (verbatim, unchanged) |
|---|---|
| `claim_mismatch` | `Cross-base write requires an explicit targetBaseId equal to the target sheet's base: target sheet ${targetSheetId} base=${targetBaseId ?? 'null'}, declared=${claimed ?? 'null'}` |
| `not_writable` | `Cross-base write denied: trigger actor lacks base-write on ${targetBaseId}` |
| `ok` | falls through to the unchanged quota step → `{ crossBase:true, ok:true }` (or the quota rejection) |

The same-base / fast-path / soft-deleted-target / quota returns are untouched. No signature change to
`evaluateCrossBaseWrite` or `CrossBaseWriteGate`. The only import change in the adapter: `resolveBaseWritable` →
`resolveCrossBaseWriteAuthority` (the direct `resolveBaseWritable` call moved into the primitive).

## 3. Verification
- **Regression-lock — BYTE-IDENTICAL automation (real DB):** the 4 existing cross-base-write goldens, **unchanged**,
  pass against the refactored adapter — `multitable-cross-base-automation-write`, `…-write-rule`,
  `…-delete-lock`, `…-write-quota`. Includes the claim/authority-path assertions (XW-2e, LK-1f "claim==truth → step
  failed") and the quota cap. **46/46.** That the unedited tests still pass — same error strings, same quota keying,
  same claim==truth semantics — is the behavior-preserving proof.
- **New primitive unit test** `tests/unit/cross-base-write-authority.test.ts` — **6/6**: claim_mismatch (null claim
  AND claim≠target, each proving authority is NOT consulted — claim checked first), **null target base (claim null AND
  claim string → claim_mismatch, authority NOT consulted)**, not_writable, ok, null-actor pass-through.
  `resolveBaseWritable` mocked directly (cleaner isolation than a mock queryFn; lets the test assert the
  claim-before-authority order).
- **Combined run: 52/52** (46 automation goldens unchanged + 6 primitive unit). **`tsc --noEmit`: exit 0, clean.**
- **Context-agnostic proof:** the new module's only `import` is `from './permission-service'` (`resolveBaseWritable`
  + the `QueryFn` type). It imports NO automation-executor / `ExecutionContext` / quota store / automation type — so
  C2's mirror-write can consume it without dragging automation semantics.

## 4. Boundaries honored (per §10/I-3)
- **Quota stays adapter-composed** — NOT moved into the primitive. The automation adapter keeps
  `checkCrossBaseWriteQuota(targetBaseId)`. For C2: the **base-A leg** = primitive + base-A-keyed quota; the
  **base-B leg** = a plain `resolveBaseWritable` (no claim, no quota — the actor's own base, not a cross-base target).
- **No mirror-write, no flag, no new write path** is introduced in C1. `isFieldAlwaysReadOnly` is untouched (the
  mirror stays read-only everywhere). C2 builds the gated write-through on top of this primitive (lead deliverable:
  the §10/I-1 write-path enumeration).

## 5. tsc narrowing note (non-behavioral)
The adapter branches on the primitive result via `if ('reason' in authority)` (rather than `if (!authority.ok)`) —
the `in`-operator narrows the union member robustly; behavior is identical (reason present ⟺ not-ok).
