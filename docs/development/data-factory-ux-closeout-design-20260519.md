# Data Factory UX closeout design - 2026-05-19

## Purpose

This slice closes the latest operator feedback from issue #651 after the
`multitable-onprem-k3wise-20260518-5ca916303` entity-machine validation:

- Gate A / Gate B passed.
- Data Factory and K3 WISE setup routes were reachable.
- K3 WISE WebAPI status changed from `untested` to `connected`.
- A pipeline could be saved and dry-run could execute.
- Dry-run returned `rowsRead=0`, `records=[]`, `errors=[]`, which was technically
  successful but not obvious to the operator.

The change stays frontend-only. It does not touch `plugin-integration-core`,
backend APIs, migrations, packaging, or deployment scripts.

## UX changes

### Connection management

The previous copy made "连接新系统" and "查看 SQL / 高级连接" feel like separate
pages, but both actions open inline areas inside the Data Factory workbench.

The updated copy now says:

- "新增或管理连接"
- "新增连接草稿"
- "展开 SQL / 高级连接"
- The connection manager is described as an inline setup panel.

The inventory area now explicitly tells operators that saved connections can be
edited, copied, stopped, re-enabled, or deleted. Inactive connections now show an
`启用` action instead of a disabled `停用` button.

### Dataset language

The source/target chooser is now framed in business terms:

- Source side: "来源对象选择" and "来源数据集（从哪里取数）"
- Target side: "目标模板选择" and "目标数据集 / 模板（写到哪里）"

This keeps the existing `/integrations/workbench` route and API calls unchanged,
but makes the page closer to the data-factory model:

`system -> dataset/object -> multitable cleanse -> dry-run -> export/push`

### K3 WISE WebAPI target-only explanation

K3 WISE WebAPI is still target-only under the Stage 1 GATE rule. The new message
uses operator-facing wording:

> 当前 K3 WISE WebAPI 仅作为目标写入连接；来源侧请使用 staging 多维表、SQL 只读通道或其他可读连接。

The GATE constraint is still visible, but it is no longer the first concept the
operator has to decode.

### Empty dry-run

When dry-run succeeds with an empty preview (`records=[]` and `errors=[]`), the
workbench now shows:

> Dry-run 成功，但本次没有可处理记录。可能是来源数据集为空或过滤条件过严。

The export summary also changes from the generic "先运行 dry-run" message to an
empty-result explanation. This avoids confusing a valid empty dry-run with a
failed or not-yet-run dry-run.

## Compatibility

- No route changes.
- No backend contract changes.
- No migration changes.
- Existing dry-run records remain exportable.
- Existing K3 WISE target template flow remains unchanged.
- SQL executor missing remains a deployment/runtime skip, not a UI regression.
