# Multitable Executable Assets Sync

Date: 2026-03-26

## Goal

Complete the remaining high-value multitable functionality port from the old worktree into the clean mainline worktree by restoring the executable surface area, not just the frontend path.

This round focuses on the residual gap that remained after the main UI flows were already ported:

- multitable pilot smoke entrypoints
- multitable pilot/on-prem ops scripts
- multitable profile/report helper scripts
- deployment templates and issue template assets required by those scripts
- root `package.json` script entrypoints

## Design

The new worktree had already caught up on the main multitable UI/runtime path, but it still lacked a full executable shell around that functionality.

The missing surface was concentrated in:

- `scripts/verify-multitable-live-smoke.mjs`
- `scripts/profile-multitable-grid.mjs`
- `scripts/ops/multitable-*`
- `docs/deployment/multitable-*`
- root package scripts that exposed those commands

The sync strategy for this round was intentionally narrow:

1. Keep the new worktree as the mainline source of truth for frontend/runtime code.
2. Copy only the residual high-value executable assets from the old multitable worktree.
3. Do not overwrite newer clean-mainline-only multitable logic such as the expanded `verify-smoke-core.mjs`.
4. Verify syntax, entrypoint discovery, and template dependency completeness after the sync.

## Files Synced

### Scripts

- `scripts/verify-multitable-live-smoke.mjs`
- `scripts/profile-multitable-grid.mjs`
- `scripts/ops/multitable-grid-profile-summary.mjs`
- `scripts/ops/multitable-onprem-delivery-bundle.mjs`
- `scripts/ops/multitable-onprem-deploy-easy.sh`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-install.sh`
- `scripts/ops/multitable-onprem-package-upgrade.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `scripts/ops/multitable-onprem-preflight.sh`
- `scripts/ops/multitable-onprem-release-gate.sh`
- `scripts/ops/multitable-onprem-repair-helper.sh`
- `scripts/ops/multitable-pilot-handoff-release-bound.sh`
- `scripts/ops/multitable-pilot-handoff.mjs`
- `scripts/ops/multitable-pilot-local.sh`
- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-ready-local.sh`
- `scripts/ops/multitable-pilot-ready-release-bound.sh`
- `scripts/ops/multitable-pilot-release-bound.sh`
- `scripts/ops/multitable-pilot-release-gate.sh`

### Deployment Assets

- `docs/deployment/multitable-customer-delivery-signoff-template-20260323.md`
- `docs/deployment/multitable-pilot-expansion-decision-template-20260323.md`
- `docs/deployment/multitable-uat-signoff-template-20260323.md`
- refreshed multitable deployment/runbook/checklist/template files under `docs/deployment`
- `.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml`

### Entrypoints

Restored root `package.json` scripts:

- `verify:multitable-pilot`
- `verify:multitable-pilot:local`
- `verify:multitable-pilot:readiness`
- `verify:multitable-pilot:ready:local`
- `verify:multitable-pilot:ready:local:release-bound`
- `verify:multitable-pilot:release-gate`
- `prepare:multitable-pilot:handoff:release-bound`
- `prepare:multitable-pilot:release-bound`
- `verify:multitable-onprem:release-gate`
- `profile:multitable-grid`
- `profile:multitable-grid:local`
- `verify:multitable-grid-profile:summary`

## Verification

### Syntax

Ran:

```bash
node --check scripts/verify-multitable-live-smoke.mjs
node --check scripts/profile-multitable-grid.mjs
node --check scripts/ops/multitable-grid-profile-summary.mjs
node --check scripts/ops/multitable-onprem-delivery-bundle.mjs
node --check scripts/ops/multitable-pilot-handoff.mjs
node --check scripts/ops/multitable-pilot-readiness.mjs
```

All passed.

Ran:

```bash
bash -n scripts/ops/multitable-onprem-deploy-easy.sh
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-install.sh
bash -n scripts/ops/multitable-onprem-package-upgrade.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
bash -n scripts/ops/multitable-onprem-preflight.sh
bash -n scripts/ops/multitable-onprem-release-gate.sh
bash -n scripts/ops/multitable-onprem-repair-helper.sh
bash -n scripts/ops/multitable-pilot-handoff-release-bound.sh
bash -n scripts/ops/multitable-pilot-local.sh
bash -n scripts/ops/multitable-pilot-ready-local.sh
bash -n scripts/ops/multitable-pilot-ready-release-bound.sh
bash -n scripts/ops/multitable-pilot-release-bound.sh
bash -n scripts/ops/multitable-pilot-release-gate.sh
```

All passed.

### Entrypoints

Ran:

```bash
pnpm run | rg 'multitable-(pilot|onprem|grid-profile)|profile:multitable-grid|verify:multitable-pilot|prepare:multitable'
```

Confirmed the restored multitable pilot/on-prem/profile commands are now discoverable again from the root workspace.

### Template Dependency Completeness

Checked all deployment template and issue-template references used by:

- `scripts/ops/multitable-onprem-delivery-bundle.mjs`
- `scripts/ops/multitable-pilot-handoff.mjs`
- `scripts/ops/multitable-pilot-release-bound.sh`
- `scripts/ops/multitable-onprem-release-gate.sh`

Result: all referenced files now exist in the clean worktree.

### Residual Audit

Post-sync comparison result:

- old multitable scripts vs new worktree scripts: `OLD_ONLY 0`, `DIFFERS 0`
- old multitable deployment docs vs new worktree deployment docs: `OLD_ONLY 0`, `DIFFERS 0`
- old multitable frontend tests vs new worktree frontend tests: `OLD_ONLY 0`

Important nuance:

- `apps/web/src/multitable/**` still differs between old and new worktrees.
- Those differences are not missing old-only functionality anymore; they reflect the newer clean-mainline implementation and additional improvements/tests already landed in the new worktree.

## Conclusion

From a functional/code path perspective, the remaining old-worktree multitable executable assets have now been merged into the clean worktree.

The old worktree should still be retained for one more stage if we want history-level confidence, because:

- branch history is still not fully merged
- the old branch still contains reference value for commit archaeology

But the reason to keep it is now historical audit value, not obvious missing multitable functionality.
