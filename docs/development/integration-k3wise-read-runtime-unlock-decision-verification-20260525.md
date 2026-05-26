# K3 WISE read-only runtime UNLOCK — Decision/Design Verification (S3) - 2026-05-25

## Scope

Verifies the S3 decision/design doc against the requested gates. This is a **decision + design document — nothing is implemented, so there is no behavior to test.** It verifies the doc's framing, scope-lock, and issue-citation accuracy.

## Requirement → design section

| Required gate | Design section | Met |
|---|---|---|
| First-order question is **whether to UNLOCK** read-only runtime, not interface design | §Scope (decision-first) + §1 "The decision (first-order — owner's call)" with options (a)/(b)/(c) | ✅ |
| Carve **minimal slice from #1593**, do NOT redesign read/list | §2 — reuses #1593 `read` surface / read metadata / `K3_WISE_READ_*` taxonomy verbatim; defers O2/O3/O4 + master-object + BOM read | ✅ |
| Scope only **Material reference resolution** (in: `templateMaterialNumber` read-key **+** reference field(s) to harvest · out: the reference object(s) already in that Material's detail · use: S2/A4 preview + future S4) | §2 — input distinguishes read-key vs reference field; **HARD BOUNDARY: Material-detail harvesting, NOT a generic master-code resolver** (arbitrary unit/account code → object needs master-object read or mapping, out of slice) | ✅ |
| Explicit **read-only**: no K3 write / BOM / Submit/Audit / multi-record | §3 — all four stated; single-key read only; `K3_WISE_READ_*` ≠ Save error; read is opt-in per object | ✅ |
| Explicit **composition location**: client/operator = lock-safe; server pipeline transform = frozen unless owner unlocks | §4 — both stated explicitly | ✅ |
| **This doc does NOT implement**; runtime is a separate opt-in PR | §5 + §Boundary — impl gated on owner unlock AND #1593 O1–O6; sequence spelled out; #1709 is the runtime track | ✅ |
| Issue numbers: cite **#1593** as contract source; verify **#1709** before citing; don't bake unverified | §Issue references — #1593 cited; **#1709 confirmed via `gh issue view 1709` (OPEN, "[Post-GATE] K3 WebAPI read/list adapter for Material/BOM")** before citing; #1526 noted as the closed umbrella | ✅ |

## Lock conformance

- **Files:** 2 docs under `docs/development/`. No runtime, adapter, migration, or `plugin-integration-core` change.
- The doc explicitly keeps read/list runtime frozen (impl = separate #1709 opt-in after unlock) and keeps server-pipeline composition, BOM, Submit/Audit, multi-record frozen. Read-only single-key slice is the *most* it proposes — and only as a decision to be made, not made here.

## Boundary

- Verifies decision/design framing + scope-lock + citation accuracy only; **no executable behavior exists**.
- The unlock decision is the owner's; this PR does not make it.
- Implementation conformance (when/if unlocked) is the future #1709 runtime PR's own verification (against the #1593 acceptance matrix).

## See also
- `integration-k3wise-read-runtime-unlock-decision-20260525.md` — the decision/design this verifies.
- #1593 (read/list contract), #1709 (runtime track), #1792 (GATE evidence), #1828 (S2), #1832 (A4).
