# K3 WISE Live PoC Markdown Escape Design

Date: 2026-05-07

## Context

The K3 WISE live PoC path produces two operator-facing Markdown files:

- `integration-k3wise-live-poc-packet.md`
- `integration-k3wise-live-poc-evidence-report.md`

The matching JSON files are the machine contract. The Markdown files are the
human handoff contract for customer GATE answers, dry-run evidence, Save-only
write evidence, replay evidence, and signoff review.

Before this slice, both Markdown renderers interpolated dynamic values directly
into bullets and tables. Customer-provided values such as tenant IDs, workspace
IDs, evidence paths, run IDs, issue messages, or checklist text could contain
Markdown-sensitive characters:

- table pipes: `|`
- line breaks copied from email or spreadsheet cells
- backticks in diagnostic text or route names

That could split table rows or make the handoff report ambiguous even though the
JSON evidence remained valid.

## Change

This slice adds local Markdown rendering helpers to both live PoC scripts:

- `markdownText(value)` collapses CR/LF and repeated whitespace into one line.
- `markdownInlineCode(value)` wraps dynamic values in inline code and chooses a
  backtick fence long enough for values that already contain backticks.
- `markdownTableCodeCell(value)` applies inline-code rendering and escapes table
  pipes so GitHub-flavored Markdown keeps table columns stable.

Applied surfaces:

- `integration-k3wise-live-poc-preflight.mjs`
  - summary metadata bullets
  - External Systems table
  - Pipelines table
  - Checklist table
  - Safety Notes bullets
- `integration-k3wise-live-poc-evidence.mjs`
  - decision metadata bullets
  - Phase Results table
  - Issues table

## Scope

This does not change:

- preflight validation
- evidence decision logic
- JSON packet/report shape
- CLI stdout shape
- secret redaction rules
- mock PoC adapter behavior

Only Markdown formatting changes.

## Conflict Note

Several open K3 WISE PRs touch the same live PoC scripts for security and
safety validation. Those PRs do not modify the existing `renderMarkdown()`
surface in the current review diff, but merge order can still require a normal
rebase.

## Risk

Low. The output becomes more code-span heavy, but the handoff files are now
stable when customer text contains punctuation that would otherwise alter table
structure.
