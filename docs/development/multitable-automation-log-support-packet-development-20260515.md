# Multitable Automation Log Support Packet - Development

Date: 2026-05-15

## Why this PR exists

PR #1562 aligned the automation run-history viewer with the backend
execution-log contract and redacted step output/error rendering. The
next useful kernel-polish slice is to make a single execution easy to
handoff to support without copying raw DOM text or leaking recipients,
SMTP values, webhook tokens, bearer tokens, JWTs, or DingTalk receiver
IDs.

This PR adds a redacted support packet for an expanded automation
execution. It stays within shipped run-history UI behavior and does not
change automation execution semantics.

## Scope

In scope:

- Add a browser-side support-packet utility for automation executions.
- Add copy-to-clipboard Markdown and download-JSON actions in
  `MetaAutomationLogViewer`.
- Reuse the existing `automation-log-redact.ts` helper introduced by
  #1562.
- Update Phase 3 TODO closeout entries for already-merged D1/D4 work.
- Add focused tests for packet generation, redaction, and UI actions.

Out of scope:

- No backend route, schema, migration, OpenAPI, or executor change.
- No new automation action type.
- No real SMTP send.
- No Data Factory, K3, Attendance, DingTalk runtime, or
  `plugins/plugin-integration-core/*` change.

## Design

### Packet shape

`automation-log-support-packet.ts` exports:

- `buildAutomationLogSupportPacket(execution, generatedAt?)`
- `renderAutomationLogSupportPacketJson(execution, generatedAt?)`
- `renderAutomationLogSupportPacketMarkdown(execution, generatedAt?)`
- `createAutomationLogSupportPacketFilename(execution)`

The packet uses:

- `schemaVersion: 1`
- `kind: multitable.automation.execution.support-packet`
- `redactionVersion` from `automation-log-redact.ts`
- `redactionPolicy: step-output-and-error-summaries-only`

The packet intentionally stores only summaries for step output and
errors. It does not export raw `step.output` values, because those can
contain recipient lists, webhook URLs, SMTP identifiers, DingTalk user
IDs, or rendered customer content.

### UI behavior

When a log row is expanded, the detail block now shows:

- `Copy redacted packet` — writes Markdown to the clipboard.
- `Download JSON` — creates a local JSON file via a browser Blob.
- A short per-execution status line for copy/download success or
  redacted failure messages.

Both buttons use `@click.stop` so copying/downloading does not collapse
the expanded execution row.

### Redaction

The packet utility delegates to the shared UI redactor:

- `redactString()` for ids, actor-like strings, timestamps, and
  failure messages.
- `summarizeStepOutput()` for step output.
- `summarizeStepError()` for step errors.

This keeps the packet behavior aligned with the visible run-history
drawer and avoids a second redaction implementation.

## Files Changed

| File | Purpose |
| --- | --- |
| `apps/web/src/multitable/utils/automation-log-support-packet.ts` | New support-packet builder, JSON/Markdown renderer, safe filename helper. |
| `apps/web/src/multitable/components/MetaAutomationLogViewer.vue` | Adds copy/download actions and per-execution status display. |
| `apps/web/tests/automation-log-support-packet.spec.ts` | Tests packet schema, JSON/Markdown redaction, and filename sanitization. |
| `apps/web/tests/MetaAutomationLogViewer.spec.ts` | Tests support-packet action rendering and clipboard copy redaction. |
| `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md` | Closes D1/D4 merge-commit drift and records this support-packet slice. |
| `docs/development/multitable-automation-log-support-packet-development-20260515.md` | This development note. |
| `docs/development/multitable-automation-log-support-packet-verification-20260515.md` | Verification note. |

## Stage-1 Lock Compliance

- Does not touch K3 PoC files or `plugins/plugin-integration-core/*`.
- Does not open an AI product surface.
- Does not alter automation executor semantics.
- Does not add a new route or persistence model.
- Fits the allowed "kernel polish on shipped multitable automation"
  category.

## Follow-ups

- If operators want a backend-generated packet later, add a separate
  route only after defining an explicit retention and access-control
  contract.
- Real SMTP PASS-path validation remains blocked on dedicated SMTP
  credentials and a test recipient environment.
