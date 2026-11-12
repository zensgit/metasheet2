# 多维表创建人 / 修改人姓名显示：开发与验证

日期：2026-11-12。授权范围：本地修复、合成验证、独立复核及文档；不提交、不推送、不合并、不部署。

第 1–6 节保留首次本地验收时的授权与结果；后续提交、推送及实际 CI 的独立授权见第 7 节，不追改历史失败证据。

## 1. 绑定与结论

- 基线 HEAD：`8909e7273f012af25151ea8717d8674b0e47d1ba`。候选为该提交之上的未提交工作区差异，不是新的 Git commit。
- 本轮仅补齐创建人、修改人的姓名显示及回归测试。未修改权限服务、持久化身份、数据库结构、CI 调度、测试超时或门槛。
- 当前覆盖普通网格、记录详情字段面板、XLSX / CSV 导出。原始用户 ID 仍是权威身份，姓名仅为读取时的显示投影。
- 本地验证完成；实际 GitHub CI 未运行本轮增量。原 Draft PR 的旧头 CI 不代表本候选通过，也不构成合并或部署批准。
- 独立复核报告、最终字节哈希及完整运行记录保存在 `artifacts/multitable-system-actor-names-20261112/`。一次并行 native 运行的连接重置保留为限制，不能用随后通过的串行对照抹除。

## 2. 最小实现

### 后端

`packages/core-backend/src/routes/univer-meta.ts`：

- 复用已有 `personSummaries` 通道，额外接受 `createdBy` / `modifiedBy` 的单个字符串 ID；普通人员字段继续使用 ID 数组。
- 从已获准的记录和字段收集 ID，复用一次批量用户查询，不新增用户目录接口或逐用户请求。
- 系统人员只输出非空 `users.name`，不以邮箱或原始 ID 作为姓名回退；缺失、已删除、无姓名用户的 summary.display 为空，停用状态仍沿用原标记。
- `/view` 和单记录 GET 保留 `record.data` 内原始标量 ID，姓名另放摘要。既有属性隐藏、用户 / 角色字段权限、记录读取限制先于摘要组装生效。
- 导出只修改当前响应的临时值，不更新数据库。XLSX / CSV 共用投影；未知人员导出为 `Unknown user`，无人员值导出为空。
- 普通 `person` 字段现有姓名 → 邮箱 → ID 回退保持不变。

### 前端

`apps/web/src/multitable/utils/field-display.ts`：仅对两类系统人员字段使用 ID 完全匹配的摘要姓名。摘要缺失、错配或空姓名显示“未知用户” / `Unknown user`；真正的空值仍显示 `—`。不改写输入值、不新增权限判断或数据请求。

测试扩展位于原有三个规格文件，继续沿用已登记的测试链，无新增 CI 文件：

- `apps/web/tests/multitable-system-fields.spec.ts`
- `apps/web/tests/multitable-field-display-i18n.spec.ts`
- `packages/core-backend/tests/integration/multitable-feedback-read-export-realdb.test.ts`

## 3. 分工

- Grok 4.7：限定三个前端文件实现，测试先红后绿；运行界面实际使用 xhigh，不能记为 medium。父代理随后仅修正测试冻结数组的 TypeScript 推断写法，冻结行为不变。
- 主代理：后端显示投影、真实数据库回归、合成浏览器、验证与证据收尾。
- Sol 6.1 high：独立只读复核姓名 / 身份分离、权限消费者、前后端接线及证据。该复核不等于独立重跑测试。模型会话与测试服务按各自所有权关闭，不影响其他工作区。

## 4. 执行证据

证据目录：`artifacts/multitable-system-actor-names-20261112/`。以下计数不叠加重复运行或子集。

| 验证 | 结果 | 记录 |
| --- | --- | --- |
| 后端针对性旧行为对照 | 4 FAIL / 4 PASS / 23 未选择；失败对应缺失姓名 / 导出投影 | `native-before-corrected-fixture.log` |
| Grok 前端旧行为对照 | 5 FAIL / 21 PASS | `frontend/red.log` |
| 前端最终回归 | 8 文件 / 178 PASS；包含最初 26 条子集 | `frontend/regression-final.log` |
| 后端单元回归 | 8 文件 / 263 PASS | `backend-unit.log` |
| 初次完整 native | 3 文件 / 45 PASS | `native-after.log` |
| 增补 CSV 后并行 native | 44 PASS / 1 FAIL，HTTP `ECONNRESET` | `native-final.log` |
| 同源码完整串行诊断 | 3 文件 / 45 PASS，0 跳过 | `native-serial-diagnostic.log` |
| 合成 Chromium | 9 PASS，两个角色各下载并解析 5006 行 XLSX | `browser/result.json`、`browser/run-final.log` |
| 质量门槛 | `validate:all`，另含前后端类型检查 | `validate-all-final.log`、`typecheck-web.log`、`typecheck-backend.log` |

最初 native 红测中另有一项测试夹具缓存问题：直接 SQL 更新字段属性后没有刷新已有字段缓存。仅在测试夹具中调用现成失效函数，重新保留对照结果；不把夹具错误当成产品缺陷或变异命中，不修改生产缓存规则。

### 合成浏览器验收

使用真实 Vue 网格 / composable / API client、真实记录字段面板、真实 Express 路由及专属 PostgreSQL，不 mock API 响应。`browser/run-browser.ts` 和 `browser/harness.html` 绑定源文件哈希，运行前后校验五个候选代码 / 测试文件字节未变化。

9 项检查包含：翻页往返、游标无重复、创建人与修改人不同姓名、删除 / 无姓名用户安全回退、详情面板 GET 接线、两个角色各自下载 5006 行 XLSX、用户 / 角色字段屏蔽、持久化记录身份 / 数据 / 版本不变，以及非法日期 / 空字节请求仍返回 400。

- 授权角色：网格和详情分别显示两个不同姓名，普通人员字段原样显示；页面数据中的创建人 / 修改人仍为原 ID。
- 受限角色：创建人按用户隐藏，修改人按角色隐藏。网格、详情 JSON / DOM、导出均不出现对应字段值、摘要或姓名 canary。
- XLSX：5006 条唯一记录完整；未知人员不回退为邮箱或 ID。另由 native 测试覆盖完整 / 筛选两个 CSV 导出分支。
- 对 5006 条记录比较 ID、数据、版本、创建人 / 修改人元数据，无显示或导出引发的持久化改写。
- 截图：`browser/owner-grid.png`、`browser/restricted-grid.png`、`browser/owner-details.png`、`browser/restricted-details.png`。

## 5. 保留的失败与限制

1. 并行 native 中既有“foreign formula taint closes the next formula hop on reads”出现一次 HTTP socket hang up，44 / 45 通过。没有 SQL 断言失败或数据库崩溃证据。停止本轮其他测试进程后，完全相同源码的完整三文件串行对照 45 / 45 通过；未改断言、超时、重试配置或生产实现。**根因尚未证实**，不声称修复了连接问题。前端并行运行另记录 WebSocket 端口占用警告，不能据此断言两者同因。
2. 本次使用本地专属 PostgreSQL 15.17，沿用先前合成集群；不是 CI PostgreSQL 14 / Linux 的干净重建证明。没有连接 Mac mini、共享或客户数据库。
3. 浏览器是合成身份注入，RBAC bypass / token trust 关闭，验证真实权限消费者；不是登录认证、完整工作台、Safari、真实输入法或 staging 验收。
4. 主动拒读源记录的系统人员案例没有新增动态验证，既有记录读取守卫按源码复核；不将普通允许读取的对照称为主动拒读证明。
5. 普通列表 GET / 写入回显未新增此摘要通道；没有摘要的其他显示调用会安全显示未知用户。本轮不扩展到所有视图、历史或垃圾箱的姓名体验，也不宣称从 API 中删除原始 ID。
6. 浏览器零错误范围限于捕获的 pageerror、JSON 读取失败、HTTP 5xx 及 Playwright HTTP 同源约束；不是全进程 / WebSocket 出站隔离证明。

## 6. 收尾与后续

- `cleanup-receipt.json` 记录：专属数据库停止前其他连接为 0，进程已停止，只移除本轮空 socket 目录；合成数据与全部红 / 绿证据保留。浏览器、API、Vite 由运行器关闭。
- 未提交、推送、创建或修改 PR，未合并、部署、修改 CI / 真实权限 / 开关。现有 Draft 维持原状态。
- 待 owner 后续明确批准发布时，再核对远端 main / 分支漂移、审阅最终 diff、运行精确新头实际 CI；若连接重置再现，先限定定位测试传输层，不盲目重跑或放宽门槛。

## 7. 最新 main 组合与发布续期（2026-11-12）

Owner 已明确批准本轮提交、推送到既有 Draft #6875 并运行 / 脚本监控实际 GitHub CI；仍不合并、不部署。保留第 5 节连接重置的红测与未确定根因，后续通过不覆盖旧记录。

- 核实时原 PR head 仍为 `8909e7273f012af25151ea8717d8674b0e47d1ba`；main 已从 `1c02a5ec66ad8beb4b1517a467069ba4b78774b6` 前进到 `af4aba9b7f526d334aab13203f952e08d5d154cd`（#6843，备料修复及迁移）。不能称 main 无漂移，已先补组合审查。
- 姓名修复提交：`c98929fac2a5199a9133a2dbd86730f6fe409719`；自动整合 main 后的验证候选：`d845b1437cd05cb839b2aa79472bef380fc7fbb2`。没有手工冲突解决；树与 Git 自动合并结果一致，五个姓名代码 / 测试文件仍逐字节等于首次独立复核候选。
- 新 main 未改工作流或锁文件；组合保留 PR 原有 CI 测试登记和最新 main 的测试链 / provenance 增量，不减少测试或放宽门槛。本轮未新增 CI 配置修改。
- 专属合成 PostgreSQL 15 仅执行新增的 `108_create_integration_stock_prep_sheet_repair`，迁移记录 467 → 468；真实环境未迁移，备料修复写开关未开启。
- 在组合候选上串行补验：native 三文件 **45 PASS**、后端单元八文件 **263 PASS**、前端八文件 **178 PASS**、真实 Vue / API / PostgreSQL 合成浏览器 **9 PASS**、`validate:all` **PASS**。这批 native 没有复现连接重置；仍不能据此确定旧失败根因。
- 浏览器再次验证两个角色各导出 5006 行、创建人与修改人分别显示姓名、详情面板接线、未知人员回退、字段权限遮蔽及持久化身份不变。专属数据库、API、Vite、浏览器已停止，证据保留。
- 最终推送前再次核对远端 main / PR head；实际 CI 必须绑定新头，由单一五分钟只读脚本等待全部适用工作流和检查终态。旧头 CI 不复用；预期可选 Strict 跳过与失败分开记录。最终发布头、独立续期报告和 CI 结果保存在 `artifacts/multitable-system-actor-names-20261112/publication/`。
- 本节是组合验证 / 发布准备，不预先声明实际 CI 已通过。后续如仅补充本节文档，需证明运行时代码与已验收的 `d845b1437c` 相同，再以最终推送头跑 CI。
