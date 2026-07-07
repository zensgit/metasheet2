# AI 字段 S1b · 真批次回滚 · 设计锁（PROPOSED）

> 状态：**PROPOSED — 待 owner ratify**。docs-only；不改 runtime。
> 前置（已落 main）：**S1 = 写入血缘 + 批次分组 FOUNDATION**（lock #3569 + runtime #3584；round-2 评审把"batch rollback"**明确降级为 grouping foundation**、S1b 独立门禁——即 S1 造了"一次批量=一个 batch_id"的地基但**明示不承诺回滚**）· record-level version restore（既有，单记录版本还原）· HistoryCenterModal（**当前只读**）· `meta_record_revisions`(带 batch_id)。
> ⚠ 本锁的运行时具体点（restore 路径能否定位"批次前一版本"、restore 的权限门）**需在 impl 时对当前 head 逐一核实**，不得照抄本文假设——本文定的是形状与不变式，不是实现细节。
> 模型分档：设计 = Fable/Opus；runtime = Sonnet；回滚是写操作 → 点亮/权限相关的对抗审阅 = Opus。

## 1. 原则

S1 已经把"哪些记录属于同一次批量操作"钉死成 batch_id（AI commit / bulk-fill / 一次 `/patch` 共享一个 id，LOCK-12 修完后 partial-success 也共享）。但 History Center 现在是**只读**的——你能看到"这批改了什么"，却**没法一键把这一批撤回**。S1b 补的就是这个：**批次级回滚**——把某个 batch 里所有记录，原子地还原到"这批操作之前"的状态。

**明确的既有缺口**（S1 台账 + 记忆）：restore 面**没有 batchId 入口**、**没有 per-record"批次前一版本"定位**。现有 record-level restore 是单记录还原到某个指定 revision；S1b 需要在其上加"按 batch 找到每条记录批次前的那个 revision，然后成组还原"。

## 2. 边界（S1b 做什么 / 不做什么）

**做**：
- **batchId 回滚入口**：History Center 的某个 batch → "回滚此批"动作（read-only 面加一个受控写入口）。
- **per-record 批次前版本定位**：对 batch 内每条记录，找到 batch_id 那次改动**之前**的 revision（若该记录在此 batch 是"新建"，回滚 = 删除/软删该记录，按既有 recycle-bin 语义）。
- **原子 / fail-closed**：整批要么全还原、要么报告 partial 并**不半还原**（沿用 LOCK-12/G-8 的 fail-closed 姿态）；任一记录无写权/被锁/掩码 → 该批回滚被拒（不部分绕过）。
- **回滚本身可追溯**：回滚是**一次新的批量写**，产生自己的新 batch_id + 血缘（source=`rollback`，指向被回滚的 batch）——回滚可被再回滚。
- 全程走**既有写入路径 + 权限 + 掩码 + 校验**（不是新写通道；复用 record-restore 的权限门）。

**不做（各自独立 ring）**：
- 不做"部分记录选择性回滚"（v1 = 整批；子集回滚 demand-gated）。
- 不做跨 batch / 时间范围回滚。
- 不改 restore 的权限模型（复用既有 record-restore 权限门，不新增/放松）。

## 3. 硬闸门（不变式）

1. **原子性 / fail-closed**：批内任一记录无法安全还原（无写权 / 被锁 / 前版本不可定位）→ **整批拒绝**，不半还原、不塞脏。
2. **不绕权限/掩码**：回滚的每条写经既有权限 + 字段掩码 + 校验；对无写权字段/记录 → 拒。
3. **可追溯**：回滚 = 新 batch + 血缘（source=rollback，link 到被回滚 batch）；可再回滚。
4. **新建记录的回滚语义 = 既有 recycle-bin**（不发明新删除路径）。
5. **只读面的写入口受控**：History Center 加的"回滚"动作是**显式确认**的（避免误触整批撤回）。

## 4. 门禁（TODO-checklist）

- 🔒 **S1b-1 per-record 批次前版本定位**（给定 batch_id，为每条记录解析"批次前的 revision"；新建记录→标记删除语义）+ real-DB golden（含"前版本不存在"= 拒的负向断言）— 待本锁 ratify；Sonnet。
- 🔒 **S1b-2 原子批次还原写**（成组、fail-closed、走既有权限/掩码写路径、产回滚血缘）+ golden（含无写权/被锁记录→整批拒）— S1b-1 后；Sonnet；Opus 审（写操作）。
- 🔒 **S1b-3 History Center 回滚入口**（只读面加显式确认的"回滚此批"动作 + 深链）— S1b-2 后；presentation + 最小 wiring。
- 🔒 **不做**：子集回滚 / 跨批回滚 / 权限模型改（各自立项）。

## 5. 验证纪律
每 slice 双 MD；批次前版本定位 golden（含新建记录 + 前版本缺失向量）；原子还原 golden（含 partial→整批拒的负向断言）；证明"回滚不绕权限/掩码"（无写权记录/掩码字段上回滚被拦）；回滚血缘可查（source=rollback link 到源 batch）。

## 6. 一句话
S1 造了批次的"骨架"（batch_id），S1b 给它装"撤回键"——按 batch 定位每条记录的批次前版本、原子还原、走既有权限/掩码写路径、回滚本身留血缘。只读的 History Center 加一个显式确认的受控写入口。v1 只做整批、只复用既有权限门,不发明新删除/新绕过。
