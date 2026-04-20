# DingTalk Group And Person Recipient Rollout Verification

Date: 2026-04-20

## Source Runs

Mainline merge/deploy evidence checked for:

- `#954` merge commit `bab4f5c52b9f8a8f021e2ee6655adfa4334984c1`
- `#955` merge commit `0b18d2bc82c4b833d07805b8d77ef096bd65c69f`

Primary production rollout run:

- `Build and Push Docker Images`
- Run `24674833062`

## Commands

```bash
gh run list --repo zensgit/metasheet2 --branch main --limit 8 --json databaseId,workflowName,displayTitle,headSha,status,conclusion,createdAt
gh run view 24674833062 --repo zensgit/metasheet2 --json databaseId,displayTitle,headSha,status,conclusion,jobs,workflowName
gh run view 24674833062 --repo zensgit/metasheet2 --log --job 72156120286
gh run download 24674833062 --repo zensgit/metasheet2 -n deploy-logs-24674833062-1 -D output/dingtalk-954-955-deploy-20260420
rg -n "image_tag=|persisted IMAGE_OWNER and IMAGE_TAG|=== DEPLOY START ===|=== DEPLOY END ===|=== MIGRATE START ===|=== MIGRATE END ===|Smoke:|=== SMOKE START ===|=== SMOKE END ===" output/dingtalk-954-955-deploy-20260420/deploy-logs-24674833062-1/deploy.log output/dingtalk-954-955-deploy-20260420/deploy-logs-24674833062-1/step-summary.md
git diff --check
```

## Results

From `gh run list`:

- `Deploy to Production` completed for `#955`
- `Build and Push Docker Images` completed for `#955`
- all listed mainline workflows around the merge were `success`

From `gh run view 24674833062`:

- workflow conclusion: `success`
- build job: `success`
- deploy job: `success`

From [deploy.log](/Users/chouhua/Downloads/Github/metasheet2/output/dingtalk-954-955-deploy-20260420/deploy-logs-24674833062-1/deploy.log:1):

- `[deploy] image_tag=0b18d2bc82c4b833d07805b8d77ef096bd65c69f`
- `[deploy] persisted IMAGE_OWNER and IMAGE_TAG in .env`
- `=== DEPLOY START ===`
- `=== DEPLOY END ===`
- `=== MIGRATE START ===`
- `=== MIGRATE END ===`
- `=== SMOKE START ===`
- `Smoke: api/plugins=ok health=ok web=ok`
- `=== SMOKE END ===`

From [step-summary.md](/Users/chouhua/Downloads/Github/metasheet2/output/dingtalk-954-955-deploy-20260420/deploy-logs-24674833062-1/step-summary.md:1):

- `Smoke: PASS`

## Verification Conclusion

`#954` and `#955` are both in `main`, and the production Docker rollout for `0b18d2bc82c4b833d07805b8d77ef096bd65c69f` completed successfully with:

- published images
- remote `.env` reconciliation
- deploy success
- migrate success
- smoke success
