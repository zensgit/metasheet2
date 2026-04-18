## Background

`#902` merged the main member-group ACL subject work into `main`, but the follow-up inactive-subject governance slices were still spread across stacked PRs:

- `#910` inactive candidates cannot receive new grants
- `#911` inactive current ACL entries become cleanup-only
- `#912` inactive orphan field/view overrides become visibly identifiable
- `#913` cleanup-only rows explicitly explain their state
- `#914` inactive candidates explicitly explain blocked grants

After `#902` merged, the fastest and cleanest way to continue was to promote these follow-up slices onto a fresh `main`-based branch instead of trying to preserve the old stacked chain.

## Goal

Package the inactive-subject governance follow-ups into one clean branch based on `main`, ready for a single PR and a single validation pass.

## Scope

- replay the five inactive-subject follow-up slices on top of `main`
- preserve the per-slice development and verification notes
- add one package-level record for the consolidation step

## Implementation

### 1. Promote the inactive-subject follow-ups onto `main`

Created a new branch from `main` and replayed the following commits in order:

- `f5fcef3bb` `fix(multitable): block acl grants to inactive candidates`
- `4ee3e44d1` `fix(multitable): lock inactive acl entries to cleanup only`
- `df3eaf7c1` `feat(multitable): surface inactive orphan acl subjects`
- `7a5970d95` `feat(multitable): explain inactive acl cleanup state`
- `e3c2b5de5` `feat(multitable): explain inactive candidate grant blocks`

### 2. Keep the scope limited to inactive-subject governance

No new ACL model was introduced in this package step. The promoted work is still limited to:

- sheet ACL candidate rows
- record ACL candidate rows
- current sheet ACL rows
- current record ACL rows
- field/view template rows
- field/view override rows
- field/view orphan rows

### 3. Preserve per-slice MD coverage

The branch keeps all previously added slice-level development and verification docs so the packaged PR still has traceability for each step.

## Files Added In This Packaging Step

- `docs/development/multitable-inactive-governance-followups-package-development-20260418.md`
- `docs/development/multitable-inactive-governance-followups-package-verification-20260418.md`

## Risk Notes

- no new runtime semantics beyond the previously verified slices
- no backend changes
- no migration
- no deployment-step change
