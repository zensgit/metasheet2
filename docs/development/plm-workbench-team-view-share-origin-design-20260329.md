# PLM Workbench Team View Share Origin Design

## Background

`local preset` 和 `team preset` 的 share helper 都已经按 runtime 取 `window.location.origin`。

但 `buildPlmWorkbenchTeamViewShareUrl(...)` 还保留着硬编码默认值：

- `http://127.0.0.1:8899`

这会让一条真实的 frontend parity gap 一直存在：

- `PlmProductView` 和 `PlmAuditView` 的 team-view share callsite 通常只传 `route.path`
- 没有显式传入 origin 时，最终复制出来的 URL 仍会指向 localhost
- 在 preview / staging / production 环境里，这种 share link 是错误目标

## Goal

让 `team view` share helper 和 preset-share helper 对齐到同一份 origin 合同：

- 调用方显式传了 origin，就尊重调用方
- 否则优先取 `window.location.origin`
- 如果运行环境里没有可用 origin，则返回空字符串，让上层沿用既有的“生成 share 链接失败”反馈链

## Design

修改：

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`

把 `buildPlmWorkbenchTeamViewShareUrl(...)` 从硬编码默认 origin 改成：

- `const resolvedOrigin = origin ?? window.location.origin`

然后所有 `kind` 分支统一使用 `resolvedOrigin` 拼接最终 URL。

## Why This Is Correct

- 与 `plmFilterPresetUtils.ts` 里现有 share helper 的行为完全对齐
- 不影响已有显式传 origin 的测试和 SDK 用法
- 把浏览器内 share 行为从“固定 localhost”纠回到“当前部署地址”
