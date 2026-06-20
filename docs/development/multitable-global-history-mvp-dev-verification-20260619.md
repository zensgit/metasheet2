# 全局历史与时点恢复 — read-only MVP 开发与验证 MD

> 对应 /goal「根据开发计划及 todo MD 完成开发，完成后给出开发及验证 MD」。
> **范围 = canonical 计划授权的只读 MVP（T0 ratify + T1 + T1b + T4 + T2/T3），已全部落 `main`。** restore/PIT/config（T5/T6/T8/T9）按计划保持 gated，未建（各自独立 owner opt-in）。
> 设计基准：`multitable-global-history-pit-restore-design-lock-20260619.md` + `...-todo-20260619.md` + T0 已决项 `multitable-global-history-t0-resolved-decisions-20260619.md`。

## 1. 交付范围（authorized 只读 MVP — 已 MERGED）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **T0** | §8 已决项 + 首刀数据模型形态（ratify 对象，docs-only） | ✅ #2958 (`db520a26f`) |
| **T1** | `meta_record_revisions.batch_id` 分组键（单动作=自身 id；bulk 共享一个 = LOCK-12 确定性边界，非并行写库 LOCK-1） | ✅ #2961 (`5cf527ac5`) |
| **T1b** | `history-projection.ts` project-on-read 投影（按 `COALESCE(batch_id, id::text)` 分组，LOCK-11 排序）+ `GET /bases/:baseId/history/events[/:batchId]` | ✅ #2961 |
| **T4** | sheet 级读门（`filterReadableSheetRowsForAccess`）+ record 级 deny（投影内）+ LOCK-3 real-DB security goldens | ✅ #2961 |
| **T2/T3** | 只读 FE 历史中心（时间线 + actor/source/action 筛选 + 可展开批次明细）+ `useHistoryCenter` composable + 🕰 工具栏入口 | ✅ #2961 |

## 2. 关键设计锁落地

- **LOCK-1**（read model 非并行写库）：投影只读现有 `meta_record_revisions`；唯一写侧改动 = 在现有日志上加 `batch_id` 分组列（nullable、inert），不复制行、不另立事实源。
- **LOCK-12**（一次用户动作 = 一个 batch）：单动作默认 `batch_id = 修订自身 id`；bulk `patchRecords` 全行共享一个 `batch_id`（→「bulk = 一个 batch」）。legacy 行（NULL）回退自身 id（各自一 batch，不误并），标 `provenanceQuality='legacy'`。
- **LOCK-11**（排序确定性）：`created_at DESC, version DESC, id DESC`（现表 uuid PK 无 sequence，不假设）。
- **LOCK-3**（权限先于 list/count/detail）：行级 rule/grant-deny 整条 record 从投影剔除；整批被拒 → 批次不可见且不计入 total；混合批次仅报 `visibleAffected*`（post-filter）；明细对「被拒」与「不存在」返回**同一 404**（无存在性 oracle）；admin bypass + flag-off inert，复用现有 `loadDeniedRecordIds` 机制。

## 3. LOCK-3 real-DB security goldens（load-bearing — CI `test (20.x)` PASS）

`multitable-history-events-realdb.test.ts`（plugin-tests 白名单，6/6 绿）：
- bulk 动作 = 一个 batch，报 2 条可见记录；
- flag-ON + deny：整批被拒的 batch 不出现且 total 不计；混合批次的被拒 record 被剔除（total + `visibleAffectedRecordCount` 均 post-filter）；
- 明细：被拒 batch 与不存在 batch 同为 404（同 shape，无 oracle）；可见混合批次仍可打开，仅含未被拒 record；
- admin bypass：管理员看到被拒 batch + 完整计数；
- flag-off：即使已写 deny 规则，全部可见（byte-inert）。

## 4. 验证汇总

- backend `tsc --noEmit`：0 error；
- backend unit：**3726/3726 pass**（无回归，含 record-history / record-write 改动）；
- web `vue-tsc -b`：0 error；
- web FE：`multitable-history-fe.spec.ts` **5/5 pass**（composable load/toggle 永不抛、denied→null 无 oracle）；入 `multitable-web-guard` vitest 列表；
- **real-DB goldens：CI PASS**（#2961 合并即 `test (20.x)` 绿）。

### 4.1 CI 抓到并已修的两个 bug（goldens 的价值）
1. **seed 写了不存在的 `meta_records.base_id` 列** → 6 测试在 seed 阶段全挂；修：INSERT 去掉 base_id。
2. **`COALESCE(batch_id, id)` 文本/uuid 类型不匹配** → detail 路由 500（2 测试 500 vs 期望 200/404）；修：`id::text` 转型。
（二者本地 tsc 均无法发现，正是 real-DB goldens 的设计目的。）

## 5. 保持 gated（未建，各自独立 opt-in）

- **T5/T6** restore（必须经 preview token；revert/reset 语义 + reset all-or-nothing preflight）；
- **T8** 时点恢复（PIT restore，owner-gated + impl 前独立 design-lock）；
- **T9** config/schema 变更捕获与恢复；
- 跨 base 搜索、retention/checkpoint、async restore 上限。

## 6. PR / SHA 账本

- 设计锁 canonical（前序）：#2952（`108ed1bd9`）；T0 ratify 对象：**#2958（`db520a26f`）**；只读 MVP：**#2961（`5cf527ac5`）**。
