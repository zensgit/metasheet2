# 222 实证:项目目录子树桥接在客户测试 PLM 上跑通(2026-09-06 00:17)

> W2 第 1–3 步的证据记录。全文 values-free:只有计数、状态、配置字段名;无零件号、无项目名以外的业务值。项目号 `2-20231625` 是客户此前提供给我们做测试的编号。

## 1. 升级到 r10

- 包:`metasheet-multitable-onprem-v2.5.0-r10.zip`(CI run 33976786327,gitSha `4e509b614` = main 合并 #5492 后)。zip sha256 与 `.zip.sha256` 一致。
- 就地升级脚本 8 步全过:必存在文件断言 OK、插件哈希核对 440 文件 OK、迁移 exit 0、健康检查 200(attempt 3)。升级前 `pg_dump`(2.13 MB)与 `app.env` 备份在 `output\backups\`。
- 升级后核对:`stock-preparation-bom-expansion.cjs` 含 `readPlan.projectSubtree` 与入口读后置过滤;`stock-preparation-source-preflight.cjs` 含 `project-subtree` 词表。

## 2. 开启子树桥接(配置)

在 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` 的 `source.readPlan` 里新增(精确字符串插入,备份 `app.env.pre-subtree-20260906-001714`):

```json
"maxReadCount": 30000,
"projectSubtree": {
  "pathInfo": { "parentIdField": "Parent_OBJ_ID" },
  "bomHead":  { "pathIdField": "path_id" },
  "maxSubtreeDepth": 1, "maxSubtreeNodes": 200, "maxSubtreeRoots": 200, "includeSelf": true
}
```

要点:`readPlan.maxReadCount` 在启用子树时是**必填**(归一化拒绝无预算的子树计划);重启必须先把 `app.env` 装进当前进程再 `pm2 restart --update-env`(否则进程带旧值,见交付说明 §7.1)。重启后 `pm2 env 0` 含 `projectSubtree`,健康 3 秒恢复。

## 3. 试算结果(项目 2-20231625,客户测试 PLM,只读)

| 项 | 开子树前(2026-09-05) | 开子树后(2026-09-06 00:17) |
|---|---|---|
| dry-run 状态 | `ready`,0 行(该项目无订单) | `manual_confirm_required` |
| rowsExpanded | 0 | **135** |
| readCount | 3 | 399 |
| 耗时 | 0.36 s | 7.0 s |
| counts.add / manual_confirm | 0 / 0 | 135 / 225 |
| subtree.nodesVisited | — | 10 |
| subtree.rootsDiscovered / rootsExpanded | — | **6 / 6** |
| subtree.rootsWithoutChildren | — | 1 |
| rootQuantitySource | — | orderDetail 0 / subtreeDefault 6 |

解读:
- 此前只读枚举得到的"该项目子树 14 节点、6 张表头全在深度 1"与这次 `rootsDiscovered=6` 一致;`nodesVisited=10` = 项目节点 + 9 个深度 1 子节点(深度 1 上限下不再下探)。
- 135 行是能在物料表里找到的零件;225 项挂起对应缺件(该测试库的 BOM 明细约四到六成指向物料表里不存在的零件,此前已知),它们会出现在确认队列并显示"去源系统补"提示;`canApply=true` 但状态为待确认,写入被规划器的挂起挡住——与设计一致。
- 读预算三键(`maxPages 100 / maxReadCount 30000 / maxElapsedMs 600000`)在证据里可见;本次 399 次读远低于预算。

## 4. 未做 / 待做

- 未 apply(本轮只试算);缺件清单(#5500/#5499)落地后再跑一次,把 225 项挂起对应的零件号导出给客户补数据。
- 预检 `declaredBridge` 未改,`bom_store_signals_conflict` 那条 blocker 与找根轴无关(见设计记录 §5)。
- 定时任务(每日 06:00 只试算)待 #5493 合并后注册;服务账号与令牌文件已就位(`C:\metasheet\secrets\`,ACL 仅管理员)。
