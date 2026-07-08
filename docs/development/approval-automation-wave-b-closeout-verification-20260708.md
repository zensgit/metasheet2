# 审批及流程自动化 · wave-B 操作页人性化 · 设计与验证收尾 — 2026-07-08


> 来源审计：`docs/research/approval-automation-operation-ux-benchmark-20260704.md`（§7 P-slice 已在 desktop-parity 阶段完成；本文覆盖 wave-B「补缺陷 + 收观感」的 12 项）。
> 纪律：只陈述 MetaSheet 自身原则，不出现外部产品名。

## 1. 这一轮做了什么

RP 路由预览线收官后，/goal 固定节奏把 batch-2 的 12 个「G」项（无门、纯前端为主）按**车道=文件独占**并行开发、**champion 串行落地**。原则：**缺陷优先于打磨**（用户被挡住却不知道为什么 > 观感）。

## 2. 12 项 as-built（按车道）

| # | 项 | 车道/文件 | 一句话 | PR |
|---|---|---|---|---|
| B2-11 | 新待办到达刷新 pill | ApprovalCenterView | 不自动刷新（保护批量勾选）；重置搬进 loadCurrentTab 单一 choke 点 + static tripwire | #3932 |
| B2-12 | 催办按行状态 + 已催办记忆 | ApprovalCenterView | 按行 Set 门（原全局单飞会让"看着能点"的他行静默无反应）；429 也记为已催办；记忆不持久化 | #3919 |
| B2-17 | 模板中心 requester 卡片画廊 | TemplateCenterView | !canManageTemplates 分叉；filter 须镜像服务端 `(name|key) ILIKE AND category` | #3926 |
| B2-18 | 复杂图节点接目录选择器 | TemplateAuthoringView | 复用 useApprovalDirectory；手动 ID 高级回退（逐字符不截断） | #3950 |
| B2-21 | 模板编辑器发起人视角预览 | TemplateAuthoringView | getVisibleFormFields 共享显隐；隐藏字段诚实分「自身规则失败」vs「依赖链隐藏」 | #3937 |
| B2-22 | 保存禁用原因可视化 | MetaAutomationRuleEditor | canSave = saveBlockReasons.length===0 单一真源；穷举 32768 守卫笛卡尔 product | #3930 |
| B2-23 | 规则卡「上次运行」chip | MetaAutomationManager | 统计串行→并行（一次性合并写）；last-run chip | #3929 |
| B2-24 | executionMode 折叠进 Advanced | MetaAutomationRuleEditor | 引擎术语移出首屏；requiresJobMode 时自动展开 | #3943 |
| B2-25 | 动作步骤折叠卡 + 句式摘要 | MetaAutomationRuleEditor | 700 行控件墙折叠；persisted 默认收起、新加展开；摘要纯函数 | #3949 |
| B2-26 | 空态配方卡 + 双入口降级 | MetaAutomationManager | 空态引导（配方卡预填 draft）；双入口**降级不删** | #3957 |
| B2-27 | 目标表下拉 (+ 类型化值 defer) | MetaAutomationRuleEditor | listSheets 下拉 + 手动回退；类型化值控件**诚实缩范围**未做（需 target-sheet schema fetch） | #3955 |
| B2-06 | 线性流程脊柱（只读）+ 步骤间插入 | TemplateAuthoringView | 脊柱复用 assigneeSourceSummary（措辞不漂移）；insertStepAt 保留改名步骤 | #3956 |

## 3. review 抓到的真缺陷（agent 产出 → 主循环/对抗审阅拦下）

- **B2-17 双向谓词漂移**：client filter 依 mock 匹配 description（服务端从不匹配→按 Enter 卡片消失）**且**漏掉 key（服务端匹配→画廊把服务端返回的行藏起来）。教训：client filter 必须镜像服务端谓词，别造更宽/窄平行语义。
- **B2-22 non-vacuous 守卫**：手写 36 例让 4 条顶层守卫可 neuter 而全绿，其中 webhook-secret 一条**生产可达**（编辑已存在规则→改 webhook 触发器→secret 留空→保存）。补穷举 32768 笛卡尔 product 钉死。
- **B2-25 折叠行为未测**：mount spec 通过 ≠ 折叠生效（v-show 下内容始终可查）。补行为测试 + mutation。

## 4. agent 反过来纠正我的两处

- **B2-23**：我在 spec 里断言 Promise.all 下 read-modify-write 竞态丢条目——**错的**。agent 实证 + 我复验：RMW-after-await 不丢（JS 单线程，读写间无 await）；stale-base-before-await 才丢。agent 拒绝把我的假命题写成注释。→ [[feedback_js_readmodifywrite_after_await_is_safe]]
- **B2-25 / B2-11 等**：多次纠正我 brief 里的行号/调用点计数。「以代码为准，发现我说错要指出」是有效指令。

## 5. 系统性发现（owner 决策项）

**required `test (20.x)` 只 build apps/web，从不跑其 spec。** web spec 只在**非 required** 的 approval-web-guard / multitable-web-guard 里按手维护的 vitest filter 跑。发现时 19+ 个 approval spec + automationSaveBlockReasons 在**零** workflow 里 → 绿 PR ≠ 这些测试通过。已把它们两点接线补进 guard（跑通全 filter 735 tests 绿）。**根治需把一个 web-test job 提进 required 集**——branch-protection scope，owner 定夺。→ [[feedback_apps_web_specs_ungated]]

## 6. 过程教训（工程纪律）

1. 两 PR 都 edit CI filter 行 → rebase 必冲突（union 解：留 main 全量 + 加新词 + 跑通全 filter）。
2. `gh pr create --body` 含 backtick 会被 shell 命令替换、静默丢标识符 → 一律 `--body-file`。
3. `git checkout -- <file>` 丢未提交改动（本轮又踩，mutation 后想 revert）→ 先 commit 再 mutate，revert 用精确反向 edit。
4. 组件显式 import EP 组件的文件里加新 EP 组件（如 el-collapse）**必须**同步加进 import，否则测试壳渲染成无 class 未知元素。
5. `git push --force-with-lease` 无 explicit refspec 会因 push.default 歧义静默不推 → 用 `push --force-with-lease origin HEAD:$BR`；每次推后 re-read origin ref。
6. 非判别式金测比没金测更危险（B2-22/B2-25 都靠 mutation 才发现测试空转）。

## 7. 全池收官

**12/12 全部落地**（champion 串行）。RP 线（RP-0..RP-3）+ wave-B 12 项 = 本目标池「审批及流程自动化余下开发」清空。收尾 MD 两份：本文 + `approval-route-preview-closeout-verification-20260708.md`（RP 线）。

**agent 韧性事件**（多次由主循环接管/自做）：B2-21 agent 撞 session 限额（自做）· B2-18 agent 撞 auth 错误 mid-commit（接管其未提交实现）· B2-25/B2-27 agent 完成但留诚实 gap（补行为测试+mutation）· B2-26 agent 撞 transient 500（自做）· B2-23 agent 反过来纠正我的假竞态命题。模式：agent 跑量、主循环守门+接管，产出不因单个 agent 死亡而丢失。

**owner 决策项（未做，branch-protection scope）**：①把一个 web-test job 提进 required 集（现 required test(20.x) 只 build apps/web，从不跑 spec；已把散落 spec 两点接线进非-required guard 补救）②两仓 merge-queue（治本 rebase treadmill）。
