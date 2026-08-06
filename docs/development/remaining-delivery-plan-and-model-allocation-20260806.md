# 备料 + 数据库及系统对接:剩余交付计划与模型分配(2026-08-06)

回答一个问题:**这两条线还剩多少开发,什么时候可交付测试。**

本文的每条状态都对 `origin/main` 与 GitHub API 复核过,不引用记忆。易变事实(PR 是否已合、某 check 是否 required)一律现打 API 复核,
数字的取数命令写在正文里以便复算。

---

## 0. 结论先行

| 线 | 代码侧 | 剩余 | 卡在谁 |
|---|---|---|---|
| 数据库及系统对接(GIP) | **已落尽** | 0 个开放 PR | — |
| 备料 / K3 首 profile | **功能已落尽** | 2 个 PR,均非新功能 | 我方(今日可清) |
| 实体机窗口(先读后写) | — | 排期 + 现场执行 | **owner** |

**"还有多少开发"的答案:新功能为零,但不等于「无剩余开发」。** 剩下的两个 PR 一个是修真 bug,
一个是让 runbook 对着真实部署包跑一遍。之后的关键路径不在代码,在客户窗口排期。

---

## 1. 数据库及系统对接(GIP)——代码侧已落尽

**零个开放 GIP PR**(2026-08-06 API 复核)。已在 main 的底座 = 16 个 `gip-*.cjs` 模块 / 17 套件:

```
gip-approved-binding-resolver              gip-profile-certification-contracts
gip-binding-qualification-spike            gip-profile-compliance-harness
gip-bridge-bounded-read-profile            gip-read-observability-contracts
gip-canonical-json                         gip-server-bound-source-executor
gip-canonical-object-contract-registry     gip-sqlserver-rcsi-total-order-strategy
gip-connector-kind-registry                gip-sqlserver-snapshot-page-sequence-{executor,strategy}
gip-inert-entry                            gip-sqlserver-snapshot-paged-read-profile
gip-system-identity-read
```

含 SQL Server snapshot executor(#4665 / #4667)。`bridge.bounded_read.v2` 已落 main。
B1a 各票已于 2026-07-26 MERGED —— **逐个核实**:#4601 / #4603 / #4604 / #4609
(此处只声明这四个,因为只查了这四个;旧记录写"五票"未给出第五个编号,不予沿用)。

上面每个数字都是当场机械核出来的,不是引用:模块/套件计数 =
`git ls-tree -r --name-only origin/main | grep -c 'lib/gip-.*\.cjs$'` → 16、
同理 `__tests__/gip-.*\.test\.cjs$` → 17;"零个开放 GIP PR" =
`gh pr list --state open --search "gip in:title"` 返回空。

**这些断言是门控的**:`integration-guard` 是 main 的 **9 个 required check 之一**,
且它跑整条 `plugin-integration-core` CJS 链 —— 上述套件都在这条链里。
(此前一度记成"不在 required 里",已作废;当前 9 条 required 为
`contracts (strict|dashboard|openapi)` / `pr-validate` / `test (20.x)` / `web-tests` /
`stock-prep PowerShell 5.1 acceptance` / `attendance-web-guard` / `integration-guard`。)

**仍在 owner HOLD 名单上、不得自动开工**:GIP runtime 接线与 binding 激活、W3 消费触发、
外部写回、rollout/flag enablement、直接提高页数上限。
下一刀 `bridge.sealed_snapshot.v1`(实体机导出 + 签名 manifest + 分块续传 + 服务端校验)
是大数据量/不可分页 bridge 的长期解法,owner 明确说**本认证通过后**才开。

⇒ **本线不需要我再写代码。** 要推进只有一个动作:owner 放行 sealed_snapshot 或 runtime 接线。

---

## 2. 备料 / K3 首 profile——功能已落尽,剩两个非功能 PR

### 2.1 已在 main(现在就能测)

| 面 | PR | 内容 |
|---|---|---|
| 写路径 | #4758 / #4761 / #4766 | 命名 profile 强制 + `maxApplyRows=3` 三层锁 + C6「dry-run → 单次 token → apply」生命周期 |
| 写入面安全门 | #4769 | savePath 钉死、`/pipelines/:id/run` 与 replay 双入口关闭、C6 只消费已批准的 B4 binding |
| 读路径 | #4757 / #4763 | GetList 投影带 `FItemID`、GetDetail、B4 read binding 铸造/审批 |
| 出包验证 | #4760 / #4764 | main 出包 → 五检 → PG 15/16/17 矩阵,**实跑全绿**(run 30979764981,7/7) |
| 文档 | #4767 + #4776/#4777/#4778/#4781 | 交付 MD + 实体机窗口 runbook(含四次勘误) |

### 2.2 剩余两项

**#4784 — C6 用剥凭据的 accessor 载入写 target**(**已 MERGED** `e6523c949`)。
是真 bug:两处 C6 handler 用 `getExternalSystem` 拿到的是**去凭据**的公开响应,
adapter-backed 的 target kind 必须改用 `getExternalSystemForAdapter` 重载。

**#4768 — staging 窗口彩排**(Draft;#4784 已合,本分支已 rebase 其上)。让 runbook 对着真实部署包整条跑一遍。
本轮已解 owner 报的 source P1,机制如下(不是绕过,是找到真正的接合点):

`ensureObject` 把**一行字段**同时写成两个身份(`provisioning.ts:696`):

```
id   = stableMetaId('fld', projectId, 'plm_raw_items', field.id)   // 'code'
name = <显示名>                                                    // 'Code'
```

于是两条腿**从相反方向落到同一个 `fld_…`**:seed 走 `GET /api/multitable/fields`
(显示名 → 物理 id),adapter 走 `resolveFieldIds`(逻辑 id → 物理 id)。
前提是二者共用同一 `projectId`,已实证:`installStaging` 把入参交给 `ensureObject`
(`staging-installer.cjs:225`)并**原样 return**(`:284`)。

⚠️ **本线最隐蔽的失败形态**:`resolveObjectFieldIds` 是 **compute-only** ——
`resolved[id] = stableMetaId(...)` 对任何输入都产出合式 hash、从不省略
(`provisioning.ts:150-160`;`core-backend/src/index.ts:599` 明说 "compute-only and never
omits a field")。一个**不存在的**逻辑字段名会静默别名到从未 provision 的幽灵字段,
那列永远读空,**全程零报错**。已由契约测试钉死(config.fields ⊆ descriptor 字段 id)。

**owner 点名的第 5 步「bare read」故意没做成独立步**:`read-source-probe` 受
`requiredKind` 门控且设计上 values-free,没有干净的 staging 裸读面,新造一个是越界。
**dry-run 本身就是判别器**:两条 fieldMapping 都带 `required`,`validateRecord` 的
required 用 `isEmpty()`(undefined/null/纯空白),失败即 `counts.failed += 1; continue`
(行到不了 `counts[decision]`),而 `canApply` 要求 `failed===0 && held===0`
⇒ **code/name 为空不可能跑出绿 dry-run**。缺的只是归因,已补 `counts.failed`/`counts.held` 进证据。

### 2.3 B4 同实例门——已闭合(owner 20260806 复审后本轮修掉)

**此前确实是 target 与自身比较**:驱动器另建了 K3 读记录,却用 `targetSystemId` 铸 B4;
路由再从同一个 target 取 `targetBaseUrl`,profile 按同一 id 重载后比较。**真实读记录从未进入
比较**,两台不同的 K3 也能通过 —— 这个检查在结构上就不可能发现读写错配,换任何比较函数都没用。

根因是关系检查的可达范围:非 K3 源时读记录两端都不是,绑 target 是**唯一**能满足 #4769 的选择。
现在写目标显式声明配对读记录(`config.pairedReadSystemId`),该 id 加入关系集合,于是 B4 绑
**真实读记录**、守卫比较**两条确实不同的记录**。刻意收窄:只认 target 自己点名的那一条,
且仍须过 ratified 合同匹配、kind 门与同实例门。

**这一改动把 #4769 的关系检查放宽了一个 target 声明的 id** —— 属于动已 ratify 的闸,
依 owner 明确指示执行,在此标注以便复核。

控制(走真实路由):A→A 同一台 K3(同源不同路径,即步 0-b 拓扑)**必须接受**;
A→B 读记录在另一台 K3 **必须拒绝**。变异:`sameK3Instance → true` 令 A→B 变红;
从关系集合去掉 `pairedReadSystemId` 令 A→A 变红。

---

## 3. 时间线与关键路径

```
#4784 已合 ──►  #4768 已 rebase ──►  短复审(新 head) ──►  Ready/arm ──►  合并 ──►  dispatch 彩排
   ✅            ✅                                                                                      │
                                                                                      ▼
                                                        ┌───────────────────────────────────┐
                                                        │ 实体机窗口:先读后写(owner 排期) │
                                                        └───────────────────────────────────┘
```

**dispatch 必须在合并之后**:`workflow_dispatch` 要求 workflow 在默认分支上,
合并前 dispatch 拿不到信息 —— 这是 owner 的原话「合并后 dispatch 才有信息价值」。

**我方自主可推进的到"彩排绿"为止。** 再往后(实体机先读后写)需要客户窗口,
不是代码问题。因此**不给日期**:剩余关键路径不在我这边。

---

## 4. 模型分配(按开发难度)

分配规则本身是本线的实证产物,不是先验偏好:

| 难度特征 | 模型 | 依据 |
|---|---|---|
| **判据开放**——正确答案在开工时不可知,要靠对抗审逼出来 | **opus 5** | #4769 同一缺陷类逃逸**八次**(字段→跨文件→跨 profile 条件→检查早于归一化→`?`/`#`→单点段→段内尾点→匹配锚点)。终局解不是第九条正则,而是把守卫移到唯一咽喉点。这种"解法形状本身要被发现"的工作,便宜模型跑再多轮也不收敛。 |
| **判据已定死**——形状确定,剩机械变换 | **sonnet 5** | #4766 的套件机械变换(机制迁 BOM、material 武装 profile、5 行夹具被 cap 逼拆 3+2)由 sonnet 代理完成,零降级。 |
| **形状固定后的成文** | **fable 5** | #4759 附录 E(勘误 + 裁决记录)由 fable 后台代理起草。 |

**佐证**:本线四次独立审的多数发现是「**过强声明**」而非坏代码 ——
即瓶颈在判断力而非产出速度,这正是把 opus 押在闸门、把跑量让给 sonnet/fable 的理由。

### 剩余项的分配

| 项 | 模型 | 理由 |
|---|---|---|
| #4768 exact-head 对抗审 | **opus 5** | 闸门;且本 PR 已四次出现「守卫被测但接线未被测」 |
| #4784 合并后的 rebase 与冲突处理 | **sonnet 5** | 形状确定的机械操作 |
| ~~B4 同实例门闭合~~ | **opus 5** | 已完成(§2.3)。判据确实开放,最终解不是换比较函数,而是让关系检查够得着真实读记录 |
| 彩排跑绿后的验收 MD 回填 | **fable 5** | 形状固定,填实测值 |
| GIP sealed_snapshot(若 owner 放行) | **opus 5** | 新认证刀,判据全开放 |

### 一条估算纪律

F.1 曾把 R1 估成 0.5–2.0 人天,实耗 ~1.5,但**轮次是估计的 2 倍以上**。
⇒ **跨安全类加固按「逃逸轴条数」估,不按 diff 行数估**;轴数在开工时不可知,
所以只能给区间 + 不确定性来源,不能给点估。

---

## 5. 验证状态

| 证据 | 状态 |
|---|---|
| main 出包验证矩阵(build→五检→同源→一字节负控→PG 15/16/17) | ✅ 实跑全绿 run 30979764981(7/7) |
| 候选包 serviceRuntimeSha | `e1b91594e` |
| `rehearsal-driver-contract.test.mjs` | ✅ 10/10。**勘误**:此前写「plugin-tests.yml 门控」是错的——它跑在 `k3wise-offline-poc` job,而该 check **不在 9 条 required 里**,红了不挡合。现已同时挂进 required 的 `test` job |
| `rehearsal-harness.test.mjs` | ✅ 5/5,同一 CI step |
| 彩排端到端(真实部署包) | ⏳ 待 #4768 合并后 dispatch |
| 实体机先读后写 | ⏳ 待 owner 排窗口 |

**诚实项**:契约测试是**源码文本断言**,按 owner 的原话「不能证明真实记录成功写入」。
真正证明写入的是 dry-run/apply 的行为断言(§2.2),以及彩排 dispatch。
两者不可互相顶替。
