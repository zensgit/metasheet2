# Read-source resolver composition C-R0 → C-R3 — dev & verification — 2026-07-05

## Scope

This document records the as-built, verified state of the **read-source resolver composition** arc
(#1709) — chaining one approved configured read's single resolved output into a second approved
configured read (materialNumber → FItemID → FBOMNumber), **read-only throughout**. It closes out the
first three implementable rungs (C-R1 config model, C-R2 pure planner, C-R3 runtime executor) and
states precisely what remains gated.

It is a **status ledger, not an authorization**. C-R4 (route/UI/client-mirror), recursion, and any
write path remain separately, explicitly gated (see §6).

## 0. One-line arc position

```text
C-R0 direction lock  →  C-R1 config model  →  C-R2 pure planner  →  C-R3 runtime executor  →  [C-R4 route/UI: gated]
       (docs)              (#3553)               (#3563)               (#3565)                  (needs opt-in)
```

Standalone resolver (R0–R2, merged earlier on #1709) is the per-hop primitive each chain step reuses;
composition orchestrates hops, it does not fork a second read/resolver path.

## 1. Rungs as built

| Rung | PR | Merged SHA | What landed | Boundary held |
| --- | --- | --- | --- | --- |
| **C-R0** | (docs) | `integration-read-source-resolver-composition-design-lock-20260703.md` | Direction lock: bounded ordered approved-config chain, typed single-value handoff, per-hop + chain fail-closed, values-free stitched evidence, read-only; recursion excluded | Docs only — authorizes no runtime |
| **C-R1** | #3553 | `665504041` | Chain **config model + save-time validator**: migration `063_create_integration_read_source_composition_configs.sql`, content-keyed versioned store + approve/retire, depth-bounded (exactly two steps in v1), acyclic, write-shaped-step rejected | No runtime, no chaining execution |
| **C-R2** | #3563 | `7e9c844d4` | **Pure planner/evaluator**: `planReadSourceComposition` (reuses the C-R1 validator verbatim), `deriveCompositionStepInput` (typed single-scalar handoff via the runtime's own key predicate), `evaluateCompositionOutcome` (values-free per-step vector + last-hop-only data projection) | No route, no outbound, no adapter, no persistence, no write, no recursion |
| **C-R2 hardening** | #3568 | *(in-flight, parallel session)* | Two seam fail-closes: (1) `planReadSourceComposition` requires an approval-config map (omission = PLAN_INVALID, not a preview); (2) a hop is a success only when `evidence.ok === true` **and** it carries a chain-usable scalar | Same scope fence; pure lib |
| **C-R3** | #3565 | `e68fe39ce` | **Chain runtime executor**: `executeReadSourceComposition` — orchestrates approved step configs in order, per-hop fail-closed, values-free stitched evidence, read-only; reuses S3-1 `executeConfiguredRead` + R1 resolver per hop | No route, no persistence lookup inside, no write, no recursion, no new credential path |

## 2. The locks, and where each is enforced

The C-R0 design-lock defines eight locks. Where each lands in the shipped code:

| Lock | Enforcement point |
| --- | --- |
| **L1 — bounded ordered APPROVED configs** | C-R1 validator (`status==='approved'` / `resolver_lookup` / `read-only` / handoff-target match, depth 2, acyclic). C-R3 re-runs it over the resolved per-step bundle as **defense-in-depth over the route load**, and coerces any non-`'approved'` status (incl. missing) to a fail-closed marker so a statusless bundle cannot slip through. C-R2 #3568 makes the approval-map mandatory at the planner seam. |
| **L2 — typed single-scalar handoff** | `deriveCompositionStepInput`: prior hop's resolver output target must match the config-declared wiring; the value passes the **same** `normalizeReadSourceProbeInputs` key predicate every read uses (imported, not re-stated — no mirror drift). |
| **L3 — runtime request key-only** | C-R3 `normalizeCompositionRuntimeRequest`: strict `{ inputs: { key } }` allowlist at the chain boundary (config override / per-hop key / extra field rejected, not dropped). Intermediate keys are **derived by the platform**, never runtime-supplied. |
| **L4 — per-hop + chain fail-closed, downstream never runs** | `deriveCompositionStepInput` is the single gate between hops in C-R3's loop (a failing derive aborts before the next outbound read); `evaluateCompositionOutcome` clamps every post-failure ordinal to `STEP_NOT_RUN`, so the vector cannot certify a downstream execution after an abort. Verified as an **outbound-call** property (aborted hop issues zero reads), not just a vector property. |
| **L5 — values-free stitched evidence; last-hop-only data** | `evaluateCompositionOutcome` builds a `{step, ok, rule?, errorCode?}` vector (coarse codes + ordinals only) and re-projects chain data from a **single validated snapshot** of the last hop's output — the intermediate resolved value, candidate values, field/target names, host, credential, tenant/system id, and the runtime key never ride into evidence. |
| **L6 — read-only** | Every hop is `executeConfiguredRead` (read). No write path anywhere; C-R3 tests assert the adapter write surface is never touched (`writes===0`). |
| **L7 — idempotency / retry** | No state, no write; a re-run with the same first key re-reads deterministically. Platform timeout + row cap apply per hop (reused constants). |
| **L8 — authorization / tier** | Composition config authoring = write-tier (C-R1 store approve/retire); running an approved chain = read-tier (approved-only, key-only). |

## 3. Adversarial verification (per rung)

Each code rung went through the multi-lens adversarial-verify pattern (independent attack lenses →
refute-verification) on top of ordinary review. Confirmed findings were fixed with red tests before
merge.

**C-R2 (#3563)** — 2 review findings + 5 adversarial findings, all fixed:
- P1 zero-step shaped plan crashed instead of failing closed → `isPlanShaped` requires the C-R1 step
  bounds + handoff arity; zero/one-step/wrong-arity → `PLAN_INVALID` from both evaluate and derive.
- P2 token-shaped errorCode guard let unregistered `A_CODE`-shaped values (e.g. a leaked
  `MAT_001_SECRET`) into stitched evidence → guard is now the exact registered probe/resolver code set.
- Accessor-bearing hop data could **throw** out of `evaluateCompositionOutcome`, and a TOCTOU getter
  could pass validation then smuggle an unvalidated object into chain data via a second read →
  `snapshotResolverData` reads each hop field **once**; validation and projection share that read; all
  exports fail-closed-catch (exception messages never escape).
- L5 chain-data stripping had no red test (a `{...spread}` regression would ship green) → `deepEqual`
  shape pin + sentinel scans.
- `isResolverData` was narrower than R1's real emission set (R1 can resolve a boolean/object
  standalone) → the chain-only scalar narrowing is now **explicit** with a dedicated
  `STEP_OUTPUT_NOT_SCALAR` code; R1/R2 standalone behavior unchanged.
- Handoff failure vocabulary pinned (MISSING = never resolved / MISMATCH = wrong target / INVALID =
  resolved-but-not-key-usable).
- L4 not enforced on the vector itself → post-failure entries clamped `STEP_NOT_RUN`.

**C-R3 (#3565)** — adversarial pass surfaced 3 items (the workflow's own verifiers refuted them as
caller-contract; the L1 one was independently reproduced and hardened anyway because it makes the
module's own stated defense-in-depth invariant hold):
- **L1 fail-OPEN closed** — a per-step bundle **lacking a `status` property** slipped through as
  approved and ran the full chain (reproduced: `ok=true, reads=2`), because the C-R1 validator's status
  check is optional at save-time. The runtime now coerces any non-`'approved'` status to `'not_approved'`
  before planning; a statusless bundle fails closed (`PLAN_INVALID` / `STEP_NOT_APPROVED`, `0 reads`).
  Safe direction: if the future C-R4 route forgets to populate status, the chain fails closed loudly
  instead of silently running an unapproved step.
- Non-scalar handoff abort got an end-to-end red test (hop 0 resolves a K3 boolean → chain aborts with
  `STEP_OUTPUT_NOT_SCALAR`, hop 1 never reads, `writes===0`, values-free).
- L3 named request-shape vectors got red tests (JSON `__proto__` own-key rejected at body+inputs,
  getter-on-key read exactly once, object/array key fails closed at hop 0 with no outbound read).

**C-R2 hardening (#3568, in-flight)** — cross-verified against merged C-R3: after rebasing #3568 onto
main-with-C-R3, the full composition suite (planner + runtime + neighbors) is green; guard 2's
`evidence.ok` requirement is satisfied by C-R3's real-producer hops, and the non-scalar handoff test
still yields `STEP_OUTPUT_NOT_SCALAR`. The hardening does not regress C-R3.

## 4. Test inventory (all local-green; wired into the plugin `test` chain)

- `read-source-composition-config.test.cjs` (C-R1) — validator + store + migration.
- `read-source-composition-planner.test.cjs` (C-R2) — purity require-allowlist tripwire, plan
  approved-only/write-rejection, derive fail-closed matrix (runtime key bounds 128 / control-char /
  non-scalar), accessor/throw/TOCTOU never-throw, L5 strip, scalar-narrowing, L4 clamp, vocabulary.
- `read-source-composition-runtime.test.cjs` (C-R3) — happy-path two-hop (derived intermediate key on
  hop-1 filter, last-hop-only data, values-free, `writes===0`), key-only request rejection, plan gate
  (draft/missing/statusless/malformed → PLAN_INVALID, no hop runs), non-scalar handoff abort, hop-0
  ambiguate/not-found abort (hop 1 never reads), hop-1 failure after hop-0 resolve, adapter-throw
  fail-closed (error message never leaks), kind-mismatch fail-closed, createAdapter required, L3 named
  vectors, proto-pollution-safe bundle lookup.

## 5. Reuse discipline (no forked path)

Each chain hop is one `executeConfiguredRead`; composition **orchestrates** hops, it does not fork a
second read/resolver path:

- per-hop selection = the R1 evaluator (invoked inside `executeConfiguredRead` for `resolver_lookup`);
- per-hop outbound = the S3-1 executor's promoted S2-b builders (same overlay, same request, same
  error classification as the probe/read paths);
- the key predicate between hops = the runtime's own `normalizeReadSourceProbeInputs` (imported);
- the approval gate = the C-R1 validator (re-run at runtime as defense-in-depth).

## 6. What remains gated (each a separate explicit opt-in)

The read-only composition executor is **code-complete through C-R3**. Everything below is **not**
authorized by this document:

- **C-R4 — route + config-store approved-only load + client vocab mirror + UI.** Wiring
  `executeReadSourceComposition` to an HTTP route means: (a) a new external surface, (b) the C-R1 store's
  approved-only `getForRuntime` load per step, and (c) a **client/server closed-vocabulary mirror**
  obligation for the composition error codes (the resolver line already carries such a mirror with a CI
  tripwire — a composition route/UI must extend or add the equivalent). This is the natural next rung and
  needs an explicit opt-in.
- **Recursive / unbounded BOM expansion** — a strictly-later, separate design-lock (fan-out, cycle
  detection, per-level budget, aggregate shape). Named in C-R0 so it is not silently folded into
  composition; not designed here.
- **Any write / Save / Submit / Audit / external write / production write** — a different line, and
  production external write is **customer-barred** (`SaveSubmitAuditK3Write` / `externalWrite` /
  `productionWrite` = false); it needs explicit authorization + sandbox-first, not a general directive.

## 7. Disposition

C-R1 / C-R2 / C-R3 merged and adversarially verified; the read-only composition chain
(materialNumber → FItemID → FBOMNumber shape) executes end-to-end behind approved-only / key-only /
values-free / fail-closed locks. C-R2 hardening (#3568) is in-flight and cross-verified compatible.
The arc rests at its opt-in boundary: **C-R4 (route/UI/mirror) is the next rung and awaits an explicit
opt-in.**
