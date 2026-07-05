# 收尾规划 B 层执行 一轮 — 设计与验证 — 2026-07-05

## 0. 本轮定位

以《数据库及系统连接线收尾规划》(#3655 7c1a48d72)为目标池,执行其中**不依赖实体机、不需 owner
决定**的可立即解锁项——B 层质量收尾的 B1/B3/B4 + C 层 C3。A 层(#3652 probe + BL 链)归 owner/BL
session;B2/B5/C1/C2 是 owner 决定,本轮不碰。

## 1. 交付清单

| 收尾项 | 内容 | PR | SHA | 分派 |
| --- | --- | --- | --- | --- |
| **B1** | integration-guard CI lane | #3660 | `00108b4b8` | Fable-5 亲做 |
| **B3** | stale scope-fence 注释清理(2 cjs) | #3661 | `2ba7133de` | Sonnet agent |
| **B4** | 冒烟姿态声明(收尾规划 §8.1) | #3661 | 同上 | Sonnet agent |
| **C3** | gated 池冻结即完成清单(§8.2) | #3661 | 同上 | Sonnet agent |
| P3 前修 | 收尾规划 §1 基线 SHA 措辞 | #3658 | `4b9bdf9c1` | Fable-5 |

## 2. 设计要点

### 2.1 B1 — integration-guard CI lane(本轮头号价值)

**问题**(深读发现):本线全部测试——插件 72 文件 CJS 链(read-source config/probe/resolver/
composition + write-target)+ 两个 vocab tripwire(composition #3576 / resolver #3539)+ 三面板 +
service specs——**不在任何 workflow**。"tripwire 在 CI 变红""test-locked"此前仅本地成立。

**方案**:新 `.github/workflows/integration-guard.yml`,照 attendance/approval-web-guard **定向模式**
(curated spec 列表,不上全量 apps/web vitest 避历史 flake):
- step 1:`pnpm --filter plugin-integration-core test`——35 个 hermetic CJS 套件,**无需 DB**
  (亲验 exit 0)。
- step 2:定向 vitest,子串 target 精确命中 6 文件(composition/resolver vocab mirror + 3 面板 +
  service),63 test 全绿、**无误配**(逐一核过命中集)。
- 触发:push[main] + PR,paths 覆盖插件全目录 + 6 个 client 文件/spec + workflow 自身。
- **未接为 required check**——那是单独的 branch-protection 决定,姿态正确(先跑观察,后按需设 required)。

### 2.2 B3 — stale 注释(纯注释,零 runtime)

`read-source-read-runtime.cjs`(×2)与 `read-source-composition-planner.cjs`(×1)仍写着 composition
是"a separate, still-ungated slice"/"C-R3 ... a separate, later, gated opt-in"——C-R1→C-R4 早已发布。
注释改述当前真相:standalone resolver 在本文件保持 standalone;composition 路径在
`read-source-composition-runtime.cjs`(C-R3 已合)按 hop 编排本执行器;后续 rung(递归)仍 gated。
**关键**:planner 有 purity tripwire 读模块源码扫 `require(`/`fetch(`/`query(` token——注释须避开这些
token,agent 做到了,复验绿。

### 2.3 B4/C3 — 姿态与冻结(docs,§8 addendum)

- **§8.1 B4**:读/组合冒烟为 workflow_dispatch-only、不链 deploy(仅 K3 冒烟 continue-on-error 链入)
  ——声明为**有意姿态**(需实体机 K3 凭证 + owner 供样本 key,是 owner-run 验收通道非 deploy gate)。
- **§8.2 C3**:冻结池表——REC-R1/R2/R3、connector 目录、事件入站、可视化清洗、OAuth、marker-gating、
  delete(W0 硬排、无解锁路径)、K3 Save/Submit/Audit + 生产写(客户禁)、四个永久边界锁——全部
  **冻结即完成**,不计入未完成项。§5 checklist B3/B4/C3 勾为 ✅。

## 3. 验证汇总

| 件 | 验证 |
| --- | --- |
| B1 | 插件链本地 exit 0(35 OK);target vitest 命中 6 文件 63 test 全绿、无误配;YAML python-yaml 解析过;**合并后 integration-guard lane 在 main 实跑 completed/success**——真机 CI 确认 lane work,非仅本地声明 |
| B3 | 纯注释(diff 过滤后零代码变更);`node --check` ×2;planner purity tripwire + read-runtime test 独立复验绿 |
| B4/C3 | §8.1 对照真实 smoke workflow + docker-build deploy job 核实;§8.2 逐项对齐设计锁 |
| 集成 | B1 我亲做亲验;L2(B3/B4/C3)Sonnet 起草 + 我逐行审(纯注释确认)+ 干净 worktree 独立复跑 |

## 4. 模型分派实录

| 件 | 难度 | 分派 | 结果 |
| --- | --- | --- | --- |
| B1 CI lane | 需判断插件链 hermetic 与否、防 flake 上门、target 精确性 | Fable-5 主循环 | 亲验插件链无 DB 可跑、target 无误配 |
| B3/B4/C3 | 注释改述 + docs 追加,机械但需避开 purity tripwire token | Sonnet agent | 过质量闸;避 token 判断到位;零偏差 |

分派策略(CI/安全判断 → 主循环;机械 docs/注释 → Sonnet + 质量闸)**第四轮验证有效**。

## 5. 收尾规划状态推进(#3655 checklist)

本轮后:
```text
B1 ⬜→✅  B3 ⬜→✅  B4 ⬜→✅  C3 ⬜→✅
```
剩余(全部 owner 侧或依赖实体机):
```text
A1 ⬜ #3652 probe(owner 实体机,执行卡已贴)
A2-A5 🔒 BL1..BL4(BL0 session,各 opt-in)
B2 ⬜ W1 处置(owner 决定:开 W2 / 声明契约层冻结)
B5 ⬜ :id/read 无 UI 声明(owner 一句话)
C1 ⬜ #1709 关闭重组(owner)
C2 ⬜ 卫星 issue 处置(#1711/#2777/#2438/#2642)
```

## 6. 边界(本轮零跨越)

零 runtime 逻辑改动(B1=CI 配置,B3=注释,B4/C3=docs);写路径/递归/K3 Save 全维持冻结;未与
并行 session worktree 冲突。
