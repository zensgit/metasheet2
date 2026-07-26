# HANDOFF — W4C-0 contracts and durable storage（阶段接力注记，不随 PR 交付内容变更）

分支 `claude/w4c0-contracts-durable-storage-20260725`（base = origin/main `b5ff168e9`）。

---

## Stage A — schema/migrations + SQL 函数（DONE, commit `7fa801187`）

### 完成项与落点

单一迁移文件：
`packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts`

- 闭集常量（command entrypoints 12 / calc entrypoints 13 / item source kinds 13 / batch source kinds 2 / actor postures 7 / capabilities 8 / write postures 3 / op states 3 / outcomes 4 + reasons 25 含 pairing / merge policies 5 / tiers 2 / projection effects 3 / segment statuses 7 / segment reasons 11 / shadow diff codes 12 / rollout states 5 / visibility reasons 4 / execution reason codes 2）：文件头 ~L47-L240。
- SQL 函数：`attendance_w4_uuidv5(uuid,bytea)`（pgcrypto sha1、v5+variant 位）~L258；`attendance_w4_canonical_date_text` ~L280（to_char 只 STABLE，改 lpad/extract 全 IMMUTABLE）；`attendance_w4_item_name_bytes` / `attendance_w4_scheduled_name_bytes`（NUL=decode('00','hex')）~L293-L316；`attendance_w4_segment_reasons_valid`（非空/闭集/COLLATE "C" 字节序严格升序=sorted+unique）~L320；`attendance_w4_job_proof_vector_valid`（exact-key 4 字段、ordinal=下标、64hex、derivedOperationId 经 SQL UUIDv5 复推）~L350。
- §7.1 registries：`attendance_result_operation_batches`（PK org/entrypoint/batch_command_id，entrypoint=source_kind、batch_command_id=source_root_id）~L470；`attendance_result_operations`（PK org/entrypoint/operation_id，batch 复合 FK 复用 org/entrypoint 列 ⇒ 项-批 entrypoint 强一致；amendment §1.1 entrypoint↔source_kind 映射 CHECK；§1.3 per-source-kind proof shape CHECK「不多不少」；derived-ID CHECK 走 SQL UUIDv5 三 namespace；business snapshot 仅 import/integration item 且 completed 必填）~L500-L610。
- §7.1a outbox：唯一 (org,entrypoint,operation_id,event_kind)；identity/payload 不可变 + pending→delivered 单向 + attempts 单调 + DELETE/TRUNCATE 拒（`attendance_w4_outbox_update_guard`）。
- §7.2 snapshots：PK (org,request_id,version)；payload_fingerprint 有索引**非唯一**（A→B→A 合法）；FK (request_id,org_id)→attendance_requests(id,org_id)（本迁移补 `uq_attendance_requests_id_org`）。
- §7.3 calculations：全列 + 全部 CHECK（outcome/reason 配对、kind/outcome 配对、baseline 形状、reversal 需 supersedes、shadow effect=none、review 全空、completed 需 resolved_v2+context+count 1..3、authoritative completed→set_active）；partial unique `uq_arc_operation`、baseline unique `uq_arc_baseline`；lineage 严格低版本 BEFORE INSERT trigger（`attendance_w4_calculation_lineage_guard`）。
- §7.4 segments：unique (calculation_id,segment_index)、复合 FK RESTRICT、闭集 status/reasons；**双侧** deferred 计数 constraint trigger（calc 侧 + segment 侧）。
- §7.5 pointer：attendance_records 新增 4 列 + 5 CHECK + 复合 FK + `attendance_w4_records_pointer_guard`（owner/pointer 互锁、指针目标必须 authoritative completed/reversed、visibility 随 projection_effect/outcome_reason 匹配、W4-owned daily 字段=快照、不可回 legacy_untracked）；WHEN 子句保证纯 legacy 默认元组热路径**不触发**（byte-identical + 零成本）。
- §7.6：`attendance_current_records` 视图（仅 schema 面；零 consumer 切换）。
- §7.7：append-only 表 UPDATE/DELETE/TRUNCATE 全拒（共享 values-free deny fn）；registries DELETE/TRUNCATE 拒 + claimed→completed|canceled 转移守卫（完成后全列不可变）；deferred `claimed` commit 拒绝（重读当前行态，合法同事务 seal 通过）+ completed batch 的 item 计数 deferred 守卫。
- §7.9：`attendance_import_rollback_closures` unique (org,batch) append-only。
- §9：`attendance_calculation_rollout_state`（合法转移 trigger：INSERT 只许 legacy/由 legacy 入 shadow；UPDATE 按五条合法边 + prior_state=旧值 + version+1）+ `attendance_calculation_rollout_events` append-only。
- P07：attendance_import_jobs 15 个 w4_* 列；`chk_aij_w4_shape` null-all-or-V1-complete；proof vector CHECK 经 SQL 函数复推；`chk_aij_w4_exec_reason` 配对（SUSPENDED↔queued、POSTURE_CONFLICT↔failed、其余 null）；partial unique `uq_attendance_import_jobs_w4_reservation`；冻结字段 UPDATE trigger（version 永不可改，含 null→1）。
- down()：先数 11 类行（§11 列表 + 额外 rollout state 行与 V1 job 行，**有意更严**，防 DROP COLUMN 毁数据），任一 >0 在**任何 DDL 前**抛 `W4C0_DOWN_BLOCKED`；空则全量回收（视图→records 列→jobs 列→表→函数）。

Smoke 测试：`packages/core-backend/tests/integration/attendance-w4c0-durable-storage-smoke.db.test.ts`（7 用例）。
两点接线：`.github/workflows/plugin-tests.yml` ~L918 + `packages/core-backend/vitest.config.ts` ~L466。

### 实跑实数（本地 PG 15.17, 独立库 ms2_w4c0，MIGRATION_EXCLUDE 同 CI）

- fresh 全量迁移 → 成功（含本迁移）；up() 连跑两次（replay/幂等）→ 成功；空库 down() → 成功且 up() 复活成功（ms2_w4c0_cycle）；有数据 down() → `W4C0_DOWN_BLOCKED` 零 DDL。
- SQL UUIDv5 金标：v5(DNS ns,'www.example.com') = `2ed6657d-e927-568b-95e1-2665a8aea6a2` ✓。
- psql 负例逐条红（真实拒绝输出，非源码断言）：wrong derived-ID、cross-source 冒充（import UUIDv5 当 scheduled）、claimed commit、completed UPDATE/DELETE、paused state、partial V1 shape、eligible 入 posture、冻结字段 UPDATE、非法 rollout 转移、segment 计数缺失、pointer 指 shadow、daily 漂移、回 legacy_untracked、snapshot UPDATE。
- Smoke test 7/7 passed。
- 既有测试零改写、零红：CI attendance 步全量 34 files / 354 tests passed + 先行 3 files / 213 tests passed（含 attendance-plugin/result-edit/outdoor-punch/shift-segments 等）。tsc --noEmit 干净。

### 未竟 / 两读（Stage B-F 必读，禁静默跳过）

1. **outbox `chk_areo_event_kind` 是临时闭集**（attendance.punched / requested / request.updated / request.cancelled / resolved / outdoorPunch.requested 六种）。§7.1a 要求 W4C-0 生成 exact reachable event-kind/payload inventory —— Stage C/D 生成后必须回改本迁移的 `OUTBOX_EVENT_KINDS`（迁移未合入 main，可直接改同文件）。
2. **rollout state 初始 INSERT 规则是本阶段裁量**：锁只定义转移边，没写首行插入合法态。现实现：INSERT 只许 (legacy,prior=null) 或 (shadow,prior=legacy)，version=1。若门审认为「missing row=legacy、首插必须=shadow」或其它读法，改 `attendance_w4_rollout_state_guard`。
3. **projected_status 闭集不含 'off'**（与现行 attendance_records_status_check 对齐；§6.3 的 off 是非持久化非工作日语义）。若 W4C-1 计算器要落 'off' 投影，需同步扩 CHECK。
4. **baseline 的 context_snapshot / source_definition_fingerprint 被强制非空**（锁 §7.3 字面「nullable only for unsupported review」）。若 Stage C 实现 baseline 时拿不到 context V1，这是契约两读点，须呈裁而非放宽 CHECK。
5. down() 比 §11 列表**多查两类**（rollout state 行、V1 job 行）——有意 fail-closed 加严，PR 需在诚实偏离节声明。
6. segment reasons 排序 = COLLATE "C" 字节序升序；Stage B 的 TS 排序/校验器必须逐字节一致（ASCII sort），Stage E 金标对齐。
7. **deferred batch item-count 守卫要求 batch+items 同事务落**（smoke 测试第 3/4 用例即此形状）；Stage C registry service 的 claim/seal 实现必须单事务。
8. proof_user_id uuid / proof_work_date date 强类型：非 UUID 的 legacy user id 进不了 scheduled W4 身份（锁一致；Stage B parser 同样 strict）。
9. attendance_records 新列为 additive；index.cjs 内两处 `SELECT * FROM attendance_records`（~L19265 / ~L19960，FOR UPDATE 内部读）不外发原始行——Stage E 若可行补一条响应字节 sanity。
10. §7.6 的 exact-head SELECT inventory 与 §8.4 DML collector（P01-P28, pinned `e0defbe26`）都还没做（Stage D）；§12.1 其余 gates（并发/TOCTOU/advisory locks/replay 协议）归 Stage C/E。
11. 本地库保留给门审复跑：`ms2_w4c0`（含 smoke/psql 残留 fixture，append-only 表不可清属设计内）、`ms2_w4c0_cycle`（down/up 循环用）。drill 脚本在 scratchpad `w4c0-migration-drill.ts`（未提交，勿入库）。
12. Stage A 未跑正式 mutation 轮（归 Stage F）；但每道守卫都有真实红输出证据（上节列表），非源码文本断言。

---

## Stage B — TS 身份/锁层（DONE, commit `0192cb842`）

### 完成项与落点

单一模块（身份/锁/姿态共享 module-private WeakSet 见证注册表，故不拆文件）：
`packages/core-backend/src/attendance/w4c0-identity.ts`

- 修订 §1 closed factories/signatures 逐字：`VerifiedAttendanceOrgIdentityV1` / `VerifiedAttendanceOperationIdentityV1`（含 `sourceProof`）/ `VerifiedAttendanceCalculationTargetIdentityV1`（Opaque 冻结 null-proto 见证，WeakSet 成员即证明 ⇒ JSON clone/spread/prototype 替身/序列化全失效）；`createVerifiedAttendanceOrgIdentityV1` / `parseCanonicalAttendanceRolloutOrgKeyV1` / `createVerifiedAttendanceOperationIdentityV1` / `rehydrateVerifiedAttendanceOperationIdentityV1` / `createVerifiedAttendanceCalculationTargetIdentityV1`（~L470-L700）。
- 三 key builder 字节逐字（rollout `"…segment-rollout:v1\0"+orgId` 清顶两位=class 00；operation `"…result-operation:v1\0"+kind+"\0"+orgId+"\0"+entrypoint+"\0"+operationId` low62|0x8000…=class 10；target `"…calculation-target:v1\0"+org+"\0"+user+"\0"+date` low62|0xc000…=class 11；`BigInt.asIntN(64)` 二补码；01 永不产生）+ 三 acquisition helper（final-key 去重 + signed-bigint 数值升序、rollout helper=唯一 shared/exclusive 选择点、SQL 错误直传不吞、无 try-lock/timeout-to-continue）（~L700-L860）。
- closed source matrix 全 15 kind（`ATTENDANCE_OPERATION_SOURCE_MATRIX_V1`，9 direct + verified_delivery + import/integration batch/item + scheduled；kind/entrypoint 逐行钉死；derived 变体输入**无 id 字段**+exact-key 拒未知键 ⇒ 最终 UUID 不可由 caller 提交）。注：任务书「17 行」按修订 §1.1 表实为 15 行数据（与 Stage A 迁移 13 item+2 batch 常量一致）。
- 词法 pre-lock org parser（canonical UUID | 逐字节 `default`；大写 UUID 归一小写；`Default`/空白别名拒）与 post-lock verified-org factory 隔离：factory 只收 resolver 的 posture 见证 + 同一 orgKey（改 key 拒 `W4C0_ORG_KEY_CHANGED`；不从字面 `default` 推 legacy；`default`×`shadow|authoritative` 拒且 rehydrate（DB reload）路径同拒）。
- `resolveSegmentCalculationPosture(trx,orgId)` 单一 seam：§9 全表闭形（legacy/missing/wildcard-only→legacy_projection_only+preview；shadow/eligible→shadow（唯一 eligible→shadow 归一点）；authoritative→authoritative；suspended→blocked 且**无视 env fail-closed**）；exact-org allowlist 复用现 env `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`（`*` 永不算数）。**零调用方切换**；W3 shift-service 的 `SEGMENT_CALCULATION_IMPLEMENTED=false` 未触碰。
- rehydrator：exact-key 11 列 durable row（camelCase 镜像迁移列）→ 复推 factory → 与存量 operationId 比对（drift=`W4C0_IDENTITY_PROOF_DRIFT`）→ proof shape 不多不少（镜像 `chk_aro_proof_shape`）；`proofWorkDate` 只收 canonical string（JS Date 拒——node-pg date 解码时区相关，读方须 `::text`）。
- TS/SQL golden parity 钉死（双侧同字面）：UUIDv5 import=`e22b42e2-c607-50b4-8bcf-dcc383d15bc3` / integration=`c3bf2b78-8f9e-5b45-a441-772905c30e4e` / scheduled=`3e1fa29a-f411-5840-bed0-4c0f92c9f140`；signed key rollout(default)=`1320501217781065229`、rollout(org)=`2207163269983992351`、op item=`-9078275941089543826`、op batch=`-4625420971228601305`、target=`-4551290893819917091`。
- 测试：unit `src/attendance/__tests__/w4c0-identity.test.ts`（37 用例：修订 §2 门 1/2/3/4/5/6/8 的 unit 腿 + §9 posture 矩阵 + digest seam 护栏）；real-DB `tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts`（3 用例：三 namespace SQL 金标、随机 tuple TS↔SQL 一致 5 轮、helper 真锁 pg_locks classid/objid/mode + xact 释放）。两点接线：plugin-tests.yml attendance 步 + vitest.config.ts exclude（各紧跟 Stage A smoke 行）。
- 错误纪律：全部 `AttendanceW4IdentityError`，message=code 本身，values-free（unit 有断言腿）。

### 实跑实数（Stage B）

- `npx tsc --noEmit`（core-backend）干净。
- unit：`npx vitest run src/attendance/__tests__/w4c0-identity.test.ts` → 37/37 passed。
- real-DB（ms2_w4c0，Stage A 保留库）：`ATTENDANCE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/ms2_w4c0 npx vitest run --config vitest.integration.config.ts tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts` → 3/3 passed。
- 金标交叉验证：TS 脚本与 psql 双侧独立算出同一三 namespace UUIDv5（写测试前先钉，scratchpad `w4c0-goldens.mjs`，未提交勿入库）。
- plugin-tests.yml 改后 YAML parse ok。既有测试零改写（本阶段只新增文件 + 两点接线追加行）。

### 未竟 / 两读（Stage C-F 必读）

13. **resolver 的 implementation capability 取值是本阶段裁量**：模块常量 `SEGMENT_CALCULATION_IMPLEMENTATION_CAPABILITY=true`（语义=本片 storage+identity 层已在）。辩护：authoritative 需持久 authoritative 行——Stage A INSERT guard 只许 legacy/shadow 初始态且 W4C-0 无 transition writer，故 authoritative 不可达；shadow 需 exact-org env+持久行双门，默认零行为差。若门审要求 W4C-0 期间常量=false（与 W3 同姿势），改一行即可但 unit 矩阵需注入面。呈裁点。
14. **非法/降级持久态的 fail-closed 方向是裁量**：持久 shadow/eligible/authoritative 但 capability/allowlist 不满足 ⇒ 解析为 legacy 行（env 单独不 advertise 的镜像）；唯 suspended 永远 blocked（环境不可解除 suspension）。锁只给「Effective state requires 1-8」清单没写不满足时的落点。呈裁点。
15. resolver 未验证 §8.2 锁序（class-00 须先持有）——那是 Stage C 边界职责；resolver 仅在 trx 上读状态。同样 §9 效验条件 4-8（legal transition/pending request/null-version job/rollback closure 扫描）属 transition writer（后续片），resolver 本片只组合 capability+allowlist+persisted state+scope。
16. helper 尚无 `W4_ADVISORY_HELPER_WAIT_MS`/lock_timeout 预算与 55P03→closed-code 映射（§12.1 multi-key deadline leg）——归 Stage C 常量契约 + Stage E 并发腿。当前 helper 无 timeout=无限等待，Stage C 须在事务层设预算。
17. ordinal 上界钉在 int4（`ATTENDANCE_W4_MAX_ITEM_ORDINAL=2147483647`）对齐迁移列；5000 批量上界（W4C-R26）归 Stage C。
18. segment status_reasons 的 TS 校验器（COLLATE "C" 字节序，见第 6 条）本阶段未做——归 Stage C/W4C-1 写入面。
19. Stage B mutation 轮归 Stage F；点名腿：advisory 前缀字节改一字节→金标红；class 位互换→范围断言红；去重/排序删除→order 腿红；WeakSet 检查删除→forgery 腿红；rehydrate 比对删除→drift 腿红；`default` 门删除→gate1 腿红（各自已有排他断言）。
20. unit 测 posture 用 stub trx（resolver 是 seam 的纯组合逻辑）；真库 posture 行为（真 rollout 行 + resolver）建议 Stage E 加一条 db 腿（现仅 golden-parity db 测通过 resolver 读了空状态）。→ **Stage C 已部分覆盖**：registry db 测在真 rollout 行（shadow）+ exact-org env 下走 resolver 全链。

---

## Stage C — registry service 接口层（DONE, commit `748894d50`）

### 完成项与落点

六个新模块（全部零调用方接线；production route/worker 无一 import）：

1. `packages/core-backend/src/attendance/w4c0-operation-contract.ts` — §7.1 六常量**一次导出**（5000/5000/180000/5000/=LOCK_TIMEOUT/2，unit 钉死字面值）；closed 操作层 code→HTTP 映射表（409/503/422/403）+ values-free `AttendanceW4OperationError`（message=code，lockClass 只在 helper busy 上出现）；OUTBOX_EVENT_KINDS 的 TS 镜像（与迁移字面同步义务见未竟 1）。
2. `w4c0-identity.ts`（增补）— §7.1 helper-wide monotonic deadline 协议进三个 acquisition helper：入口一次定 deadline=now+W4_ADVISORY_HELPER_WAIT_MS，每 final key 前 `set_config('lock_timeout', remaining, true)`、acquire、后再查 deadline；只有 helper 自己 acquisition 的 55P03/预算超时映射 typed busy（rollout→503 ROLLOUT_BUSY / operation→409 IN_PROGRESS / target→503 TARGET_BUSY），其它 SQL 错误原样传播；成功后恢复 5000ms；module-private test clock seam（`__setAttendanceW4MonotonicClockForTests`，非测试运行时 fail-closed，与 digest seam 同姿势）。另加 `deriveAttendanceOperationCandidateIdentityV1`（pre-lock 候选推导，无 witness 无权威——§7.1「pre-lock read may derive candidate identities but confers no authority」）与三个 witness verifier 导出。
3. `w4c0-fingerprints.ts` — 严格 canonical JSON（sorted keys；undefined/NaN/class 实例/symbol 键全拒）；**域分隔**的 command / item-sequence（有序）/ item-set（无序）/ business-key 指纹；§4.2 evidence/fact 闭集比较器（timed→(occurredAt,direction,kind,ref)、untimed 殿后；fact 按 kind rank→request→snapshot v/fp→approval v→business time→record id；0/1 元素数组也逐条校验）；§4.3 `computeAttendanceSemanticInputFingerprintV1`（exact 9 键；内部自排序 evidence/facts ⇒ caller 顺序不可影响 hash；attribution 投影**剔除 resolvedAt**）与 `computeAttendanceProvenanceFingerprintV1`（13 transport 闭集；per-variant required/forbidden 矩阵）。
4. `w4c0-authorization.ts` — `AuthorizedAttendanceWriteContextV1` host factory（deep-copy、null-proto 冻结、WeakMap<object,digest> 注册）+ `verifyAuthorizedAttendanceWriteContextV1`（每次用前重算 digest + `crypto.timingSafeEqual`；spread/JSON clone/形状仿造/plain-object 全 403）；capability↔entrypoint 12 行闭集矩阵 + `requireAuthorizedCapabilityForEntrypointV1`；`recheckAttendanceAuthorizationInTransactionV1`（users.is_active + COALESCE(activation_status,'activated') + user_orgs.is_active；platform_admin 只豁免 actor membership，不豁免 subject）。
5. `w4c0-source-commands.ts` — §4.1 变体矩阵 12 kind 严格 validator（unknown-key 拒；闭 enum：direction/approve|reject/web|verified_delivery/frozen_prior|current_policy/set|unset/4 种 import transport）；envelope 归一 = null-proto 深冻结 + **同步**算 command/item-sequence/item-set 指纹（async 前完成 ⇒ 调用方 post-entry 变异无效，unit 有腿）；operationId/correlationId 不进 command 指纹（response-loss 重试保持 congruent；verified_delivery 的 action 在 payload ⇒ 进指纹）；scheduled 禁 caller 提交 operationId；输出直接给出 registry 层输入形状。
6. `w4c0-operation-registry.ts` — 核心生命周期：`attendanceResultOperationPreflightV1`（§8.2 步 1-2：verify witness+capability+org 绑定 → SQL recheck → **non-locking stable-order read**（all-completed-congruent 即零 DML replay，含 suspended 下）→ class-00 shared → resolver → suspended 零 DML 返回 → post-lock org/identity factories → class-10 exclusive → 锁下重读严格分类：replay / all-new claim（batch 先、items 按 operation_id 序、state='claimed'）/ mixed·incomplete·non-congruent=closed 409）；congruence= actor_id/actor_posture/token_subject/capability/subject_scope(canonical json)/source_ref/command_fingerprint 字节等值，accepted posture **不**比较（rollout 转移后重试返回存量）；`seal`（item/batch，batch response=order vector+byItem，键集与 attach 项严格对账）/`cancel`（source-free）/`enqueueAttendanceResultEventOutboxV1`（legacy posture 拒）/`reserveAttendanceImportJobW4V1`（P07：class-10 → operation+batch 排他 recheck → job FOR UPDATE congruent→existing / 不同→409 / 无→INSERT 完整 V1 shape+proof vector（ordinal=index，SQL CHECK 复推）；**零 operation row**）/`runAttendanceResultOperationTransactionV1`（SERIALIZABLE + 合同超时 + 只 40001/40P01 有界重试）。
7. `w4c0-write-boundary-types.ts` — §8.1 四签名 + §4.1/4.2 prepared-plan/intent/evidence/fact/projection-directive 全形状**纯类型**逐字转写（execute/prepare/apply/writeBatch 的实现属 W4C-1/2——W4C-0 只交付 interface，见未竟 21）。

测试：unit `src/attendance/__tests__/w4c0-operation-layer.test.ts`（23 用例）；db `tests/integration/attendance-w4c0-operation-registry.db.test.ts`（8 用例：单命令 claim→seal→replay→payload/actor 漂移 409、batch 全生命周期+重排/缺项冲突、legacy null-ID 零行/stable-ID 兼容 op replay+outbox 禁、cancel、claimed 不可提交（deferred 经 service 行触发）、P07 reservation 三态、deadline busy 映射+lock_timeout 恢复、inactive actor SQL recheck 拒）。两点接线：plugin-tests.yml attendance 步（紧跟 Stage B 行）+ vitest.config.ts exclude。

Stage B 同片测试的 3 条 helper 调用形状断言按 deadline 协议更新（set_config 交错 + 恢复值 5000 断言；**main 上既有测试零改写**——这 3 条属于本分支 Stage B 自己的新测试，handoff 第 16 条本就指派 Stage C 改 helper）。

### 实跑实数（Stage C）

- `npx tsc --noEmit`（core-backend）干净。
- unit：`npx vitest run src/attendance/__tests__/w4c0-identity.test.ts src/attendance/__tests__/w4c0-operation-layer.test.ts` → **60/60 passed**（37 Stage B + 23 Stage C）。
- real-DB（ms2_w4c0）：`DATABASE_URL=… ATTENDANCE_TEST_DATABASE_URL=… npx vitest run --config vitest.integration.config.ts` 三个 w4c0 db 文件 → **18/18 passed**（Stage A smoke 7 + Stage B parity 3 + Stage C registry 8）。注意 smoke 用 `src/db/pg` ⇒ 必须同时给 `DATABASE_URL`（只给 ATTENDANCE_TEST_DATABASE_URL 会连默认库红；CI 步两个都设，无问题）。
- CI 同构 attendance 步全量（56 文件，per plugin-tests.yml 实际清单）：**711/712 passed**；唯一红 = `multitable-durable-startup-failclosed.db.test.ts` 的 S1（真 MetaSheetServer.start 起服套件，批跑资源竞争），**standalone 复跑 8/8 绿**，且本 diff 零触碰 multitable/server 启动面——判定环境 flake，Stage F 发 PR 前建议再批跑一次留证。

### 未竟 / 两读（Stage D-F 必读）

21. **§8.1 execute/prepare/apply/writeBatch 是类型声明非实现**：完整编排需要 W4C-1 计算器 + W4C-2/3 私有 adapter。W4C-0 「canonical authorization/write/enqueue interfaces with no caller cutover」按「接口 + 可实现的内部协议（preflight/claim/seal/replay/congruence/enqueue 已实现）」读。呈裁点：若门审认为 execute 需要一个 W4C-0 内的 walking skeleton（空 adapter registry），在 registry 模块上加薄壳即可。
22. **capability↔entrypoint 矩阵 12 行配对是本阶段裁量**（锁只给两个闭集没给配对）：request_* 4 kind→approval_apply、integration_batch→import，其余一一对应。呈裁点。
23. **provenance per-variant required/forbidden 矩阵是裁量读**：artifactSha256 required={csv_upload,xlsx}、normalizedCsvSha256 required={csv_text,csv_upload,xlsx}、sheetName required={xlsx}、sourceRef 全 variant required。呈裁点。
24. **12 kind payload 字段级 allowlist 是 §4.1 表 prose 的裁量固化**（字段名/长度上限/嵌套 object 的 deepFreeze 不逐键校验——requestWrite/patch/location/meta 等仍是「plain-JSON 深冻结」而非逐键 allowlist；「exact normalized request-write allowlist」的逐键版本需要对现有 request-write 面的盘点，建议归 W4C-3 请求线切片或呈裁）。
25. **canceled 行的重试语义 = fail-closed 409**（锁未写明 canceled 键重试落点；现读法：cancel 是有意放弃，同键重试 conflict，需新 command ID）。呈裁点（db 测有此腿）。
26. **单 envelope 内 null-ID 与 stable-ID 混合 + 已有存量行 ⇒ 409**（null-ID 命令无从证明其已执行，不可参与 replay 集）；W4 posture 下 null-ID 直接 `W4C0_OPERATION_ID_REQUIRED`。
27. **command 指纹域**：kind+subjectUserId+payload（不含 operationId/correlationId/orgId——org 在行键、correlation 属审计）。congruence 另比 actor/token/subject_scope/capability/source_ref 列。若门审要求 correlationId 进 congruence，改 fingerprintCommand 一处。
28. P07 reservation 要求 items 的 org witness 与 batch 是**同一对象引用**（同事务同 resolver 铸造）；proof vector ordinal=数组下标（迁移 SQL CHECK 复推），env/参数注入不进。
29. **outbox event-kind 清单仍是临时六种**（未竟 1 未消化）：Stage D 生成 reachable inventory 后须**三处同步**：迁移 `OUTBOX_EVENT_KINDS`、`w4c0-operation-contract.ts` 的 TS 镜像、（若变）db 测 fixture。
30. deadline 协议的多 key 累计预算腿（§12.1 multi-key deadline leg：第一把 <5s + 第二把令累计超 5s）与 helper-origin 双腿 mutation（预算在 query 前耗尽 / 最后 acquisition 后耗尽分别独立红）归 Stage E/F；Stage C db 测只证：单 key 争用→closed code、成功→恢复 5000ms、55P03 不外泄。
31. Stage E 的两连接 first-claim 真并发矩阵（§8.2：first-holder 预算内 commit→waiter 拿存量响应；超预算→waiter 409 IN_PROGRESS 零额外 DML）尚未做——Stage C 的 preflight 已按「锁下重读」结构支持，直接对 `attendanceResultOperationPreflightV1` 双连接驱动即可。
32. §8.4 DML collector（P01-P28, pinned `e0defbe26`）+ §7.6 SELECT inventory 仍归 Stage D（未竟 10 不变）。
33. 本地复跑口诀：三个 w4c0 db 文件要 `DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 双设（见实跑注记）；registry db 测每 run 随机 org/op id，append-only 残留属设计内。

---

## Stage D — §8.4 DML inventory collector + CI 接线（DONE, commit `d6e6e5200`）

### 完成项与落点

六个新模块（`scripts/attendance/w4c0-dml-inventory/`，纯静态分析工具，零运行时接线）：

1. `table-classification.cjs` — 闭集 attendance-owned 表→bucket 映射（`business`/`schedule_fact`/
   `shared_hook` 三类需逐 debt-ID 认领；`operational`/`reference` 两类 bucket 级放行；
   `w4_canonical` 类=Stage A 九张新表，仅 canonical adapter 路径前缀（`src/attendance/w4c0-*.ts` +
   W4C-0 迁移文件）内的写入放行，其余路径命中一律 `outsideBoundary` 硬失败）。
2. `collector.cjs` — 根发现（读 `pnpm-workspace.yaml` + 每包 `package.json`，非手写单插件路径，
   § 8.4「Paths come from workspace/package manifests」逐字落实；额外命名根 `scripts/`= 锁文本
   自己点名的「operator scripts」，非单插件替身）+ 逐行正则 DML 扫描（INSERT/UPDATE/DELETE/
   TRUNCATE/MERGE INTO/COPY/staging CREATE|DROP|ALTER TABLE，大小写敏感——本仓真实 SQL 全大写，
   验证过大小写不敏感会把英文注释「update a record」当命中）+ SQL 保留字误命中过滤
   （`ON CONFLICT...DO UPDATE SET` 的裸 `SET` 不算表名）+ migrations 目录内 CREATE/DROP/ALTER
   跳过（schema DDL≠staging-table 运行时生命周期，INSERT/UPDATE/DELETE 仍扫）+ 最近前驱声明启发式
   symbol 归因（route 注册/具名函数/const 箭头函数，逐行倒扫取最近命中；**非 AST，明文声明为启发式**）
   + 50 行粗粒度 block 去重（同名小助手函数在文件内多处复用时避免误并——见「未竟」）+ debt key
   （bucket::relPath::table::verb::symbol::block，**不含裸行号**，符合门审建议「行号入 hash 会让
   守卫一周内被关」）。
3. `sources.cjs` — 双源适配器：`createWorktreeSource`（真读工作树，供 exact-head 检查）与
   `createGitRefSource`（`git ls-tree`+`git show <ref>:<path>`，只读指定 ref，从不碰工作树，供
   pinned baseline 生成/复验）。
4. `curated-debt-entries.cjs` — P01-P28（锁 §1.1 逐字转写）+ X01-X05（本次扫描发现但 §1.1 表未
   单独点名的额外 debt，§8.4 原文预期「generator 会发现更多」）+ 非 attendance 通用共享函数
   allowlist（`AfterSalesApprovalBridgeService`/`test-approvals-contract.mjs`/`seed-approvals.ts`/
   泛化 approval-bridge 迁移——明确判定为其它产品线可达，非 attendance 判别项，§8.4「cannot be
   banned globally」原文落实，非静默丢弃，manifest 里可见）。每条 debt 用 `(relPath,symbol)` 谓词
   认领，P03/P04 与 P01/P10 按锁 §1.1 line 92 原文故意共享同一站点（同函数两个 initiator=两个
   debt ID）。
5. `classify-tracked-sites.cjs` — 用 curated 谓词对 tracked 站点分类；零谓词命中且不在通用共享
   allowlist 上 = unclaimed = CI 失败。
6. `generate-baseline-manifest.cjs` — CLI（`--ref` 默认 `e0defbe26d7f2e1747e74aa908ca710422812bf7`，
   `--out` 默认 `docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json`），只读给定 git
   ref 生成 pinned manifest；生成前先跑 unclaimed/unclassified/outsideBoundary 三道零容忍检查，任一
   非零直接 `process.exit(1)`，不会把带 gap 的 manifest 写盘。

已提交数据制品：`docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json`（33 条 debt
entry 的 `id/title/owningSlice/sharedHook/confidence/siteCount/tables/symbols/contentHash` +
`runtimeRoots`（13 个工作区包 + `scripts`）+ `genericSharedAllowlist`（9 站点）+ 顶层
`manifestContentHash`）。**诚实偏离**：锁 §8.4 原文要求该 artifact 作为「独立 docs/data-only
commit，先于任何 W4C-0 运行时变更」；本分支 Stage A-C 已先落地（新增文件，未改现有调用路径）。
manifest **内容**仍只由 `git show <ref>:<path>` 生成、与工作树无关（可复验），但 commit 顺序确实
偏离锁字面顺序——如实记录，未回改历史。

CI 接线（单点，见 §7 说明）：`.github/workflows/plugin-tests.yml` W3 shift-segments 步之后新增
「Run attendance W4C-0 Stage D §8.4 DML inventory collector」步，`node --test
scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs`。

测试：`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs`（node:test，12 用例）——
(1) exact-head 工作树扫描零 unclaimed/unclassified/outsideBoundary；(2) pinned baseline artifact
从 ref 重新生成后与已提交文件**逐字节**相等（防手改）；(3) ref 字面量钉死 = 锁文本原字符串；
(4)-(9) 六个 positive control（plugin 直写 bypass / core-backend 新路由无 discriminator bypass /
shared-approval 未列名路径 bypass / operator-script 未列前缀 bypass / 对 canonical 表的越界 COPY /
对 `attendance_records` 的抢跑 COPY FROM STDIN——§8.4 原文点名的两个专门 positive control 之一）；
(10) MERGE INTO + 运行时 staging CREATE TABLE 语法类都被扫描器识别；(11) canonical boundary 助手
与 classifier 判定一致；(12) 本文件自身在 workflow 里有显式执行点（W1 契约测试同款自证模式）。

### 实跑实数（Stage D）

- `node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` → **12/12 passed**
  （耗时 ~21s，主要是 pinned-ref 重生成那条测试的 `git show` 调用量）。
- YAML 语法：`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/plugin-tests.yml'))"`
  → OK。
- Mutation 自检（先 commit `d6e6e5200` 后 mutate，`git checkout -- <file>` 精确路径还原，非
  `git checkout -- .`）：
  1. `curated-debt-entries.cjs` 删除 P01 对 `op` symbol 的认领 → `exact-head HEAD scan` 与
     `pinned baseline artifact is byte-reproducible` 两条独立翻红，其余 10 条（含全部 6 个
     positive control）保持绿——证明「零 unclaimed」判据是真判别，不是与旁路守卫共用失败原因。
     还原后 12/12 复绿。
  2. `collector.cjs` 的 `isCanonicalBoundaryPath` 改为恒 `true` → 仅 `raw COPY into a W4
     authoritative table from outside the boundary fails` 与 `canonical boundary helper agrees
     with the classifier` 两条翻红，其余 10 条（含另外 5 个 positive control）保持绿——证明
     canonical-boundary 判据独立于 unclaimed 判据，两道门互不掩护。还原后 12/12 复绿。
- 既有测试零改写：本阶段只新增 8 个新文件 + workflow 追加一步；未改动任何既有 `.ts`/`.cjs` 运行时
  文件，未跑全量回归（该证据已由 Stage A-C 的 711/712 + standalone 8/8 建立，本阶段未触碰任何
  legacy 调用路径，故不重复整轮跑；HEAD 扫描本身即是「零 legacy DML 变化」的机器证据——tracked
  站点数 224 与 baseline 完全一致，仅新增 5 个 `w4_canonical` 站点）。

### 未竟 / 两读（Stage E-F 必读，禁静默跳过）

34. **enclosing-symbol 归因是启发式，非 AST**：最近前驱声明正则会把「小助手闭包在文件内多处复用」
    误并到同一 symbol（例：`dataTypeFor`/`isAnomaly` 在 plugin 文件里各出现 5 次/1 次，语义上属于
    不同调用点）。50 行 block 粗粒度 tiebreaker 缓解了「完全不相关站点被同一 debt 吞并」的最坏情况，
    但**不是**证明；`generate-baseline-manifest.cjs` 的 `symbols`/`tables` 字段已如实反映谁被合并
    进哪个 P0x，供门审对照。collector 本身的测试/handoff/PR body 都需明说这条，不能被读成「已 AST
    级证明每条 debt 归因正确」。
35. **P02/P07/P08/P19-P25 是零 claim 记录条目**（无法从本扫描器的正则语法独立定位其 DML 站点，或
    本就不是 DML 形状的债务——P19 权限矩阵缺口/P20 读路径/P21 时区解析/P23 rollback 授权姿态/P24
    dry-run 记录属 operational bucket 放行/P25 本身就是「operational bucket 放行」这条规则的文字
    来源）。这些条目留在 manifest 里是「记录以待将来定位」而非「已验证零剩余债务」——门审若要求更
    精确定位，需要 AST 级 collector（見 34），非本阶段范围。
36. **X01-X05 的 owningSlice 是本 session 判断，非权威分配**（`W4C-3b (unconfirmed)` 标记），特别是
    X04（年假/调休台账写手族）与 X05（`AttendanceExpiryService` 到期扫）— 这两组是否该单独立项
    还是并入既有台账相关切片，需 owner 或后续切片 owner 确认；不确认不影响本阶段 CI 判据（它们已
    被 curated 谓词认领，不会被判 unclaimed），只影响未来「谁来 canonicalize 这条债务」。
37. **测试文件/fixtures 完全不在扫描范围内**（`EXCLUDED_PATH_SEGMENTS` 排除 `__tests__/`/`tests/`/
    `test/`/`__fixtures__/`）——这是本阶段明确收窄的范围声明，不是疏漏：§8.4 提到的「fixtures that
    first prove zero operation/snapshot/calculation history」允许生产 fixture 写入，但真实
    `*.test.ts` 内的 seed/cleanup 直接 INSERT（例如 `attendance-plugin.test.ts` 等集成测试建 fixture
    行）体量极大且与「生产 DML 债务」目标不同源，本阶段选择不纳入。若门审要求纳入，需要新增
    「测试 fixture 债务」bucket 与其自身 zero-history 断言(该断言本阶段也未实现)，工作量不小，建议
    作为独立子任务而非塞进本片收尾。
38. **仅扫描 `.ts/.js/.cjs/.mjs/.sql/.sh` 六种扩展名**；多行拼接的 SQL 字符串（`INSERT INTO` 关键字
    与表名分属不同物理行）不会被逐行正则捕获——这是逐行扫描器的已知限制，本阶段未见此仓库内有此
    写法（已核实 P01-P28+X01-X05 全部命中均为单行），但不保证未来代码不会引入。
39. **大小写敏感扫描**是刻意选择（见 collector.cjs 注释），若未来任何 attendance 写手改用小写/
    混合大小写 SQL 关键字，本 collector 会静默漏检——这是显式声明的已知盲区，不是隐藏假设。
40. `attendance_import_jobs` 的 P07 W4 字段写入（Stage C `w4c0-operation-registry.ts` 的
    `reserveAttendanceImportJobW4V1`）落在 `operational` bucket（表级放行，非逐站点 debt），与
    `w4_canonical` 边界检查（仅约束 9 张新表）是两套独立机制——没有交叉验证「W4 字段写入只能来自
    canonical adapter」；若门审认为这条也该有边界收紧（防止未来非 canonical 路径直接 UPDATE
    `attendance_import_jobs` 的 W4 列），需要把该表拆成「legacy 列=operational / W4 列=需边界」的
    列级而非表级 bucket，本阶段判定为过度工程（Stage A 的 DB 层冻结字段 trigger 已经在数据库层面
    拒绝非法写入，见 Stage A 完成项），未做。
41. §8.4 还点名「an exact-head generated inventory of all single/sequence reference guards」
    （锁 L2231 附近，§7.8 predecessor/preimage 相关）与「§7.6 的 exact-head SELECT inventory」——
    这两项不在本阶段 P01-P28/§8.4 collector 范围内（本阶段只做写入面），归 Stage E 或未来读面
    切片，Stage C 未竟第 10 条已标注同一缺口，此处不重复展开。
42. Stage F 若要对本阶段做完整 mutation 轮，建议额外覆盖：`table-classification.cjs` 删除一条
    `w4_canonical` 映射（应触发 `unclassifiedTable`）、`SQL_RESERVED_NON_TABLE_WORDS` 删除 `SET`
    （应在 baseline 重生成时冒出假 debt「SET」表）、`isMigrationPath` 恒 false（migrations 内
    schema DDL 会被误判为 tracked，`unclaimed` 增多）——本阶段验证了两条最核心判据（P01 claim 删除
    + canonical boundary 恒真），未逐一穷举以上三条，如实声明留给 Stage F。

---

## Stage E1+E2 — DB gates + identity gates（DONE, commit `c802811e5`）

### 完成项与落点

两个新真库测试文件（各自两点接线：plugin-tests.yml attendance 步紧跟 Stage C 行 +
vitest.config.ts exclude 注释块）：

**E1 `packages/core-backend/tests/integration/attendance-w4c0-db-gates-e1.db.test.ts`（20 用例）**
— §12.1 DB 门全条：

- 迁移生命周期（测试自建 scratch database `ms2_w4c0_e1_<run>`，最小 legacy 副本表只含迁移
  DDL/触发器引用的列；行为矩阵全部跑在主库真实 schema 上，副本仅驱动 DDL 生命周期——测试注释
  已明示）：fresh+upgrade（up() 覆盖既存 legacy job/record 行 → 逐字节保留 + W4 shape 全 null）、
  up() 连跑幂等、空表 down() 全量回收（表/函数/列/约束全消失 + legacy 行逐字节保留）+ up() 复活、
  populated down() 对 **V1-job 与 rollout-state 两类**（补 smoke 的 registry 类）pre-DDL 拒绝且
  零 DDL；
- 不可变面全表扫（snapshots/calculations/segments/closures/rollout events 各 UPDATE/DELETE/
  TRUNCATE；registries DELETE/TRUNCATE/CASCADE、paused 拒绝、非法转移、completed
  response/fingerprint 不可变；rollout state 合法边正控 + 非法边/prior/version/identity/初始态/
  DELETE/TRUNCATE 全拒）。TRUNCATE 腿用 rollback-only helper（守卫被 neuter 时也不会真清共享库，
  腿仍翻红）；
- deferred 约束 transaction-bound 腿：同事务 claim+seal 提交成功（**若约束被改 immediate 则
  INSERT 即炸——这是判别腿**）、未 seal claim/batch 提交拒、注入回滚零行、source-free cancel
  裸 SQL 腿；batch/segment 双侧计数守卫（不足/超额/**事后补插额外 child 在其自身 commit 翻红**、
  review 行零 child）；calculation insert 后注入失败 → 无 child/pointer/projection；
- pointer 门（set_active 正控、drift、visibility mismatch、shadow/review 目标、跨 org FK、
  authoritative 清指针拒、set_retired reason 匹配正/负 + §7.6 视图不可见性）；lineage
  strictly-older/missing/cross-record 拒 + `uq_arc_operation` retry 幂等 backstop；snapshot
  A→B→A 三版本 + 重复 version + 篡改拒；outbox 状态机全腿（非法 kind/重复键/非法转移/
  attempts 单调/delivered 终态）；closure 唯一性；
- P07 全条：冻结字段矩阵（**含 legacy null→1 promotion 拒**）、execution_reason_code 闭集配对
  五腿、legacy 行不可带 reason、partial shape 两腿补充、proof-vector CHECK 矩阵（乱序/重复/
  缺/多/篡改 root/错 namespace/多 key/缺 key 八腿 + 零行落库断言）、**两真连接 reservation
  backstop 双 commit 序**（holder 回滚 → waiter 锁下重读后 created；holder 提交 → 同 job
  existing；全程 23505 不外泄 + 裸 SQL bypass 正控证 unique index 真实存在并以 23505 命名
  `uq_attendance_import_jobs_w4_reservation`）、changed-actor 409、**legacy-only batch root 的
  reservation 必须 created**（null-version job 不满足 W4 replay）；
- 触发器姿态扫（全部 trg_a% ON attendance_% 的 tgenabled='O'，声明为弱判别，见未竟 46）+
  两点接线自证腿。

**E2 `packages/core-backend/tests/integration/attendance-w4c0-identity-gates-e2.db.test.ts`
（10 用例）** — 修订 §2 八门逐条真库腿（unit 腿在 Stage B 文件）：

- 门1：rehydrator（=DB reload 面）default×{legacy OK 正控 / shadow 拒 / authoritative 拒 /
  eligible 值直接 W4C0_WRITE_POSTURE_INVALID}；真持久 eligible 行（shadow→eligible 合法转移
  fixture）经 resolver 归一 shadow；JSON 序列化毁 witness；**DB CHECK 腿**：裸 SQL default+shadow/
  authoritative 在 operations/batches/jobs 三面各自被 `chk_aro/arob/aij_w4_default_org_posture`
  拒 + default+legacy 正控落库；
- 门2：六个有序跨 namespace 冒充（import↔integration↔scheduled 全对称）逐条
  `chk_aro_derived_identity` 拒 + integration/scheduled 正确 namespace 正控落库（import 正控在
  smoke）；
- 门3：SQL tuple 逐字段突变（root/ordinal/fp/namespace/user/date）UUID 全不同、NUL 分隔符
  load-bearing（无 NUL 拼接 ≠ 有 NUL）、正确 UUID 配错 tuple（ordinal 0 的 UUID 报 ordinal 1）拒；
- 门4：json-clone/spread/prototype-lookalike/plain-object 四伪造 → builder 拒 + acquisition
  helper **零 SQL**（计数 wrapper trx 断言 issued=0）+ 真 witness 同 client 正控过锁；
- 门5：三 source family（import_item/scheduled/verified_delivery）真落库→worker 形状 reload
  （`proof_work_date::text`）→ rehydrate → 真锁验证 builder-grade；漂移矩阵十腿（opId/ordinal/
  fp/root/date/user/ledger-root/多 proof 字段/缺 proof 字段/JS Date）各自精确错误码；缺 key/多 key
  → DURABLE_ROW_INVALID；P07 vector reload 逐条经 factory 复推 + 换 fp 篡改 → PROOF_DRIFT；
- 门6：三 namespace SQL 金标字面（与 Stage B parity/unit 同字面）；
- 门7：unknown kind（接受 chk_aro_source_kind|chk_aro_entrypoint_source_pair 二名——未知 kind
  构造性同时违反两 CHECK，PG 报哪个先到；测试注释已说明）、非法 scalar 组合六腿（direct 多
  root/scheduled 缺 user/import_item 缺 ordinal（带 business snapshot 隔离 shape CHECK）/
  scheduled 带 ordinal（**正确 derived ID** 隔离 shape CHECK）/verified_delivery root≠id）+
  零行落库；
- 门8：rollout helper 词法再验（'Default'/前后空白/braces/URN 五腿零 SQL）、大写 org UUID 与小写
  同 key、posture witness 必需（浅拷贝拒）、org-key-changed、字面 'default' 配 shadow witness →
  ORG_KEY_CHANGED（posture 永不来自 org 字面）、candidate（pre-lock 推导）被 builder+helper 拒
  零 SQL、大写 client UUID → 同 identity 同 key；+ 两点接线自证腿。

**迁移文件两处声明性加固**（同文件 `zzzz20260725120000_...ts`，未合 main 可直改；down() 同步）：

1. `chk_aro_default_org_posture` / `chk_arob_default_org_posture` / `chk_aij_w4_default_org_posture`
   —— 修订 §1.2 「default with shadow|authoritative fails before operation or source DML」落到
   DB 边界（防绕过 factory 的裸写手）；对现存运行时行字节惰性（legacy 行全 null 安全通过）。
2. `attendance_w4_operation_items_commit_guard`（AFTER INSERT DEFERRABLE 于 operations）——
   completed batch 计数守卫的 **item 侧镜像**：事后对已 completed batch 补插额外 item 只有
   item 侧触发器能看见（batch 侧守卫只在 batch 行自身 INSERT/UPDATE 时触发）。正常 claim→seal
   事务不可见（commit 时 batch completed 且计数相等）。

### 实跑实数（Stage E1+E2）

- `npx tsc --noEmit`（core-backend）干净。
- E1：`DATABASE_URL=… ATTENDANCE_TEST_DATABASE_URL=… npx vitest run --config
  vitest.integration.config.ts tests/integration/attendance-w4c0-db-gates-e1.db.test.ts`
  → **20/20 passed**（ms2_w4c0）。
- E2：同法 → **10/10 passed**。
- 五个 w4c0 db 文件同跑 → **48/48 passed**（smoke 7 + parity 3 + registry 8 + E1 20 + E2 10）。
- w4c0 unit 两文件 → **60/60 passed**（Stage B 37 + Stage C 23，零改写，仍绿）。
- **CI 同构 attendance 步全量（58 文件，加入 E1/E2 后的 workflow 实际清单）在全新 CI 形库
  `ms2_w4c0_e1fresh`（fresh CREATE DATABASE → 全链 db:migrate with CI MIGRATION_EXCLUDE →
  单次整步）→ 742/742 passed, 58/58 files。**
- plugin-tests.yml YAML parse OK。
- 既有测试零改写（本阶段只新增 2 测试文件 + 迁移加固 + 两点接线行）。

### 未竟 / 两读（Stage F 必读，禁静默跳过）

43. **共享脏库上 attendance-plugin.test.ts 的 auto-shift 块不可复跑**（与本 diff 无关的既有
    现象，三重证据链）：该套件在固定 org 'default' 上创建 `attendance_scheduler_scopes`
    active 行与 'Auto Shift%' shifts（本地 ms2_w4c0 已积 91 个）且从不回收；同库第二次跑
    「scheduler_scope_forbidden」前置即被残留 scope 破坏（appliedCount 1≠0）。全新库上整步
    单跑 = 742/742 全绿；同一全新库先 standalone 后整步 = 又红（standalone 自己制造了残留）。
    CI 每 run 新建库不受影响。**门审在 ms2_w4c0 复跑该文件前须先
    `UPDATE attendance_scheduler_scopes SET is_active=false WHERE created_by='integration-test'
    AND subject_ref='system:attendance-auto-shift'`，且期望 auto-shift 三用例可能仍因 shift
    残留翻红——用 ms2_w4c0_e1fresh 或重建库复跑才是有效证据。**
44. **两处迁移加固是本阶段裁量**（完成项节已述理由）：default-org CHECK 是修订 §1.2 字面往 DB
    边界的下沉（rollout state 表本身未加 default 限制——default org 的 rollout 行仍可入库，
    但其身份在 factory/rehydrator/三 CHECK 处全拒）；item 侧计数触发器把「later extra child」
    从服务层不可达升为 DB 拒绝。PR 诚实偏离节需列出。
45. **§12.1 rollback-closure eligibility 门未做**（「closure of a batch with any frozen target
    preimage or W4 operation/calculation/pointer reference returns 409 … removing each
    eligibility predicate fails its own leg」）：W4C-0 代码里没有 closure 写入 service（Stage C
    只交付表 + witness 不可变性；§8.1 write-boundary 为纯类型，未竟 21）。E1 只测了表级
    不可变/唯一门。该 eligibility 逻辑属 W4C-3a 的 rollback 切片（§12.4 亦有同门）——呈裁：
    若门审判定 W4C-0 必须交付，需在 registry 层补 closure service；本阶段判断其无调用方形态
    与「no caller cutover」一致，不属本片。
46. 「no source disables triggers after data exists」只有弱判别覆盖（tgenabled='O' 全表扫 +
    Stage D collector 保证无未认领写点）；无法证明「任何未来代码不会 DISABLE TRIGGER」。
47. E2 门1 的 factory 路径 default×shadow 拒绝腿在 unit（stub trx 喂 default 行）——真库无法
    构造：往 rollout state 插 org='default' shadow 行会永久污染共享库（append-only 不可删）。
    真库面由 rehydrator 腿 + 三 DB CHECK 腿覆盖。呈裁点（若门审要求真库 factory 腿，需接受
    default rollout 行残留或建独立库）。
48. E1 门「upgrade fixtures preserve every byte」的 jsonb 键序比较依赖 jsonb 规范化序（两侧
    同为 jsonb 产物，删键不改剩余键相对序）——非文本级 diff；字段值全等已覆盖。
49. E3（真并发 first-claim 矩阵/null-version worker terminal-without-effect/enqueue vs 同步
    双 commit 序/rollout lock 序/multi-key deadline 双腿）与 Stage F mutation 轮不在本阶段；
    Stage C 未竟 30/31 仍开放。E1 的 P07 backstop 双连接腿已给 E3 可直接复用的双 client 驱动
    形状（见 E1 文件 P07 reservation 用例）。
50. 本地库现状：`ms2_w4c0`（主验证库，已带加固后 schema + 各阶段残留 fixture）、
    `ms2_w4c0_cycle`（Stage A down/up 循环）、`ms2_w4c0_e1fresh`（本阶段全新 CI 形库，
    742/742 证据现场，保留给门审）；E1 scratch 库 `ms2_w4c0_e1_<run>` 每次运行自建自删。
51. E2 会向 ms2_w4c0 的 rollout state 表新增每 run 两个随机 org 的 shadow/eligible 行
    （append-only 设计内残留）；E2 门1 正控会在 'default' org registry 留一条
    legacy_projection_only completed 行（同属设计内）。CI 新库无此累积。

---

## Stage E3 — 并发 gates（DONE, commit `c7367e088`）

### 完成项与落点

**新真库测试文件 `packages/core-backend/tests/integration/attendance-w4c0-concurrency-gates-e3.db.test.ts`
（11 用例；两点接线：plugin-tests.yml attendance 步紧跟 E2 行 + vitest.config.ts exclude；
套件内自证腿）** — §12.1 点名的 dual-connection 腿全部构造**真并发**（双/三连接、
waiter 先经 pg_locks `granted=false` 证明真阻塞、双 commit 序都跑；
[[feedback_toctou_needs_constructed_race]]）：

1. 单命令双连接 first claim：holder 预算内 seal+commit → waiter 解锁后 replay
   同一 stored response；全程恰一行 effect、waiter 零 DML；
2. all-new batch 双连接 first claim：waiter replay 已提交 order vector；恰一 batch 行
   + 一套 item 行；
3. holder 超 waiter 预算（clock seam 把 waiter 预算压到 10ms 真 lock_timeout）→
   values-free 409 `ATTENDANCE_OPERATION_IN_PROGRESS`（message=code，无 55P03/23505
   泄漏）、零额外 DML；holder 随后提交，同 waiter 重试 → replay stored response；
4. multi-key deadline：blocker1 占第一 final key（真释放 ~300ms，模拟钟记 3000ms<5000）、
   blocker2 占第二 key（remaining=2000ms 真超时）→ 一个 helper 预算内的同一 closed
   busy code；blockers 释放后复跑成功且 lock_timeout 恢复 '5s'。「单预算 vs per-key
   重置」判别靠 elapsed 窗（协议 ~2.3s，落 [1500,4500)；per-key 重置 ≈5.3s 会翻红）；
5. helper 自身预算两处检查点（下一 query 前耗尽 → **零 SQL**（counting-trx 断言 issued=0）；
   最后一次 acquisition 后耗尽）都映射到与 55P03 腿相同的 closed code；
6. null-version legacy worker：shared 锁下 source effect（attendance_records INSERT）+
   terminal status 单事务；第三连接 mid-flight probe 证「terminal-without-effect 任何
   快照不可见」；transition 双连接真等待（pg_locks），worker 提交后 exclusive 下看到
   terminal+effect 成对；rollback 腿 → nonterminal + 零 effect；
7. rollout shared/exclusive 双向：null-ID legacy source 持 shared → transition 真等待、
   提交后在 exclusive 下 re-evaluate（resolver 读 legacy）再落 transition；反向
   transition 持 exclusive 落 shadow → source 的 preflight 在 shared 处真阻塞，释放后
   claim 冻结**新** posture（行内 accepted_write_posture='shadow'，非 pre-lock 的 legacy）；
8. P07 enqueue vs rollout transition 双序：enqueue-first（shared 从 resolve 持到 job
   insert 提交；transition 真等待，mid-flight 零 job 可见，exclusive 下 scan 看到
   queued+frozen 'shadow'）；transition-first（eligible→authoritative 在 exclusive 下
   提交；enqueue 在 shared 处真阻塞，释放后 job 冻结 'authoritative' —— 若 posture
   在锁前读会冻 'shadow'，判别成立）；suspension 子腿（authoritative→suspended 提交后
   waiter resolver→blocked、org factory 拒 mint `W4C0_ORG_POSTURE_BLOCKED`、零 job 行）；
9. P07 enqueue vs 同步调用双 commit 序：sync-first（enqueue 在 class-10 真阻塞，sync
   seal+commit 后 enqueue 锁下重读 → 409 batch conflict、零 job 行、恰 2 个 sync
   operation 行）；enqueue-first（sync preflight 在 class-10 真阻塞，enqueue 提交后
   sync 锁下重读 → 409、零 operation/batch 行、恰 1 个 job）——「exactly one side
   reserves the tuple」两个方向都成立；
10. incomplete stable-ID operation vs rollout transition：claimed 未提交时 transition
    在 class-00 exclusive 排队，claim seal+commit 后 transition 完成 shadow→eligible ——
    全程无 40P01/重试耗尽；
11. 两点接线自证腿。

**registry 加固（`w4c0-operation-registry.ts` ~L644-L664，enqueue-first 竞态腿的必要
实现面）**：preflight 对 import_batch/integration_batch 的 batch envelope 在 class-10
锁下重读 operation 行**之后**（§8.2 步 2 字面「lock and re-read the operational job
after those operation rows」）FOR UPDATE 重读 V1 job reservation；存在任何 reservation
→ closed 409 `ATTENDANCE_OPERATION_BATCH_CONFLICT`（W4C-0 preflight 无 worker adapter
可执行并 terminalize 被保留的 job，fail-closed）。

另：E3 文件对 rollout state 的 UPDATE 不带 `updated_at`（该表列名为 `changed_at`
且仅 INSERT default —— 初稿笔误已修）。

### 实跑实数（Stage E3，本地 PG 15.17）

- E3 单文件（ms2_w4c0）：`DATABASE_URL=… ATTENDANCE_TEST_DATABASE_URL=…
  npx vitest run --config vitest.integration.config.ts
  tests/integration/attendance-w4c0-concurrency-gates-e3.db.test.ts` → **11/11 passed**
  （修完列名笔误后首跑即绿，3.09s）。
- 六个 w4c0 db 文件同跑（ms2_w4c0）→ **59/59 passed**（smoke 7 + parity 3 +
  registry 8 + E1 20 + E2 10 + E3 11）。
- w4c0 unit 两文件 → **60/60 passed**（零改写，registry 加固不影响 unit 面）。
- `npx tsc --noEmit`（core-backend）→ exit 0。
- **CI 同构 attendance 步全量（59 files，含 E3 后的 workflow 实际清单）在全新 CI 形库
  `ms2_w4c0_e3fresh`（fresh CREATE DATABASE → 全链 db:migrate with CI
  MIGRATION_EXCLUDE → 单次整步）→ 59/59 files, 753/753 tests passed（61.7s）。**
  日志里的红色 durable-startup 错误行是该套件的注入故障预期输出，用例全绿。
- plugin-tests.yml YAML parse OK。既有测试零改写（本阶段新增 1 测试文件 + registry
  加固 21 行 + 两点接线行）。

### 未竟 / 两读（Stage F 必读，禁静默跳过）

52. **preflight job-reservation recheck 的语义是本阶段 fail-closed 裁量**：任何存在的
    V1 reservation 一律 409。§8.2 的 `(queued, all-new)` admit-for-execution 分支
    （resolved posture == frozen `accepted_write_posture` 才执行、否则只落 job 锁下的
    posture-conflict failure）与 §8.2 步 1 的「P07/P08 replay 还须 congruent completed
    job row」都**未实现**（import batch 的 all-completed replay 目前不查 job）——
    属 P07 worker cutover 片；PR 诚实偏离节需列出，两读呈裁。
53. **leg 8 enqueue-first 的「transition blocks if its normalized accepted_write_posture
    would differ」的 DECISION 逻辑未测**：transition writer（§9 效验条件 4-8）不在
    W4C-0（Stage B 未竟 15 不变）。E3 证明的是 scan 的锁序+可见性（transition 必须等
    shared 释放、之后必然看得到 committed retryable job 及其 frozen posture）。
54. **leg 6-8 的 worker/enqueue/transition 驱动代码是协议 harness**（W4C-0 零 caller
    cutover；生产 worker/transition writer 属后续片）——锁等待/原子性/可见性断言是真
    双连接证据，但「生产代码遵守该协议」的接线证据归 cutover 片。§12.1 对应 gate 的
    「moving terminalization before/after the source transaction … fails」类 mutation
    在 harness 形态下只能 mutate 测试自身，Stage F mutation 轮应声明此边界而非伪造。
55. **leg 4 的单预算判别是时序断言**（elapsed ∈ [1500,4500) ms）：极慢 CI 理论上可
    flaky（真实约 2.3s±抖动）。若门审要求非时序判别，可用 clock-seam 记录
    `set_config('lock_timeout',…)` 值序列（5000→2000）改为形状断言——目前该形状断言
    的等价物在 Stage C registry db 测（deadline 协议 set_config 交错腿）已有单 key 版。
56. **Stage F mutation 轮点名腿（§12.1 逐字，E3 建好judgment面）**：removing the
    canonical operation-identity advisory lock / locking only the batch or only its
    items / changing one identity tuple / moving acquisition after INSERT / broadly
    relabeling another 55P03（→ leg 1-3 各自红）；resetting the deadline per key /
    omitting either budget check / using wall-clock / failing to restore lock_timeout /
    exposing the test clock to production（→ leg 4-5 各自红；最后一条已有 unit 腿）；
    removing either rollout acquisition（→ leg 7 红）；reading posture before shared
    lock / releasing shared before insert commit（→ leg 8 红）；removing class-10 only
    from enqueue / checking reservations before that lock（→ leg 9 红）；moving either
    operation lock ahead of the shared rollout lock（→ leg 10 红）。先 commit 后
    mutate、精确路径还原（不要 `git checkout -- .`）。
57. **suspended P07 对「已存在 job」的 execution-reason 分支无 service 面**（E3
    suspension 腿证的是新 enqueue 被 factory 拒 + 零 job 行；「已 queued job 在
    suspended 下 idempotent 保持 queued + 落 SEGMENT_CALCULATION_SUSPENDED」的表级
    CHECK 在 E1，有 service 行为归 P07 cutover 片）。
58. E3 残留（共享 ms2_w4c0，设计内）：per-run 随机 org 的 rollout 行（ORG_CLAIM 终态
    eligible、ORG_ENQ_FREEZE 终态 suspended、两个 worker org 的 shadow 行）、
    operation/batch/job/attendance_records fixture 行。**`ms2_w4c0_e3fresh` 保留给
    门审复跑**（753/753 证据现场；复跑整步须重建库，理由同未竟 43）。

---

## Stage F — mutation self-check + PR (DONE, no net code diff — commit is this handoff + PR only)

授权来源：taskbook §2 Stage F + advisor 三条房规（多道门互掩护/fixture 自然形状/正控）+
advisor 给的四条 mechanics 提醒（harness mutation 不算证据；SQL guard mutation 要让 DDL
真的重新生效；三桶账本 RAN/NOT RUN/NOT APPLICABLE；PR 前重新核对 main 未漂移）。

### 0. 起手核实

- `git fetch origin main && git rev-list --count HEAD..origin/main` = 0，`..HEAD` = 9 —— main
  未漂移，本分支仍是 fresh-main 的 9 个提交（Stage A-E3 + 两条 ratify/amendment doc + 一条
  integration doc，见 `git log --oneline`）。§12 串行合同持续满足。
- Stage A-E3 的既有测试全部先重跑一遍确认起点绿：unit 60/60、六个 w4c0 db 文件 59/59
  （ms2_w4c0）、collector 12/12 —— 与各阶段 handoff 记录的数字一致，说明本阶段开工前状态
  未被并行会话污染。

### 1. Mutation 记账 —— RAN（先 commit 后 mutate、精确路径 `git checkout -- <file>` 还原，
   每条都给 flip set 而非计数；SQL 侧一律核实是「结构真的改了」而非「测试自己的 harness 改了」）

**桶 A — 身份/advisory 层（`src/attendance/w4c0-identity.ts`，覆盖修订 §2 门 3/4/5/6/8）**

| # | 变异 | Flip set（unit=60 题 / 相关 DB 套件） | 还原核验 |
|---|---|---|---|
| M1 | `OPERATION_KEY_PREFIX` 尾字节 v1→v2 | 3 red: golden 三 namespace、uppercase-UUID 一致性、final-key 排序/去重；57 green | `git diff --stat`=空 + 单测 37/37 |
| M2 | class-`10`/class-`11` 前缀位互换 | 同上 3 red / 57 green（金标同时钉了 class 位与数值） | 同上 |
| M3 | `toSortedUniqueSignedKeys` 去掉 `Map` 去重 | 2 red: 排序/去重用例、强制同键碰撞用例；58 green（金标不受影响，纯排序值不变） | 同上 |
| M4 | `requireOperationWitness` 去掉 WeakSet membership 检查 | 1 red: gate-4 forgery 用例（唯一断这条的用例）；59 green | 同上 |
| M5 | `mintOrgWitness` 去掉 `default`×posture 门 | 2 red: default×shadow 拒绝腿、DB-reload 拒绝腿；58 green，且 `accepts default under legacy_projection_only` 正控保持绿（证明门是排他的，不是共因失败） | 同上 |
| M6 | rehydrator `derived_item` 分支去掉 drift 比较 | 1 red（E2 db）: gate 5 逐字段 drift 矩阵；9 green | `npx vitest run` E2 10/10 |
| M8 | deadline 从「入口一次」改成「每 key 重置」 | 1 red（E3）: `multi-key helper deadline`；**+1 cascading**（见 §2 房规记录）；其余 9 green | E3 单跑 11/11 |
| M9 | 去掉 acquisition 后的第二次预算检查 | 1 red（E3）: `helper-origin budget expiry`；同款 cascading；其余 9 green | E3 单跑 11/11 |
| M10(即任务书 M12) | 去掉 acquisition 前的预算检查 | 1 red（E3，isolated `-t` 复核）: 同一用例 `issued()` 断言从 0 变非 0——证明「零 SQL」腿不是空转 | 同上 |
| M11 | 成功路径末尾去掉 `lock_timeout` 恢复 | 1 red（unit）: 排序/去重用例里内嵌的恢复值断言；DB 套件 19/19 不受影响（该断言只在 unit mock trx 里查 SQL 调用序列） | 单测 37/37 |
| M13 | `productionMonotonicNow` 换成 `Date.now()`（wall-clock） | **0 red** —— 真空变异，见 §3 | 无需还原（属发现） |

**桶 B — deferred 约束（迁移文件；`up()` 是 `CREATE TABLE IF NOT EXISTS` 但函数体用
`CREATE OR REPLACE FUNCTION`，故触发器函数体的编辑会被 E1/E2 自身 `beforeAll` 里的
`up(mainMigrationDb)` 自动重新落到 ms2_w4c0——已验证；表级 CHECK 约束不会，需要 psql 手工
`DROP/ADD CONSTRAINT` 并手工核验字节级还原，见桶 D）**

| # | 变异 | Flip set | 还原核验 |
|---|---|---|---|
| M14 | `attendance_w4_batches_claimed_commit_guard` + `attendance_w4_operation_items_commit_guard` 的 `<>` 弱化为 `<`（超额子项不再拒） | 1 red（E1）: `completed-batch item-count guard rejects incomplete AND extra children...`；19 green | 迁移文件 `git checkout --`，E1 重跑 20/20，且 psql 直查两个函数体确认字面回到 `<>` |
| M15 | `attendance_w4_calculation_children_commit_guard` + `attendance_w4_segment_children_commit_guard` 同款弱化 | 1 red（E1）: `two-sided segment count guard...`；19 green | 同上，20/20 |
| — | `SET CONSTRAINTS trg_aro_claimed_commit_guard IMMEDIATE` 单事务探针（不改 DDL，纯 session 级） | INSERT 本身立刻报 `W4C0_CLAIMED_COMMIT`（默认 deferred 模式下同一 INSERT 会成功，只有 COMMIT 才报——smoke 测试已证）——证明该约束真的是 deferred 而非「反正最终都会拒绝」 | 事务内 `ROLLBACK`，零持久状态变化 |

**桶 C — registry 层（`src/attendance/w4c0-operation-registry.ts`）**

| # | 变异 | Flip set | 还原核验 |
|---|---|---|---|
| M16 | `reserveAttendanceImportJobW4V1` 里去掉 class-`10` 锁获取 | 1 red（E3）: `P07 enqueue vs synchronous caller...`；**+1 cascading**；其余 17 green | E3+registry 19/19 |
| M17 | `operationRowCongruent` 去掉 `command_fingerprint` 比较 | 1 red（registry db）: `shadow single command: claim+seal -> commit -> zero-DML congruent replay; payload/actor drift 409s`；28 green | registry+E3+E2 29/29 |

**桶 D — DB CHECK/触发器（迁移文件 + 一次 psql 直接 `ALTER TABLE`，因为表级 CHECK 不受
`CREATE TABLE IF NOT EXISTS` 的 idempotent `up()` 保护）**

| # | 变异 | Flip set | 还原核验 |
|---|---|---|---|
| M18 | `trg_aij_w4_guard` 冻结字段列表去掉 `w4_accepted_write_posture` | 1 red（E1）: `P07 frozen fields: every identity/posture/vector field refuses UPDATE including null->1 promotion...`；19 green | 迁移文件还原，E1 20/20 |
| M19 | pointer 触发器去掉「pointer target 必须 authoritative completed/reversed」检查 | 1 red（E1）: `pointer gates: authoritative set_active positive...`；26 green | 迁移文件还原，E1+smoke 27/27 |
| M20 | psql `ALTER TABLE attendance_result_operations DROP CONSTRAINT chk_aro_derived_identity`（直接改活库，不经迁移文件——验证「表级 CHECK 不会被 up() 自动重置」这一 mechanics 本身） | 3 red: E2 gate2（六路 cross-namespace masquerade）、E2 gate3（tuple 突变矩阵）、smoke 自己的负例；14 green | psql `ADD CONSTRAINT`（同字面，`pg_get_constraintdef` 逐字核对）；**发现并清理了 2 条被本变异污染进库的行**（该窗口内两条 masquerade INSERT 因约束缺失而落库成功，`ALTER TABLE ... DISABLE/ENABLE TRIGGER trg_..._deny_delete` 临时开洞删除后再合上，append-only 面板复位）；三文件复跑 37/37 |

**桶 E — collector（`scripts/attendance/w4c0-dml-inventory/*.cjs`，纯静态分析，风险最低）**

| # | 变异 | Flip set | 还原核验 |
|---|---|---|---|
| M21a | `table-classification.cjs` 删除 `attendance_record_segments` 的 `w4_canonical` 映射 | **0 red** —— 真空变异，见 §3（该表当前无任何运行时写点） | `git checkout --` |
| M21b | 同文件删除 `attendance_result_operations` 的映射（该表被 `w4c0-operation-registry.ts` 真实写入） | 2 red: `exact-head HEAD scan...`、`positive control: raw COPY into a W4 authoritative (canonical) table...`；10 green（含另外 5 个 positive control） | `git checkout --`，12/12 |
| M22 | `collector.cjs` 的 `SQL_RESERVED_NON_TABLE_WORDS` 删除 `'SET'` | **0 red** —— 真空变异，见 §3 | `git checkout --` |

Stage D 自身既有的两条 mutation（P01 claim 认领删除、`isCanonicalBoundaryPath` 恒 true——
commit `d6e6e5200` 已记录，各自 2 red/10 green 含全部 positive control）本阶段未重跑，直接
引用其证据链，不重复计入桶 E。

### 2. 两条测试基础设施发现（非生产代码缺陷，如实记录）

- **E3 套件内失败断言会遗留一次跨用例的资源占用**：M8/M9/M16 三次变异都观察到「目标用例
  red + 文件顺序上紧邻的下一个用例也 red（伴随异常耗时，如 5459ms/8042ms）」。用
  `-t` 单独重跑该「下一个用例」（变异仍在场）——**始终绿**，证明它不是被变异语义牵连，而是
  前一个用例的失败路径（`expect` 抛出）跳过了某个 client 释放/事务收尾步骤，留下一把锁或
  一个连接直到下一个测试碰上超时。全新库（`ms2_w4c0_e3fresh`）单次整跑不受影响（已在
  Stage E3 完成项证实 753/753、59/59 files）。**建议后续片给 E3 补一个 `afterEach` 级别的
  连接/锁清理兜底**，但这不是 Stage F 判定为需要立即修的生产缺陷——纯测试基础设施韧性问题。
- 每次都通过「还原变异 + 单独重跑该级联用例」以及「还原后跑整份 E3 文件」两步确认：级联
  红色不会在变异被还原后残留（E3 baseline 每次都精确回到 11/11）。

### 3. 三桶账本

**RAN**（§1 全部表格 15 条变异 + 桶 A 内 1 条纯事务级 `SET CONSTRAINTS` 探针 + Stage D 既有
2 条 = 共 18 条，全部先 commit 后 mutate，`git checkout -- <精确文件>` 或 psql
`ADD/DROP CONSTRAINT`（逐字核对）还原，每条都给出 flip set 而非计数）。

**真空变异（跑了，但零翻红——如实记录为发现而非「已证明」）**：
- M13（wall-clock）：生产 `monotonicNow()` 用 `performance.now()`（真单调），但没有任何测试
  注入真实的挂钟回拨/跳变场景去区分它与 `Date.now()`——两者在一次正常测试运行内前进方式
  几乎相同。这是「结构上正确但没有专门测试」的窄口径缺口，非契约违反。
- M21a（`attendance_record_segments` 映射删除）：该表目前在 W4C-0 范围内零写点（segment/
  calculation 写手要到 W4C-1+ 计算器落地才存在），故其 `w4_canonical` 分类当前是「占位」，
  collector 看不到任何触发它的站点。等 later slice 真正写这张表时才会变成可判别的门。
- M22（`SET` 保留字删除）：没有任何测试断言「baseline 重生成后不出现幽灵 `SET` 表调试」——
  这是测试矩阵的一个真实空白（collector 测试只查 unclaimed/unclassified/outsideBoundary
  三个零容忍计数，不查「幽灵表名」这一类）。**呈裁/待补点**：若门审要求，需要给 collector
  测试加一条「baseline manifest 不含任何值为 SQL 保留字的表名」断言。

**未测但有专门测试点名过、找不到对应正控/负控（真实覆盖缺口，非「没空跑」）**：
- M7（SQL-error-swallow）：锁 §12.1 明确点名「swallowing the helper's SQL error fails its
  own cross-connection leg」，但翻遍 unit/E1/E2/E3 都没有一条测试构造「acquisition 之外的
  SQL 抛一个非 55P03 错误，断言它原样传播、不被吞」。`isLockNotAvailable` 的 catch 块目前
  只在 `code==='55P03'` 时才 remap，其它错误 `throw error` 原样抛——代码读起来是对的，
  但没有专门测试钉死这条。**呈裁/待补点**：建议 Stage E 补丁或 W4C-1 补一条 mock-trx 测试。

**NOT APPLICABLE — W4C-0 无实现面（不是「没时间」，是「代码还不存在」，advisor 提醒过不能
静默塞进「未跑」桶）**：
- rollback-closure eligibility 谓词（锁 §12.1「closure of a batch with any frozen target
  preimage...returns 409...removing each eligibility predicate fails its own leg」）——
  handoff 未竟 #45：W4C-0 只交付表 + 不可变性，closure service 不存在。
- retryable-job scan 逐条合法转移（handoff #53）——transition writer 不在本片。
- 「all five lock users import `acquireAttendanceCalculationRolloutLock`」——W4C-0 里只有
  resolver 一个读者，source/rollback/transition/closure 四个写手要到后续片才存在，无法构造
  「mutating any one caller」的跨调用方变异。
- 「every first-claiming command / every target writer」caller-side 变异——W4C-0 零生产
  caller（design-intent），没有多样化调用点可供逐个变异。
- P07 `(queued, all-completed)` admit-for-execution 分支、suspended 下已排队 job 的
  idempotent-retention 服务行为（handoff #52/#57）——worker adapter 不在本片。
- E3 leg 6/8/10 的 worker/enqueue/transition **驱动代码本身**：这些是测试 harness 里手写的
  「模拟生产调用序列」的 helper 函数，不是生产代码。对它们做「moving terminalization
  before/after the source transaction」类变异只会让测试自己的 harness 断言翻红，不构成
  对生产代码的判别性证据（advisor 提醒的边界，也是 handoff #54 原文）——Stage F 没有伪造
  这类「变异」。

### 4. 全量回归（Stage F 独立实跑，fresh DB，非复用脏库）

- `git fetch origin main && git rev-list --count HEAD..origin/main` = 0（PR 前二次核实，main
  仍是 `b5ff168e9`，未漂移）。
- 全新库 `ms2_w4c0_stagef`（`createdb` → `MIGRATION_EXCLUDE` 同 CI → `pnpm db:migrate`，
  含本迁移在内全链成功）→ **CI 同构 attendance 步整段（59 files）→ 753/753 passed**（60.6s），
  与 E3 阶段的 `ms2_w4c0_e3fresh` 证据数字一致，零回归。
- `npx tsc --noEmit`（core-backend）→ exit 0。
- `node --check` 全部 6 个 Stage D `.cjs` + collector 测试 `.mjs` → 全部 OK（此前各阶段未显式跑过
  这一步，taskbook §3 点名要求，本阶段补齐）。
- unit 两文件 → 60/60（零改写）。
- collector 测试 → 12/12（零改写）。
- 六个 w4c0 db 文件在 `ms2_w4c0`（保留库，含各阶段累积 fixture）→ 59/59，与 E3 记录一致——
  证明本阶段全部 mutate/restore 循环零残留污染（除桶 D/M20 主动发现并清理的 2 条被变异污染
  的行外，其余全部 mutate-then-restore 都是纯内存/事务级，未持久化任何变化）。
- `git status --short` / `git diff --stat` 全程回到空——**Stage F 对源码零净改动**；本阶段
  唯一的持久化产物是这份 handoff 更新（下一次 commit）。
- YAML parse OK（`.github/workflows/plugin-tests.yml`，未改动，纯核对）。
- 既有测试零改写：本阶段没有编辑任何 `.test.ts`/`.db.test.ts`/`.test.mjs` 文件（每次变异都
  是产品代码/迁移文件/collector 模块，还原后 git diff 为空）。

### 5. 主动薄弱环节声明（诚实偏离/两读呈裁清单——供 PR body 引用，不在此展开重复各阶段
   已有的未竟条目）

- M7 SQL-error-swallow：真实覆盖缺口（见 §3），非契约违反，建议后续补测。
- M13/M22：真空变异，标志两个「结构对但没有专门断言」的窄口径盲区。
- E3 级联失败（§2）：测试基础设施韧性问题，不影响生产代码正确性判定，但建议补
  `afterEach` 清理。
- Stage A-E 已有的呈裁点（handoff 条目 13/14/21/22/23/24/25/27/36/44/45/47/52/55 等）在
  PR body 单独列出一张 owner-decision 表，不在本节重复。
