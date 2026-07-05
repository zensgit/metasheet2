# Approval T3-3 node signature/compliance — declared-inert first rung — Design 2026-07-05

## Status

**Documentation-only.** The runtime for this rung already shipped and merged before this
documentation task was assigned — see [Grounding](#grounding) below. This document (and its
companion verification doc) exist to satisfy the repo's `docs/development/<area>-<slice>-{design,verification}-<date>.md`
convention retroactively, and to give a human reviewer a single place to check the already-shipped
slice against the ballot.

## Design lock reference

This rung is locked by `docs/development/approval-automation-third-batch-ballot-20260702.md`,
section **T3-3 — node signature / compliance · M-L**, all nine lines (Q1-Q9) ratified **✅
adopt-default** by the owner in commit `16461152f` / PR `#3590` ("docs(approval): owner votes T3-3
(all adopt-default) + T3-6 (hold)").

The relevant lines for *this* rung:

| # | Decision | Ratified default |
|---|---|---|
| Q1 | Signature kind | Contract-open `kind`; v1 ships typed/click attestation only. Image capture is a separate later rung. |
| Q2 | **Enforcement timing** | **First rung is declared-inert**: persist/round-trip `signaturePolicy`, do **not** block approve/reject until enforcement is separately ratified. |
| Q7 | Applies-to and exemptions | Default applies to approve only; approve+reject available. |
| Q9 | Authoring UI | Only if clearly labelled enforcement-pending; **this rung skips UI entirely** (backend round-trip only). |

Q3 (image storage), Q4 (integrity binding), Q5 (retention/legal hold), Q6 (PII echo), and Q8 (audit
shape) describe **later rungs** — capture, retention, and redaction do not exist yet, so those
decisions have nothing to bind to in this floor. They are recorded here for traceability only.

**Build contract (from the ballot's T3-3 "Build contract / reviewer-note must-fixes"):**

- First PR must prove `signaturePolicy` survives normalize → publish → reload → dispatch
  re-normalize.
- Default-absent nodes must remain byte-identical.
- If UI is included before enforcement, tests must prove it cannot imply runtime enforcement (N/A
  here — no UI shipped in this rung).

## What this rung locks

A node's `config` may carry an optional `signaturePolicy`:

```ts
interface SignaturePolicy {
  required: boolean
  kind?: string                          // contract-open (Q1) — e.g. "typed" | "click"
  appliesTo?: 'approve' | 'approve_reject'  // default approve-only (Q7)
}
```

- **Persisted and round-tripped** through the node-config JSONB whitelist (same mechanism as
  `fieldPermissions` / `timeout`) — survives create → publish → reload → dispatch re-normalize.
- **Fails closed** at save time (create/update/publish) on a malformed shape — never a coerced
  default, never a silent flatten/drop.
- **Default-absent is byte-identical**: a node with no `signaturePolicy` key emits no
  `signaturePolicy` key anywhere in the stored/returned graph, matching pre-existing behavior for
  every node that doesn't opt in.
- **No enforcement path exists.** There is no code anywhere that reads `signaturePolicy` to gate,
  block, or otherwise change approve/reject behavior. The rung is inert **by construction** — not
  by a flag that could later be flipped. Enforcing it would require writing new code in a later,
  separately-ratified rung, not toggling anything in this one.
- **No new audit action, no new CHECK migration** (Q8 scope): the policy lives entirely in the
  existing node-config JSON column; nothing is added to `approval_records` in this floor because
  nothing is ever captured yet.

## Explicitly NOT built in this rung

- Enforcement / blocking of approve or reject on a missing or unsatisfied signature (Q2 — later,
  separately-ratified rung).
- Image/handwritten signature capture or `StorageService` wiring (Q3).
- sha256 integrity binding to actor/instance/version/nodeKey/capturedAt (Q4).
- Retention horizon / legal-hold exclusion from generic erasure (Q5).
- PII-redacted reader view / compliance-export permission gate (Q6).
- Any new audit action or DB migration (Q8 — deferred until something is actually captured).
- Any authoring UI, labelled or otherwise (Q9 — this rung is backend round-trip only).

## Grounding

- Task grounding SHA (fresh `origin/main` at worktree creation): `4640f366217ed793a07116eaa26c60edfb6c6642`.
- The runtime for this exact rung is **already merged** on that `main` history as
  `b6947a481a0462d3d732ca0bea060c6b84afbf64` — PR
  [`#3512` "feat(approval): T3-3 node signaturePolicy (declared-inert slice 1)"](https://github.com/zensgit/metasheet2/pull/3512),
  merged 2026-07-03T05:42:31Z, **before** the ballot's T3-3 lines were formally voted (2026-07-05,
  commit `16461152f` / PR `#3590`). The shipped implementation matches the ratified defaults
  exactly (independently re-verified — see the companion verification doc).
- Because the runtime, its golden test, and its CI wiring are already on `main`, this task
  produces **no runtime diff**. See the verification doc for the independent re-verification
  performed against `origin/main` as part of this task.
