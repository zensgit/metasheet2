# 多维表 Time Machine — 阶梯与日历日突破:开发与验证记录(2026-08-21)

> 目标:把启用阶梯的日历地板从 11 天压到 9 天,**用更强的证据替代更弱的等待,不删任何检查**。
> 安全边界不变:本轮零 flag 翻转、零 trigger 启用、零主机触碰;所有压缩生效都以 owner ratify 为前提。

## 0. 问题:被动窗口测不到它声称要测的东西

阶梯日历硬约束 = L1(staging)≥2 天 + L6 soak ≥7 天 + 生产 L1 ≥2 天(同判据继承)= 11 天。
其中 L1 的 2 天在 flags 全 OFF 时**结构性空转**:无人持租约 ⇒ 触发器永不冲突 ⇒
「40001 发生率」被构造性地测为零。等 2 天与等 0 天获得的判别信息相同。

## 1. 方案:三件开发 + 一件明确不做

| 件 | 内容 | 模型 | 载体 |
|---|---|---|---|
| D1+D2 | L1 演练电池 + owner-gated staging workflow | Opus/Sonnet | #5045 `4bacc27ccc` |
| D3 | 修正案 A1(PROPOSED:L1 ≥2天 → ≥1天+电池PASS;L6 明确不动) | 主循环 | #5042 |
| D4 | 电池对抗门审(refute-first,四轮) | Opus 门 | 见 §3 |
| 不做 | 压缩 L6 的 7 天 | — | 一个完整周周期的日历节律,合成负载伪造不了 |

## 2. 电池为什么是承重证据

**被动窗口的结构性空转**:flags 全 OFF ⇒ 无人持租约 ⇒ 触发器永不冲突 ⇒「40001 发生率」被构造性测为零。
电池主动构造判别条件,并在**三个层面**上防"假 PASS":

1. **逐面三重断言**:持独占租约时 = 具名 409(`RECOVERY_AUTHORITY_BUSY`),零 unmapped 500,
   **零 2xx**(持锁下 2xx = 触发器未触发,比 500 更糟——它会静默作废 L1 本身);释锁后 = 同写面 2xx
   且**行状态核实**(不只看状态码)。
2. **逐面持锁/放锁 + 错类租约对照(phase 3b)**:role 租约不拦 user 键写面、反之亦然——
   证明 trigger→lease-function **映射**才是机制,防"任何 409 都算数"。
3. **两条独立反漂移轴**:census 轴(36 个未驱动站点逐个点名原因,无静默上限;新增 census 站点
   而电池未列 ⇒ hermetic 守卫红)+ **触发器覆盖轴**(6/9 覆盖态打印在 verdict;census 轴结构性
   看不见 field/record_permissions,故需第二轴)。

**驱动面**:11 面/12 census 站点,覆盖 user_permissions(×3)/spreadsheet_permissions(×2)/
user_roles(×3)/users-update/platform_member_group_members/role_permissions。
**未驱动 36 站点四类原因**:外部 provider 依赖(26)/请求内随机 UUID 致租约键不可预持(4,注册在此)/
同表同键已被驱动面代表(4)/目标表无触发器(2)。
**roles:delete 自过期豁免**:路由注释声称 FK 级联可冒 40001,实际全新库 `role_permissions`
无 `role_id→roles` FK(跨线注释缺陷,已记录未越线修)——电池每次运行用见证查询重查 `pg_constraint`,
级联若真出现即 FAIL `not_driven_reason_expired`。

**本地 E2E(实现车道跑 + 我独立全程重跑,双份一致)**:
disarmed → exit 2 NOT_ARMED(逐触发器点名);armed → exit 0:11/11 持锁 409、11/11 释锁 2xx、
2/2 错类对照、14 关系零残留(按戳 AND 按电池 user id 双扫);去 hold 变异 → 0/11 全
`trigger_did_not_fire`;错类租约变异 → 恰 1/11(唯一 role 键面)拦住;disable → 指纹精确回
`8c1be0b0…`。hermetic 守卫 39 测试,实现车道 8/8 变异探针全击杀,已接入 required contract lane。

## 3. 门审记录(四轮,head-scoped,每轮在我宣称"修好了"之后仍找出真东西)

| 轮 | head | 判定 | 新发现 |
|---|---|---|---|
| gate 1 | `556f48016a` | CHANGES-REQUESTED | 1 P1(假 residue-CLEAN:phase-1 经 invite-ledger 写 user_invites,三层扫描全盲,11 跑积 11 行)+ 2 P2 + 5 P3 |
| re-gate 1 | `9820002c14` | APPROVE-with-hardening | 全 10 项闭;3 新:P2-3 我的 P1 用死键 invited_by、P2-4 三修复无守卫、P3-6 早退清理静默 |
| re-gate 2 | `d52c33b89f` | APPROVE-with-hardening | 全 3 项闭;1 新:P3-7 我的 P3-6 守卫是裸子串(注释能骗过)+ 只钉成功路径 |
| re-gate 3 | `c93e8b913b`→`674864563b` | 三命名向量闭;**T2 天花板残留** | 守卫改去注释+双路径后,门审仍用字符串诱饵/可达性破坏 defeat——文本守卫固有天花板 |

**contention 证据本身(A1 真正依赖的那部分)从 gate 1 起扛住全部 20+ 种构造攻击**:逐表触发器神经化(6 表各只杀自己的面,无跨表冒充)、classifier 击杀(0/11,无第二 409 层)、无条件 409 stub(phase 4 正控抓住)、双库欺骗(靠 server-minted-UUID 检查而非 login 检查)、部分武装/REPLICA、15 种 acknowledge fuzz 无绕过、崩溃残留被后盾抓。

**我被门审抓到的每一次(逐条,不给总数)**:①假 residue-CLEAN(P1,我漏了 user_invites);②修复用死键 invited_by(P2-3,存的是 admin 非被建用户);③三修复无守卫(P2-4,回退全绿);④守卫用裸子串注释能骗(P3-7);⑤早退清理静默(P3-6)。**门审自曝方法坑**:首个 classifier-kill 报 PASS 是假象——mutate 后端 EADDRINUSE 死了,电池在跟未 mutate 的 app 说话,靠 lsof/PID+液性探针抓出。

### T2 天花板(与 census linkage 同类,交 owner 处置)
P3-7 的残留 = **文本存在性守卫证不了可达性**,也挡不住同形字符串诱饵。收敛闭合 = finally 早退路径的**行为测试**,需 postgres+已启动后端**同时在**的车道,现无。**行为本身正确且双独立 E2E 验证**;残留是守卫强度非活缺陷。处置权在 owner,平行 census L0。

## 4. 修正案 A1 与治理
- A1 是 PROPOSED 附加节,未 ratify 前原判据生效;ratify 前置 = 电池落 main 且过门审。
- 激进重叠选项(soak 尾 × 生产 L1)记录在 A1.4,**不随 A1 ratify**,owner 另行明示才生效。

## 5. 压缩后的账

**日历地板 11 → 9 天**(A1 ratify 后):L1 ≥2→≥1 天+电池PASS;L6 ≥7 天**不动**;生产 L1 同判据继承。
L2–L5 本无日历约束(判据制)。逐日:D0 开钟(审批 4 迁移+主机 postdeploy,小时级)→ D1 L1+电池 →
D2 L2+L3 → D3 L4/L5 canary → D3–10 soak(七天,唯一大块)→ D10 生产 L1 → D11–12 生产 L2–L5。

### owner 侧(本记录不代为决定)
1. **A1 ratify**:电池已落 main 且过对抗门审(APPROVE-with-hardening,cleared 到文档化 T2 天花板)——
   A1 的 ratify 前置已满足,但 ratify 本身是 owner 裁量。**门审的边界提示**:即便干净电池只观测
   **12/48 census 站点 + 6/9 触发器**(单写者构造式 contention)——更强信号非更广;压窗是"深换广",
   请以 12/48 和 6/9 在视野内裁,非"11/11"。
2. **P3-7 T2 天花板处置**:接受"守卫已挡尽偶发回退、蓄意字符串诱饵/可达性破坏残留"(平行 census L0),
   或要求补 postgres+backend 车道做行为测试(独立小工程)。
3. **激进重叠选项**(A1.4):soak 尾 1–2 天 × 生产 L1,再省 1–2 天,默认不推荐,owner 另行明示才生效。
4. 前置 ops(承接上一线):审批 4 迁移使 staging pending=0、目标主机 postdeploy-full、L1 那一按。
