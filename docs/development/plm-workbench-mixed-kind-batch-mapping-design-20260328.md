# PLM Workbench mixed-kind batch mapping design

## Problem

`POST /api/plm-workbench/views/team/batch` 的后端合同允许 mixed `kind` 返回，这一点已经体现在 route 实现和测试里的 `processedKinds`。

但前端 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts) 仍然把 batch 返回项统一按调用方传入的单一 `kind` 解码：

- `batchPlmWorkbenchTeamViews(kind, ...)`
- `mapTeamView(kind, item)`

这会让 mixed payload 里的 `cad` / `approvals` 条目被错误套进别的 state schema。

## Design

把 `team view` 的 runtime 映射逻辑收紧到“优先相信返回项自己的 `kind`”：

- 新增 `normalizeTeamViewKind(value, fallback)`
- `mapTeamView(...)` 先解析 `record.kind`，缺失时才回退到调用方 hint
- `state` 也跟着 resolved runtime kind 解码

这样：

- 单一 `kind` 请求保持原语义
- mixed-kind batch 返回不会再被错误 schema 反序列化

## Expected outcome

前端 client 和后端 `views/team/batch` 合同重新一致，batch 返回项会按真实 runtime kind 反解 state，不再出现跨 kind 的伪 documents/cad/approvals 视图对象。
