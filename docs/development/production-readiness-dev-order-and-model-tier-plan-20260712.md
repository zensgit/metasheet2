# 生产就绪 · 开发顺序 + 模型分级 + 验证计划（2026-07-12，Rev 2）

> **性质**：规划与验证设计文档，回答 owner「规划开发顺序、按难度分派 fable5/sonnet5/opus4.8、可并行、给设计及验证 MD」。
> **不主张任何东西已完成、已 ratify、或可上生产。** 每条 runtime 车道仍受 owner-ratify / 私有安全 / 运维-UAT 门约束。**本文不实现任何被门约束的东西。**
> **披露纪律（Rev 2 修正）**：仓库 PUBLIC。**私有安全车道（S-0 / S-1 / M3）在本公开文档中只保留不透明车道号、依赖与 owner/disclosure 门；其目标域、缺失控制、评审/CI/披露 具体状态一律移入私有材料，不在此。**

---

## 1. 车道清单（经核实的现状）

| 车道 | 现状（核实） | 门 | 难度 | 模型 |
|---|---|---|---|---|
| **M0-合并** | ✅ 全落 main：#4171(§0-a)/#4098(测试稳定)/#4174/#4182/#4189，每个 merge-commit 经 `git merge-base --is-ancestor` 证在 main | 无 | — | fable5 |
| **M0-merge-queue** | ❌ 未启用（GraphQL `mergeQueue(main)=null`；无 ruleset；6 required check + enforce_admins）| owner-config（仓级，勿在平行 session 落地时翻）| 人工 | owner 点击 / fable5 复核 |
| **S-0（私有安全落地）** | 私有 · 状态见私有材料 | owner-ratify + disclosure | high | opus4.8 |
| **S-1（私有安全加固）** | 私有 · 依赖 S-0 · 细节见私有材料 | disclosure + 依赖 S-0 | high | opus4.8 |
| **M3-审计底座** | 私有 · 部分依赖 S-0 · 细节见私有材料 | disclosure + owner-ratify | high | opus4.8 / sonnet5（视站点） |
| **#4196 retry 治理** | PR #4196 OPEN/PROPOSED，docs-only；按动作分类；**Class-A 同事务 ledger 底座 = FWB + M4A runtime 的前置** | owner-ratify | high | **opus4.8** |
| **#4195 附件四阶梯** | PR #4195 OPEN/PROPOSED，docs-only；S3 骨架已死代码删除故需新建对象存储 provider；3 开放 Q(O1/O2/O3) | owner-ratify + O3 涉运维 | medium | sonnet5 impl / **opus4.8** 鉴权代理下载审 |
| **FWB #4203** | PR #4203 OPEN/PROPOSED，docs-only，5 开放 Q(Q1–Q5)；混合架构+受约束 `write_approval_form_values` 动作 | owner-ratify + 依赖 #4196 substrate | very-high | fable5(锁done)/sonnet5(FWB-1/2)/**opus4.8**(FWB-3 greenfield) |
| **R13-A #4204** | PR #4204 OPEN/PROPOSED，docs-only；umbrella over #4187；31 reachable-mutation-path 分母；双层守卫；6 开放 Q(A1–A6) | owner-ratify（与 #4187 联批）| high | **opus4.8**(守卫)/sonnet5(逐站迁移) |
| **R13-B #4205** | PR #4205 OPEN/PROPOSED，docs-only；核实**缺口=读面过滤器非缺原语**（`reconstructRecordsAtT` 已存在且正确）；7 开放 Q(B1–B7) | owner-ratify | high | **opus4.8**(B1/B3/B4/B5 权限+幂等)/sonnet5(FE) |
| **R13-C 运维规模** | ❌ 未起草（核实无 PR/issue/doc）；retention+Reset 共存 / >5000 异步；依赖 #4204/#4205/#4199 联动 | 需先起设计锁→owner-ratify→owner-config | high | **opus4.8**(设计+reset-txn)/sonnet5(异步 worker) |
| **R14 产品路线** | HOLD；**review 建议 = Option B（Granular）；owner 尚未正式裁决（undecided）**；R14-C 真实规模基准先行（run 需真数据=运维）| owner A/B（在 R14-C 之后）| very-high | **opus4.8** |
| **M2-UAT** | 前置**现已满足**：#159 磁盘门 **CLOSED**(2026-07-12,df=39%)、§0-a 在 main、可证 SHA 部署绿；UAT 本体未跑 | ops/owner-执行（真钉钉企业+真人；session 不能跑）| 人工 | 人工 / fable5 台账 |

> 设计锁**尚未起草**的车道：**R13-C** 与 **R14**（两者的设计锁都要另起，fable5/opus 视难度）。已起草的锁 = #4195/#4196/#4203/#4204/#4205（+#4187）。

---

## 2. 依赖图（核实的边）

1. **#4196 Class-A 同事务 ledger 底座 → FWB 记录写 + M4A retry runtime**（共享幂等 claim 事务；#4196 未合前两者双重受阻）。
2. **#4195 附件 runtime → FWB-3**（**两者都改 `ApprovalProductService` 热文件**；FWB-3 的 decisionData 冻结在 `dispatchAction` 锁事务里。**FWB-1/2 可按文件情况与 #4195 并行；FWB-3 必须等 #4195 释放该热文件**——owner R13 排序原话）。
3. **S-0 → S-1**（私有排序）。
4. **S-0 → M3（后段档）**（M3 的某一档硬依赖 S-0 先落；私有）。
5. **R13-A #4204（revision/retention umbrella）→ R13-C**（keep-window 语义挂其上）。
6. **R13-B #4205（History Center 面）→ R13-C**（preview/restore 触发面）。
7. **R12-C flag-manifest #4199 ⇆ R13-C 联动**——⚠️ **#4199 是平行 session 的 Draft PR**，其落地不在本线控制内；R13-C 除 owner-ratify 门外**另受平行 session 协调**约束。
8. **R14-C 基准 → R14 正式 A/B → R14 base-wide restore runtime**。
9. **#4187(D-1c) 与 R13-A 联批**。
10. **#4195 + #4203 同批 ratify**（FWB §9）。
11. **M2-UAT 在 §0-a(#4171 已合) 之后**——前置现已满足。

---

## 3. 有序执行阶段（诚实区分「谁能做」）

### Phase 0 —— 仅 owner/运维可解（session 绝不能做，但解锁一切）
- **M0-merge-queue**：owner 在安静窗口点开（仓级配置）。
- **S-0（私有安全落地）**：owner + 运维执行（私有仓审 + 部署 + 披露）；步骤/状态见私有材料。
- **M2-UAT**：前置已满足（#159 已闭、§0-a 在 main）→ owner 在受控 UAT 环境跑 U1–U13（Stream 仅 UAT 短暂 ON，生产 OFF；retention 单独、另行）。

### Phase 1 —— owner ratify（清设计锁门；随后 session 才能建）
- **Ratify #4196**（Class-A 底座）—— **keystone**，解锁 FWB + M4A runtime。
- **Ratify #4195 + #4203 同批**（先答 #4195 O1/O2/O3 + #4203 Q1–Q5）。
- **Ratify #4204（+#4187 联批）** —— 裁 OD-A1..A6（尤其 **OD-A4=守卫先落+冻结 pending**）。
- **Ratify #4205** —— 裁 OD-B1..B7（**OD-B1 非活行 deny 基准 / OD-B5 读面权限位** = 权限面，须 owner 拍）。
- **R14**：跑 R14-C 基准 → **owner 正式 A/B 裁决**（review 建议 B，但**未决**）。
- 起草 **R13-C** 与 **R14** 的设计锁（当前未起草）。

### Phase 2 —— session 建（ratify 后，可并行的 runtime 车道）
每条**独立 opus4.8 对抗门禁（非自审）**。落地时：**已 ratify 且锁内明确要求 flag 的车道默认 OFF**（未 ratify 车道不预设此断言）。
- **Lane α（opus）**：S-1（私有安全加固，S-0 落地后）—— 私有优先，**不开公开 PR**。
- **Lane β（opus 底座 → sonnet 消费）**：#4196 Class-A ledger runtime → **FWB-1(sonnet)、FWB-2(sonnet)**（可与 Lane γ 并行）→ **FWB-3(opus)** ——**FWB-3 排在 #4195 附件 runtime 之后**（争 `ApprovalProductService` 热文件）；M4A retry ledger runtime(opus)。**#4196 substrate 是 β 的串行瓶颈。**
- **Lane γ（sonnet + opus 门）**：#4195 附件 runtime（对象存储 provider + 表 + 上传 + 鉴权代理下载）。**须先于 FWB-3。**
- **Lane δ（opus 守卫 + sonnet 迁移）**：R13-A 守卫 rung → A1/A6/A8 逐站 + 冻结 pending 刀-by-刀。
- **Lane ε（opus + sonnet FE）**：R13-B 读面去过滤 + preview/execute 分离 + 幂等 restore。
- **Lane ζ（sonnet + opus）**：M3 helper + 前段 wiring(sonnet) → **后段档(opus，S-0 落后)**。

### Phase 3 —— R13-A/B + R14 决策之后
- **R13-C 运维规模**（先设计锁→异步 worker；依赖 #4204/#4205 + 平行 session 的 #4199）。
- **R14**：owner 裁 A ⇒ base-wide restore（**operation-level 原子**：阻写范围+分块+补偿+一次性切可见，**非单大事务**）；裁 B ⇒ granular 定位收口 + 明确排除 config-revision。

---

## 4. 模型分级（按难度，逐条理由）

- **fable5**：**已起草的**设计锁 docs、规划 MD、UAT 台账转录、**以及尚未起草的 R13-C/R14 设计锁起草**（难度高的段落上调 opus）。低风险纯文字。
- **sonnet5**：中等 impl —— #4195 表/迁移/上传/MIME、FWB-1/FWB-2、R13-A 逐站迁移(A1/A6/A8)、M3 前段 wiring、R13-C 异步 worker、R13-B FE。照已锁配方落地。
- **opus4.8**：一切**碰钱/写路径/锁/并发/安全**的 —— S-0 重审、S-1、#4196 Class-A/B 语义+TOCTOU、FWB-3 决策值冻结、R13-A 守卫 rung、R13-B 权限+幂等、R13-C 设计+reset-txn、M3 后段、R14 base-wide restore，**以及每一道对抗门禁**。规则：拿不准就上调。

---

## 5. 并行与关键路径

- **可并行**：Phase 1 ratify 清门后，Phase 2 的 α / γ / δ / ε / ζ 大体可并行（文件不同）。**两个串行约束**：(i) β 的 #4196 substrate 是 FWB + M4A 的前置；(ii) **FWB-3 必须排在 Lane γ(#4195 附件 runtime) 之后**（争 `ApprovalProductService` 热文件）——**FWB-1/2 不受此限，可与 γ 并行**。并发上限 ≤2–3 build + 门禁。
- **关键路径（产品侧）**：**#4196 ratify → Class-A substrate runtime → #4195 附件 runtime → FWB-3**（8–12pd，opus）。（比「FWB-3 单独」长——因热文件串行。）
- **关键路径（安全侧）**：S-0 落地 → S-1。
- **关键路径（运维侧）**：**M2-UAT 现已可跑**（#159 闭），独立于以上，owner 半天现场即可。

---

## 6. 验证口径（每条 runtime 如何被**证明**，非仅测过）

- **构造并发**证竞态（顺序论证一文不值）：#4196 Class-A 事务中途注错→读写皆回滚；FWB 幂等双连接同时 dispatch→恰一条记录；R13-B restore 幂等 op-id 双执行→恰一次应用；R13-C reset↔retention TOCTOU。
- **正控腿**配每条「不发生」断言（否则观测坏了空转变绿）：安全守卫**拒攻击者的同时放行合法请求**；R13-A 每站 golden `reconstructRecordsAtT` 前后皆对 + **neuter 本站 revision→该站 golden 必红**；负向日志/审计断言必配「会出现」腿。
- **变异先证落地**（`git diff --exit-code`）再采信红/绿——失败的替换与健壮守卫从外面看一样。
- **真库+新库全量迁移**证 schema（zzzz 排序；新表须 zzzz TS 迁移；空库验非预载库；确认不在 CI-excluded 迁移簇内）。
- **照 CI 步骤跑**（无-DB 单测步 + plugin-tests.yml 白名单真库步）——只跑一步报绿=谎报。
- **披露纪律**：安全 fix 私有优先，披露在**部署后**；公开 PR/doc 不得描述未修漏洞机制或私有安全链状态。

---

## 7. 只有 owner/运维能做的（诚实边界）

merge-queue 启用 · 私有安全链的重审/部署/披露 · M2 现场 UAT（真钉钉企业+真人）· 全部设计锁的 ratify（含 ~30 个开放 OD/Q）· **R14 A/B 决策（尚未做出，review 仅建议 B）** · 任何生产 flag 翻转。**这些不是「写代码」能完成的，是 owner 手里的决策/输入/现场。**

## 8. 本文不主张什么

- **不主张「生产收官」**——owner 的关闭标准绝大多数在 owner+运维手里。
- 不主张任何锁「已定」——#4195/#4196/#4203/#4204/#4205 全 PROPOSED；R13-C/R14 锁**尚未起草**。
- **不把「review 建议 B」记成「owner 已裁 B」。** R14 A/B 未决。
- **不自 ratify、不自建被门约束的东西、不公开披露未修漏洞或私有安全链状态。** 能推到的极限=**决策侧全部一键可拍 + 代码侧不涉披露部分待 ratify 即可建**。

---

## 9. 复核纪律（Rev 2）

本文的车道现状经并行审计逐条对活库/源码核实（workflow `wf_7d199c80-88e`）。**Rev 2 依 owner REQUEST-CHANGES 修正四处**：P1 私有安全车道去具体化（状态移私有材料）· P2 FWB 串行修正真正折入 §2/§3/§5（非「按注理解」）· P2 R14 改为「review 建议=B / owner undecided」· P3 去两处过度声明（未起草的 R13-C/R14 锁、flag-OFF 仅限已 ratify 车道）。**任何 runtime 落地仍须每刀独立 opus 对抗门禁（非自审）。**
