# Cross-base Slice 1 — C2: editable-mirror write-through — DESIGN-LOCK (RATIFIED) — 2026-07-01

> The runtime that opens **one** gated cross-base mirror-edit path onto the floor guarded by C1
> (`resolveCrossBaseWriteAuthority`) + C2/I-1 (mirror read-only on every `meta_links`-writing path). Builds on the
> RATIFIED Slice-1 lock (`multitable-crossbase-twoway-editable-mirror-slice1-designlock-20260629.md`, §7 A–F, §10
> I-1/I-2/I-3). Grounding: `origin/main` @ `032e063af` (C1 `e10c80dc5` + C2/I-1 `c452eb403` landed). **RATIFIED
> 2026-07-01 (owner-signed; Locks A/B/C + the §6 golden matrix settled — base-B = record-level). NO code until the
> separate contract-first runtime PR.** Owner-directed to lock three things sharply (§2). Default-off
> `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE`.

## 1. Scope — one path, nothing else
Add **one** deliberately-gated operation that lets an actor on base **B** edit a cross-base **mirror** field `M_B`
on record `rec_B` to add/remove a link to a base-**A** record `rec_A`, by writing the **single canonical forward
edge** `(F_A, rec_A, rec_B)`. Everything else stays exactly as C1/C2-I-1 left it. **OUT** (each a separate later
slice, unchanged by this): same-base editable mirror (Decision D — same-base mirror stays read-only), live realtime
push (Decision E — base-B read-recomputes), cross-base triggers, cascade. No new capability beyond this one op.

## 2. The three locks (sharp)

### Lock A — the single write-through path does NOT bypass the spine invariant
- The mirror stays **read-only on every existing path**: `isFieldAlwaysReadOnly` (permission-derivation.ts:66,
  `mirrorOf ⇒ true`) is **unchanged**; the general record-write paths (PATCH / bulk `/patch` / create / form /
  import / plugin-SDK / Yjs / snapshot rebuilds) continue to **reject** a mirror write (C2/I-1). This op does **not**
  loosen that guard.
- Editing the mirror is a **distinct, dedicated operation** (a new flag-gated route/op — NOT a branch inside the
  general PATCH), so the read-only floor is never widened. It effects the change as an **authority-gated patch of
  `rec_A.F_A`** (the forward field) — i.e. Lock B/C supply the *authorization*, and the **existing forward link-write
  service** supplies the *mechanics*. It does **not** hand-roll a bare `INSERT/DELETE meta_links`. Routing through the
  forward writer is load-bearing, not stylistic: a raw INSERT preserves the *no-`M_B`-row* spine but silently drops
  the forward path's own invariants, two of them spine-relevant — **`ON CONFLICT`/dedup** (a base-B "add" of an edge
  that already exists from base-A's side must be a **no-op, never a duplicate `(F_A, rec_A, rec_B)` row** — a
  second-canonical-row break keyed by `F_A` instead of `M_B`) and **link-target-exists validation**; plus revision
  recording and the same-base mirror-invalidation collection. Routing through the service inherits all of these for
  free and is consistent with Decision E (base-A's forward field fans out normally; base-B re-projects on read). The
  op writes **only** the one canonical forward edge — **never** a row keyed by the mirror field id `M_B`. *(If a
  future impl ever bypasses the service, the doc/contract must enumerate every forward invariant it replicates — dedup
  first.)*
- **Enumeration re-proof (acceptance):** re-run the C2/I-1 write-path enumeration — after this op lands, the set of
  paths able to write a `meta_links` edge for a mirror field id is still **exactly {∅}** (the mirror field id never
  gets a row); the ONLY new writer is this op, and it writes the **forward** field id. A golden asserts
  `count(meta_links WHERE field_id = M_B) === 0` after every op outcome (allow, deny, error).

### Lock B — I-3 both-endpoints authority, implemented ASYMMETRICALLY
Both endpoints must pass; the two legs are **not** symmetric:
- **base-A leg (the canonical-edge owner — `F_A`'s base):** the write mutates base-A's relational space, so it goes
  through the C1 primitive `resolveCrossBaseWriteAuthority({ actorId, targetBaseId: baseA, declaredBaseClaim, queryFn })`
  = **claim==truth** (the op's declared base-A opt-in must equal `F_A`'s actual base) **+** `resolveBaseWritable(actor,
  baseA)` **+** the per-target-base **quota keyed to base A** (the same quota discipline as automation cross-base
  writes; composed by this caller, base-A-keyed, exactly as C1/§10-I-3 specifies — NOT inside the primitive).
- **base-B leg (where the edit originates — `M_B`'s base): RECORD-level (owner-ratified 2026-07-01).** **No claim, no
  quota, NO C1 primitive** (base-B is not a cross-base *target* / canonical-edge owner — never claim-gated or
  double-charged), **but** the op requires the actor's **local edit eligibility on the specific `rec_B`** —
  record-edit / row-level-deny / the relevant mirror-op field policy on `rec_B`. Editing `rec_B.M_B` is semantically a
  record edit of `rec_B` even though the physical mutation lands on `rec_A.F_A`, so a **row-denied / record-edit-denied
  base-B actor must NOT be able to use the mirror op as a bypass**. (A plain base-*level* `resolveBaseWritable(baseB)`
  was considered and **rejected** as too coarse — it would authorize *any* record in base B.)
- The C1 primitive is called for the **base-A leg only**; base-B is a **local `rec_B` record-edit check** (no
  primitive / no claim / no quota). Any single-leg failure → deny. (Locks the §10/I-3 asymmetry — a future impl can't
  collapse it into a symmetric double-primitive / double-quota call, and can't drop base-B to a coarse base-level
  check.)

### Lock C — I-2 per-record no-oracle mask on `rec_A`
Lock B's **base-A** authority is base-level (it authorizes writing base A, not *reading a specific record*); it does
NOT cover per-record visibility of the named base-A record `rec_A`, so:
- The op enforces the **same per-record foreign read+write mask the read path uses** — parity with
  `resolveForeignFieldReadability` / `shouldMaskForeignField` (univer-meta.ts:~1411) — on the named `rec_A`.
- **No-oracle on ADD (hard):** adding `rec_A` that is **masked** (actor lacks read) / **missing** / **not writable**
  all return the **same uniform fail-closed** response (identical status + body); a base-B actor must NOT probe base-A
  record existence or permission via a mirror add. Masked ≡ missing ≡ denied, indistinguishable.
- **No-oracle on REMOVE (hard — the sharper leak):** the mask already empties masked foreign records from the mirror
  projection, so removing one requires guessing its id — and a remove that returns **success-iff-the-edge-existed**
  would confirm a masked record was linked (a *linkage* oracle, worse than existence). Therefore the per-record
  mask/authority check on `rec_A` runs **BEFORE any edge-existence branch**, and **remove-a-masked-(or-unreadable)-`rec_A`
  is byte-identical to remove-a-nonexistent-`rec_A`** — no success/noop signal distinguishes "was linked" from "never
  existed" on either verb.
- The §6 goldens prove the load-bearing cases specifically: **has base-A write (Lock B passes) but NO read on the
  specific `rec_A`** → uniform deny on ADD (byte-identical to missing-`rec_A`) **and** on REMOVE (byte-identical to
  remove-nonexistent), with no edge written/removed either way.

## 3. Architecture (write-through, single-DB, atomic)
Bases share one Postgres; `meta_links` is one global edge table. The op resolves `F_A` (the forward field paired to
`M_B` via `mirrorOf`/`mirrorFieldId`) and its base A, then in **one `pool.transaction`**: Lock B (base-A primitive +
base-B **local `rec_B` record-edit check**) → Lock C (`rec_A` read+write mask, uniform-deny) → **invoke the
transaction-aware forward link-write helper for `rec_A.F_A`** (per Lock A — the helper supplies `ON CONFLICT`/dedup,
link-target-exists, revision recording, and mirror-invalidation; the op **never** hand-rolls a `meta_links`
INSERT/DELETE). The mirror side (`M_B` on `rec_B`) is **not** written — it re-projects on next read (Decision E: no
live cross-base push; base-A's forward field fans out normally on its own sheet). All-or-nothing.

## 4. Consistency / TOCTOU (Decision F launch gate)
Resolve-then-write is one txn; the txn takes `FOR UPDATE` on the gating row(s) so base/permission can't drift between
the Lock-B/C checks and the edge write (permission-revert lesson). **Decision F stands as the launch gate:** the flag
is NOT enabled until the forward grant/revoke routes **and** the forward link-edit co-lock with this op (same sheet
lock) **or** use a conditional/versioned write. Runtime can land default-off before that gate closes; enabling can't.

## 5. Non-goals (unchanged)
Same-base editable mirror (D); live realtime push (E, read-recompute only); cross-base triggers; cascade. `M_B`
read-only by codec on all non-op paths.

## 6. Test plan — real-DB goldens, fail-first (CI real-DB job)
New `multitable-crossbase-mirror-writethrough-realdb.test.ts`:
- **W-A spine + dedup:** happy add via the op ⇒ exactly one forward edge `(F_A, rec_A, rec_B)`; `count(meta_links
  WHERE field_id = M_B) === 0`. A base-B **add of an edge that already exists from base-A's side ⇒ no-op, still
  exactly one `(F_A, rec_A, rec_B)` row** (dedup via the forward service, not a duplicate canonical row). Remove ⇒
  edge deleted. **Fail-first:** a variant that wrote an `M_B` row **or a duplicate `(F_A,…)` row** is RED.
- **W-A floor regression:** a mirror write through the general PATCH / bulk `/patch` is **still rejected** (C2/I-1
  intact — the op didn't loosen the floor).
- **W-B authority (asymmetric, record-level base-B):** happy path (base-A primitive passes **and** actor can edit
  `rec_B`) ⇒ the one forward edge. Denials, each with **no edge**: base-A NOT base-writable; wrong/absent base-A
  claim; base-A quota N+1; **base-B `rec_B` record-edit-denied or row-denied** (the record-level upgrade — a base-B
  actor who cannot edit `rec_B` cannot use the mirror op as a bypass). **base-B asymmetry assertions:** base-B is a
  *local record-edit* check only — it consumes **no claim and no quota** (the base-A quota counter is unchanged after
  a base-B-only denial, and there is **no base-B quota counter**), and the C1 primitive is invoked for base-A only.
- **W-C no-oracle (ADD + REMOVE):** ADD — has-base-A-write-but-no-`rec_A`-read → uniform deny **byte-identical** to
  missing-`rec_A`, no edge. REMOVE — removing a **masked/unreadable-but-actually-linked** `rec_A` → **byte-identical**
  to remove-nonexistent-`rec_A`, no edge removed and no success/noop linkage signal. Fail-first: disable the
  per-record mask, **or move it AFTER the edge-existence branch** → the two responses diverge (a linkage oracle) / a
  row appears or is removed.
- **W-flag:** flag unset → op refused (mirror read-only as today), no write.
Each security golden fail-first-proven; the spine assertion runs after every case; wired into `plugin-tests.yml`.

## 7. Pre-runtime gates (before any code)
1. **Owner ratification** of §2 Locks A/B/C (+ §3/§4) — ✅ **DONE (RATIFIED 2026-07-01).** The base-B granularity
   decision is **resolved = record-level** (§2 Lock B); no open ratification items remain.
2. **Adversarial advisor pass** — ✅ run on this draft (2026-07-01); folded in: Lock A → route through the forward
   link-write service (dedup/validation/revision/mirror-invalidation inherited, no duplicate `(F_A,…)` row), Lock C →
   the REMOVE-side linkage-oracle (mask before edge-existence branch). A final pass on the ratified design before
   runtime is still advisable.
3. Only then: runtime, contract-first — the dedicated op + the three locks, goldens fail-first, default-off; the
   Decision-F co-lock is the enablement gate, not part of the runtime PR.
