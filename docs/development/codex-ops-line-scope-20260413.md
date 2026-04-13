# Codex Ops Line Scope

Date: 2026-04-13

Purpose: define the responsibility boundary for this Codex conversation line after the cross-device handoff.

## This Line Is For

Use this line as the dedicated `ops / staging / on-prem / delivery` track for `metasheet2`.

Primary responsibilities:

1. staging and on-prem runtime health
2. release packaging and delivery bundle verification
3. release-bound / preflight / handoff evidence collection
4. DingTalk `stability / drill / summary`
5. Slack / Alertmanager / Grafana / Prometheus operational continuity
6. remote host capacity checks and deployment feasibility judgments
7. UAT support, implementation support, and issue triage related to deployed environments

## This Line Is Not For

Do not use this line as the default place for:

1. large product feature development
2. unrelated UI feature work
3. multi-slice application implementation that is not directly tied to delivery or operations
4. broad architecture experimentation unrelated to staging / on-prem runtime

Those should go to separate dedicated development branches and conversation lines.

## Why This Boundary Exists

This line already carries a large amount of environment-specific context:

- host `142.171.239.56`
- staging and on-prem release status
- multitable delivery bundle history
- DingTalk monitoring / alerting chain
- runbooks, drill behavior, and preflight evidence expectations

Keeping this line scoped to operations reduces context drift and lowers the chance of deployment mistakes.

## Allowed Work Examples

- verify current staging deployment state
- create or validate temporary staging access for testing
- regenerate or validate release bundles
- inspect `stability / drill / summary` results
- review alert delivery failures
- check host capacity before deployment
- support UAT with deployed environment facts
- collect final preflight evidence for sign-off

## Preferred Resume Order

When resuming this ops line, read in this order:

1. `docs/development/codex-conversation-handoff-20260411.md`
2. `docs/development/multitable-session-20260411-handoff.md`
3. `docs/development/codex-cross-device-handoff-20260411.md`
4. `docs/development/codex-ops-line-scope-20260413.md`

## Current Working Rule

If the task is primarily about deployed environments, releases, delivery evidence, on-prem observability, or UAT support, continue in this line.

If the task is primarily about implementing new product behavior, open a separate development line instead.

