# CALC14 business-effective strict source history

## Parent and ratified behavior

Finish CALC14 as-of workDate under the existing strict fixed_shift/FSER and W7 contracts. New changes have an explicit business-effective date and retain complete immutable prior input versions. Recorded time is not business-valid time. Existing frozen calculation/request snapshots do not change. Unknown or incomplete prehistory refuses first-unfrozen historical calculation; never backdate current values. Historical entry uses a separately authorized validated path and is not inferred from ordinary save time.

Retained inputs must cover every mutable fact actually consumed by attribution/strict issuance: desired shift/window, strict shift payload and segments, relevant timezone and rule inputs, and applied/member publication/withdrawal applicability. Configuration revision alone is insufficient. Select one unique applicable version under existing source/identity locks, reuse the existing FSER derivation and W7 V2 issuer, and preserve frozen_prior/ordinary correction semantics. Source history is input provenance, not a second group/date calculation freeze store. Keep runtime default-OFF; do not create or ratify new flags to bypass existing boundaries.

## Gates

| Gate | Required evidence |
|---|---|
| Temporal contract | Explicit valid date versus recorded-at; immutable complete versions; no-op save produces no false version |
| Writer transaction | Actual typed create/update/apply/rebuild/clear/member-publication writers retain required source inputs and rollback atomically |
| As-of resolution | Same group/shift, A at T and later B at D; first historical calculation submitted after D uses A for T and B for D |
| Complete source | Group/rule/shift/segment/applicability history is complete, or refusal occurs before canonical calculation/write |
| Frozen compatibility | Existing frozen A correction after B reuses A and does not modify prior frozen bytes |
| Refusal and isolation | Missing history, ambiguity, uncovered dates and foreign identity fail closed without fabricated sources or writes |
| Storage | Migration source only in live Kysely TS stream; synthetic owned DB apply/down evidence when needed, never target apply; down data-loss preservation stated |
| Validation and review | Newly affected focused/native cases only, restore mutation fault, one effective independent review, accurate Draft PR/residuals |

## Authority and execution boundary

The owner explicitly chose correction option A and accepted the CALC14 recommended business semantics on 2026-10-30. The pinned decision receipt is artifacts/attendance-mut06-expanded-source-closure-20261029/owner-correction-A-and-calc14-recommended-ratification-20261030.json, SHA256 4bde92b4ceee7881ef0f9db28d9949ab1df87c55becc6ae27c810eac26be587d, in the owning remote workspace. This is Draft engineering authority; target installation, migration, deployment, provider writes and enablement remain unauthorized. Stream/lifecycle/externalwrites stay OFF. R71 is excluded. No passed unchanged suite is rerun.

Base: 07e4517c6448fa2485e9295494b706c56668cd77 (fresh origin/main). Existing open Draft source/evidence is historical input, not current target runtime proof. New logic belongs in sibling modules. Existing disabled and legacy behavior must remain byte-identical for admitted old inputs; no guard, assertion, scanner, window, budget or FK weakening. No new platform history framework or frozen-context builder. Values-free errors and evidence.
