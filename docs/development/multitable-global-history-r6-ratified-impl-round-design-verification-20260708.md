# Multitable Global History — R6 Ratified-Impl Round 设计+验证记录(2026-07-08)

**性质:** 固定节奏第 6 轮的设计+验证记录。R6 是本线**首个把破坏性恢复能力写成 runtime 代码**的轮次(R1-R5 均为文档/测试/设计锁)。触发 = owner 2026-07-08 一次性 ratify 五个闸门(记录见 `…r6-ratification-decision-record-20260708.md`,#3887)。
**本文事实经独立完整性审计对 `origin/main` 逐条核实**(非记忆/自述);所有 SHA、file:line 均已复验。

## 0. 闸门裁决(owner,2026-07-08)与本轮范围

| 闸门 | 裁决 | R6 处置 |
|---|---|---|
| 4c-1 lossy retype revert | RATIFIED,U-L8 = **full-read gate** | impl 落地(§2) |
| 4c-2 forward tombstone-capture | RATIFIED | impl 落地(§1) |
| T-source | 保持 A2(最终) | 零代码,闭合 |
| O-1 | PASSED(正式 staging 2026-07-08,build `94ab9675…`,7 flags,retention 未开满足 PIT_RESET STOP-SHIP) | 闭合 |
| destructive-tier FE | 闭合(#3749 接线 + R5 审计服务端权威) | 闭合 |

**贯穿边界(全程遵守):flag 全部默认 off;production 启用属独立 O-2 operator 阶梯,本轮不启用任何 flag、不触碰 staging。**

## 1. 4c-2 forward tombstone-capture(impl,merged `023385499`,#3901)

**落地:** 两张 append-only tombstone 表(`meta_field_value_tombstones` / `meta_link_tombstones`,migration `zzzz20260708090000`)+ same-txn 捕获-先于-销毁(`dropFieldCascade` 捕值/边/序列;`deleteRecord` 仅捕 inbound 边)+ fail-closed cap 422 + field-undelete R1 补水 + retention keep-days sweep。flag `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` 默认 off;`captureLossyRetypePreImageRows` 为预留 seam(4c-2 未接线,4c-1 接入)。

**承重正确性事实(命门):** field-delete 捕获**必须早于 `DELETE FROM meta_fields` 本身**——因为 `meta_links.field_id`(`zzzz20260404153000_repair_meta_core_schema.ts:34`)与 auto-number 序列 `field_id`(`zzzz20260505110000_create_meta_field_auto_number_sequences.ts:6`,**审计更正:非 repair 迁移**)都是 `ON DELETE CASCADE`;删字段行会先级联清掉边与序列,捕获若置于其后**会静默捕获空集**。车道构建期发现,审阅期以独立 mutation 复证(移除前置捕获 → 值/边/序列全丢)。

**验证:** 对抗审阅 **APPROVE-with-hardening,0 P1/0 P2**(`/tmp/pr3901-4c2-review-claude-20260708.md`)。独立复跑:fresh+rollback 迁移、单测 16/16、realdb 23/23、邻居 35/35、**5 组 mutation**(每个捕获 INSERT + cap 守卫各被一条 golden 钉死)。合并前折入:link 补水 `NOT EXISTS` 幂等(边三元组无唯一约束)、plugin-SDK 删除路径注释 + 锁 §8 点名、rank-8 lock-disposition marker。wave 验证 MD = `…4c2-impl-wave-verification-20260708.md`(#3921)。

## 2. 4c-1 lossy retype revert(impl,merged `b6301f944`,#3922)

**落地(逐 §,均对 `origin/main` 核实):**
- **信封 fail-closed 收窄**:lossy 面 = **Batch-1 类型的 property-only revert**。车道发现锁 §2.1 字面只约束 target type,会误纳 after-type 属 EXCLUDED 的 revert(如 `link→text`:裸 `UPDATE meta_fields` 跳过 teardown handlers + `coerceBatch1Value` 对 `text` 恒等 ⇒ oracle 认证「零损失」却把 link 数组留在 text 列)。取两端非 excluded 的 fail-closed 读法。
- **双闸 flag**:`MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY === 'true'`(`lossy-retype-oracle.ts:107`,默认 off)且要求基础 flag 同时 on。
- **loss-oracle**:三桶 `unchanged/coerced/dropped`,纯读预演。
- **U-L8 = full-read gate**(owner 裁决,推翻锁 §2.2 备选 (ii)):`hasFullTableReadAccess`(`univer-meta.ts:6326`)在 preview(:8660)与 execute(:8951)双侧;缺全表读权 → **403 `FULL_TABLE_READ_REQUIRED`**,不返回任何计数/undisclosed 标记。三判定轴**全部 config-derived**(审阅逐轴核实:taint 轴函数体 `meta_records` 出现 0 次;刻意不用 `loadDeniedRecordIds`——其 rule-deny 分支对 live data 求值,本身就是 U-L8 禁止的 1-bit 探针)。
- **loss-magnitude 绑定**:`hashLossSummary(fieldId, summary)` = **`createHmac('sha256', getSecret())`**(`restore-preview-identity.ts:261`,server-key,绑 `fieldId`)并入 preview token;execute 事务内 `FOR UPDATE` 后重算比对 → 不一致 **409 PLAN_DRIFT**。
- **type-era guard(P1 修复,§2.1「同 type」的真正强制)**:preview 与 execute 双侧 `hasFieldTypeChangeSince` —— 被 revert 的 revision 之后若存在 `'type' ∈ changed_keys` 的 config revision ⇒ **422 `FIELD_TYPE_ERA_MISMATCH`**;execute 侧在 `FOR UPDATE` 后、任何 mutation 前。
- **写对称 cap**:`SHEET_REVERT_MAX_RECORDS` 提入 `restore-caps.ts` 后复用,超限 **413** 双侧 fail-closed。
- **execute 单事务**:套回 before 定义 + 按 oracle 批量改写 cell,**每个 coerce/drop cell 记 record revision**(共享一 batchId)⇒ 本次 lossy revert 自身可经记录版本回退撤销;typed confirm `revert-retype-lossy` 缺失 → **400 `CONFIRM_REQUIRED`**(锁 §4 L9 原写 422 系笔误,已订正)。
- **pre-image 联动**:同事务、覆写前调 4c-2 seam `captureLossyRetypePreImageRows(reason='lossy_retype')`,锚 = 本次 revert 自身 config revision;超 tombstone cap ⇒ 拒绝本次 revert。

**验证:两轮独立对抗审阅。**
- **R1 审阅 CHANGES-REQUESTED**(`/tmp/pr3922-4c1-review-claude-20260708.md`):端到端跑通**真实数据销毁**——`text→url` 值迁移从 revert 侧偷渡(`url/email/phone/barcode/qrcode/location` 的 property sanitizer 是恒等函数 ⇒ type-only PATCH 不触发 drift,老 revision 不被 `changed_keys`-based 的 driftConflict/baselineHash 看见)。另确证 `jsonb_set(data,path,NULL)` 会把**整个 `data` 列置 NULL** 的数据销毁级 footgun(`COALESCE(...,'null'::jsonb)` 守之)。
- **R2 fix-审阅 APPROVE**(`/tmp/pr3922-4c1-fix-review-claude-20260708.md`):独立跑 **TOCTOU**(preview 通过 → type-only PATCH → execute)= 422、库零变化;只 neuter execute 侧 guard → 200 + 销毁(证明 execute 侧 re-check 必要且不可被 lossHash 替代)。六承重装置全部 mutation 证明为真守卫。
- **主会话合并前折入**:P1-1d **真-token TOCTOU golden**(mutation 复证:neuter execute guard → 409;guard 跑在 drift 之前)+ P3-A **fail-closed 平局** era-guard(同 `created_at` 的 type revision 视为已变更,零行为变更、封 latent 路径)。realdb 24/24、`tsc` 干净。

## 3. 支撑工件(本轮同期落地)

| PR | 内容 | SHA |
|---|---|---|
| #3887 | R6 ratification record(含 §3 O-1 正式 staging provenance) | `19b5a4da6` |
| #3918 | web-guard path-filter 覆盖 reset/restore/history 组件+spec(残差实为 5 面) | `8ec4da2a1` |
| #3921 | 4c-2 wave MD + **销毁路径 gap-audit** + 锁诚实修订 + D-6 | `096490866` |
| #3924 | 4c-3 record-undelete Slice 2b design-lock(PROPOSED) | `3c7c97111` |

## 4. 本轮最重要的两个非代码产出

### 4.1 【P1 缺陷,已修】4c-1 的可达数据销毁面
见 §2。价值:类型系统、单测、drift 机制**结构性看不见**这条路,唯有会「真跑」的对抗审阅端到端复现。已由 era guard(双侧)封死并 mutation 钉牢。

### 4.2 【线核心承诺的活缺陷,已记录未修】销毁路径覆盖不完备(gap-audit,#3921)
仓库有**四条 `DELETE FROM meta_records`**,C2「flag on ⇒ 凡销毁必已捕获」**只对 1 条(`record-service.deleteRecord`)成立**:
- `automation-executor.ts:2269`(automation `delete_record`,**已上线/无 flag/有授权 UI**)与 `records.ts:565`(plugin-SDK)**不写 delete revision**;而 `reconstructRecordsAtT`(`record-reconstructor.ts`)纯从 `meta_record_revisions` 派生存在性 ⇒ **被它们删掉的记录在任意 T 都被 PIT 判为「仍然存在」**。这是**时点重建正确性的活缺陷**,非缺特性。`RecordRevisionSource` 早已声明 `'automation'|'public-form'|'plugin'` 三个从未发射的枚举位。
- `univer-meta.ts:10066`(PIT-reset 内联)有 revision+trash 但**无 tombstone**。
决策菜单 **D-1..D-6**(#3921);**本轮不实现任何一项**,4c-1/4c-2 的可达边界据此如实收窄。

## 5. R7(同期,自驱正确性)

完整性审计将 gap-audit 的 **D-6** 重定性为**(A)类自驱正确性修复**(非 owner 闸门):Tier-1/2 config-restore **execute 成功路径从不调 `invalidateFieldCache`**(uncreate/undelete/lossy 分支都调),`metaFieldCache` 无 TTL 常驻并喂记录写路径 ⇒ 一次 Tier-2 retype revert 后同进程继续用 revert 前 type/property coerce 写入。按本线 R3-1/R5 自驱先例修复中(分支 `claude/gh-d6-config-restore-cache-invalidate-20260708`),mutation-proven。

## 6. 轮后状态(池已抽干到只剩 owner/operator 闸门)

完整性审计判定:**除 4c-1(已合)/D-6(R7 在修)外,无任何 pre-gate 自驱项被漏**(设计锁全起草、验证 MD 全写、CI 残差已闭、4d 红线全仓零松动)。剩余全部是 owner/operator 决策:

- 🔒 **ratify 4c-3**(record-undelete 2b;锁 #3924 在 main)。**唯一真实产品分叉 = 邻居同意语义**:锁定 **Option A**(只重放邻居 `data` 仍声称的边 ⇒ 收敛而非授权,化解跨 sheet 授权问题);Option B 需显式签核。
- 🔒 **gap-audit D-1**(automation/plugin-SDK 删除发射 delete revision,修 PIT 正确性)——**跨车道**(automation 线),owner 点名或路由。D-2(补 trash/可恢复性)= 产品决定。D-3(PIT-reset 捕获点)已并入 4c-3 锁。
- 🧭 **O-2 operator flag 阶梯**(含新 `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` / lossy flag,均默认 off)——破坏性从低到高,每步 runbook 采证。
- ⚠️ **ledger 更正**:R6 ratification record(#3887,08:42)§4/§6 把 ResetConfirmDialog web-guard 残差列为 OPEN,但 #3918(12:45)已闭合该残差——**以本文为准:该残差 CLOSED**。

**节奏承诺同前:** 任一 🔒 解锁或 operator 阶梯产出证据即开下一轮;池空且无解锁时线保持静默,不造工作。
