docs: refresh contributor guides and add dynamic views doc

Summary
- Refine AGENTS.md (EN) to a concise 200–400 word guide aligned to repo scripts and structure.
- Sync AGENTS.zh-CN.md (update CI coverage gates, keep repo-specific commands).
- Link both guides from README.
- Add docs/frontend/dynamic-views.md explaining how frontend renders plugin-provided views.

Changes
- AGENTS.md: structure, commands, testing gates (≥50% lines/statements/functions; ≥40% branches), PR rules, architecture notes.
- AGENTS.zh-CN.md: align testing gates and troubleshooting.
- README.md: clarify AGENTS links (EN/CN).
- docs/frontend/dynamic-views.md: overview of view-registry, usePlugins flow, local dev hints.

Verification
- Link check: referenced paths exist (AGENTS.md, AGENTS.zh-CN.md, docs/frontend/dynamic-views.md, docs/kysely-type-mapping.md).
- Local quickstart: `pnpm -F @metasheet/core-backend dev:core` and `pnpm -F @metasheet/web dev` → `curl $VITE_API_URL/api/plugins` returns views.

CI Impact
- Docs-only. No code or dependency changes. No workflows modified.

Rollback
- Revert the four touched files to prior versions.

---

Co-authored-by: Docs Automation <docs@metasheet.local>
