# DingTalk Directory Focus Mainline Sync Verification

日期：2026-04-15

## 分支同步

命令：

```bash
git fetch origin
git merge --no-edit origin/main
```

结果：
- 合并成功
- 无冲突

## 同步后验证

### 前端类型检查

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

结果：
- 通过

### 定向视图回归

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts --reporter=dot
```

结果：
- `1` 个文件通过
- `21/21` 用例通过

## GitHub 状态

同步前：
- `#877` `mergeStateStatus=BEHIND`

同步后预期：
- 推送新 head 后，GitHub 重新计算 merge state
- 仍只应剩 reviewer gate，而不是代码/CI gate

## 本地说明

worktree 中仍保留未跟踪的 `node_modules` symlink，仅用于本地测试，不会进入 git。
