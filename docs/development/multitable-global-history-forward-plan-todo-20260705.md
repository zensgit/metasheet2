# Multitable Global History — 前瞻开发计划 + 可跟踪 TODO(2026-07-05)

**性质:** 固定节奏开发的**前瞻规划工件**(排序 + 难度×模型分派 + 入口条件 + 并行矩阵)。
回看两轮已完成工作见 `…parallel-round-dev-verification-20260705.md`(R1)与 `…round2-dev-verification-20260705.md`(R2);现状权威图见 `…verified-state-map-and-decision-menu-20260703.md`。本文不授权任何 🔒 项开工——每个 🔒 的解锁词都写在行内。

**标记:** ✅ 已完成 · ⬜ 可建(无闸门,按节奏排队)· 🔒 gated(需行内注明的解锁条件)· 🧭 operator 动作(非 agent 工作)

## 0. 固定节奏与模型策略(两轮实证有效,沿用)

- **节奏:** 每轮 = 从池中取全部可建项 → 并行隔离-worktree 车道构建 → 主会话逐点人审(mutation 证据/安全面/写作纪律)→ auto-merge+keep-sync 落地 → 轮次设计+验证 MD。
- **模型分派(按难度):**
  | 层 | 承担 | 模型 |
  |---|---|---|
  | 编排/评审/破坏性语义判断/design-lock 起草 | 主会话 | **Fable 5**(高推理) |
  | 标准实现车道(测试/harness/FE 组件/投影层) | 并行子代理 | **Sonnet 5** |
  | 机械扫描(grep 盘点/文档比对) | 子代理 | **Haiku 4.5** |
- **落地纪律:** hot-main 用 auto-merge+keep-sync(轮询抢合会饿死);owner-hold PR 一律 watch-only;跨车道意志传给所属会话,不在 GitHub 拔开关。

## 1. 底座(已完成,勿重开)

✅ R1:#3541 retention wiring / #3542 状态图 / #3606 跨 strategy token 矩阵 / #3609 三 tier harness+runbook / #3608 内联 diff / #3615 R1-MD
✅ R2:#3626 T1b before-hydration / #3627 迁移加固 / #3628 R2-MD / #3632 exclude 摘除
✅ 选档闭合:report-sync A2/defer/diagnostic-first(#3577 §4)+ A2 实现锁 #3623 已落 main(该线归属并行会话,本计划不排它)

## 2. 前瞻 TODO(按优先序)

### R3 微轮 — 可建即排(无闸门)
- ⬜ **R3-1 retention-thinned before-hydration golden**(R2 Lane D 承接的诚实缺口):retention 开启 + 中段 revision 被清 → `before` 落到最近幸存旧态的行为 golden;附带 update-无前-revision 边角(安全退化 null)。难度 **低-中** → Sonnet 5 建 + Fable 审。realdb,单文件扩展。
- ⬜ **R3-2 readiness-refresh 文档 §2.2 stale 行修正**(R1 Lane A 发现:多记录 resurrect 原子性 golden 早已由 #3351 落地,文档仍列"建议补"):一行式 docs 修正。难度 **低** → 主会话顺手,不开车道。

### 解锁即建(闸门在 owner,入口条件明确)
- 🔒 **T-source slice**:Reset 时点选择挂到既有 Global History 时点面(history-anchored,替代自由 datetime picker)。**解锁词 = owner 对该产品方向的明确点头**(本文与两轮 MD 反复推荐,未获即不建)。难度 **中**(FE + 少量 wiring)→ Sonnet 5 建 + Fable 审;预估单轮单车道完成。
- 🔒 **三破坏性 config tier 的 FE**(uncreate / config-undelete / permission-revert 面板):**解锁条件 = 对应 flag 在 staging 验收通过 + owner 对"向用户暴露不可逆操作"的产品签核**。难度 **中-高**(不可逆语义 UI 文案 + typed confirm 纪律)→ Sonnet 5 建 + Fable 重审(参照 ResetConfirmDialog 模式)。
- 🔒 **4c-1 lossy/value-transform retype revert**:**先 design-lock(Fable 起草,含 loss-oracle / preview↔execute loss-magnitude 绑定 / write-symmetric cap),owner ratify 后才排 impl**(Sonnet)。难度 **高**。
- 🔒 **4c-2 forward tombstone-capture**(让未来的字段删除/lossy retype 可恢复值):同上,design-lock-first。难度 **高**。**注意:不恢复任何已删数据**(4d 不可能项边界)。
- 🔒 **4c-3 record undelete Slice 2b**(硬删记录复活 + 链接重建):阻塞于捕获缺口(link 边硬删无快照)——**依赖 4c-2 先行**;解锁词 = owner 单项签核。难度 **高**。

### operator 阶梯(非 agent 工作,排序建议)
- 🧭 **O-1** 用 #3609 harness 跑三 tier staging 验收(每 tier 独立,零 prod 影响)——**所有 flag 决策的证据基础,建议最先做**
- 🧭 **O-2** flag 阶梯(破坏性从低到高):`PERMISSION_REVERT` → `CONFIG_UNDELETE` → `SHEET_CONFIG_REVERT`/`FIELD_RETYPE_REVERT` → `CONFIG_UNCREATE`;PIT 双 flag:`PIT_UNDELETE` 先、`PIT_RESET` 后(**STOP-SHIP:retention 关闭或 trash 保留 ≥ 审批窗口**)
- 🧭 **O-3** 每次 flag 翻转按既有 runbook 采证(#3609 runbook / reset & pit-undelete 验收 runbook)

### 明确不做(记录在案)
- ❌ 4d 已删字段列数据的值级恢复(无 tombstone,字节不存在)
- ❌ legacy 调试旗(`MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL`)下的 uuid/text FK(默认关、无人走;#3627 已记录)

## 3. 并行矩阵与依赖

```
R3-1 ∥ R3-2                    (立即,互不相扰)
T-source ──(owner 点头)──────→ 单车道,可与任何 4c design-lock 并行
O-1 → O-2 → 破坏性 tier FE 解锁   (operator 链)
4c-1 lock ∥ 4c-2 lock          (两份 design-lock 可并行起草)
4c-2 impl → 4c-3               (2b 依赖 tombstone 先行)
```

## 4. 节奏承诺

R3 微轮(R3-1/R3-2)于本计划落 main 后立即执行并按惯例出轮次验证记录;其后每当任一 🔒 解锁或 operator 阶梯产出新证据,即开下一轮。池空且无解锁时,线保持静默——不造工作。
