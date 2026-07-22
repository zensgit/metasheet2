# 审批、自动化与 Canvas 组合收口验证（2026-07-22）

**结论：ENGINEERING STACK VERIFIED THROUGH DRAFT #4539; NOT MERGED, UAT'D OR ENABLED**

本文对组合根 #4540 `7b54908c9e7194991403cdb8962186c17e0415ed` 及其重排后的最终数据栈头
#4539 `c2e5d134f84cb5d131a0c1f855e81e187860f7ee` 的本地验证负责。
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

## 3. 数值写回的真实边界

当前不是“number 未实现”。生产链已经：

- 在 UI/config allowlist 中允许 `text | number | date | select`；
- 在执行时从目标 number 字段读取 `property.decimals`；
- 在真审批完成链中把 amount 写入多维表，并由 S1-S8 联合矩阵覆盖。

承诺范围是安全整数，或不超过 15 位有效数字且不超过目标小数位上限的数值。以下输入 fail closed：

- 超过 JS safe integer 的整数；
- 超过可靠十进制 envelope 的高精度值；
- 小数位超过目标字段 `decimals`；
- 无法解析的数字字符串。

因此常规金额/数量可写回；任意精度财务 decimal 仍是独立产品与存储设计，不得在本轮冒充支持。

## 4. CI 状态

#4540 首轮远端 checks 中除 `test (20.x)` 外均成功；该 job 的唯一失败为既有
`multitable-oapi-scope-guard-realdb` 异步审计正控未在 flush 后读到行。本地 exact-head 单独复跑 15/15，通过后仅重跑该
失败 job。记录本文时重跑仍在结算，因此不写成“CI 全绿”。#4524/#4531/#4539 的新 heads 也必须分别结算自己的 checks。

## 5. 尚未完成

### 工程/落地

1. #4540 -> #4524 -> #4531 -> #4539 均为 Draft/未合入；远端 CI 尚未全部结算。
2. 子栈已完成重排与本地 exact-head 复验，但仍须按依赖顺序串行审合并逐层 retarget 到 main。
3. merged-main 上的 8 场景、附件、版本恢复与 required web 仍需正式复跑。

### Owner-only

1. 审阅并合入组合 PR，处置被吸收的来源 PR；
2. 真实租户 UAT：独立表单、审批节点确认值、结果写回、新建/更新记录、附件、版本恢复；
3. 按 durable -> Class A -> Class B -> FWB -> attachments/Canvas 分级开启并观察；
4. 决定下一轮是否投资任意精度 decimal、自由连线、大图虚拟化和移动端原生编排。

## 6. FINAL 条件

只有以下条件全部满足，才能把这两条线标记为 `FINAL`：

- #4540 -> #4524 -> #4531 -> #4539 已按序在 main，最终 required checks 全绿；
- merged main 新库迁移和 S1-S8 生产链通过；
- 新建记录、更新 record-link 记录、decision-value、常规数值、附件与版本恢复均有真实租户正反例；
- flags 分级开启后没有重复写、poison、stuck lease、权限 oracle、raw-id 泄露或 legacy 丢事件。

在此之前，准确状态是“工程组合已在 Draft exact head 上验证；等待审合、merged-main gate、UAT 与启用”。
