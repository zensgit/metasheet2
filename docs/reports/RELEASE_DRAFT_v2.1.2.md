Release v2.1.2 (Draft)

Summary
- Documentation refresh focused on onboarding and plugin views.

Changes
- Contributor guides: refined `AGENTS.md` and `AGENTS.zh-CN.md` (commands, testing gates, architecture notes)
- README: link to both guides
- Frontend: `docs/frontend/dynamic-views.md` explaining plugin-provided views rendering
- Onboarding: `docs/quickstart.md` for a fast Kanban MVP setup

Impact
- Docs-only; no runtime or API behavior changes.

Verification
- All referenced paths exist in repo and in README
- CI workflows unaffected; no code modifications

Rollback
- Revert the touched files if necessary

Acknowledgements
- PRs: #110, #111
