# DingTalk Person Member Group Field Picker Deploy Verification

- Date: 2026-04-21
- Target change: `#965 feat(dingtalk): add member group field picker`
- Target commit: `c4093dcb813f734a32c8ded5bc9d280feec6fcb3`

## Verification Commands

```bash
gh pr view 965 --repo zensgit/metasheet2 --json number,title,state,mergeCommit,mergedAt,headRefName,baseRefName,url
gh run list --repo zensgit/metasheet2 --branch main --limit 8 --json databaseId,workflowName,displayTitle,headSha,status,conclusion,createdAt
gh run view 24699127741 --repo zensgit/metasheet2 --json databaseId,displayTitle,headSha,status,conclusion,jobs,workflowName
rg -n "image_tag=|persisted IMAGE_OWNER and IMAGE_TAG|=== DEPLOY START ===|=== DEPLOY END ===|=== MIGRATE START ===|=== MIGRATE END ===|Smoke:|=== SMOKE START ===|=== SMOKE END ===" output/dingtalk-965-deploy-20260421/deploy-logs-24699127741-1/deploy.log output/dingtalk-965-deploy-20260421/deploy-logs-24699127741-1/step-summary.md
git diff --check
```

## Results

### Mainline

- PR `#965` merged successfully.
- Merge commit:
  - `c4093dcb813f734a32c8ded5bc9d280feec6fcb3`
- Merged at:
  - `2026-04-21T01:23:42Z`

### Workflows

For `main@c4093dcb813f734a32c8ded5bc9d280feec6fcb3`:

- `Build and Push Docker Images` run `24699127741`: `success`
- `Plugin System Tests` run `24699127731`: `success`
- `Phase 5 Production Flags Guard` run `24699127750`: `success`
- `Observability E2E` run `24699127754`: `success`
- `.github/workflows/monitoring-alert.yml` run `24699127733`: `success`
- `Deploy to Production` run `24699127734`: `success`

Authoritative deploy path:

- workflow: `Build and Push Docker Images`
- run: `24699127741`
- jobs:
  - `build` job `72238342156`: `success`
  - `deploy` job `72238527775`: `success`

### Deploy Artifact Evidence

From `output/dingtalk-965-deploy-20260421/deploy-logs-24699127741-1/deploy.log`:

- `[deploy] image_tag=c4093dcb813f734a32c8ded5bc9d280feec6fcb3`
- `[deploy] persisted IMAGE_OWNER and IMAGE_TAG in .env`
- `=== DEPLOY START ===`
- `=== DEPLOY END ===`
- `=== MIGRATE START ===`
- `=== MIGRATE END ===`
- `=== SMOKE START ===`
- `Smoke: api/plugins=ok health=ok web=ok`
- `=== SMOKE END ===`

From `output/dingtalk-965-deploy-20260421/deploy-logs-24699127741-1/step-summary.md`:

- `Smoke: PASS`

### Workflow Interpretation

- `Deploy to Production` run `24699127734` succeeded, but it only executed the preflight `test` job for this merge.
- The actual remote rollout evidence comes from `Build and Push Docker Images` run `24699127741`, because that workflow includes the successful `deploy` job and uploaded deploy artifact.

## Conclusion

`#965` was merged, built, deployed, and smoke-checked successfully in production. The deploy artifact confirms that:

- the deployed image tag matched `c4093dcb813f734a32c8ded5bc9d280feec6fcb3`,
- remote `.env` tag persistence ran,
- migrate completed,
- smoke checks passed with `api/plugins=ok health=ok web=ok`.
