# Multitable Cross-Base Phase C (C3 + C2) — design-lock: finer write tier + cross-base delete/lock

Status: **DESIGN-LOCK.** Covers **C3** (a finer-grained base-write permission tier) and
**C2** (cross-base record delete + cross-base record lock). **C1** (real-time invalidation
fan-out to the target base's room) is intentionally **NOT** in this lock — it is materially
riskier and infra-adjacent, and gets its own design+review beat after C3+C2 land.

This continues the cross-base governance arc (closeout:
`multitable-crossbase-arc-closeout-verification-20260614.md`). It does not re-derive that
arc's layering; it consumes it. Own-principles framing throughout.

## 0. Grounding (verified against merged `origin/main`, post #2585/#2598/#2605)

- **Base-write authority** is resolved by `resolveBaseWritable` (`permission-service.ts:~1300`):
  a user can write a base iff one of their namespace-admitted permission codes is in
  `BASE_WRITE_PERMISSION_CODES`, **or** they own the base. Today
  `BASE_WRITE_PERMISSION_CODES = BASE_ADMIN_PERMISSION_CODES` — the **same Set object**
  (`permission-service.ts:132`): `{ 'multitable:base:admin', 'multitable:admin' }`. So
  "can write a base" ≡ "is base-admin-or-owner". The inline comment names a finer
  `multitable:base:write` tier as a future opt-in. **C3 is that opt-in.**
- **Consumer audit (the load-bearing pre-code check).** Splitting the two Sets is only safe if
  no call site uses one as a proxy for the other. Verified: `BASE_WRITE_PERMISSION_CODES` has
  exactly **one** runtime consumer — `resolveBaseWritable` — and `BASE_ADMIN_PERMISSION_CODES`
  has **no** independent admin-gate consumer (it is referenced only as the value aliased into
  BASE_WRITE). There is no `resolveBaseAdmin` reading that Set. Therefore the split touches the
  write path only; nothing currently distinguishes write-from-admin to mis-classify.
- **Namespace admission** (`rbac/namespace-admission.ts`) admits by *resource* (`multitable`),
  not by an enumerated code list, so a new `multitable:base:write` code flows through
  `filterPermissionCodesByNamespaceAdmission` exactly like the existing multitable codes — no
  allowlist to extend.
- **Cross-base WRITE gate** = `evaluateCrossBaseWrite` (`automation-executor.ts`): trigger-actor
  authority, claim==truth, `resolveBaseWritable` on the target base, then the per-target-base
  write quota. Null-actor fails closed.
- **Record lock** = `ensureRecordNotLocked` / `canUnlock` (`record-lock.ts`); enforced at the
  automation update sink (`automation-executor.ts:1733`). The lock mutates a lock column, not
  record data.
- **Delete** today has **no cross-base sink** — `records.deleteRecord` is same-base via
  `plugin-scope`. Closeout §5 line 64 flagged exactly this: a future write/delete path that
  skips `evaluateCrossBaseWrite` would be caught only by XW-* tests, not a structural RED.

## 1. C3 — finer `multitable:base:write` tier

### Principle
Authority tiers are **additive and monotone**: introducing a narrower grant must let it grant
*strictly less than or equal to* what already-existing grants do, and must not change what any
existing code-holder can do. `base:admin` continues to imply write. The new tier only opens a
**lower door to the same write room** — it never opens an admin door.

### Change
1. Introduce code `multitable:base:write`.
2. `BASE_WRITE_PERMISSION_CODES` becomes a **distinct Set** =
   `{ 'multitable:base:write' } ∪ BASE_ADMIN_PERMISSION_CODES`
   (i.e. `{ base:write, base:admin, multitable:admin }`). `BASE_ADMIN_PERMISSION_CODES` is
   **unchanged** (`{ base:admin, multitable:admin }`) and is no longer aliased.
3. `resolveBaseWritable` is unchanged in logic — it already grants on
   `BASE_WRITE_PERMISSION_CODES` membership; it now additionally accepts `base:write`.
4. Update the docstrings (`:127-132`, `:1289`) to state the split + the monotonicity invariant.

### Why this is safe (the divergence check, written down)
After the split the two Sets differ. The only consumer of each is enumerated above; the write
consumer *wants* the wider (write) set and the (currently absent) admin path *wants* the
narrower set. A `base:write`-only holder gains base-write — and, because no admin gate reads
`BASE_WRITE_PERMISSION_CODES`, gains **nothing admin**. This is the intended observable effect.

### Fail-first matrix (C3)
- `base:write`-only holder → `resolveBaseWritable(target) === true` (NEW: was false — the code
  was in no write set before). **This is the keystone test.**
- `base:write`-only holder is **not** in `BASE_ADMIN_PERMISSION_CODES` (guards the split: a
  future admin gate must reject write-only). Assert set-membership directly.
- `base:admin` holder → still writable (regression).
- `multitable:admin` holder → still writable (regression).
- `base:read`-only holder → **not** writable (negative).
- owner (no codes) → still writable (ownership path intact).
- Namespace admission is **pass-through** for `base:write` (the `multitable` resource is in
  `NON_NAMESPACED_PERMISSION_RESOURCES`), exactly as it is for `base:admin` — so the new code
  introduces **no** admission asymmetry vs the existing admin codes. (There is no per-namespace
  narrowing to test here; the split changes only set-membership, not the admission path.)
- Cross-base end-to-end: `evaluateCrossBaseWrite` now passes for a `base:write`-only trigger
  actor on the target base (it consumes `resolveBaseWritable`), with the quota still enforced.

## 2. C2 — cross-base delete + cross-base lock

### Principle
A destructive or governance action on **another base's** record requires **write authority on
that target base**, resolved by the *same* primitive a cross-base write uses — never a weaker
or separate rule. The actor is the **trigger actor** (consistent with the write gate's
fail-closed承重 decision); a null actor is a no-op, never a bypass.

### C2a — cross-base delete
1. Wherever a delete can name a foreign target (the cross-base-capable automation delete path,
   mirroring `UpdateRecordConfig`/`CreateRecordConfig`'s `targetBaseId`), route it through
   `evaluateCrossBaseWrite` **before** the delete: same base-writable gate, same claim==truth,
   same quota bucket as writes (a delete is a write for abuse-accounting).
2. The target record's lock is honored: `ensureRecordNotLocked` on the **target** record before
   delete (you cannot delete a record locked by someone you can't unlock).
3. **Structural guard (the closeout-flagged gap — REQUIRED, not optional).** Add a whole-`src`
   structural guard that enumerates cross-base-capable delete sinks and asserts each references
   `evaluateCrossBaseWrite`, mirroring the n2 lock-guard. C2 is **not done when gated; it is
   done when the new delete sink is enrolled in the guard**, so a future delete caller that
   skips the gate goes structurally RED, not merely XW-test red.

### C2b — cross-base lock
Locking a record in another base is a **denial-of-edit on foreign data** — a new governance
surface. **Decision: the bar is `resolveBaseWritable` on the target base (base:write), not
base:admin.** Rationale (written into the lock): locking is an *edit-class* action (it gates who
may edit a record), not an *admin-class* action (schema/permission/lifecycle). It is strictly
weaker than delete, which we already gate at base-write. Requiring base:admin would be
inconsistent with treating lock as an edit affordance and would over-restrict the legitimate
"protect this row" use. A future tightening to base:admin remains open if a concrete abuse case
appears. Null-actor lock = no-op.

### Fail-first matrix (C2)
- Cross-base delete by a `base:write`-authorized trigger actor on the target → allowed, quota
  decremented, audit/provenance recorded.
- Cross-base delete by an actor **without** target base-write → blocked (fail-closed).
- Cross-base delete of a **locked** target the actor can't unlock → blocked by the lock.
- Null trigger actor cross-base delete → no-op (no delete).
- Structural guard: a synthetic delete sink that omits `evaluateCrossBaseWrite` → guard RED.
- Cross-base lock by `base:write` actor on target → allowed; by non-writer → blocked; null
  actor → no-op.
- Quota: cross-base delete + write share the per-target-base bucket (a base cannot dodge the
  limit by mixing deletes and writes).

## 3. Sequence & scope discipline
C3 → C2 → (separate beat) C1. C3 lands first (C2 consumes the write tier). Each is its own PR,
fail-first then adversarially reviewed, merged before the next to keep the permission/codec hot
files conflict-free. No FE surface in this lock (C3/C2 are authority + data-path only). The
cross-base write **quota** (Phase A1) already covers the new delete sink by sharing its bucket.

## 4. Explicitly out of scope (separate gated opt-ins)
C1 real-time fan-out (own beat — the load-bearing question there is **target-room membership
gating**, not signal contents). Finer *sheet*-level write tiers. Base-admin-only operation
gates (none exist yet; C3 makes them *expressible*, it does not add them). Cross-base move/copy.
