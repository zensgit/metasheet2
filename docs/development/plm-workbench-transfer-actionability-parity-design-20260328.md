# PLM Workbench Transfer Actionability Parity Design

## Context

`team view` 和 `team preset` 的 transfer 按钮已经通过 `canTransfer*` 在 UI 上做了 disabled gating，但 handler 内部仍然先校验 `targetOwnerUserId`，再判断当前 target 是否真的允许转移。

这会留下一个对称性缺口：

- UI 已禁用 transfer
- 直接调用 handler 时却先得到 `请输入目标用户 ID`
- 真实阻塞原因其实是“当前 target 不可转移”或“仅创建者可转移”

这属于典型的 handler/UI actionability 分叉。

## Problem

当前顺序会把“输入是否完整”放在“动作本身是否允许”之前，导致：

- 只读 target 的 denial reason 被输入校验覆盖
- 显式 `permissions.canTransfer = false` 的 target 也可能先走输入提示
- team views 与 team presets 都存在同型问题

## Design

把 transfer handler 的判断顺序统一调整为：

1. target 是否存在
2. 是否处于 pending management / archived 等硬阻塞状态
3. `canTransferTarget*` 是否允许转移
4. 只有在动作允许后，才继续校验 `targetOwnerUserId`
5. 再校验 same-owner 和最终 submit readiness

并保持 denial message 与现有语义一致：

- 非 owner / 无管理权：`仅创建者可转移...`
- owner 但显式 action denied：`当前...不可转移所有者。`

## Scope

- `apps/web/src/views/plm/usePlmTeamViews.ts`
- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- focused regressions in:
  - `apps/web/tests/usePlmTeamViews.spec.ts`
  - `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## Expected Outcome

transfer handler 将与 UI disabled 状态保持一致，不再在 denied target 上误报输入校验错误，减少一类“表面像表单问题，实质是权限问题”的误导反馈。
