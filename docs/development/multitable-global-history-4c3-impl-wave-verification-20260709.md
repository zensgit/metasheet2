# Multitable Global History — 4c-3 impl wave 设计+验证记录(2026-07-09)

**性质:** 每 wave 设计+验证 MD(4c-2 先例:`…4c2-impl-wave-verification-20260708.md`)。本文对应 **4c-3 record-undelete inbound-edge replay(Option A)的 RATIFIED + AS-BUILT 实现**(PR #3975,merged `100b6dd59`,flag 默认 off)+ **R8 车道对该 PR 的吸收性对抗审计的无裁量硬化轮**(本轮,test-only,不改产品行为)。
**上游:** design-lock `…4c3-record-undelete-2b-inbound-edge-replay-design-lock-20260708.md`(owner ratify 2026-07-09,路由 Codex 车道实现)。**前置 gap-audit:** `…destruction-path-coverage-gap-audit-20260708.md`(D-1 已于同日经独立 PR #3969/#3977 落地;本文不重复其记录)。

**⚠️ 与并行 PR #3983 的关系(rebase 期发现,记录以防未来读者困惑):** 本 PR 开发期间,主线并行落地了 `test+docs(multitable): O-2 preconditions — resurrect-path goldens (P3-2) + operator flag ladder (P3-3) (#3983)`,来自**同一 PR #3975 的另一条对抗审(其自身的 review,而非本文引用的独立吸收性审计 `/tmp/pr3975-4c3-absorption-audit-claude-20260709.md`)**,该 PR 的 P3-2/P3-3 编号与本文引用的审计**编号不同但同源**(都指向 PIT-resurrect 锚定这同一个覆盖缺口)。#3983 新增 `multitable-undelete-pit-inbound-replay-realdb.test.ts`(单-vintage happy replay + Option A 邻居拒绝 + flag-off)与 `…o2-operator-flag-ladder-20260709.md`(O-2 启用阶梯)。本 PR 的 `multitable-undelete-inbound-resurrect-realdb.test.ts` 与之**部分重叠**(均含 flag-off 字节级不变一测)但**互补,非重复**:本 PR 独有多-vintage 锚定精度(只放最新 vintage、不串代)+ 未捕获-vintage 静默零重放两条 golden,以及把 resurrect 锚注释的 "deterministic" 措辞改诚实。两份 PR 已在 `origin/main` 上 rebase 兼容,9 个相关 realdb 文件(含 #3983 的新文件)同跑 75/75 绿,无 fixture 冲突。

## 1. 落地内容(逐 § 对锁)

| 锁 § | 实现 | 位置 |
|---|---|---|
| §2 anchor 列 | `meta_records_trash.delete_revision_id text NULL`(forward-only,nullable,无回填) | migration `zzzz20260709100000_add_delete_revision_id_to_meta_records_trash.ts` |
| §2 写入点 | `deleteRecord` 预生成 `recordDeleteRevisionId`,同一 id 兼作 tombstone `source_revision_id` + trash 行 `delete_revision_id` + revision `id` | `record-service.ts:829/833/854/876` |
| §2 restore 读锚 | 严格 `trash.delete_revision_id`;NULL ⇒ else 分支 `recoverable=false, replayed=0`,无启发式 | `record-service.ts:1079/1120-1122` |
| §3 六道前置 + §4 Option A + 幂等 | `replayInboundLinks`:诊断 CASE + INSERT…SELECT 同谓词锁步(R alive / N alive / F exists / F=link / F non-mirror / 邻居同意 / NOT EXISTS) | `inbound-link-replay.ts` |
| §5 授权 | 仅 `INSERT INTO meta_links`,`// lock-exempt` 标注;guard 实跑绿 | `inbound-link-replay.ts:35,133` |
| §6 retention 地板 + 撕裂修复 | `tr.delete_revision_id = g.anchor::text` 地板;按 anchor 整组裁剪 | `meta-revision-retention.ts:229-252` |
| §6 诚实信号 | `inboundEdgesRecoverable`(trash 列表)/ `recoverable: replay.total > 0`(restore 结果) | `record-service.ts:972-1002,1119` |
| §7 D-3(PIT-reset 捕获) | 预生成 `resetDeleteRevisionId` → `assertWithinCaptureCap` + `insertInboundLinkTombstones`(在 `DELETE meta_links` 之前)→ trash 锚同值;cap 超限 ⇒ 整单 reset 回滚 + 422 `TOMBSTONE_CAPTURE_CAP_EXCEEDED` | `univer-meta.ts:10456-10461,10504-10508` |
| §7 PIT-resurrect 复用 | 同一 `replayInboundLinks`;锚 = 该记录**最新** `action='delete'` revision(启发式,见 §1.1) | `univer-meta.ts:10165-10193` |
| §7 resurrect 信号 | 批量聚合 `undeleteInbound: { replayed, total }`(镜像 restore 侧,resurrect 无 per-edge skip 明细) | `univer-meta.ts:10139,10233` |
| §9 RB1–RB11 | 真库 golden 矩阵,CI 三点接线 | `multitable-undelete-inbound-replay-realdb.test.ts` |
| §9 RB12(mutation) | 六道谓词 + 地板独立 neuter → 逐一恰红(非提交测试,见 §2.2) | 审计 + R8 手工复证 |

### 1.1 承重正确性事实(本 wave 最重要的一条)

**resurrect 侧的锚不是 `restore` 侧那种存储列,是一条查询启发式**:`SELECT id FROM meta_record_revisions WHERE … action='delete' ORDER BY created_at DESC … LIMIT 1`。这在设计锁 §2 明文警告的形状之列("绝不用 `ORDER BY created_at DESC` 之类的启发式反推"),但该警告针对的是 **restore** 路径(那里有 `trash.delete_revision_id` 真锚,没有理由退化为启发式)。resurrect **没有 trash 行**(记录已被硬删且 T8-1 undelete 是从 revision 快照直接重建,不经过 trash 表),所以启发式是这个复活面**唯一可行**的锚来源,design-lock §7 本身也预见到"若 impl 期证明代价过大,允许拆为 4c-3b……必须显式记录分叉"——impl 选择不拆分,复用同一 helper,但锚来源不同这一点此前被代码注释里的"deterministic"措辞掩盖了。R8 已将该注释改为诚实版本(见 §2.3),并补齐多-vintage / 未捕获-最近删除两条 golden 把**实际行为**钉死,而不是让文档继续暗示一个不存在的精确性保证。**过放在两种复活面下都不可能**——precondition 6(邻居同意,读 `N` 自己的 `data`)独立于锚的选取为每条边把关,启发式唯一能造成的失效模式是**欠放**(某个 vintage 的边没被这次复活捡回来),不是错放。

## 2. 验证(独立复跑,不采信 PR 自证)

**独立吸收性对抗审计判定:APPROVE(post-hoc)— 0 P1 / 0 P2**(`/tmp/pr3975-4c3-absorption-audit-claude-20260709.md`)。

审阅方独立执行:
- migration 实跑:`\d meta_records_trash` 确认 `delete_revision_id text` 列存在;forward-only nullable,无回填。
- realdb RB1–RB11:12/12 绿(含 sentinel)。
- **独立 mutation 矩阵 6/6 恰红**(见 §2.2)。
- 逐门核对 design-lock §1–§9 + C1–C8 不变量,全部 PASS(C4 golden 判 "弱见 NIT"——见 NIT-4)。
- 邻居回归:`multitable-record-reconstructor-realdb.test.ts` 8/8。

R8 车道(本轮,2026-07-09)在审计判定之上补齐全部可无裁量修复的 P3/NIT 覆盖缺口,**未改动任何产品行为**(仅 1 处代码注释重写,见 §2.3)。

### 2.1 判定表(C1–C8,审计原文)

| 不变量 | 判定 | 证据 |
|---|---|---|
| C1 forward-only | PASS | RB3 绿 |
| C2 六道前置 | PASS | M3–M7 mutation 各自对应 golden 红 |
| C3 幂等 | PASS | RB8 绿 + M7 红 |
| C4 原子+并发 | PASS(golden 弱,见 NIT-4) | RB11 绿;`FOR UPDATE` |
| C5 无新权面 | PASS | §5 证 |
| C6 retention 地板 + 诚实信号 | PASS | RB10 绿 + M-floor 红 |
| C7 flag 默认 off | PASS | RB1 绿 |
| C8 写对称 | PASS | cap fail-closed + rank-8 标注 |

### 2.2 独立 mutation 矩阵(6/6,审计 + R8 两轮复证,每次还原后 `git diff` 空)

| Mutation(neuter 对象) | 对应 golden | 结果 |
|---|---|---|
| M3 field-exists `JOIN meta_fields`(改 LEFT JOIN + 放行 null-field) | RB4(fieldGone/23503) | **RED** ✓ |
| M4 `AND f.type='link'` → `AND TRUE` | RB5(fieldNotLink) | **RED** ✓ |
| M5 `AND (f.property->>'mirrorOf') IS NULL` → `AND TRUE` | RB6(fieldMirror) | **RED** ✓ |
| M6 `AND (n.data->F) ? R` → `AND TRUE` | RB7(neighborDeclined / Option A) | **RED** ✓ |
| M7 `AND NOT EXISTS(...)` → `AND TRUE` | RB8(self-link 双写) | **RED** ✓ |
| M-floor 地板谓词禁用(`table===LINK` → `false`) | RB10(retention 地板) | **RED** ✓ |

**结论:六道写谓词守卫 + 地板全部 load-bearing,无假绿。** RB12 本身此前**未固化为提交测试**(仅审计 PR-body 手工复证)——这正是 NIT-4 点名的缺口。R8 未新增一个"批量 mutation runner"文件,而是确认 **RB4/RB5/RB6/RB7/RB8/RB10 六个既有 golden 本身就是「结构守卫」形状**(每个 golden 的断言只在对应谓词在位时才绿,已在 §2.2 逐一独立复证),并核实它们已提交(`multitable-undelete-inbound-replay-realdb.test.ts`)且在 CI 名单(`plugin-tests.yml` real-DB 运行块 + `vitest.config.ts` exclude 名单)——**无需新增代码即满足 NIT-4 的实质要求**。

### 2.3 R8 本轮新增覆盖(P3/NIT 硬化,test-only)

| 项 | 覆盖 | 文件 | Mutation 证据 |
|---|---|---|---|
| P3-3 | neighborGone(邻居窗口内被硬删)⇒ 该边跳过,R 正常恢复 | `multitable-undelete-inbound-replay-realdb.test.ts` RB13 | 移除诊断 CASE 的 `neighborGone` 分支 → RB13 恰红 |
| NIT-3 | anchor 非空 + 零 tombstone(capture flag 对该次删除关闭)⇒ `recoverable=false`,零重放,无错误 | 同上 RB14 | `record-service.ts` 把 `recoverable: replay.total > 0` 硬编码为 `true` → RB14 恰红(其余 13 条不受影响) |
| P3-2 | D-3 PIT-reset 捕获:happy path(锚一致 + restore 回放全链路)+ cap 超限 → 422 + 整单回滚(含无关 revert 候选也被回滚,证明是全事务回滚而非仅该条) | `multitable-reset-pit-inbound-capture-realdb.test.ts` (a)(b) | 注释掉 `insertInboundLinkTombstones` 调用 → (a) 恰红、(b) 不受影响;注释掉 `assertWithinCaptureCap` → (b) 恰红、(a) 不受影响 |
| P3-1 | PIT-resurrect 多-vintage:锚定最新 delete revision,只重放对应 vintage,不串代;最近删除未捕获 → 静默零重放;flag-off 字节级不变 | `multitable-undelete-inbound-resurrect-realdb.test.ts` (A)(B)(C) | 锚查询 `ORDER BY … DESC` 改 `ASC` → (A) 恰红(B/C 不受影响);response 拼接去掉 `isRecordUndeleteInboundEnabled() &&` 门控 → (C) 恰红(A/B 不受影响) |
| P3-1(注释) | `univer-meta.ts` resurrect 锚注释的 "deterministic" 改为诚实描述(启发式来源、多-vintage 行为、未捕获行为、过放不可能的机理) | `univer-meta.ts:10165-10182` | 纯注释,无行为差异(comment-only diff 已核对) |

全部新增 golden 均在同一次性 docker `postgres:16` 实跑绿,且与既有邻居文件(`multitable-reset-pit-realdb.test.ts`、`multitable-undelete-pit-realdb.test.ts`、`multitable-d1-delete-revision-parity-realdb.test.ts`)同跑无 fixture 冲突(fixture id 均按文件前缀 + 时间戳命名空间化)。

## 3. 可达边界与 flag 状态(不虚构)

- **可达边界不变:** 只重放经 `record-service.deleteRecord`(捕获 flag 开启期间)或 PIT-reset 内联删除(同一 flag)销毁的 inbound 边。automation / plugin-SDK 硬删路径**仍不产生 tombstone**(= gap-audit D-2,owner 决策,出界)。4d 红线不动摇。
- **三个独立 flag,均默认 off:** `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED`(捕获总闸)、`MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND`(inbound 重放闸,restore + resurrect 共用)、`MULTITABLE_ENABLE_PIT_RESET` / `MULTITABLE_ENABLE_PIT_UNDELETE`(各自复活面的既有闸,4c-3 未新增)。任一组合 off ⇒ 对应路径逐字节不变(RB1、resurrect (C) 均实证)。
- **production 启用** 属独立 O-2 operator 阶梯,不在本锁/本 wave 范围。

## 4. 诚实缺口(本 wave 未做/需裁量,记录不隐瞒)

1. **resurrect 侧的精确 vintage 锚定未做**(P3-1 遗留的"改代码"半句)——把启发式换成精确锚(例如给 resurrect 也提供一个可靠的 per-vintage 锚,或在响应里暴露"此次复活可能遗漏更早 vintage 的边"的显式信号)需要新的存储或响应 schema 决策,**超出"补 golden/诚实注释"的一行级改动**,记录为**未做/需裁量**,不在本轮触碰。当前行为(欠放、不错放)已被 golden 钉死为诚实的已知限度。
2. **resurrect 响应的 per-edge skip 明细未做**(镜像 restore 侧的 `skipped.{fieldGone,fieldNotLink,...}`)——resurrect 目前只聚合 `{replayed, total}`,不像 restore 那样按跳过原因分桶。这同样是响应 shape 的产品裁量(会改变多条已合并调用方可能依赖的 JSON 形状假设),记录为未做,不在本轮触碰。
3. **NIT-1(drift-tripwire 精度)/ NIT-2(单语句 NOT EXISTS 对同批重复 tombstone 三元组的理论双放)/ NIT-5(`listDeletedRecords` 全列 SELECT + tombstone-capture.ts 文档枚举未列 PIT-reset 路由)** —— 审计原文即标注为低风险/理论可达,本轮未新增 golden(超出本轮授权的"补 P3/NIT golden"清单;若后续需要,按同一 mutation-verified 方法论补齐)。
4. 50k 捕获 cap 的规模/性能特征、on-prem 包构建路径未验(与 4c-2 wave 的诚实缺口 4 一致,未随本 wave 复测)。
