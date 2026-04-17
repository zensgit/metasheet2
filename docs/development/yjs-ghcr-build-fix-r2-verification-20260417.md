# Yjs GHCR Build Fix R2 Verification

日期：2026-04-17

## 本地源码验证

在干净 worktree `/tmp/metasheet2-ghcr-publish` 中执行：

```bash
pnpm --filter @metasheet/core-backend build
```

结果：

- 通过

## Docker 验证

执行：

```bash
docker build -f Dockerfile.backend -t ghcr.io/zensgit/metasheet2-backend:20260417-yjs-rollout-r2 .
docker build -f Dockerfile.frontend -t ghcr.io/zensgit/metasheet2-web:20260417-yjs-rollout-r2 .
```

结果：

- backend image build 通过
- frontend image build 通过

## GHCR 发布验证

执行：

```bash
docker push ghcr.io/zensgit/metasheet2-backend:20260417-yjs-rollout-r2
docker push ghcr.io/zensgit/metasheet2-web:20260417-yjs-rollout-r2
docker pull ghcr.io/zensgit/metasheet2-backend:20260417-yjs-rollout-r2
docker pull ghcr.io/zensgit/metasheet2-web:20260417-yjs-rollout-r2
```

结果：

- backend tag 可拉取
- web tag 可拉取

已确认 digest：

- backend: `sha256:009e08988aae2d6e76a9f4f5f80840a6a62f0074a98eadb9a6dfc33fc3d232ee`
- web: `sha256:025028d54f20aad59879f481495eb3c593133e53247d803fc7a1f321812ba481`

## 结论

- `20260417-yjs-rollout-r2` 已可作为真正的 Yjs 发布候选 tag
- 下一步可在远端 `.env` 中切换：

```bash
IMAGE_TAG=20260417-yjs-rollout-r2
```

- 然后再执行：
  - `docker compose pull`
  - `docker compose up -d`
  - migration
  - `check-yjs-rollout-status`
  - `check-yjs-retention-health`
  - `capture-yjs-rollout-report`
