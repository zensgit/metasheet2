# K3 WISE Stage 1 Internal Closeout — 2026-05-09

## Purpose

Snapshot of the K3 WISE Stage 1 internal work completed before the customer
GATE answers arrive. Captures what shipped, where the work paused (and why
that pause is correct), what is gated on customer input, and what remains
optional and operator-facing should we want to keep moving while the GATE
window stays open.

This document is a closeout, not a runbook — operators continuing the work
after the GATE arrives should read
`docs/operations/integration-k3wise-live-gate-execution-package.md` (PR
#1445 + the rehearsal fixups in #1447) as the canonical sequence; this
document only locates where that runbook fits.

---

## Stage 1 invariants (preserved end-to-end)

- Customer GATE answers have not arrived → no integration-core touch, no
  new战线, 内核打磨 only — per the `K3 PoC Stage 1 Lock` memory.
- Every PR shipped this stage was `docs(...)`, `chore(integration)`, or
  `fix(integration)` scope; no `plugin-integration-core/` runtime,
  adapter, pipeline, or runner code was modified.
- All operator-shareable artifacts (preflight JSON / MD, postdeploy smoke
  evidence, live PoC packet) carry the same four-grep secret-hygiene
  contract; verified `0/0/0/0` against real artifacts and against
  synthetic-leak fixtures designed to defeat the older two-grep version.

---

## Shipped this stage (5 PRs)

| # | Title | Merge SHA | Triggered by |
|---|---|---|---|
| #1433 | `chore(integration): add K3 PoC on-prem preflight script` | `b26d3d501` | initial scope from operator |
| #1437 | `docs(integration): add K3 PoC on-prem preflight runbook` (also: `fix(integration): sanitize K3_API_URL query secrets at storage time`) | `36ca5250d` | advisor flagged `sanitizeUrl` storage-time gap |
| #1442 | `docs(integration): expand K3 WISE internal-trial runbook with host-shell path` | `1fb028bc6` | 142 host-shell mint pattern run on real prod env |
| #1445 | `docs(integration): add K3 WISE live GATE execution package` | `ff0a11efe` | preparing for customer GATE arrival |
| #1447 | `docs(integration): close 3 GATE-package operator footguns surfaced by rehearsal` | `364f9e2d8` | self-driven rehearsal exposed G1 / G2 / G3 |

Each PR was driven by real-execution evidence from the previous one — the
sequence is "tool ships → run it for real → record gap → next PR closes
gap". No invented requirements.

---

## Verified deployment-side state (machine 142)

Both verifications fall under the closing `K3 WISE Internal Trial`
runbook contract.

| Check | Result | Captured by |
|---|---|---|
| On-prem preflight (mock mode, host shell) | `decision=PASS / exit 0 / 5 pass / 3 skip / 0 fail` | local artifact + `pnpm verify:integration-k3wise:onprem-preflight` 14/14 PASS |
| On-prem preflight (`--mock` against real prod env via Docker bridge-IP recipe) | `decision=PASS / exit 0`; `pg.migrations-aligned: applied=159 / pending=0` | first execution of the migration-real-path the unit suite cannot cover; recipe lives in PR #1437 runbook |
| Internal-trial postdeploy smoke (host shell, fresh-minted admin token via `docker exec metasheet-backend node`) | `signoff.internalTrial=pass / 10 pass / 0 skipped / 0 fail` | full chain: `api-health` / `integration-plugin-health` / `k3-wise-frontend-route` / `auth-me` / `integration-route-contract` / four control-plane lists / `staging-descriptor-contract` |
| Public surface access posture | TCP-allow + HTTP-deny by source (curl error 52 from external workstation; GHA + host-loopback succeed) | matches design intent; documented in PR #1442's runbook |

The 142 deploy is internal-trial-signoff-ready under the existing
contract. The customer-side bits (real K3 endpoint, customer GATE
answers, rollback contract owner) cannot be closed without customer
input.

---

## What is **gated on customer GATE arrival** (frozen by design)

Following the Stage 1 chain `142 PASS → GATE package → wait → C0–C10 →
evidence PASS → platformization decision`, the next four boxes are all
deliberately blocked until the customer fills A.1–A.6 of the live GATE
execution package:

- **C2** — `integration-k3wise-onprem-preflight.mjs --live` against the
  customer's real K3 endpoint (TCP probe of K3 host:port; configured K3
  env presence check). Returns `exit 2 / GATE_BLOCKED` until
  `K3_API_URL` / `K3_ACCT_ID` / `K3_USERNAME` / `K3_PASSWORD` are
  supplied.
- **C3** — `integration-k3wise-live-poc-preflight.mjs --input
  <gate.json>` to build the live PoC packet. Throws on any of the hard
  contracts the package documents under A.1–A.6.
- **C4–C9** — testConnection (PLM + K3) → material dry-run → material
  Save-only PoC → optional BOM Save-only → dead-letter replay → rollback
  rehearsal. Each requires a real customer K3 to be reachable and
  authenticated.
- **C10** — Evidence compiler (`integration-k3wise-live-poc-evidence.mjs`)
  signoff. Returns `decision=PASS` only when every Save-only / row-count
  / K3-record / BOM-product-scope / legacy-product-id contract is
  satisfied with real evidence from C4–C9.

Trying to run any of these earlier than the customer GATE arrives would
produce only synthetic data — exactly the rehearsal we already did, with
diminishing returns past PR #1447.

---

## Optional pre-GATE work that does not require customer input

These are independent of the customer; they would be additive once
chosen, and none would touch `plugin-integration-core` runtime.

| Item | Effort | Trigger |
|---|---|---|
| Customer-facing GATE intake template (Stage D gap #1) — semi-structured Chinese plus a fillable YAML/wiki page covering A.1–A.6 in plain language with `<fill-outside-git>` placeholders for every credential slot | small docs PR, ~200 lines | when you decide which delivery channel (PDF / Lark wiki / email attachment) the customer prefers |
| On-site evidence-collection template (Stage D gap #2) — slot-per-step JSON skeleton for C4–C9 (runId / externalId / billNo / dead-letter row id / rollback evidence), drops directly into `integration-k3wise-live-poc-evidence.mjs --evidence <file>` | small docs PR, ~100 lines | when you decide whether the on-site recording happens in the JSON skeleton or in a wiki transcript that we then translate into JSON |
| Field-semantics explainer (Chinese, Stage D gap #3) — design intent ("why production is forbidden", "why BOM requires product scope", "why core-table writes are blocked outside `readonly` mode") | small docs PR, ~80 lines | only after the first live PoC produces real customer questions; deferred is correct |
| `K3_SESSION_ID` env path in `integration-k3wise-onprem-preflight.mjs` — closes the C2-vs-C3 sessionId-only divergence the runbook surfaces under A.2 | small script PR + tests | only when a customer GATE answer arrives with a sessionId-only credential bundle; until then this gap is documented and harmless |

The first two are the natural closeout of the Stage D gap list in PR
#1445. They're cheap and ship-ready; the only blocker is the
deliverable shape question.

The last two are deliberately deferred — not because they're
expensive, but because acting on them now would be guessing.

---

## Untracked drafts on the workstation

These files exist on disk after this session but were intentionally not
committed (they're either still drafts under review, or evidence that
already lived in a merged PR via a more polished form).

```
docs/development/
├── integration-k3wise-live-gate-rehearsal-20260509.md            # superseded — equivalent merged in PR #1447
└── integration-k3wise-stage1-closeout-20260509.md                # this file
```

Plus all rehearsal artifact directories under
`artifacts/integration-k3wise/internal-trial/rehearsal-*/` — covered by
the gitignore rule from PR #1442 and inert to repo state.

---

## Acceptance criteria for "Stage 1 fully closes"

Stage 1 cleanly closes — and the platformization decision can begin —
when *all* of the following hold against a real customer K3:

- `signoff.internalTrial=pass` (already true on 142).
- `integration-k3wise-live-poc-preflight.mjs` packet built without
  `normalizeGate` throws against real GATE answers.
- `integration-k3wise-live-poc-evidence.mjs` returns `decision=PASS /
  issues=[]` with at least one material Save-only PoC and (when BOM in
  scope) one BOM Save-only PoC.
- `rollback.owner` exercised the rollback strategy on test rows.
- Pre-share self-check returns `0/0/0/0` on every artifact attached
  to the customer report.

Until these hold, Stage 1 is **paused**, not finished. The pause is
correct — pushing further internal effort right now would be
diminishing-returns rehearsal of code paths the test suites already
cover.

---

## See also

- `docs/operations/integration-k3wise-live-gate-execution-package.md` —
  canonical execution sequence (C0–C10, PASS/FAIL gates).
- `docs/operations/k3-poc-onprem-preflight-runbook.md` — per-check fix
  recipes for the on-prem preflight (#1437).
- `docs/operations/integration-k3wise-internal-trial-runbook.md` —
  postdeploy auth smoke + host-shell mint pattern (#1442).
- `scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample`
  — schema source of truth for the GATE answer JSON.
