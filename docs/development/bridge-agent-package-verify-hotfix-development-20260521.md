# Bridge Agent Package Verify Hotfix Development Notes

Date: 2026-05-21

## Purpose

The official `Multitable On-Prem Package Build` run for main SHA `663e7646e`
successfully built the package archives, then failed inside
`multitable-onprem-package-verify.sh` at the new Bridge Agent evidence-template
marker.

The failing verifier marker expected this literal string:

```text
"decision": "PASS|FAIL"
```

The real packaged template uses the documented placeholder form:

```text
"decision": "<PASS | FAIL>"
```

So the failure was a verifier marker mismatch, not missing package content.

## Change

The verifier now checks stable fields that actually exist in
`scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.json`:

- `"spec": "ba-m0.5-driver-smoke"`
- `"decision": "<PASS | FAIL>"`
- `"sqlServerVersionRedacted"`

This preserves the gate while matching the real evidence template contract.

## Scope

- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/development/bridge-agent-package-verify-hotfix-development-20260521.md`
- `docs/development/bridge-agent-package-verify-hotfix-verification-20260521.md`

No package builder, runtime, API, frontend, DB, K3 write path, or
`plugin-integration-core` behavior changed.
