# PLM Workbench Default Signal Type Alignment Design

## 背景

`attachPlmTeamViewDefaultSignals(...)` 会在 route 层把 `operation_audit_logs` 里的 `last_default_set_at` 信号回填到 team view row。

## 问题

helper 的返回类型被写成了：

- `Promise<Array<T & { last_default_set_at?: string }>>`

但底层 `PlmWorkbenchTeamViewRowLike` 本身允许：

- `last_default_set_at?: Date | string | null`

这样在 `return rows` 这类直接回传原始 `T[]` 的分支里，TypeScript 会报泛型不兼容。

## 设计决策

- 不改运行时逻辑
- 不收窄 row model
- 只把 helper 返回类型对齐回 `T[]`
- 映射分支继续把 audit signal 归一化成 ISO string，满足现有 response 行为

## 实现

- `attachPlmTeamViewDefaultSignals(...)` 返回类型改为 `Promise<T[]>`
- `rows.map(...)` 结果显式断言为 `T[]`

## 预期结果

- backend `tsc` 构建恢复
- route 层现有 `last_default_set_at` 输出语义不变
- 现有 route tests 不需要调整断言
