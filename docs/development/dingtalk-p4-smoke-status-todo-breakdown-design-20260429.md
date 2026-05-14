# DingTalk P4 Smoke Status TODO Breakdown Design

- Date: 2026-04-29
- Branch: `codex/dingtalk-smoke-status-todo-breakdown-20260429`
- Base: `origin/main` at `54b08b3b6`
- Scope: make generated remote-smoke status/TODO reports show manual-evidence and automated-check remaining work separately

## Goal

The generated P4 smoke status already reports aggregate remote-smoke progress, but operators still need to inspect every row to answer how much of the remaining work requires real DingTalk client/admin evidence versus rerunning automated/API bootstrap checks. This slice adds a direct breakdown so the next operator can prioritize manual phone/client work without guessing.

## Design

- Keep the existing `remoteSmokeTodos.total`, `completed`, `remaining`, and `items[]` contract unchanged.
- Add `remoteSmokeTodos.manualEvidence` with `total`, `completed`, and `remaining`.
- Add `remoteSmokeTodos.automatedChecks` with `total`, `completed`, and `remaining`.
- Render the same breakdown in both generated status Markdown and executable TODO Markdown.
- Treat each required check's existing `manual` flag as the source of truth.
- Preserve all redaction behavior; the new fields are numeric counts only.

## Compatibility

- Existing JSON consumers can keep reading the aggregate progress and `items[]`.
- New handoff/status consumers can read the manual-vs-automated breakdown directly.
- No network, DingTalk, 142 server, database, or browser call is added.

## Operator Impact

- If `manualEvidence.remaining > 0`, real DingTalk client/admin evidence is still required.
- If `automatedChecks.remaining > 0`, the next action is rerun/inspect API bootstrap or delivery-history evidence.
- If both are `0` and aggregate `remaining` is `0`, the flow can proceed toward final closeout/handoff gates.
