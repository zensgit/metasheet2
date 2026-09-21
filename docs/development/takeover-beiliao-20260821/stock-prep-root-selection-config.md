# 备料拉取:根选择(`rootSelection`)配置契约

> 2026-09-18 · issue #5862。规则是**配置**,不是代码:图号前后缀是一家工厂的编码约定,不同客户各有各的字典。

## 放在哪里

环境变量 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`(或等价的 `INTEGRATION_CORE_TABLE_ACTIONS_JSON`)
→ 数组(或按 actionId 的对象)里 `actionId` 为 `plm.stock-preparation.pull-bom.v1` 的那条 action
→ 它的 `rootSelection` 键。

```json
[
  {
    "actionId": "plm.stock-preparation.pull-bom.v1",
    "source": { "...": "既有配置不动" },
    "target": { "...": "既有配置不动" },
    "rootSelection": {
      "mainDrawingPrefix": "J",
      "mainDrawingSuffix": "-00",
      "sheetMetalSuffixes": ["-A", "-B", "-C", "-D"],
      "sheetMetalMatch": "contains"
    }
  }
]
```

上面这一块就是**本客户**的预设(#5862 客户口径:总图 = `J` 开头且 `-00` 结尾;钣金图 = 图号**含** `-A`/`-B`/`-C`/`-D`)。
其余键不写,落到老系统默认。改完 `pm2 restart metasheet-backend --update-env`,配置错误会在启动/注册时以 `TABLE_ACTION_CONFIG_INVALID`(422)拒绝,不会静默跑成别的规则。

## 键与默认值(全部可选;不写 = 老系统 `StockInfoController.java` 的行为)

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 整条根选择规则的开关。`false` = 订单行全部当根(F1c 之前的行为)。 |
| `mainDrawingPrefix` | string(可为 `""`) | `"J"` | 总图图号前缀。`""` 表示本部署不按前缀判总图。 |
| `mainDrawingSuffix` | string(不可为空) | `"-00"` | 总图图号后缀。空串会让每个图号都成总图,配置时直接拒。 |
| `sheetMetalSuffixes` | string[] | `["-A","-B"]` | 钣金 token 列表。`sheetMetalMatch = endsWith` 时是后缀列表(老系统);`contains` 时是 token 列表,名字沿用不改。 |
| `sheetMetalMatch` | `"endsWith"` \| `"contains"` | `"endsWith"` | 钣金 token 怎么匹配。`contains`:token 出现在图号**首字符之后**的任何位置即命中(仅以 token 开头的图号不算)。 |
| `sheetMetalRequiresMainPrefix` | boolean | `true` | 钣金图号是否也必须以 `mainDrawingPrefix` 开头(老系统:钣金 = `J…-A`)。`false` 时 `B1-2-A` 也可以是钣金。 |
| `dropDashDescendants` | boolean | `true` | 无总图时,按图号 dash 分段判定为别的订单行子级的行剔除(老系统 `checkHierarchyRelationship`)。 |

**未知键一律拒绝**(例如把 `sheetMetalMatch` 写成 `sheetMetalMatchMode`):这块配置会被快照并进哈希,忽略拼错的键等于存进一条展开器不跑的规则。

## 判定顺序(固定,不随模式变)

1. 先判**总图**:`startsWith(mainDrawingPrefix) && endsWith(mainDrawingSuffix)`。
2. 再判**钣金**:总图**永远不是**钣金(`J1-A-00` 含 `-A` 又以 `-00` 结尾 → 总图)。然后按 `sheetMetalRequiresMainPrefix` 看前缀,按 `sheetMetalMatch` 看 token。
3. 有总图 → 根 = 版本最高的那一张总图 + 全部钣金;其余订单行不是根(作为子级展开)。
4. 无总图 → 订单行全部当根(`dropDashDescendants` 时剔除 dash 子级),允许多根。

## dry-run 里的 `rootSelectionReport`(values-free)

在 `evidence.expansion` 里,与 `rootsFilteredOut` 相邻(展开结果 `summary` 上也有一份同样的):

```json
{
  "mode": "main_drawing",
  "mainDrawingCandidates": 2,
  "sheetMetalRoots": 2,
  "otherCandidatesDropped": 1,
  "dashDescendantsDropped": 0,
  "flags": ["multipleSheetMetalRoots"]
}
```

- `mode`:`main_drawing` / `no_main_drawing` / `disabled`。
- `mainDrawingCandidates`:认出的总图条数(含被版本压掉的;只留一张,压掉的 = 该数 − 1)。
- `sheetMetalRoots`:留作根的钣金条数。
- `otherCandidatesDropped`:有总图时,既非总图也非钣金而被剔除的订单行数。
- `dashDescendantsDropped`:无总图时,按 dash 层级剔除的行数。
- `flags`:`multipleSheetMetalRoots`(钣金根 > 1)/ `sheetMetalRootMissing`(有总图但钣金根 = 0)/ `noMainDrawingMultipleRoots`(无总图且根 > 1)。只是提示,不阻断。

只有 token 和整数,没有图号、名称、材质。`rootsFilteredOut`(总剔除数)不变,仍只在 > 0 时出现。

## 代码位置

- 契约与纯函数:`plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs`(`DEFAULT_ROOT_SELECTION` / `ROOT_SELECTION_KEYS` / `normalizeRootSelection` / `hasSheetMetalShape` / `selectOrderRootCandidates` / `makeRootSelectionReport`)。
- 配置时校验:`stock-preparation-table-actions.cjs` `normalizeActionRootSelection`(同一套词汇,翻译成 422)。
- 两条通道同一份规则:交互式 dry-run 走 `action.rootSelection`;大 BOM 后台通道走 `job.actionSnapshot.rootSelection`(`stock-preparation-large-bom-jobs.cjs`)。
