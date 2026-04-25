# DingTalk P4 Current Remaining Development TODO Development

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Base commit: `30a6ee05d`
- Scope: add an execution-focused current remaining-development TODO for DingTalk P4

## Context

The current branch has already implemented the P4 product/tooling chain and recorded local readiness. The work still open against the target is mostly external verification against 142/staging and real DingTalk clients, plus final release evidence handoff.

The previous remaining TODO documented the full ordered checklist. This slice adds a sharper current-state execution view that answers how much development remains and separates conditional code work from required remote verification.

## Changes

- Added `docs/development/dingtalk-p4-current-remaining-development-todo-20260424.md`.
- Quantified remaining work as conditional code fixes, external smoke/evidence, and final closeout.
- Defined the completion boundary for `remoteSmokePhase`, `overallStatus`, final packet validation, final docs, and PR handoff.
- Split the remaining work into P0-P7 execution phases.
- Added a conditional code-fix lane for failures discovered by real smoke.
- Added a parallel execution plan for env readiness, non-sandbox regression, manual evidence preparation, and closeout preparation.
- Linked the new current TODO from the main DingTalk feature plan.

## Out Of Scope

- No real 142/staging smoke was executed.
- No admin token, DingTalk webhook, robot secret, user token, public form token, or temporary password was added to tracked files.
- No product code or smoke tooling code was changed.
- No checklist item that requires real DingTalk evidence was marked complete.
