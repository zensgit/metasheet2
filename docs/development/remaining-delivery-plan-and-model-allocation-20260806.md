# 备料 + 数据库及系统对接:剩余交付计划与模型分配(2026-08-06)

回答一个问题:**这两条线还剩多少开发,什么时候可交付测试。**

本文的每条状态都对 `origin/main` 与 GitHub API 复核过,不引用记忆。易变事实(PR 是否已合、某 check 是否 required)一律现打 API 复核,
数字的取数命令写在正文里以便复算。

---

## 0. 结论先行

| 线 | 代码侧 | 剩余 | 卡在谁 |
|---|---|---|---|
| 数据库及系统对接(GIP) | **已落尽** | 0 个开放 PR | — |
| 备料 / K3 首 profile | **功能已落尽** | #4768 / #4784 / **#4790(D2)** / #4787 / #4785 **均已合**;剩 #4788 / #4794 文档票 | 我方 |
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

**#4768 — staging 窗口彩排**(**已合** `9a061909c`,四轮独立门审末轮无 P1 无 P2)。让 runbook 对着真实部署包整条跑一遍。**已跑两次**:首跑 `31084631813`、最终跑 `31103021849` @ `aa48c3f18`。
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

### 2.2-b 迁移名单精确校验(§6 表中该项的出处)

彩排 lane 原本只断言排除项**数量**等于 6。数量不是集合:把 `048` 换成 `074`,数量仍是 6、
全部检查仍绿,而 `074` 一旦进排除集就被从喂给 `Pending` 的那张表里删掉 —— 于是 `Pending: 0`
在 `074` **从未执行**的情况下成立。现改为对 `migration-replay.yml` 逐字集合相等,并对 074/075
逐名证明其被考虑且被执行。等量替换现在必红,而旧的数量判据对它照样放行。


> ## ⚖️ OWNER 裁决落账(2026-08-06,先于本节其余内容)
>
> 本节以下若干处写于裁决之前。**以本框为准。** 逐字 token:
> `ownerD2CeilingDecision=ACCEPT_SEPARATION_NO_DISSOLVE`
> `ownerCurrentSourceDecision=SQLSERVER_APPROVED_SOURCE`
> `ownerYuantusDecision=DEFERRED_FUTURE_PROFILE_NOT_CURRENT_BLOCKER`
> `ownerEntityWindowDecision=AUTHORIZED_TO_SCHEDULE_WITH_FROZEN_AA48_PACKAGE`
>
> **D2 天花板:接受职责分离,不做 DISSOLVE。** 最终定义:
> - **D2 只负责**证明 K3 读回绑定与 K3 写目标属于**同一认证身份**;
> - **SQL Server 来源与数据血缘**由 pipeline/source binding、dry-run token 与实体机运行证据负责;
> - 两者**本来就是不同责任**,**不要求** K3 read 记录成为 C6 的数据来源;
> - DISSOLVE 会**混淆职责**、牺牲读写账号最小权限、并导致 binding 全量重铸,**当前不授权**。
>
> ⇒ 因此本文原先把「读记录不在数据路径上」写成 **D2 的天花板/未闭合项**是**错误的归类**:
> 那不是 D2 的缺口,是**另一条责任线**,且该线有它自己的证据(source binding + token + 实体机)。
>
> **当前客户源 = 已批准的 SQL Server source。** `plm:yuantus-wrapper` 留作**未来 profile**,
> 尚无 E2E 证据,**不是当前阻塞项**。
>
> **实体机窗口:已授权排期**,使用下方冻结包身份。

### 2.3 B4 同实例门——D1 已关;D2 已按 owner 裁决定形(见上框)

分两个可以分开裁决的缺陷,混为一谈就会得出过强结论。

**D1(自比仍是被接受的配置)—— 已关。** 此前确实是 target 与自身比较:驱动器另建了 K3 读记录,
却用 `targetSystemId` 铸 B4;路由再从同一 target 取 `targetBaseUrl`,profile 按同一 id 重载后比较,
真实读记录从未进入比较。**这个检查在结构上就不可能发现读写错配,换任何比较函数都没用。**

第一轮修复(让写目标声明 `config.pairedReadSystemId`、驱动器改绑真实读记录)**只改了惯例,
没改不变量** —— `pipelineSystemIds` 是并集且仍含 `targetSystemId`,filter 只问"是否集合成员",
全树没有任何 distinctness 断言,所以在 target 上铸的 binding 照样通过。**这是我上一轮的过强声明,
已撤回。** 现在 `boundSystemId === system.id` 直接拒(`K3_C6_B4_BINDING_SELF_REFERENTIAL`),
这才把"驱动器碰巧绑了读记录"变成"这道门无法靠自己跟自己比来满足"。

~~**D2(即便真比了两行,证明力仍弱)—— 未关,四个候选方案没有一个能关。**~~

**已作废(owner 裁决 2026-08-06,`ACCEPT_SEPARATION_NO_DISSOLVE`)。** 两处都错:
判据早已不是 origin(#4790 升级为**认证身份**,已合 `aa48c3f18`);更根本的是**归类错了** ——
「读记录不在 C6 数据路径上」不是 D2 的缺口,而是另一条由 pipeline/source binding、
dry-run token 与实体机证据负责的责任线。**D2 只负责证明同一认证身份。**
~~比较两条记录只证明**两个操作员敲进去的 baseUrl 共享 origin**。~~ **已过时,两处都过时。**

**(1) 判据早已不是 origin。** #4790(已合 `aa48c3f18`,五轮门审末轮无 P1)把身份升级为
**认证身份**,逐字镜像 adapter 的认证解析:`sessionId` / `authority-code|authorityCode|token` /
`login-acctId`。同一台服务器上不同账套、不同授权码、不同会话现均判为不同实例。

**(2) 更要紧的是归类错了。** 我把「被认证的读记录不在 C6 数据路径上」称作 **D2 的天花板**。
owner 裁定这是**错误归类**:那不是 D2 的缺口,而是**另一条责任线**。
`ownerD2CeilingDecision=ACCEPT_SEPARATION_NO_DISSOLVE` —— D2 只证同一认证身份;
数据血缘由 pipeline/source binding、dry-run token、实体机运行证据负责;
**不要求** K3 read 记录成为 C6 数据来源;DISSOLVE 会混淆职责、牺牲最小权限、令 binding
全量重铸,**不授权**。

**我的错误是把两条责任混成一条,再为这个混合体找不到判据,就管它叫「天花板」。
归类错了,再诚实的披露也是错的。**

⇒ **origin 相等是配置交叉检查,不是同一台物理机的证明。** 这句必须留在验收结论里。

**这一改动放宽了 #4769 已 ratify 的关系检查一个 target 声明的 id** —— 独立复审核实过
不授予新能力:`readSourceConfigsApprove` 与 `externalSystemsUpsert` 同为 `requireAccess(req,'write')`,
能设 `pairedReadSystemId` 的人本来就能直接在 target 上铸并批准 B4;跨租户由 `loadSystemById`
从 pipeline 记录取作用域堵住。

控制(走真实路由):A→A 同一台 K3 接受;A→B 另一台 K3 拒绝;绑 target 自身拒绝。
四道门(kind / 同实例 / 关系集合 / 自引用)逐个 neuter **各自独立见红**,无互相掩护。

---

## 3. 时间线与关键路径

```
#4784 已合 ──► #4768 已合 ──► #4790 D2 已合 ──► 彩排最终跑 17/17 ──► 出包冻结 ──► 实体机窗口(已授权排期)
   ✅              ✅                  ✅                        ✅           自动      合并后立即
                                                                            │
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
| #4787 窗口自检下界 + 文档状态清扫 | **sonnet 5** 执行 / **opus 5** 裁决升级项 | 形状定死的机械活;它把祖先下界标为「需要决策」拒绝猜测,由 opus 核实后落定 |
| 本文 §6/§7 成文 | **fable 5** | 骨架(条目/依赖/风险四条)由 opus 定死,fable 只成文;它另报了四条文档内不一致,未自行修 |
| 彩排跑绿后的验收 MD 回填 | **fable 5** | **已派并完成**(#4788):形状与全部数字由 opus 前置给定 |
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
| 候选包 serviceRuntimeSha | `e1b91594e` —— ⚠️ **该钉已作废**,早于 #4769 的安全门;出包下界见 §7.1(#4787 已上移到 `e6523c949`) |
| `rehearsal-driver-contract.test.mjs` | ✅ 10/10。**勘误**:此前写「plugin-tests.yml 门控」是错的——它跑在 `k3wise-offline-poc` job,而该 check **不在 9 条 required 里**,红了不挡合。现已同时挂进 required 的 `test` job |
| `rehearsal-harness.test.mjs` | ✅ 5/5,同一 CI step |
| 彩排端到端(真实部署包) | ✅ **已跑两次**:最终跑 `31103021849` @ `aa48c3f18`,17/17 |
| 实体机先读后写 | ⏳ **已授权排期**(`AUTHORIZED_TO_SCHEDULE_WITH_FROZEN_AA48_PACKAGE`),未执行 |

**诚实项**:契约测试是**源码文本断言**,按 owner 的原话「不能证明真实记录成功写入」。
真正证明写入的是 dry-run/apply 的行为断言(§2.2),以及彩排 dispatch。
两者不可互相顶替。

---

## 5-bis. 一次性回填(2026-08-06 收束)

本文前面各节写于彩排之前。以下是**实测终态**,与前文冲突处以本节为准。

| 项 | 终态 |
|---|---|
| #4784 C6 凭据访问器 | MERGED `e6523c949` |
| #4768 彩排 lane | MERGED `9a061909c`,四轮门审 |
| **#4790 D2 窄修复** | **MERGED `aa48c3f18`,五轮门审、末轮无 P1** |
| 彩排首跑 | run `31084631813`,17/17 |
| **彩排二跑(D2 门活着)** | **run `31103021849`,17/17,数字与首跑逐项一致** |
| **批准包身份(已冻结)** | `serviceRuntimeSha=aa48c3f187685b6f37aceed8cec1c5bcccc8b9a7`<br>`tgz=93aa75c9…`  `zip=d66392d9…`  出包 run `31103351286` |
| #4787 | **已合** `8247cbf55` |
| #4788 | 已推,**owner HOLD 中**(P1 已修:runbook 缺 `pairedReadSystemId` 与 D2 认证身份要求) |
| #4789 | **已记录裁决后关闭为 superseded** |

**二跑的增量不在数字,在前提。** 首跑时 D2 那道门还是「origin 相等」,且在 offline PoC 里
**结构性缺席**;二跑时它 fail-closed、覆盖三种认证模式、且门缺失本身即拒。**同样的绿,证明力不同。**

### 这一轮真正的教训(比任何单个修复重要)

D2 一刀经**五轮门审、十七条 P1/P2、零条自测发现**;其中一条回归**由我在修复过程中亲手引入**
(sessionId 守卫写成 adapter 的严格超集,使 `0`/`false` 这类输入比修之前更不安全);
另有**五个连续的守卫被判无判别力**,最后一个是我自己的 CI 监视脚本 ——
它在出错时走了一条**看起来像结论的默认分支**。

⇒ **fail-open 的形态不挑地方**:生产代码、测试守卫、运维脚本里长得一模一样。
⇒ **「整链绿」不构成放行理由,独立判定才是。**

### 仍未闭合(不因上述进展而改变)

- **实体机「先读后写」未执行** —— 三层是 `mock ≠ rehearsal ≠ customer live`,今天到第二层。
- **源选型已裁**:当前客户源 = **已批准的 SQL Server source**;`plm:yuantus-wrapper` 留作
  未来 profile、尚无 E2E 证据,**不是当前阻塞**(`ownerYuantusDecision=DEFERRED_FUTURE_PROFILE_NOT_CURRENT_BLOCKER`)。
  彩排跑的是 staging 替身,只证明**写生命周期**。
- **~~D2 天花板~~ 归类错误,已更正**:「读记录不在 C6 数据路径上」**不是 D2 的缺口**,
  而是另一条责任线 —— 数据血缘由 pipeline/source binding、dry-run token 与实体机运行证据负责。
  owner 裁:接受职责分离,不做 DISSOLVE。

---

## 6. 工作分解与依赖序

把 §3 的时间线摊成逐项的依赖表,归属与状态逐项标明,不合并、不美化:

| 项 | 依赖 | 归属 | 状态 |
|---|---|---|---|
| #4784 C6 凭据访问器修复 | — | 我方 | 已 MERGED `e6523c949` |
| #4768 彩排 lane(含 B4 D1 闭合、迁移名单精确校验、谓词守卫 v3) | #4784 | 我方 | **已合 `9a061909c`**,四轮门审末轮无 P1 无 P2 |
| #4787 窗口自检(改钉**批准包精确身份**)+ 文档状态清扫 | — | 我方 | **已合 `8247cbf55`** |
| #4785 剩余交付计划与模型分配 | — | owner 拍板可否合 | 绿,等 owner |
| 彩排 dispatch | #4768 合并 | 我方触发 | **已跑两次,均 17/17**;最终跑 `31103021849` @ `aa48c3f18`(12:48:48Z→12:51:44Z) |
| 验收 MD 实测值回填 | 彩排跑绿 | 我方 | 阻塞于上一项,无实测值 |
| 实体机窗口「先读后写」 | — | **owner** | **已授权排期**(`ownerEntityWindowDecision=AUTHORIZED_TO_SCHEDULE_WITH_FROZEN_AA48_PACKAGE`);冻结包 runtime `aa48c3f18…` / tgz `93aa75c9…` / zip `d66392d9…` |
| B4 D2 判据 | — | — | **已裁(20260806)**:`ACCEPT_SEPARATION_NO_DISSOLVE`;窄修复已合 `aa48c3f18` |
| GIP `sealed_snapshot` / runtime 接线 | owner 放行 | **owner** | 在 HOLD 名单上 |

依赖只有一条主干:#4784(已合)→ #4768 → 合并 → 彩排 dispatch → 彩排跑绿。
#4787 与 #4785 在主干旁各自独立,不阻塞也不被阻塞。

**我方侧的全部工作沿这条主干收敛到「彩排跑绿」为止。** 跑绿之后我方剩下的只有验收 MD
实测值回填,而它除了「彩排跑绿」本身没有任何新依赖。跨过这个点,表里剩下的每一项 ——
实体机窗口、B4 D2 判据、GIP HOLD 名单 —— 都以 **owner 的裁决或 owner 排定的窗口**为前置,
没有一项存在我方可单方面推进的路径。这不是进度陈述,是关键路径位置的陈述:
从「彩排跑绿」起,关键路径整体在 owner 侧。

---

## 7. 风险与其对应动作

### 7.1 出包下界会继续过期

**现象**:窗口自检钉的 SHA 已经失效过两次 —— 原钉 `e1b91594e` 早于 #4769 的安全门,
`65edb98c6` 早于 #4784。

**为什么会发生**:下界钉的是一个时点,而 K3 写路径还在被修 ——
**每次有影响 K3 写路径的修复合入,当前钉的 SHA 就失效一次。** 已发生的两次不是两个孤立事故,
是同一结构在重复。

**已做的对应**:#4787 把下界上移,并在 runbook 里写明**它会继续上移** ——
照抄历史 SHA 与当初照抄 `e1b91594e` 是同一个错误。

### 7.2 窗口不可重试

**现象**:现场只有一次机会,窗口内没有第二次执行。

**为什么会发生**:这是实体机窗口本身的性质。后果是「跑一次看看」不是可用策略 ——
凡是本可以现场试错发现的问题,都必须换成离线阶段的预检。

**已做的对应**:29 个 agent 的离线 dispatch 预检,结果 0 P1 / 1 P2 / 4 P3,**全部已修**;
叠加四轮独立门审。

### 7.3 守卫的声明比它的判据强

**现象**:同一个谓词守卫上出现过三次:v1 黑名单、v2 子串 + 计数、v3 只覆盖跨度 ——
每一版的注释都比判据多说了一点。

**为什么会发生**:注释写的是守卫想挡的类别,判据实现的只是当下这一版实际覆盖的子集;
这个差额不报错、不掉测试,只会被下一轮审读出来 —— 与 §4 的观察一致:
本线独立审的多数发现正是「过强声明」。

**已做的对应**:每一次都撤回并收窄声明;并且把「未覆盖面」写进注释本身,
而不是留给读者推断。

### 7.4 B4 D2 —— 已按 owner 裁决定形为「职责分离」(本节以下为裁决前的分析,保留作历史)

**现象**:D2(即便真比了两行,证明力仍弱)没有关,手头材料也关不掉它。

**为什么会发生**:三层天花板逐级下压 —— 比较两条记录只证明
**两个操作员敲进去的 baseUrl 共享 origin**;全仓扫 K3 自报身份端点**零命中**,
「问两边你是谁」没有可站立的面;更根本的是,**被认证的读记录不在 C6 的数据路径上**,
即便有完美的记录等同证明,也覆盖不到真正被写入的行(§2.3)。

**已做的对应**:拆成 D1 / D2 分别裁决 —— D1 已关(§2.3),
D2 明确标为**已知限制**并留在验收结论里,不并入任何「已关」的声明。
