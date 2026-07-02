# Cross-base Slice 1 — C2: mirror write-through — BUILD SPEC (design-lock refinement) — 2026-07-01

> Refines the RATIFIED slice-1 design-lock
> (`multitable-crossbase-twoway-editable-mirror-slice1-designlock-20260629.md`) into the C2 runtime build
> bar. Prereqs **LANDED on main**: **I-1** write-path enumeration + mirror-read-only hardening (#3412) and
> the **C1** authority primitive (`resolveCrossBaseWriteAuthority`). Grounded on `origin/main` @ `032e063af`.
>
> **Artifact split — NOT a security-boundary split.** This doc is **PR-A**. The runtime is **PR-B**: ONE PR
> implementing the dedicated op + flag + authority + no-oracle + write-through + fail-first goldens **all at
> once**. The per-record no-oracle on `rec_A` is the **same** security boundary as opening write-through —
> shipping write-through without it, even briefly, is a real probeable oracle window — so it is **not** a
> follow-up and must never be split off.

## 0. Prereqs (verified on main)
- **I-1 floor (#3412).** Every `meta_links` edge-writer rejects a mirror write via the canonical
  `isFieldAlwaysReadOnly`; the spine invariant (a mirror field never owns a `meta_links` row) is guarded on
  every path. C2 opens exactly ONE deliberately-gated path onto this floor.
- **C1 primitive.** `resolveCrossBaseWriteAuthority({ actorId, targetBaseId, declaredBaseClaim, queryFn })
  → { ok: true } | { ok: false, reason: 'claim_mismatch' | 'not_writable' }` — claim-before-authority
  (load-bearing order), fail-closed on null actor/base. **Quota is caller-composed, not primitive-owned.**
- **C2 design-lock (#3440).** Base-B is record-level in v1: local edit eligibility on the specific `rec_B`,
  with no C1 primitive, no claim, and no quota.

## 1. Locked decisions (restated from the ratified design-lock — NOT relitigated)
- **A — canonical-edge write-through, no mirror row.** A mirror edit mutates the ONE canonical forward
  `meta_links` edge. Never materialize a mirror-side row (preserves the #3412 spine invariant).
- **B — both-endpoints authority (strict-first).** The op requires BOTH endpoints' write authority and is
  fail-closed if EITHER is missing, so a cross-base mirror cannot become a single-sided permission bypass.
  (base-A-only is a future evidence-gated relaxation — OUT of v1.)
- **C — no-oracle, uniform fail-closed.** No response byte may distinguish "exists but masked" from "does
  not exist" for the named `rec_A`.

## 2. Authority — ASYMMETRIC two legs (I-3), NOT a symmetric C1 call
Both legs must pass; the op is fail-closed (uniform, per §3) if either fails.

- **base-A canonical-owner leg** — `resolveCrossBaseWriteAuthority({ actorId, targetBaseId: baseA,
  declaredBaseClaim, queryFn })`: **claim==truth** (`declaredBaseClaim === baseA`) **+ base-A writable +
  caller-composed quota keyed to base A**. This leg owns the canonical edge and bears the quota.
- **base-B acting-side leg** — local **record-level edit eligibility on `rec_B`**: record-edit / row-level-deny /
  relevant mirror-op field policy must allow the actor to edit the originating record. **No C1 primitive, no claim,
  no quota, no double-charge.** Base-B is the acting side, not the cross-base canonical-edge target.

The two legs are deliberately **different checks** — C1 is **not** invoked for base-B (that would double-charge
quota and impose a spurious claim), and base-B must not be degraded to a coarse base-level writable check that lets a
row-denied actor use the mirror op as a bypass.

## 3. No-oracle per-record mask (C / I-2) — same op, same boundary
The base-A C1 leg gives **base-level** authority; the no-oracle is a **per-record** property C1 does NOT cover. An
actor with base-A write authority but no per-record **read** on the named `rec_A` must be indistinguishable from one
targeting a non-existent `rec_A'`:
- Apply the read path's per-record mask to the named `rec_A` **before** any write-side effect or
  distinguishable error.
- A masked `rec_A` and a non-existent `rec_A'` MUST yield **byte-identical** responses (status + body +
  error code/shape; no field, count, or ordering that leaks existence).
- This executes **inside the same op** as authority + write-through — there is no ordering in which
  write-through (or a distinguishable rejection) is reachable without the mask having been applied.

## 4. Write-through + TOCTOU / atomicity (A / §5)
- Resolve the canonical **forward** edge for the mirror and mutate THAT `meta_links` row (create/update/
  clear), never a mirror-side row. Route the mutation through the transaction-aware forward link-write helper so the
  forward path's dedup, link-target-exists validation, revision recording, and mirror-invalidation semantics are not
  reimplemented by hand.
- authority (§2) → no-oracle mask (§3) → write (§4) run in **one transaction**, taking the same
  lock family used by the forward writer for the rows this op owns. This closes resolve→write drift inside the op,
  but **does not by itself prove flag-on concurrency with independent forward link-edit routes**; that remains the
  Decision-F enablement gate in §6.

## 5. Goldens (real-DB, fail-first, CI `test (20.x)` multitable job) — implemented in PR-B
- **W-A (authority).** base-A leg: pass; deny on claim-mismatch, base-A-not-writable, quota-exceeded.
  base-B leg: pass only when the actor can locally edit `rec_B`; deny on `rec_B` record-edit-denied / row-denied /
  relevant mirror-op field-policy denial. **both-endpoints strict**: deny if EITHER leg fails. Assert base-B consumes
  no claim and no quota; the C1 primitive is invoked for base-A only.
- **W-B (write-through).** A gated mirror edit mutates the ONE canonical forward edge; the spine assertion
  `SELECT count(*) FROM meta_links WHERE field_id = <mirror> === 0` still holds; the I-1 un-gated paths
  remain unable to mutate the edge via the mirror (regression stays green). Re-adding an already-existing forward
  edge is a no-op, never a duplicate `(F_A, rec_A, rec_B)` row.
- **W-C (no-oracle — LOAD-BEARING).** masked `rec_A` vs non-existent `rec_A'` → **byte-identical**; an actor
  with base-A write but no per-record read on `rec_A` gets the same fail-closed output as a non-existent
  target. (The sharpest security assertion; verify adversarially.)
- **fail-first**: reverting each fix turns its golden RED. Regression: read / mask / relation-agg /
  dangling-link paths stay green (write-through didn't perturb the read/mask/repair paths).

## 6. Flag + Decision F enablement gate (do NOT overclaim)
- Runtime lands behind `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE`, **default-off**.
- **Decision F is an ENABLEMENT GATE, not a shipped capability.** Landing the op default-off is permitted;
  **flag-on is BLOCKED until the forward link-edit ↔ this-op TOCTOU / lock strategy is PROVEN closed** — a
  concurrency golden showing a concurrent forward link-edit and this op cannot interleave to break the
  canonical edge or bypass the per-record mask. **The PR-B text MUST state the op is default-off and NOT
  enable-ready**; it must not imply flag-on readiness.

## 7. Scope / non-goals
OUT of this slice: base-A-only (looser) authority; coarse base-level base-B authorization; any mirror-row
materialization; a symmetric C1 call for the base-B leg; enabling the flag; FE. Read/mask semantics are reused, not
changed.

## 8. Sequence
PR-A (this build-spec) → PR-B (the runtime op + flag + authority + no-oracle + write-through + fail-first
goldens, default-off, one PR) → separately, a TOCTOU/lock-closure concurrency golden that is the Decision-F
enablement precondition before any flag-on.
