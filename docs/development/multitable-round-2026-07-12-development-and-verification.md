# 多维表线 · 本轮开发与验证记录(2026-07-12)

**类型**:开发与验证记录(docs-only,零 runtime)。
**触发**:owner /goal(两条,连续)——①「接着开发,可并行,你来排顺序」;②「审阅多维表开发代码及目标文档,还有哪些未开发」。
**基线**:`origin/main`。**所有断言均对已落地代码核验**,不信文档头部;头部与代码冲突时**以代码为准并记为发现**。

---

## §1 本轮落地(按落地序)

| PR | SHA | 内容 | 门禁 |
|---|---|---|---|
| **#4172** | `6543efbe9` | person 名称解析 design-lock **RATIFIED**(记录 owner 三条裁决:OD-P1=A · OD-P2=carry inactive **and render** · OD-P3=no flag;并承认 `fieldTypes` companion payload 的 scope) | docs-only |
| **#4175** | `087ffa47a` | **T5/MetaRecordDrawer 决策 brief(停点)** —— 见 §3 | docs-only |
| **#4161** | `b674dba8c` | person before-side 名称解析 runtime + **「禁止编造值」修复**(见 §2.1) | Opus 独立门禁:1 轮 BLOCK → 修 → 复审 MERGE_CLEAN |
| **#4184** | `8961fefb9` | T1345 验证 MD **T2 勘误**(我自己的文档 stale,见 §4.1) | docs-only |
| **#4185** | `d52d7ba59` | **剩余开发总盘 + 排序**(3 车道只读审计的产出) | docs-only |
| **#4178 / #4180** | — | UI-P2-1c **T1** close-× → MtIconButton(8 个组件) | Opus 独立门禁:双双 MERGE_CLEAN |
| **#4188** | — | **接线 6 个从未执行过的真库 spec(67 测)** —— 见 §2.2 | 主循环亲验(§2.2 有实证) |
| **#4187** | — | **D-1c 表单提交 EDIT 不写 revision** design-lock(**PROPOSED**,零 runtime) —— 见 §3 | gate-front,**不实现** |
| **#4191** | — | 修 main 上 3 个红 spec + 接线 | 门禁进行中 |

**之前 D-2 那条(同日早些)**:#4004 锁由 **owner 亲自 ratify**,runtime **#4168** `db2eb8a57` 落地;#4170 `7fee43790` 修掉一个跨 PR 红人的 `send_status` race。

---

## §2 两个真缺陷(都不是「新功能」,都是**已上线的东西是错的**)

### 2.1 历史 diff 在**编造值**(#4161,门禁 BLOCK 抓出)

`fieldForDiff` 从**掩码后的** `fieldTypes`/`fieldNames` 图合成字段——但那两张图只有 **id→名 / id→类型**,**没有 `property`**。于是 `formatFieldDisplay` 里每个依赖 property 的分支**静默取默认值,把值编出来**:

| 字段 | 真值 | 渲染成 |
|---|---|---|
| `currency`(`property.code='USD'`)| `1000` | **`¥1,000.00`** ← 美元字段盖了人民币符号 |
| `rating`(`property.max=10`)| `8` | **`★★★★★`** ← 读作满分,实为 8/10 |

`props.fields` 只含**当前表** ⇒ **每一条跨表行都走这条路**。

**为什么这是 P2 而不是 nit**:历史是**审计面**。读的人**没有任何线索**能看出 `¥1,000.00` 是假的——它比 raw JSON **更可信、也更错**。

**修法**:把跨表回退**收窄到 `person`**——锁 §0.1 唯一授权 `fieldTypes` 去做的类型(*fieldNames 修标签,fieldTypes 修值*——for person)。其余类型回落原始值。**这同时把 PR 收回锁授予的范围内**,而不是扩大它。

**突变实证**(不是断言):删掉那一行守卫 ⇒ **恰好红 2 个**(26 中),报错逐字为 `expected '¥1,000.00' to contain '1000'` 与 `expected '★★★★★' to contain '8'`;被授权的跨表 person 金测与其余 23 个**全绿**。

**门禁比我更狠的一点**:它枚举了 `formatFieldDisplay` **每一个**依赖 property 的分支(currency/rating/dateTime/number/percent/duration/autoNumber/link),确认全部已不可达;并指出这是**白名单 = fail-closed 形状**——**明天平台新增字段类型会自动落 raw,而不必等人记得去拉黑**。

> **自审为什么打不中它**:该 PR **自带的 self-review 写的是 APPROVE**——因为它只渲染过跨表 **person**,而 person 恰是**唯一 property-independent、唯一不出这个 bug** 的类型。**只测自己实现的那条路 = 系统性看不见相邻类型的塌陷面。**

### 2.2 CI 在谎报绿(#4188)

`plugin-tests.yml` 跑**两次** vitest:无-DB 步骤,与真库步骤(Postgres 到后者才起)。**6 个 DB-gated spec 既不在无-DB job 的 exclude 里、也不在真库步骤的文件表里** ⇒ 被无-DB job 收集 → `describeIfDatabase` 看不到 `DATABASE_URL` → 走 skip 分支 → **在必需的 `test (20.x)` 里报绿,零断言**。**67 个测试,从未执行过一次。**

**skip-green 实证**(main 的配置,无 `DATABASE_URL` —— 正是无-DB job 今天的行为):
```
↓ multitable-crossbase-realtime-fanout.test.ts  (6 tests | 6 skipped)
↓ multitable-record-duplicate.test.ts           (8 tests | 8 skipped)
  Test Files  2 skipped (2) / Tests  14 skipped (14)
  exit code: 0          ← 绿。零断言。
```

**真库实证**(隔离 Postgres,CI 的 **exact** `MIGRATION_EXCLUDE`):
```
Test Files  6 passed (6) / Tests  67 passed (67)
```

**两点接线,两端都验**:`vitest.config.ts` exclude ⇒ 无-DB job **再也收集不到**它们(复跑:`No test files found`);`plugin-tests.yml` 真库步骤 ⇒ 它们**真的执行**。
**零 spec 被修改**——它们**一直是对的,只是从没被跑过**。

---

## §3 两个「推到闸门前就停」的(**零 runtime**)

### 3.1 T5 · MetaRecordDrawer(#4175)—— 锁自己写着「待 owner 定」

锁 §3 明写 T5「**待 owner 定 toggle/emoji 处理**」。T5 的第一个 manager(MetaApiTokenManager,#4143)能直接落,是因为核实后它**没有** stateful toggle。MetaRecordDrawer **三样都有**。两个**实现无权拍**的硬点:

1. comment 按钮的 active 态用 `#f59e0b`/`#fff7ed`/`#b45309`,而**唯一**的琥珀 token 是 `--ms-color-warning: #d97706`——**三个都不等于它**。⇒「只用 token、不新增 hex」与「保住观感」**直接冲突**,必有一个让步。**这是设计取舍,不是实现细节。**
2. comment 按钮**根本不是 T5 意义上的 shared-class sharer**——它属于一个**跨 9 组件、约 12 处调用**的 comment-affordance 系统。单独把 drawer 这处迁进 MtButton = **把那个系统劈开**。

**如实记录**:锁里「全 sharer 一次迁」这句**对本 manager 不成立**——那个「整齐」是把两个真决策揉进一次机械迁移换来的。

### 3.2 D-1c · 表单提交 EDIT 不写 revision(#4187)—— **本轮最重**

**已实测执行的链条**(真 Postgres,走**真实路由**,非手搓 SQL;**带正控腿**:同表正常 `PATCH` ⇒ revisions `[create v1, update v2]`、重建返回 `ctrl-v2` ✅):

1. 成员经表单编辑 ⇒ 活行 `v2-edited-via-form`@**v2**,而 revisions **只有** `[create v1]`;
2. `reconstructRecordsAtT` 返回 **v1**(编辑前);
3. 运维在编辑**之后**的时点做 sheet revert-preview(**本该 no-op**)⇒ 它**提议**回滚这条编辑;
4. **revert-execute 真的执行了**;
5. 成员那个值现在在 **0 条** revision 里(`snapshot` + `patch` 全扫,零命中)⇒ **不可恢复。**

**真正的发现是:这是一整类,8 个点。** D-1 当年只补了 side-door 的**删除**那一半 ⇒ 今天 **automation 创建的记录没有出生 revision,但一旦被 automation 删除,D-1 会尽职地给一条「从未出生的记录」写死亡 revision**。其中 **plugin-SDK `patchRecord` 也已实测复现**;其余 6 个**源码核实、未实测**,文中逐条标明。

**为什么不自主实现**:它落在 D-1 锁 **§5 显式推迟**的子系统里(推迟的是 public-form 的 **CREATE** = 「历史缺个**头**」;而 **EDIT** 这一半**任何文档都没提过** = 「历史链**中间有洞**,且历史在**撒谎**」)。擅自动手 = 越过 owner 刻意留下的闸门。⇒ **PROPOSED,六个 OD 全留给 owner。**

---

## §4 我在本轮犯的错(如实,含纠正)

### 4.1 我自己的文档 stale,而且是**半截 fix-forward**(#4184 修)
T1345 验证 MD 的 §1/§6/§7 仍写着 T2「🔒 HOLD / MtButton 现无对应变体」,而 main 上 `MtButton.vue:36` 早就有 `plain`、三个视图各迁了 4/3/5 处。**更糟的是**:同一份文档的 §3 已经引用了「#4156 已落 main」——**一份文档自己跟自己矛盾**。
⇒ **fix-forward 必须全文搜旧表述,不能只改你来时的那一段。** 读者先撞上 §6 就会以为 T2 还卡着、T1/T5 剩余批次得等它——**而它们不必**。

### 4.2 我把**别人的 PR** 当成自己车道的,连错两次
单维护者仓 ⇒ **所有 PR 的 author 都是 `zensgit`** ⇒ **author 根本不能用来判断归属**。唯一可靠判据是**分支名**。我据此:
- **关了 #4177**(别人的),理由写成「我的车道重复了」——**前提是错的** ⇒ 已**重开 + 公开更正**;
- 给 **#4174**(别人的,**且从未过门禁**,还坐在破坏性 restore 面上)**arm 了 auto-merge** ⇒ 已**撤销 + 说明**;
- 还给自己的车道发了一条基于错误归因的纠偏 —— **代理顶了回来,它是对的,我是错的**。

**教训**:**arm 之前必须两问 —— ① 是我的吗?② 过门禁了吗?** #4174 两个都是 no。
**做对的一方是我的 lane A**:它开工第一步就做 collision check,**主动让出**了 RestorePreview/RestoreBatch,救掉一次同 hunk 冲突。

---

## §5 本文不主张什么

- **不主张多维表线「开发完了」。** #4185 的总盘里:**8 项已授权工作一项未动**;**7 个 owner 决策点全开着**;**164 个 raw `<button>` 未分诊**;7 个隔离的 workbench spec(92 个失败测试里的 84 个)**有记录但没解决**;**159 个多维表 web spec 仍跑在零个 workflow**(#4191 只修了其中 3 个红的)。
- **#4188 不主张「CI 现在诚实了」**——它只主张**那 6 个**现在真的在跑。另有 13 个非多维表 DB-gated spec 以同样方式 skip-green,**未处理**。
- 不主张 #4187 / #4175 里任何一个「(荐)」已被采纳——**全部待 owner 拍板**。
- 不主张任何 flag 被打开或应被打开;生产启用是独立的 O-2 运维阶梯。
- **不主张文档头部可信。** 本轮恰恰证明了反面:**零个虚假的「已完成」声明,但一批文档在少报已上线的东西**——包括**我自己写的那份**。
