## Execution

工作目录：

- `PR3` worktree: `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408`
- CI merge ref 临时 worktree: `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/pr724-merge-ref`

排查顺序：

1. 读取 `contracts (openapi)` 失败日志，确认失败点是 `openapi dist drift detected`
2. 在 `PR3` 分支头本地执行 `pnpm exec tsx packages/openapi/tools/build.ts`
3. 在 CI 用的 merge ref `pull/724/merge` 上复现
4. 在 Node `20.20.2` + pnpm `9.15.9` 环境下再次复现，确认不是旧 run 假阳性
5. 重新生成并提交 `packages/openapi/dist/*`

## Files Updated

- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/combined.openapi.yml`

## Verification Commands

```bash
npx -p node@20.20.2 -p pnpm@9.15.9 -c 'pnpm exec tsx packages/openapi/tools/build.ts'
git diff -- packages/openapi/dist/openapi.json packages/openapi/dist/openapi.yaml packages/openapi/dist/combined.openapi.yml
```

提交后再用和 CI 一致的命令验证：

```bash
npx -p node@20.20.2 -p pnpm@9.15.9 -c 'bash scripts/ops/attendance-run-gate-contract-case.sh openapi'
```

## Expected Outcome

- `contracts (openapi)` 重新运行后转绿
- `PR #724` 只剩 review / draft 状态门槛，不再被 contract drift 卡住
