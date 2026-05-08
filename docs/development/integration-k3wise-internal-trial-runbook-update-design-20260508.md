# Design: Internal-Trial Runbook Update — Host-Shell Path & Public Posture

**Date**: 2026-05-08
**Files**:
- `docs/operations/integration-k3wise-internal-trial-runbook.md` (modified)
- `.gitignore` (one new ignore rule)

---

## Problem

`integration-k3wise-internal-trial-runbook.md` today documents two paths to a
signoff: the GHA workflow and the equivalent CLI run with `$METASHEET_AUTH_TOKEN_FILE`
already provided. It does not show how to *obtain* a fresh admin token when
operating directly on the deploy host. The token-resolver script
(`scripts/ops/resolve-k3wise-smoke-token.sh`) is GHA-shaped — it requires
`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY_B64` env vars and is meant to
run from a CI control plane that SSHes into the deploy host. An operator
already on the deploy host has to read the resolver, extract the
deploy-host-fallback Node script, and re-derive the `docker exec
metasheet-backend node …` invocation themselves — about thirty minutes of
work, every time.

A second gap: the runbook treats `--base-url http://<deploy-host>:8081` as if
it works from anywhere, but on 142 today the public `:8081` surface has an
application-level allowlist (TCP succeeds, HTTP returns empty reply) that
permits GHA and host-loopback but blocks ad-hoc workstation `curl`. Operators
trying to run a workstation smoke against `:8081` get curl error 52 with no
guidance.

## Goal

Capture both findings as small, additive sections in the existing runbook so
the next operator (or the same operator weeks later) does not have to rederive
them. Plus a one-line `.gitignore` for the matching artifact path so accidental
`git add` of host smoke evidence doesn't surface deployment topology in the
repo history.

## Non-goals

- New runtime / script behaviour. PR is doc-only plus a single ignore rule.
- Replacing `scripts/ops/resolve-k3wise-smoke-token.sh`. The host-shell snippet
  is a **mirror** of its deploy-host fallback inner script, not a replacement.
- Changing the public `:8081` access posture. Loosening the allowlist is a
  deployment-side change in `metasheet-web` nginx config or a front-door reverse
  proxy, not a runbook change.

## Design

### What is added

A new **"Host-Shell Mint and Smoke (deploy host, no GHA)"** section between
"CLI Path" and "Deployment Workflow", with:

- A 4-step recipe: mint token via `docker exec metasheet-backend node` reading
  the same admin user / `authService.createToken()` path as the resolver; write
  to a `0600` `/tmp/...jwt` file; run the smoke; render summary; optional
  `shred` cleanup.
- Inlined Node `--input-type=module` heredoc — the literal mint logic so the
  operator can copy-paste, not derive.
- Notes on what re-derivation looks like when the resolver script changes
  upstream (so the runbook can rot gracefully).

A new **"Public Surface Access Posture"** section between "Deployment
Workflow" and "142 Internal Trial Evidence", with:

- A one-paragraph statement of the observed posture (TCP-allow / HTTP-deny by
  source) with the curl exit code so operators recognize it.
- An explicit reachable / non-reachable list — GHA, host-shell, ad-hoc
  workstation.
- A pointer that loosening the allowlist is out of scope (lives in
  `metasheet-web` nginx config or a front-door reverse proxy).

The **"142 Internal Trial Evidence"** section gains a second entry for the
2026-05-08 host-shell signoff run, kept in newest-first chronological order.
The original GHA run entry is preserved so historical traceability stays
intact.

### `.gitignore`

One new rule for `artifacts/integration-k3wise/internal-trial/`, matching the
existing pattern for `artifacts/integration-k3wise-onprem-preflight/` (added
in PR #1437) and the older
`output/integration-k3wise-postdeploy-smoke/` pattern.

### Fact-check discipline

- The Node mint heredoc was lifted from
  `scripts/ops/resolve-k3wise-smoke-token.sh` lines 175–289 at commit
  `854b27bd9` and shaped into a single literal source the operator can run
  without GHA env. It was executed against 142 today and produced a working
  token whose subsequent smoke returned `signoff.internalTrial=pass / 10 pass
  / 0 fail` — see verification MD §1.
- The "Public Surface Access Posture" claims (TCP-allow / HTTP-deny / curl
  error 52 / GHA reachable / host-shell reachable / ad-hoc workstation
  blocked) were observed in this session — see verification MD §2.

## Affected files

| File | Change |
|---|---|
| `docs/operations/integration-k3wise-internal-trial-runbook.md` | Two new sections + one expanded evidence section. |
| `.gitignore` | One new rule: ignore `artifacts/integration-k3wise/internal-trial/`. |

No source code change. No script change. No CI workflow change.

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
