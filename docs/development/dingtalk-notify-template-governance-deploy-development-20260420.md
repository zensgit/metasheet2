# DingTalk Notify Template Governance Deploy Development - 2026-04-20

## Goal

Deploy the main-based DingTalk notification template governance package (`#930`) to the production-like remote host so the live authoring UI matches the newly merged main branch.

## Scope

- No new runtime feature work.
- No schema changes.
- Remote deployment and smoke verification only.

## Inputs

- Merged PR: `#930`
- Main commit: `71e29327d052f4976dff549e46d34aa96f398667`
- Remote host: `142.171.239.56`
- Remote repo path: `~/metasheet2`

## Work Completed

1. Confirmed `origin/main` advanced to `71e29327d052f4976dff549e46d34aa96f398667`.
2. Verified the remote checkout was already fast-forwarded to the same main commit.
3. Confirmed the remote runtime still pointed at the older image tag `700358ead790daa55cbcfb3e55c2a4bda4fe64f7`.
4. Updated remote `.env` so `IMAGE_TAG=71e29327d052f4976dff549e46d34aa96f398667`.
5. Pulled and restarted `backend` and `web` with the new image tag.
6. Re-ran backend migrations even though `#930` introduced no new migration, to keep the rollout path explicit and repeatable.
7. Ran post-deploy smoke checks for:
   - backend health
   - running image tags
   - presence of the template-governance UI strings inside the deployed web bundle

## Remote Commands

```bash
ssh -o BatchMode=yes -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 '
  cd ~/metasheet2 &&
  perl -0pi -e "s/^IMAGE_TAG=.*/IMAGE_TAG=71e29327d052f4976dff549e46d34aa96f398667/m" .env &&
  grep ^IMAGE_TAG .env &&
  docker compose -f docker-compose.app.yml pull backend web &&
  docker compose -f docker-compose.app.yml up -d backend web &&
  docker compose -f docker-compose.app.yml exec -T backend \
    node packages/core-backend/dist/src/db/migrate.js &&
  docker compose -f docker-compose.app.yml ps &&
  curl -sf http://127.0.0.1:8900/health
'
```

```bash
ssh -o BatchMode=yes -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 '
  cd ~/metasheet2 &&
  docker compose -f docker-compose.app.yml exec -T web sh -lc "
    grep -R -n -E '\''Message summary|Apply preset|Rendered title|Unknown placeholder|Unknown template path'\'' \
      /usr/share/nginx/html/assets | head -n 20
  "
'
```

## Claude Code CLI Usage

Used `claude -p` locally in read-only mode to generate a concise post-deploy smoke checklist for public-form and internal-link authoring. Deployment execution itself was performed directly from the shell.

## Outcome

- Remote source checkout and remote runtime are both aligned to `main@71e29327d052f4976dff549e46d34aa96f398667`.
- The template-governance authoring polish from `#930` is now available in the live environment.
