# Data Factory issue #1542 workflow install-staging development - 2026-05-15

## Summary

This slice wires the Data Factory issue #1542 install-staging retest into the
manual GitHub Actions postdeploy smoke workflow.

Before this change, operators could run:

```bash
--issue1542-workbench-smoke --issue1542-install-staging
```

from the command line, but the manual
`.github/workflows/integration-k3wise-postdeploy-smoke.yml` workflow had no
input for that path. The workflow could prove the baseline K3/Data Factory
postdeploy smoke, but not the staging install + staging source upsert + draft
pipeline save path added by the #1574 smoke.

## Changes

- Adds workflow input `issue1542_install_staging`.
- When enabled, both the pre-smoke env check and the smoke append:
  - `--issue1542-workbench-smoke`
  - `--issue1542-install-staging`
- Extends `integration-k3wise-postdeploy-env-check.mjs` so generated command
  evidence knows the issue #1542 flags.
- Updates the K3 internal-trial runbook's GitHub Actions path with the new
  `issue1542_install_staging` input.
- Env-check now fails early when install-staging is requested without:
  - authenticated smoke mode;
  - a token source;
  - a tenant id.
- Extends workflow contract tests and env-check tests.

## Operator Behavior

For normal internal-trial smoke, leave `issue1542_install_staging=false`.

For bridge/test issue #1542 validation after a deploy:

1. set `require_auth=true`;
2. provide or auto-resolve the smoke token;
3. provide `tenant_id`;
4. set `issue1542_install_staging=true`.

The workflow then produces the usual smoke artifact with additional issue #1542
checks, including `issue1542-staging-install` and the downstream schema/pipeline
checks.

## Safety

- The new path is opt-in.
- It writes staging/source/pipeline metadata only.
- It does not run dry-run, Save-only, Submit, Audit, or a K3 live write.
- Token values remain redacted in stdout, JSON evidence, and Markdown evidence.

## Out Of Scope

- Automatic deploy workflow opt-in via repository variables.
- SQL Server query executor deployment.
- K3 Save-only execution.
- Signoff-gate strict mode for requiring issue #1542 checks.
