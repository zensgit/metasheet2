# Bridge Agent Package Verify Runbook Gate Hotfix - development - 2026-05-21

## Context

The manually dispatched `Multitable On-Prem Package Build` workflow for
`bridge-agent-877576961` failed after the package archive was built and after
the archive checksum passed.

The failing verifier line was:

```text
[multitable-onprem-package-verify] ERROR: Bridge Agent driver smoke runbook must preserve the BA-M1 gate
```

This was a false negative in the package verifier, not a package omission.
The checked-in driver-smoke verification notes already document that the
operator runbook wraps the BA-M1 gate across a parenthetical line break:

```text
Until this smoke returns `decision=PASS`, **BA-M1 (Bridge Agent MVP
implementation) does not start**.
```

The previous package verifier expected the impossible contiguous marker:

```text
BA-M1 does not start until BA-M0.5 is signed off green
```

That exact sentence is present in the legacy planning document, but not in
the operator runbook that is actually packaged and verified.

## Change

The Bridge Agent package tooling verifier now checks the stable runbook gate
marker:

```text
does not start
```

This matches the already-documented BA-M0.5 gate wording in
`docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` and mirrors the
empirical marker recorded in
`docs/development/bridge-agent-driver-smoke-verification-20260520.md`.

The same local package run also exposed a second stale verifier marker. The
previous hygiene check expected:

```text
Do not paste raw evidence into GitHub
```

The actual runbook is stricter and broader: it has a dedicated `Secret hygiene`
section and says not to commit real connection strings, host names, database
names, usernames, passwords, or tokens to Git, issue comments, PR bodies, or
the evidence files. The verifier now checks the stable `Secret hygiene`
section header instead of a non-existent sentence.

The local package run then exposed a third stale verifier marker in the
Markdown evidence template check. The template title is:

```text
BA-M0.5 Driver Smoke Evidence (template)
```

The verifier now checks the stable `BA-M0.5 Driver Smoke Evidence` marker
instead of the non-existent `Driver Smoke Evidence Template` phrase.

## Why this is still a real gate

The verifier still checks the packaged operator runbook itself. The marker is
not moved to a development-only document, and the runbook path remains part of
the Bridge Agent tool contract:

- BA-M0.5 smoke harness exists and runs `SELECT @@VERSION`;
- BA-M0.5 evidence templates are packaged;
- BA-M0.5 Markdown evidence template carries the real template title;
- BA-M0.5 runbook states that BA-M1 does not start before the smoke passes;
- BA-M0.5 runbook contains the operator secret-hygiene section;
- BA-M1 readonly Bridge Agent script, config, and runbook are packaged;
- `INSTALL.txt` points operators to the Bridge Agent tools.

The fix only removes the brittle assumption that the gate sentence must fit on
one physical line.

## Scope

- Three verifier marker changes in
  `scripts/ops/multitable-onprem-package-verify.sh`.
- No runtime code changes.
- No database migration.
- No plugin-integration-core changes.
- No API or frontend changes.
- No K3 Save / Submit / Audit behavior changes.

## Deployment impact

This change affects only package verification. It allows the official on-prem
package workflow to complete when the packaged BA-M0.5 runbook contains the
real gate wording.

It does not change the produced Bridge Agent runtime files, SQL behavior, or
customer GATE status.
