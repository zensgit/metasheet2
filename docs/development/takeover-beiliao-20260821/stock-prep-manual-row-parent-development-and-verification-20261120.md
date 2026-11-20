# 备料人工补充行「指定 / 修改父组件」开发与验证汇总（ADR §12）

- 日期：2026-11-20
- 基线：`path:line` 一律以 main `05f35de0c`（含下列四个 PR）为准。
- 性质：已完成功能的开发与验证汇总，纯文档。设计原文见 `adr-stock-prep-manual-rows-20261030.md` §12。

## 1. 范围与来源

需求（owner 2026-11-19）：新增人工补充行时能选父组件图号 + 名称；加错了能改、能移出，也能自己建一个新的父组件。目标是跟第 3 个包上线，不影响 R85 签收。

| PR | 内容 | 合入 commit | 合入时间 (UTC) |
|---|---|---|---|
| #6947 | docs：ADR §12 方案 + 页面原型 `beiliao-manual-row-parent-prototype-20261119.html` | `a4d44d09c` | 2026-11-20 00:15 |
| #6949 | P1 主机：路由、规则 P1–P8、候选读接口、依赖数读接口（R-100） | `e1acfd040` | 2026-11-20 00:16 |
| #6951 | P3 导出：有父组件的人工补充行插到父组件下面（OQ-P2） | `8d5f9f138` | 2026-11-20 00:17 |
| #6950 | P2 网页：选择 / 修改父组件、改图号和删行前的提示（叠在 #6949 上） | `05f35de0c` | 2026-11-20 00:51 |

决策：

| 编号 | 问题 | 裁决（owner 2026-11-19「按建议」，Harold 11-19 定） |
|---|---|---|
| OQ-P1 | 复制为新行带不带父组件 | 带上；两列都可读可写且满足 P4、P5 才带，否则两列都不带，复制照常成功 |
| OQ-P2 | 导出位置 | 插到父组件的子件之后 |
| OQ-P3 | 下拉候选范围 | 已有父组件 + 本项目任意物料（PLM 行和人工行） |
| R-100 | 登记册 | `decision-register.md` 的 R-100 行；取代 R-68 里「OQ5 复制不拷父组件两列」一句；P1 终审补充 ⑧（P5 读口径）标 `Ratified-by-default-2026-11-20` |

全系列：无迁移、无新增 env 开关（#6949 正文；R-100 ⑤）。

## 2. 实现要点

### 2.1 规则 P1–P8（一句话版）

| 规则 | 内容 | 落点 |
|---|---|---|
| P1 | 父组件两列只能经三条人工行路由写：新增 `POST /sheets/:sheetId/manual-rows`、复制 `POST /records/:recordId/manual-copy`、修改 `PATCH /records/:recordId/manual-fields`；修改要求该行满足 M（人工补充行） | `univer-meta.ts:21107`、`:21223`、`:21299`；M 判断 `:21347` |
| P2 | /patch、PATCH /records、Yjs、填充、粘贴、导入、表单、自动化对这两列照旧只读；两列不进 `editableFieldIds` | 类别 `parent_assignable` 独立于 `fillable`：`stock-preparation-manual-rows.ts:184-190`、`:228-233`；真库用例 MR3-RD-04 |
| P3 | 两列成对提交，只提交一列回 400 `pair_incomplete` | `stock-preparation-manual-rows.ts:291-293` |
| P4 | 只收字符串或 null（否则 400 `not_text`）；两列都空 = 不挂；图号非空名称可空 = 挂上；名称非空图号空 = 422 `name_without_code`；「空」按去首尾空格判断，保存原值 | `stock-preparation-manual-rows.ts:276-296`；状态码映射 `stock-preparation-manual-rows-gate.ts:509-513` |
| P5 | 父组件图号不能等于本行图号（422 `self_parent`），两个方向（改父组件、改本行图号）都挡；在写事务里、行加 `FOR UPDATE` 之后，对合并后的整行判断 | `stock-preparation-manual-rows-gate.ts:808-860`（锁 `:815`，合并判断`:839-841`）；比较规则 `stock-preparation-manual-rows.ts:316-319` |
| P6 | 服务器不检查父组件是否存在于本表；父组件只是显示属性，不建引用（「新建父组件」靠它成立） | 全部落点中没有存在性查询；人工行改图号或删行时只给提示（见 2.2） |
| P7 | 逐人字段权限：请求点名任一列，就按两列一起判断写权限，任一不可写回 403；403 文案只列调用者提交过的列 | `univer-meta.ts:8420-8427`（`manualRowWriteGatedFieldIds`）、`:21381-21388` |
| P8 | 开关关闭、项目归档时只挡新增和复制，已有人工行仍可改父组件 | 修改路由注释 `univer-meta.ts:21284-21285`；门的 edit 模式只要 key 锁（+ 点名时的父组件锁）`stock-preparation-manual-rows-gate.ts:365-378`（key 锁 `:376`） |

### 2.2 主机（#6949）

改动文件（`packages/core-backend`）：

| 文件 | 作用 |
|---|---|
| `src/multitable/stock-preparation-manual-rows.ts` | 列类别、锁豁免 6+2 列、P3–P5 的纯函数 |
| `src/multitable/stock-preparation-manual-rows-gate.ts` | 门、两列缺锁判断、事务内复检、复制拆对、`/context` 块 |
| `src/multitable/stock-preparation-manual-row-parent-options.ts`（新，271 行） | 候选与依赖数两条固定 SQL、查询串解析、行映射 |
| `src/multitable/record-service.ts` | 新增事务里对父组件做 P3–P5（`:735-743`） |
| `src/routes/univer-meta.ts` | 路由、`/context` 块、权限与读范围 |
| 测试与工具 | 见第 3 节；另有 `docs/.../decision-register.md`（R-100）与 `multitable-field-read-gate-tracker-20260602.md` |

要点：

| 项 | 实现 | 位置 |
|---|---|---|
| 锁豁免 | 6 个可填列 + 父组件 2 列 = 8 列，只在三条路由上、只对新建人工行或满足 M 的行 | `stock-preparation-manual-rows.ts:246`；派生集合 `lockExempt` 在 gate `:220-235` |
| 两列缺锁 | 点名这两列的请求回 409 `lock_missing`（缺列为 `contract_mismatch`），并有专用文案；不点名的新增、修改照旧；复制此时两列都不带；`/context` 不发 `parentFieldIds` | gate `:261-275`、`:304-320`、`:365-378` |
| 新增 | 门看提交的列 id；P3–P5 在 403 之后、事务内再判一次 | `univer-meta.ts:8511`；`record-service.ts:735-743` |
| 修改的并发与校验 | 沿用 `RecordWriteService.patchRecords`：带 `expectedVersion`，`preWriteGuard` 在 fence 之后、行锁下复检 M、门和 P5 | `univer-meta.ts:21420-21437`；gate `:808` |
| P5 读口径（反预言机） | P5 比较的是已存单元格，所以「修改」要求能读本行，且能读被比较的那列（改父组件须读本行图号，改图号须读父组件图号），否则 403，先于事务 | `univer-meta.ts:21395-21406`；gate `:866`；R-100 ⑧ |
| 复制（OQ-P1） | 两列都可读可写、源值合法、非空图号、不等于副本自己的图号才带，否则两列都不带 | gate `:931-950`；`univer-meta.ts:8589-8598` |
| 拒绝体 | 码 `STOCK_PREP_MANUAL_PARENT_INVALID`，`details.reason` 四种；文案不含任何值 | gate `:489-519` |
| `/context` | 人工行块多 `parentFieldIds {code,name}`（仅操作人可写两列且路由收两列时）和 `componentCodeFieldId`（仅在 `parentFieldIds` 旁、且图号列可读）；其他 `/context` 逐字节不变 | `univer-meta.ts:9888-9901`；gate `:553-570`、`:645-675` |
| 候选读 | `GET /sheets/:sheetId/manual-rows/parent-options?q=&limit=`：仅会话请求；canRead 且表是活的，再要 canCreateRecord 或 canEditRecord；行级策略的拒读行先排除再分组、计数、封顶；各列不在读权限允许集内就传 NULL（不投影、不被 `q` 匹配）；每个图号一条（名称取使用最多的，平手取字节最小）；`q` 两侧都由数据库折叠大小写；`limit` 默认 20、上限 50，`q` ≤200 字符；超出 `truncated: true` | `univer-meta.ts:21155-21215`；`stock-preparation-manual-row-parent-options.ts:55-57`、`:113-164` |
| 依赖数读 | `GET /records/:recordId/manual-parent-dependents`：只回数量（按记录定位，服务器读本行图号，值不进 URL） | `univer-meta.ts:21470-21525`；`stock-preparation-manual-row-parent-options.ts:236-268` |
| 出口守卫 | 候选读是新的 `data->>` 投影读，已登记进出口、污点、W13 三个守卫测试 | `tests/unit/multitable-egress-coverage-guard.test.ts` 等 3 个文件在 #6949 改动清单中 |

### 2.3 网页（#6950）

改动文件（`apps/web`）：`src/multitable/api/client.ts`、`types.ts`、`components/MetaManualRowDialog.vue`、`MetaManualRowParentDialog.vue`（新，183 行）、`MetaManualRowParentPicker.vue`（新，167 行）、`MetaRecordInspector.vue`、`utils/manual-rows.ts`、`manual-row-labels.ts`、`manual-row-parent-dependents.ts`（新，32 行）、`views/MultitableWorkbench.vue`。

| 项 | 实现 | 位置 |
|---|---|---|
| 新增弹窗「父组件」栏 | 只在 `/context` 带 `parentFieldIds` 时出现；三种选法：不挂（默认，载荷不变）/ 选已有（防抖搜索，分「已有父组件」带子件数和「本项目物料」，本行图号不列，选中值原样保存）/ 新建（图号、名称必填，去首尾空格） | `MetaManualRowDialog.vue:86-122`；`utils/manual-rows.ts:272-340` |
| 提交前校验 | 名称无图号、自挂自在提交前拒绝；服务器文案原样显示 | `utils/manual-rows.ts:253-323` |
| 抽屉「修改父组件」 | 人工行的记录抽屉：改成已有 / 新建 / 移出；经 manual-fields 保存并带行版本；`componentCodeFieldId` 缺失时隐藏（服务器会 403） | `MetaRecordInspector.vue:336-345`；`MultitableWorkbench.vue:3559-3630` |
| 网格 | 两列在所有行上保持只读；即使主机把它们列为可编辑也会被网页剔除 | `utils/manual-rows.ts:153-157` |
| 过期提示 | 改人工行图号（网格单元格、抽屉）或删人工行（抽屉、批量）前，若有 N 行人工补充行以它为父组件，弹确认「修改/删除后它们不会跟着变」；只是提示，不是门；读不到数量时放行 | `MultitableWorkbench.vue:3284-3286`、`:3364-3367`；`utils/manual-row-parent-dependents.ts:21-31`；`client.ts:3874`、`:3883` |
| 不做右键菜单 | 与 2026-10-27 客户反馈一致 | ADR §12.2 |

### 2.4 导出（#6951）

改动：`plugins/plugin-integration-core/lib/stock-preparation-prep-line-export.cjs`（只此一个源文件）。

| 项 | 实现 | 位置 |
|---|---|---|
| 做法 | 对 `orderRowsAsBomTree` 结果的后处理 `exportPrintOrder`；前缀行仍不进树身份、去重、沿用说明 | `:848`、调用 `:1135` |
| 可插入条件 | 来源为「人工补充」、父组件图号非空且不等于本行图号；树必须是 path 模式 | `:853-856` |
| 位置 | 锚点 = 第一个已打印、图号相同的树行（树行优先于人工行）；插到该锚点 path 前缀子树末尾、其 PLM 行之后；同锚点内按 `compareSiblingRows`；嵌套锚点同末尾时深的在前；人工父组件的子行跟在那一行后面 | 注释 `:833-846`；实现 `:870-941` |
| 退回表尾 | 无锚点、锚点无效或被折叠、成环、自挂自、「人工（非补充）」、降级树或平比较器 → 保持今天的表尾顺序 | `:853-856`（平模式）、ME-11 至 ME-15 |
| C09 | 没有可插入的行时返回原表达式，工作簿逐字节不变 | `:847`、`:856` |

## 3. 测试覆盖与结果

### 3.1 测试文件

| 片 | 文件 | 用例数 / 关键用例 |
|---|---|---|
| 主机单元 | `packages/core-backend/tests/unit/stock-preparation-manual-rows-parent.test.ts` | 84 个 `it/test`（规则 P3–P5、门、复制拆对、候选与依赖数的纯函数） |
| 主机单元 | `.../stock-preparation-manual-rows-parent-routes.test.ts` | 94（路由：新增、修改、复制、候选、依赖数、`/context`、403/409/422 分支） |
| 主机单元 | `.../stock-preparation-manual-rows-contract.test.ts`、`...-routes.test.ts` | 27、44（35 列每列恰一类的普查等，#6949 改动） |
| 主机守卫 | `multitable-egress-coverage-guard.test.ts`、`multitable-stored-data-taint-chokepoint.guard.test.ts`、`multitable-w13-write-path-layer3-gate.guard.test.ts` | 登记候选读 |
| 主机真库 | `tests/integration/stock-preparation-manual-rows-host-realdb.cases.ts` | MR3-RD-01 新增带父组件；-02 改/换/移出；-03 PLM 行与未绑定前缀行拒改（409 `not_manual_row`）；-04 /patch 与 PATCH /records 仍拒（403 `FIELD_READONLY_PLM_SYSTEM`）；-05 自挂自两个方向 + 真行锁下第二连接；-06 复制拆对；-07 缺锁；-08 候选与不可读列；-09 行级策略不泄露；-10 `/context` 的 `parentFieldIds`；-11 非 ASCII 搜索；-12 P5 非预言机 |
| 主机真库 | `.../stock-preparation-manual-rows-realdb.cases.ts` | MR-RD-04：设置并改人工行父组件后，拉取（预览再执行）不动该行，正式导出仍 200 |
| 主机工具 | `tests/utils/stock-prep-manual-rows-fake-pg.ts` | 假库 |
| 网页 | `apps/web/tests/multitable-record-inspector-manual-parent.spec.ts` | 17 |
| 网页 | `apps/web/tests/multitable-workbench-permission-wiring-manual-parent.spec.ts` | 17 |
| 导出 | `plugins/plugin-integration-core/__tests__/stock-preparation-manual-rows-export.test.cjs`（+ `support/...-fixtures.cjs`） | 18：原有 7 + ME-08…ME-18（尾部子树插入、同锚点排序、同图号首个、无锚点/无效/折叠、人工到人工、成环与自挂自、降级树、人工（非补充）、C09 六张表对 main 的 sha256、行集合无关性、挂载路由端到端） |

两个真库 cases 文件由 `multitable-record-duplicate.test.ts` 与 `stock-preparation-p4-repair-once-realdb.test.ts` 引入；这两个测试在 CI `plugin-tests.yml:2494`、`:2498` 的 realdb 步骤列表里。用例数按 `it/test(` 行数统计，参数化用例以实际运行数为准。

### 3.2 本次本地运行

| 项 | 结果 |
|---|---|
| 导出 `node plugins/plugin-integration-core/__tests__/stock-preparation-manual-rows-export.test.cjs`（在 `05f35de0c` 工作树） | 通过，输出 `all assertions passed`，ME-01 至 ME-18 全部 OK |
| 主机、网页 vitest | 未跑：该工作树没有 `node_modules`，按约定不为此安装依赖。以 CI 结果和各 PR 作者记录的本地结果为准 |

### 3.3 PR 作者记录的本地结果（未复跑）

| PR | 记录 |
|---|---|
| #6949 | core-backend type-check 通过；8 个 `stock-preparation-manual-rows*` 文件 + 出口/污点/W13 守卫共 820/820；一次性内嵌 PG 上 `multitable-record-duplicate` 79/79（ctype C 与 en-US 各一遍），`stock-preparation-p4-repair-once-realdb` 的 MR-RD-01…04 通过；更宽的单元扫描有 8 个文件失败，在 origin/main 的 Windows 检出里同样失败（CRLF、缺工具） |
| #6950 | 网页 10 个 spec 文件 221/221；vue-tsc 通过；ESLint 无错误；`multitable-workbench-1672-1673` 与 `multitable-workbench-permission-wiring` 的 5 秒超时在不含本片时也存在 |
| #6951 | 导出测试 18/18；测试链逐条运行 341 过、8 败，同样 8 个在撤掉本片的基线上也败（Windows 检出）；逐条去掉规则的变异检查都会让至少一个新用例失败 |
| 评审 | #6949 经独立对抗终审（Fable 5.2 max）「有条件通过」，发现项已在分支内修复；合并条件是真库 MR3-RD-01…10 与 MR-RD-04 在 CI 全绿 |

### 3.4 CI 检查（statusCheckRollup，取自各 PR 合入前的检查）

四个 PR 的检查全部成功，仅「Strict E2E with Enhanced Gates」在 #6949、#6950 为 SKIPPED（未触发）。

| 作业 | #6947 | #6949 | #6951 | #6950 |
|---|---|---|---|---|
| unit / test / coverage / contracts（20.x、dashboard、openapi、strict） | 通过 | 通过 | 通过 | 通过 |
| multitable-db (20.x)、runtime-db、approval-db、attendance-db、permissions、tasks-realdb | 通过 | 通过 | 通过 | 通过 |
| business-check-realdb | 无此项 | 通过 | 通过 | 无此项 |
| multitable-realdb-context-read-verdict、migration-replay、core-backend-cache、telemetry-plugin、approval-realdb-projection-key-parity | 无 | 通过 | 无 | 无 |
| web-tests、Stock-prep browser verify (chromium)、Approval browser verify (chromium)、Web dist upgrade (bash/powershell/pwsh)、stock-prep PowerShell 5.1 acceptance | 通过 | 通过 | 通过 | 通过 |
| Multitable browser verify (chromium)、multitable-web-guard、tasks-web-guard、e2e | 无 | e2e 通过 | 无 | 全部通过 |
| 导出相关：replay self-test、trigger-path wiring contract | 无 | 无 | 通过 | 无 |

真库集成：#6949 的 `multitable-db`、`business-check-realdb`、`multitable-realdb-context-read-verdict` 等通过；这些作业与第 3.1 节所列 realdb 步骤的具体对应关系（哪个作业执行了 MR3-RD-01…12、MR-RD-04）**未核实**，只核实了两个测试文件在 `plugin-tests.yml` 的步骤列表中。#6949 合并条件即为这些通道全绿，且四个 PR 合入时检查均为成功。

## 4. 未覆盖项与已知限制

| 项 | 说明 |
|---|---|
| 没有端到端浏览器测试 | 网页片只有 vitest spec；#6950 正文写明未跑带模拟数据的开发服务器，截图依据是 #6947 的页面原型。CI 的 browser verify 作业是既有的，其中没有针对本功能的用例（未逐一核实其内容） |
| 没有对着现场数据的验证 | 全部依赖合成数据和假库 / 内嵌 PG |
| 「查看子件」「查看所有使用位置」 | 按 PLM 身份过滤，没有 PLM 身份的行用不了；PLM 父件上点「查看子件」看不到挂在下面的人工子件，人工父组件上这两个按钮不可用。要看人工子件用填写视图分组（ADR §12.2，`bom-relations.ts:10-14`） |
| 父组件会过期 | 人工行的父组件是快照；人工父组件被改或被删后，子行留在旧图号的组里，导出落表尾。只提示数量，不自动改子行（P6） |
| 成环只挡自挂自 | A 挂 B、B 挂 A 不挡，只影响导出位置（落表尾） |
| 同图号多处 | 导出按图号找锚点，可能挂到另一处同图号零件下面；只影响导出位置，不影响数据 |
| 撤销 | 「修改父组件」不进网格撤销栈；改图号的提示在撤销时不会再弹（#6950 正文） |
| 读不到父组件图号的人 | 不能再经这条路由单独改人工行的图号，会得到 403（R-100 ⑧，#6950 正文） |
| 推宜搭 | 示例映射含 `parentDrawingNo`（业务主键之一）和必填的 `versionNo`，人工行很可能推不过去；是否推、用哪个键定位记录交集成线确认；本系列不改宜搭代码，发送开关保持关闭（R-100 ⑦） |
| 同步面板计数 | 「人工行的父组件在本次 BOM 里找不到」的计数 v1 不做 |
| 出口表内排序名称 | 候选里同图号取使用最多的名称（平手取字节最小）。ADR §12.2 写的是「已有父组件那一条的名称」，两者在多数情况下一致，差异未专门核实 |

## 5. 上线前要做的事

| 项 | 说明 | 状态 |
|---|---|---|
| 第 3 个包的 on-prem verify 标记 | 现在 `scripts/ops/multitable-onprem-package-verify.sh:477-496` 的 `verify_stock_preparation_manual_rows_contract` 只认 B1–B4 的标记；在该脚本和 `onprem-package-runtime-closure.test.mjs` 中搜索 `parent-options`、`manual-parent`、`stock-preparation-manual-row-parent` 均无命中。切第 3 个包时要补：主机 dist 的 `parent-options` 路由、新模块 `stock-preparation-manual-row-parent-options` 的运行时闭包、网页 chunk 的调用 | 待办（#6949 正文已列为后续） |
| 现场验证 | 第 3 个包上线后按第 6 节验收 | 待办 |
| 是否登记 env flag | 本系列不加 env 开关，无需登记 flag manifest | 已核对 R-100 ⑤ |
| 数据库迁移 | 无 | 已核对（#6949 正文） |
| 与 R85 的关系 | 不进 R85，只在 main 上、跟第 3 个包 | 已定（ADR §12.7 ⑤） |

## 6. 验收口径（现场，可勾）

前置：第 3 个包已装，新增人工行的开关为允许，操作人对父组件两列有写权限。

| 勾 | 检查项 | 期望 |
|---|---|---|
| [ ] | 新增弹窗出现「父组件」栏 | 默认「不挂父组件」；不选时新增与以前一样，落在空值组 |
| [ ] | 选已有 | 搜索能按图号或名称命中；分「已有父组件」和「本项目物料」；本行自己的图号不在候选里；选后保存，填写视图里该行出现在所选父组件的分组 |
| [ ] | 新建父组件 | 图号、名称必填；只填名称或只填图号被拦下；保存后该行有这组值 |
| [ ] | 人工补充的物料成为父组件 | 先新增该物料为一行，再给另一行选它，选得到 |
| [ ] | 抽屉「修改父组件」 | 人工行能改成另一个、新建一个、移出（回到空值组）；PLM 行没有这个入口 |
| [ ] | 网格单格 | 人工行的父组件两格不能单独编辑 |
| [ ] | 自挂自 | 选自己的图号被拦；改本行图号为其父组件图号被拒绝，文案不含具体值 |
| [ ] | 复制为新行 | 源行有父组件时副本带同一父组件；改完能再改 |
| [ ] | 改图号 / 删行提示 | 有别的人工行以它为父组件时弹出带数量的确认；确认后仍可继续 |
| [ ] | 正式导出位置 | 挂了 PLM 父件的人工行出现在该父件子树末尾（其 PLM 子件之后）；挂人工父组件的跟在那一行后面；新建父组件、找不到锚点的在表尾；「来源」列仍为「人工补充」，「层级」仍为空 |
| [ ] | 导出不变性 | 没有人工行或人工行都没挂父组件的项目，导出与上一个包逐字节相同（可用同一项目前后对比） |
| [ ] | 拉取不动人工行的父组件 | 改父组件后执行一次拉取，该行父组件不变；之后正式导出仍成功（不回 409） |
| [ ] | 权限 | 对父组件任一列只读的人：新增弹窗和抽屉都不出现父组件入口；直接请求回 403 |
| [ ] | PLM 行的父组件 | 仍不可改 |
| [ ] | R85 | 签收口径不受影响 |

## 7. 回退

| 项 | 结论 | 依据 |
|---|---|---|
| 功能开关 | 没有专用开关，无 env 开关 | R-100 ⑤；#6949 正文。登记册 ADR §4 的「人工行总开关」只挡新增和复制，不挡修改父组件（P8），所以不能用它回退本功能 |
| 回退方式 | 换回上一个包（不含 §12 的主机、网页、插件三处代码） | 代码层面无迁移，无 schema 变化，故无需回滚库结构 |
| 回到旧包的影响 | 已写入的父组件值留在行数据里：旧包的主机路由仍拒绝新增提交这两列、修改路由只收 6 列，旧网页不显示入口，所以这些值只读保留；填写视图仍按父组件图号分组，这些人工行继续显示在对应分组里；旧包的导出把它们放在表尾 | 主机：ADR §12.1（旧行为）；插件：`:1006-1012` 的旧表尾逻辑为 §12.5 所述今天的行为 |
| 数据是否需要清理 | 不需要强制清理；如想让人工行回到空值组，需在新包里逐行「移出父组件」（或另行写脚本，未核实是否有现成脚本） | — |
| 退回后再升级 | 数据兼容，无需处理 | 同上；未专门演练，未核实 |
| 是否做过回退演练 | 未核实 | — |
