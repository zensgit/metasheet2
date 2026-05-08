# K3 WISE Postdeploy Smoke Markdown Escape Design

Date: 2026-05-07

## Context

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` writes two evidence files
after a postdeploy diagnostic run:

- `integration-k3wise-postdeploy-smoke.json`
- `integration-k3wise-postdeploy-smoke.md`

The JSON evidence is consumed by automation and remains structurally safe. The
Markdown evidence is operator-facing and may include deployment-specific values
from runtime responses, route checks, descriptor failures, and operator-provided
inputs.

Before this slice, the Markdown renderer interpolated several values directly:

- `generatedAt`
- `baseUrl`
- `signoff.reason`
- check `id`
- check `status`
- check detail/error text

The detail cell escaped table pipes, but it did not collapse newlines. Check IDs
and statuses were not escaped. A response value containing `|`, backticks, or
newlines could split the Markdown table or make the evidence hard to read in a
handoff package.

## Change

This slice adds a small Markdown rendering boundary inside
`integration-k3wise-postdeploy-smoke.mjs`:

- `markdownText(value)` collapses CR/LF and repeated whitespace into one line.
- `markdownInlineCode(value)` renders values as inline code and uses a dynamic
  backtick fence long enough for values that already contain backticks.
- `markdownTableCodeCell(value)` uses the inline-code renderer and escapes table
  pipes so GitHub-flavored Markdown keeps the table shape stable.

The renderer now applies these helpers to:

- metadata bullets for generated time and base URL;
- signoff reason text;
- every Markdown table row for check ID, status, and detail.

## Scope

This does not change diagnostic behavior, HTTP probes, JSON evidence shape, exit
codes, token reading, or redaction semantics. It only changes the human-readable
Markdown evidence formatting.

## Risk

Low. Existing checks keep the same IDs/statuses in JSON and stdout. The Markdown
file becomes slightly more code-span heavy, but it is more resilient when values
contain user or deployment-sourced punctuation.

## Follow-Up

If more ops scripts start writing GitHub-flavored Markdown, consider extracting a
shared Markdown utility after at least two scripts need the same helpers. For now
the helper stays local to avoid adding another shared ops dependency.
