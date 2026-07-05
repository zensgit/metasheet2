# Read-source recursive expansion — direction design-lock — 2026-07-05

## Status

**Direction design-lock only. No runtime, no config model, no planner, no executor, no route, no UI,
no code, no write.** This document locks the *direction* for **recursive / multi-level expansion** over
the governed read-source surface (#1709) — a bill whose lines are themselves bills, walked to N levels —
which the composition design-lock (2026-07-03) explicitly named as "a strictly-later, separate rung"
and deliberately excluded from composition v1. This is that separate rung's direction lock. It
authorizes no implementation; every REC rung below is a separate, later, explicitly gated opt-in, and
**the build additionally sits behind a demand gate** (§2).

Foundation as of this lock: the read-only composition arc is feature-complete on main
(C-R0 lock → C-R1 config #3553 → C-R2 planner #3563 → C-R3 runtime #3565 → C-R4 route/mirror/service/UI
#3573/#3576/#3583/#3585, hardening #3568/#3586/#3588). Composition v1 is a **fixed, small, acyclic
depth-2 chain** resolving one scalar per hop. Recursion is everything composition v1 refused to be —
which is exactly why it gets its own lock instead of being folded in.

## 1. One-line scope

> Walk a resolved bill-of-materials to a **bounded** number of levels through the SAME approved,
> key-only, values-free, read-only configured-read primitive — with a platform-fixed depth cap,
> per-level and total-node budgets, cycle detection, and a values-free per-level evidence aggregate —
> producing a bounded traversal result for the authorized caller. **Never unbounded, never a write.**

## 2. Demand gate (build precondition — not satisfied by this lock)

The two-gate discipline applies (demand + governance). Governance is designed here; **demand is not yet
named**. The build may start only when a concrete customer case requires multi-level expansion
*through the governed read surface* — e.g. "given material X, enumerate its full N-level BOM via the
approved K3 WebAPI read configs, values-free evidence, for review inside MetaSheet".

Two adjacent facts keep this honest:

- The PLM stock-preparation line **already has** a recursive large-BOM expansion (bridge SQL substrate,
  bounded synchronous lane + checkpointed background lane). Recursion here is a **different substrate**
  (approved configured reads over the external API), not a replacement of that path. If a future case is
  actually a stock-preparation case, it belongs there, not here.
- The K3 GATE productionization gap ("populate full K3 ref objects" leaning on deferred READ) is a
  *potential* future demand shape but has not been named as requiring multi-level expansion.

If the demand never materializes, this lock simply never unlocks — that is the intended behavior.

## 3. Why recursion is not "composition with a loop"

Composition v1 is one ordered list of two approved configs with a typed single-scalar handoff. Recursion
adds five hazards that composition deliberately does not have — each becomes a lock in §4:

1. **Unbounded fan-out.** A bill has many lines; each line may be a bill. Growth is multiplicative, not
   linear. Without budgets, one root key can generate an unbounded number of outbound reads against a
   customer's ERP.
2. **Cycles.** A BOM that (directly or transitively) references itself. Without cycle detection the walk
   never terminates.
3. **Budget semantics.** A cap that silently truncates *looks* like a complete result. The
   stock-preparation large-BOM lesson is adopted verbatim: **a bounded subset is never presented as an
   authoritative expansion** — cap-hit is an explicit, coarse-coded, fail-closed outcome.
4. **Aggregate result shape.** Composition returns one scalar. An expansion returns a bounded tree; the
   data plane needs parent/child/depth structure and the evidence plane needs per-level aggregates —
   without values riding into evidence.
5. **Traversal determinism.** Re-running the same root key must traverse in the same order (declared
   child ordering), or retries/diffs become meaningless.

## 4. The locks (direction, to be sharpened at REC-R1)

1. **Same primitive, no forked path.** Every level is the same `executeConfiguredRead` over an APPROVED
   read-source config (the per-hop primitive composition already reuses). Recursion orchestrates
   *iterated* hops; it never adds a second read path, a raw endpoint, or a new credential path.
2. **Bounded by construction — three independent budgets, all platform-capped.** (a) max depth: a
   per-config small integer ≤ a platform-fixed ceiling; (b) per-level fan-out cap; (c) total-node
   budget for the whole expansion. Hitting ANY budget aborts the walk fail-closed with a dedicated
   coarse code (e.g. `…EXPANSION_DEPTH_CAP` / `…EXPANSION_NODE_BUDGET`) — **a truncated walk is never
   returned as a success**, mirroring the large-BOM "bounded preview is not an authoritative plan" rule.
3. **Cycle detection, fail-closed.** A visited set keyed on the resolved child identity within one
   expansion; a revisit → dedicated coarse code (`…EXPANSION_CYCLE`), walk aborted (v1 does not
   "skip-and-continue" — partial-tolerance is a later policy question, not a default).
4. **Key-only runtime request, platform-derived descent.** The runtime request carries ONLY the root
   business key (the existing strict `{ inputs: { key } }` contract). Every descent key is derived by
   the platform from a parent row through config-declared wiring — never runtime-supplied, never a raw
   filter.
5. **Values-free evidence aggregate.** Evidence carries per-level aggregates only: nodes visited per
   level, depth reached, caps hit (booleans + counts), cycle detected, per-level coarse failure codes.
   It NEVER carries item numbers, quantities, names, paths of values, hosts, credentials, or the root
   key. The traversal DATA (the bounded tree: parent/child references, depth, per-node resolved fields)
   flows only to the authorized caller — same two-plane split as the whole line.
6. **Read-only, idempotent.** Every level is a configured READ; no write shape anywhere; a re-run with
   the same root key re-reads deterministically (declared child ordering) with no state and no partial
   effect. No checkpoint/resume in v1 — that machinery exists in the stock-preparation lane for APPLY
   workloads; a read-only expansion that exceeds its budgets FAILS CLOSED instead of checkpointing.
7. **Authorization tiers unchanged.** Expansion config authoring = write-tier (consultant declares the
   descent wiring + budgets, content-keyed versioned approve/retire, forking the existing store shape);
   running an approved expansion = read-tier, approved-only, key-only.
8. **Closed vocabulary discipline.** New coarse codes (cycle, budget caps, descent failures) are a
   server-registered closed set from day one, and any route/UI rung carries the client mirror +
   CI tripwire obligation (the composition/resolver mirror pattern).

## 5. Staged rungs (each a separate opt-in; none authorized here)

| Rung | Scope | Fence |
| --- | --- | --- |
| **REC-R0** (this doc) | direction: bounded budgets, cycle detection, values-free aggregates, same-primitive reuse, demand gate | docs only |
| **REC-R1** | expansion config model + validator (descent wiring, budgets ≤ platform caps, write-shaped rejected) + **pure** traversal planner/budget-cycle evaluator | no outbound, no route |
| **REC-R2** | expansion runtime executor (iterated `executeConfiguredRead`, per-level fail-closed, aggregate stitching) | no route, no UI |
| **REC-R3** | route + client mirror/tripwire + UI | separate; mirror obligation |

The first implementable rung after demand-gate PASS + explicit opt-in is REC-R1. No rung combines
model + executor + route in one PR.

## 6. Non-goals (explicit)

- No write / Save / Submit / Audit / external write / production write (different line; production
  write customer-barred).
- No unbounded or "best-effort partial" expansion; no silent truncation.
- No checkpoint/background/resumable lane in v1 (that belongs to apply-class workloads).
- No replacement of the stock-preparation bridge-SQL large-BOM path.
- No auto-selection between ambiguous children (the resolver's no-auto-pick discipline holds at every
  level).
- No implementation in this document.

## 7. Disposition

Direction locked; nothing built, nothing unlocked. Prerequisites for any code: **(1) a named customer
demand through the governed read surface, (2) an explicit owner opt-in for REC-R1.** Until both, the
read-source line's capability boundary remains: standalone resolver + depth-2 composition, read-only.
