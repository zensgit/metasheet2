# Data Factory — User Flow & IA Design Verification - 2026-05-26

## Scope

Verifies the UX/IA design doc's framing + scope-lock. **UX/IA design, not code — no behavior to test yet.** UX implementation, when it happens, is a separate gated opt-in with its own verification.

## Guardrail / requirement → design section

| Gate | Where | Status |
|---|---|---|
| **G1 — integrate into the family, avoid drift** | "Relationship to adjacent Data Factory decisions": #1838 = umbrella, #1839 = data model, this = UX/IA; cross-refs #1826/#1835/#1709 | PASS |
| **G2 — UX/IA only; reference (not re-derive) the data model** | The 5-stage table anchors each stage to #1839 objects / #1826 / #1709 by reference; defines screens/flow/navigation, not data shapes | PASS |
| **G3 — docs-only; later impl stays gated** | Boundaries: "no runtime; UX implementation is a later, separate gated opt-in; nothing auto-built" | PASS |
| Absorb Yida structure, not its engine | "Why an IA layer": 5 Yida stages → multitable workflow; explicitly no canvas / user code / raw SQL | PASS |
| K3 = preset, not center | stated in Scope + Boundaries | PASS |
| Frozen surfaces stay frozen | Boundaries: no Submit/Audit/BOM/multi-record/read-unlock/server-composition | PASS |

## Lock conformance

- **Files:** 2 docs under `docs/development/`. No runtime / adapter / migration / `plugin-integration-core` / frontend code.
- The doc is purely UX/IA + navigation; it references shipped pieces (#1828 completeness preview, #1832 A4 shape) and #1839's model without changing them; all frozen surfaces explicitly deferred.

## Boundary

- Verifies framing + scope-lock only; no executable behavior exists.
- This is the **third/final** 阶段二 seed doc (direction + data-model + UX/IA); further 阶段二 detail waits for K3 PoC evidence (#1838 gating).

## See also
- `data-factory-user-flow-ia-design-20260526.md` (the design) · #1838 · #1839 · #1826 · #1828 · #1830 · #1832 · #1835 · #1709.
