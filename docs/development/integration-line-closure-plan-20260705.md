# 数据库及系统连接线(#1709)— 收尾规划 — 2026-07-05

> 基于四路深读(#1709 全 150 评论时间线 / origin/main 代码实况审计 / 8 份设计锁与账面文档去重 /
> 卫星 issue 扫描)。本文是**规划,不是授权**——每个 🔒 项仍需其标注的门;✅ 表示已完成;⬜ 表示
> 已解锁可执行。

## 0. 收尾定义(DoD,三层)

这条线"收尾"= 三层同时成立:

- **A 能力关键路径**:组合链(material→内码→BOM 号)在实体机 **BL4 复跑 PASS**,或 owner 显式
  声明二跳能力 out-of-scope 并按该口径改写 close-out。当前组合链已实跑一次、**败于第二跳**
  (BL0/caseB:缺 `BOM/GetList` 按内码的 standalone 读),在 BL2+BL3 standalone PASS 前,
  组合线必须保持"非实体机 PASS"口径(BL0 锁明文)。
- **B 质量收尾**:本线的安全声明有 CI 兜底(见 §3——**当前不成立,是本规划最大发现**)、
  stale 注释清零、文档账面与 main 一致。
- **C 治理收尾**:#1709 关闭重组(body 级 DoD 已满足,残余 gate 迁至卫星 issue)、gated 池以
  "冻结即完成"口径显式声明。

## 1. 现状矩阵(origin/main @ 4c376b8e4)

| 面 | 状态 | 实体机验证 |
| --- | --- | --- |
| 读自助化 S0-S3(配置→探测→审批→运行) | 全栈 wired(路由+client+UI+冒烟) | ✅ PASS(#3488,dbd3768d8) |
| C3 LIST / C4 BOM 读 | wired | ✅ PASS(#3390 / #3405) |
| resolver R0-R3 | wired + mirror | ✅ standalone PASS(17688041f) |
| 组合 C-R1→C-R4 + authoring 面 | 全栈 wired(#3553…#3621/#3625) | ❌ **二跳 FAIL**(BL0/caseB)——A 层主阻塞 |
| 组合冒烟 + runbook | 就绪(#3600/#3598) | 待 BL 链后复跑 |
| 写阶梯 W1 | **完全 latent**(仅 lib+迁移+测试;零 service 注册/零路由/零 client) | N/A |
| field-option sync | wired(stock-prep preset 限定) | 既有线验证 |
| 递归 / 写执行 / K3 Save-Submit-Audit / delete | 🔒 冻结(各设计锁) | N/A(冻结即完成) |

## 2. A 层 — 能力关键路径(BL 链,顺序依赖)

| # | 项 | 执行者 | 门 | exit criteria |
| --- | --- | --- | --- | --- |
| A1 ⬜ | **#3652 二跳读形状 probe**(S2-b 探测面,今天即可跑) | **owner(实体机)** | 无(已上线能力) | values-free 形状证据回贴(container located / keyField token / 目标字段在否) |
| A2 🔒 | **BL1** 契约/config/preset 元数据 | BL0 session | owner opt-in(A1 证据后) | 契约合并,零 runtime |
| A3 🔒 | **BL2** standalone 读 runtime | BL0 session | 单独 opt-in | 本地全绿 |
| A4 🔒 | **BL3** 打包 + standalone 实体机冒烟 | owner(实体机) | 单独 opt-in | standalone PASS 证据块(standalone-first 纪律) |
| A5 🔒 | **BL4** 组合 E2E 复跑 + close-out 更新 | owner(实体机) | BL2+BL3 PASS | 组合链 PASS;runbook #3598 附录回填 |

> 替代路径:owner 可随时声明二跳 out-of-scope → A 层改为"按现口径改写 close-out",A2-A5 冻结。

## 3. B 层 — 质量收尾(不依赖实体机,可立即做)

| # | 项 | 执行者 | 说明 |
| --- | --- | --- | --- |
| B1 ⬜ | **integration CI guard lane(最高优先)** | 我 | **深读确认:插件 CJS 测试链(read-source/probe/resolver/composition/write-target 全套)不在任何 workflow;mirror tripwire + 三面板/service specs 也零 CI**——"tripwire 变红"声明当前仅本地成立。补法照 repo 既有模式(approval/attendance-web-guard 定向 spec,不上全量 vitest 避 flake):新 `integration-guard.yml` = `pnpm --filter plugin-integration-core test`(CJS 链)+ 定向 vitest(mirror tripwire + 3 面板 + service specs) |
| B2 ⬜ | **W1 处置决定** | owner 决定,我执行 | 二选一:(a) 开 W2(dry-run 契约 + token,W1 从 latent 转活);(b) 声明"W1=契约层完成、runtime 冻结"为收尾态,写入账面。**不决定 = W1 悬空,不是合法收尾态** |
| B3 ⬜ | stale scope-fence 注释清理 | 我 | `read-source-read-runtime.cjs:13,:180`、`read-source-composition-planner.cjs:7` 仍写着"composition 未 gated 开放"等旧口径 |
| B4 ⬜ | 冒烟姿态声明 | 我(docs) | 读/组合冒烟为 dispatch-only、不链 deploy(仅 K3 冒烟 continue-on-error 链入)——作为**有意姿态**写入账面,或改链入(owner 决定) |
| B5 ⬜ | 单配置 read 路由无 UI 面 | owner 决定 | `POST /read-source-configs/:id/read` 仅冒烟脚本消费——声明"runtime-tier-only 即终态"或排 UI 供给(建议前者,一句话入账) |

## 4. C 层 — 治理收尾

| # | 项 | 说明 |
| --- | --- | --- |
| C1 ⬜ | **#1709 关闭重组**(owner) | body 级验收标准已全部满足(读/list 规范化预览、错误语义、redacted fixtures、adapter 测试、零写),2026-06-30 close-out 已宣"CLOSED at scoped deliverable"。建议:关闭 #1709,残余 gate 迁卫星——BL 链挂 #3652/BL0、resolver GATE-front 形状挂其自身线程、W 阶梯挂 W0 锁 |
| C2 ⬜ | 卫星 issue 处置 | #1711(关系注册表,休眠)→ 对照已交付 resolver/组合重新定界或关闭;#2777/#2438(runner 侧联通)→ 明确不卡 owner-run 路径,独立轨;#2642(Windows TEMP)→ 工效项独立轨 |
| C3 ⬜ | gated 池冻结声明(收尾文档一句话表) | REC-R1..R3(双门)/ connector 目录 / 事件入站 / 可视化清洗 / OAuth / marker-gating / delete(无解锁路径)/ 永久边界锁(host-allowlist 等)——**冻结即完成**,不计入未完成项 |

## 5. TODO checklist(可追踪)

```text
A 能力关键路径
  ⬜ A1 #3652 probe(owner,实体机,~10min)
  🔒 A2 BL1 契约(门:owner opt-in)
  🔒 A3 BL2 runtime(门:单独 opt-in)
  🔒 A4 BL3 打包+standalone 冒烟(门:单独 opt-in;owner 跑)
  🔒 A5 BL4 组合复跑(门:BL2+BL3 PASS)
B 质量收尾
  ⬜ B1 integration CI guard lane(我;最高优先)
  ⬜ B2 W1 处置(owner 二选一 → 我执行)
  ⬜ B3 stale 注释清理(我)
  ⬜ B4 冒烟姿态声明(我 docs / owner 可改链入)
  ⬜ B5 :id/read 无 UI 声明(owner 一句话)
C 治理收尾
  ⬜ C1 #1709 关闭重组(owner)
  ⬜ C2 卫星 issue 处置(owner+我)
  ⬜ C3 gated 池冻结声明表(我,并入收尾文档)
```

**建议起手序**(并行三轨):A1(owner 实体机)∥ B1+B3(我,今天可完)∥ B2/C1 两个 owner 决定
(异步定即可)。A 层其余按 BL 门渐进;全部勾完后出最终《收尾报告 MD》并关线。

## 6. 模型分派预案

| 件 | 分派 |
| --- | --- |
| B1 CI guard workflow(YAML+定向 spec 选择,防 flake 上门) | Fable-5 主循环(踩过 web-guard 模式与 flake 教训) |
| B3 注释清理 / C3 冻结表 / B4 姿态声明 docs | Sonnet agent + 质量闸 |
| BL1-BL2(若 opt-in) | BL0 session(不抢 lane) |
| W2(若选 (a)) | token-helper 提升=Fable 亲写;预览 evidence 机械件=Sonnet |

## 7. 边界(本规划零开门)

递归/写执行/K3 Save-Submit-Audit/delete/生产写全维持冻结;BL1+ 仍待 opt-in;本文档 authorizes
nothing。
