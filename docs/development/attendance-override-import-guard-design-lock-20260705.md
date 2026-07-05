# 考勤 override 导入护栏（备份提示 + 不可逆确认）design-lock — 2026-07-05

> **Status: PROPOSED — 等 owner ratify 后才可实现**（本刀含 UX 行为变更：给既有提交流程
> 加确认门，非 display-only，不适用 delegated-execution 姿势）。
> 依据：benchmark refresh v3 §3.5（安全默认：覆盖式导入"先导出再改"警告 + 不可逆操作
> 显式提示 + 余额重算前备份）+ 2026-07-05 现状审计（§2 锚点）。

## 1. 审计结论（为什么范围收敛到 override 导入这一个点）

§3.5 原始清单里的三个担忧，经 fresh 审计逐一定性：

| 担忧 | 现状 | 定性 |
|---|---|---|
| 年假重算覆盖余额 | accrual 引擎 **additive-only + 幂等**（`ON CONFLICT (org_id, source_key) DO NOTHING`，重跑 `lotsCreated=0`；无任何 UPDATE/DELETE 既有 lot 的路径）；且已有 dry-run 强制先行 + `annualOpsConfirm` 确认模态 + off-year 额外勾选 | **靠构造免疫，无需备份** |
| 手工调整误伤 | 负 delta 走 `deductLeaveBalance(block)`，不足即 `422 ANNUAL_LEAVE_BALANCE_INSUFFICIENT` 整事务回滚；幂等键防重放；已有确认模态 | **已护栏，仅缺"不可逆"文案**（→ §3 G3） |
| **override 导入覆盖记录** | `ON CONFLICT (user_id, work_date, org_id) DO UPDATE SET first_in_at/last_out_at/…/meta = EXCLUDED.*` 整行覆盖；**rollback 不恢复被覆盖行**（`finalSourceBatchId = existingRow ? null : …` 把既有行从批次脱钩，rollback 只删批次新插入行）；前端 `runImport` **一键直提交**——无确认模态、Preview 非强制、仅静态小字提示；且 **override 是默认模式** | **唯一真裸奔点，本锁主体** |

（merge 模式 = `min(firstIn)/max(lastOut)` 并集，非破坏性，不加门。commitToken 是防重放
闸不是人的确认闸——前端自动获取。）

## 2. 现状锚点（2026-07-05 实证）

- override 覆盖写入：`plugins/plugin-attendance/index.cjs` ~L17943-17960（`DO UPDATE SET`
  全行）、~L18014-18018（override 分支直接替换打卡时间）、~L34743（`clearMissing` 连带清
  multi-punch meta）。
- rollback 不可恢复：~L18006（既有行脱钩批次）+ ~L35141/35165（rollback 只
  `DELETE … WHERE source_batch_id = $1`）。
- 前端裸提交：`AttendanceView.vue` `runImport` ~L18244（无 confirm）；Import 按钮 ~L6084
  仅 `:disabled="importLoading"`；模式选择器 ~L5902-5911 默认 `override`。
- 待镜像的确认 idiom：`annualOpsConfirm` ~L7100-7113（label→value lines 复述 +
  `extraConfirmRequired` 必勾选；accrual 侧还有 **dry-run 先行强制**——commit 按钮
  `:disabled="!annualAccrualDry"` + 编辑参数即清预演 ~L23007）。
- 可复用的备份出口：既有 `GET /api/attendance/export`（CSV/JSON，`attendance:read`）——
  **前端调用既有只读路由即可实现"先导出备份"，零后端改动**。（批次自带的
  `…/batches/:id/export.csv` 导出的是 post-commit 快照，不能当被覆盖行的事前备份。）
- **Preview 现无既有行覆盖计数**：preview builder `plugins/plugin-attendance/index.cjs` ~L31630（sync）/~L22733（async），payload ~L32138 的 `stats = { rowCount, invalid, duplicates }`——`duplicates` 是**载荷内**去重（`seenKeys=userId:workDate` ~L31868），**从不查 `attendance_records`**；commit 路径虽在 ~L32601 批量预取既有行（`existingMap`），但 `importedCount` 对新/覆盖行一视同仁、**不聚合覆盖数**。故 Preview 当前拿不到"准确覆盖 N"（→ §6 Deferred）。

## 3. 范围（frontend-only；G1 是行为变更半边，G2/G3 是文案半边）

| # | 改动 | 口径 |
|---|---|---|
| G1 | **override 提交确认门**：`importMode==='override'` 时，"Import" 不再直提交，先弹 `annualOpsConfirm` 同款模态——lines 复述（模式 / **影响范围 = Preview 的解析行数 `rowCount` + 日期范围/员工集**）+ **通用不可逆警告"被覆盖行无法通过 rollback 恢复"**（**不承诺精确既有行覆盖数 N**——见 §2 锚点 / §6 Deferred）+ 必勾选 "我已知晓被覆盖行无法通过 rollback 恢复" + 模态内一键 **"先导出备份"**（调既有 export 路由按导入范围下载 CSV，下载与否不阻塞，但按钮点过与否显示状态）。**姿势 = A（owner ratified 2026-07-05）**：强制 Preview 先行（镜像 accrual 的 dry-run-required：无 Preview 结果时 override 提交按钮禁用，参数变更即失效预演）——house 已有 idiom；A 的价值是**强制预演 ＋ 复核解析行**，**非**精确覆盖计数。〔B = 仅确认模态、无 Preview 也可提交：**已否决**——override 是破坏性默认，值得强制 dry-run。〕 |
| G2 | merge 模式**不弹门**（非破坏性），保持一键；模式选择器旁的静态小字升级为明确对比文案（override=覆盖且不可回滚 / merge=并集） |
| G3 | 手工负调整的 `annualOpsConfirm` lines 增加一行"扣减将写入台账，需以反向调整回补（不可直接撤销）"（纯文案） |

## 4. 硬边界

- **零后端改动**：不加路由/字段/表；备份 = 调用既有只读 export 路由；确认门纯前端。
- **不承诺精确覆盖计数 N**（"零后端改动"的直接推论）：G1 modal 只显示影响范围（`rowCount`/日期范围）+ 通用不可逆警告；精确 N 需破本边界（后端 overwrite-stat）或 N 次单员工读——均 → §6，不进本锁。
- 不改 merge 行为、不改默认模式（default `override` 保持——改默认是产品决策，→ §6）。
- 错误路径 enum-strict；确认模态复用 `annualOpsConfirm` 结构与 testid 约定；zh/en 走 `tr()`。
- async 导入路径（`/import/commit-async`）与同步路径同门——门在提交动作前，与路径无关。

## 5. 完成口径

- 前端实现（导入确认状态机抽独立 `.ts` 模块）+ web 测试：override 弹门/必勾选/未勾选禁提交、
  **影响范围（`rowCount`/日期范围）+ 通用不可逆警告文案进 lines**（A 姿势含"无预演禁提交+参数变更失效"）、merge 不弹门、导出按钮调用
  export 路由的精确 wire 断言、G3 文案断言；**mutation 自检**：砍确认门 → override 直提交
  用例翻红。新 spec 接入 attendance-web-guard（run 列表 + 双 path-filter）。
- Opus 对抗审阅 0 P1/P2 后合并；frontend-only 不设 staging 门。

## 6. Deferred（各自独立 gate，不随本刀）

- **真回滚**：被覆盖行事前值持久化（restore 表/批次 meta）+ rollback 恢复语义——后端行为
  变更，需单独 design-lock；
- override 默认模式改 merge（产品决策）；
- 服务端强制 Preview（后端校验 prepare 引用）；
- **精确既有行覆盖数 N（overwrite count）**：两条路都不进本锁——(a) 后端 preview 加 overwrite-stat 最省力（commit 路径 ~L32601 已有的既有行批量预取可直接复用来计 `existingMap` 命中数），但**破 §4 零后端改动**；(b) 前端 preview-rows ∩ 既有读路由计算，但 `GET /api/attendance/records`/`export` 均**单 `userId`** scoped，需每员工一次调用（N 次）。本锁只给通用不可逆警告，精确 N 留作独立增强 gate；
- 余额域快照导出入口（价值低——accrual 免疫 + 调整已护栏，记录即可）。
