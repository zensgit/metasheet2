# AI output as an UNTRUSTED WRITE SOURCE — boundary design-lock (v0.2) — 2026-07-05

> **What this locks.** Before any feature routes an AI model's output into a *privileged sink* — a
> `select`/`enum` field, an executable `formula`, an `automation` action, a `cross-base` write, or the
> `plugin` SDK — the boundary is locked HERE. Model output is **untrusted DATA, never a trusted command.**
> It carries no authority, is validated fail-closed against the target domain, and must re-pass the same
> permission / no-oracle / write membrane every human-originated write passes.
>
> **This is a doc-only boundary lock (PR-A shape).** No runtime in this PR. It is a PRECONDITION on any
> future sink-opening slice, not a feature. Grounded on `origin/main` @ `65ee03ebf`.
>
> **Why now, not later.** The downstream sandbox that might otherwise have contained a bad AI-derived write
> **does not exist today** (§0). So this boundary cannot be deferred to "when we wire the sink" — by then the
> probeable window is already shippable. Locking it first makes every sink-opening PR inherit a fixed bar.

## 0. Verified facts on main (the reason this lock is load-bearing)

- **No downstream sandbox backstop.** `PLUGIN_SANDBOX_ENABLED==='true'` STILL returns `NoopSandbox`
  (`packages/core-backend/src/core/plugin-sandbox.ts:8-16`, `createSandbox()` is a "Placeholder", `NoopSandbox.wrap`
  returns the plugin unchanged); the CJS runtime path is explicit that "sandbox code execution remains unavailable …
  callers get an explicit error instead of a false sense of isolation"
  (`packages/core-backend/src/security/plugin-runtime-security-service.ts:117-119`). **vm2 is NOT a live boundary and
  must not be cited as one.** Any untrusted-code-or-data containment must be enforced at the *call site*, not assumed
  downstream.
- **Today's AI blast radius is small — by construction, not by luck.** AI shortcut targets are `string|longText`
  ONLY (`packages/core-backend/src/multitable/ai-shortcut-config.ts:33-34`: "classify writes the label TEXT — select
  targets are a later ring"); output lands in a cell via the authoritative patch path; the ledger stores no prompt/
  completion text. The moment a target becomes a `select`/`enum`, or output feeds a formula/automation/cross-base/
  plugin sink, the blast radius changes class — that transition is exactly what this lock gates.
- **`classify` output is prompt-constrained, not server-enforced.** The option set is a prompt instruction; the server
  does NOT enforce `output ∈ options` today. Acceptable while the target is free text; a hard gate the instant the
  target has a domain (§2-B).
- **The membrane already exists for human writes.** Cross-base established the pattern: two-leg authority
  (`resolveCrossBaseWriteAuthority` + record-level eligibility), per-record no-oracle (`MIRROR_LINK_TARGET_UNAVAILABLE`
  uniform), `meta_sheets FOR UPDATE` serialization, default-off + enablement gate. AI-derived writes reuse THIS; they
  do not get a parallel, weaker path.

## 1. Threat model (one sentence)

An attacker who can influence any source cell that flows into an AI prompt (own data, shared record, imported row) can
influence the AI's *output*; if that output is later treated as a *command* or as a *pre-authorized* write, the attacker
has laundered untrusted input into a privileged action. The only defense that holds without a downstream sandbox is to
treat the output as untrusted data at the sink and re-impose the full membrane.

## 2. Locked hard rules (A / B / C — NOT relitigated downstream)

- **A — AI output carries NO authority.** A write fed by AI output derives its authority SOLELY from the invoking
  user / current actor, exactly as if the user had typed the value. It is NEVER elevated because "the system generated
  it," never runs as a service/automation identity that the user lacks, and never bypasses a gate the user's own edit
  would hit. Authority attaches to the actor, not to the provenance.
- **B — Domain validation is FAIL-CLOSED; reject, never coerce.** AI output entering a typed sink
  (`select`/`enum`/typed field/formula operand/automation parameter) MUST be validated against the target domain and
  **rejected** if invalid. Silently coercing an out-of-domain `classify`/`extract` result into a "nearest" valid value
  is itself a silent-corruption vector and is forbidden. Reject → surface a stable, explicit, fail-closed error (e.g.
  `AI_OUTPUT_DOMAIN_INVALID`) that does not reveal hidden domain details; do not write.
- **C — injection→action is FAIL-CLOSED and NO-ORACLE, end to end.** When AI output enters an `automation`,
  `formula` execution, `cross-base` write, or the `plugin` SDK, it re-passes the SAME permission membrane as a
  human-originated write: authority (§A) → domain validation (§B) → per-record no-oracle mask → write under the
  established lock family. No sink may auto-execute AI output. **Availability / authority / visibility** denials along
  the chain are uniform and non-distinguishing (masked ≡ missing ≡ not-writable), so the sink leaks no existence/authority
  oracle. **Domain-validation** failures are a separate class: they use a stable, fail-closed error (§B) that must not
  reveal hidden domain details, but need NOT be byte-identical to an availability/authority denial (over-uniforming them
  buys no security and needlessly constrains UX).

## 3. Sink → membrane map (what each future sink MUST reuse)

| Sink | Must reuse (no parallel weaker path) |
|---|---|
| `select`/`enum` field write | §B domain gate (output ∈ option set, fail-closed) + normal field-permission write gate |
| executable `formula` operand | §A (actor authority) + §B (typed operand) + existing dry-run-before-run discipline; AI never auto-runs a formula |
| `automation` action parameter | §A + §B + §C; AI output is an untrusted parameter, re-validated inside the action's own authority check, never a trigger to run at elevated identity |
| `cross-base` write | the full C2 membrane: `resolveCrossBaseWriteAuthority` + record-level eligibility + `MIRROR_LINK_TARGET_UNAVAILABLE` no-oracle + `FOR UPDATE`; AI provenance grants nothing extra |
| `plugin` SDK record methods | AI output crossing into a plugin-reachable method is untrusted on BOTH ends (plugin is untrusted caller AND output is untrusted data); no sandbox backstop (§0) → gate at the call site |

## 4. Fail-first golden spec (what a sink-opening PR-B MUST prove — none exist yet)

Every sink-opening slice ships real-DB, fail-first goldens whose discriminator is *sound* (distinguishes fixed-vs-unfixed,
not a bare green status):

- **G-A (no laundered authority).** An actor who CANNOT perform write W directly also cannot perform W via an AI-output
  path. Reverting the actor-authority binding turns G-A RED.
- **G-B (domain fail-closed).** An out-of-domain AI output (e.g. `classify` label ∉ option set) is REJECTED with a
  stable fail-closed domain error (need not be byte-identical to an availability denial; must not leak hidden domain
  details) and writes nothing; no coercion to a nearest option. Removing the domain gate → the write lands → RED.
- **G-C (injection→action no-oracle).** A masked/absent/not-writable target reached via an AI-output sink yields a
  byte-identical uniform denial (status + body), and no edge/row is written or removed. Moving any mask after the
  existence/effect read → responses diverge → RED.
- **fail-first evidence:** per §5, L3 load-bearing goldens (G-A/G-B/G-C) carry an **observed-RED** record, not only a
  structural argument.

## 5. L3 process rules (recorded here; apply to every sink-opening slice)

- **Trip-wire auto-escalation (no self-downgrade).** Touching ANY of {`auth`, `meta_links`, the AI usage `ledger`, the
  AI `provider` call, a `cross-base` write, or an **AI-output sink**} auto-classifies the slice **L3**, regardless of
  self-assessment. The tier choice is written into the PR / design-lock for review.
- **Independent golden authorship.** An L3 load-bearing golden is authored by — or adversarially reviewed by — a second
  perspective (independent agent or human reviewer) working from the SPEC, not the implementation, so the golden encodes
  the requirement, not "what the guard happens to do."
- **Observed-RED before merge.** For an L3 load-bearing guard, the PR records an actually-observed RED (temporarily
  revert the guard / break the condition, run the golden, capture the failure) — not merely "it would go red." If the
  full suite cannot be run, the PR states WHY and gives the alternative trace evidence. "Structurally fail-first" is the
  fallback, never the default.

## 6. Enablement gate — PRECONDITION LIST (written, NOT implemented here)

AI capability flags are not "done" at default-off. `MULTITABLE_AI_ENABLED`, live-provider confirm, AI bulk, and any
future AI-output sink each get a tracked ledger entry: **owner · precondition · last-reviewed date · flag-on smoke ·
rollback condition**. Standing preconditions before any such flag goes on in a shared deployment:

- **kill-switch verified** — the flag is re-read per request (map: `preflight()` per request), so flipping it off takes
  effect immediately; this rollback path is TESTED, not assumed.
- **cost observability + pre-cap alarm** — spend is visible approaching the cap, not only blocked at it (today's
  shared-fate instance-USD cap is otherwise a silent DoS surface).
- **`merged ≠ enabled ≠ safe-to-enable`** stated explicitly — three stages; the middle (build complete) is never the
  terminus.
- **injection posture + domain validation** (§2) reviewed for the specific sink being enabled.
- **per-tenant vs shared-fate cost policy** decided (no real tenant model today → "tenant" caps are per-user).

## 7. Doc↔impl drift gate

For an L3 design-lock, key named symbols must exist in the implementation or be **reconciled-or-justified** — prose may
not silently diverge from as-built. Watch-list symbols for this line: `resolveCrossBaseWriteAuthority`, `FOR UPDATE`,
`field_permissions` (write-side enforcement point), `unsafe_input` (and its coverage gaps), and any Idempotency /
reservation key. If a design-lock names a primitive the impl does not use (as happened once with `resolveBaseWritable`
→ as-built `canEditRecord`), the doc is reconciled to as-built with the reason recorded, not left to mislead.

## 8. Scope / non-goals

IN: the boundary rules (§2), the sink→membrane map (§3), the golden bar (§4), the L3 process rules (§5), the enablement
precondition list (§6), the drift gate (§7). OUT: any runtime; enabling any flag; opening any specific sink; a real
tenant model; an instruction-injection *classifier* (structural instruction/data separation + domain validation are the
v0.2 posture, not a semantic jailbreak detector). Read/mask/authority semantics are reused, not changed.

## 9. Sequence

This lock (PR-A, doc-only) → codify the L3 playbook + review-calibration checklist into `docs/` → adopt rigor tiering →
per-sink slices (PR-B each): domain gate for `select`/`enum` first (smallest, highest-frequency), then formula/automation/
cross-base/plugin, each all-at-once behind §2-A/B/C with G-A/G-B/G-C observed-RED goldens, default-off, tracked in the §6
enablement ledger. No sink opens until its slice proves the membrane.
