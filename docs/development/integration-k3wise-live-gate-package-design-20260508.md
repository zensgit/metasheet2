# Design: K3 WISE Live GATE Execution Package

**Date**: 2026-05-08
**Files**:
- `docs/operations/integration-k3wise-live-gate-execution-package.md` (new)
- `docs/development/integration-k3wise-live-gate-package-verification-20260508.md` (new — this design's matching verification)

---

## Problem

Today the K3 WISE live PoC inputs are split across three sources:

- The GATE JSON shape lives in
  `scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample`.
- The hard-constraint contracts (what `normalizeGate()` throws on) are
  scattered across that same script.
- The on-prem preflight script (PR #1433) consumes the same customer-supplied
  K3 connection in env-form (`K3_API_URL`, etc.) — a different shape from
  the GATE JSON.

There is no single document that:

1. Lists, in plain language, what the customer must supply.
2. Maps each customer-supplied value into our two preflight inputs (env-form
   for #1433, JSON-form for the live preflight).
3. Spells out the execution sequence from "deploy is up" to "evidence
   compiler returns PASS", with explicit PASS/FAIL gates per step.
4. States that live preflight is gated by customer GATE arrival.

Operators preparing the customer engagement have to reverse-derive items 1–4
from the scripts. The cost is ~1–2 hours per engagement and a meaningful
risk of misreading a constraint (e.g., not realising that
`k3Wise.autoSubmit=true` would be rejected, or that core-table writes are
blocked unless `sqlServer.mode=readonly`).

## Goal

Produce a single operator-facing reference (`docs/operations/integration-k3wise-live-gate-execution-package.md`)
that is fact-checked against the scripts at this commit and explicitly
boundary-marks the live PoC: no production writes, Save-only enforced,
live preflight blocked until customer GATE arrives.

## Non-goals

- New runtime / script behaviour. PR is doc-only — three new files, zero
  code, zero existing-doc rewrites, zero `.gitignore` changes.
- Replacing `--print-sample` as the schema source of truth. The doc points
  at the script and tells operators "the script wins on conflict".
- Replacing `docs/operations/k3-poc-onprem-preflight-runbook.md` (PR #1437)
  or `docs/operations/integration-k3wise-internal-trial-runbook.md`. The
  new package references both and explicitly avoids re-documenting the
  bridge-IP recipe or the host-shell mint pattern they each cover.
- Producing customer-facing GATE intake or on-site evidence templates.
  Those gaps are listed in the new doc's "Stage D" but not filled — they
  are best filled when customer answers actually arrive (driven by real
  questions, not invented ones).

## Design

### Sections in the new package

| Section | Contents |
|---|---|
| Purpose | Frames the doc as a single source for live PoC orchestration; explicit non-overlap with #1437 / internal-trial runbook. |
| When to use | Four trigger states (post-deploy, before sending intake, during answer review, during PoC execution). |
| Conventions | Four invariants — schema source of truth, hard-contract enforcement location, secret hygiene, **live-blocked-until-GATE statement**. |
| Stage A — Customer GATE intake | Six tables (A.1 test scope; A.2 K3 connection; A.3 PLM source; A.4 field mappings; A.5 SQL Server channel — optional; A.6 rollback contract) with field name, purpose, and hard constraint. |
| Stage B — Field ↔ env / JSON mapping | One table mapping GATE JSON path → on-prem preflight env var. Operator-only env (`DATABASE_URL`, `JWT_SECRET`) explicitly noted as not customer-facing. |
| Stage C — Execution sequence with PASS/FAIL | Eleven steps C0–C10. Each row: name, when, command, PASS criterion, FAIL criterion. |
| Stage D — Existing-doc coverage and gaps | Six-row coverage table + three-item gap list with priority rationale. |
| Stage E — Secret hygiene | The four pre-share grep commands from #1437's runbook plus a note that they apply unchanged to this package's artifacts. |
| See also | Index of every script and runbook referenced. |

### Fact-check discipline

The verification MD enumerates the five operator-stated requirements and
shows the literal grep / diff results on the runbook content at this commit.
The runbook was iterated to PASS those five checks before the verification
MD was finalised. Specifically:

1. No secret-shaped strings (zero matches across `eyJ…` / `Bearer …` /
   non-redacted postgres userinfo / non-redacted secret URL query params).
2. All referenced repo paths exist (7/7).
3. Env-var set referenced in the doc is identical (set-equal) to the env
   names the on-prem preflight script reads.
4. The only `production` mentions are reject / forbidden / audit contexts
   (zero claims of production write).
5. Live preflight is blocked at C2 until customer GATE; the conventions
   section spells this out as an explicit invariant, not just an inferred
   side-effect of the gate-blocked exit code.

### Why this is a separate doc, not an addendum

- `k3-poc-onprem-preflight-runbook.md` is keyed by **check ID** (it answers
  "the preflight returned X — what now?"). Adding customer-facing GATE
  semantics or an end-to-end execution sequence would dilute its
  per-check fix-recipe focus.
- `integration-k3wise-internal-trial-runbook.md` covers a **different
  phase** (post-deploy auth smoke, before any K3 conversation). Mixing
  customer-facing GATE intake into it would muddle that phase boundary.
- The new doc lives in `docs/operations/` next to its peers, follows the
  same `integration-k3wise-*.md` prefix convention, and explicitly
  cross-links forward to both.

### Branch and PR layout (planned, executed only after #1442 merges)

- Branch: `codex/integration-k3wise-live-gate-package-20260508`, forked from
  `origin/main` after the `docs(integration): expand K3 WISE internal-trial
  runbook with host-shell path` PR (#1442) is merged.
- PR contains exactly three files:
  1. `docs/operations/integration-k3wise-live-gate-execution-package.md`
  2. `docs/development/integration-k3wise-live-gate-package-design-20260508.md` (this file)
  3. `docs/development/integration-k3wise-live-gate-package-verification-20260508.md`
- No `.gitignore` change (the package writes no artifacts of its own; the
  artifacts it references are already gitignored under
  `artifacts/integration-k3wise-onprem-preflight/` and
  `artifacts/integration-k3wise/internal-trial/` by earlier PRs).

## Affected files

| File | Change |
|---|---|
| `docs/operations/integration-k3wise-live-gate-execution-package.md` | New — ~230 lines. |
| `docs/development/integration-k3wise-live-gate-package-design-20260508.md` | New — this file. |
| `docs/development/integration-k3wise-live-gate-package-verification-20260508.md` | New — five-point validation matrix. |

No source code change. No script change. No CI workflow change. No package
manifest change. No `.gitignore` change.

## Deployment impact

None.

## Customer GATE status

PR is **outside** the GATE block — and is in fact the first artefact whose
explicit purpose is to **prepare for** the GATE arriving:

- Doc-only.
- No real ERP business behaviour added.
- `plugin-integration-core` runtime / adapters / pipelines / runner are all
  untouched.
- Stage 1 Lock memory ("until GATE PASS, no new战线 / no integration-core
  touch; 内核打磨 permitted") remains in force; this PR fits clearly inside
  "内核打磨" — the script invariants it documents are already shipped
  (PR #1433 / #1437 / pending #1442) and live preflight remains blocked
  until customer answers arrive.
