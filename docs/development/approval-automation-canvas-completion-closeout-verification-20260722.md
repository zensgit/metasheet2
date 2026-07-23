# 审批、自动化与 Canvas 组合收口验证（2026-07-22）

**结论：ENGINEERING STACK VERIFIED THROUGH DRAFT #4539; NOT MERGED, UAT'D OR ENABLED**

本文对组合根 #4540 `ca207f8e8930479bec27a4fb86a90a7a0fc41039` 及其重排后的最终数据栈头
#4539 `60d42499547a0b01a7c1bdfb43aede0c6fc58c5a` 的本地验证负责。
Draft、远端 CI、合入 main、真实租户 UAT 和生产启用是五个独立状态。

## 1. 为什么需要组合 PR

数据根 #4510 与 Canvas 顶部 #4538 没有 patch-equivalent commit，但重叠 22 个关键文件，包括：

- `TemplateAuthoringView.vue` 和共享 node editor；
- `graphTopologyEdit.ts`、`parallelEdit.ts`、`ApprovalProductService.ts`；
- approval routes、automation executor、CI run-list。

直接分别合入会让后落分支覆盖先落行为。#4540 在最新 main 上保留两边语义，并对组合态重新验证。

## 2. exact-head 验证证据

### 2.1 新库与真链

使用独立 PostgreSQL 数据库从空库运行全部迁移，迁移成功到：

- approval template version restore；
- FWB action/ledger；
- durable outbox；
- approval attachment scan/purge。

随后运行：

| Gate | 结果 | 证明范围 |
|---|---:|---|
| FWB production activation | 14/14 | 真实 rule save、审批完成、executor、权限与同事务写回 |
| S1-S8 matrix | 9/9 | 崩溃窗、reclaim、zombie fencing、FWB chained outbox |
| FWB write action | 4/4 | claim + record + revision/outbox 原子性与 duplicate net-once |
| attachment integration | 30/30 | bind/GC、pipeline、upgrade migration、flag OFF 正控 |
| template restore UAT API | 6/6 | concurrent restore、stale/cross-template 拒绝、规则重校验 |
| fresh-DB combined integration | **63/63** | 上述联合范围 |

在重排后的最终数据栈头另行复验：

| Gate | 结果 | 证明范围 |
|---|---:|---|
| record-link + FWB create/update + S1-S8 | **85/85** | record-link 39、update 15、activation 18、matrix 9、write action 4 |
| attachment + template authoring/restore UAT | **25/25** | attachment 19、authoring/restore 6 |

### 2.2 前端与后端

| Gate | 结果 |
|---|---:|
| Canvas/authoring/version focused on #4540 | 8 files / 157 tests |
| approval/topology/FWB focused backend unit on #4540 | 6 files / 182 tests |
| final FWB/record-link focused web | 8 files / 152 tests |
| final FWB/record-link focused backend unit | 9 files / 56 tests |
| required web on final stack head | 359 files / 4310 tests |
| full backend on final stack head | 525 files / 7183 passed; 182 files / 1633 configured skipped |
| frontend `vue-tsc --noEmit` | pass |
| backend `tsc --noEmit` | pass |
| frontend production build | pass |

构建中的既有 chunk-size warning、测试桩的未注册 Element Plus 组件 warning 和预期 fail-closed 日志均未被当作失败。

### 2.3 2026-07-23 审阅修复轮

在重排到 `origin/main@ee39a13eb9db27d01c89cb19f0644b546c711347` 的最终 #4539 head 上：

| Gate | 结果 | 证明范围 |
|---|---:|---|
| formula + graph + product service unit | **3 files / 221 passed** | 动态依赖、区间恒真证明、历史静态公式跳过与动态正控 |
| combined real-DB | **6 files / 92 passed** | template authoring/restore 7、record-link 39、FWB create 18、update 15、write 4、S1-S8 9 |
| backend `tsc --noEmit` | pass | 最终组合 head 类型面 |
| authoring error + parallel preflight + mounted view web | **3 files / 98 passed** | machine-code 文案、未知错误 fallback、raw node/source 不可见、SFC 接线 |
| frontend `vue-tsc --noEmit` | pass | 错误映射与 authoring 接线类型面 |

动态依赖守卫的“始终允许”变异使 AST、运行时和保存三条指定规格同时变红；区间恒真守卫的“始终否”变异
使区间证明与保存拒绝两条指定规格变红；条件可见字段正控防止把可能隐藏的 required 字段误判为恒真。
record-link 的 required 真库矩阵以
base-read 为唯一变量，覆盖 submit 和 picker 的 fail-closed/positive-control 两面；未对生产授权代码执行削弱型
源代码变异。

### 2.4 Claude/Grok 外部复核后的 exact-head 复验

用户明确授权将本轮相关代码发送给 Claude/Grok 后，两者在 composed head 上执行只读复核。Grok 构造出带动态
引用的恒等式公式可绕过恒真门；ReClaude/Opus 独立确认该缺口，同时确认 record-link base-read 与 FWB number
activation 均 fail closed。两者对 formula dry-run 的判断不一致：Codex 检查返回面后保留作者自己的公式/结构诊断，
因为它不回显数据库错误、运行时值或隐藏字段值。

修复重叠到最终 #4539 head 后的结果：

| Gate | 结果 | 证明范围 |
|---|---:|---|
| formula + graph + product service unit | **3 files / 224 passed** | AST 恒等式、保存门、历史模板 runtime fallback |
| combined real-DB | **6 files / 92 passed** | template authoring/restore 7、record-link 39、FWB create 18、update 15、write 4、S1-S8 9 |
| authoring errors + parallel preflight + mounted inspector | **3 files / 44 passed** | 通用并行错误不含 raw key、authoring 错误与真实 SFC 接线 |
| backend `tsc --noEmit` + frontend `vue-tsc --noEmit` | pass | 最终组合 head 类型面 |

恒等式拒绝由纯函数、服务保存、历史运行时和真 API 四层正反例覆盖。本轮曾尝试临时中和新增守卫做源码变异，
但执行环境因会短暂制造审批路由安全回归而拒绝；没有绕过限制，也不把该项写成 mutation-proven。既有动态依赖
和区间恒真守卫的历史变异证据仍有效，但不替代本轮恒等式测试。

### 2.5 2026-07-23 P2 修复与全栈重排

后续审阅证明上一轮“恒等式检测 sound”和“#4540 已在当前 main”均不成立。本轮修复后：

- semantic truth 与 authoring/runtime capture policy 分离。可选字段或缺失 requester context 的自比较不再被
  `approvalConditionFormulaIsProvablyAlwaysTrue` 冒充为语义恒真；
- authoring 明确拒绝结构恒等和保守算术恒等（至少 `x - x == 0`、`x * 0 == 0`），错误码为
  `APPROVAL_CONDITION_FORMULA_CAPTURE_PRONE`；
- legacy 存量图命中静态/捕获公式时返回 values-free 409，不再静默 `continue` 到 default edge；
- FWB mounted editor 的 18 项组件规格进入 required `web-tests`，同时进入 approval guard 的
  pull-request/push path 与执行命令。

exact-head 本地证据：

| Gate | 结果 | 证明范围 |
|---|---:|---|
| formula + graph + product service unit | **3 files / 226 passed** | semantic totality、capture policy、legacy fail-closed、authoring choke |
| capture guard mutations | **3/3 RED** | semantic totality、authoring capture、runtime capture 各自被对应规格击杀 |
| FWB mapping required slice | **2 files / 21 passed** | model 3 + mounted editor 18，日志确认两文件均被收集 |
| required web script | **359 files / 4312 passed** | 实跑 `run-required-web-tests.sh`，非单独 spec 假绿 |
| fresh-DB migrate + authoring API | **7/7** | PostgreSQL 15 空库全迁移，真实 HTTP/DB 错误码与算术捕获 |
| backend `tsc --noEmit` + frontend `vue-tsc --noEmit` | pass | 重排后最终组合类型面 |

全栈从 `origin/main@1bcfc86b86f250c789d199660fc36da7b04e9a4d` 重排，依赖链和 heads 为：

1. #4540 `ca207f8e8930479bec27a4fb86a90a7a0fc41039`
2. #4524 `764e7c0f517ed94b582e3f6faabfa42c567ccdef`
3. #4531 `da565853cce1a7d12b9543243645647bb191ce9f`
4. #4539 `60d42499547a0b01a7c1bdfb43aede0c6fc58c5a`

`range-diff` 证明 #4524 的 6 个、#4531 的 2 个、#4539 原有的 10 个独有提交均 patch-equivalent；
#4539 只额外增加 required editor gate 提交。GitHub 一度只刷新 #4531 的 branch ref、未刷新 PR ref；对同一
base 执行无语义变化的 PR 重算后，两者均指向 `da565853c`。

## 3. 数值写回的真实边界

当前生产链可写回 `text`、`select`、`date` 与 `record-link`；创建新记录、更新受约束已有记录和审批节点确认值
均由真链测试覆盖。

number 不在本轮可交付范围。保存确认、创建执行和更新执行都会先调用
`hasUnavailableFwbNumberMapping`，任何 `targetType: 'number'` 均以 values-free 的
`exact_number_mapping_unavailable` fail closed。activation 真库规格还明确断言 amount 不出现在新记录中。

代码中的数值 envelope 校验器可以验证 JS safe integer、有效数字和目标 `decimals`，但生产 number 路径当前
不可达，因此不能据此宣称金额或数量已经写回。精确数值须由 D0-D4 独立完成设计锁、存储/序列化实现、权限与
真链验收后再解锁。

## 4. CI 状态

#4540 首轮远端 checks 中，`test (20.x)` 的唯一失败为既有 `multitable-oapi-scope-guard-realdb` 异步审计正控未在
flush 后读到行；本地 exact-head 单独复跑 15/15 后只重跑失败 job。重跑越过原失败的 multitable 真库步骤并最终通过，
#4540 全部 required checks 为绿。#4524/#4531/#4539 新 heads 的实际 path-trigger checks 也已成功；串行 retarget 到 main
后仍必须让完整 required set 在新基线上重新结算。

2026-07-23 P2 修复后的四层 heads 已重新推送，远端 required checks 正在按新 SHA 重新结算。本地 exact-head 证据见
§2.5；在 GitHub 对各 PR 的新 head 返回最终结果前，不称 CI 全绿。#4535 本次文档更新也以自己的新 head 结算为准。

## 5. 尚未完成

### 工程/落地

1. #4540 -> #4524 -> #4531 -> #4539 均为 Draft/未合入；外部复核修复 heads 已远端过绿。
2. 子栈已完成重排、本地 exact-head 复验与当前 stacked-base CI，但仍须按依赖顺序串行审合并逐层 retarget 到 main。
3. merged-main 上的 8 场景、附件、版本恢复与 required web 仍需正式复跑。

### Owner-only

1. 审阅并合入组合 PR，处置被吸收的来源 PR；
2. 真实租户 UAT：独立表单、审批节点确认值、结果写回、新建/更新记录、附件、版本恢复；
3. 按 durable -> Class A -> Class B -> FWB -> attachments/Canvas 分级开启并观察；
4. 决定下一轮是否投资 D0-D4 数值写回、自由连线、大图虚拟化和移动端原生编排。

## 6. FINAL 条件

只有以下条件全部满足，才能把这两条线标记为 `FINAL`：

- #4540 -> #4524 -> #4531 -> #4539 已按序在 main，最终 required checks 全绿；
- merged main 新库迁移和 S1-S8 生产链通过；
- 新建记录、更新 record-link 记录、decision-value、附件与版本恢复均有真实租户正反例；number 在 D0-D4
  独立完成前必须继续 fail closed；
- flags 分级开启后没有重复写、poison、stuck lease、权限 oracle、raw-id 泄露或 legacy 丢事件。

在此之前，准确状态是“工程组合已在 Draft exact head 上验证；等待审合、merged-main gate、UAT 与启用”。
