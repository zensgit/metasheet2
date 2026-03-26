# Multitable Pilot Release Gate Run Mode

## Context

`staging` 的 `ready/handoff/release-bound` 链已经支持独立输出根和 wrapper artifact，但 `multitable-pilot-release-gate.sh` 仍然保留了 `local` 假设：

- skipped live smoke note 固定写成 `executed earlier by multitable-pilot-ready-local`
- canonical gate report 没有显式 `runMode`
- direct gate 命令没有 `staging` 入口

这会导致 `staging` 复用 smoke artifact 时，顶层 gate 摘要仍像 `local` 执行。

## Design

### 1. Make release gate run-mode aware

`scripts/ops/multitable-pilot-release-gate.sh` 新增：

- `RUN_MODE=${RUN_MODE:-local}`
- `local`:
  - smoke command: `pnpm verify:multitable-pilot`
  - skipped note: `executed earlier by multitable-pilot-ready-local`
- `staging`:
  - smoke command: `pnpm verify:multitable-pilot:staging`
  - skipped note: `executed earlier by multitable-pilot-ready-staging`

同时把 `runMode` 写入 canonical `report.json` / `report.md`。

### 2. Thread RUN_MODE through readiness wrappers

避免 wrapper 调 gate 时丢 mode：

- `multitable-pilot-ready-local.sh` 调 gate 时显式传 `RUN_MODE=local`
- `multitable-pilot-ready-staging.sh` 调 gate 时显式传 `RUN_MODE=staging`

### 3. Add direct staging gate command

`package.json` 新增：

- `verify:multitable-pilot:release-gate:staging`

这样 staging 不需要靠手动写环境变量去跑 canonical gate。

## Verification

### Focused ops tests

执行：

```bash
node --test \
  scripts/ops/multitable-pilot-release-gate.test.mjs \
  scripts/ops/multitable-pilot-ready-staging.test.mjs
```

覆盖：

- local skipped smoke 仍保持原行为
- staging skipped smoke 改成：
  - `pnpm verify:multitable-pilot:staging`
  - `executed earlier by multitable-pilot-ready-staging`
  - `report.runMode === "staging"`
- `ready-staging` 调 gate 时环境里确实带 `RUN_MODE=staging`

### Syntax / build

执行：

```bash
bash -n \
  scripts/ops/multitable-pilot-release-gate.sh \
  scripts/ops/multitable-pilot-ready-local.sh \
  scripts/ops/multitable-pilot-ready-staging.sh

pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

预期：

- shell syntax 通过
- focused ops tests 通过
- web `tsc --noEmit` 通过
- `@metasheet/web build` 通过

## Outcome

现在 `staging` 的 multitable pilot 链在 `release-gate` 这一层也终于是 first-class run mode 了，不再出现：

- staging artifact
- local skip note
- local-only replay command

这种顶层摘要错配。
