# 数据库及系统连接线 — 验收准备 + 递归方向锁 一轮 — 设计与验证 — 2026-07-05

## 0. 本轮定位

组合线(#1709 read-only composition)在 2026-07-05 早间达成端到端 feature-complete(C-R0→C-R4 全栈
+ 防御纵深闭环,见 arc ledger §8)。本轮是其后的**收口与开门准备**轮,固定节奏 + 并行 lane:

```text
L1a 组合冒烟脚本+workflow(实体机验收自动化通道)   —— 可逆 in-gate,Sonnet-5 agent 起草
L1b 组合实体机 E2E runbook(owner-run 验收手册)     —— 可逆 in-gate,Sonnet-5 agent 起草
L2  REC-R0 递归展开方向设计锁(docs-only)           —— 本线下一能力梯级的方向锁,Fable-5 亲写
```

写路径 / 递归 build 未触碰(各自 gated;生产写客户显式禁)。

## 1. 交付清单

| 件 | PR | SHA | 验证 |
| --- | --- | --- | --- |
| A1 组合冒烟 `scripts/ops/integration-composition-postdeploy-smoke.mjs` + `.github/workflows/integration-composition-postdeploy-smoke.yml` | #3600 | `bba53d1e3` | node --check OK;YAML 双解析器过;无网络调用;required-arg fail-closed |
| A2 实体机 runbook `docs/development/integration-composition-entity-e2e-runbook-20260705.md` | #3598 | `fe378cd4f` | 458 行;零品牌名;全占位符 values-free;形状对齐已发布 fixtures |
| REC-R0 设计锁 `docs/development/integration-read-source-recursive-expansion-direction-design-lock-20260705.md` | #3595 | `28136b5c3` | docs-only;authorizes nothing;需求门显式未满足 |

## 2. 设计要点

### 2.1 A1 冒烟(生命周期,全 values-free)

auth round-trip → 存+审两个 hop read config(幂等容忍重跑:复用已审行仅 draft 才 approve)→ 存组合 →
**审前负测 run(409 NOT_APPROVED)** → 审 → run `{inputs:{key}}`(HTTP 200 为硬杠;链 fail-closed 粗码
如 NO_MATCH 记为 `chainOutcome` 平台通过,不断言)→ **config-override 负测(400 RUN_CONTRACT_INVALID)**
→ retire → **retire 后 run(409)**。

- **values-free 在脚本内强制**:`leakScan` 三类哨兵(sample key / 两条读路径 / **已解析值本身**)扫
  证据面;summary 只带 statuses / coarse codes / booleans / dataTarget 名。
- 三个与读线冒烟模式的偏差,均基于真实 store 语义:组合 `name` 时间戳盐化(content-key 对 retire 后
  同内容重存 409);hop config 不盐化(真业务 wiring,幂等复用);`--sample-key` 必填(本线无 key-less 路径)。

### 2.2 A2 runbook(owner-run,4 阶段)

Phase 1 authoring(两 config + 组合,step-1 形状对齐已证 live 冒烟;**step-2 BOM 形状显式标注未
live 验证、probe-first,不造形状**)→ Phase 2 run(C-R4-3b 面板 + API,预期结局表含粗码语义)→
Phase 3 负测(draft 409 / 走私 400)→ Phase 4 清退。附 values-free 证据模板(可贴/禁贴清单)、
PASS 判据、排障表(其最细一行来自真实代码路径:hop 内异常坍缩 STEP_FAILED vs resolver 专码保留的
不对称)。诚实标注已知缺口:**组合 authoring UI 尚缺**(仅 run 面板),authoring 走 API——预期非缺陷。

### 2.3 REC-R0 递归方向锁(八把锁,双门)

- **需求门显式未满足**:build 须先有命名的客户场景走治理读面;并与既有 stock-prep bridge-SQL
  large-BOM 通道诚实切割(不同基底,非替代)。
- 八锁:同一读原语迭代复用(零分叉)/ 三重平台上限预算(深度/逐层/总节点;**cap-hit = fail-closed
  专码,截断永不算成功**,吸收 large-BOM bounded-preview 教训)/ 环检测 fail-closed / key-only +
  平台派生下降键 / values-free 逐层聚合证据 / 只读幂等(v1 无 checkpoint)/ 权限层级不变 /
  闭词表 + 未来 route/UI rung 镜像义务。
- REC-R1(config+纯 planner)→ REC-R2(executor)→ REC-R3(route/mirror/UI)各自独立 opt-in。

## 3. 模型分派实录(按难度自动选择)

| 件 | 难度画像 | 分派 | 结果 |
| --- | --- | --- | --- |
| REC-R0 设计锁 | 最难:治理推理、与两条既有线切割 | **Fable-5 主循环亲写** | 一次成稿 |
| A1 冒烟 | 机械镜像 + store 语义细节 | **Sonnet-5 agent**(worktree 隔离) | 过质量闸;3 个 store-语义偏差判断出色(content-key 409 / approve-on-approved 409 / key 必填) |
| A2 runbook | 机械镜像 + 事实核对 | **Sonnet-5 agent**(worktree 隔离) | 过质量闸;step-2 未证形状显式标注、authoring-UI 缺口诚实入档 |
| 质量闸/审阅/集成 | — | Fable-5 | 两件均实文件复核(values-free 扫描、node --check、YAML 解析) |

前一夜云端 routine(Sonnet-5)自主交付 C-R4-3b UI(#3585)同样过闸——「设计/安全推理 → 强模型,
镜像/机械件 → Sonnet-5 并行」的分派策略两轮验证有效。主循环模型仍归 owner(/model);我可自动分派的
层级 = subagent/Workflow per-task `model`/`effort` 覆盖。

## 4. 验证汇总

- A1:`node --check` OK;YAML js-yaml + python-yaml 双过;无参 fail-closed 无网络调用;未对任何部署
  主机发起请求。
- A2:实文件复核(零品牌名、全角括号占位、API 路径/形状与 http-routes.cjs 及 runtime fixtures 对齐)。
- REC-R0:docs-only,无 build 授权;边界矩阵 codeAuthorized=false / demandGateSatisfied=false /
  writePathTouched=false / stockPrepLargeBomReplaced=false。
- 工程教训 2 则(供后续 merge loop 复用):① 分支被他 worktree 占用时 `worktree add origin/branch`
  落 detached HEAD,rebase 后须 `push HEAD:refs/heads/<branch>`,推分支名会静默 no-op;② 不要覆盖
  运行中的 loop 脚本文件(bash 增量读取会把旧实例截断成语法错误)。

## 5. 下一步(全部待 owner 指令)

1. **实体机验收执行**(owner-run):按 #3598 runbook + #3600 冒烟通道在部署机跑组合链真机验收
   ——step-2 BOM 形状先 probe 后填;跑完把 values-free 证据回填 runbook 附录。
2. **W 写阶梯**:W1 config model(#3548)仍 draft,un-draft 后进入审阅。
3. **递归 build**:REC-R0 已锁方向;REC-R1 需「命名客户场景 + 显式 opt-in」双门齐备。
4. **benchmark 改进项**(连接器目录/事件入站/可视化清洗):各自设计锁先行的独立 opt-in。

## 6. 边界纪律(本轮零跨越)

写路径(Save/Submit/Audit/外部写/生产写)未触碰(客户显式禁);递归仅方向锁未 build;未与并行
session worktree 冲突(#3568 全程未碰,A1/A2 agent 各自隔离 worktree)。
