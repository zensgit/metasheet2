# DingTalk 数据对接线 — 设计与验证 MD（自主执行轮，2026-07-12）

> **执行背景**：owner 不在电脑前，`/goal` = 「这条数据对接还有哪些开发要完成 … 你能帮我自动处理开发任务么」。
> **全程硬保持**：`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` = **OFF**；U1–U13 UAT 与生产启用 **未触碰**；权限层与外部写 **未触碰**。

---

> ## ⚠️ AS-BUILT 更正（owner 复审 2026-07-12）
>
> **本文档最初版本有三处错误，已订正**：状态表把 #4142/#4146 写成「开着」（实际已 MERGED），并把自身 PR 号写成 #4149（实际 #4151）。
>
> **更重要的是：这一轮并未收官。** owner 真库复审在已合入的代码里抓到 **1 个 P1 + 3 个 P2**：
> - **P1 卡状态 TOCTOU**：`expired` 卡仍可完成审批（wrapper 只在事务外查 `card_state`；锁内权威校验既不锁卡片行也不复核状态；acted-claim 在审批提交之后的另一个事务里）。**这是 #4112 号称修掉的同一类 TOCTOU，只是漏在了另一个字段上。**
> - **P2 三个 retention scheduler 共用一把 Redis leader lock key** ⇒ 先启动者当选，**卡片清扫永远是 follower、从不执行**。
> - **P2 `'UTC'` 实际按宿主机本地时区执行**；DST 回拨还会**执行两次**（我上一轮把它写成「已知限制 + lease 兜底」，**lease 兜不住**：两次触发相隔一小时）。
> - **P2 PUT 时区把「显式清空」与「未提供」混为一谈**；读不到旧配置就**猜 UTC**。
>
> 修复见后续 PR。**retention 与 Stream flag 仍保持 OFF。本线未关闭。**

## 0. 结论先说

这条线**已接近结构性穷尽**。真正「还没做、也没有门挡着」的开发只剩两项，都已完成并开 PR。其余全部是 **DONE** 或 **卡在 owner 决策**（UAT / 设计锁批准 / 治理线 / 运维开关）——不是我能替你决定的。

**本轮落地**（全部 CI 绿、真库验证、mutation 钉住）：

| PR | 内容 | 状态 |
|---|---|---|
| #4112 | P1-1 陈旧卡片安全修复（supersede-only 迁移 + 锁内 TOCTOU 守卫 + 真双事务交错 golden） | ✅ MERGED `ec6ac3af5` |
| #4137 | owner 点名的两个非阻断 P3（锁等待探针精确关联 + 三处契约注释） | ✅ MERGED |
| #4116 | P1-2 跨企业代批门（+ 本轮 3 项复审修复） | ✅ MERGED |
| #4118 | P2 线路契约（IM_ROBOT 大小写 + 官方 params.action） | ✅ MERGED |
| #4142 | **新建**：卡片/个人投递台账保留期清扫（DT-HARDEN-08，**默认 OFF**） | ✅ MERGED |
| #4146 | **新建**：目录同步 per-integration 时区（§7.8）+ **修掉一个僵尸任务** | ✅ MERGED |
| #4151 | UAT 文档订正 + 本 MD | ✅ MERGED |

---

## 1. 安全链（#4112 → #4116 → #4118）

### #4112 — P1-1 陈旧卡片（已 MERGED）
owner 三轮真库 REQUEST-CHANGES 后 APPROVE/GO。最终形态：
- **迁移 = supersede-only**：预列卡片**无可证明的原轮次锚点**，所以**绝不推断**——一律 `superseded` fail-closed。（owner 复现过：从「当前唯一活跃席位」推断 epoch，会把旧卡重新授权进新一轮同节点。）
- **权威守卫在锁内**：`dispatchAction` 的实例 `FOR UPDATE` 事务内重新校验 card→round 绑定。wrapper 的读时绑定只是**预读**，不是权威。
- **真双事务交错 golden**：一条连接持锁并推进 N1→N2，同时一张 node1 卡的 dispatch **真的阻塞在锁上**（`pg_stat_activity` 证实，非计时器）→ 409 STALE，零 node2 写入。
- Mutation 钉住：把守卫移到锁外 ⇒ 交错 golden 变红，而顺序版 headline 仍绿（**这正是顺序测试抓不到、交错测试独有的牙齿**）。

### #4116 — P1-2 跨企业代批（落地中）
Opus 真库对抗审阅：**漏洞确实被堵死**——真双企业 userId 碰撞 fixture（同一钉钉 userId：corp A = 攻击者 / corp B = 受理人）+ 17 个攻击向量，全部 fail-closed 零记录；**拆掉回调守卫 ⇒ corp-A 点击者真的代批了 corp-B 的审批**（14 RED）⇒ 守卫是唯一屏障。本轮修 3 项：
- **P2-1（本会阻断 CI）**：回调测试手写的 delivery insert 漏 `entryEpoch`。#4112 严格绑定合入 main 后，其**正控腿**从 `executed` 退化成 `stale`。`merge-tree` 报文本无冲突——**这是只有真库跑得出的语义 break**。
  正解 = 补种真实活席位 epoch。**绝不可把断言改成 `stale`**：那会留下一个「即使跨企业门拒绝所有人也照样绿」的**全 fail-closed 空测**。正控腿存在的意义就是证明门**专门拒绝攻击者**，而不是**拒绝所有人**。
- **P3-1 provenance laundering**：header 缺失时，**body 伪造的 `eventCorpId` 会原样存活**并被下游当作「header 级来源」信任（而 header 的优先级高于 body `corpId`）。改为**无条件 delete、再只从 header 写回** ⇒ body 无法再伪造锚点，header 缺失就诚实地读作缺失（fail-closed）。新增 golden + mutation 钉住。
- **P3-3**：新 env `DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID` 补进 UAT 文档（**未设置 = 互动卡永不投放、全部回落 OA**，这是正确的 fail-closed，但表现为「Stream 开了却收不到卡」，所以现在是排查第一项）。

### 🚧 P3-2 — **开 flag 之前的硬前置（已写进 UAT §0-a）**
`dingtalk-stream@2.1.5` 的类型声明里，`eventCorpId` **只出现在 EVENT 主题**的 header 组——**互动卡 callback 帧很可能根本不带它**。若为真：
1. 跨企业门会**静默退化**为只认 body `corpId`（而非设计所称的「网关保证的权威锚点」）；
2. **若真实 callback body 顶层也没有 `corpId`，则每一次点击都 fail-closed ⇒ 卡片点了没反应（dead-on-arrival）。**

**这一条无法从代码判定，必须抓一帧真实 callback 帧**（worker 侧 values-free 只记「字段是否存在」，**切勿打印 corpId 值**）。现在做是免费的；到 UAT 才发现会很难看。

---

## 2. 本轮新建的开发

### #4142 — 卡片 / 个人投递台账保留期清扫（DT-HARDEN-08）
DT-HARDEN-08 的口径是「redact, index, expire, scope」。group 台账在 #4013 拿到了清扫，**这两张是最后没有过期机制的账本**（代码里**根本没有任何 DELETE**）。

| 表 | 动作 | 理由 |
|---|---|---|
| `dingtalk_person_deliveries` | 有界批量 **DELETE** | 真的存了完整消息 `content` + 原始 `response_body` |
| `dingtalk_approval_card_deliveries` | `sent` → **`expired`**；**永不删除** | `acted_action/by/at` 是「谁用哪张卡做的决定」的唯一证据；`task_id` + 追溯索引必须留给运维 |

- **安全不变式（真库 keystone 钉住）**：一条 `card_state='sent'` + 有效深链 token = **永久可操作**——这个无界可领取窗口正是清扫要关掉的。过期 `UPDATE` 的 `WHERE` 要求 `card_state='sent'`，所以它**只能把行推离 `sent`，结构上不可能把卡复活成可操作状态**。
- **默认 OFF（刻意与 group sweep 相反）**：group sweep 是默认 ON/opt-out；这两张更贴近审批安全边界与原始消息内容，所以**未显式设置 `DINGTALK_DELIVERY_RETENTION_DAYS` 就是彻底 no-op**（无效值也**不**回落默认窗口）。要翻成 opt-out 只是一行极性改动。
- **⚠️ operator 脚枪**：卡片清扫**不问审批是否还 pending**。窗口短于真实审批 SLA ⇒ **活卡会被过期**（决策不丢，退回网页，但一键路径没了）。7 天 MIN 是护栏，**不是建议值**。
- 无迁移（`expired` 本就在 CHECK 约束里）；无新依赖。

### 目录同步 per-integration 时区（roadmap §7.8）
`directory-sync-scheduler.ts` 硬编码 `timezone: 'UTC'`。Asia/Shanghai 的企业把同步 cron 配成 `0 2 * * *`（本意凌晨 2 点）实际会在**本地上午 10 点**跑。改为 per-integration 时区，**默认仍 UTC**（现有集成字节等同），保存时校验 IANA 时区、fail-closed。

---

## 3. 我**没有**动、需要**你**决定的（完整清单）

| 类别 | 项目 | 为什么没动 |
|---|---|---|
| **UAT / 产品门** | Stream flag ON、U1–U13、生产启用；staging smoke | 需真实钉钉企业 + 凭据 + 模板；owner 明确 held |
| **设计锁批准** | #3944 provider org-transfer 计划（Rev 2）、#3941 corp-switch 研究；本地未提交的 local-directory-provider / canonical-org-anchor 计划 | 设计锁需 owner ratify；org-transfer Phase 1+ 实现全部 gated 在此之后 |
| **治理线** | org-scoped RBAC（`user_roles` 无 `org_id` ⇒ `attendance:admin` 无法证明 org 归属）；operator trace API/CLI（#4102 只落了索引+accessor 基础） | owner 2026-07-11 明确裁定为**独立 P1 治理线**，且是「又一个 send-adjacent 授权面」 |
| **需求门** | REC-R1+ 递归多层连接器展开 | 设计锁已成，但门槛条件（≥3 层的具名用例）未满足；核实过：无 issue 提出此需求 |
| **staging 门** | §7.7 `user/list` 作为同步字段主源（性能）；批量 upsert / bcrypt 出事务 | 已埋遥测取前后证据，但翻转本身 staging-gated |
| **仅设计** | §8.3 凭据单一真源；§8.6 目录管理 UI 现代化 | 明确「仅设计不实现」；凭据集中化 = 更高价值目标，须先与字段层权限 + 审计对齐 |
| **纯运维开关** | `DIRECTORY_DEPROVISION_ENABLED`（**一开即在下次同步批量停用**）、`DIRECTORY_PRIMARY_DEPT_FROM_ORDER`、`DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE`、告警 webhook | 这是运维决策不是开发；尤其第一个后果很重 |

---

## 4. 验证方法（真实数字，非推断）

- **真库**：`createdb` → 全量 migrate → `vitest --config vitest.integration.config.ts`。
- **迁移**：**fresh-DB 全量 migrate** 验证（预载 DB 会掩盖迁移 bug——这正是 #4112 R3 踩到的自家陷阱：我在旧代码上 migrate 过，新的 supersede 迁移从未真正执行过）。
- **mutation**：每一条安全守卫都反向验证「拆掉 ⇒ 测试变红」，否则测试没有牙齿。
- **CI**：结论一律读 `gh pr checks` 的**已推送 head**，绝不用本地推断。（R3 教训：我曾把 `pending` 当成 `pass` 上报。）

---

## 5. 三次对抗审阅各自抓到了「读代码抓不到」的东西

这一轮我对每个安全面都跑了独立 Opus 真库对抗审阅。三次都不是走过场：

**#4116（跨企业门）** — 门本身是对的（17 个攻击向量、真双企业 userId 碰撞 fixture，全部 fail-closed 零记录；拆掉守卫 ⇒ corp-A 点击者**真的代批了** corp-B 的审批）。但抓到两件事：
- 回调测试手写的 insert 漏了 `entryEpoch`，严格绑定落 main 后**正控腿从 `executed` 退化成 `stale`**——`merge-tree` 报文本无冲突，**只有真库跑得出来**。
- **陷阱**：最省事的「修法」是把断言改成 `stale`。那会留下一个**全 fail-closed 的空测**：此后即使跨企业门拒绝所有合法点击，测试也永远绿。**正控腿的意义就是证明门「专门拒攻击者」而不是「拒所有人」。**

**#4142（保留期清扫）** — 不变式成立，但**守卫没被测到**：把 `buildSummary` 里唯一的 `card_state === 'sent'` 拿掉，**整个仓库 43/43 全绿**，而被清扫成 `expired` 的卡**重新变得可批**。原因很微妙：系统里其他所有非 `sent` 的卡，其实例也早已推进，于是兄弟条件把这个检查**掩盖**了——**这个清扫是系统里第一个「非 sent 卡 + 实例仍 pending + 席位仍活」的状态**，也就是 `card_state` 第一次单独承重的地方。已补真实产品面 golden（含**正控腿**）+ mutation 钉住。

**#4146（调度器时区）** — 爆炸半径经实测为**零**（无任何生产任务的触发时刻改变）。但抓到一个**真实运维事故**：`armCronTimeout` 跑完后会用**它当初捕获的 job 对象**重新排程，且不检查该 job 是否还注册着 ⇒ **管理员在一次同步执行中把同步关掉，同步会变成僵尸继续调用钉钉，直到进程重启**（`getJob()` 已返回 null，定时器却还活着）。同源问题还会让**时区修改被跑完的旧任务悄悄回滚**。两条 golden + mutation 钉住。

**同时纠正了 PR 自己写下的两条假声明**（假声明比不写更坏）：DST 回拨双触发是**真的**，而「同步 lease 能兜底」是**错的**（两次触发**相隔一小时**，lease 只拦并发）；`'UTC'` 默认仍走**本地** getter ——我的探针当场抓到：在这台 Mac 上，一个标着 `'UTC'` 的 cron 实际上是按**美西时间**判定的。

**教训（已入记忆）**：安全测试只有攻击腿 = 空测；必须留一条「合法请求确实成功」的正控腿，否则守卫坏成「拒绝所有人」也照样绿。

## 6. 我踩到并自曝的一个坑

P3-3 的第一版 golden **失败了**，我没有把它糊过去。查下来：审阅者给的例子 `30 2 8 3 *` @ America/New_York 依赖**当前时钟**——DST 起始日每年在变（三月第二个周日），而 `hasNext()` 从「现在」往后扫一年，这条年度表达式在窗口里只有**一个**候选。真实「现在」是 7 月 ⇒ 下一个 3/8 落在 2027（非 DST 日）⇒ 可达 ⇒ 测试失败。**原则是对的（同一条 cron 在不同时区可达性相反），例子需要钉住时钟。**已用 `vi.setSystemTime` 钉死，并把注释里那句过度断言改成实测口径。

宁可发现这个，也不要一个「因为错误原因而通过」的测试。
