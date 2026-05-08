# Design: K3 PoC On-Prem Preflight Runbook

**Date**: 2026-05-08
**Files**:
- `docs/operations/k3-poc-onprem-preflight-runbook.md` (new)
- `.gitignore` (one new ignore rule)

---

## Problem

PR #1433 added `scripts/ops/integration-k3wise-onprem-preflight.mjs`, a stable
read-only preflight with three exit codes (PASS / FAIL / GATE_BLOCKED). The
script's `--help` covers flags, and its safety notes describe redaction.
Neither tells an operator how to *act* when a check fails, and neither
documents the surprises we hit running it against a real Docker-deployed
metasheet on machine 142.

Specifically:

- The deployed `DATABASE_URL` uses a docker-compose service hostname (e.g.,
  `postgres`) that is unresolvable from a host shell — operators see
  `pg.tcp-reachable: fail` with `ENOTFOUND` and have no recipe.
- The slim production backend image ships only `dist/`, so the preflight
  script is not present inside the prod container — operators trying to run
  it via `docker exec` hit a dead end.
- `pg.migrations-aligned` cascading-skips through several distinct reasons,
  each with a different correct response. The script reports the reason but
  not what to do.
- Artifact files contain enough host topology that an over-eager operator
  could `git add` the artifact directory; today no `.gitignore` rule covers
  this path.

## Goal

A single operator-friendly runbook that lets a first-time user of the
preflight read its output and act, plus a one-line gitignore rule that closes
the artifact-leak footgun.

The runbook is intentionally NOT a tutorial on Postgres, Docker compose, or
JWT secrets. It is a fix-recipe lookup keyed by the script's own check IDs
and decision codes.

## Non-goals

- New runtime / script behaviour. PR is doc-only plus a one-line gitignore.
- Replacing `scripts/ops/integration-k3wise-onprem-preflight.mjs --help`.
  The runbook references the help, not duplicates it.
- Replacing `docs/operations/integration-k3wise-internal-trial-runbook.md`,
  which covers *post-deploy* authenticated smoke. The two are sequential
  (preflight → boot → trial smoke), and the new runbook links forward to it.

## Design

### What goes in the runbook

| Section | Contents |
|---|---|
| When to run | 4 trigger scenarios |
| TL;DR | The single canonical command |
| Exit codes | 0 / 1 / 2 + the role of `warn` |
| Per-check failure recipes | One section per check ID, keyed by `details.code` / `details.reason` |
| Running against Docker-deployed metasheet | The hostname-→-bridge-IP recipe, and when to prefer alternatives |
| Sharing the artifact safely | What's already redacted, and a pre-share self-check |
| What this preflight does NOT do | Negative scope to set expectations |
| Footgun summary | One-row-per-pitfall table |
| See also | Forward link to internal-trial runbook |

### Fact-check discipline

Every literal string the runbook quotes from the script (hint texts, reasons,
exit code labels, regex patterns) was lifted from
`scripts/ops/integration-k3wise-onprem-preflight.mjs` on the merge commit
(`b26d3d501`) at the time the runbook was written. The verification MD lists
each quoted string with its source line for review.

The Docker recipe in §3 is the literal command sequence run on machine 142
on 2026-05-08, returning `PASS / applied: 159 / pending: 0`. No invented
configuration.

### Why a runbook and not a README inside `scripts/ops/`

`scripts/ops/` files are typically tooling, not human guidance. Operator
runbooks live under `docs/operations/` next to existing peers
(`integration-k3wise-internal-trial-runbook.md`, `deploy-ghcr.md`,
`dingtalk-alertmanager-*-runbook.md`). The preflight is an operator tool, so
its runbook follows the same convention.

### Why the gitignore rule

The artifact directory at `artifacts/integration-k3wise-onprem-preflight/`
contains:

- Docker bridge IPs (operationally informative; not strictly secret but not
  worth surfacing in commit history).
- Migration counts and run timestamps.
- Sanitized DATABASE_URL strings.

Existing `.gitignore` already covers analogous paths
(`output/integration-k3wise-postdeploy-smoke/`, with the same rationale
"can include deployment topology"). Adding the matching rule for this
preflight keeps the project consistent and prevents an operator accidentally
committing local run output.

## Affected files

| File | Change |
|---|---|
| `docs/operations/k3-poc-onprem-preflight-runbook.md` | New file (~280 lines). |
| `.gitignore` | One new rule: ignore `artifacts/integration-k3wise-onprem-preflight/`. |

No source code change. No script change. No CI workflow change. No package
manifest change.

## Deployment impact

None.

## Customer GATE status

PR is **outside** the GATE block:

- Doc-only + a one-line gitignore.
- No real ERP business behaviour added.
- `plugin-integration-core` runtime / adapters / pipelines / runner all
  untouched.
- Stage 1 Lock memory ("until GATE PASS, no new战线 / no integration-core
  touch; 内核打磨 permitted") remains in force; runbook fits clearly inside
  "内核打磨".
