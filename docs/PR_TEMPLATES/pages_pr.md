---
name: GitHub Pages (OpenAPI) Clean PR Checklist
about: Minimal PR to enable OpenAPI Pages without dragging unrelated commits
---

Scope
- Only include files related to Pages and OpenAPI artifacts:
  - .github/workflows/publish-openapi-pages.yml
  - metasheet-v2/packages/openapi/** (build, validate, dist/index.html, dist/openapi.yaml)
  - [Optional] CI: include OpenAPI build/validate to ensure artifacts exist

Required Checks
- Observability (V2) / v2-observability
- Migration Replay (V2) / replay

Verification Steps
- After merge, confirm Pages deployment succeeds
  - Redoc: https://<owner>.github.io/<repo>/
  - YAML: https://<owner>.github.io/<repo>/openapi.yaml

Notes
- If PR #NN contains broad v2/init history, open this clean PR from main and cherry-pick only Pages commits.
- Close #NN after this PR merges, and open a tracking issue to merge remaining v2 features in phases.

