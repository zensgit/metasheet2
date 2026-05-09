# Design: K3 WISE Live GATE Execution Package — Rehearsal Fixups

**Date**: 2026-05-09
**Files**:
- `docs/operations/integration-k3wise-live-gate-execution-package.md` (modified)
- `docs/development/integration-k3wise-live-gate-rehearsal-20260509.md` (already drafted as untracked; included in this PR as the supporting evidence artifact)
- `docs/development/integration-k3wise-live-gate-rehearsal-fixups-verification-20260509.md` (this design's matching verification)

---

## Problem

PR #1445 landed the live GATE execution package with five-point validation
against script behaviour at that commit. After the merge, an internal
rehearsal walked the C0–C3 sequence end-to-end on a workstation using a
synthetic GATE answer (RFC 6761 `.test` hostnames, sanctioned credential
placeholders only). The rehearsal was successful as a script-and-script-
output validation but surfaced three operator-facing footguns the doc
glossed over:

- **G1** — The C1 row's PASS criterion includes
  `pg.tcp-reachable / pg.migrations-aligned / fixtures.k3wise-mock all pass`,
  and the example command is `node … --mock --out-dir <art>`. A new operator
  starting from a cold shell with no env exported gets `FAIL exit 1` on
  `env.database-url` and `env.jwt-secret`, the C1 PASS path is unreachable,
  and there is no doc cross-link explaining either where to source those env
  vars on a real deploy host or how to satisfy them for a workstation
  rehearsal.
- **G2** — The C2 row's FAIL column says only
  `exit 1 (mandatory) or exit 2 (GATE_BLOCKED — customer field still missing)`.
  When the on-prem preflight returns `k3.live-reachable: fail` with a TCP
  error code (`ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT`),
  the actual fix recipes live in
  `docs/operations/k3-poc-onprem-preflight-runbook.md` (PR #1437) — but the
  C2 row does not link there. A first-time operator hitting the diagnostic
  has to discover that runbook on their own.
- **G3** — Stage E's pre-share self-check shows four greps but says nothing
  about pipeline exit-code semantics. Operators wrapping the preflight
  scripts in `node … | head -n …` shells (a common evidence-capture
  pattern) silently record `exit: 0` even when the script returned `1` or
  `2`, because pipefail is off by default. The rehearsal's own harness
  fell into this trap.

Each fix is small and depends only on internal observations — they do not
require customer-supplied information to validate.

## Goal

Close the three operator footguns with the smallest possible runbook
additions, traceable line-by-line to the rehearsal evidence in the
included findings MD. No script change, no CI change, no `.gitignore`
change.

## Non-goals

- Re-architecting Stage C or restructuring the execution sequence.
  C0–C10 retain their current PASS/FAIL gates; only their inline
  prerequisites and cross-links are tightened.
- Adding the `K3_SESSION_ID` env path to the on-prem preflight to close
  the C2-vs-C3 sessionId-only divergence. That is a script change and is
  out of scope here. The runbook already calls the divergence out under
  A.2 (added in PR #1445's tightening commit).
- Filling in the customer-facing GATE intake template / on-site evidence
  collection template that PR #1445's Stage D listed as gaps. Those
  remain best-driven-by-real-customer.

## Design

### Runbook edits

| ID | Edit | Where |
|---|---|---|
| G1 | C1 row's command cell gains "(see [C1 prerequisites](#c1-prerequisites) below)"; FAIL cell points operators at the same anchor when env defects fire. A new "C1 prerequisites" subsection follows the Stage C table with two operating modes (real-deploy-host with `DATABASE_URL`/`JWT_SECRET` already exported, vs workstation rehearsal with `--skip-tcp --skip-migrations` and synthetic env). The workstation example uses sanctioned placeholders only. | Stage C row C1 + new subsection |
| G2 | C2 row's FAIL cell gains a sentence cross-linking to `docs/operations/k3-poc-onprem-preflight-runbook.md` § "Per-check failure recipes" for `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT` diagnostics on `pg.tcp-reachable` and `k3.live-reachable`. | Stage C row C2 |
| G3 | Stage E gains a "Shell-pipeline exit-code hygiene" subsection after the four-grep self-check. Two example patterns: `set -o pipefail` first, or capture `$?` directly before any pipe. | Stage E |

### Provenance trail

The rehearsal-findings MD lives in `docs/development/` next to other
development evidence (postmortems, design notes, verification reports).
Each runbook edit references a literal observation in that MD:

- G1 ↔ rehearsal §"Executed sequence" rows C1 (cold) and C1', plus
  finding §G1.
- G2 ↔ rehearsal §"Executed sequence" row C2, plus finding §G2.
- G3 ↔ rehearsal §"Findings"§G3 (the harness self-bug observed during
  the rehearsal).

A reviewer reading the runbook diff alongside the rehearsal MD can trace
every line of doc change back to a reproducible command and a literal
failure mode.

### Re-running C0–C3 with the patched runbook

The verification MD captures a fresh re-run of C0–C3 on the **patched**
runbook, demonstrating that:

1. The C1 cold-start FAIL path is now resolvable by following the runbook
   alone (no external knowledge required).
2. The C2 FAIL diagnostic still fires with the same content as before
   (the script is unchanged), but the operator now has an inline cross-link
   to the per-error-code fix recipes.
3. Stage E's pipefail guidance produces the correct exit-code capture in
   a representative shell pipeline.

This is the symmetric counterpart of PR #1445's verification matrix —
where #1445 verified the runbook described the script accurately, this
PR's verification confirms the patched runbook unblocks the operator
paths the rehearsal exposed.

## Affected files

| File | Change |
|---|---|
| `docs/operations/integration-k3wise-live-gate-execution-package.md` | Stage C C1 row + new "C1 prerequisites" subsection; Stage C C2 row FAIL cell cross-link; Stage E new "Shell-pipeline exit-code hygiene" subsection. |
| `docs/development/integration-k3wise-live-gate-rehearsal-20260509.md` | New (was untracked draft). Captures the literal commands run on 2026-05-09 and the three findings with proposed fixes. |
| `docs/development/integration-k3wise-live-gate-rehearsal-fixups-design-20260509.md` | New — this file. |
| `docs/development/integration-k3wise-live-gate-rehearsal-fixups-verification-20260509.md` | New — re-runs C0–C3 with the patched runbook and confirms the fix paths. |

No source code change. No script change. No CI workflow change. No
`.gitignore` change.

## Deployment impact

None.

## Customer GATE status

PR is **outside** the GATE block:

- Doc-only.
- No real ERP business behaviour added.
- `plugin-integration-core` runtime / adapters / pipelines / runner are
  all untouched.
- Stage 1 Lock memory ("until GATE PASS, no new战线 / no integration-core
  touch; 内核打磨 permitted") remains in force.
- This PR closes three internal footguns surfaced by a rehearsal that
  used only synthetic data. No customer information was used.
