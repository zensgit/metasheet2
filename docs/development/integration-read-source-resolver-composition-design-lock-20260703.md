# Read-source resolver composition + recursive expansion — direction design-lock — 2026-07-03

## Status

**Direction design-lock only. No runtime, no config model, no chaining runtime, no recursion,
no code, no write.** This document locks the *direction* for **composing** one configured
read's resolved output into a second configured read (chaining), building on the merged
standalone resolver_lookup (R0 contract, R1 evaluator, R2 runtime; #1709). It also scopes
**recursive expansion** as a strictly-later, separate rung. Each implementation step below is
a separate, later, gated opt-in.

The standalone resolver design-lock explicitly deferred composition ("Chaining a resolver
output into another configured read … is a later design-lock"). This is that later
design-lock. It authorizes no implementation. Read-only throughout; write/Save/Submit/Audit
and production external write are a **different line** and remain out of every rung here.

## One-line scope (owner)

> Let an approved configured read **hand its single resolved output to a second approved
> configured read** — a bounded, ordered, fail-closed chain (e.g. material number → internal
> id → bill number) — with values-free evidence stitched across steps and no intermediate
> value leaking. **Standalone resolver stays the default; composition is opt-in per chain.**
> Recursive/unbounded expansion is a separate, even-later rung.

## The concrete demand (why this exists)

The customer's accepted candidate chain (values-free shape, #1709) is a two-hop resolve:

```text
materialNumber → FItemID → BOM/GetList by FPercentItemID → unique-only FBOMNumber
```

Step 1 (`materialNumber → FItemID`) is the standalone resolver (already shipped R0–R2). Step 2
(`FItemID → FBOMNumber`) is a **second** configured read that consumes step 1's output as its
input key. Composition is exactly this handoff. The accepted fail-closed policy is per-hop:

```text
each hop:  0 candidates → NOT_FOUND · 1 → resolve · >1 → AMBIGUOUS / held
automaticSelectionByStatusVersionDate = false   (never auto-pick by status/version/date)
```

## Why composition is harder than a standalone resolver

A standalone resolver is one outbound read and one selection. A chain adds five hazards the
standalone slice does not have — each becomes a lock below:

1. **Dependency ordering.** Step 2 cannot start until step 1 resolves; a chain is an ordered
   DAG of approved configs, not a free graph.
2. **Typed data-plane handoff.** Step 1's resolved output (an id) becomes step 2's input key.
   The handoff must be a **typed, single-value** contract — never a raw row, never a free
   payload.
3. **Partial-failure semantics.** Step 1 resolves but step 2 fails (or ambiguates). The chain
   must fail-closed with a values-free per-step outcome — never a half-resolved leak.
4. **Evidence stitching without leaking intermediates.** The chain's evidence must say *which
   hop* failed and *why* (coarse code), but must **never** carry the intermediate resolved
   value (the FItemID), any candidate value, or any field name across the boundary.
5. **Idempotency across >1 outbound.** A retried chain must re-run deterministically and be a
   **no-op read** (no write anywhere); no partial-commit, since there is no commit — read-only.

## The locks (direction, to be sharpened at C-R1)

1. **Chain is a bounded, ordered list of APPROVED configs.** A composition config references
   step configs **by their approved version id** (reuse the S2-c approved-only `getForRuntime`
   per step); a draft/retired step config makes the chain non-runnable. Max depth is a small
   platform-fixed constant in v1 (the concrete demand is depth 2); **no unbounded/recursive
   chain in v1** (recursion is a separate rung below).
2. **Typed single-value handoff.** Step N's output is the **one resolver output value** (the
   R1 evaluator's `data.resolver.value`) mapped to step N+1's **declared input key** — a
   typed, single scalar. Never a row, never a candidate list, never a free payload. The
   handoff is declared at config time (which step's output feeds which step's key), not
   supplied by the runtime request.
3. **Runtime request stays key-only.** The chain's runtime request carries ONLY the first
   step's business key (`{inputs:{key}}`, the existing S3-2 strict allowlist). Intermediate
   keys are **derived by the platform** from prior steps, never runtime-supplied. No raw
   endpoint/filter/body/response-path at any hop.
4. **Per-hop fail-closed, chain-level fail-closed.** Each hop applies the standalone resolver
   fail-closed policy (0→NOT_FOUND / 1→resolve / >1→AMBIGUOUS). Any hop that does not resolve
   to exactly one value **aborts the chain** with that hop's coarse code; downstream hops do
   not run. `automaticSelectionByStatusVersionDate` stays **false** — never silently pick.
5. **Values-free evidence stitching.** Chain evidence is a values-free per-step vector:
   `[{step, ok, rule, coarseCode?}, …]` — coarse codes and step ordinals only. It **never**
   carries the intermediate resolved value, candidate values, field/target names, host,
   credential, tenant/system id, or the runtime key. The final `data` carries **only the last
   step's single resolver output** (target + value); intermediate resolved values are **not**
   returned (a chain resolves material → FBOMNumber; the FItemID in the middle is not exposed).
6. **Read-only, no write, no side effect.** Every hop is a configured READ. No hop may be a
   write/Save/Submit/Audit config (fail-closed: a write-shaped step config is rejected). The
   chain has no commit; a retry re-reads deterministically.
7. **Idempotency / retry.** A re-run of the same chain with the same first key produces the
   same outcome (or the same fail-closed code); no state, no write, no partial effect. Platform
   timeout + row cap apply **per hop** (reuse the platform constants).
8. **Authorization / tier.** Composition config authoring is **write-tier** (a consultant
   declares the chain of approved step configs + the handoff wiring); running an approved
   chain is **read-tier** (approved-only, key-only) — the same two-tier split as the read line.
   A composition config is itself content-keyed, versioned, approve/retire (reuse the S2-c
   store shape).

## Recursive BOM expansion (a strictly-later, separate rung)

Multi-level BOM expansion (a bill whose lines are themselves bills, walked to N levels) is
**out of the composition v1** and is its own later design-lock, because it adds beyond a
fixed-depth chain: unbounded fan-out, cycle detection (a BOM that references itself), a
per-level row-cap budget, and an aggregate result shape. v1 composition is a **fixed, small,
acyclic depth** (the depth-2 demand). Recursion is not authorized here and not designed here —
it is named so it is not silently folded into composition.

## Staged rungs (each a separate opt-in)

| Rung | Scope | Gate |
| --- | --- | --- |
| **C-R0** (this doc) | direction: bounded ordered chain, typed single-value handoff, per-hop + chain fail-closed, values-free stitched evidence, read-only, recursion excluded | nothing (docs) |
| **C-R1** | **chain config model + validator** — the ordered-approved-step contract + handoff wiring; content-keyed versioned store + approve/retire (fork S2-c); depth-bounded, acyclic; write-shaped step rejected | no runtime, no chaining execution |
| **C-R2** | **pure chain planner/evaluator** — given resolved step-1 output + step-2 config, derive step-2's input; no outbound, no route; values-free per-step outcome | no route, no adapter |
| **C-R3** | **chain runtime executor** — orchestrates approved step configs in order, per-hop fail-closed, values-free stitched evidence, read-only; reuses the S3-1 executor + R1 resolver per hop | approved-only, key-only, no write, no recursion |
| **(later)** | **recursive expansion** — separate design-lock (fan-out, cycle detection, per-level budget, aggregate shape) | separate |

No rung combines config-model + planner + runtime in one PR. Write, recursion, and any
runtime-supplied endpoint/key beyond the first business key remain out of every rung.

## Foundation (reused, not reinvented)

- **Standalone resolver (R0–R2, merged #1709):** `read-source-config.cjs` (per-mode validator),
  `read-source-resolver-evaluator.cjs` `evaluateResolver` (per-hop selection + values-free
  evidence), `read-source-read-runtime.cjs` `executeConfiguredRead` (the per-hop read + resolver
  branch). Each chain hop is one `executeConfiguredRead`; composition orchestrates hops, it does
  not fork a second read/resolver path.
- **Read self-service spine:** the S2-c content-keyed versioned store + approve/retire lifecycle
  (`createReadSourceConfigStore`) — fork for the chain config; the S3-2 approved-only/key-only
  runtime route + `getForRuntime`; the values-free evidence builder (`readSourceProbeEvidence`)
  — the stitched evidence is a vector of these, never a new value-carrying shape.

## Non-goals (explicit)

- No write / Save / Submit / Audit / external write / production write (a different line).
- No recursive / unbounded expansion (a separate later design-lock).
- No runtime-supplied endpoint/filter/body/response-path or intermediate key.
- No exposure of intermediate resolved values in `data` or evidence.
- No auto-selection by status/version/date (stays fail-closed unique-only).
- No config-model, planner, or runtime impl in this doc (those are C-R1/C-R2/C-R3).

## Disposition

Direction only. Authorizes no runtime, no config-model impl, no planner, no chain executor,
no recursion, no write. Every rung (C-R1/C-R2/C-R3) and the recursion track remain separately,
explicitly gated. When opted in, the first implementable rung is **C-R1** (chain config model +
validator — pure/config-time, depth-bounded, acyclic, write-shaped-step-rejected; no runtime,
no chaining execution).
