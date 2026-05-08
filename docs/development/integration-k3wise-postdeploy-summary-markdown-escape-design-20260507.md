# K3 WISE Postdeploy Summary Markdown Escape Design - 2026-05-07

## Context

`scripts/ops/integration-k3wise-postdeploy-summary.mjs` renders K3 WISE
postdeploy smoke evidence into GitHub Step Summary text. This summary is one of
the quickest operator-facing artifacts after deploying ERP/PLM integration
support.

Some values in the evidence JSON come from runtime responses or customer-facing
configuration:

- `baseUrl`
- signoff reason text
- check id/status
- failed check details such as missing routes, invalid fields, and adapter
  messages

Before this change, those values were interpolated directly into Markdown or
wrapped with a single backtick. Values containing backticks, CR/LF, or other
Markdown-sensitive text could break the rendered summary and make the evidence
hard to read during K3 WISE deployment signoff.

## Change

Add two small rendering helpers:

- `markdownText(value)` collapses CR/LF and repeated whitespace into a single
  line for plain text locations such as signoff reason.
- `markdownInlineCode(value)` collapses CR/LF and chooses a backtick fence that
  is longer than any backtick run inside the value.

Then route these fields through the helpers:

- missing-evidence input path
- signoff reason
- failed-check detail values
- base URL
- authenticated-checks flag
- summary count line
- check id and check status

## Scope

This is an output-format hardening change only.

- No K3 WISE network behavior changes.
- No auth behavior changes.
- No evidence schema changes.
- No deployment workflow YAML changes.

## Customer Impact

When a deployed K3 WISE smoke run fails with a messy URL, route path, adapter
message, or copied customer text, the GitHub Step Summary remains readable.
That keeps the deploy smoke artifact useful for handoff and customer-facing
signoff instead of forcing engineers to open raw JSON first.

