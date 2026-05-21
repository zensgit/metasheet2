# Bridge Agent Driver Smoke (BA-M0.5) - verification - 2026-05-20

Companion to `bridge-agent-driver-smoke-design-20260520.md`. All evidence
was produced in an isolated `git worktree` to avoid the parallel-session
worktree hazard.

## File inventory

| File | Purpose |
| --- | --- |
| `scripts/ops/bridge-agent-driver-smoke.ps1` | PowerShell harness (3 provider modes, redacted evidence output) |
| `scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.json` | Shape-only JSON evidence template |
| `scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.md` | Shape-only Markdown evidence template |
| `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` | Operator-facing runbook |
| `docs/development/bridge-agent-driver-smoke-design-20260520.md` | Design MD |
| this file | Verification MD |

No existing file under `plugins/`, `apps/web/`, `packages/core-backend/`,
or `scripts/ops/multitable-onprem-*` is modified.

## Local checks

### 1. Branch self-check

```text
git branch --show-current
  -> codex/bridge-agent-driver-smoke-20260520
```

The branch matches the intended name before commit, preventing the
parallel-session "commit on the wrong branch" failure mode #1699
caught.

### 2. `git diff --check`

```text
git diff --check  -> exit 0
```

No trailing-whitespace, merge-conflict markers, or known-bad whitespace
introduced.

### 3. Secret-shape grep across all 5 changed files

Five patterns × five files = **25 cells, all 0**:

| File | JWT | populated password | bearer token | raw PG userinfo | secret query value |
| --- | --- | --- | --- | --- | --- |
| `bridge-agent-driver-smoke.ps1` | 0 | 0 | 0 | 0 | 0 |
| `evidence.template.json` | 0 | 0 | 0 | 0 | 0 |
| `evidence.template.md` | 0 | 0 | 0 | 0 | 0 |
| `bridge-agent-driver-smoke-runbook-20260520.md` | 0 | 0 | 0 | 0 | 0 |
| `bridge-agent-driver-smoke-design-20260520.md` | 0 | 0 | 0 | 0 | 0 |

Patterns checked:

- `eyJ[A-Za-z0-9_-]{6,}` (JWT shape)
- `"password"\s*:\s*"[^<]` (populated password)
- `Bearer [A-Za-z0-9._~+/=-]{8,}` (bearer token)
- `postgres://[^ ]*:[^ <]*@` (raw PG userinfo)
- `[?&](token|secret|access_token|sessionId|password)=[^<&) ]` (populated secret query)

### 4. PowerShell parse check

```text
pwsh -NoProfile -Command \
  "[System.Management.Automation.Language.Parser]::ParseFile(<harness>, [ref]\$null, [ref]\$null)"
  -> no local pwsh on this dev host
```

Documented gap. The harness is exercised on Windows-side CI / the
target on-prem bridge machine, where PowerShell 5.1+ or 7+ is the
expected runtime. Local parse coverage on this development host is
not available and is intentionally not faked.

## Runbook acceptance markers (grep, empirical)

Run against
`docs/operations/bridge-agent-driver-smoke-runbook-20260520.md`:

| Needle | Count | Anchor |
| --- | --- | --- |
| `SELECT @@VERSION` | 2 | Smoke definition + decision-logic section |
| `BA-M0.5` | 3 | Title + back-references |
| `does not start` | 1 | BA-M1 gating sentence (line 15: "...BA-M1 (Bridge Agent MVP implementation) does not start") |
| `IntegratedSecurity` | 2 | Param documentation + Mode C example |
| `PasswordEnvVar` | 3 | Secret-hygiene section + Mode A example + Mode B example |
| `Secret hygiene` | 1 | Section header |

Pattern shape was changed for the BA-M1 gating sentence (`does not start`
instead of `BA-M1 does not start`) because the runbook breaks "BA-M1"
and "does not start" across a line with a parenthetical insertion. The
empirical count drove the pattern, not vice versa.

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| BA-M0.5 driver smoke runbook for Windows on-prem | `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` |
| Minimal smoke harness (.NET Framework / System.Data / ODBC / OLE DB preferred) | `bridge-agent-driver-smoke.ps1` with `-Provider {SqlClient,Odbc,OleDb}` |
| jTDS fallback note | Runbook "Fallback: jTDS (Java)" section (no separate ps1, documented inline) |
| Smoke executes only `SELECT @@VERSION` | Hard-coded literal in `Invoke-SmokeWithProvider`; no other SQL anywhere in the file |
| Redacted JSON + MD evidence output | Harness writes `ba-m0_5-driver-smoke.{json,md}` to `-OutDir`; both pass through the same redactor |
| Design MD + verification MD | this PR adds both |
| Update #1710 comment noting BA-M1 stays blocked | Follow-up comment posted on PR open |

## Boundary / Stage 1 Lock conformance

- No `plugins/plugin-integration-core` touch.
- No DB migration, API runtime, or frontend runtime change.
- No K3 Save / Submit / Audit behavior change.
- No SQL/TLS failure summarization (separate #1526 actionable).
- Customer GATE state unchanged.

## Operational note (parallel-session worktree hazard)

Developed in an isolated `git worktree` under `/tmp/ms2-bridge-smoke-...`
per the parallel-session worktree hazard memory. Branch
`codex/bridge-agent-driver-smoke-20260520` was created from
`origin/main` (one shot, no rename / no re-point). Branch self-check
ran inside the worktree immediately before commit. No file in the main
checkout was modified.
