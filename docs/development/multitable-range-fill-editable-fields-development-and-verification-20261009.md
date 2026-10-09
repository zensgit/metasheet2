# 多维表可编辑字段复制：开发与验证

日期：2026-10-09。关联 [PR #6271](https://github.com/zensgit/metasheet2/pull/6271)，分支 `codex/multitable-range-fill-20261008`。本报告覆盖用户追加的多选、人员及其他可编辑字段拖动复制，扩展契约见[设计锁](multitable-range-fill-editable-fields-design-lock-20261009.md)。原始范围填充的 G1–G7 证据保留在[原验证报告](multitable-range-fill-verification-20261009.md)。

## 实现范围

| 字段组 | 支持内容 |
| --- | --- |
| 普通数据 | 文本、长文本、数字、布尔、日期、日期时间、单选 |
| 选项与对象引用 | 多选、原生人员（单人/多人）、关联记录（含旧式关联人员）、附件 |
| 其他可编辑值 | 金额、百分比、评分、时长、网址、邮箱、电话、条码、二维码、地点 |
| 计算与系统结果 | 公式、查找、汇总、自动编号及创建/修改时间和人员不可作为写入目标；按钮不会被复制触发 |

共 21 种现有可编辑数据类型。复制整组覆盖目标值，数组去重后仍保持原顺序，不追加到旧选择。跨列只接受相同类型，关联字段还要求引用同一数据表及相同引用种类。目标选项、必填、单值限制仍生效；人员目录资格、成员组、关联目标和附件绑定由现有服务端写入路径复核，任一不合法即整批拒绝。

多选和人员支持从本表复制、粘贴及拖动重复填充。剪贴板是 TSV，各数组单元格保留 JSON 数组；逗号、换行属于选项内容，不作为拆分符。人员使用用户 ID，不按显示姓名猜测身份；普通姓名文本不属于本切片的自动解析能力。可选数组字段的空白剪贴板清为空数组，必填字段拒绝空数组。附件复制已存在的引用，不上传或复制文件实体。

序列仍仅支持数字和日期。公式是列级定义：复制其输入数据后重新计算；汇总跟随复制后的关联记录重新计算。公式/汇总/自动编号的显示结果可通过剪贴板作为普通值粘贴到兼容的可编辑字段，但不能覆盖计算字段本身。没有新增 Excel 式单元格公式、A1 相对引用拖动或自动编号重写。

## 关键实现

- `grid-range-fill.ts`：统一可写类型判断，复用字段配置解析器；严格值形状、目标约束、结构化剪贴板及关联引用兼容检查。
- `useGridRangeSelection.ts`：在拖动开始深拷贝数组/对象，防止等待期间源值变化污染提交。
- `MetaGridTable.vue`：范围复制使用权限检查，不再受“是否有内嵌编辑器”的旧类型清单限制。默认关闭时原编辑行为不变。
- `useMultitableGrid.ts`：提交时再次深拷贝，保留一次 `partialSuccess: false` 的原子 PATCH。扩展类型成功后用现有记录读取接口取得规范值及人员/关联/附件显示信息；最多四个并发读取，按原视图/加载代数和版本检查，不能覆盖新视图或较新实时记录。
- 读取失败与写入失败区分：若已成功写入但回读失败，显示固定的“已保存，请刷新核对，无需重复提交”提示，不重试写入。
- 没有修改后端应用代码、API、迁移、依赖、权限规则或开关；保留 `VITE_MULTITABLE_RANGE_FILL_ENABLED === 'true'` 构建期开关，默认 OFF。

Sol 6.1 high 分别实现规划器及真实数据库验收扩展；Codex 主任务完成网格与写入集成、回读、界面测试和浏览器验证，并独立运行测试。另一个 Sol 6.1 high 执行只读反例复核。此次未把 Grok/Kimi 的历史未完成调用计入产出。

## 基线与验证

开始前获取 main，并在原功能分支合入 `a16a12aca35d46b6b621ae12f49b380b50b95b48`，合并提交 `a498e9c9b9e133816e94a9e646921564d625944f`。这是把 main 同步到功能分支，未把 PR 合入 main。工作流及开关清单自动合并，运行登记守卫检查；本次没有新增测试文件，原有两处前端接线和迁移后整文件数据库接线继续生效。

| 验收门 | 本地证据 | 状态 |
| --- | --- | --- |
| E1 规划器 | 153 项，覆盖 21 类型、数组/对象快照、选项/必填/单值/未知类型、关联引用兼容和结构化剪贴板 | 通过 |
| E2 交互 | 54 项真实组件规格；Chromium 11 步操作与真实剪贴板 | 通过；浏览器提交器为合成内存实现 |
| E3 写入 | 109 项，含深捕获、原子请求、规范值/姓名回读、四并发上限、读写失败区分及导航/实时版本竞态 | 通过 |
| E4 已认证数据库 | 本文件 26 项，邻接权限和 batchId 文件 7 项，全部无跳过 | 主任务独立 33/33 |
| E5 回归与接线 | 9 项开关、195 项网格及清单邻接、7 项系统字段、137 项后端及接线/只读守卫、40 项开关登记 | 通过 |
| E6 复核与交付 | 独立审阅、变异负例、应用类型检查、Vite 构建、截图、开发/验证文档 | 本地通过，无剩余复核问题；新提交 CI 单独跟踪 |

以上本地共有 **737 项唯一测试**：325 功能前端 + 202 邻接前端 + 137 后端/登记守卫 + 40 开关登记 + 33 真实数据库；复跑不重复累加。应用 `vue-tsc -p tsconfig.app.json --noEmit --incremental false` 与 Vite build 通过。完整本地 `pnpm validate:all` 在前轮因自动安装 `ERR_PNPM_IGNORED_BUILDS` 阻断，本轮沿用已安装依赖定向验证，不宣称该聚合命令通过。

数据库为自建临时 PostgreSQL 15.17，只含合成数据，沿用现有 CI 的六项迁移排除清单，成功应用 429 项既有迁移。真实 JWT、生产鉴权模式、关闭 RBAC bypass/token trust；请求经过正式路由和 SQL。验证整组选项替换、单/多人员、地点/金额/长文本、附件引用和关联边持久化；规范化读取中的人员显示名也做精确断言。负例覆盖失效选项、无资格成员、受限组外成员、单人字段超额、过期版本、只读字段和非法认证，要求值/版本/历史/引用不发生部分修改。

人员资格使用既有目录解析器，并未新增租户隔离规则。另一表成员负例中的用户没有平台级 multitable 资格，不能把这一例扩大解释为所有“仅有另一表授权”的用户都被当前目录排除。

真实公式验证：复制数字输入后公式回声及数据库值更新；复制关联字段后汇总回声及依赖汇总的公式更新。计算字段直接写入仍返回 403，整批回滚。缺少数据库而显式开启 CI 标记时哨兵失败（1 失败、25 未运行），不是跳过绿灯。

## 复核记录

规划器在旧实现上新增规格出现 45 项失败；实现后通过。去掉深捕获和关联引用兼容检查分别使对应负例失败，随后恢复。主任务发现范围交互仍使用旧内嵌编辑器类型清单，地点/金额/长文本的 3 项拖动测试失败；改为范围权限检查后全部通过。

独立复核发现保存后回读会更新版本而漏同步新的锁状态；两项回归在修复前失败（107 项未选中），修复后通过。现按相同上下文及版本守卫完整替换服务端记录，锁定与解锁元数据同步更新；复核者独立重跑 writer 109 项及锁邻接 6 项通过，无剩余可执行问题。主任务另将回读的实时版本守卫临时移除，匹配用例变红；精确恢复源码后匹配用例通过，变异没有留在交付代码。旧提交 `ceaa706f4c` 的 CI 成功仅是历史证据，不能当作本扩展新提交的绿灯。新提交的执行结果以 PR head 对应的 Actions 日志及最终回执为准。

## 复现与证据

从 `apps/web` 使用已安装 Node 20 及依赖：

```sh
node node_modules/vitest/vitest.mjs run tests/multitable-range-fill-planner.spec.ts tests/multitable-range-fill-flag.spec.ts tests/multitable-range-fill-writer.spec.ts tests/multitable-range-fill-interaction.spec.ts tests/multitable-system-fields.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p tsconfig.app.json
node node_modules/vite/bin/vite.js build
VITE_MULTITABLE_RANGE_FILL_ENABLED=true node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18919 --strictPort
# 上述本地服务启动后，另一个终端运行：
node scripts/verify-range-fill-browser.mjs
```

准备迁移后的独立 `DATABASE_URL`，在 `packages/core-backend`：

```sh
METASHEET_REAL_DB_TEST_STEP=1 node node_modules/vitest/vitest.mjs --config vitest.integration.config.ts run tests/integration/multitable-range-fill-realdb.test.ts tests/integration/multitable-fieldperm-write-gate-patch-realdb.test.ts tests/integration/multitable-patch-batchid-echo-realdb.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

主任务日志位于忽略目录 `artifacts/range-fill-editable/`：`feature-final.log`、`frontend-neighbors.log`、`backend-guards.log`、`flag-manifest.log`、`realdb-independent.log`、`app-typecheck.log`、`web-build.log`、`browser.log`、`lock-regression-red.log`、`read-version-mutation.log`、`read-version-restored.log`。日志不作为源码提交；可复现实验与规格已纳入 PR。[已检查的合成浏览器截图](../../artifacts/range-fill/grid-range-fill.png)。

## 发布边界

PR 保持 Draft，功能默认 OFF。未合并、部署或启用 staging/生产，未接触真实客户数据。浏览器 UI 与真实已认证 API/数据库分别验证，不能声称已完成部署环境的浏览器到后端全链路验收。

本轮核心源码 SHA-256（最终本地验证后）：

| 文件 | SHA-256 |
| --- | --- |
| `apps/web/src/multitable/utils/grid-range-fill.ts` | `860f4caea9b444ca970f0044ab67ad66afcce2c77f72c04bcd30ac29db6300b1` |
| `apps/web/src/multitable/composables/useGridRangeSelection.ts` | `6760cd2a8c3c047d359984f8e1c1e584b4fb000a68995f9cddbbc92a9459588f` |
| `apps/web/src/multitable/composables/useMultitableGrid.ts` | `300f073cdf3ad5da02e49392e5074ce04859a50220353698fe7e2b0648a4fd07` |
