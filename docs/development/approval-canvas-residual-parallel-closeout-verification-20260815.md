# Approval Canvas Residual Parallel — As-built Closeout (2026-08-15)

**Status:** ENGINEERING CLOSEOUT ONLY — residual product PRs are on main; ledgers stamped DONE; palette-focus canary wired  
**Integration head:** `origin/main` `348eccde90825591ed6af0b6e503d152fe3cc672`  
`feat(attendance): Gate D3 — wire scheduled authoritative writes to the D1 core (#4556) (#4903)`  
Residual vitest + `SKIP_TESTS=1` smoke were re-run on this closeout branch after rebase onto that head.  
**This closeout:** ledger honesty + always-on canary wiring for every residual test that already exists on that head. No residual product behavior was re-implemented.

## 0. Non-claims

| Claim | Status |
|---|---|
| Residual product PRs merged on main | **YES** — `#4815` `#4816` `#4817` `#4818` `#4819` `#4823` `#4824` `#4825` `#4826` (and engineering land `#4806`) |
| Wave-3 design ledger left OPEN | **NO** — stamped DONE with those PR numbers |
| Real-tenant UAT | **NOT CLAIMED** |
| Staged / production flag ON | **NOT CLAIMED** |
| Product FINAL | **NOT CLAIMED** |
| Owner G0 ratify (`PROPOSED` → `RATIFIED`) | **NOT CLAIMED** — lock Status lines unchanged |

## 1. Residual PRs on the integration head

From `{SCRATCH}/residual-prs.log` (`git log --oneline -F --grep='(#NNNN)'` on `348eccde90`):

| PR | SHA | Subject |
|---|---|---|
| #4806 | `323d7e1afe` | Canvas V2 final-eligibility engineering |
| #4815 | `a06ce31928` | form session undo/redo |
| #4816 | `52796b726e` | dual-canvas version compare |
| #4817 | `f814e6c61b` | residual G5-C canaries + owner UAT smoke harness |
| #4818 | `5c3146acbc` | flow-canvas edge-insert a11y |
| #4819 | `60659ddc3b` | inspector topology a11y |
| #4823 | `2f86b92207` | wave-3 always-on residual canaries and smoke |
| #4824 | `99c49475bb` | edge-insert menu item a11y |
| #4825 | `5e1efd3e31` | form palette focus-return |
| #4826 | `88d5cb14ce` | G5-C residual structural pins |

Design ledgers:

- `docs/development/approval-canvas-residual-parallel-design-20260808.md` — DONE (wave-1) `#4815`–`#4817`; canary list includes `approval-form-palette-focus` (`#4825`); follow-on wave-3 DONE `#4823`–`#4826`
- `docs/development/approval-canvas-residual-parallel-wave2-design-20260808.md` — DONE `#4818`–`#4819`; follow-on wave-3 DONE `#4823`–`#4826`
- `docs/development/approval-canvas-residual-parallel-wave3-design-20260808.md` — **DONE (wave-3)** `#4823` `#4824` `#4825` `#4826` (no OPEN rows)

## 2. Always-on canary wiring (including palette-focus)

`{SCRATCH}/canary-wiring.log` records that all six residual suites are required here:

| Surface | Tokens present |
|---|---|
| `.github/workflows/approval-web-guard.yml` (path filters ×2 + canary vitest) | `approval-form-authoring-history`, `approval-version-dual-canvas`, `approval-flow-canvas-a11y`, `approval-canvas-inspector-a11y`, `approval-form-palette-focus`, `approval-g5c-authoring-scenarios` |
| `apps/web/scripts/run-required-web-tests.sh` | same six (always-on block; no env flag) |
| `scripts/ops/approval-canvas-owner-uat-smoke.sh` | `require_file` for the six test files (and form/dual-canvas modules); focused vitest list includes palette-focus |

Absence of `approval-form-palette-focus` on those three surfaces was the leftover honesty/wiring gap after `#4823`–`#4826`.

## 3. Residual vitest (real files on the integration-head worktree)

Command (from `apps/web`, `--watch=false`):

```bash
pnpm exec vitest run --watch=false \
  tests/approval-form-authoring-history.test.ts \
  tests/approval-version-dual-canvas.test.ts \
  tests/approval-flow-canvas-a11y.test.ts \
  tests/approval-canvas-inspector-a11y.test.ts \
  tests/approval-form-palette-focus.test.ts \
  tests/approval-g5c-authoring-scenarios.test.ts \
  --reporter=verbose
```

Capture: `{SCRATCH}/residual-vitest.log`

| Result | Count |
|---|---:|
| Test files | **6 passed** |
| Tests | **42 passed** |

All six listed files ran. These are the shipped tests on this head, not copies.

## 4. Owner smoke (values-free)

```bash
SKIP_TESTS=1 scripts/ops/approval-canvas-owner-uat-smoke.sh
```

Capture: `{SCRATCH}/owner-smoke.log`

- Exit 0 / `approval-canvas-owner-uat-smoke: PASS`
- Requires residual test files including `approval-form-palette-focus.test.ts` and `approval-g5c-authoring-scenarios.test.ts`
- Does not set or recommend flipping `approvalCanvasV2`, FWB, or attachments flags
- Does not claim product FINAL

## 5. Flag defaults and lock ratify (unchanged)

Capture: `{SCRATCH}/flags-default-off.log`

| Gate | Default |
|---|---|
| `apps/web/src/stores/featureFlags.ts` `featureDefaults` | `approvalCanvasV2: false`, `approvalFwbWriteback: false`, `approvalAttachments: false` |
| `isApprovalCanvasV2Enabled` | `APPROVAL_CANVAS_V2_ENABLED === 'true'` only |
| `isFwbWritebackEnabled` | `APPROVAL_FWB_WRITEBACK_ENABLED === 'true'` only |
| `isApprovalAttachmentsEnabled` | `APPROVAL_ATTACHMENTS_ENABLED === 'true'` only |
| Canvas V2 interaction lock | **Status: PROPOSED** (unchanged) |
| Canvas V2 development plan | **Status: PROPOSED** (unchanged) |

## 6. Scratch evidence paths

Implementer scratch dir (goal `{SCRATCH}`):

`/var/folders/yh/vsjnc3z117zg5_rxcjdml1k00000gn/T/grok-goal-2cfbd188afc9/implementer`

| File | What it proves |
|---|---|
| `residual-prs.log` | residual PR SHAs on `0261b33c61` |
| `canary-wiring.log` | always-on / `require_file` lines including palette-focus |
| `residual-vitest.log` | 6 files / 42 passed |
| `owner-smoke.log` | `SKIP_TESTS=1` exit 0, files required, no flag flip |
| `flags-default-off.log` | canvas / FWB / attachments default OFF; locks still PROPOSED |

Owner-only remainder (out of this closeout): G0 ratify, real-tenant UAT, staged flag enablement, product FINAL.
