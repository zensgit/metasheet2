# 多维表 Cross-base 治理墙 + 能力弧 — 收官验证 — 2026-06-14

> Status: **ARC CLOSEOUT(收官,已验证组合无缝)** · 总目标 `multitable-benchmark-surpass-goal`(对标并超越多维表格)。
> 自有原则:本文只陈述 MetaSheet 自身的治理不变量,不引用任何外部产品。
> 范围:跨 base 从"后端今天已半可达且零治理"的安全债,收口为"显式、受治理、读写两侧 fail-closed"的能力。10 个 PR,每刀独立对抗审查;本文是**组合层**(全部合并后是否无缝)的收官验证。

## 0. 一句话

跨 base **链接(读)+ 自动化(写)** 现已完整、受治理、读写两侧全程 fail-closed,且在最终合并 main 上**组合无缝**(215/215 组合测试绿,5 条跨层不变量由"一个场景同时跑两道门"的组合测试钉死,结构守卫按构造拦截)。这是"超越"的核心差异化项的地基与能力。

## 1. 弧内 PR(全部合并 main,最新在前)

| 层 | PR | squash | 交付 |
|---|---|---|---|
| ②b 写 | #2585 | `c1877dd16` | 受治理跨 base 自动化写 + 收口 §1.3 既存裸写洞 |
| ②b 写设计 | #2584 | `42ccde506` | 自动化切片设计锁定 + slice-1 doc 校正(N1/N3) |
| ②b 读 | #2582 | `252d44fdf` | `foreignBaseId` opt-in 跨 base 链接 + base-read 门 |
| ②b 读设计 | #2579 | `c08c0f0cc` | 能力设计锁定刷新(post-wall) |
| §2a.4 | #2576 | `dea80c298` | sheet-create TOCTOU 收口(`createSeededSheet` 卡点)+ 悬挂链接 sweep;base-delete 证实不可达 |
| ②a 墙 | #2574 | `78f7d2acd` | 拒绝静默跨 base 链接配置 + base 权限原语 |
| n2 守卫 | #2575 | `38d4125e7` | 锁/越权/taint 守卫泛化为 whole-`src` 扫描 |
| rank-8 锁 | #2554 | `…` | 记录锁(全 mutation 路径) |
| §2a.3 掩码 | #2549 | `fb8f316f` | 外表字段级越权掩码(全读 sink) |

## 2. 分层架构与卡点(每层一个 chokepoint,组合时各管各层、AND 叠加)

- **字段级读掩码(§2a.3)** — `resolveForeignFieldReadability`(univer-meta.ts)是唯一外表可读性原语 → `maskStoredRecordFieldIds` 扇出全读 sink。
- **记录锁(rank-8)** — `ensureRecordNotLocked` 在每个 mutation 站点;跨 base 写时锁检查**重定向到 target 记录**。
- **结构守卫(n2)** — whole-`src` 扫描:锁-mutation 枚举(每个 UPDATE/DELETE `meta_records` 须带处置标记)、egress-coverage GOLDEN(新 egress 须先有真库 locking test)、taint-chokepoint、raw-projection。**按构造拦截,非抑制**。
- **链接墙(②a)** — `validateLinkFieldConfig` 在字段定义卡点拒绝静默跨 base;base 权限原语 `resolveBaseReadable`。
- **sheet-create TOCTOU(§2a.4)** — `createSeededSheet` 单卡点(覆盖两个创建 caller),挡"建链接指向未来 sheet → 在他 base 建该 sheet"的延迟绑定。
- **base-read 门(②b 读)** — `foreignBaseId` opt-in(claimed===actual 一致性);Sink A(`resolveForeignFieldReadability` 内)+ Sink B(`buildLinkSummaries` 静默掩 / `link-options` 403)。base 门只**清空不放宽**,字段掩码仍叠加。
- **base-write 门(②b 写)** — `evaluateCrossBaseWrite` + `resolveBaseWritable`(吃 userId,执行器无 req);**触发者权威**(零 confused-deputy,null-actor fail-closed);claim==truth;同 sheet 写定义上同 base 走 fast-path 不查库。

## 3. 验证结果(合并 main `c1877dd16`,真库)

**组合套件:27 文件 / 215 测试 → 215 passed / 0 skipped / 0 failed**(集成 20 文件 194 在单次串行真库 vitest 调用内跑完,可暴露共享设置串扰;结构+单元守卫 7 文件 21)。**零 skip 承重**:每个 `describeIfDatabase` 激活(DATABASE_URL 在 + 迁移 165/0)、每库文件带 `sentinel: DATABASE_URL set` 断言(失败而非跳过)→ 真跑非空绿。

**5 条跨层不变量 — 全部由"一个场景同时跑两道门"的组合测试覆盖且绿**(组合的真证据,非两个孤立测试):
1. base-read 通过 + 字段被拒 → **字段掩码仍掩**(XB-2b:OK 字段可见、DEN 字段空)。
2. base-read 被拒 → 全外表掩(Sink A 空)+ link-options 403(Sink B)(XB-2)。
3. 跨 base 写 + target 记录**被锁** → 即便有 base-write 也挡(XW-2c:锁检查重定向 target,锁优先)。
4. 跨 base 写 + 无 target-base-write → 挡、不写(XW-1b/2b:触发者 fail-closed,**不用规则属主权威**)。
5. §1.3 裸跨 base 创建 → 现须 opt-in + base-write(XW-1/1b/1c 收口)。

**结构守卫按构造拦截**:锁守卫遍历整 `src`、强制每个 `meta_records` 写站点带处置标记(弧内新写站点已正确标记);egress GOLDEN 强制新 egress 先有真库 locking test。无 allowlist 藏漏。

## 4. 纪律证据

- **多 sink 教训贯穿**:每刀对抗审查均抓出真 BLOCKER(掩码 5 轮收敛、锁 advisory-only-on-3-paths、墙 type-conversion 绕过、§2a.4 第二个 seed sink、写 NIT-1 软删 base zombie + CI 回归的 mock-fidelity)——全部修复 + fail-first canary 钉死后合并。
- **fail-closed 优先**:写侧承重决策(谁的权限)取最保守 = 触发者权威(零 confused-deputy)。
- **gating-by-construction > 一次性审查**:n2 把人工逐 sink 战果转为 whole-`src` 结构守卫,新漏自动 RED。

## 5. 已延后(各为独立 gated opt-in,经验证均未半做)

| 项 | 状态 | 备注 |
|---|---|---|
| 跨 base 写 **配额/限流** | 缺席 | 点名滥用向量 Base-A-thrashes-Base-B;写门开放后**第一**个运维护栏。当前安全(触发者权威 + per-action opt-in),配额前应视跨 base 写规则为受信任配置 |
| **前端** picker/switcher | 缺席 | 能力今为后端-only;FE 是把它变成用户可触达价值的那一步 |
| Yjs 跨 base fan-out | 缺席 | 实时层失效信号扇出到 target base 房间 |
| 跨 base delete / lock | 缺席 | delete 无 sink;lock 是改锁列非数据、引入"锁他人 base 记录"新治理面 |
| 细粒度 `multitable:base:write` 码 | coarse-by-design | 现 == `:base:admin`(注释点名细分为未来 opt-in) |
| **读侧 `resolveBaseReadable` 对称修补**(收官新发现) | 待 | permission-service.ts:1261-1262 在 `deleted_at` 存在性 SELECT 之前对 admin/base-read 授权短路返回 true,与写侧 NIT-1(先查存在)不对称、违自身 docstring。**非漏**(仅 read-any-base 权威受影响、软删是生命周期态非权限边界、读无完整性危害、运行期不可达);可选对称 retrofit |
| **跨 base 写结构守卫**(收官前瞻) | 待 | 现无结构守卫枚举跨 base 写站点;未来若有写路径跳过 `evaluateCrossBaseWrite` 只靠 XW-* 测试拦、不会结构 RED。当前弧内每条写路径均已 gated。建议:仿 n2 锁守卫给写门加 whole-`src` 枚举守卫 |

## 6. 总目标状态

对标并超越:跨部门工作流的核心地基(受治理跨 base 读 + 写)**已收官**。能力今为后端-only;运维护栏(配额)与用户可触达(FE)是后续各自 gated 的刀。本弧机制(滚动审计 → 阶梯 → staged-arc + 每刀对抗审查 + fail-closed + gating-by-construction)已验证有效。**CHECKPOINT:弧收官,建议 consolidation;下一刀各为显式 opt-in,不自动接续。**
