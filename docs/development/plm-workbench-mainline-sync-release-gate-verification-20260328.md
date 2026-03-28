# PLM Workbench Mainline Sync Release Gate Verification

## Preflight

Use an isolated temporary clone to verify that `origin/main` can merge cleanly into `codex/plm-workbench-collab-20260312` without reopening conflict resolution work.

Expected result:

- merge applies without conflicts
- merge stops at `--no-commit --no-ff` cleanly

## Local verification after real merge

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected result:

- PLM frontend still type-checks
- PLM regression suite stays green on top of the updated mainline base

## Release gate interpretation

This sync is considered successful when:

1. the branch is no longer blocked by stale base divergence
2. local PLM verification remains green
3. remote checks can re-run on the merged branch head

Formal release still depends on:

- GitHub checks turning green on the new head
- PR leaving `Draft`
- final staging smoke
