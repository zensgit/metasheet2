# DingTalk Directory Batch Progress

## Goal

继续把目录 review queue 做成真实可运营的管理员工作台。

在已有的批量绑定、推荐确认、批量停权处理里，管理员之前只能看到按钮上的 `处理中...` 和最终一条成功提示；中间没有任何可见的处理状态，也不知道当前目标项数和系统处于哪个阶段。

本轮目标：

- 给 review queue 的批量动作增加可见的处理进度。
- 在不改后端接口的前提下，明确展示：
  - 当前动作类型
  - 当前阶段
  - 当前进度 `X / Y`
- 继续兼容现有批量绑定、推荐确认、批量停权处理。

## Implementation

### Frontend

- 在 `apps/web/src/views/DirectoryManagementView.vue` 增加 `ReviewBatchProgress` 状态：
  - `kind`
  - `phase`
  - `total`
  - `applied`
  - `message`
- 在待处理队列顶部新增“处理进度”卡片，展示：
  - 动作类型：
    - `批量绑定`
    - `推荐绑定确认`
    - `批量停权处理`
  - 阶段：
    - `提交中`
    - `刷新中`
    - `已完成`
    - `失败`
  - 进度：
    - `进度 X / Y`
- `submitReviewBindings(...)` 现在支持可选的 `progressKind`：
  - 发请求前进入 `submitting`
  - 后端返回成功后进入 `refreshing`
  - 本地刷新 integrations / review-items / accounts 完成后进入 `completed`
  - 任一阶段出错则进入 `failed`
- `batchUnbindReviewItems()` 也接上同一套进度卡逻辑。
- 进度卡在切换集成或重置页面时会清空；处理结束后管理员也可以手动 `清除进度`。

说明：

- 本轮没有变更后端 API。
- 进度里的 `applied` 直接复用后端批量接口返回的 `items.length`；若后端未显式返回，则回退到本次提交目标数。

## Tests

前端测试更新在：

- `apps/web/tests/directoryManagementView.spec.ts`

覆盖点：

- `batch-confirms recommended pending bindings`
  - 继续覆盖推荐批量确认成功
  - 额外断言最终进度卡为 `推荐绑定确认 / 已完成 / 2 / 2`
- `shows visible progress while batch-confirming recommended pending bindings`
  - 覆盖请求未返回时的 `提交中 / 0 / 1`
  - 覆盖请求完成后的 `已完成 / 1 / 1`
- `batch-binds pending review items`
  - 额外断言最终进度卡为 `批量绑定 / 已完成 / 2 / 2`
- `batch unbinds inactive linked review items`
  - 额外断言最终进度卡为 `批量停权处理 / 已完成 / 2 / 2`

## Verification

通过：

```bash
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

## Environment Note

这轮验证前，当前工作区的 `pnpm` 依赖链接里存在断到旧临时目录的坏链，导致：

- `apps/web/node_modules/vitest`
- `apps/web/node_modules/vue-tsc`
- 以及部分根级依赖入口

无法正常执行。为完成验证，我先执行了：

```bash
CI=true pnpm install --frozen-lockfile
```

它只重建本地依赖链接，没有改锁文件或仓库源码。

## Notes

- 本轮并行开发里使用了 worker 辅助补测试。
- 也调用了 `Claude Code CLI` 做只读辅助检查；最终实现与结论仍以本地代码和本地测试结果为准。
