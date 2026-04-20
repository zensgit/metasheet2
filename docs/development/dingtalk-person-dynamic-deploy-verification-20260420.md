# DingTalk Person Dynamic Recipients Deploy Verification

- Date: 2026-04-20
- Target change: `#952 feat(dingtalk): package dynamic person recipient automation`
- Target commit: `67d23da123b92d9d8fb96940c718f716a9d0c023`

## Verification Commands

```bash
gh run list --branch main --limit 6 --json databaseId,workflowName,displayTitle,headSha,status,conclusion,createdAt
gh run view 24670485107 --json databaseId,displayTitle,headSha,status,conclusion,jobs,workflowName
gh run view 24670485107 --job 72140017011 --log
gh run download 24670485107 -n deploy-logs-24670485107-1 -D output/playwright/ga/24670485107
rg -n "image_tag=|=== DEPLOY START ===|=== DEPLOY END ===|=== MIGRATE START ===|=== MIGRATE END ===|Smoke:|=== SMOKE START ===|=== SMOKE END ===|persisted IMAGE_OWNER and IMAGE_TAG" output/playwright/ga/24670485107/deploy.log
sed -n '1,220p' output/playwright/ga/24670485107/step-summary.md
git diff --check
```

## Results

### Mainline

- `origin/main` head:
  - `67d23da123b92d9d8fb96940c718f716a9d0c023`
- PR `#952` merged successfully.

### Workflows

- `Build and Push Docker Images` run `24670485107`: `success`
- Jobs:
  - `build`: `success`
  - `deploy`: `success`

### Deploy Artifact Evidence

From `output/playwright/ga/24670485107/deploy.log`:

- `[deploy] image_tag=67d23da123b92d9d8fb96940c718f716a9d0c023`
- `[deploy] persisted IMAGE_OWNER and IMAGE_TAG in .env`
- `=== DEPLOY START ===`
- `=== DEPLOY END ===`
- `=== MIGRATE START ===`
- `=== MIGRATE END ===`
- `=== SMOKE START ===`
- `Smoke: api/plugins=ok health=ok web=ok`
- `=== SMOKE END ===`

### Step Summary Evidence

From `output/playwright/ga/24670485107/step-summary.md`:

- Overall: `PASS`
- Remote exit code: `0`
- Remote preflight: `PASS`
- Deploy: `PASS`
- Migrate: `PASS`
- Smoke: `PASS`

## Conclusion

`#952` was built and deployed through the production Docker workflow, and the remote deploy artifact shows:

- the new SHA-tagged backend/web images were used,
- the remote `.env` tag persistence ran,
- migration completed,
- smoke checks passed with `api/plugins=ok health=ok web=ok`.

## Known Limits

- Direct non-interactive SSH verification from the local terminal was not available during this run.
- Public access to `http://142.171.239.56:8900/health` returned an empty reply, so the verification source of truth for this rollout is the successful production deploy artifact rather than direct host probing.
