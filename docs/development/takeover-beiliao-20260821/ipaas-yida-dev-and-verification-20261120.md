# 宜搭 / iPaaS 集成线：开发及验证报告（2026-11-20 上午，续篇）

> 读者：owner（Harold，裁定）与 Codex、权限线（评审）。本文只汇总、不裁定。
> 本文 values-free：不含主机、地址、口令、token、authorityCode、appKey、凭据值和客户真实数据；只写位置。指纹 digest 只写前 8 位。

## 0. 承接关系与范围

- **承接**：
  - 设计基线 `ipaas-yida-dev-baseline-v2.3-20261106.md` 与补充裁定 `ipaas-yida-dev-baseline-addendum-20261106.md`；
  - 第一份开发验证报告 `ipaas-yida-dev-and-verification-20261108.md`（宜搭 Y0–Y10、iPaaS I1–I5）；
  - 收尾报告 `ipaas-yida-dev-and-verification-20261109-closeout.md`（I6a–I6d、Y8 对齐、R-90–R-92）。
  - 沿用它们的切片编号与术语（Y 系列 = 宜搭，I 系列 = iPaaS 作业链，AIS = 授权输入序列化，D21 = 授权版本协议）。
- **本文范围**：2026-11-09 之后到 2026-11-20 上午新增的内容。11-17 的开发验证草稿（仓库外，见 §9）是底稿，本文把它压缩并补上 11-18 至 11-20 的进展。
- **时点与基线**：
  - 写作时点 2026-11-20 09:00–09:05（UTC+8；UTC 01:00–01:05）。
  - 基线 commit：`origin/main` = `05f35de0c`（#6950，2026-11-20 08:51 +08:00）。
  - PR 状态均为本文写作时用 `gh` 的只读查询（附录 A 有查询说明）。
  - 「已合入」只在 `gh` 显示 MERGED 时才写；其余写「未核实」。
- **标记**：
  - 【gh】写作时亲查的 PR / 检查状态；
  - 【日志】写作时亲读的 CI 日志；
  - 【转述】取自仓库外证据或记忆，本文没有重跑，未核实之处汇总在 §8.3。

## 1. 一句话现状

- 宜搭剩余栈（7 个 PR）全部是 Draft，没有一个合入。**合并顺序已定、每个都要 Harold 点头，Harold 11-20 选了「审过再合」**：先等 Codex 审完 #6915 + #6786 这一对，权限线审完 fence 与他们那几条测试的改动，再按顺序合。【转述 记忆 11-20】
- #6786、#6796、#6797、#6813、#6819 的 `unit (20.x)` / `test (20.x)` 红，**经日志核实全部是同一对用例**：`authorization-input-writers.guard.test.ts` 里的两条，它们要等 #6915 先合才会转绿（§3.2）。
- 今早（11-20）发现并处理了第二个 fence 问题：fence 锁定了所有 public 函数，Y6 的迁移新增了一个函数，从 Y6 起往上全部会让授权操作返回 503；已在 Y6 加了自己的分区并向上合到 YD / YE / Y9，全部推送（§6）。
- 所有发送、写回、多目标开关仍然关闭，客户还没用上新东西。首发（窗口一 / 窗口二）没有日期，卡在客户测试应用与 owner 批准，不卡开发（§4.3）。

## 2. 11-06 之后的开发计划摘要

### 2.1 切片清单

「状态」只写 `gh` 核到的；栈内 Draft 的 head 见 §3。

| 切片 | PR | 做什么 | 依赖 | 状态 |
|---|---|---|---|---|
| Y0–Y3、Y6a | #6762 #6765 #6766 #6770 #6777 | 首发手册、dispatching 恢复手册、物料编码生成器、v3 进入发送、generated 模板核心 | 互相独立或叠栈 | MERGED（11-16 15:26–15:29Z）【gh】 |
| Y4 | #6779 | 绑定 B1：创建身份围栏、源记录绑定、执行摘要 v2 | Y3 | MERGED（11-16）【gh】 |
| YT1 / YT2 / Y9a / Y10 | #6780 #6794 #6776 #6785 | 变异钉子、owner-http 缺省读取器、回写核心、切换对账 | Y4 等 | MERGED（11-16）【gh】 |
| Y7 / Y8 | #6768 #6778 | 修复路由补锁、模板两列 | Y7 → Y8 | MERGED（11-09、11-13）【gh】 |
| I1–I5 | #6764 #6769 #6782 #6789 #6793 #6795 | iPaaS 作业链（R-69，仅试算、默认关） | 链式 | MERGED（11-14 07:12–07:14Z）【gh】 |
| D0 | #6775 | 基线与补充裁定入库、R-69 ADR、登记册 R-72–R-88 | — | MERGED（11-09）【gh】 |
| AIS 骨架 / 组织锁闸 | #6897 #6902 | 授权输入序列化的判定骨架与守卫 | — | MERGED（11-14）【gh】 |
| 备料线 D1 / D3 | #6925 #6928 #6927 #6926 #6929 #6931 | 存档修订不计机器列、carry、fills 计数、运行手册等 | — | MERGED（11-17）【gh】 |
| 平台 1b | #6932 | 宿主 `patchRecord` 读行加 `FOR UPDATE` | — | MERGED（11-18 02:09Z）【gh】；11-17 草稿里写的 Draft 已过时 |
| AIS 判定规则 | **#6915** | 只对 D21 一个文件、这一摘要、这十条触发器语句放行 | #6897 | Draft |
| Y5a | **#6786** | D21 授权版本协议（触发器兜底 + 显式递增 + 加锁辅助）；本轮含 fence 的 D21 分区、只读计划 lock-only | #6915 先合 | Draft |
| Y5 | **#6796** | 绑定 B2：审批与准入事务内重新鉴权 | Y5a | Draft |
| Y6 | **#6797** | generated 接线、目标级布局封存；本轮含 fence 的 Y6 分区 | Y5 | Draft |
| YD | **#6813** | 未定事项默认做法可配置化 | Y6 | Draft |
| YE | **#6819** | 来源校验失败的专用不可重试码 | YD | Draft |
| Y9 | **#6812** | 发料确认日期回写（方案 A：回写不提升项目写代次；扫描修复与游标；written_inactive；留痕加固） | YE | Draft |
| D2 | #6940 | 通用写入方不得抹掉或植入机器列 `issueConfirmDate`（剥离机器列 + `expectedVersion`） | 独立；与 Y9 谁后合谁补一条钉子 | Draft |
| 出网 (a) | #6941 | `/api/events/subscribe` 改走 S0-a 出网守卫 | 独立 | Draft |
| 出网 (b) | 无 | HTTP 适配器；等 Codex 的 S0-b | — | 未核实（没找到 S0-b 的 ref / PR） |
| S1–S4 ADR | #6914 | iPaaS 步骤化线（R-94）ADR | — | Draft |
| S1-a / S2-a | 无 PR | 受治理配置读入口（纯重构、休眠）；步骤输出库（只有库、无调用方） | ADR #6914 合并后推送 | 本地分支，未推送（11-19 记忆；本文未复核） |

### 2.2 计划评审（11-16，Fable max，`sound-with-changes`）

- 结论：已建成的东西和宜搭剩余栈的合并顺序成立；缺的是从「合了、开关关着」走到「客户在用」的一段。
- 5 条最小修复（X）：
  1. 把现场线写进计划并定日期；
  2. AIS 一对一轮评审、成对批准，点名归属人；
  3. S1-b 开工前 owner 先定 S 线做完是什么样；
  4. 出包条件从「Y4 合入」扩到「Y5、Y6 合入且暴露审计里有 D21 一行」；
  5. 窗口一之前问清封进槽的是哪套凭据。
- 证据：`E:/Projects/_program-evidence/ipaas-yida-20261106/plan-review-20261116/SUMMARY-zh.md`、`OWNER-DECISIONS-merged-20261117.md`。

### 2.3 相关登记册条目（`decision-register.md`，main `05f35de0c`）

| 条目 | 要点 |
|---|---|
| R-93 | 宜搭剩余系列常设授权：必需检查全绿、保真核对通过、无冲突、证据入目录时，集成线可对齐推送、按栈次序合并；开关、部署、生产写入、真实数据、AIS 契约、K3 写不在授权内；AIS 侧由集成线写、Codex 审，合并逐项请 owner 批 |
| R-94 | 开 S1–S4 线，ADR 另开 PR、另批合并；读真实系统、写入、开关、部署仍逐项批 |
| R-97 | D3-1：写到失效旧行并标 `written_inactive`；备料线让日期跟着行走 |
| R-98 | 平台 1b（#6932） |
| R-99 | 类 n8n 集成助手方向（11-19，四项按推荐） |
| R-96 | **不在 main 的登记册里**（main 上 R-95 后接 R-97）。R-96 只在 Y9 分支里，合入时与 R-97 要手工排序、保持 CRLF【转述 11-17 草稿 §4.8；本文只核了 main 上缺 R-96】 |

## 3. 7 个 PR 栈当前状态

### 3.1 状态表（2026-11-20 09:04 UTC+8 = 01:04Z，【gh】）

CI 数字 = 成功项数；跳过项（按设计跳过的 Strict E2E 等）不计。「审阅」只写 GitHub 上看得见的；Codex 与权限线的审阅发生在会话里，不在 GitHub review 记录里。

| 顺序 | PR | 切片 | 分支头 | CI | 审阅状态 | 合并前置条件 |
|---|---|---|---|---|---|---|
| 1 | #6915 | AIS 判定规则 | `f0efb8745` Draft | 40 绿 0 红，`MERGEABLE / CLEAN` | GitHub 无 review。Codex 一轮评审**未完成**（本文写作时） | Codex 审完；Harold 点头（R-93 ③ 契约项逐项批） |
| 2 | #6786 | Y5a | `f234640c5` Draft | 75 绿，2 红：`unit (20.x)`、`test (20.x)`（汇总项）；见 §3.2 | GitHub 只有 11-16 一条评论，无 review。Codex 与权限线均**未审完** | #6915 先合（让 writers.guard 那一对转绿）→ 合 main、重跑 CI → Codex + 权限线审（fence 分区、中央锁入口一行、测试等待位置）→ Harold 点头 |
| 3 | #6796 | Y5 | `238baf1a3` Draft | 77 绿，2 红（同上） | 未核实（GitHub review 未查） | #6786 合入 → 合 main、CI → Harold 点头 |
| 4 | #6797 | Y6 | `f0de8d814` Draft | 79 绿，2 红（同上）；`attendance-db` 已转绿（早些时候曾在运行中） | 权限线需审 Y6 的 fence 分区 | #6796 合入 → 合 main、CI → 权限线审 → Harold 点头 |
| 5 | #6813 | YD | `cfa900800` Draft | 80 绿，2 红（同上，01:01–01:02Z 刚跑完） | 未核实 | #6797 合入 → 合 main、CI → Harold 点头 |
| 6 | #6819 | YE | `1ade786f3` Draft | 80 绿，2 红（同上，01:00–01:01Z 刚跑完） | 未核实 | #6813 合入 → 合 main、CI → Harold 点头 |
| 7 | #6812 | Y9 | `f8c228d6d` Draft | 87 绿；**运行中（截至 01:02Z）**：`unit (20.x)`、`multitable-db (20.x)`、`approval-db (20.x)`、`attendance-db (20.x)` | 备料线对备料文件回 OK（R-93 ④）与 Codex 签 `db.cjs` 根方法：本文未核实现状 | #6819 合入 → 合 main、CI 全绿 → 备料线 OK → R-96 否决窗口 → Codex 签 `db.cjs` → Harold 点头 |

旁支：

| PR | 内容 | 头 | CI | 状态 |
|---|---|---|---|---|
| #6940 | D2 机器列写入者 | `7ec1cca6b` Draft | 39 绿 0 红 | 备料线文件 blob 未变（11-19 记忆）；合并另批 |
| #6941 | 出网守卫 (a) | `9d8017097` Draft | 37 绿 0 红 | 合并另批 |
| #6914 | S1–S4 ADR | `8630e4110` Draft | 32 绿 0 红 | owner 答待裁项并批合并（R-94 ①）。11-17 草稿里写的头是 `aadb188f3`，已被后续提交取代 |

7 个栈 PR 与 3 个旁支都不是 MERGED。合并顺序 #6915 → #6786 → #6796 → #6797 → #6813 → #6819 → #6812，每个都要 Harold 点头。

### 3.2 `unit (20.x)` 红的真实原因（亲查日志）

- **方法**：`gh pr view` 取失败检查，再 `gh run view --log-failed --job <id>` 取失败作业日志，按 vitest 的 `FAIL` 行与汇总行统计。每个 run 的 head 都等于上表的当前分支头。
- **结果**：#6786、#6796、#6797、#6813、#6819 **完全一致，都是 core-backend 单元测试里同一个文件的 2 条用例失败，其余全过**。

| PR | 作业（unit） | 汇总行 | 失败用例（两条，同一文件） |
|---|---|---|---|
| #6786 | run 44566499276 / job 135715042377 | 1 个文件失败；2 failed、30477 passed | 见下 |
| #6796 | run 44566515246 / job 135722615783 | 2 failed、30494 passed | 同 |
| #6797 | run 44645345815 / job 135989232731 | 2 failed、30880 passed | 同 |
| #6813 | run 44645352874 / job 135989677865 | 2 failed、30883 passed | 同 |
| #6819 | run 44645362812 / job 135989952086 | 2 failed、30890 passed | 同 |

失败文件与用例（`packages/core-backend/tests/unit/authorization-input-writers.guard.test.ts`）：

1. `migrations > every migration outside the frozen list is checked: one that writes an input carries the bounded try form and each of its writes is judged safe`
2. `migrations > POSITIVE CONTROL — through the real traversal: a compliant migration passes, a raising or lock-less one is rejected, and the frozen list cannot absorb a later file`

- **失败内容**：第 1 条的断言是「期望空数组，实际 10 项」，十项都是 D21 迁移 `zzzz20261106110500_add_authorization_version_rows.ts` 的 `unreadable DROP TRIGGER: statement kind is not on the safe list`（在 #6786 日志里读到）。也就是 main 上的 AIS 判定器还不认 D21 那十条触发器语句，而 #6915 正是给这十条加放行规则的 PR。
- **结论**：与记忆里说的「writers.guard 那一对，要等 #6915 先合才会绿」**一致**。`test (20.x)` 只是 `unit (20.x)` 的汇总项（30 秒内失败，不跑用例）。
- **还没有证实的一点**：「#6915 合入后这对转绿」这个因果，本文只有两个佐证：(a) #6915 自己 CI 全绿，(b) 构建方在 #6915 与 Y5a 叠加后的树上跑 AIS 单测 731/731、699/699、854/854（【转述】）。尚未在 GitHub 上看到过「#6915 合入后 #6786 的 unit 转绿」，所以这一点要等 #6915 合入后的那次 CI 才能最终落实。
- **其余检查**：#6786 / #6797 / #6812 的 `authorization-operation (14/15/16/17)`（fence 矩阵）、`permissions (20.x)`、`admin-users-realdb-review` 三项、`approval-realdb-permission-catalogue` 在写作时均为 SUCCESS【gh】。

## 4. 验证记录

### 4.1 11-17 开发验证草稿要点（【转述】`dev-verification-md-20261117/…-draft.md`，写作时点 main `59876b3d6`）

| 项 | 要点 | 11-20 更新 |
|---|---|---|
| Y9 方案 A（R-96） | 回写不提升项目写代次；原因表去掉 `issue_confirm_writeback`、用途表保留。补丁包单测 34/34，加回 `bumpGeneration` 后新测试亲见红 | R-96 仍不在 main；Y9 头现为 `f8c228d6d` |
| Y9 扫描修复与游标 v2 | 新增 `db.cjs` 根方法 `selectUnmatched`（安全面，**需 Codex 签字**）；游标 `{v,s,t,c,i}`，目标集变了 409，每页至多 100 行 | 签字状态未核实 |
| Y9 日志码与 written_inactive | 四条日志码；UNWRITTEN 最终裁为 9 个结果；`written_inactive`（D3-1）带新迁移，只改写、不并入 written；变异 d1–d5 全见红 | 同上 |
| Y9 2d 头本地验证 | 宜搭单测 566/566、插件链 350 套件、lock-protocol 真库 718/718（第一次 717/718，一个 4 秒等待的时序抖动，重跑绿） | 11-19 栈对齐后 Y9 本地：后端单测 211/211、根 node 293/293、插件链 350（见 §5） |
| Y9 2e 待做项 | 告警 9 个所附条件、测试副本永不列入回写清单、written_inactive 回滚时 R85 读取方失败关闭、遗留沙箱表范围、runbook :14 等措辞 | **2e 是否完成：未核实** |
| D2 | 三个通用写入方会抹掉机器日期；3 轮修复；S6 真库 83/83、13 个变异红；第 3 轮宿主文件 241/241；普查脚本只出计数，现场一次都没跑 | 已推送为 #6940（`7ec1cca6b`，CI 39 绿） |
| 出网 (a) | `/api/events/subscribe` 改走 S0-a 守卫；41/41、S0-a 集合 323/323 | 已推送为 #6941（`9d8017097`，CI 37 绿） |
| AIS 与盲区 | #6915 规则按内容比摘要（第 4 轮）；main 上对计算 SQL / 包一层执行器的判定盲区早于 #6915，不作合并条件，另立事项 | #6915 现头 `f0efb8745`（见 §5） |
| 备料线条件表 | Y9 合并前置：C4（CI 真库腿在 exact head 上为绿）、X4/X5、2e 全部条目 | Y9 现在已有 CI（运行中） |

### 4.2 D21 验收（11-17，【转述】`d21-acceptance-20261117/REPORT.md`）

- **做了什么**：在 WSL 里的 PG14 一次性库（前缀 `d21acc_`，共建 32 个，全部 DROP，剩 0）上，用 Y5a `ecb5e2d64` 与 main `59876b3d6` 的 LF 导出，验收 D21 迁移（LF sha256 前 8 位 `a7b1c9b2`）。共 15 个脚本、48 个日志。
- **怎么验、结果**：

| 项 | 结论 |
|---|---|
| 条件对：库里有 033 的旧外键 `user_roles.role_id → roles(id)` 时，目录同步 × 删除角色 | 确实出现 40P01 死锁（4/4）。只改代码或只改触发器都去不掉这个环，前提是那条外键。失败方整笔回滚、不留半截写入；调用方都不重试（目录同步等下一个 tick，删角色返回 500） |
| 不带 CI 排除清单的全量库 | 被排除的 6 条迁移都执行成功；D21 / AIS 套件 197/197、lifecycle 16/16 |
| 迁移顺序 | 乱序排在最后或按名序都成功，census + serialization + protocol 81/81 |
| 装机锁竞争 | `up()` 在 11 张表上持 ShareRowExclusiveLock 到迁移事务提交；常规负载 5.5 秒完成；遇 40 秒空闲长事务则 57014 整体回滚、可重跑；旧代码「先 INSERT users 再 user_roles」路径与 `up()` 表级死锁，迁移是牺牲方、整体回滚、重跑成功 |
| 回退（代码退回、迁移留着） | 13 个旧操作结果一致；旧代码多用户角色写在用户顺序相反时出现 40P01（事务形态 17/600，对照 0，Y5a 0）；旧包 migrate 报 `corrupted migrations … is missing`，所以回退必须 `-RunMigrations 0` |

- **是否改 D21 迁移字节**：不需要。唯一可选字节改动是给 `up()` 套 `lock_timeout`（把装机写停顿上限从约 30 秒降到约 5 秒），会让 #6915 重新钉 sha256、整栈重新对齐，必须在 #6915 合并前决定；本文未见该决定被做出，按「不做」处理（**未核实**）。
- **对抗复核**（Opus max）：`holds-with-fixes`，只有两条 low：(1)「load」场景下装机对写入方的影响低于测量精度，不应把 3.3 秒归因于迁移，也不能用该场景的一个 40P01 说明 D21；应以事务形态 17/600 对 0 为 D21 的 ABBA 证据（复核者复现为 19/600 对 0）。(2) 几处日志无法由已存脚本重现，其中一份日志自相矛盾（实质成立）。
- **未覆盖**：条件对与管理员授角色用「真实函数 + 未导出段落逐句重放」，没有经过 Express 路由；现场库有没有 033 外键本机回答不了，要 owner 批一次 values-free 只读探查；`admin-user-*-review` 两个套件因库名守卫没跑。
- **要补进手册与暴露审计的三条**：回退必须 `-RunMigrations 0`；回退后开着迁移装不含 D21 的包会报 corrupted migrations；旧代码在 D21 下多用户角色写会出现 ABBA 40P01。

### 4.3 首发准备（【转述】`first-send-20261119/window-1-2-checklist-zh.md` 第 2 版，11-19 02:09Z 按核对结果改过）

- **性质**：现场清单，不是开发。首发需要的代码 R84 里都有（单目标、只收 v2、开关默认关、只认原文 `true`），不需要再写代码。清单代替两份不在安装包里的旧文件（首发手册 `runbook-yida-first-send-20261104.md` 与 L3/L4 清单第 3.1 版）。
- **版本**：R84 = 标签 `onprem-r84`（`beed2a1e1`）；R85 = `onprem-r85`（`220bd80ab`），清单写 R85 已于 11-19 现场安装但**整体尚未验收**，每日拉取仍暂停（现场状态本文未核实）。
- **结论**：「什么时候让客户测宜搭连接」今天给不出日期，卡四件事：客户交测试应用并答凭据问、owner 批窗口一、窗口二当天 owner 单独批发送开关、与 R85 装机的先后。

| | 窗口一（不发送） | 窗口二（发一条） |
|---|---|---|
| 做什么 | L3 测试连接；L4 一次性本地初始化（**不可逆**，唯一撤销办法是恢复 L4 前的全库备份）；实测 PBKDF2（要求 T < 300 ms） | 打开发送开关、owner 在界面批准并只提交一次、读回核对、**无论结果都关回开关** |
| 前置 | O-0 R84 签收在现场核得到；O-1 窗口一批准；O-1a 凭据轮换（客户答「是」或「不知道」时）；O-1b 目标确认（七键布局、只报 True/False） | O-2 **当天**单独批准 `INTEGRATION_YIDA_OWNER_SEND_ENABLED`；窗口一回报全部符合要求；再做一次全库备份 |
| 关键约束 | L4 在 L3 之后在同一页面做；预检 `L4_PREFLIGHT=PASS`；开发者工具全程关闭 | 发送开关**默认关**，只认进程环境里的原文 `true`（`TRUE`、`1` 都算关）；发完改回 `=false`、不删这一行；不选 v3 草稿；不开多目标 |

- **验收口径（窗口二 S3-2）**：owner 在宜搭**测试**表单里按业务键人工核对：**测试副本比发送前恰好多 1 条合成记录 = 首发成功**；没有 = 首发没成功（不重试）；多于一条 = 停，报 owner。只记「有 / 无 / 多」。发送用的一行必须是合成数据（R-70 ④），状态停在 `acknowledged` 还要做读回核对；`outcome_unknown` 或 `dispatching` 时宜搭里**可能已有**这条记录，不再提交、不对同一行再批准（系统永不自动重发，R-50 ⑥）。
- **不在首发内**：多目标开关、第二条发送、正式表单、v3 草稿发送、K3 写回（永久禁止）。「日常怎么发」与「凭据轮换」两份 ADR 在首发之后。
- **与 R85 的关系**：两个窗口与 R85 装机不能交错；R85 装机单第 3 步要求三个宜搭开关在进程和文件里都不是字面 `true`。
- **所有现场值只在现场录入**，不经聊天、邮件、截图转交；回报只写 True/False、行数、毫秒数、状态类别和面板错误码。

## 5. 最近两轮重新对齐

### 5.1 对齐到 main `e0e4406bf`（11-18 至 11-19 凌晨，【转述】`realign-e0e4406bf/`）

- **起因**：权限线连续合入 #6924（授权操作 fence 与确认读回）与 #6934（显式委派激活），改动了 AIS 判定器、契约注册表、中央锁模块。
- **AIS #6915**：合并提交 `fbe740086`（父 = 218fa2464 与 e0e4406bf）。盘点出 main 上随功能 PR 合入的 AIS 契约变化（#6924 新增语句级规则 J1、#6934 新增路径 + 摘要绑定的 set-aside J2 与第 12 张输入表等），记录在 `realign-e0e4406bf/ais/main-ais-changes.md`；这些变化没走单独的 AIS 契约评审，本文只记录、不裁决。
- **Y5a #6786**：逐处盘点 #6924 / #6934 新增的写入路径对 D21 协议的影响；修了「互斥锁把 #6924 的 nowait 传进 D21 第一步」与「nowait 下第一步只加锁不写」。D21 迁移字节未变。
- **发现 fence 阻塞项**：在装了 D21 的库上，main 的授权操作 fence 拒绝所有授权操作（503 `AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE`），见 §6.1。当时产出了补丁包 A / B（`realign-e0e4406bf/fence-pack/`）。
- 本轮未推送；11-19 因额度耗尽中断，之后 main 又前进。

### 5.2 对齐到 main `df83192d9`（11-19，【转述】`realign-df83192d9/`）

- **起因**：权限线又合入 #6938、#6939、#6936、#6937（main → `df83192d9`）：8 个新迁移（B2）、fence 改成「B2 新增部分单独算摘要」、目录同步与 AIS 锁文件都改了。试合并：AIS 冲突 1 个文件，Y5a 冲突 10 个文件。
- **Harold 11-19 16:13 裁定「fence 选 A」**：D21 的 fence 指纹由集成线放进 #6786，先给权限线审。旧 `fence-pack` 补丁 A / B 作废（fence 文件已被 #6938 重写）。
- **冲突怎么解**：
  - AIS #6915 → 合并提交 `f0efb8745`（判定器 `judgeSource` 两侧都保留），已推送。
  - Y5a #6786 → 合并提交 `9c8e0e245`（10 处冲突，取舍在提交说明里）+ fence 修复 `6f43da89d`（D21 分区）+ 只读计划 lock-only `e9584bce5`；之后 `19e6b29ae`（夹具与 D21 排队点、封闭的两组环）、`40ccad914`（终审修正）、`f234640c5`（修 `authorization-exception-write` 夹具）。
  - 栈 Y5 → Y9 在 `40ccad914` 之上以 `--no-ff` 合并，无文本冲突、无修复提交；index.ts、vitest.config.ts、flag manifest 及其测试等清单类文件两侧都保留；s6a 钉子各层与合并后文件一致无需重算；迁移无冲突（Y6 `zzzz20261108120000`、Y9 `zzzz20261117090000` 排在 main 新迁移之前，`allowUnorderedMigrations` 允许）。Y9 的 `records.ts` 与写锁真库用例与 main 字节一致，#6932 的 `FOR UPDATE` 读保留。
- **跑了哪些检查**（WSL 里 LF 导出、PG14 一次性库，用完删除）：

| 对象 | 检查与结果 |
|---|---|
| #6915 | LF 导出上 4 个 AIS 单测文件 854/854，带 / 不带 D21 两遍都过。教训：`git archive` 必须加 `-c core.autocrlf=false`，CRLF 导出会让 5 个按字面量比对的守卫误红 |
| #6786 | 终审（Fable max，只读）：必须修一条（并行契约字面量写成反斜杠加字母 n，应为反斜杠加换行）、中等一条（只读加锁顺序按库排序规则而非调用方规范顺序，改为 `WITH ORDINALITY` 排序）、低风险文档与测试加强，均已修；PR 说明增加 review round、上线 / 回滚说明与 4 个后续项。真库 writers 696/698，仅剩已知环境抖动（`security-action-attempt-admission`，在纯 main 上同样 4/26 失败） |
| Y5–Y9 栈（11-19/20 的 `130641d4d / aa295f360 / 31d6e8d10 / d2984453e / a065cf51f` 那一轮，随后被 §6 的 fence 提交和重新推送取代） | tsc 全 0；后端单测 Y5 154、Y6 168、YD 115、YE 57、Y9 211，全过；根 node 测试 86 / 86 / 173 / 253 / 293；插件链 349（Y9 350）；owner-HTTP 41/41（YE 54/56）；真库有 1–5 个随机失败（`YIDA_OWNER_SEND_UNAVAILABLE`、`outcome_unknown`、`SYNTHETIC_GATE_TIMEOUT` 等被 fail-closed 掩码的表现，父分支上同样出现，原因未明，看 CI 上是否同样出现） |

- **本文的核对**：该轮之后的现行头（Y5 `238baf1a3`、Y6 `f0de8d814`、YD `cfa900800`、YE `1ade786f3`、Y9 `f8c228d6d`）的 CI 见 §3.1；这些头上的本地全量复跑**没有做**（未核实）。

## 6. fence 问题与处理

### 6.1 问题一：D21 触发器 / 函数让 fence 拒绝授权操作

- **现象**：权限线 #6924 的授权操作 fence（`packages/core-backend/src/admin/authorization-operation-fence.ts`）只认固定的库结构指纹清单（`SUPPORTED_SCHEMA_PROFILES`）。在装了 D21 的库上，所有授权操作返回 503 `AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE`。11-19 凌晨实测（`realign-e0e4406bf/y5a/y5a-realign-facts.md`）：13 个操作真库文件在 D21 结构上 50 failed / 46 passed / 6 skipped；只删 D21 的触发器和函数后 96 passed。
- **根因**：指纹覆盖 22 张 fence 表上的非内部触发器、所有 public 函数和数据库行。D21 在其中 5 张表上加了 6 个触发器（users 2 个，user_roles、user_permissions、user_namespace_admissions、platform_member_group_members 各 1 个），并新增 2 个 public 函数。
- **处理**：Harold 11-19 裁定「**fence 选 A**」：在 #6786 里带 D21 指纹分区，由权限线审。沿用 #6938 的 B2 分区写法：D21 的 6 个触发器 + 2 个函数单独成一个分区，摘要前 8 位 `e726ffee`；基础路径要求 B2 与 D21 两个分区都对上，D21 缺失、被停用或被替换都拒绝（提交 `6f43da89d`）。
- **怎么验证**：
  - 方法校验（本地 PG14）：带 D21 的库在新分区下的基础摘要，等于不带 D21 的库在 main 代码下的基础摘要（前 8 位 `bad4fd9c`），说明 D21 恰好只加了这 8 行。
  - 完整画像以 **CI fence 矩阵 PG14–17** 为准（`authorization-operation (14/15/16/17)`，新加了「D21 改动必拒」用例）：#6786 当前头上四项均为 SUCCESS【gh】。该矩阵在 #6786 的 `40ccad914` 上曾红，只红在 `authorization-exception-write` 夹具，已在 `f234640c5` 修复（本地 3/3）。
  - **本地不能验完整画像**：本机 WSL PG14 上 main 自己的 fence 也不接受 main-only 库（基础摘要 `bad4fd9c` 不在列表里，原因是本机 PG 小版本 / 本地化与 CI 镜像不同），所以只用 CI。

### 6.2 问题二：fence 锁定了所有 public 函数，Y6 的迁移再次破坏它（11-20 早）

- **现象**：Y6（#6797）的迁移 `zzzz20261108120000` 新增了一个 public 函数 `integration_yida_generated_layout_immutable_guard`（生成布局不可改的守卫，不碰 fence 表）。从 Y6 起往上（Y6、YD、YE、Y9）的授权操作都会被 fence 拒绝；CI 上表现为 PG14–17 的 fence 矩阵与 `permission-browser-realdb` 红。
- **根因**：fence 给**所有** public 函数算指纹，不只看与 fence 表有依赖的函数，所以任何栈上新增 public 函数的迁移都会触发同类问题。
- **处理**：在 Y6 `f0de8d814` 加自己的分区，摘要前 8 位 `bcd3224c`（PG14、C 本地化实测）；基础路径要求 B2、D21、Y6 三个分区都对上；本机实测三分区之外的基础摘要与 main 不带 D21 / Y6 时相同。然后向上合到 YD `cfa900800`、YE `1ade786f3`、Y9 `f8c228d6d`，**全部已推送**。
- **怎么验证**：同样以 CI fence 矩阵 PG14–17 为准。写作时 #6797 的 `authorization-operation (14/15/16/17)` 与 `permissions (20.x)` 均为 SUCCESS【gh】；YD、YE 的 fence 矩阵与 #6812 的 `authorization-operation (14–17)` 也为 SUCCESS，其余作业见 §3.1。
- **权限线审阅点**：`realign-df83192d9/review-request-permission-line.md` 列了 5 项，最要紧三处：① fence 的 D21 分区（#6786）与 Y6 布局守卫分区（#6797）；② 中央锁入口一行（`CONSUME` 计划传 `lockOnly`）；③ 权限线几条真库测试的等待位置改动（结果不变）。

### 6.3 剩余风险

- **以后任何栈上新迁移只要新增 public 函数，或给 fence 表加触发器，就要同步 fence 分区**，否则授权操作 503。Y9 之后若还有新迁移（例如备料线、S 线）都要查。
- 设计层面：是否改成「只看与 fence 表有依赖的函数」由权限线定（review-request 第 5 项的设计提醒）。
- **部署与回滚顺序**：D21 迁移之后，仍跑 main 旧代码的进程对所有授权操作返回 503，回滚须先跑 D21 的 `down()`（补丁 B 若采用则须先撤）。代码先于迁移上线时，授权操作 503，其它契约命令 500（42P01）。
- 后续项（不在 #6786）：把版本表本身纳入 fence 画像；对 `CONSUME` 根做静态普查，禁止其写 D21 覆盖的表；补一条 D21 仍会留下的那个死锁环的真库用例。
- 完整画像在 PG15–17 上的通过只能由 CI 证明；本文只看到当前头上的 CI 绿，没有看到合并后 main 上的结果（合并还没发生）。

## 7. 合并计划与下一步

### 7.1 合并顺序与条件

1. 先等 **Codex 审完 #6915 + #6786 这一对**，**权限线审完 fence 分区和他们那几条测试的改动**（Harold 11-20「审过再合」）。
2. 然后按顺序，每个都要 Harold 点头：#6915（squash）→ #6786（合 main 后用合并提交）→ #6796 → #6797 → #6813 → #6819 → #6812。
3. 每个栈 PR 合入前：合 main、`git merge-tree` 试合并无冲突、必需检查全绿（#6786 起 unit 要由红转绿）。
4. 合并链开始前，集成线会请权限线暂停往 main 合其它 PR 几个小时（转给权限线的文字里已提出，【转述】；对方是否同意未核实）。
5. #6812 另需：备料线对备料文件回 OK（R-93 ④）、R-96 否决窗口、Codex 签 `db.cjs` 根方法、CI 真库腿在推送的 exact head 上为绿。

### 7.2 已知未决与风险

| # | 事项 | 谁 | 等什么 |
|---|---|---|---|
| 1 | Codex 评审 #6915 + #6786 | Codex | owner 发起 / 评审时间 |
| 2 | 权限线评审 fence 两个分区、中央锁入口、测试改动 | 权限线 | 转给他们的文字：`realign-df83192d9/paste-to-codex-and-permission-line.md` |
| 3 | AIS 归属人与契约边界 | owner | 至今没有点名（11-17 草稿 owner 决定 #2）；J1、J2 是随功能 PR 合入的契约变化，未走单独评审 |
| 4 | D21 `up()` 加 `lock_timeout` 与否 | owner | 必须在 #6915 合并前定（改字节会重新钉 sha256 并整栈重新对齐）；本文按「不做」处理，**未核实** owner 是否另有裁定 |
| 5 | 现场库有没有 033 外键 | owner 批一次只读探查 | 决定条件对的 40P01 在现场是否可能出现 |
| 6 | Y9 2e、D2 第 4 轮是否完成 | 集成线 | 本文未核实；#6940 已推送且 CI 绿 |
| 7 | R-96 排序 | 集成线 | Y9 合入时手工排在 R-97 前、保持 CRLF |
| 8 | Y9 合并前置（§7.1 第 5 点） | 备料线、Codex、owner | — |
| 9 | #6914 ADR 与 S1-a / S2-a 推送 | owner | owner 答待裁项并批合并后才推送 S1-a / S2-a（本地分支） |
| 10 | 出包条件 | 备料线 + 集成线 | 「Y5、Y6 已合」且暴露审计有 D21 一行；回退手册补三条（§4.2） |
| 11 | 现场线（首发） | owner、客户、QA | 客户测试应用与凭据答复、窗口一批准；R85 验收；不卡开发 |
| 12 | 测试流水线的随机真库失败 | 集成线 | 栈对齐的真库测试每次 1–5 个不同用例随机失败（`SYNTHETIC_GATE_TIMEOUT` 等被掩码），原因未明，要看 CI 上是否复现 |

### 7.3 下一步（集成线可以马上做、不需要 owner）

- 等 Codex / 权限线反馈；有评审意见就在对应 PR 里修，修完重新对齐、重跑 CI。
- 每次 main 前进后：`git fetch`、`merge-tree` 试合并再下结论（主工作区会落后 `origin/main`，对齐前先 fetch）。
- 若发现新迁移新增 public 函数，先同步 fence 分区再推送（§6.3）。
- 不在授权内（仍逐项批）：合并、转正式、部署、打开开关、真实数据读取、任何写回。

## 8. 未核实与口径说明

### 8.1 本文亲查的

- 所有 PR 的状态、head、CI 计数、MERGED 状态与合并提交（`gh pr view`，01:00–01:05Z）；
- #6786 / #6796 / #6797 / #6813 / #6819 的 `unit (20.x)` 失败作业日志里的失败文件、失败用例名、汇总行，以及 #6786 日志里 D21 迁移的 `unreadable DROP TRIGGER` 十项；
- main 登记册里 R-93 至 R-100 的有无（R-96 缺）。

### 8.2 取自证据文件、没有重跑的

- 11-17 草稿里的测试数字、反驳结论；D21 验收的所有结果；栈对齐的本地验证数字；fence 摘要前 8 位与本地测量；首发清单的内容。

### 8.3 标了「未核实」的点

1. #6796 / #6813 / #6819 / #6797 / #6812 的 GitHub review 记录；
2. Codex 评审 #6915 + #6786 的进度（以会话为准）；
3. Y9 2e 是否完成、D2 第 4 轮是否完成；
4. D21 `lock_timeout` 是否另有裁定；
5. S1-a / S2-a 本地分支现状；
6. 出网 (b) 的 S0-b ref；
7. R85 现场装机与验收现状（清单 11-19 的回报，现场情况本文无法核实）；
8. 备料线对 Y9 备料文件的 OK 与 Codex 对 `db.cjs` 的签字；
9. 「#6915 合入后 #6786 的 unit 转绿」（只有间接佐证，见 §3.2）；
10. 现行头上的本地全量复跑；
11. #6812 的 4 项运行中检查的最终结果。

## 9. 证据位置索引（只列路径，不复制内容）

仓库内：

- `docs/development/takeover-beiliao-20260821/ipaas-yida-dev-baseline-v2.3-20261106.md`、`ipaas-yida-dev-baseline-addendum-20261106.md`
- `docs/development/takeover-beiliao-20260821/ipaas-yida-dev-and-verification-20261108.md`、`ipaas-yida-dev-and-verification-20261109-closeout.md`
- `docs/development/takeover-beiliao-20260821/runbook-yida-first-send-20261104.md`
- `docs/development/takeover-beiliao-20260821/decision-register.md`（R-93 至 R-100）

仓库外（`EV` = `E:/Projects/_program-evidence/ipaas-yida-20261106/`）：

| 内容 | 路径 |
|---|---|
| 续跑账本 | `EV/RESUME-20261115.md` |
| 11-06 起的开发计划与账本 | `EV/dev-program-20261106/STATE.md`、`DEV-AND-VERIFICATION-20261106.md` |
| 11-17 开发验证草稿（底稿） | `EV/dev-verification-md-20261117/ipaas-yida-dev-and-verification-20261117-draft.md` |
| 计划评审 | `EV/plan-review-20261116/SUMMARY-zh.md`、`OWNER-DECISIONS-merged-20261117.md` |
| D21 验收 | `EV/d21-acceptance-20261117/REPORT.md`、`scripts/`、`logs/`、`adversarial-r1/` |
| 首发清单 | `EV/first-send-20261119/window-1-2-checklist-zh.md`（附件在同目录 `frozen/`，核验在 `verify/`） |
| 对齐到 e0e4406bf | `EV/realign-e0e4406bf/`（`ais/main-ais-changes.md`、`y5a/y5a-realign-facts.md`、`fence-pack/`） |
| 对齐到 df83192d9 | `EV/realign-df83192d9/`（`README.md`、`stack/REPORT.md`、`pr-6786-review-round.md`、`pr-6786-section.md`、`review-request-permission-line.md`、`paste-to-codex-and-permission-line.md`） |
| D2 | `EV/d2-writers-20261117/`（`round2/`、`round3/census.md`、`round4/`） |
| 出网 | `EV/egress-20261117/pr-body-draft.md` |
| Y9 包 | `EV/y9-pack-20261117/`（`CHANGES-v3.md`、`y9-scan-pr-notes.md`、`SHA256SUMS`） |
| S 线 | `EV/s-line-20261119/`（`S1-a/pr-body.md`、`S2-a/pr-body.md`、`adr/`） |
| 本轮会话记忆 | `C:/Users/zen08/.claude/projects/E--Projects-metasheet/memory/integration-line-takeover-20261119.md`（完整记忆在 `C:/Users/zen08/.rec/claude/accounts/44413/config/projects/E--Projects-metasheet/memory/`） |
| 本文失败作业日志副本 | 未入库；作业编号见 §3.2，可用 `gh run view --log-failed --job <id>` 重取 |

---

## 附录 A：查询说明

- 用 `gh pr view <n> --json headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup` 取状态；用 `gh run view --log-failed --job <id>` 取失败日志。CI 数字取自 `statusCheckRollup` 的 SUCCESS 项数。
- `gh pr checks` 在查询中途出现过一次网络错误（TLS），改用 `gh pr view` 重取，未影响结论。
- 「运行中」的检查不猜结果；#6812 的 4 项检查截至 01:02Z 仍在运行。
