# docker-build deploy-job SSH timeout runbook - design - 2026-05-22

## Goal

Issue #1772 reports that after PR #1771 merged at `d23472167`, the
main-push workflow `Build and Push Docker Images` succeeded in the build
job but failed in the deploy job at the very first step (`Sync deploy
host files`), with the sanitized error:

```text
ssh: connect to host <redacted> port 22: Connection timed out
deploy_rc missing; failing deploy job.
```

The build worked, the merged PR did not touch deploy plumbing, and the
later main-push workflows (Phase 5 Production Flags Guard, Observability
E2E, Deploy to Production, monitoring-alert, Plugin System Tests) all
passed. The fault is squarely **deploy-host TCP/22 reachability from
GitHub-hosted runners**, not an app or CI regression.

We do not have an operator runbook for this specific failure shape today.
Adding one captures the diagnostic ordering on the operator side so the
next recurrence can be triaged from the workflow log + the runbook
without context-bouncing or guessing.

## Scope

In scope:

- `docs/operations/docker-build-deploy-ssh-timeout-runbook.md` - the
  operator-facing runbook.
- this design MD + a verification MD.

Out of scope (hard):

- any change to `.github/workflows/docker-build.yml` itself - the
  workflow is fine when the host is reachable;
- deploy SSH key rotation (a separate concern - this runbook explicitly
  says timeout is not the key/user failure shape);
- application runtime, DB migration, API, frontend;
- Bridge Agent / Data Factory / K3 WISE / SQL Server / customer GATE.

## Why an operator-facing runbook is the right delivery shape

The failure is operational, not code. Three signals say so:

- the workflow's build job is healthy and the same code path was green
  before the failure;
- the failure text is at the TCP layer (`Connection timed out` on port
  22), before any auth or sshd negotiation;
- the suggested checks in #1772 itself are deploy-host infra checks
  (firewall, SG, sshd state), not code changes.

So the deliverable is operator knowledge in a single place, citing the
exact step and line in the workflow so an operator triaging the next
recurrence does not have to read the YAML to find what failed.

## Runbook shape decisions

1. **Symptom-first**, not failure-class-first. The runbook opens with
   the exact step name, the exact line number, and the exact sanitized
   error text. The operator's eye should match-in-one-pass without
   reading the whole doc.

2. **Order the checklist by failure probability**, not by OSI layer.
   Most recurrences will be DNS drift / cloud-SG edit / runner CIDR
   roll, in that order; key/user/sshd checks come later because the
   `Connection timed out` shape does not indicate those.

3. **Explicit "this is not the failure shape for X" lines.** A timeout
   is not `Permission denied`. A timeout is not sshd-config. Saying so
   prevents the operator from rotating the key in panic.

4. **Secret-hygiene discipline section** up front. The whole point of
   the workflow already redacting `<redacted>` in its log is so the
   sanitized form is the canonical form. The runbook tells the
   operator to copy the sanitized line, not their own terminal.

5. **Cite GitHub's published runner CIDR endpoint**
   (`https://api.github.com/meta`) and note it can roll. The deploy
   host's allowlist must track it; cached lists go stale.

6. **`ssh -v` reproduction** as the single most useful diagnostic
   once 1-7 are clean, with the placeholders shape the operator should
   actually type. Match `ConnectTimeout` / `StrictHostKeyChecking` /
   `IdentitiesOnly` to what the workflow uses, so the local repro is
   apples-to-apples.

7. **Re-run failed jobs** is step 9, gated on "you fixed something". The
   runbook also names the run ID from #1772
   (`26293551077`) so this first incident has a working link.

## Why not patch the workflow

Two reasons:

- the workflow already does the right thing when reachability is
  restored - re-runs succeed without code change;
- adding workflow-side resilience (retries, fallback hosts, etc.)
  hides the underlying outage and slows future triage. The operator
  side is the right place to fix this.

If a future recurrence shows the timeout is reliably transient and
short, a small `--connect-timeout` / single retry could be considered -
but that is a separate change and not part of this docs PR.

## Files

- `docs/operations/docker-build-deploy-ssh-timeout-runbook.md` (new)
- `docs/development/docker-build-deploy-ssh-timeout-runbook-design-20260522.md`
  (this file)
- `docs/development/docker-build-deploy-ssh-timeout-runbook-verification-20260522.md`
  (companion)
