# DingTalk Alertmanager Closeout Runner Design

- Date: 2026-05-05
- Scope: implemented closeout runner plus operator docs
- Code changes:
  - `scripts/ops/dingtalk-alertmanager-closeout.mjs`
  - `scripts/ops/dingtalk-alertmanager-closeout.test.mjs`

## Problem

After `ALERTMANAGER_WEBHOOK_URL` or a supported fallback secret is configured,
operators still need to manually chain several steps:

- run GitHub Actions runtime readiness;
- trigger or select the DingTalk OAuth stability workflow;
- wait for completion;
- download the workflow artifact;
- inspect the summary without leaking webhook secrets.

When the secret is missing, the current useful action is readiness only. A
runner should stop there and provide a concrete next action instead of starting
a workflow that is expected to fail for the same known reason.

## Command

```bash
node scripts/ops/dingtalk-alertmanager-closeout.mjs \
  --repo zensgit/metasheet2 \
  --workflow dingtalk-oauth-stability-recording-lite.yml \
  --ref main \
  --trigger \
  --wait --timeout-seconds 900 \
  --format markdown \
  --output /private/tmp/ms2-dingtalk-alertmanager-closeout-summary.md
```

Useful operator modes:

- `--trigger`: trigger a fresh workflow after readiness passes.
- omit `--trigger`: run readiness only, or summarize an explicit `--run-id`.
- `--run-id <id>`: skip workflow discovery and download a known artifact after
  readiness passes.
- `--wait`: wait for the selected workflow run before artifact download.
- `--output <path>`: write a redacted summary for handoff.
- `--format json`: emit a machine-readable redacted summary for automation.

## Flow

```text
start
  -> readiness strict check
  -> if no supported webhook secret: blocked summary and exit
  -> if readiness failed for another reason: failed summary and exit
  -> if trigger requested: workflow dispatch
  -> wait for selected workflow run
  -> download artifact
  -> parse summary
  -> redact sensitive fields
  -> print and write closeout summary
```

## Readiness Contract

The runner should reuse the same readiness checks as
`github-actions-runtime-readiness.mjs`.

Required readiness facts:

- deploy secrets are present;
- supported Alertmanager webhook self-heal secret is present;
- K3 deploy auth gate variables are configured;
- readiness output is already redacted.

Missing webhook secret is a blocked state with a direct action, not a workflow
failure to reproduce.

## Artifact Contract

The runner should download the DingTalk OAuth stability artifact and extract
only safe summary fields:

- overall status;
- stability return code;
- health status;
- webhook configured flag and host;
- Alertmanager active alert count and notify error count;
- storage usage gate;
- failure reasons.

Sensitive data must be redacted before display or file output:

- webhook URL and path;
- GitHub secret values;
- authorization headers;
- cookies;
- bearer tokens;
- session identifiers that can be reused.

## Exit Codes

- `0`: closeout completed and artifact result is pass.
- `1`: readiness or artifact completed with a real failure.
- `2`: blocked by missing supported webhook secret and no workflow was started.

Unexpected CLI, GitHub API, workflow wait, artifact download, or artifact parse
errors currently exit non-zero with the underlying error message.

## Non-Goals

- Do not set, rotate, or infer webhook secrets.
- Do not modify workflow YAML.
- Do not bypass readiness.
- Do not write unredacted artifacts into tracked repo paths.

## Implementation Notes

The runner composes existing safe pieces instead of duplicating their logic:

- `github-actions-runtime-readiness.mjs` provides the readiness contract.
- `gh workflow run`, `gh run watch`, `gh run view`, and `gh run download` handle
  GitHub workflow lifecycle.
- `summary.json` from `github-dingtalk-oauth-stability-summary.py` is parsed and
  reduced to safe status fields.

The runner never reads webhook values. It only sees secret presence metadata and
the redacted artifact summary.
