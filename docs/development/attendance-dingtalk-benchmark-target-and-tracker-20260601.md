# 考勤对标钉钉 — 目标 + 进度追踪（单一真源）

> **版本** 2026-06-01 · 取代过时且未入库的 `docs/research/dingtalk-attendance-optimization-plan-20260514.md`（v1）
> **用途**：唯一的"我们在对标什么、到哪了、还差什么"账本。任何 attendance 开发开工前先读它 + `git log origin/main` 查重，落地后回填 ✅。**防止"开发着开发着就开发歪了"。**
> **基线**：origin/main @ `7e573591b`（#2189，本 PR 对账时的 base；rebase 后更新为最新 hash）。证据为 `file:line`/PR 号。v1 的 schema/API/UI 设计**仅作 archived design reference**，且 **RBAC 一节作废**（见 §5）。
> **档位经产品负责人 2026-06-01 拍板**（自动对班降 SHOULD+灰度门；排班修改窗升 MUST）。

---

## 0. 三视野（北极星）

| 视野 | 范围 | 量级 | 现在做？ |
|---|---|---|---|
| **H1 — scheduler-scope 收尾** | 把已建成的子管理员范围/enforcement 线收干净 | **3–7 人天** | 是，零散收尾（§4） |
| **H2 — 考勤核心成熟度** | **不追全量钉钉**，只补"真实客户会痛"的核心（MUST/SHOULD，§1） | **3–5 周** | **是，最值得做的下一阶段** |
| **H3 — 钉钉级高级** | 调度/换班/多门店/设备围栏/人脸/算薪… | **2–4 月+** | 否，不一口吞（拆 3a 可建 / 3b 不自研，§6 末） |

---

## 1. H2 目标档位（产品负责人 2026-06-01 最终版）

> 验收口径：MUST 项 = **后端运行时强制 + 前端可配 + 反向（权限/校验）测试 + 1 条 staging 联调** 才算 ✅；不是"能展示"算完。

| 档 | 项 | 关键约束 |
|---|---|---|
| **MUST** | **排班合规引擎**（日/周/月工时 cap，**超限阻断保存**） | 钉钉最硬护城河。**MUST 口径 = 排班时阻断保存；warning-only 只算报表/预警红利，不算 MUST ✅**（避免实现方交 warning 充数） |
| | **未排班提醒**（提醒负责人/本人） | ⚠️ **不是小 feature**：attendance 无调度器、无事件→通知消费者（2026-06-01 verify 证伪"渠道已有"）→ 实为"**attendance scheduler + notifier 基座**"基础设施刀（镜像 `ApprovalSlaScheduler`，leader-elected + env 渠道 notifier）；与**假期过期提醒共建/复用同一基座**。估时 **2–3pd**（原 1–2pd 作废）；排序靠后（§3）。**未排班处理策略 → 归 ③ 打卡策略组，不在此单建** |
| | **排班修改窗**（可改 N 天内、超窗锁；钉钉默认 180） | 与合规引擎 + 历史数据可信度强绑；无它则报表不可信。实现量小、治理价值高 |
| | **打卡策略组**（外勤审批 + 内外勤卡合并 + **未排班打卡策略**） | 三项同属 punch policy → 一个"**打卡策略配置基座**"design-lock（greenfield，0 现有字段）；抽屉已在只差配置写入；未排班"阻断/允许打卡"默认 **allow**（不回归） |
| | **加班 ↔ 调休** | 假勤闭环 |
| | **假期过期管理**（expires_at/延长/提醒） | 假勤闭环 |
| **SHOULD** | **自动对班**（**feature-flag 默认关，先 preview/建议态，再灰度自动写入**） | 误判会污染考勤/加班/请假/报表全链 → 不直接自动写，灰度门 |
| | 一天多班次（multi-slot） | 动 `shift_assignments` schema |
| | 排班发布/草稿（draft/pending/published） | 动 `shift_assignments` schema |
| | 临时班次（划线 temp_shift） | |
| | 加班三段（工作日/休/节按日型独立引擎） | 当前仅公式派生，引擎不区分 |
| **OPTIONAL** | 调度 · 换班 · 小组织挂部门 | 多门店/连锁客户真要时单点开（各约 1–2 周，非 H3 的"2–4 月"）|
| 🚫 **OUT** | 算薪引擎（**对接 SaaS 不自研**）· 防作弊/越狱 · AI 拍照 · 原生 app · 插件市场 · 多时区报表（除非海外客户） | 防 scope creep 红线 |

---

## 2. 现状对账（done vs remaining）

> ✅ 已落 · 🟡 部分 · ⬜ 未开始 · 🚫 不做。证据为当前 main 实测。

| 项 | 档 | 状态 | 证据 / 备注 |
|---|---|---|---|
| 管理范围 RBAC + 运行时 enforcement | （H1 已成） | ✅ | `scheduler_scopes`（subject×action×6-target）+ enforcement E1–E5（#2134→#2140/#2142/.../#2162-2164/#2175）；**异构于 v1 模型**，见 §5 |
| 主/子负责人 | （已成） | ✅ | group owner roster/panel/scope（#2099–2103） |
| 综合工时（报表侧） | （已成，OUT 之外的红利） | ✅ | #1801 等（113 hits，`enforcement:'warn'`） |
| 固定班 preview/apply + provenance + managed controls · 周矩阵展示 · 打卡只读抽屉 · HR 字段/onboarding/work-time drawer · FormulaEngine（仅差 4–5 函数） | （红利） | ✅ | 并行 session 两天内落地 |
| 排班合规引擎（超出禁止保存） | MUST | ⬜ | 综合工时仅报表 warn；排班时 block = 0 |
| 未排班提醒（= scheduler+notifier 基座刀） | MUST | ⬜ | **verify 2026-06-01 证伪"渠道已有"**：attendance 无调度器、无事件→通知消费者 → 镜像 `ApprovalSlaScheduler`+notifier；2–3pd；与假期过期提醒共建。处理策略已移入 ③ |
| 排班修改窗 | MUST | ⬜ | **greenfield**（2026-06-01 轻核：原标的 5 hits 经核为无关的 report-sync job-locking，并非排班修改窗）；可**免迁移**——policy 入现有 `ruleSet.config` JSONB + update-time 按日期判窗，hook 在 assignment PUT/DELETE 路由 |
| 外勤审批 | MUST | ⬜ | 0 |
| 内外勤卡合并 | MUST | ⬜ | 0（打卡抽屉只读） |
| 加班↔调休 | MUST | ⬜ | 0 |
| 假期过期管理 | MUST | ⬜ | 0 |
| 自动对班 | SHOULD | ⬜ | 0 |
| 一天多班次 | SHOULD | ⬜ | 0 |
| 排班发布/草稿 | SHOULD | ⬜ | 0 |
| 临时班次 | SHOULD | ⬜ | 0 |
| 加班三段引擎 | SHOULD | ⬜ | 公式派生，引擎不区分日型 |
| 调度 / 换班 / 小组织 | OPTIONAL | ⬜ | 0 |

**余下量**：H2 全量（MUST+SHOULD）≈ 3–5 周；**只做 MUST ≈ 2.5–3.5 周**。

---

## 3. H2 执行排序（产品负责人 2026-06-01）

① **排班修改窗**（**首刀**；纯 update-time 校验，不碰 scheduler/notifier 新基座；治理价值高）
② **打卡策略组**（外勤审批 + 内外勤合并 + 未排班打卡策略；一个 punch-policy 配置基座 design-lock）
③ **排班合规引擎**（招牌）
④ **加班调休 + 假期过期**（假勤闭环；假期过期提醒在此**首建** scheduler/notifier 基座）
⑤ **未排班提醒**（**复用 ④ 的 scheduler+notifier 基座**；镜像 `ApprovalSlaScheduler`）
⑥ **自动对班**（灰度门，feature-flag 默认关 → preview → 自动写）

> **回填（2026-06-01 pre-flight 发现）**：原排序把"未排班提醒"列首，依据"渠道已有/最便宜"——**verify 证伪**（attendance 无调度器、无事件→通知消费者）。故改：**排班修改窗为首刀**（真·最便宜 + 治理高）；未排班提醒降级为后续"scheduler+notifier 基座"基础设施刀（2–3pd，与假期过期提醒共建）；未排班处理策略归 ③ 打卡策略组。

> **⚠️ schema 成组迁移，别一刀一迁。** 首刀"排班修改窗"按当前实现路线**不做 DDL**：policy 先落现有 `ruleSet.config` JSONB，write-time 按受影响日期判窗。后续若要把排班合规（`shift_constraints`）、发布（`status`）、多班次（`slot`）、或持久锁窗（`locked_at`）落到 `attendance_shift_assignments`/`rule_sets`，这些 schema 变更再打一个协调 migration，再分层叠 service/UI（v1 阶段2 已是此意）。

---

## 4. H1 — scheduler-scope 收尾清单（3–7 人天）

| 项 | 量 | 备注（含审计 `/tmp/attendance-scheduler-scope-enforcement-audit-20260601.md` 收紧） |
|---|---|---|
| scoped 非管理员真实 UX smoke | **0.5–1.5 天** | 必须 seed "**有 scope、无中央 `attendance:import`/`approve`**" 的子管理员——证明 scope 分支**可达、非死代码**（`fullImport`/`canAccessOtherUsers` 会短路）；并核 provisioning 不会给同一人同时发中央权限+scope（否则 scope 在 import/approve 上被静默忽略） |
| dept/roles/roleTags 真 picker | **0–4 天** | **roles/roleTags 当前无可枚举源**（开放词汇）→ 大概率停在 chips、性价比低、可不做；departments 若有部门树才值得做 |
| async import/batches/rollback/templates/integrations 开放给 scoped actor | design-lock **0.5–1 天**；接线另 **3–6 天** | 当前是 `withAttendanceImportPermission`（中央权限）专属、自洽两层模型。**倾向 design-lock 拍板后 DEFER 接线**（YAGNI，除非客户明确要） |

---

## 5. ⚠️ 已发生的偏离（记录，否则再歪一次）

v1 阶段1 旗舰 = `attendance_admin_scopes`（scope_type + permission_set）。**实际并行 session 建的是完全不同的 `attendance_scheduler_scopes`（subject×action×6-target）+ 一整套运行时 enforcement。**
- **能力已交付且更完整**（v1 只设计 scope CRUD，实际还做了 11 路由的运行时 403）——**不回退、不按 v1 的 `attendance_admin_scopes` 重做**。
- v1 §三整节作废；后续"管理范围"以 `scheduler_scopes` + `assertAttendanceSchedulerScopeAllowed`（`index.cjs:~15269`）为准。
- 其余阶段 schema 可参考 v1，但**落地前必 `git log origin/main` 查重**（本轮已撞 2 次：T4 pickers、整条 enforcement）。

---

## 6. 防漂移规则（这份文档存在的意义）

1. **唯一真源**：本表是"对标到哪了"的唯一账本。每个 attendance PR 合并后回填对应行 ✅ + PR 号。
2. **开工前查重**：`git fetch origin main && git log origin/main --oneline -15` + grep 该项特征 symbol/路由，确认没被并行抢做（**讨论计划 ≠ 占坑**）。
3. **每项独立 opt-in**：MUST/SHOULD/OPTIONAL 各项是独立 PR 链，不自动串下一刀。
4. **OUT 红线**：§1 的 🚫 项不碰。
5. **验收口径**：MUST 项"能配置且运行时生效 + 反向测试 + staging 联调"才 ✅。
6. **H3 拆两类**：**3a 可选可建**（调度/换班/小组织/多门店——客户真要时单点开，各约 1–2 周）vs **3b 不自研红线**（算薪→SaaS · 防作弊→原生 app · 人脸/AI→视觉资源 · 设备/WiFi/地理围栏→原生/硬件）。别把"能做的大"和"不该自研"混报"2–4 月"。
