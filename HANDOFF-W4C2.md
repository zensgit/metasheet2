# HANDOFF — W4C-2 live and scheduled shadow（阶段接力注记，不随 PR 交付内容变更）

分支 `claude/w4c2-live-scheduled-shadow-20260725`（base = origin/main `aebac4f8b`）。
真库：Stage A/B 用 `ms2_w4c2`；Stage C 第三棒基线/验证用**全新** `ms2_w4c2_relay3`（基线）
与 `ms2_w4c2_relay3b`（cutover 后），CI 同构 MIGRATION_EXCLUDE 全链迁移，postgres@127.0.0.1。

**状态总览：Stage A + B + C + D + Stage E（第五棒，commit `c44e18440`：§12.3 残余门矩阵
13 腿真库套件 + 两点接线补漏 + ME1-ME5 mutation）DONE。剩余：Stage F（mutation 汇总表 +
PR，body 呈裁点 1-15 全列）。**

---

## Stage E — §12.3 残余门矩阵（DONE，第五棒，commit `c44e18440`）

落点：**新 db 套件** `packages/core-backend/tests/integration/attendance-w4c2-gate-matrix-e5.db.test.ts`
（13 腿，route-level 真服务 + 少量 module-level 协议腿同库；已两点接线：plugin-tests.yml
attendance 步 + vitest.config.ts no-DB exclude。**同 commit 补了 Stage C/D 两套件
（live-scheduled-boundary / posture-matrix）漏加的 vitest exclude——两点接线补漏**）。

腿 → 锁 §12.3 门映射（详见套件头注释）：

1. **W2 ambiguity（live）**：两重叠已发布 assignment ⇒ 被**保留的 legacy 路由契约**
   （R5/OD-4556-8）422 `WORK_DATE_ATTRIBUTION_AMBIGUOUS` 拒于 boundary 之前，零
   event/record/operation/calculation/outbox（= fresh ambiguity 无 parent/result）；同 org
   单 assignment 正控 completed/calculated resolved_v2。**发现（映射修正）：live 侧
   「existing parent + ambiguous review」结构性不可达**——路由拒绝先于 boundary，freeze 内
   ambiguous 只在 route-resolution 与 in-trx re-resolution 分歧（并发 assignment 发布）时可
   达；unsupported→review 面由 matrix 套件（missing_frozen_context）+ w4c1 纯映射
   `ambiguous→context_resolution_ambiguous`（calculator spec ~L1034）+ E1 review-shape
   CHECK 三方合围。no-pointer 不变量改钉在 leg 9 的 scheduled review parent 上。
2. **V2 cast 存储 backstop**：completed + 非 resolved_v2 attribution 直接 INSERT ⇒
   `chk_arc_completed_shape` 拒（行为半面 = leg 1 ambiguous→unsupported；纯半面 =
   frozen-attribution 单测闭码拒）。
3. **same-org/cross-org isolation**：同 org 异 actor 同 key ⇒ 409
   `ATTENDANCE_OPERATION_CONFLICT` 零 DML（op 行 actor 不变）；异 org 同 key ⇒ 独立
   operation（PK = org+entrypoint+operation_id），互不可见。
4. **W4 shadow response-loss retry**：shadow strict punch（带 note meta）replay ⇒ 字节同
   response + 恰 1 event/1 calc/1 outbox/1 op；同 key 异 note ⇒ 409 零新 DML
   （legacy_compat 半面在 wiring 套件 leg 2）。
5. **forged witness 四腿**：(a) spread/JSON clone 伪 witness ⇒ preflight
   `ATTENDANCE_WRITE_NOT_AUTHORIZED` 且**零 SQL**（throwing+counting client——stub 失败点
   在守卫之内：若守卫没拦，观察到的是 stub 自己的 distinct error；真 witness 正控证
   counting 有判别力后 sentinel 回滚）；(b) self override / token-subject /
   scheduler-scope posture mismatch 三闭码在 **mint** 拒（无 SQL 面）；(c) scheduler witness
   带错 capability（punch）打 scheduled envelope ⇒ 零 SQL 拒，正确 capability 正控达 SQL 后
   回滚（零持久行）；(d) inactive membership route 腿：403 values-free、零
   event/record/op/outbox，membership 复活正控 200。
6. **authoritative fail-closed 双入口**：authoritative org（合法边走到）live punch 503
   `W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED` 零 DML（claim 随事务回滚）；admin absence run 同
   码 503 零行。**呈裁点 13（见下）：§12.3「authoritative calculator review ⇒ retired
   review_placeholder（普通读零行/history 有 review）」本片端到端不可达。**
7. **accepted_write_posture 不可静默 rebase**：legacy 下 seal 的 compat op → 合法
   legacy→shadow promotion（org 在 allowlist，即时生效）→ 同 key replay ⇒ 存储响应字节同 +
   posture 仍 legacy_projection_only + 零新 calc/outbox；**新 key 正控走 shadow 路径**
   （accepted_write_posture='shadow' + 1 calc——证 replay 腿非真空 legacy）；直接 UPDATE
   posture ⇒ `W4C0_OPERATION_STATE` 触发器拒。
8. **outbox before seal 严格序**：BEFORE UPDATE SQL-order probe 触发器（scoped
   `NEW.org_id = orderOrg AND NEW.state='completed'`，seal 时 outbox 行必须已在）——
   生产 shadow punch 在已装触发器下 200（序成立）；module-level claim+seal **不带 outbox**
   同 org 被同一触发器抓（`W4C2_E5_SEAL_BEFORE_OUTBOX`，probe 实弹正控）。
9. **durable scheduled replay + skipDedup + scheduled ambiguity**：admin run 两跑：run1
   generated 1 + 恰 1 scheduled op（`identity_source_kind='scheduled'`、
   `source_root_id == deriveAttendanceScheduledRunIdV1('admin_run',org,date)`、
   proof_user/date、actor=internal-scheduler）+ 恰 1 scheduled review calc
   （missing_frozen_context、零 children、parent 无 pointer）+ ambiguous user（两重叠
   assignment）reviewRequired `WORK_DATE_ATTRIBUTION_AMBIGUOUS` 且零 record/op/calc；run2
   generated 0、**同一 operation_id**、零新 DML。路由恒 `skipDedup:true` ⇒ in-memory key
   被绕情况下仍零 DML = registry 是唯一 dedup = 重启等价（全部判定输入 DB-resident；
   runId golden 已 pin）。**真跨进程重启未构造**（同进程双 server 不清 module state），
   等价性论证写入套件注释——Stage F/PR body 自报。
10. **P02 写次数判别腿（Stage C 呈裁点 7 清账）**：row-level audit 触发器（scoped
    mergeUser）计 attendance_records DML；fixture = 直插 outdoor_approval event+record
    （路由拒 reserved source，直插即 S3 writer 的自然形状）→ merge 开启
    （internalWinsOnIn，settings 快照/leg 内 PUT 还原）→ internal check_in 触发
    decision.changed ⇒ **恰 [UPDATE] 一次写** + first_in 翻到 internal 值（语义正控）+
    legacy org 零 op/calc/outbox。

### Stage E 实跑实数

- 新套件 13/13 绿（`ms2_w4c2_relay5` 全新库首跑；脏库复跑亦 13/13——套件自带
  per-run 随机 org/user 命名空间）。
- 单测面：w4c1 calculator 76/76（**P3-1/P3-2/P3-5 hardening 三腿逐名确认绿**）+
  frozen-attribution 15/15 + merge-policy + shadow-expected-differences，合计 108/108。
- tsc --noEmit exit 0；plugin-tests.yml YAML parse OK；index.cjs 本棒零改动。
- **CI 同构 attendance 步全量（全新库 `ms2_w4c2_relay5b`）：64 files / 789 passed**
  （= Stage D 776 + 本棒 13；零改写零红——字节红线证据；日志 scratchpad
  `w4c2-relay5-fullstep.log`）。

### Stage E mutation 记账（先 commit `c44e18440` 后 mutate，git checkout 精确路径还原，均实跑，diff 核对命中真代码行）

| # | 变异 | Flip set（实测） | 还原核验 |
|---|---|---|---|
| ME1 | boundary live：outbox enqueue 挪到 seal 之后（序反转） | **恰 1 红**（e5+matrix 两套件 18 腿合跑）：leg 8（probe 触发 punch 500）；matrix 全绿（其 outbox 断言只查存在性）——ORDER 判别独占 | git checkout 还原 |
| ME2 | index.cjs：changed 分支复活 append 第一写（P02 二写回귀） | **恰 1 红**：leg 10 写次数半面（audit [UPDATE,UPDATE]≠[UPDATE]） | 同上 |
| ME3 | index.cjs：merge decision neuter（恒走 append） | **恰 1 红**：leg 10 语义半面（first_in 停 00:30≠01:00）——与 ME2 翻不同断言 = 双侧判别 | 同上 |
| ME4 | boundary：scheduled runId 改 crypto.randomUUID()（毁决定性） | **恰 1 红**：leg 9（source_root_id 不匹配/op 增殖） | 同上 |
| ME5 | w4c0-authorization：actor membership recheck 恒跳过 | **恰 1 红**（e5+w4c0-registry 两套件 21 腿合跑）：leg 5d（200≠403）；registry 的 inactive-ACTOR 腿保持绿——membership 谓词独立判别 | 同上，还原后 tree clean |

### Stage E 呈裁点/薄弱点（续接 1-12，PR body 必列）

13. **authoritative review_placeholder 门本片不可达**：boundary 对 authoritative 全 fail-closed
    （`W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED`，本片有双入口零 DML 腿），且当前**没有任何
    read 路由过滤 `visibility_state`**（grep 零命中）——「普通读零行/history 有 review」的
    read-side 面归交付 authoritative 执行的后续片。PR body 必须 declare。
14. **promotion-blocked 门本片不可达**：sanctioned rollout transition writer 不存在（测试
    fixture 走 raw SQL 合法边），「promotion drains/blocks on incomplete op/retryable job」
    的运行时谓词随 promotion writer 交付；本片已证面 = posture 冻结不可 rebase（leg 7 双半
    面）+ E3 的 enqueue-vs-transition 锁序。PR body declare。
15. **live 侧 ambiguous-in-freeze 结构性不可达**（见 leg 1 映射修正）：并发 assignment 发布
    的 TOCTOU 窗口存在但需在单 HTTP 请求内注入——未构造；unsupported-review 面已由
    unresolved 味道 + 纯映射 + CHECK 合围。PR body 自报。
16. **web decision UUID / verified channel replay 诸腿**照第一棒架构判点 9：registry 协议面
    W4C-0 已证（operation-registry/identity-gates 套件），approval 路由 cutover 属 3b——
    PR body 引用而非重做。
17. **scheduled 重启等价未做真跨进程**（见腿 9 注）——论证：路由恒 skipDedup:true +
    全部判定输入 DB-resident + runId golden pin；若 owner 要真重启腿，构造 = spawn 子进程
    跑 run2（Stage F 可选加）。

### 接力者 TODO（Stage F）——较第四棒清单的增量

- ~~Stage E 全部残余腿~~ DONE（本棒；P02 写次数腿即 Stage C 呈裁点 7 清账）。
- Stage F：mutation 汇总表（MA1-2/MB1-2/MC1-5(部分)/MD1-5/ME1-5）+ PR（body 照
  #4606/#4607 形制 + §11.1 六项 + 呈裁点 1-17 全列 + §12.3 门→腿对照表——套件头注释
  已按门排布可直接摘）。PR 前 `rg -io "(close[sd]?|fix(es|ed)?|resolve[sd]?) #?[0-9]+"`
  自查 body。
- 注意：collector P01-P04「independently removed」的 per-marker mutation 只跑过 P01
  （MC5）；Stage F 若要满配可对 P02/P03/P04 marker 各补一刀（collector test 断言已按
  marker 独立铺，预期各恰 1 红）。

---

## Stage D — 姿态矩阵与冻结（DONE，第四棒，commit `21dc05110`）

落点：

- **修复 Stage C latent bug（矩阵腿抓出）**：boundary legacyOnlyTime 分支原把非闭集
  `{kind:'legacy_time_ingress',...}` 塞进 evidence 传给
  `computeAttendanceSemanticInputFingerprintV1` ⇒ `W4C0_EVIDENCE_SHAPE_INVALID` ⇒ 整个
  shadow offset-less punch 500（Stage C 无 offset-less 测试故未暴露）。修复：evidence 保持
  闭集空数组；raw + `legacy_parseDateInput_server_local` + resolvedInstant 冻进
  `input_provenance.legacyTimeIngress`；raw 字节仍经 attribution.sourceFingerprint
  （sha256(raw)）绑进 semantic fingerprint。落点
  `w4c2-live-scheduled-boundary.ts` legacyOnlyTime 分支（~L830-L870）。**PR body 须declare：
  锁文字「review carrying raw plus legacy-parser provenance」的存储落点选择 =
  input_provenance（evidence 闭集是 W4C-0 锁面，不单方扩）。**
- **dispatcher 生产接线（env-gate）**：index.cjs activate 内（annual-leave 注册块后）——
  `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` 非空 且 port.drainResultEventOutbox 存在
  才 `attendanceScheduler.registerJob({name:'attendance-w4-result-outbox-drain'})`；
  **注册本身被 gate**（区别于其它 dormant-run job）：无 env ⇒ 无 job 对象 ⇒ 字节不变。
  deactivate 反注册。tick 节奏归共享 attendance scheduler（ATTENDANCE_SCHEDULER_ENABLED，
  与其余 job 同姿势）。测试探针 `module.exports.__attendanceW4OutboxDrainForTests`
  （getState().gated + runOnce = 生产闭包本体非拷贝）。
- **新 db 套件** `tests/integration/attendance-w4c2-posture-matrix.db.test.ts`（5 腿，已进
  plugin-tests.yml attendance 步）：server 启动前设 exact-org env allowlist（shadow/eligible/
  freeze 三 org）+ 合法初始态 rollout 行（shadow 初始合法；eligible 走 shadow→eligible 边）：
  1. legacy 姿态 offset-less：200 legacy 形状 + 零 operation/calculation/outbox；
  2. shadow offset-less（stable-ID）：legacy projection 保留（event+record）+ **恰一条**
     mode='shadow'/entrypoint='live'/review_required/`legacy_time_ingress_not_authoritative`/
     effect='none'/expected_segment_count=0/context null/segment 子行 0/evidence []/
     input_provenance.legacyTimeIngress 全形状 + attribution unsupported+sha256(raw) +
     sealed op（posture='shadow'，双指针）+ response_snapshot==wire body + outbox pending 1；
  3. eligible offset-less：**正控先行**（同 org 严格时间 200 + 一条 shadow review
     `missing_frozen_context`）→ 拒绝腿 422 `W4_ATTRIBUTION_UNSUPPORTED`（message==code、
     raw 不回显）+ 零 event/record/calc/outbox + **claim 随事务回滚（零 operation 行）**；
  4. V2 freeze：真 shift+assignment（Asia/Shanghai 09:00-18:00）⇒ calc1 completed/calculated、
     attribution resolved_v2、absoluteWindow=01:00Z-10:00Z 精确 + attributionWindow 端=绝对端
     +冻结 tail（自洽断言，tail 源不 pin）→ UPDATE shift 端 19:00 → calc2 窗口端=11:00Z
     （正控：改动达及新解析）→ calc1 attribution_snapshot 逐字节重读不变（freeze）→
     直接 UPDATE snapshot 被 `W4C0_IMMUTABLE` 拒（存储层绝对冻结）；
  5. env-present drain：gated=true + runOnce（生产闭包）一遍投递全部 4 pending（org-scoped
     恰 4 断言 + global-anchored counts，脏库复跑安全）→ 二遍 claimed 0。
- **boundary wiring 套件追加 no-env 腿**（同片自有文件，additive）：beforeAll 显式 delete env；
  gated=false + runOnce reject `W4_OUTBOX_DRAIN_NOT_GATED` —— 与矩阵套件 env-present 腿构成
  排他对（MD4 证）。
- **新纯单测** `src/attendance/__tests__/w4c2-frozen-attribution.test.ts`（15 腿，default
  vitest include ⇒ 走 required 单测门）：freeze 语义（窗口=candidate 字面量；tail 改 60 ⇒
  END_UNEXPLAINED 而非移窗；OT 撤销 ⇒ END_UNEXPLAINED；缩窗拒；start/end 漂移 MISMATCH 分腿；
  DST gap start/end 分腿 + fold 拒；输入形状违规 throw 闭码——其中 offset-less approvedEndAt
  在下层 `AttendanceW4TimeError/W4C1_INSTANT_INVALID` 拒，per-layer 实态已 pin）；
  windowEvidenceFingerprint（requestId 排序不敏感 / tail/OT-identity/anchor 敏感）；
  scheduled runId（**golden pin**：cron/default/2026-07-22 =
  `3477855b-403c-5fa1-9268-eb21b45c44cb`、admin_run 同键 =
  `268051a3-3f83-5c14-a315-19e1d3265554`，独立 RFC-4122 v5 实现算出后 pin 为字面量，防
  namespace/推导序漂移破坏跨部署 durable replay；决定性/三键区分/v5 形状/闭集 initiator 拒/
  非 canonical org+date 拒）。scheduled runId 实现本身 Stage C 已落（boundary L124-L168），
  本棒补其判别腿；namespace 新常量呈裁点不变（原呈裁点 4）。

### Stage D 实跑实数

- **CI 同构 attendance 步全量（全新库 `ms2_w4c2_relay4b`，CI MIGRATION_EXCLUDE 全链迁移）：
  63 files / 776 passed**（= Stage C 766 + wiring 4（Stage C 期未入列）+ 本棒 6 新，文件数
  61+2 对账精确；零改写零红——字节红线证据；日志
  scratchpad `w4c2-relay4-fullstep.log`，红 error 行 = 注入故障套件预期输出）。
- 矩阵套件 5/5；boundary wiring 10/10（原 4 + no-env 1 = 5，两套件合跑 10/10）；
  frozen-attribution 单测 15/15；collector gate 14/14；mock-activation + attendance 模块
  spec 277/277；tsc --noEmit exit 0；node --check index.cjs OK。
- 基线库：`ms2_w4c2_relay4`（开发/调试）+ `ms2_w4c2_relay4b`（判别，全新）。

### Stage D mutation 记账（先 commit `21dc05110` 后 mutate，git checkout 精确路径还原，均实跑）

| # | 变异 | Flip set（实测） | 还原核验 |
|---|---|---|---|
| MD1 | boundary legacyOnlyTime 检测 neuter（`&& false`——把 legacy 解析瞬时当 W4 evidence，diff 核对命中真代码行） | **恰 3 红**：矩阵腿 2（review 形状不符）+ 腿 3（eligible 不再拒）+ drain 腿（pending 5≠4 记账）；腿 1/freeze 绿 | 还原后 5/5 |
| MD2 | legacyOnlyTime 分支 insertShadowCalculation 剥离（省略 shadow review） | **恰 1 红**：矩阵腿 2 独红（calcs 0≠1）——「omitting the shadow review fails independently」排他证 | 还原后（经 MD4 轮合跑）绿 |
| MD3 | eligible 拒绝条件放宽为 `if (legacyOnlyTime)`（shadow 也拒 legacy 写） | **2 红**：矩阵腿 2（422≠200）+ drain 腿（pending 3≠4）；**腿 3 保持绿** ——「rejecting the shadow legacy write fails independently」由腿 2 独立判别 | 还原后 clean |
| MD4 | index.cjs drain 注册去掉 env-gate 条件（无 env 也注册 worker） | **恰 1 红**（两套件 10 腿合跑）：boundary no-env 腿（gated true）；矩阵 env-present 腿绿——排他对成立 | 还原后 10/10 |
| MD5 | frozen-attribution END_MISMATCH 检查 neuter（`if (false && ...)`) | **恰 1 红**：单测 legacy-helper drift 腿（end 漂移铸出 V2）；14 绿（start 漂移腿仍拦） | 还原后 15/15 |

### Stage D 呈裁点/薄弱点（PR body 必列，续接 Stage C 呈裁点 1-7）

8. **legacy-time provenance 落点 = input_provenance**（非 evidence_snapshot）：evidence 闭集
   是 W4C-0 锁面（punch/approved_adjustment/scheduled_absence），legacy-only 值本就不可为 W4
   evidence；锁 §12.3「carrying raw plus legacy-parser provenance」未 pin 存储列。声明之。
9. **drain worker 双 env**：注册被 `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` gate，tick
   还需 `ATTENDANCE_SCHEDULER_ENABLED=true`（共享 scheduler 既有姿势）。生产开 shadow 时两个
   都要设——PR body/运维注记写明。
10. **矩阵套件对 env 的进程内假设**：posture per-request 读 env，套件全程保持 allowlist 设定、
    afterAll 精确还原；CI 每文件独立 fork 无泄漏。no-env 腿显式 delete env 后再 activate。
11. **drain 全局计数**：dispatcher 按设计全库扫；套件对本套件 org 恰-4 断言 + 全局锚定 counts，
    脏库复跑不假红（但判别仍应全新库）。
12. **freeze db 腿的 tail 不 pin**：attributionWindow 端用「绝对端+冻结 tail 自洽」断言（tail
    源为 org policy 默认 120，不锁死具体值）——移窗判别力在 calc2 正控 + 逐字节重读，不依赖
    tail 具体值。

### 接力者 TODO（Stage E 残余 + Stage F）——较第三棒清单的增量

- ~~Stage D dispatcher 生产接线~~ DONE（本棒）。
- ~~offset-less legacy time 三姿态矩阵~~ DONE（本棒，含 removing-each-side 独立判别 MD1-MD3）。
- Stage E 仍余：scheduled W4 durable replay（重启等价 = 二次 run 同 runId per-user replay 零
  DML + skipDedup 不可绕——runId 决定性纯腿本棒已铺，db 腿未铺）、forged witness 四腿
  （boundary 面）、TOCTOU 双连接、promotion blocked/accepted_write_posture 不可 rebase 的
  boundary 腿、P02 写次数判别腿（Stage C 呈裁点 7）、shadow strict-time punch 的 outbox
  before seal **顺序**断言（本棒证了存在性与 pending 态；严格序 = crash-between 构造，
  dispatcher 套件已有部分面）。
- Stage F：mutation 汇总表（MA/MB/MC/MD + 新增）+ PR（body 照 #4606/#4607 形制 + §11.1 六项
  + 呈裁点 1-12 全列）。PR 前 `rg -io "(close[sd]?|fix(es|ed)?|resolve[sd]?) #?[0-9]+"` 自查。

---

## Stage C — P01-P04 cutover（DONE，第三棒，commit `a1d13dd06` + wiring-test commit）

落点：
- **Boundary 重构** `packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts`：
  - executeLivePunch：org-key 预分类（非 canonical org = 结构性 legacy，零 strict parse/零
    witness/零新拒绝面）→ shared rollout lock + posture（suspension preflight 先于一切 DML）→
    null-ID+legacy 短路走 adapter（零 envelope/witness——这是 766 基线字节不变的关键）→
    stable-ID/W4 姿态走完整 W4C-0 registry 协议（replay-before-suspension 保持 7.1 语义）。
  - executeScheduledRun：同 org 预分类；probe 事务内 rollout lock+posture+legacy 批量 DML；
    witness 只在 W4 per-user 路径铸（probe 不再 recheck——非 canonical org 无法铸 witness）。
- **Plugin adapters**（index.cjs，module-scope，`generateAbsenceRecords` 前）：
  `applyLivePunchProjectionLegacyV1`（P01 逐字搬移 + **P02 lift**：port
  `applyMergePolicyPure`（w4c1-merge-policy 唯一源）先算 decision，`!changed`→单次 append
  upsert（与旧 #1 字节同）；`changed`→单次 override upsert（approvedMinutes+decision 边界，
  终态行值与旧两写等价）——第二次 mutable UPDATE 不再存在于 live 路径）+
  `resolveW4LiveCandidateInTransactionV1`/`resolveW4ScheduledCandidateInTransactionV1`
  （includeFullWinner）+ `buildW4ShadowFrozenContextV1`（shift+segments→FrozenContextV1，
  不可表达即 null→review）。
- **路由 cutover**：punch 路由（~L26600s）换 boundary 调用（emit 只在 legacy/legacy_compat
  kind；replay/w4 不直发）；`punchSchema` 增 optional `operationId`(uuid)；auto-absence
  admin 路由与 cron run loop 传 `w4Boundary`+initiator（'admin_run'/'cron'），boundary 缺失
  fail-closed（503 W4_WRITE_BOUNDARY_UNAVAILABLE / cron logger.error 跳过）。
  `runAutoAbsenceForOrgDate` DML 点：有 boundary 走 executeScheduledRun（suspended→
  `{skipped:true,reason:'segment_calculation_suspended',total:0}`）；**无 boundary 保留
  direct `generateAbsenceRecords(db,...)` 仅供裸模块消费者**（W2 db test 直接调 helpers，
  自带 db、无 host port——零改写纪律所迫；生产初始者不可达此分支，见呈裁点 6）。
- **W4 错误映射** `respondIfW4BoundaryError`（activate 内）：按 error.name 闭集 + code/
  httpStatus 映射，values-free（message=code）。
- **Resolver**：第二棒定义而未接的 `attachFullWinner` 已接到 live/scheduled resolved 返回
  （无 includeFullWinner 字节不变；由 766 基线复跑证得）。
- **core port**（index.ts ~L2040s + types/plugin.ts）：新增 `applyMergePolicyPure`。
- **Collector**：P01-P04 加 `canonicalizedBy: 'W4C-2'`（**title 字节不动**——test 2 的
  pinned-baseline 再生投影含 title，改了会红）；P01 claims 增
  `applyLivePunchProjectionLegacyV1`；`table-classification.cjs` W4_CANONICAL_PATH_PREFIXES
  增 `w4c2-`（修复 Stage B 遗留的 out-of-boundary 红——**Stage B 时 collector gate 在 HEAD
  上其实是红的**，第三棒接手时实测确认并修复）；collector test 增两条 additive 腿
  （四 marker 独立断言 + 排他集合 + adapter symbol 认领）。
- **Stage E 首批 wiring 腿** `tests/integration/attendance-w4c2-live-scheduled-boundary.db.test.ts`
  （4/4 绿，已进 plugin-tests.yml attendance 步）：legacy null-ID 零 operation/calculation/
  outbox；stable-ID legacy_compat claim+seal+congruent replay 零新 DML+同 key 异 payload 409；
  live/scheduled 两侧 suspension-precedes-DML 各配正控（legacy-state org 能写）。
  suspended fixture 走 rollout 状态机合法边 legacy→shadow→eligible→authoritative→suspended
  （持久 suspended 不依赖 env——posture seam 无视 allowlist 尊重 suspended）。

### Stage C 实跑实数（全部于全新库）

- 基线（cutover 前，`ms2_w4c2_relay3`）：attendance 步 61 files / **766 passed**。
- cutover 后（`ms2_w4c2_relay3b`）：61 files / **766 passed**（零改写零红——字节红线证据）。
- 新 wiring 套件 4/4；collector gate **14/14**（原 12 + 2 additive）；tsc --noEmit clean；
  node --check index.cjs + resolver clean；portless mock-activation 单测 66/66；
  resolver 单测+attendance 模块 spec 248/248。
- 脏库复跑警示再证实：`ms2_w4c2_relay3` 复跑 attendance-plugin.test.ts 时 auto-shift
  auto-write 腿假红（appliedCount 1≠0）——判别一律用全新库。

### Stage C mutation 记账（先 commit 后 mutate，git checkout 精确路径还原，均实跑）

| # | 变异 | Flip set（实测） | 还原核验 |
|---|---|---|---|
| MC1 | runAutoAbsenceForOrgDate 强制 `w4Boundary=null`（absence initiator 绕过 canonical writer） | **恰 1 红**：scheduled suspended 腿（suspended org 被直插 generated=1）；其余 3 绿（scheduled 正控腿在 direct insert 下同样能写，属预期） | 还原后 4/4 |
| MC3 | boundary executeLivePunch 强制 `rolloutKey=null`（live 全部按 legacy 处理，suspension preflight 不可达） | **恰 2 红**：suspended live 腿（200+写入=绕过签名）+ stable-ID 腿（422 W4C2_ORG_KEY_OUTSIDE_W4_DOMAIN）；legacy null-ID 与 scheduled 腿绿 | 还原后 4/4 |
| MC5 | 删 P01 的 `canonicalizedBy` marker | **恰 1 红**：collector marker 腿；13/14 绿 | 还原后 14/14 |

### Stage C 呈裁点/薄弱点（PR body 必列，接力者续）

1. **PUNCH_TOO_SOON vs stable-ID replay**：min-interval 节流在路由层先于 boundary，同 key
   同 payload 的立即重试会 429（间隔过后 replay 正常返回存储响应）。锁 12.3「response-loss
   retry returns one event and one result」严格读法下，keyed 重试或应绕过节流——**owner
   裁**。wiring test 用 settings 快照/精确还原把 minPunchIntervalMinutes 置 0 后测 replay。
2. **非 canonical org = 结构性 legacy**：rollout 表 org_id 无 canonical CHECK，理论上可被
   raw SQL 塞进非 canonical org 的 suspended 行，但 sanctioned transition writer 不存在且
   posture seam 本身拒绝非 canonical key——boundary 预分类与 W4C-0 姿态面一致。声明之。
3. **P02 lift 的极角落语义差**：manual_result_edit marker + merge 翻转边界恰好回到
   correctedAgainst 指纹时，旧两写会留下第一写挂上的 stale reviewConflict，单写不会。
   旧行为可论证为 bug；无现有测试覆盖（766 零红）。PR body 声明。
4. **holidayKind 传 null**（punch 路由 → shadow frozen context）：legacy 路径不受影响；
   shadow 保真度欠账，Stage E 铺 shadow 腿时补（resolveWorkContext 的 holiday 出参可用）。
5. **shadow+null-ID 拒绝**（W4C0_OPERATION_ID_REQUIRED）：W4 姿态 org 的无 key 客户端打卡
   会 4xx——rollout scope 限 synthetic_staging，真实流量不可达；W4C-0 registry 既有语义。
6. **裸模块 fallback**（runAutoAbsenceForOrgDate 无 boundary 时 direct insert）：为 W2 db
   test 直调 helpers 的零改写所迫；生产初始者（cron/admin 路由）boundary 缺失一律
   fail-closed 不达此分支，MC1 证明绕过会被 suspended 腿抓住。PR body 声明。
7. **P02 正控腿未铺**（「restoring the P02 post-upsert mutation fails its own
   positive-control leg」）：当前无测试能判别恢复第二写（终态等价）。Stage E/F 需铺
   判别腿——建议：merge-enabled fixture 下断言 attendance_records 行的写次数
   （statement-level trigger 计数或 xmax/cmax 探针）恰 1。**未竟**。

### 接力者 TODO（Stage D/E/F 残余）

- Stage D：dispatcher 生产接线（env-gate `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`
  非空才注册 drain 循环；无 env ⇒ 无 worker ⇒ 字节不变）。port `drainResultEventOutbox`
  已在（index.ts），只差 plugin activate 侧注册（attendanceScheduler.registerJob 姿势）。
- Stage E 残余：shadow 三姿态矩阵腿（env allowlist + shadow org 的 stable-ID punch ⇒
  calculation mode='shadow' projection_effect='none' + outbox before seal 断言）、
  offset-less legacy time 三姿态矩阵（legacy/shadow-review/eligible-reject 三腿 removing
  either side fails independently）、scheduled W4 durable replay（重启等价 = 二次 run 同
  runId per-user replay 零 DML + skipDedup 不可绕）、forged witness 四腿（boundary 面）、
  TOCTOU 双连接、promotion blocked/accepted_write_posture 不可 rebase 的 boundary 腿、
  P02 写次数判别腿（上呈裁点 7）。
- Stage F：mutation 汇总表（MA/MB/MC + 新增）+ PR（body 照 #4606/#4607 形制 + §11.1 六项 +
  本文全部呈裁点）。PR 前 `rg -io "(close[sd]?|fix(es|ed)?|resolve[sd]?) #?[0-9]+"` 自查。

---

（以下为第一/第二棒原注记，保留供追溯）

**原状态总览：Stage A + Stage B DONE（已 commit）。核心 cutover（Stage C-F）未开工——本文
§Plan 节是完整架构决定记录，接力 agent 从 Stage C 起工。**

---

## Stage A — #4607 门审移交批（DONE, commit `git log` 第 1 条）

1. **P3-1/P3-2/P3-5 三腿**追加进 `packages/core-backend/src/attendance/__tests__/w4c1-segment-calculator.test.ts`
   末尾新 describe 块（纯追加，零改写既有断言；76/76 绿）。P3-1 fixture 是自算的
   164+306=470 形状（门审建议的 165/305 在 per-segment rounding 下不排他——165 整除 15；
   我的 164/306 对 per-segment(450)/step30(450)/step10/5/none(470) 全排他，正确值 465）。
2. **shadow-diff 预期差异清单（P0）**：`w4c2-shadow-expected-differences.ts` + spec（4/4 绿）。
   唯一条目 `correction_applied_daily_adjusted`（W4C-1 裁量 #6：legacy computeMetrics
   ~L11369 只在 leave/OT>0 给 adjusted；W4 correction-applied 无异常日给 adjusted）。
   预期差异谓词 exact-shape fail-closed；W4 侧用真计算器证得（correction+零 leave/OT ⇒
   adjusted）；W4C-4 comparator 消费此 roster。
3. **P3-4 timezone 写入路由**：新 services port `attendanceW4SegmentCalculation`
   （core index.ts ~L2035，least-privilege 只发 plugin-attendance；类型在 types/plugin.ts）
   暴露唯一 strict IANA validator。plugin 侧 helper
   `respondUnlessStrictIanaTimezoneWrite`（index.cjs activate 内，emitEvent 定义后）+
   三处路由接线：PUT /rules/default、POST /shifts、PUT /shifts/:id。port 缺失且携带
   timezone 的写 ⇒ 503 fail-closed。新真库套件
   `attendance-w4c2-timezone-write-guard.db.test.ts`（8/8 绿，两点接线，随机 org 零共享态污染,
   `+05:00` 腿 = strict-vs-loose 判别）。
4. **P3-3 决定（二选一）**：选「接线处显式保证」——W4C-2 boundary 的 merge-policy lift 调用点
   必须先证 record 行存在（legacy 调用序 upsert 后 merge，等价流程中无记录行分支不可达）。
   **此保证落在 Stage C 的 boundary 代码 + 注释 + 一条断言腿；PR body 要写明选择理由**（不加
   `recordExists` 输入是为了不改写已落 main 的 w4c1-merge-policy 测试 fixtures——零改写纪律）。
5. 反建议照办：未为 `>2 matches` 加 stub Intl 腿。

## Stage B — outbox dispatcher（DONE, commit 第 2 条）

`w4c2-outbox-dispatcher.ts`：SKIP LOCKED 批量 claim → emit → 同事务 delivered 翻转；
at-least-once 通知、零 source/result DML；per-row 失败 containment（attempts 单调 +
线性 backoff `next_attempt_at`）；无自带 timer（调度归 caller，env-gate 姿势同 posture seam）。
真库 5 腿含 rendezvous 构造的真并发（两连接 SKIP LOCKED 扫描重叠证明）。
**生产接线未做**（归 Stage C/D）：建议在 core-backend 启动面（或 plugin activate 的
attendanceScheduler.registerJob）注册 drain 循环，用与 posture allowlist 同一 env
`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` 非空作为 gate（无 env ⇒ 无 worker ⇒ 字节不变）。

## 实跑实数（Stage A+B）

- calculator spec 76/76；shadow-diff spec 4/4；timezone guard 8/8（ms2_w4c2）；
  outbox dispatcher 5/5（ms2_w4c2）；tsc --noEmit exit 0；node --check index.cjs OK；
  plugin-tests.yml YAML parse OK。
- **CI 同构 attendance 步全量：61 files / 766 passed（753 基线 + 13 新 = 766，零红零改写）**
  于 ms2_w4c2（Stage B commit 后实跑，日志 scratchpad `w4c2-fullstep.log`）。日志内红色
  error 行是 import 套件的注入故障预期输出。复跑注意 W4C-0 handoff 未竟 43 的
  attendance-plugin auto-shift 共享库残留现象——脏库复跑该文件可能假红，用全新库判别。
- Mutation 自检（先 commit 后 mutate）：见下文 §Mutation 记账。

---

## Plan — 核心 cutover（Stage C-F，未开工；架构决定已定案如下）

### 已核实的地基事实（接力者不必重查）

- 插件 db = `context.api.database` = core 的 `poolManager`（同一 Pool）；plugin trx 有
  `__rawClient`（真 pg client）；plugin `db.query` 返回 rows 数组，registry 层要 `{rows}`
  ——boundary 内做双向 wrapper。
- W4C-0 API 全部可直接消费：`normalizeAttendanceSourceOperationEnvelopeV1`（live_punch/
  scheduled 的 payload 闭集校验 + registryInput）、`attendanceResultOperationPreflightV1`
  （四态：replay/suspended/claimed/legacy_no_operation；内部已做 witness 校验、SQL recheck、
  class-00 shared、resolver、class-10、锁下重读）、`seal/cancel/enqueueOutbox`、
  `runAttendanceResultOperationTransactionV1`（SERIALIZABLE + 合同超时 + 40001/40P01 有界重试）、
  `createAuthorizedAttendanceWriteContextV1`（host factory）、posture resolver。
- P01 站点：index.cjs `/api/attendance/punch` 路由 ~L26537 db.transaction（event INSERT +
  loadAttendanceRecordForUpdate + upsertAttendanceRecord + applyAttendanceInOutMergePolicy）；
  P02 = 同事务第二步 merge；P03 = `runAutoAbsenceForOrgDate` ~L21240 调 `generateAbsenceRecords`
  ~L21101（INSERT..SELECT NOT EXISTS）；P04 = `/api/attendance/auto-absence/run` ~L43165 同函数。
- calculations/segments 表的完整 CHECK 矩阵在迁移 zzzz20260725120000 ~L643-L900（completed 需
  attribution posture=resolved_v2 + context + count 1..3；review 全空 + effect none；shadow ⇒
  projection_effect='none'；`uq_arc_operation` 幂等 backstop；lineage 严格低版本 trigger）。

### 架构拍板（接力者照此实现，改动须在 PR 声明）

1. **boundary 属 core-backend TS**：新模块 `w4c2-live-scheduled-boundary.ts`（§8.1 的
   executeAttendanceResultOperation 面向 live_punch/scheduled 两 kind 的实现）。plugin 经
   既有 `attendanceW4SegmentCalculation` services port 拿到
   `createLiveScheduledBoundary({ legacyAdapters })` 工厂（activate 时一次性注入 legacy
   执行闭包——**不是 per-request callback**，与锁 §4.1「no route-provided source callback」
   相容：路由每次只提交纯数据 envelope）。
2. **legacyAdapters 形状**（plugin activate 时注入，全部收 plugin-shaped trx wrapper）：
   - `applyLivePunchLegacy(trx, args)` — 现 db.transaction 体逐字搬移（event INSERT →
     loadForUpdate → freeze V1 meta → upsert → merge lift）；args = 路由已算好的
     { userId, orgId, workDate, timezone, rule, eventType, occurredAt, source, location,
     meta, punchWorkDateResolution, isWorkday, settings }。**P3-3 显式保证落点**：merge
     调用前 record 必已由 upsert 存在（断言腿 + 注释）。
   - `applyScheduledAbsenceLegacy(trx, args)` — generateAbsenceRecords 的同字节 INSERT。
   - `resolveLiveCandidate(trx, args)` / `resolveScheduledCandidate(trx, args)` — §8.2 步 4/7
     的事务内重解析（复用 resolvePunchWorkDateByShiftWindow / resolveWorkContext /
     scheduledAdapters；shadow 分支用）。
3. **事务形状**：两阶段单事务——`runAttendanceResultOperationTransactionV1` 包整个 preflight
   +分支（legacy 分支也在 SERIALIZABLE 内跑同字节 DML；40001 重试 = 整事务重放，随机 UUID
   在闭包内生成）。若门审判 legacy 分支必须保持原 isolation，改为 preflight 探测后二次开
   plugin db.transaction——两读呈裁点，默认取前者（顺序测试下不可观测）。
4. **响应字节红线**：路由的响应组装保持逐字节（result.event/record/workDateResolution 形状
   不动；emitEvent 仍在路由 post-commit 同步发——legacy 分支不写 outbox）。
5. **scheduled run 身份（裁量，PR 必须声明）**：runId 决定性推导
   UUIDv5(新命名 namespace 常量, initiator("cron"|"admin_run") + NUL + orgId + NUL + workDate)；
   cron 与 admin 分 run（congruence 比 actor，同 run 异 actor 会 409 毒化）；
   `expectedRunVersion` 恒 1，`scheduledAbsenceSource` = initiator 常量。durable replay =
   registry 层（重启后同 runId ⇒ 同 per-user UUIDv5 ⇒ replay 零 DML）；`skipDedup` 只跳
   in-memory key，永不能绕 registry replay。legacy 姿态下 scheduled 全 null-ID（零 operation
   行，字节不变）；W4 姿态下逐 user 一个 scheduled 单命令 envelope（batch kinds 只有
   import/integration——Stage A 常量核实过）。
6. **shadow 分支序**（§8.2 步 3-16 的 live/scheduled 摘要）：claim 后 → legacy source DML
   （经 legacyAdapters，= prepared legacy projection 的执行）→ class-11 target 锁 →
   事务内重解析 attribution/context → V2 builder（见下）→ w4c1 calculator →
   calculation+segments INSERT（mode='shadow'、projection_effect='none'、outcome per §6.2）→
   outbox enqueue（**seal 前**）→ seal(item, response=路由响应快照)。
   W2 ambiguous / 姿态矩阵三腿 / offset-less legacy time ⇒ 按 §12.3 的 review/拒绝分支。
7. **V2 attribution builder**（最深的未决工程）：新模块 `w4c2-frozen-attribution.ts`。
   输入 = W2 winner 的完整 candidate（含 absoluteWindow/attributionWindow——resolver lib
   ~L659-L681 已构造但 public result 收窄丢弃；需给 resolver 加 opt-in 返回完整 winner 的
   additive 出参，零现行为变化）+ timezone + tail policy + OT windows。用 w4c1-strict-time
   重建每个边界（无 buildZonedDate/UTC fallback），与 candidate 窗口逐 instant 比对，
   不一致 ⇒ review_required；`windowEvidenceFingerprint` = canonical JSON hash（tail policy +
   OT window IDs/versions/anchors）。V1/missing/ambiguous/unresolved 永不 cast V2。
8. **collector curated 更新**（Stage D）：删 P01/P02/P03/P04 四条 debt entry；其站点
   （op/upsertAttendanceRecord/generateAbsenceRecords）改由新「canonical-adapter claim」类目
   认领（认领谓词 = 同 (relPath,symbol)，类目字段标 `canonicalizedBy: 'W4C-2'`）——
   unclaimed=0 检测不被绕；pinned baseline artifact 字节不动（其重生成只读 pinned ref）。
   注意 collector 测试第 2 条（byte-reproducible）不受影响，第 1 条（exact-head scan）需要
   新类目生效。`table-classification.cjs` 的 `w4_canonical` 路径前缀需加 `w4c2-*.ts`。
9. **§12.3 门→落点映射**（PR body 模板骨架）：live 三姿态矩阵/replay/posture split 双侧
   独立腿/claim+suspension 先于 first DML(call-order mutation)/scheduled direct-insert
   mutation/P01-P04 removal 对账/forged witness 四腿/promotion blocked+accepted_write_posture
   不可 rebase(可复用 E1/E3 已证面+新增 boundary 腿)/suspension replay 零 DML。
   「web decision UUID / verified channel replay」诸腿属 registry 协议面（W4C-0 已证）+
   3b cutover——PR body 引用而非重做，误差自报。

### Stage 顺序建议（接力）

- Stage C：boundary + V2 builder + plugin 四点 cutover（index.cjs 换调用 + adapters 注入）。
- Stage D：collector curated 更新 + dispatcher 生产接线（env-gate）。
- Stage E：真库门矩阵（三姿态矩阵逐腿/replay/TOCTOU 双连接/call-order mutation 腿）。
- Stage F：mutation 轮 + PR（body 照 #4606/#4607 形制 + §11.1 六项 + 薄弱环节自报）。

## Mutation 记账（Stage A+B 已跑部分；Stage F 汇总成表）

先 commit 后 mutate、`git checkout -- <精确文件>` 还原（全部已实跑，ms2_w4c2）：

| # | 变异 | Flip set（实测） | 还原核验 |
|---|---|---|---|
| MA1 | index.cjs 删默认规则路由的 strict 检查 | **恰 2 红**：default-rule 的 `+05:00` 与 `Not/AZone` 腿；6 绿（含 shift 全部腿 + 双正控）——排他 | git checkout 还原后 8/8 |
| MA2 | helper 改用本地 loose `isValidTimeZoneIdentifier` | **恰 3 红**：三条 offset-form 腿（rule `+05:00` / shift create `+05:00` / shift update `+08:00`）；`Not/AZone`/`Mars/OlympusMons` 腿保持绿（loose 也拒它们）——证明 offset 腿判别 strict-vs-loose | 同上 |
| MB1 | dispatcher SQL 去掉 `SKIP LOCKED`（**首刀误中 doc 注释 = 真空变异 5/5 绿，已察觉并重打到 SQL 行**——教训：mutate 后核对命中位置） | **恰 1 红**：并发腿 rendezvous 10s 超时；4 绿 | git checkout 还原后 5/5 |
| MB2 | dispatcher 不 emit 直接 delivered | **3 红**：crash-recovery（emitted 空）/emit-failure（poisoned 被假投递）/并发（ordinals 空）；2 绿（validation+wiring 腿不断言 emission，属预期） | 同上；两套件合跑 13/13 复绿 |

## 呈裁/薄弱点（PR body 必列）

1. P3-4 使默认规则/shift 的 timezone 写从「任意字符串静默入库」变为 4xx——sanctioned 行为
   变化（锁 §12.2 末句 + owner 把它列为 W4C-2 明写门）；`legacy_projection_only` 响应字节
   红线不覆盖该写入面（新增拒绝面 ≠ 已有响应变形）。
2. port 缺失 ⇒ 503 fail-closed 的姿势沿 S7 先例；非 core host 不存在，风险低。
3. dispatcher 的 at-least-once（emit 后 commit 前 crash ⇒ 重发通知）是有意读法——锁只禁
   重复 source/result DML。
4. scheduled runId 推导 namespace 是新常量（非锁文字面）——裁量呈裁。
5. Stage A/B 未动 P01-P04 站点——debt 移除对账在 Stage C/D 之后才成立；本阶段 PR 若先行，
   body 须明说 P01-P04 removal 未完成（或等 cutover 完成后一并开 PR——**建议后者**）。
