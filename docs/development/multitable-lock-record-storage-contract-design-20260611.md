# 多维表 lock_record 存储契约 + 重新暴露 — 设计锁定 — 2026-06-11

> Status: **DESIGN-LOCK(docs-only)** · 阶梯 rank 8;benchmark §8-3,审计**唯一回归项**。
> 地基:2026-06-11 勘察(file:line)。**实现等 owner 拍 §3 的 6 个锁语义决策**(已给推荐默认,可一句"按推荐")。
> 含一个 migration(meta_records 加列,zzzz 最高层)。不碰 central RBAC/auth。

## 0. 现状(勘察确认 — 它今天是坏的)

`executeLockRecord`(automation-executor.ts:1775)往**不存在的 `meta_records.locked` 列** UPDATE → 触发即运行时失败。`lock_record` 在 `ALL_ACTION_TYPES`(automation-actions.ts:14)声明为受支持,但**存储、写路径执行、前端**三者全无。PR #2278 只是把它从新规则 UI 下拉**藏掉**(可见但坏 → 不可见但仍坏),没修根。本设计补齐契约让它真正工作。

## 1. 范围一句话

补 `meta_records` 锁存储(`locked` + `locked_by` + `locked_at`)→ 写路径执行(锁定记录拒编辑/删除)→ 解锁权限 → 自动化 lock/unlock action 修复 → 前端锁指示与行动作(撤销 #2278 的隐藏)。

## 2. 锁定设计(按推荐默认;owner 可逐项改)

### 2.1 存储(migration,zzzz 最高层,镜像 `zzzz20260430163000_add_meta_record_modified_by`)
- `meta_records` 加三列:`locked boolean NOT NULL DEFAULT false`、`locked_by text NULL`、`locked_at timestamptz NULL`。存量行默认 false=不变。
- 选中间路径(非纯 boolean、非独立表):布尔最便宜但无审计;独立表对 v1 过重;三列给"谁锁的/何时"审计 + 支撑 issuer-unlock,与既有 `created_by/modified_by` 先例同构。down() 干净。

### 2.2 写路径执行(record-write-service.ts:572 邻域,`ensureRecordWriteAllowed` 之后)
- `patchRecords`:`recordRow.locked && !canUnlock(actor, recordRow)` → 拒(既有 `RecordValidationError`/FORBIDDEN 语义)。
- 删除处理器:同款守卫(锁定记录不可删)。
- **不静默绕过**:即便 admin,要改也须先显式 unlock(语义清晰、无每-mutation 绕过逻辑)。

### 2.3 解锁权限 `canUnlock(actor, record)`
- 推荐 = **locker 本人(`locked_by===actor`)∨ 记录 owner(`created_by===actor`)∨ sheet admin(`canManageSheetAccess`)**。三者皆用既有 capability/系统字段,零新原语。

### 2.4 自动化 action 修复
- `executeLockRecord` 改为写新列(`locked`/`locked_by=<rule 或 system>`/`locked_at=now()`);`config.locked===false` = **解锁**(action 已是 `{locked:boolean}`,unlock 零新 action type)。失败如实进 automation 执行日志。

### 2.5 前端重新暴露(撤销 #2278)
- 网格行:锁图标指示(锁定行只读视觉)+ 行动作菜单 lock/unlock(按 `canUnlock` 显隐),与既有 comment/delete 动作并列。
- 记录抽屉:锁状态 + locker/时间展示。
- 规则编辑器:lock_record 重新进 action 下拉(契约补齐后不再是"坏动作")。
- i18n 走既有模块。

## 3. ⚠️ Owner 决策(6 项,推荐默认)

| # | 决策 | 推荐(最便宜且语义清晰) | 备择 |
|---|---|---|---|
| a | 锁粒度 | **整记录**(automation config 已是记录级) | 字段级(贵:每字段写守卫 + jsonb 跟踪) |
| b | 解锁权限 | **locker ∨ owner ∨ sheet-admin** | 仅 owner / + 超级 admin |
| c | 自动化锁 vs 手动锁 | **同一状态**(单列,自动化与用户写同处) | 分离 `manual/automation_locked`(贵:schema 翻倍) |
| d | 锁的作用范围 | **拒编辑 + 拒删除**(允许评论——锁≠冻结讨论) | 仅拒编辑 / 拒一切含评论 |
| e | admin 绕过 | **不绕过**(admin 也须显式 unlock) | 条件绕过 / 无条件编辑绕过(贵) |
| f | 解锁触发 | **手动动作 + 自动化 unlock(`locked:false`)** | + 时间过期(贵:需调度) |

## 4. 测试矩阵(fail-first;真库)
LR-T1 锁定记录拒编辑(canUnlock=false actor)· LR-T2 拒删除 · LR-T3 评论仍可(范围 d)· LR-T4 canUnlock 三层各放行 · LR-T5 自动化 lock/unlock 真写列(修 executeLockRecord;现状触发即失败=fail-first 起点)· LR-T6 admin 不静默绕过(须先 unlock)· LR-T7 存量行 locked=false 回归 · LR-T8 migration up/down · LR-T9 前端锁指示/动作按 canUnlock 显隐 · LR-T10 wire-vs-fixture:locked/locked_by 真 wire 往返(新列经 record echo)。

## 5. 回滚
列默认 false 存量无害;前端撤销=回到 #2278 隐藏态;automation action 修复后即便回滚也不比现状(坏)更糟。

## 6. 不在本设计
字段级锁 · 锁过期 TTL · 独立 locks 表 · 与审批引擎 lock 的深度集成(approval C1 lock-safe 是另一议题,本设计的记录锁与之正交,不冲突)· 批量锁。
