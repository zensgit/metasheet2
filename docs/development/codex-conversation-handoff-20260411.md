# Codex Conversation Handoff

Date: 2026-04-11

## Current Recommended Package

- Package: `multitable-onprem-run20-20260407`
- Release: https://github.com/zensgit/metasheet2/releases/tag/multitable-onprem-run20-20260407
- Recommended deployment env:

```env
PRODUCT_MODE=platform
ENABLE_PLM=0
```

## Current Delivery Status

The Windows on-prem delivery line is now green end-to-end.

Validated in field:

- `deploy.bat` exit code `0`
- `pnpm install` resolves runtime deps correctly
- `bootstrap-admin.bat` exit code `0`
- admin login succeeds after bootstrap

This closes the `run13 -> run20` Windows reroll chain.

## Important Final Fixes

### Windows packaging / bootstrap chain

- `run17`: stop using `node -e` in Windows bootstrap helper
- `run18`: move temp `.cjs` execution under package-local `.tmp/node-bootstrap`
- `run19`: add `bcryptjs` to root runtime dependencies and lock it in package verify
- `run20`: normalize `process.argv` so temp `.cjs` keeps the old `node -e` indexing semantics

Relevant merged PRs:

- `#709` fix(multitable): stop using node -e in windows bootstrap
- `#710` fix(multitable): resolve bcryptjs in windows bootstrap
- `#711` fix(multitable): add bcryptjs to root runtime deps
- `#712` fix(multitable): preserve argv in windows bootstrap

## Earlier Product / Delivery Milestones

### Platform / attendance delivery

- `run5`: platform shell + approvals/nav fixes considered stable
- `run8`: reports 2.0 slice with time ranges, trend cards, management stats
- `run9`: employee self-service dashboard 2.0 slice
- `run10`: import/export ops summary and preview outcome improvements
- `run11+`: RC and Windows delivery hardening

### Key stable product behaviors already validated

- attendance works in `platform` mode
- PLM can be disabled with `ENABLE_PLM=0`
- employee attendance self-service permissions work
- approvals inbox no longer loops users back to login
- attendance overview and reports are split and independently useful
- Windows deployment and admin bootstrap now work

## Still Open / Non-Blocker Polish

Tracked mainly in:

- Issue: https://github.com/zensgit/metasheet2/issues/651

Known non-blockers still mentioned during validation:

- logout triggers a burst of meaningless `403` requests
- approvals page may still have console-noise follow-up worth checking
- new employees without attendance-group assignment need a clearer empty-state prompt
- mobile / small-screen detection in some admin surfaces is still rough
- login rate limit is aggressive for dev/test workflows
- attendance/multitable script naming is still mixed in some places

## Repo / Working State Notes

- Do **not** assume the root worktree is clean.
- At the time of this handoff, the root repo contains unrelated untracked local files and other in-progress docs.
- Avoid destructive cleanup from the root worktree.
- Prefer a fresh dedicated worktree for new slices or release fixes.

## Recommended Next Step

Do **not** continue the Windows bootstrap reroll line unless a new real blocker appears.

Preferred next tracks:

1. RC polish from `#651`
2. approval-center product work
3. attendance/product iteration work, but not on the `run20` fix line

## How To Resume On Another Computer

Open this file and tell Codex:

> Continue from `/Users/huazhou/Downloads/Github/metasheet2/docs/development/codex-conversation-handoff-20260411.md`. Treat `multitable-onprem-run20-20260407` as the current recommended package and use issue `#651` as the non-blocker polish backlog.

## Source References

- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-run5-delivery-summary-20260403.md`
- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-windows-bootstrap-admin-design-20260407.md`
- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-windows-bootstrap-psql-fix-design-20260407.md`
- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-windows-bootstrap-node-cjs-fix-design-20260407.md`
- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-windows-bootstrap-modulepath-fix-design-20260407.md`
- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-windows-bootstrap-bcrypt-rootdep-design-20260407.md`
- `/Users/huazhou/Downloads/Github/metasheet2/docs/development/multitable-windows-bootstrap-argv-fix-design-20260407.md`
