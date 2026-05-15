# K3 WISE On-Prem Operator Handoff Development - 2026-05-15

## Purpose

This slice closes the repo-local handoff gap between the packaged MetaSheet
on-prem build and a bridge-machine operator who must deploy, verify, and then
prepare for K3 WISE live PoC execution.

The goal is not to add runtime behavior. It is to make the deploy-to-live order
explicit and make the on-prem package verifier fail if the handoff checklist is
missing from a generated package.

## Changes

### Operator checklist

Added:

```text
docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md
```

The checklist links existing runbooks into one operator sequence:

1. download and verify the exact package artifact;
2. install or upgrade the Windows / WSL on-prem deployment;
3. run mock preflight and authenticated postdeploy smoke;
4. prepare the customer GATE intake file outside Git;
5. run live preflight and live packet compilation only after customer answers;
6. fill the C4-C9 on-site evidence worksheet;
7. compile the final delivery readiness record;
8. keep secrets out of tracked files, chat, and evidence artifacts.

It also states the Claude Code boundary: repo-local work does not need Claude
Code, but bridge-machine work can use it when the task requires access to
Windows / WSL logs, K3 host reachability, SQL Server, or browser checks from the
deployment network.

### Package build

Updated:

```text
scripts/ops/multitable-onprem-package-build.sh
```

The new checklist is now part of the package required paths and is listed in
the generated `INSTALL.txt` runbook section.

### Package verification

Updated:

```text
scripts/ops/multitable-onprem-package-verify.sh
```

The verifier now requires:

- the checklist file to exist in the package;
- the Windows easy-start guide to list it;
- the checklist to include package verification, GATE intake, C4-C9 evidence,
  and Claude Code boundary sections.

The required-content count increases from 73 to 74.

### Delivery bundle

Updated:

```text
scripts/ops/multitable-onprem-delivery-bundle.mjs
```

The checklist is copied into the customer delivery bundle with the existing K3
WISE runbooks.

### Windows easy-start guide

Updated:

```text
docs/deployment/multitable-windows-onprem-easy-start-20260319.md
```

The detailed runbook list now includes the operator handoff checklist.

## Boundaries

- No backend runtime code changed.
- No frontend runtime code changed.
- No DB schema or migration changed.
- No customer GATE value, token, password, session id, or SQL connection string
  is added to the repository.
- This slice does not make live K3 execution automatic; it documents the safe
  execution order and strengthens package verification.

## Deployment Impact

Generated on-prem packages must now include:

```text
docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md
```

If the checklist is missing or the Windows easy-start guide does not point to
it, `scripts/ops/multitable-onprem-package-verify.sh` fails.

## Claude Code Use

Claude Code is not required for this repo-local slice.

Use Claude Code on the bridge machine only after deployment begins and only for
local checks that this workstation cannot see directly:

- Windows / WSL service logs;
- K3 WISE WebAPI host and port reachability;
- SQL Server allowlist / middle-table checks;
- browser validation from the deployment network.
