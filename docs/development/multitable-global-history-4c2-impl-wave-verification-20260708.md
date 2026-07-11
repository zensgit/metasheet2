# Multitable Global History — 4c-2 impl wave 设计+验证记录(2026-07-08)

**性质:** R6 §5 承诺的「每 wave 设计+验证 MD」。本文对应 **4c-2 forward tombstone-capture 的 RATIFIED 实现**(PR #3901,merged `023385499`),flag 默认 off。
**上游:** design-lock `…4c2-forward-tombstone-capture-design-lock-20260707.md`(owner ratify 2026-07-08,见 `…r6-ratification-decision-record-20260708.md` §1)。

## 1. 落地内容(逐 § 对锁)

| 锁 § | 实现 | 位置 |
|---|---|---|
| §2 两表 | `meta_field_value_tombstones` / `meta_link_tombstones`(append-only,surrogate uuid PK,reason CHECK,独立表零热读改动) | migration `zzzz20260708090000_create_meta_tombstone_tables.ts` |
| §2 捕获点 1 | field-delete:列值 + 该 field 全部 link 边 + auto-number `last_value` | `dropFieldCascade`(`univer-meta.ts`) |
| §2 捕获点 2 | record-delete:**仅 inbound 边**(`foreign_record_id=$1`) | `deleteRecord`(`record-service.ts`) |
| §2 捕获点 3 | lossy-retype pre-image:**预留 seam,已单测、未接线**(4c-1 的活) | `captureLossyRetypePreImageRows`(`tombstone-capture.ts`) |
| §3 flag + cap | `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED`(默认 off)/ `MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS`(默认 50000)→ 超 cap **拒绝破坏操作本身**(422,fail-closed) | `tombstone-capture.ts` + 3 条路由 |
| §4 R1 | field-undelete 补水:值(仅 `NOT (data ? key)` 的行)/ 边(两端记录均存活)/ 序列 | `recreateFieldFromConfig` |
| §5 C6 | 两表接入 `meta-revision-retention.ts` 同一 knob,**keep-days**、bounded batch、默认 off | `meta-revision-retention.ts` |

### 1.1 承重正确性事实(本 wave 最重要的一条)

**field-delete 的捕获必须早于 `DELETE FROM meta_fields` 本身**,而不是早于其后那几条显式 DELETE:
`meta_links.field_id` 与 `meta_field_auto_number_sequences.field_id` 都是 **`ON DELETE CASCADE`**(`zzzz20260404153000_repair_meta_core_schema.ts:34`),因此删字段行时数据库先把边与序列级联清掉。捕获若置于其后,**会静默捕获到空集**——表面成功、实际零恢复力。实现期由车道自身发现,审阅期以 mutation 独立复证(移除该前置捕获 → 值/边/序列全部丢失)。

## 2. 验证(独立复跑,不采信 PR 自证)

**对抗审阅判定:APPROVE-with-hardening — 0 P1 / 0 P2**(MD:`/tmp/pr3901-4c2-review-claude-20260708.md`)。

审阅方独立执行:
- 迁移:fresh bootstrap 干净 + **down→up 往返**干净 + 幂等(`IF NOT EXISTS`)。
- 单测 16/16(`tombstone-capture` 5 + `meta-revision-retention` 11)。
- realdb 23/23(field-capture 8 / field-rehydrate 3 / record-capture 6 / retention 6)。
- 邻居回归 35/35(undelete-config + record-recycle-bin + config-restore)。
- **独立 mutation ×5,每次还原后 `git diff` 空**:neuter `insertFieldValueTombstones` / `insertFieldLinkTombstones` / `readAutoNumberNextValue` / `insertInboundLinkTombstones` / **`assertWithinCaptureCap`**(审阅方自加,PR 未测)→ 每次恰好对应 golden 变红。**每个捕获 INSERT 与 fail-closed cap 守卫都被 golden 钉死。**

主会话(Opus)闸门复核补充:
- `tsc --noEmit` 干净;`multitable-record-lock-guard.guard.test.ts` 4/4;rehydrate golden 3/3(带新增 `NOT EXISTS` 后仍绿)。

### 2.1 审阅后折入的加固(合并前)

| 项 | 内容 |
|---|---|
| P3-2 | link 补水 INSERT 增加 **`NOT EXISTS`(edge triple)** 幂等守卫。`meta_links` 在 `(field_id, record_id, foreign_record_id)` 上**没有唯一约束**(PK 只是随机 `id`),既有 `ON CONFLICT DO NOTHING` 只守 PK。当前流程不可达,但 **4c-3 的 inbound 重放会让它成为真 bug**——故先行加固。 |
| P3-1 | plugin-SDK `records.ts` 的 `deleteRecord` 就地注释为**不在 tombstone 范围**;锁 §8 同步点名。 |
| NIT-2 | self-link 免疫机制注释更正:免疫来自「inbound 捕获从不被重放」,**不是** outbound 的 `ON CONFLICT`(它只守随机 PK)。 |
| CI | rank-8 结构守卫要求每个 `meta_records` UPDATE/DELETE 站点带 lock disposition;R1 补水 UPDATE 补 `// lock-exempt: field-undelete schema op`(镜像 field-delete drop 先例)。 |

## 3. 诚实缺口(本 wave 未做/未验)

1. **G6(lossy-retype 捕获 golden)未做** —— 捕获点 3 是**预留未接线** seam,由 4c-1 接入并携带其 golden(L11)。
2. **跨 sheet inbound 捕获未测** —— 唯一的 record-delete 捕获 golden 把 A/B/C 放在**同一 sheet**;而 link 字段的常态是跨 sheet。且 `meta_link_tombstones.sheet_id` 在 `reason='record_delete'` 行上存的是**被删记录的 sheet**,`field_id`/`record_id` 却属于**源记录的 sheet** —— 任何按 `sheet_id` 过滤/清理/鉴权的逻辑对跨 sheet 链接都是错的。**4c-3 必须只按 `source_revision_id` 锚定,永不按 `sheet_id` 过滤。**
3. **C2 的真实覆盖面 = 4 条记录硬删路径中的 1 条** —— 见同批 `…destruction-path-coverage-gap-audit-20260708.md`;锁 §1/§8 已按实情修订。
4. 50k cap 的规模/性能、on-prem 包构建未验。
5. CI 噪声:共享 DB 大 bundle(单 vitest × ~40 文件 × 单 pg)出现过一次与本 PR **无关**的 `oapi2a-comments-write` 红。已判定为调度扰动 flake:该测试隔离下 4/4 绿、与本 PR 4 个新 realdb 文件同跑 27/27 绿、main 该 workflow 近 8 次全绿;重跑后消失。**教训:此 bundle 里与改动无关的红,先隔离复跑再归因。**
