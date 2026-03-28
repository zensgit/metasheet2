# Multitable Pilot Daily Triage Template

Date: 2026-03-19  
Scope: Daily pilot issue review

## Triage Metadata

- Date:
- Moderator:
- Teams reviewed:
- Build / branch / commit:
- On-prem gate stamp:
- Release gate result:
- `gates/report.json` path:
- Release gate failed step (if any):
- Release-bound report:
- Handoff artifact:

## New Issues

For each issue:

1. Title:
2. Team:
3. Scenario: `import / person / attachment / form / comments / search / conflict / other`
4. Severity: `P0 / P1 / P2 / P3`
5. Blocking pilot: `Yes / No`
6. Repro steps:
7. Expected:
8. Actual:
9. Artifact path or issue link:
10. Related gate evidence (`gates/report.json` / readiness / smoke path):
11. Owner:
12. Fix target: `today / 24h / backlog`

## Daily Decision

- `P0` count:
- `P1` count:
- `P2` count:
- `P3` count:
- Pilot should continue tomorrow: `Yes / No`
- Hotfix required today: `Yes / No`
- If yes, exact fix batch:

## Notes

- Repeated confusion themes:
- Copy / UX issues worth fixing without changing contracts:
- Risks to watch tomorrow:

## Evidence Paths

- `output/playwright/multitable-pilot-handoff/<stamp>/handoff.md`
- `output/playwright/multitable-pilot-handoff/<stamp>/release-bound/report.md`
- `output/playwright/multitable-pilot-ready-local/<stamp>/readiness.md`
- `output/playwright/multitable-pilot-ready-local/<stamp>/gates/report.json`
