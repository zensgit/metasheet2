# 考勤 W4C-2 QA 交付包 — 隔离数据库 + 合成数据功能测试手册

Status: **DRAFT — QA handoff（测试团队用）**；本文档不授予也不请求任何授权。

Date: 2026-07-26

Refs: issue #4556（W4 主 issue，非本包完成点）· PR #4612（W4C-2 交付，Draft + OWNER-AUTHORIZATION-HOLD）·
设计锁 `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`（§12.3）

被测代码基线（QA 检出点）：PR #4612 head 分支
`claude/w4c2-live-scheduled-shadow-20260725` @
`f0fe4a4a649a96842a154d35a3cda9d6e8a60fc9`（`git rev-parse` 直贴）。
若该分支后续追加 commit，本手册按「以最新 head 重取 + 复核 §2 表落点」处理，勿默认沿用本 SHA。

## 0. 边界（先读）

- 本包适用范围：**本地 / 隔离环境功能测试**（自建全新 PostgreSQL 库 + 合成数据）。
- **staging flag 与七日 soak 属另行授权**：按 W4 剩余切片序，需在 W4C-4 之后由 owner 单独授权，
  **不在本包范围**；本包中任何脚本、fixture、预期值都不构成对 staging/生产的任何操作依据。
- **#4612 可交测试 ≠ #4556 关闭**：#4556 仍含 W4C-3a/3b/3c、W4C-4 与七日 soak 等后续环节，
  两者不是同一个完成点。QA 通过本包，结论只覆盖「W4C-2 切片在隔离环境下的功能行为」。
- #4612 当前为 **Draft + OWNER-AUTHORIZATION-HOLD**：QA 测试不改变其状态；测试发现的问题按
  issue/评论回报，不直接改 PR。
- 本包为**文档 + 脚本**交付，不改任何被测代码；脚本只针对隔离数据库 + 合成数据，
  连接串默认强制 localhost（见 §6 脚本内护栏）。

## 1. 被测面与运行方式

### 1.1 检出与构建

```bash
git fetch origin claude/w4c2-live-scheduled-shadow-20260725
git worktree add /tmp/w4c2-qa-checkout f0fe4a4a649a96842a154d35a3cda9d6e8a60fc9
cd /tmp/w4c2-qa-checkout && pnpm install
```

### 1.2 测试套件与 CI 步骤映射（QA 本地复跑 = 复现下表右列步骤）

| 套件 / 文件 | 类型 | 归属 workflow 步（`.github/workflows/plugin-tests.yml`，job `test`，matrix 18.x/20.x） |
|---|---|---|
| `packages/core-backend/tests/integration/attendance-w4c2-gate-matrix-e5.db.test.ts` | 真库 | step `Run attendance integration tests`（id `attendance-real-db-integration`，`vitest --config vitest.integration.config.ts run`，整文件参数） |
| `…/attendance-w4c2-live-scheduled-boundary.db.test.ts` | 真库 | 同上 |
| `…/attendance-w4c2-outbox-dispatcher.db.test.ts` | 真库 | 同上 |
| `…/attendance-w4c2-posture-matrix.db.test.ts` | 真库 | 同上 |
| `…/attendance-w4c2-timezone-write-guard.db.test.ts` | 真库 | 同上 |
| `…/attendance-w4c2-p2-remediation.db.test.ts` | 真库 | 同上 |
| `…/attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts` | 真库 | 同上 |
| `packages/core-backend/src/attendance/__tests__/w4c2-frozen-attribution.test.ts` | 单测（无库） | step `Run core-backend tests`（默认 `vitest.config.ts`） |
| `…/__tests__/w4c2-shadow-expected-differences.test.ts` | 单测（无库） | 同上 |
| `…/__tests__/w4c1-segment-calculator.test.ts`（W4C-1，本片有增补） | 单测（无库） | 同上 |
| `scripts/ops/attendance-w4c2-ci-wiring.test.mjs` | 接线守卫 | step `Attendance W4C-2 CI wiring contract`（`node --test`） |
| `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` | 债务台账守卫 | step `Run attendance W4C-0 Stage D §8.4 DML inventory collector`（`node --test`；需先 fetch 基线 commit `e0defbe26d7f2e1747e74aa908ca710422812bf7`） |

真库步骤环境（与 CI 一致）：

```bash
DATABASE_URL=postgresql://postgres@localhost:5432/<隔离库名>
ATTENDANCE_TEST_DATABASE_URL=$DATABASE_URL
```

套件内部另设 `RBAC_BYPASS=true`、`SKIP_PLUGINS=false`、
`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED=<逗号分隔 orgId 名单>`（由各测试文件自行设置）。
QA 手工探索性测试时须自行设置同名 env——姿态生效条件是「rollout state 行 **且** 该 org
出现在 env 名单」两者同时成立（w4c0 姿态口径），缺一即回落 `legacy_projection_only`。

迁移排除清单（与 CI `Run DB migrations` 步一致，写入 §6 重置脚本）：
`MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql`

## 2. Gate 清单 — 锁 §12.3 实际清点 = 23 条（与「19」的差异见 2.1）

### 2.1 清点口径与「19」差异说明

- 对 `origin/main` 上锁文 §12.3（`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
  L2648-2710）逐 bullet 清点：**顶层 gate bullet 共 23 条**。#4612 PR body 的「§12.3 gates → 落点映射」
  表同为 23 行，两处行数一致。
- 外部审阅所说「19 个 gate」在锁文与 PR body 中均无同名清单。一个可复算的对应关系是：
  23 条中有 **4 条在本片内不是由 W4C-2 新证据直接证得**（G2 结构性不可达；G8、G15 引用
  W4C-0 / W4C-1 既有证据；G17 的 promotion writer 半边本片不交付），23 − 4 = 19 恰为
  「本片自证 gate 数」。此对应是本包的**重构推测**，非任何权威文档的原文；如实报出，
  QA 与 owner 以 23 条全表为准。

### 2.2 全表（G1–G23）

覆盖状态图例：`套件` = 有常驻真库/单测腿，QA 可复跑；`mutation` = 证据是 PR 作者一次性
mutation 自检（记录于 #4612 body），QA 不能靠绿灯复证，只能按触发条件做行为抽查；
`引用` = 证据在前置切片（W4C-0/W4C-1）；`不可达` = 本片诚实标注未覆盖。

| # | 证明什么（锁 §12.3 摘句） | 触发条件（QA 可执行动作） | 预期结果 | 证据落点 | workflow 步 | 覆盖 |
|---|---|---|---|---|---|---|
| G1 | fresh W2 ambiguity 不产生 parent/result；既有 parent 至多追加 unsupported review | 同 user 同日两条互相重叠的 published+active 班次指派，`POST /api/attendance/punch` | 保留既有 legacy 422 拒绝；`attendance_records`/`attendance_record_calculations`/operations/outbox 零新行 | gate-matrix-e5 leg 1 | `attendance-real-db-integration` | 套件 |
| G2 | authoritative 计算器 review 只产生 retired `review_placeholder`；普通读零投影 | （本片无 authoritative 交付路径可触发） | 按锁：ordinary read 无行、history 可见 review、无默认 normal/零分钟投影 | 呈裁点 13：本片结构性不可达 | — | 不可达 |
| G3 | V1/missing/ambiguous/unresolved 不可 cast 为 V2 | builder 直调非法输入；或直接 INSERT `completed` 计算行但 attribution 非 `resolved_v2` | 闭码拒绝（单测 15/15）；存储层 CHECK 拒绝 | w4c2-frozen-attribution 单测 + gate-matrix-e5 leg 2 | `Run core-backend tests` + `attendance-real-db-integration` | 套件 |
| G4 | V2 冻结 absolute/attribution 窗口；事后改 tail/OT/assignment 不移窗 | 打卡产生 calc1 → UPDATE 班次定义 → 再打卡产生 calc2 | calc1 快照逐字节重读不变；calc2 窗口随新定义（正控）；对快照直接 UPDATE 被触发器拒（`W4C0_IMMUTABLE`） | posture-matrix 矩阵腿 4 | `attendance-real-db-integration` | 套件 |
| G5 | 同 org 异 user 与跨 org 隔离 | 同一 operation key 换 actor 重放；换 org 重放 | 同 org 异 actor：封闭 409、零 DML；跨 org：视为独立 operation | gate-matrix-e5 leg 3 | 同上 | 套件 |
| G6 | 伪造 witness / self override / 错误 scheduler capability / inactive membership 均先于 source/result SQL 失败 | 见 §3.3 malformed 4/7/8 | spread/JSON 克隆 witness：registry preflight 拒、零 SQL；self/token-subject 不匹配：mint 即拒；错误 capability：零 SQL；inactive membership：values-free 403 `ATTENDANCE_WRITE_NOT_AUTHORIZED`（复活后同一打卡可写 = 正控） | gate-matrix-e5 legs 5a/5b/5c/5d/5e | 同上 | 套件 |
| G7 | live `operationId` 各类 retry 一 event 一 result；同 key 异 evidence 409 | 同 `operationId` 重发同 payload；再改 outdoor-note payload 重发 | 重放：返回存储响应，恰 1 event + 1 result；异 evidence：409 | gate-matrix-e5 leg 4 | 同上 | 套件 |
| G8 | web decision UUID / verified channel 动作身份重放收敛到单一终态 | （approval 路由 cutover 属 W4C-3b） | 按锁：重放一个终态 approval/fact/result；response-only ID 变造失败 | 呈裁点 16：registry 协议面 W4C-0 已证（operation-registry / identity-gates 套件） | W4C-0 套件所在步 | 引用 |
| G9 | durable scheduled-run 重放跨重启存活；`skipDedup` 不可绕过 | 同参数二次 admin run | run1/run2 同 deterministic operation id，run2 零新 DML；W2-ambiguous user 零 parent/result；`skipDedup:true` 仍被 registry 去重。真跨进程重启腿未构造（呈裁点 17，标记可选加） | gate-matrix-e5 leg 9 | `attendance-real-db-integration` | 套件（部分） |
| G10 | outbox 行在 operation seal 之前插入；crash/重启/并发 dispatcher/emit 失败最终投递且不重复 source/result DML | shadow 打卡后查 SQL 顺序探针；起 dispatcher `runOnce`；双连接并发 claim | 生产路径过 seal-before-outbox 探针；drain 一遍投递全部 pending、二遍 claim 0；并发不重复投递 | gate-matrix-e5 leg 8 + outbox-dispatcher 套件 + posture-matrix 腿 5 | 同上 | 套件 |
| G11 | `legacy_projection_only` 下同一入口保持既有同步/尽力 emit，不产生 operation/calculation/outbox 行；posture split 两侧各自独立可失败 | legacy 姿态 org 打卡 | 响应与 legacy 基线同形；无 `operationId` / offset-less 的 legacy 打卡：W4 三表零行；带 `operationId` 的 stable-ID 打卡：产生 compatibility operation（`accepted_write_posture='legacy_projection_only'`），calculation/outbox 仍零行（gate-matrix leg 7 前半实测） | boundary 套件 legacy 短路腿（常驻）+ MD1–MD3（排他性属 mutation 证据） | 同上 | 套件 + mutation |
| G12 | P01/P02/P03/P04 四条 DML 债务台账独立移除；operation claim + suspension preflight 先于每个首次 source DML | 跑 collector 守卫；call-order 属 mutation 证据 | collector：四 marker 独立断言 + 排他集合通过 | collector 套件（MC5+MF4–MF6 四刀「恰 1 红」记录于 #4612 body）+ MC1/MC3 | `Run attendance W4C-0 Stage D §8.4 DML inventory collector` | 套件 + mutation |
| G13 | 变造 absence initiator 绕过 canonical writer / 恢复 P02 post-upsert 二次写，各有正控腿 | 内部 punch 触发 merge 翻转 | `attendance_records` 恰被写一次且落 merged 边界（leg 10 常驻）；绕过/恢复类变造属 mutation 证据（MC1、ME2/ME3） | gate-matrix-e5 leg 10 | `attendance-real-db-integration` | 套件 + mutation |
| G14 | scheduled 直插变造被拦 | `w4Boundary` 缺失时 scheduled 路径 | fail-closed（503 / logger.error 跳过，不落回直插）；「落回直插会被 suspended-org 行为腿抓住」属 mutation 证据（MC1）。注意 PR body 措辞精确化：拦截是行为级先决条件，非存储层 DML guard | boundary 缺失 fail-closed 腿 + MC1 | 同上 | 套件 + mutation |
| G15 | calculation-group 读路径变造被拦 | （W4C-2 边界/attribution 零处读 calculation_group 表，grep 复核零命中） | W4C-1 计算器闭集 schema：`calculationGroupId` → `input_schema_invalid` | 呈裁点 19：引用 W4C-1 既有 behavioral backstop | `Run core-backend tests` | 引用 |
| G16 | wildcard/missing/legacy/suspended 姿态不能启用 capability/计算器/引用 writer；移除任一共享 resolver 调用必失败 | 各姿态 org 打卡 / admin run | 非 shadow/eligible 姿态零 W4 行；probe 侧移除 = MF3a 恰 3 红（mutation 证据）；per-user re-check 侧 MF3b 0 红已被更正为「可证明的同事务冗余」，非覆盖缺口（NIT-1 更正） | 姿态腿散布于 posture-matrix / boundary / gate-matrix + MF3a | `attendance-real-db-integration` | 套件 + mutation |
| G17 | shadow/eligible promotion 被未完结 operation/batch/retryable job 阻塞；`accepted_write_posture` 不可静默 rebase | legacy→shadow 提升后同 key 重放；直接 UPDATE 该列 | 重放返回存储 legacy 响应（`toEqual` 全 body）；新 key 走 shadow（`accepted_write_posture='shadow'`）；直接 UPDATE 被拒（错误含 `W4C0_OPERATION_STATE`）。promotion writer 本身本片不交付（呈裁点 14） | gate-matrix-e5 leg 7 | 同上 | 套件（部分）+ 引用 |
| G18 | suspension 下 congruent completed 重放返回存储响应零 DML；missing/conflicting/incomplete 返回 suspension/conflict 且零写 | suspension 姿态下按 §3 场景重放 | 存储响应原样；异常态封闭码 + 零 DML | gate-matrix-e5 leg 7 + Stage C wiring 套件 | 同上 | 套件 |
| G19 | 并发 assignment/segment 编辑不能混指纹 | 双连接竞态：route 读后、canonical 事务前换 assignment/shift/tz（§3.2 组 B/C/D/D-overnight/G） | step-7 候选身份门：`review_required`/`context_mismatch`（组 G 为 `missing_frozen_context`），零 segment，legacy 投影完好；对照腿（无竞态）`completed` | p2-1-canonical-freeze-anchor 套件 + frozen-attribution 指纹敏感性单测 | 同上 + `Run core-backend tests` | 套件 |
| G20 | shadow 用 prepared legacy projection；prepare 后重入旧 writer 必失败 | shadow 打卡后核对投影来源 | legacy 投影 = prepared 那份；重入旧 writer 属 mutation 证据（MC3） | boundary 套件 + MC3 | `attendance-real-db-integration` | 套件 + mutation |
| G21 | W4 review 结果仍应用 prepared legacy projection；duplicate/DST review 不使 flag-OFF 投影过期 | review 场景打卡后读 legacy 投影 | legacy 投影与 prepared 完全一致、不因 W4 review 而变 | posture-matrix 腿 1/2 + p2-1 各 review 腿的 legacy-projection-intact 断言 | 同上 | 套件 |
| G22 | offset-less/legacy-only 业务时间三姿态矩阵；去掉任一侧独立失败 | 同一 offset-less 时间分别打进 legacy/shadow/eligible org | legacy：200 legacy 形状 + W4 三表零行；shadow：legacy 投影保留 + 恰一条 `review_required`/`legacy_time_ingress_not_authoritative`（零 segment、无 pointer、effect none、raw+legacy-parser provenance）+ sealed op + outbox pending 1；eligible：422 `W4_ATTRIBUTION_UNSUPPORTED`，claim 随事务回滚（零 operation 行；同 org 严格时间 200 = 正控） | posture-matrix 腿 1/2/3；排他性 MD1/MD2/MD3（mutation） | 同上 | 套件 + mutation |
| G23 | flag/state OFF 对外保持 legacy 投影/响应字节；shadow DB 证据仅存在于 shadow/eligible | legacy org 打卡逐字段比对响应；shadow org 查 W4 表 | 响应过 golden 递归 key-path + 显式值断言（`attendance-w4c2-golden-response.ts`）；legacy org W4 三表零行 | timezone-write-guard / posture-matrix / p2-1 的 golden 断言 + MF1/MF2（mutation） | 同上 | 套件 + mutation |

## 3. 固定 fixtures（合成数据）

命名纪律：一律随机 UUID（文件/会话级命名空间），名称前缀 `W4C2-QA-`，email 域
`@w4c2-qa.test`。任何字段不得使用真实 org/人员/设备值。共享库并跑禁裸 `Date.now()` ID。

### 3.1 基础 fixture kit（SQL 模板，与被测套件 helper 同形）

```sql
-- 用户 + org 成员
INSERT INTO users (id, email, username, name, password_hash, role, permissions,
                   is_active, is_admin, created_at, updated_at)
VALUES (:user_id, :user_id || '@w4c2-qa.test', :user_id, 'W4C2-QA fixture', 'x',
        'user', '[]'::jsonb, true, false, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO user_orgs (user_id, org_id, is_active)
VALUES (:user_id, :org_id, true) ON CONFLICT DO NOTHING;

-- 姿态行（state ∈ legacy|shadow|eligible|suspended，按场景选）
INSERT INTO attendance_calculation_rollout_state
  (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
VALUES (:org_id, 'shadow', 'w4c2-qa', 'QA_FIXTURE', 'w4c2-qa-actor', 1, NULL);

-- 班次（UTC，QA 场景默认非隔夜）
INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time,
                               work_end_time, is_overnight, working_days)
VALUES (:shift_id, :org_id, 'W4C2-QA-Shift', 'UTC', '20:00', '23:00', false,
        '[0,1,2,3,4,5,6]'::jsonb);

-- 指派（published + active，start=end=当日）
INSERT INTO attendance_shift_assignments
  (id, org_id, user_id, shift_id, start_date, end_date, is_active,
   publish_status, slot_index)
VALUES (:assignment_id, :org_id, :user_id, :shift_id, :day, :day, true,
        'published', 1);

-- 打卡时间线（route 面走 POST /api/attendance/punch；直插 events 仅用于预置历史证据）
-- POST body: { "eventType": "check_in", "occurredAt": "2026-07-19T22:00:00.000Z",
--              "timezone": "UTC", "orgId": ":org_id", "operationId": "<uuid>" }
```

env：`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` 必须包含该 org，姿态行才生效。
token：`GET /api/auth/dev-token?userId=<id>&roles=admin&perms=attendance:write`
（需 `RBAC_BYPASS=true` 的隔离环境；生产铸币纪律不适用于隔离库）。

### 3.2 场景组（与 p2-1 套件 fixture 同形，QA 可对照复现）

| 组 | 形状 | 用途 |
|---|---|---|
| A（drift/对照） | shadow org；shift UTC 20:00–23:00；指派 2026-07-19；打卡 22:00Z。drift 腿 client `timezone: 'Asia/Tokyo'`，对照腿 `'UTC'` | 冻结锚（PRE-resolution 输入）正确性；对照腿 `completed` |
| B（assignment 竞态） | shift A（UTC 00:00–04:00）与 shift B（UTC 22:00–06:00 隔夜）；route 读后另一连接把当日指派从 A 换成 B；变体 B2 预置 D-1 日 `check_in` 历史证据行 | G19 step-7 身份门 + 证据锚随重解析日 |
| C（tz-only 竞态） | 单 shift UTC 06:00–22:00；竞态只改 shift 行 `timezone` 列 | 身份不变、winner-timezone 变的半边 |
| D / D-overnight（shiftId-only 竞态） | 同日两个互相覆盖的 shift（09:00–17:00 vs 08:00–18:00；隔夜版 22:00–06:00 vs 21:00–07:00 同 `start_date`）；竞态换指派 shiftX→shiftY | 只换 `shiftId`（workDate 不变）的身份合取项 |
| E/F（零并发自观测） | 隔夜 shift UTC 22:00–06:00 属日 D；打卡 D+1 02:00Z / 03:00Z | outer/inner reasonCode 翻转的自观测探针（非竞态） |
| G（**malformed**，见 3.3-1） | 同 D 的双 shift 竞态，但两个 shift 各插**一条非稠密 `segment_index = 1`** 的 `attendance_shift_segments` 行（不插 index 0） | 双侧 frozen context 为 null → 指纹合取项结构性沉默 → 隔离身份合取项；预期 `review_required`/`missing_frozen_context` |
| 三姿态矩阵 | 同一 offset-less 业务时间分别打进 legacy / shadow / eligible 三个 org | G22 |
| admin_run 负例 | admin run 分别携带：内部 scheduler 身份作 adminActorId / 从未注册的 admin 身份 / cron 携非空 adminActorId / `adminActorId = null` | P1-4 legs A–D（mint/preflight 拒，零 DML；真实活跃 admin = 正控） |

### 3.3 故意 malformed fixture 清单（形状 + 理由）

1. **组 G 非稠密 `segment_index`**：每 shift 仅插 `segment_index = 1`（无 0 行）。
   在该表现行 CHECK/唯一约束下**合法可插**（CHECK 排除的是 `segment_index > 2`，不是非稠密集合
   ——#4612 gate4 P2 勘误确认，此前「不可构造」推论已被正式撤回）；
   `buildW4ShadowFrozenContextV1`（`index.cjs` ~L21451）拒绝 `segment_index !== 数组位置` 的
   段集 → 双侧 frozen context 为 null → 指纹合取项无信号，留下身份合取项作为该腿的
   排他判别子。若省略 segment 行，shift 会落回 legacy `work_start_time/work_end_time`
   单段回退产生非 null context——正是组 D 的形状，与组 G 必须区分。
2. **W2 二义指派**：同 user 同日两条重叠 published+active 指派——每行合法、组合语义二义，
   驱动 G1 的既有 legacy 422。
3. **offset-less 业务时间**：legacy-only 时间进入三姿态矩阵（G22）。
4. **伪造 witness**：真 witness 的 spread/JSON 克隆（对象身份伪造，非 DB 行）→ preflight 拒。
5. **同 key 异 evidence**：同 `operationId` 改 outdoor-note payload → 409（G7）。
6. **非 `resolved_v2` 的 completed 计算行直插**：存储 CHECK 负例（G3）。
7. **对不可变行直接 UPDATE**：计算快照 → 触发器拒（`W4C0_IMMUTABLE`，G4）；
   `accepted_write_posture` → 拒绝错误含 `W4C0_OPERATION_STATE`（G17，leg 7 实测）。
8. **admin_run witness 变形**：scheduler 身份 / null / 未注册身份（P1-4 legs A–D）。

## 4. 预期响应（outcome / outcome_reason_code / 关键投影）

闭集来源：锁 §6.1/6.2（`outcome` 恰为 `baseline|completed|review_required|reversed`；
理由码闭集见锁原文，此处只列本包场景用到的值）。

| 场景 | HTTP | DB 侧 outcome / reason | 关键投影断言 |
|---|---|---|---|
| shadow org 正常打卡（组 A 对照腿） | 200，legacy golden 形状（递归 key-path + 显式值，util `attendance-w4c2-golden-response.ts`） | `completed`（套件断言 `completed` 且 reason ≠ `context_mismatch`；completed 的合法配对按锁为 `calculated\|shadow_only`，QA 以套件断言为准，勿加码） | 恰 1 calc 行；operation `state='completed'` 且 `response_snapshot IS NOT NULL`；outbox pending ≥1 |
| 组 B/C/D/D-overnight 竞态命中 | 200（legacy 响应不受影响） | `review_required` / `context_mismatch` | 零 `attendance_record_segments`；legacy 投影完好；证据锚 = 重解析后的日 |
| 组 G（非稠密 segment） | 200 | `review_required` / `missing_frozen_context`（且断言 ≠ `context_mismatch`） | 零 segment；legacy 投影完好 |
| 竞态对照腿（B/C/D disarm） | 200 | `completed` | 证明竞态腿非 fixture 组装伪影 |
| 三姿态矩阵 leg 1（legacy + offset-less） | 200 legacy 形状 | 无 W4 行 | operations/calculations/outbox 对该 org 零行 |
| 三姿态矩阵 leg 2（shadow + offset-less） | 200 legacy 形状 | `review_required` / `legacy_time_ingress_not_authoritative` | 恰 1 条 review：零 segment、无 parent pointer、effect none、raw + legacy-parser provenance；sealed op；outbox pending 1 |
| 三姿态矩阵 leg 3（eligible + offset-less） | 422 `W4_ATTRIBUTION_UNSUPPORTED` | 零写（claim 随事务回滚） | 同 org 严格时间 200 = 正控 |
| 同 key 重放（G7/G17/G18） | 200，字节 = 存储响应 | 零新 DML | event/result 各恰 1 |
| 同 key 异 evidence | 409（`ATTENDANCE_OPERATION_CONFLICT` 族，values-free） | 零新 DML | — |
| 同 org 异 actor 重放 | 409 封闭码 | 零 DML | 跨 org 同 key = 独立 operation |
| inactive membership 打卡 | 403 `ATTENDANCE_WRITE_NOT_AUTHORIZED`（values-free） | 零 source DML | 复活成员后同一打卡 200（正控） |
| admin_run witness 负例（P1-4 A/B/C/D） | mint/preflight 拒（含 `W4C2_SCHEDULED_ADMIN_WITNESS_REQUIRED`） | 零 absence-adapter 调用、零 operation 行 | 真实活跃 admin 同参调用 claim+seal（正控） |
| 计算快照直接 UPDATE | SQL 错误（触发器 `W4C0_IMMUTABLE`） | 行不变 | — |
| `accepted_write_posture` 直接 UPDATE | SQL 错误（含 `W4C0_OPERATION_STATE`） | 行不变 | — |

错误/审计面 values-free 纪律：以上负路径响应只允许 code/enum/count，不回显用户值。

## 5. 数据库 residue 查询（测后必跑）

背景：本仓已两次因共享库残留造成假红（W4C-0 E1 scratch-DB FORCE drop 的 57P01 连坐，
#4608 修复；#4612 修复轮记录过一次 `attendance-plugin.test.ts` 因持久库残留状态误红）。
另注意：`attendance_records` 一旦挂有 calculation 即 **FK RESTRICT + append-only 触发器**
不可删——共享库跑过 W4 套件后无法「清干净」，这正是 §6 采用「整库 drop 重建」的原因。

`scripts/attendance/w4c2-qa/qa-residue-check.sql`（同仓交付）内容要点：

```sql
-- 1) W4 三表 + 计算面残留总量（隔离库测后应与测试自身写入量对账）
SELECT 'attendance_result_operations' t, count(*) FROM attendance_result_operations
UNION ALL SELECT 'attendance_result_operation_batches', count(*) FROM attendance_result_operation_batches
UNION ALL SELECT 'attendance_result_event_outbox', count(*) FROM attendance_result_event_outbox
UNION ALL SELECT 'attendance_record_calculations', count(*) FROM attendance_record_calculations
UNION ALL SELECT 'attendance_record_segments', count(*) FROM attendance_record_segments
UNION ALL SELECT 'attendance_request_calculation_snapshots', count(*) FROM attendance_request_calculation_snapshots;

-- 2) 未终结 operation（claimed 悬挂 = 泄漏信号；表 PK = org_id+entrypoint+operation_id，无 id 列）
SELECT org_id, entrypoint, operation_id, state, created_at
  FROM attendance_result_operations
 WHERE state <> 'completed' ORDER BY created_at;

-- 3) 未投递 outbox（drain 后应为 0）
SELECT count(*) FROM attendance_result_event_outbox WHERE delivery_state = 'pending';

-- 4) 孤儿检查
SELECT count(*) FROM attendance_record_segments s
 WHERE NOT EXISTS (SELECT 1 FROM attendance_record_calculations c WHERE c.id = s.calculation_id);
SELECT count(*) FROM attendance_record_calculations c
 WHERE NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.id = c.attendance_record_id);

-- 5) QA fixture 命名空间残留（合成数据标记）
SELECT count(*) FROM users WHERE email LIKE '%@w4c2-qa.test';
SELECT count(*) FROM attendance_shifts WHERE name LIKE 'W4C2-QA-%';
SELECT count(*) FROM attendance_calculation_rollout_state WHERE reason_code = 'QA_FIXTURE';

-- 6) 现处 legacy 姿态的 org 不得有 calculation/outbox 证据（G23 抽查）。
--    注意：legacy org 允许存在 compatibility operation 行
--    （accepted_write_posture='legacy_projection_only'，leg 7 前半实测），
--    故此处只查 calculation 与 outbox，另查「legacy org 名下出现
--    非 legacy 姿态 operation」这一真正的缺陷形状。
SELECT count(*) FROM attendance_record_calculations c
  JOIN attendance_records r ON r.id = c.attendance_record_id
  JOIN attendance_calculation_rollout_state rs ON rs.org_id = r.org_id
 WHERE rs.state = 'legacy';
SELECT count(*) FROM attendance_result_event_outbox e
  JOIN attendance_calculation_rollout_state rs ON rs.org_id = e.org_id
 WHERE rs.state = 'legacy';
SELECT count(*) FROM attendance_result_operations o
  JOIN attendance_calculation_rollout_state rs ON rs.org_id = o.org_id
 WHERE rs.state = 'legacy' AND o.accepted_write_posture <> 'legacy_projection_only';
```

判读：隔离库上「有残留」本身不是缺陷（append-only 设计使然）；缺陷信号是
2) 悬挂 claimed、3) drain 后 pending>0、4) 孤儿>0、6) legacy org 出现
calculation/outbox 行或非 legacy 姿态 operation 行。

## 6. 重置脚本（隔离库 建库 / 清库 / 重放）

同仓交付于 `scripts/attendance/w4c2-qa/`：

- `qa-db-reset.sh`：`dropdb --if-exists` + `createdb` + 按 §1.2 的 `MIGRATION_EXCLUDE`
  跑 `pnpm --filter @metasheet/core-backend db:migrate`。内置护栏：目标主机非
  `localhost/127.0.0.1` 直接拒绝（防误指共享/远端库）；库名必须带 `w4c2_qa` 标记。
- `qa-run-suites.sh`：对隔离库按 CI 同构参数整文件跑七个真库套件 + 两个单测文件 +
  两个 `node --test` 守卫；结尾自动跑 `qa-residue-check.sql`。
- 清库 = 重新执行 `qa-db-reset.sh`（整库 drop 重建；理由见 §5 append-only 说明）。

## 7. 薄弱环节自报（QA 使用本包前须知）

1. 「19」的重构（§2.1）是本包推测，未在任何权威文档找到同名清单原文。
2. G11/G12/G13/G14/G16/G20/G22/G23 的**排他性/判别力**证据一部分是 PR 作者一次性
   mutation 自检（MC/MD/ME/MF 系列，记录于 #4612 body），不是常驻 CI 腿——QA 复跑套件
   全绿并不重新证明这些排他性；表中已逐条标注。
3. G2（不可达）、G8/G15（引用前置切片）、G9 真跨进程重启腿、G17 promotion writer
   半边：本片无新证据，QA 无法在本包范围内测到。
4. 竞态组 B/C/D/G 依赖测试内 seam（`__setAttendanceW4LivePunchPreBoundarySeamForTests`）
   构造 rendezvous——QA 手工黑盒复现竞态窗口不可行，只能复跑套件。
5. §4 中 completed 的 reason 码本包未逐字 pin（套件亦未 pin），以套件断言为准。
6. 本包 SQL 模板由被测套件 helper 同形抄录，若 #4612 后续修复轮改动 helper 形状，
   需以新 head 重核 §3.1。
7. 脚本在本包交付时点仅做了 bash 语法与护栏路径自测（见 PR body 证据），未在
   全新机器上做端到端演练——QA 首跑若遇 `pnpm install`/postgres 版本差异
  （CI 用 Postgres 14），以 CI 步骤为准。
