## Multitable Frontend Module Recut Development

Date: 2026-03-19

### Context

PR `#483` (`feat(multitable): multi-dimensional table frontend module (6 phases)`) was green after fixing `contracts (openapi)`, but the branch had no usable merge base with current `main`. A normal `git merge origin/main` failed with `refusing to merge unrelated histories`.

### Recut Strategy

- Started from current `origin/main`
- Restored the PR file set from commit `6b3e52d245bc79fb51b482181db6491af893e9ca`
- Did not reuse old generated OpenAPI artifacts directly
- Rebuilt `packages/openapi/dist/*` on top of current `main`
- Restored `packages/openapi/src/base.yml` to current `main` first, then reapplied only the multitable-specific schema additions so newer non-multitable schema fields on `main` were preserved

### Delivered Scope

- New frontend multitable module under `apps/web/src/multitable/*`
- Multitable Vitest coverage under `apps/web/tests/multitable-*.spec.ts`
- Multitable OpenAPI source definitions in `packages/openapi/src/paths/multitable.yml`
- Multitable schema additions in `packages/openapi/src/base.yml`
- Regenerated OpenAPI dist artifacts in `packages/openapi/dist/*`
- Existing multitable design and delivery docs from the original PR file set

### Notes

- The original `#483` branch should be treated as superseded once the recut PR is open.
- Temporary worktrees used for validation may show tracked plugin `node_modules` link noise after `pnpm install`; those changes are not part of the recut commit.
