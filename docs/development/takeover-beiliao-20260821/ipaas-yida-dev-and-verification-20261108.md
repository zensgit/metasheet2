# 受控 iPaaS 与宜搭标准化对接：开发及验证报告

> 目标（owner 2026-11-06 /goal）：把类 n8n 的受控 iPaaS 和宜搭标准化对接开发完；开发文档已冻结为设计基线 v2.3；规划开发计划与模型、effort；完成后给出开发及验证 MD。
> 交付形态：全部为 **Draft PR**（以 main 为基）。合并、转正式、部署、打开开关、真实客户数据与真实发送都不在开发授权内，列在 §6。
> 依据：冻结基线 v2.3（入库副本 `docs/development/takeover-beiliao-20260821/ipaas-yida-dev-baseline-v2.3-20261106.md`，正文 sha256 `5657c16a…31ec1`）与 owner 补充裁定（同目录 `ipaas-yida-dev-baseline-addendum-20261106.md`），见 #6775。登记册行 R-72–R-88 同在 #6775。
> 写于 2026-11-08（UTC）。本文所有 head、CI 数字取自写作时的 GitHub 状态；入库副本见 #6775 的 `docs/development/takeover-beiliao-20260821/ipaas-yida-dev-and-verification-20261108.md`。

## 0. 一页结论

- **宜搭线全部开发完**：Y0–Y10、Y5a、Y6a、Y9a、YD、YE、YT 一 / 二段都已开发并通过独立核验。
- **iPaaS 线（R-69 链）全部开发完**：I1–I5 通过独立核验。R-69 仍未裁定，整条链只做试算、默认关闭、裁定前不合并。
- **文档**：D0 #6775（基线与补充裁定入库、R-69 ADR v4、登记册 R-72–R-88）。
- **验证方式**：每片实现后由独立核验代理在自己的工作区重跑测试、亲手做变异并看到变红、按 sha256 逐字节还原，真库用 WSL PostgreSQL 14 一次性库（用完删除）。保证类切片两轮封顶；备料线负责的 Y7/Y8 另经备料会话独立审阅；Y6 另经外部审阅（owner 转贴）发现并修复了跨模板同码问题 P1。
- **两件最值得 owner 知道的事**：
  1. Y6 P1：每份模板各自合法，仍可能在同一目标上让不同身份拼出同一编码。现改为「目标级生成布局在首次使用时封存」，两轮核验通过。仍有一处已声明的残余：首次 generated 审批之前用直接映射发出的编码，见 §6.2。
  2. 装含 Y8（模板两列）的版本时，**必须用新包重新导出生产 app.env 里的 env 绑定**，否则拉取 / 导出 / 大车道会 422（备料线实测，R-81）。这是 owner 层的生产配置改动。

## 1. 开发计划、模型与 effort

| 角色 | 计划 | 实际 |
| --- | --- | --- |
| 机械改动、文档、等 CI | Opus medium | 同计划 |
| 常规开发 | Opus high | Y0–Y3、Y6a、Y6、Y7–Y10、YD、YE、YT、I1、I2、I4、I5 |
| 难的开发（授权、并发、迁移、执行器核心） | Fable 5.1 max | Y4、Y5a、I3 用 Fable max；Fable 额度 11-06 21:24Z 用完后，Y5、Y5L 改 Opus max |
| 保证类独立核验、方案、裁判 | Fable 5.1 max | 额度用完期间按 owner 10-29 先例改 Opus max，逐片标注（§2）；额度恢复后回到 Fable max（Opus max 兜底） |
| 一般核验 | Opus high | Y2、Y7、Y8、I4 |

- 每片：实现 → 独立核验（最多两轮）→ 修复；两轮后仍有问题只落实协调裁定，不开第三轮全面核验。
- 两条线并行（宜搭、iPaaS）；owner 两次要求加速后，文件不重叠的预制片（Y5a、Y6a、Y9a、Y10）并行开工。
- **接管**：原协调会话 8039938b 于 11-06 07:56Z 额度耗尽，本会话 3ebdc4b3 接管。接管前先做了一轮只读深读（6 路读者 + 裁判），结论：Y4/Y8 半成品续做不重做；I3 原简报三处假设与代码不符，已修正；Y5a 改为数据库触发器兜底。
- **中断与续跑**：账号 5 小时额度两次、每周额度一次打断代理；工作流运行时自动重启或由心跳按续跑手册接上，没有丢失已提交的工作。

## 2. 切片总表

CI 数字为写作时该 head 上 `gh pr checks` 的通过 / 跳过（跳过项均为按设计跳过的 Strict E2E 或 Observability Strict）。「核验」列：轮次、核验模型、执行的变异数。

### 2.1 宜搭线

| 片 | 内容 | PR | head | 核验 |
| --- | --- | --- | --- | --- |
| Y0 | 首发手册 L4 七键布局 + 两模板键定义一致 | #6762 | `b862b66b8` | 文档片，实现者变异 M1–M3 |
| Y1 | dispatching 恢复手册 + 合成 PG 三例 | #6765 | `ef65f8e55` | Fable max PASS r1（9 处变异） |
| Y2 | 物料编码纯生成器 | #6766 | `3a7d92a7f` | Opus high PASS r2 |
| Y3 | v3 进入持久化发送 | #6770 | `29a1c13ef` | Fable max PASS r1 |
| Y4 | 绑定 B1：创建身份围栏、源记录绑定、执行摘要 v2、D20 | #6779 | `d2a66c47b` | Fable max r1 FIX_FIRST → PASS r2（20） |
| Y5a | D21 授权版本协议（触发器兜底 + 显式递增 + 加锁辅助） | #6786 | `335bed8f3` | Fable max PASS r1；#6792 后锁顺序适配 Opus max r1 FIX_FIRST → PASS r2（30） |
| Y5 | 绑定 B2：审批与准入事务内重新鉴权 | #6796 | `4acddf0ca` | Opus max PASS r1（40）→ 补测试增量 PASS（37）→ 随 Y5a 适配 PASS |
| Y6a | generated 封闭部件模板核心 | #6777 | `9e95092a9` | Fable max PASS r1（44） |
| Y6 | generated 接线、SOURCE_UNBOUND、真库 A9/A10、目标级布局封存（P1） | #6797 | `690777448` | Opus max r1 FIX_FIRST → PASS r2（57）；外部审阅 P1 → 修复 r1 FIX_FIRST → PASS r2（15 个变异 / 20 次红） |
| Y7 | 修复路由补缺列加补锁 | #6768 | `ba1576ca3` | Opus high PASS r2；备料线审 |
| Y8 | 模板加 issueConfirmDate / projectSpecModel | #6778 | `5cf4586a4` | Opus high PASS r1（19，含真库）；备料线审 FIX_FIRST（MF1）→ 修复 → 通过；收 VY8D-01 为 S3B-07 |
| Y9a | 发料确认日期回写核心 | #6776 | `c6a0e52dd` | Fable max r1 FIX_FIRST → PASS r2（60） |
| Y9 | 回写接线 + 真库崩溃测试 | #6812 | `eacd5d3c3` | PASS r1（25）→ 跟进增量 PASS（18） |
| Y10 | 切换对账（每项目只读、证据分离、绝不伪造 ACK） | #6785 | `a076f01ce` | Fable max PASS r1 → 补齐 4 MEDIUM 后 PASS r2（21） |
| YD | 未定事项默认做法可配置化（Q4 / D2 / D17） | #6813 | `602a8cff0` | r1 FIX_FIRST（37）→ PASS r2 增量（14） |
| YE | 来源校验失败的专用不可重试校验码（四个来源校验失败 422；封存目标建草稿即 409；库 / 解密故障仍 503） | #6819 | `96cb35f77` | Fable max PASS r1（19 个变异 / 26 次运行，1 个结构上不可达存活）；收尾提交实现者自证见红 |
| YT 一段 | R82 存活变异在各自文件里的钉子（只加测试） | #6780 | `47ed0a678` | Fable max PASS r1 |
| YT 二段 | owner-http 缺省读取器、准入后中止真库、IDENTITY_RESERVED 409 | #6794 | `ea6555465` | Opus max PASS r1（15） |

### 2.2 iPaaS 线（R-69：仅试算、默认关、裁定前不合并）

| 片 | 内容 | PR | head | 核验 |
| --- | --- | --- | --- | --- |
| I1 | 合成具名只读操作 → 运行内传值 → 宜搭纯预览 | #6764 | `291daaffe` | Fable max PASS r2（45）+ 补测试 PASS |
| I2 | 插件侧受治理入口 + signal + checkpoint（1b-i） | #6769 | `949e01496` | Fable max PASS r1；11-08 合 main（含备料 BI 系列）后另行核验，见下 |
| I3a | 作业租约：表、心跳续租、带围栏的结果记录 | #6782 | `b93bc9a4a` | 与 I3b 一并核验 |
| I3b | run_integration_job 动作、执行器、端口、开关、迁移（1b-ii） | #6789 | `8ad9a8744` | Fable max PASS r1（41）→ 补测试增量 PASS r2（14） |
| I4 | 规则编辑器支持（1b-iii） | #6793 | `b5ca82869` | Opus high r1 FIX_FIRST（HIGH）→ PASS r2 |
| I5 | integration.run_finished 触发器 + 告警模板（1c） | #6795 | `811552dd6` | Opus max r1 FIX_FIRST（HIGH）→ r2 FIX_FIRST（裁定类 MEDIUM）→ 落实裁定后增量 PASS（29）；合 main 后补 held(pull_batch_installing) |

### 2.3 文档

| 片 | 内容 | PR | head | 审核 |
| --- | --- | --- | --- | --- |
| D0 | 基线 v2.3 与补充裁定入库、首发手册凭据措辞、R-69 ADR v4、登记册 R-72–R-88、本报告 | #6775 | `88d86313f` | 协调者审（正文 sha256 一致、无代码、values-free）；备料线只读核过登记册编号与行文；下一个空号 R-89 |

## 3. 关键修复与发现（按发现时间）

- **I4**：运行页原样渲染 run_integration_job 的输出，里面带租户 id → 已改为 values-free 摘要。
- **I5**：动作步骤抛错时一条摘要都不发；关停摘要被静默丢弃；Proxy / 访问器可绕过闭集校验 → 已修。另按基线 §10.2.2 ③ 给事件加了 canApply 与分决策计数（R-84）。
- **Y9a / Y9**：取事实端口返回 null 时会落成不可修复的终态 → 已修。回写钩子从「submit 内等待」改为「submit 返回后、受关停排空跟踪」（基线 D5）。
- **Y8（备料线 MF1）**：装过字段包的部署在 env 动作里存了按 33 列导出的显式字段映射，新模板多两列就会 422 → 安装手册附录 C 新增「重新导出 env 绑定」一步（R-81）；备料线的真库复现收为 S3B-07。
- **Y5 / Y5a**：持有者锁顺序改为先锁主体版本行；死锁一律失败关闭（PB→CONFLICT、PA→UNAVAILABLE），从不误放行。#6792 之后又补了字段行路径的锁顺序，ensureFields 的写写死锁也修了（R-80）。
- **Y6 P1（外部审阅）**：两份各自合法的模板（身份 + 字段 / 字段 + 身份）配上精心选的字段值，可在同一目标上让不同身份拼出同一编码 → 目标级生成布局签名在首次审批 / 准入时原子封存，不同布局（含不带 generated 的草稿）一律 409；修前在旧 head 上用真 PG 复现为红（R-86）。**撤回此前「G1 + 一侧规则已消除全部同码反例」的结论**，已记入 memory，作为以后核验跨草稿保证的检查项。

## 4. 栈关系与合并顺序（供 owner 合并时参考）

- **宜搭主栈**：Y3 #6770 → Y4 #6779 → Y5 #6796（合入 Y5a #6786）→ Y6 #6797（合入 Y6a #6777，内含 Y2 #6766）→ 其上并列 Y9 #6812（合入 Y8 #6778 ← Y7 #6768、Y9a #6776）、YD #6813、YE #6819。
- **叠在 Y4 上**：Y10 #6785、YT 二段 #6794。**单独基于 main**：Y0、Y1、YT 一段、D0。
- **iPaaS 链**：I2 #6769 + I1 #6764 → I3a #6782 → I3b #6789 → I4 #6793 → I5 #6795。
- 所有 PR 以 main 为基，说明顶部写明栈与自身 diff 范围。父 PR squash 合并后，子 PR **合 main，不 rebase**。
- **合并时已知的冲突与解法**（都已和备料线约定）：
  - Y7 × I2：两边都重钉 `s6a-package-provenance-pins.json` 的 pluginHttpRoutes，后合的一方重算钉子并重跑插件测试链。
  - **iPaaS 链 × 备料 BI-1b（#6814 已进 main）**：
    - `computeDryRun` 签名取并集（`governedEntry = null, pullBatchLane = null`）；
    - I2 把备料路由重构成受治理入口，BI-1b 在原处理器里加了一两行调用（逐处理器列在 #6814 正文里），合并时把这些调用机械地搬进受治理入口；
    - 插件 `index.cjs`、开关清单、web token 清单都按「保留 main 的行 + 追加」处理。
  - **Y8 / Y9 × BI 系列**：`applyAddDecision` 新建行写批次单元格，但永不写 issueConfirmDate / projectSpecModel；`project-targets` / `target-provisioning` 新表出生时两边都保留；写锁词表文本相邻。
  - **I5 × 备料拉取脚本**：`not_found` → skipped、`review_pending` → held、`skipped_pull_batch_installing` → held(pull_batch_installing) 都已在 I5 里（I 链 11-08 已合 main）。
- **R 线**：R82（onprem-r82 = `a7f23ec17`）已发布，未装 222。以后挑入从 onprem-r82 往后切；**Y0 / Y3 / Y4 挑入前须先有 #6714**；I1 须适配 R 线的串行 plugin-tests.yml（R 线缺 #6660）。

## 5. 按 T 层默认前进的决策（owner 24 小时内可否决）

完整行文见登记册 R-78–R-86（#6775）。另有几项写在各 PR 说明里，摘要如下：

- R-78：Y4-05 取 (a)；D20 暂用通用 CONFLICT（YE 起改专用码）。
- R-79：D21 覆盖由数据库触发器兜底 + TS 显式递增。
- R-80：主体版本行先锁；死锁失败关闭；#6792 后字段行路径的锁顺序。
- R-81：Y8 的 continuation 排除、填写视图与部署表规则、装机重新导出 env 绑定（备料线确认的是 MF1 改法与其真库复现一致；在 222 上改 app.env 仍是 owner 闸门）。
- R-82：R82 五个存活变异定性为测试缺口。
- R-83 / R-84：R-69 1b-ii / 1c 的默认值（每项目意向 + 租约；canApply 与分决策计数；skipped 默认告警、held 静默；not_found / review_pending 映射）。
- R-85：Y10 对账行保留 intent=create；R1–R9 推荐值；abandon 只限运行所属 owner。
- R-86：hash 名排序成对布局；G1 一侧变长；rowIdOf 指向绑定键字段；目标级布局封存。
- **PR 说明里的其他 T 层默认值**：
  - Y9：回写运行不读发送开关（ACK 刚好在开关关闭前到达的仍补写日期），也不做 proveDraftTarget 直证；
  - YD：两个 preset 可各自选形式，声明 uuid-36 等同缺省；
  - Y6：hash 成员换序视为同一布局，封存只存摘要，封存时机是审批 / 准入（不是建草稿时）。

## 6. 需要 owner 的事项

### 6.1 批准类（不在开发授权内）
1. **合并与转正式**：上表全部 Draft PR，顺序见 §4。iPaaS 链在 R-69 裁定前不合并；Y3 在首次测试表单发送成功前保持 Draft（R-70 ③）。
2. **开关**（默认全关，精确 `'true'` 才开）：
   - 宜搭：`INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS`、`INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED` / `_TARGET_REFS`、`INTEGRATION_YIDA_RECONCILE_READ_ENABLED`、`INTEGRATION_YIDA_SHEET_SOURCE_ENABLED`；
   - 自动化：`INTEGRATION_AUTOMATION_RUN_*`（I3–I5）；
   - 已有的多目标与发送开关。
   - 打开回写开关前，要先给角色授予可操作档，否则每条已确认发送都会留下永久的 permission_revoked 记录（Y9 运行手册）。
3. **装机**：R81 / R82 装 222 各需单独批准。装含 Y8 的版本时，**生产 app.env 的 env 绑定重新导出**须 owner 批准并写进装机单（R-81）。
4. **真实读写**：Y10 每项目对账读真实宜搭；任何真实发送；真实客户数据。
5. **否决窗口**：§5 所列 T 层默认值。

### 6.2 待 owner 决定的设计问题
- 物料编码由系统生成还是用宜搭流水号（Q2，默认系统生成）；小数均分规则（Q4，默认精确均分、除不尽拒绝）；编码形式 uuid-36 还是 uuid-32（D2，默认 36 位，需对照旧代码 `StockInfoController.java:1896`）。YD 之后这三项都是配置项，owner 定值即可，不用改代码。
- Y5：第一阶段的主体行锁是否只对有绑定的行取（目前所有审批 / 准入都取）。
- Y5a F4：是否做一次性迁移，把遗留 jsonb 字符串格式的 property 规范成对象（目前登记为协议缺口、靠运维兜底）。
- **Y6 残余**：是否改为「目标的任何首次审批即封存」，以覆盖首次 generated 审批之前用直接映射发出的编码；目标定位串（appType / formUuid）是否需要规范形式（目前只去空格）。
- R-69 本身的裁定（I 系列合并的前提），以及 ADR 后续：§3.1 sheet_id 必须是已登记目标表、§6.5 绑定租户与表所属租户比对、§11 四夹具权限等价矩阵。
- ensureFields refuse / preserve 模式的预读竞态（P0-S 后续，只会写写冲突，不会误放行）。

### 6.3 待客户 / 现场回答
- Q1 项目号下拉收到选项外的值；Q3 宜搭里已有的旧记录（默认走 Y10 对账）；Q6「默认值」字段的用途；Q7 旧数据是否有材质为空的行；F1 项目规格型号从哪里取（PR-6 等它）。

## 7. 未定事项的默认做法（R-88：一律可配置 + 默认值）

| 事项 | 默认做法 | 配置方式 |
| --- | --- | --- |
| Q1 下拉收到选项外的值 | 该行无效、不发送 | 目录里的选项与控件类型 |
| Q2 物料编码由谁出 | 系统生成 | 每个字段选生成 / 宜搭自填 |
| Q3 宜搭已有旧记录 | 按项目只读对账，先只计数，绝不重复创建 | Y10，每项目单批 |
| Q4 小数均分 | 精确均分，除不尽拒绝 | `quantityRounding`：exact（默认）/ legacy-1dp（会改总量） |
| Q5 回写发料确认日期 | 业务默认回写，代码开关默认关 | 两个开关 + 目标名单 |
| Q6「默认值」字段 | 常量或宜搭自填 | 映射 |
| Q7 材质为空 | 报 KEY_MISSING | 「允许空键」逐键勾选 |
| F1 项目规格型号 | 空列、不映射 | 有来源后配映射；PLM 取值字段到 PR-6 再定 |
| D2 编码形式 | uuid-36 | preset 选项 uuid-36 / uuid-32，由目标布局签名封存 |
| D17 表格来源 | 跟随多目标开关 | 独立开关 `INTEGRATION_YIDA_SHEET_SOURCE_ENABLED`（默认关） |

## 8. 通用化候选：宜搭 ↔ 任意多维表的可配置对接（R-87）

> owner 2026-11-07 同意列为 iPaaS 增值方向，**本轮不开发，后期完善**。

- **已经通用、可直接复用的部件**：v3 映射、源记录绑定与创建身份围栏、D21 事务内重新鉴权、发送台账与回读、切换对账、集成作业动作与租约、run_finished 事件。
- **目前写死备料场景、通用化时要改的接缝**：
  1. 范围来源：项目号取自备料项目登记表 → 表上任选一列作范围列；
  2. 创建身份：(keyValue, projectNo) → (keyValue, scopeValue)；
  3. 来源表：main 上「从表格读」已能选任意 owner 可读的表 / 视图（多目标开关打开时），但只有已登记的备料项目表才产生源记录绑定（Y4 `yida-sheet-source.ts` 的 `resolveProjectSheet`），而正式目标只收绑定行；
  4. 列集合：备料模板列 → 由所选表的字段决定；
  5. 物料编码预设与发料确认回写：保留为备料专属预设；
  6. 宜搭侧：字段 ID 目前全由管理员手填，没有表单结构读取与字段选择器；做选择器要真实读宜搭（owner 审批）。
- **触发条件（任一即立项）**：备料宜搭链路在 222 首发成功并稳定；该客户提出第二个宜搭场景；owner 决定作为对外功能。
- **粗略规模**：约为本轮宜搭线的一半到三分之二。在此之前，不往通用部件里加新的备料专属假设。

## 9. 验证方法与证据位置

- **独立核验**：
  - 核验代理不信 PR 说明，在自己新建的 detached 工作区（`wt-verify-<片>-tk*-r<轮>`）里重跑基线测试；
  - 逐个对被保护的代码做变异，亲眼看到对应测试变红，再按 sha256 逐字节还原；
  - 并发保证用两条真实连接加屏障来证，不靠 sleep。
- **备料线审阅**：Y7 / Y8 由备料会话（「备料应用插件」）独立审阅；R82 存活变异由备料线 R82 核验实跑定性；登记册 R-78–R-88 由备料线只读核过。
- **外部审阅**：Y6 P1 由 owner 转贴的外部审阅发现，修复后两轮核验通过。
- **证据位置**：
  - 每片的核验报告在协调会话 scratchpad 的 `dev-program-20261106/verify-<片>-r<轮>/review.md`（本机临时目录，不入库）；
  - 各 PR 说明里都有见红变异表与本地 / CI 运行记录；
  - 开发账本是同目录的 `STATE.md`，代理规则与全部协调裁定在 `AGENT-RULES.md`。

## 10. 已知限制与后续

- **I 链已合 main（11-08，c058f8442）**：备料 BI 系列落在 I2 改写过的处理器里的只有一行（BI-1b 试算里的 pullBatch 上下文），已搬进受治理入口 `governedStockPrepPull.runDryRun`，HTTP 处理器委托入口，两条路径一致，测试 G-08 钉住；其余 BI 改动自动合并，路由快照未重钉；I5 补了 held(pull_batch_installing)（默认静默，T 层），对账测试第三个声明例外 P-INSTALLING:canApply；安装窗口的写锁拒绝不再落 failed。合并后的独立核验（Fable max，17 个变异）PASS；遗留 1 条 MEDIUM 测试缺口：「安装持有者的写锁拒绝 → held(pull_batch_installing)」目前逐层钉住（端口规则、对账测试夹具），还没有一条用真实安装租约端到端跑通的测试，列为后续小片。另一项 T 层默认：pull_batch_installing 归 held、默认静默（与 review_pending 一致），owner 可改为告警。
- **宜搭栈与 main**：Y 系列最后一次合 main 在 914e439cf / c5481cdbf 前后；之后 main 上的备料改动（BI-2 等）与 Y7 / Y8 / Y9 在 project-targets、target-provisioning、写锁词表上文本相邻，合并时按 §4 处理。
- **PR-B（Y10 面板与手册）**：/initialization 的 reconcileEnabled 显示位随 PR-B 发。手册三条：轮换凭据前先放弃运行；库层换 owner 时把运行标 ABORTED；首个 POST 前记下 commandId。
- **D17 b 的面板显示位**：/initialization 的 sheetSourceEnabled 与 web 区块留作后续小片。
- **F1 / PR-6**：项目规格型号取值逻辑，等客户答复。
- **本机环境**：
  - 这几处只在 Windows 本机失败，CI 是裁判：`yida-owner-runtime.test.ts` 在 CRLF 工作区会 OOM（LF 副本通过）；开关清单测试 14 在 Windows 上有一处 CRLF 假红；两个浏览器车道文件需要 CI 的网络隔离。
  - 本轮新记的两个偶发失败（重跑一次失败作业即绿，已记入 memory）：考勤 w4c3c 锁等待、恢复启动 RECOVERY_LOCAL_CUSTODY_STORE_REFUSED。
- **可选的 Fable 复核清单**（Fable 额度用完期间改用 Opus max 核验的片）：Y5（r1 与补测试）、Y5L、Y6 r1 / r2、YT 二段、I5 各轮。

## 更新记录
- 2026-11-08：定稿。全部切片开发完并通过独立核验；YE、I 链合 main 两项已补入。
