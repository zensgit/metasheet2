# docker-build deploy-job SSH timeout runbook - verification - 2026-05-22

Companion to `docker-build-deploy-ssh-timeout-runbook-design-20260522.md`.
Docs only: one operator runbook + two dev MDs. No workflow YAML change.
No `plugin-integration-core`, no DB migration, no API runtime, no
frontend.

## Local evidence (isolated worktree)

### 1. Acceptance-text greps against the runbook

Each marker the task required, counted via `grep -cF` against
`docs/operations/docker-build-deploy-ssh-timeout-runbook.md`:

| Marker | Count |
| --- | --- |
| `DNS / IP resolution` | 1 (section 1 heading) |
| `port 22` | 7 |
| `security group` | 5 |
| `firewall` | 7 |
| `deploy user` | 1 (section 7 heading + the `<deploy-user>` placeholder shows 1 here) |
| `deploy key` | 4 |
| `api.github.com/meta` | 1 (the canonical GitHub runner CIDR endpoint) |
| `ssh -vv` | 1 (the `-vv` reproduction shape in section 8) |
| `Re-run failed jobs` | 2 (section 9 instruction + the closing reference) |
| `26293551077` | 3 (cited as the workflow run, in symptom + step 9 + "Related" footer) |
| `#1772` | 3 (top tracking line + step 9 reference + "Related" footer) |
| `docker-build.yml:83` | 1 (the failing step's current exact line) |
| `docker-build.yml:100` | 1 (the failing `ssh` command's current exact line inside the step) |

All eight checklist items from the task acceptance are present
(DNS/IP, port 22, security group / firewall, deploy user, deploy key,
GitHub runner outbound, manual `ssh -v`, when to rerun).

### 2. Workflow grounding (cite-only, no edit)

The runbook cites `.github/workflows/docker-build.yml` line numbers
verified against current `origin/main` (HEAD `e4f5d1a91` at the time of
the 2026-05-30 refresh):

- `name: Build and Push Docker Images` on line 1
- `jobs:` on line 19
- `deploy:` job on line 76
- `Sync deploy host files` step on line 83
- the first `ssh` command inside that step on line 100

The runbook does **not** modify the workflow YAML. The line numbers are
helpful for operator triage but intentionally not the contract; the
runbook now tells operators to match by workflow name, deploy job, step
name, and first `ssh $ssh_opts` invocation if the YAML shifts.

### 3. Secret-shape sweep

Patterns searched, expected count `0` per cell:

| Pattern | runbook | design MD |
| --- | --- | --- |
| `eyJ[A-Za-z0-9_-]{6,}` (JWT shape) | 0 | 0 |
| `(Password\|Pwd)=<populated>` | 0 | 0 |
| `Bearer <token>` | 0 | 0 |
| `postgres://<userinfo>@` | 0 | 0 |
| IPv4 literal | **1*** | 0 |
| SSH key blob (`-----BEGIN ... PRIVATE KEY-----` / `ssh-rsa AAAA` / `ssh-ed25519 AAAA`) | 0 | 0 |

`*` The single IPv4 literal in the runbook is `0.0.0.0/0` (line 142),
the universal CIDR placeholder meaning "any IPv4" - it is **not** a
leaked host address. The phrase is "If the deploy host's inbound is
open to `0.0.0.0/0` on port 22, this step is not the cause - move to
step 6." It is needed to phrase the negative case for security-group
allowlisting and cannot be omitted without losing clinical meaning.
No real `<deploy-host>` / `<deploy-user>` / `<deploy-path>` value
appears anywhere; every reference uses an explicit placeholder.

### 4. `git diff --check`

```text
git diff --check  -> exit 0
```

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| docs/ops small PR, no runtime / DB / API change | only 3 docs files; section 1 above lists them; section 2 confirms no workflow YAML edit |
| Runbook explains the workflow failure shape | symptom section names the exact step, the exact line, the exact sanitized error text |
| Operator checklist: DNS/IP | section 1 above |
| Operator checklist: port 22 | sections 3 + 4 + 6 |
| Operator checklist: security group / firewall | section 4 (cloud SG + on-prem firewall + NAT + recent-change scan) |
| Operator checklist: deploy user | section 7 |
| Operator checklist: deploy key | section 7 (with the explicit "timeout is not the key/user failure shape" caveat) |
| Operator checklist: GitHub runner outbound IPs | section 5 cites `https://api.github.com/meta` |
| Operator checklist: manual `ssh -v` | section 8 with the `ssh -vv -o ConnectTimeout=10 ...` placeholder-only reproduction shape |
| Operator checklist: when to rerun failed jobs | section 9 with the "fix first, rerun once" discipline |
| Cite #1772 and workflow failure point | tracking line + step 9 + Related-workflows footer; current line numbers 83 and 100 for the step and ssh call, with an explicit "match by shape if YAML shifts" caveat |
| Design MD + verification MD | this PR adds both |
| No secret / host / user / key emitted | secret-shape sweep above; `0.0.0.0/0` is the only IPv4 literal and it is the CIDR-any placeholder, not a leak |

## Out-of-scope reaffirmation

- No `.github/workflows/docker-build.yml` modification.
- No SSH key rotation / cloud SG edits / firewall changes are performed
  by this PR - it documents how an operator does them on the deploy
  host side.
- No `plugin-integration-core`, no DB migration, no API runtime, no
  frontend, no K3 Save / Submit / Audit.
- Customer GATE state unchanged.

## Operational note

Developed in an isolated `git worktree`
(`/tmp/ms2-deploy-ssh-67785`) per the parallel-session worktree hazard
memory. Branch verified
(`codex/docker-build-deploy-ssh-timeout-runbook-20260522`) before
commit and push.
