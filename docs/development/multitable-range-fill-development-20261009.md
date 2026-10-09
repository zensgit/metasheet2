# 多维表矩形复制与填充：开发说明

日期：2026-10-09。关联 PR：#6271。本文把已锁定的 v1 范围映射到实现入口和验收门；不是新路线图。详细行为契约见[设计锁](multitable-range-fill-design-lock-20261008.md)，已有验证记录见[验证报告](multitable-range-fill-verification-20261009.md)。

## 用户目标与 v1 范围

用户要在多维表中像电子表格一样选择矩形单元格、复制粘贴、向相邻方向重复填充，并生成数值或日期序列。操作只针对当前显示且已加载的行和可见列，最多修改 1,000 个目标单元格；不扫描或创建整个后端行/列。

支持鼠标拖选、Shift 点击/方向键扩展、右下角手柄沿单一轴向四方向填充，以及工具栏和 Ctrl/Cmd+C/V。重复填充按源矩形平铺；序列只支持数值及严格 `YYYY-MM-DD` civil date，单种子步长为 1，多种子须为等差数列。操作整批校验后经现有写入入口一次提交，保留逐格版本校验和服务端权限校验。

## 实现映射

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 纯规划 | `apps/web/src/multitable/utils/grid-range-fill.ts` | 矩形几何、TSV 解析/序列化、复制粘贴和四向填充规划、类型/权限前置校验、1,000 格上限 |
| 功能开关 | `apps/web/src/multitable/utils/grid-range-fill-flags.ts` | 仅构建期精确字符串 `VITE_MULTITABLE_RANGE_FILL_ENABLED === 'true'` 启用；缺省及其他值关闭 |
| 选区交互 | `apps/web/src/multitable/composables/useGridRangeSelection.ts` | 选择与填充状态、剪贴板、冻结快照、上下文变化取消和固定错误反馈 |
| 工具栏 | `apps/web/src/multitable/components/MetaGridRangeToolbar.vue` | Copy/Series 模式、复制粘贴入口、状态和撤销限制提示 |
| 网格绑定 | `apps/web/src/multitable/components/MetaGridTable.vue` | 鼠标/键盘选择、填充手柄及选区呈现 |
| 写入与投影 | `apps/web/src/multitable/composables/useMultitableGrid.ts` | `patchRange` 单次调用现有 `/api/multitable/patch`，`partialSuccess: false`；成功后才投影服务端结果，拒绝并发和过期覆盖 |
| 定向验证 | `apps/web/tests/multitable-range-fill-{planner,interaction,writer,flag}.spec.ts`；`apps/web/scripts/verify-range-fill-browser.mjs` | 规划、交互、写入、开关和合成数据浏览器验证；既有测试/CI 接线依据见验证报告 |
| 已认证持久化验证 | `packages/core-backend/tests/integration/multitable-range-fill-realdb.test.ts` | 实际前端规划器 → 真实 JWT 中间件及 patch 路由 → PostgreSQL；检查值、版本、统一历史批次和整批拒绝 |

运行时环境变量变更不会启用已构建前端；需要构建时显式设置上述精确值。默认保持 OFF，不包含生产启用或部署。

## 按难度分配及实际调用

模型按风险分工：版本、权限和并发写入交给 Sol 6.1；边界明确的说明文档交给 Luna 6；纯算法和反例咨询分别尝试 Grok 4.7、Kimi K3。该选择也参考了 [OpenAI 模型选择指引](https://developers.openai.com/api/docs/guides/model-selection)，实际入口以本机会话和 CLI 返回为准。

| 模型 | 难度 / 职责 | 本轮实际结果 |
| --- | --- | --- |
| Sol 6.1（high） | 高：原子写入、响应投影、版本和视图竞态；真实后端验收规格 | 修正成功响应缺少普通字段时的本地投影，补齐响应完整性、并发写入和同步导航检查；补写 10 项真实 JWT / PostgreSQL 规格，由主任务独立执行 |
| Grok 4.7 | 中高：纯规划器反例审查 | Runtime/模型入口可用，但调用返回本周额度用尽；无代码或测试产出，由 Codex 接手 |
| Kimi K3（`kimi-code/k3`） | 中：独立反例咨询 | 调用在 180 秒时超时，未形成最终复核结果；不计入验收证据 |
| Luna 6（medium） | 低：按已有设计和代码整理文档 | 生成本开发说明初稿，最终状态由 Codex 核验后更新 |
| Codex 主任务 | 高：集成与独立复核 | 核读规划器、交互与真实后端响应契约，补齐八步浏览器验证；独立建立临时 PostgreSQL、执行迁移和测试、变异鉴权守卫、核对 CI 接线与证据 |

## 本轮修复的具体问题

1. 后端 `RecordWriteService` 的 `records` 是可选计算字段回声，普通字段可能只收到 `updated` 版本确认。旧范围写入没有乐观更新，因此会出现服务器已写入、前端仍显示旧值。修复后收到完整确认才投影冻结的提交值，并让服务端回声优先覆盖。
2. 不完整或异常成功响应必须在任何本地投影之前拒绝；无对应版本确认的其他记录回声不能覆盖实时数据，已被删除的记录不能重新生成摘要。
3. 范围提交与单格、批量、撤销/重做写入互斥，避免乐观编辑和晚到响应互相覆盖。同步切换 sheet/view 即使马上切回，也会取消旧范围投影。

这些修改仍使用现有 API，没有增加后端接口或改变默认关闭策略。

## 验收门

| 门 | 通过条件 | 证据状态 |
| --- | --- | --- |
| G1 规划器 | 四方向平铺、反向偏移、多行/列、数值与 civil-date 序列、TSV 和严格类型负例 | 本轮 80 项通过 |
| G2 网格交互 | 鼠标/键盘选区、手柄、模式、剪贴板往返；隐藏/折叠/过滤/未加载内容不可成为目标 | 本轮 42 项及八步 Chromium 操作通过 |
| G3 安全边界 | 开关默认关闭且精确启用；权限、锁定、只读、过期上下文、上限和异步取消负例 | 本轮 9 项开关及相关负例通过 |
| G4 写入 | 单次原子请求及版本捕获；成功投影；403/409/验证/网络失败不改本地值 | 本轮 82 项通过，传输为 mock；非真实后端验收 |
| G5 接线与回归 | 新规格纳入领域 guard 和 required web 测试清单，并运行定向及邻接测试 | 本地通过；`fa99d518...` 的 Web Tests / Multitable Web Guard 已通过，新增后端规格仍待当前提交 CI |
| G6 独立检查 | 守卫变异负例、类型检查/构建和浏览器画面检查，并说明工具限制 | 变异 4 项失败，恢复后通过；应用类型检查和 Vite 打包通过，完整质量链有阻断 |
| G7 真实后端 | 真实 JWT、规划器请求、数据库值/版本/历史、整批拒绝、缺失数据库哨兵 | 新增 10 项及邻接 7 项通过；签名变异使对应负例变红，恢复后 17 项通过 |

同步 main 后共 561 项唯一测试通过，核心修复及浏览器证据提交为 `74af99627c1068f777019568684dbf06bbf90168`，其源码哈希保持不变。开关与 required 测试登记完整保留两边并集。测试命令、源码哈希、反例和 CI / 工具链限制完整记录在[验证报告](multitable-range-fill-verification-20261009.md)。`validate:all` 未完成；不能由本地通过推断 CI、合并或部署完成。

后续真实后端验收提交为 `8bbe8d3c5d`，未修改应用源码。使用临时 PostgreSQL 15.17 和 CI 相同的六项迁移排除清单，成功应用 426 项现有迁移。新增测试在 `plugin-tests.yml` 的迁移后多维表真实数据库步骤整文件执行；默认无数据库单测配置明确排除它。鉴权使用临时签名密钥和真实用户记录，关闭 `RBAC_BYPASS` / `RBAC_TOKEN_TRUST`，生产模式禁用开发 mock-user 回退。17 项持久化测试与先前 561 项分开报告；复跑已有 52 项写入单测仅作为无数据库通道正对照，不重复计数。尚未完成浏览器直连已认证后端或 staging 验收。

## UI 使用与限制

构建时以 `VITE_MULTITABLE_RANGE_FILL_ENABLED=true` 启用后，在网格拖动或用 Shift 选择矩形；用工具栏 Copy/Series 选择模式，拖动选区右下角手柄沿行或列扩展。也可用工具栏或 Ctrl/Cmd+C/V 复制粘贴 TSV。Series 对每列/行分别推算数值或日期等差序列；不规则种子会拒绝。剪贴板文本按目标字段类型严格解析。写入遇到任一不可写格或校验错误时整批失败。请求超时结果不确定时，先刷新检查再重试；系统不会自动重放。成功填充会清除单格撤销/重做历史，范围撤销不在 v1 内。

## 明确排除

- 后端全行/全列选择、隐含创建记录、过滤或折叠区域以及隐藏列作为目标。
- 超过 1,000 个目标格、同时扩展行和列、触屏手势及自动边缘滚动。
- 文本序列推断、dateTime 序列推断、静默类型回退、自动创建选项和部分成功。
- 新后端 API、数据库迁移、范围撤销、真实客户数据读写、外部系统写入、生产启用或部署。

PR 外的日期导入回归事项属于独立问题，不纳入本切片。
