# metasheet2 审计：SUPERSEDED_LEGACY_SQL_MIGRATIONS 缺继任 / 漂移分析 — 2026-07-10

> 触发：S2 车道（PR #4016）实证发现 035_create_files 被一揽子 skip 且无现代继任 → 新鲜迁移库缺表。
> 本审计 = 同类缺陷全量清查。基线 origin/main。审计者：Explore agent（只读），主循环归档。

## 0. 机制澄清（两套独立系统）

| 机制 | 位置 | 行为 | 清单 |
|---|---|---|---|
| `SUPERSEDED_LEGACY_SQL_MIGRATIONS` | migration-provider.ts:21-51；:114-121（createNoopMigration）、:195-197、:225-229 | **改成 no-op**：名留史、up() 空转，新装不重放。逃生阀 `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true`（:186-188） | 032–055 共 29 项 |
| `MIGRATION_EXCLUDE` | :189-194、:198、:231-233 | **整条移除**（连历史都不留） | CI plugin-tests.yml:161/:563 |

- 两清单仅 048/049/042a 三项重叠（重复无害）。
- **关键推论**：CI 的 MIGRATION_EXCLUDE 还排除一批现代迁移（views_view_states/gantt/view_tables/snapshot_labels/protection_rules/change_management）→ plugin-tests 跑的是**裁剪版 minimal schema**，结构上**抓不到**全新安装缺表——缺陷类无 CI 护栏。
- 29 条 SUPERSEDED 项全部对应真实文件；无 CREATE TYPE/ENUM/DOMAIN → 枚举维度 N/A。

## 1. 缺口表（被 skip 且全新安装无现代继任）——全部僵尸，低危

| Legacy | 对象 | 读写方 | 危级 |
|---|---|---|---|
| 035_create_files | files 表 + idx_files_owner | 僵尸 0 ref（**已由 PR #4016 桥接闭合**） | 低（已修） |
| 037 | view_configs + 3 索引 | 僵尸 | 低 |
| 038 | secrets / secret_access_logs / config_history | 僵尸（复活前须安全评审） | 低 |
| 040 | data_source_schemas/query_templates/query_history/data_sync_jobs/data_sync_history/connection_metrics | 僵尸 | 低 |
| 041 | script_sandbox 整包 8 表 | 僵尸 | 低 |
| 042 | workflow_tokens / workflow_incidents | 仅孤立死模块 WorkflowRepository.ts（全 repo 无 importer） | 低（假活） |
| 042/044 | data_source_credentials | 僵尸 | 低 |
| 042/044 | external_tables | 仅孤立死模块 DataMaterializationService.ts（全 repo 无 importer） | 低（假活） |
| 042/046 | templates（裸表） | 僵尸 | 低 |
| 046 | plugin_manifests | 僵尸（现代插件用 plugin_registry） | 低 |
| 042/047 | audit_signatures / query_cache | 僵尸 | 低 |
| 047/048 | event_handlers / event_queue | 僵尸（现代 event-bus ts 建 8 表漏此 2） | 低 |
| 047/048 | event_dead_letters | 软继任 dead_letter_events；EventBusService.ts:875 显式容错 | 低 |

## 2. 漂移（有继任但形状不一致）

| 对象 | 漂移 | 危级 | 证据 |
|---|---|---|---|
| users.permissions | TEXT[] → jsonb，无转换迁移；AuthService.ts:357 Array.isArray 兜底不崩，但 SQL 级语义分叉 | 低-中 | 054:10 vs zzzz20260119100000:16 |
| users.name | NOT NULL → 可空 | 低 | 054:6 vs 同上 :13 |
| users 新列 | avatar_url/is_active/is_admin 老库缺 | 低 | zzzz20260119100000:17-19 |

（spreadsheets 逐列比对洁净无漂移；其余 ~15 张已覆盖表的全量逐列核对属后续工作，跨边界 ALTER 暴露面已核窄。）

## 3. 关键否定结论

任务假设「可能存在活依赖+缺继任=高危」——**逐一验证后：没有**。唯一真正活的跨边界情形是 users 列
（must_change_password / HR 字段），legacy 056/060 的守卫 ALTER 在新装静默跳过，但维护者已用
zzzz20260512100000 + zzzz20260529190000 两条专门迁移闭合。全部现代 ALTER 目标均有现代创建者——
**没有第二个「守卫 ALTER 打向缺继任表」的静默列缺口**。

**headline：真实但全域潜伏的缺陷类——覆盖是逐表 ad-hoc 补的，缺系统性保证；任何僵尸表被复活即命中新装静默缺表。**

## 4. 修复建议（owner 决策项）

1. **P0（治本）**：CI 加一条不带 MIGRATION_EXCLUDE 的「全新库全量迁移 + schema 断言」作业——唯一能防「下一个 files」的措施。
2. **P1**：逐僵尸决策删/建继任；孤立死模块（DataMaterializationService / WorkflowRepository）一并清除或标 deprecated。
3. ~~P1 files 补继任~~ → **已由 PR #4016（S2）落地** zzzz20260710120000_create_files.ts。
4. **P2**：users.permissions 幂等转换迁移（USING to_jsonb）。
5. **P2**：038 secrets 复活前安全评审。
6. **P3**：清理 056/060 恒空转守卫 ALTER 与 MIGRATION_EXCLUDE 重复项。

完整证据锚点（file:line）见审计正文（本 MD 为归档摘要，逐项 file:line 保留在会话记录与 docs 版）。
