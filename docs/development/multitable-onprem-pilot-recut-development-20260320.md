# Multitable On-Prem Pilot Recut Development

Date: 2026-03-20

Branch:
- `recut/multitable-onprem-pilot-main`

Base:
- `origin/main` at `12452347f7e4a8d83f6664e26864576d366c3d72`

Source branch:
- `codex/multitable-fields-views-linkage-automation-20260312`

## Scope

This recut intentionally keeps only the first operational delivery slice:

- on-prem package build workflow
- on-prem package/install/verify scripts
- delivery bundle script
- pilot/customer handoff documentation
- issue template and deployment templates
- root script aliases needed for package and handoff entrypoints

Small cleanup included in this recut:

- quote `@owner` in `.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml` so the form YAML parses correctly

## Explicitly Excluded

The first recut does **not** carry:

- multitable pilot smoke generation
- multitable grid profile generation
- pilot readiness summarization
- pilot E2E workflow

Reason:
- current `main` still lacks multitable backend route implementations
- the smoke/profile scripts call `/api/multitable/*` endpoints directly
- shipping those scripts first would create a PR that cannot run independently on current `main`

## Included Files

- `.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml`
- `.github/workflows/multitable-onprem-package-build.yml`
- `docker/app.env.multitable-onprem.template`
- `ops/nginx/multitable-onprem.conf.example`
- `package.json`
- `scripts/ops/multitable-onprem-delivery-bundle.mjs`
- `scripts/ops/multitable-onprem-deploy-easy.sh`
- `scripts/ops/multitable-onprem-healthcheck.sh`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-install.sh`
- `scripts/ops/multitable-onprem-package-upgrade.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `scripts/ops/multitable-pilot-handoff.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`
- `docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md`
- `docs/deployment/multitable-onprem-package-layout-20260319.md`
- `docs/deployment/multitable-pilot-daily-triage-template-20260319.md`
- `docs/deployment/multitable-pilot-feedback-template-20260319.md`
- `docs/deployment/multitable-pilot-go-no-go-template-20260319.md`
- `docs/deployment/multitable-pilot-quickstart-20260319.md`
- `docs/deployment/multitable-pilot-team-checklist-20260319.md`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`

## Follow-Up

Later recuts can add:

- pilot smoke/profile generation
- readiness summarization
- backend route and contract dependencies
- runtime-facing multitable hardening slices
