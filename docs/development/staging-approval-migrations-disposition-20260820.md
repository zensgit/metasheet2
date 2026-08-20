# staging 四条审批迁移处置便笺(2026-08-20)

> **给谁**:审批线(执行)+ owner(批准)。
> **谁写的、边界是什么**:Time Machine O-2 线。本便笺是**只读静态分析 + 预填彩排清单**;
> 迁移的应用/标记动作归审批线按 runbook 执行,owner 批准。**本线不代为应用。**
> **为什么存在**:O-2 阶梯 L0 要求 staging `pending migrations = 0`。2026-08-20 部署 `401fa1d880`
> 时对齐报告判 `do_not_run_full_migrate`(run `32321291505`,工件含 `report.md` / `schema-probes.sql`),
> runner 按 bundle §3.2 停止。待应用的恰是下列四条审批线迁移——它们是 L1 唯一的非-owner-button 阻断。

## 1. 逐条判定(全部逐行读过 up/down,非 grep 速判)

| 迁移 | 报告风险 | 实际形状 | 判定 |
|---|---|---|---|
| `zzzz20260817120000_add_handle_action_to_approval_records` | **high** | `DROP CONSTRAINT IF EXISTS` + 重建 `approval_records_action_check`(14→15 枚举) | **启发式误报**——纯 CHECK 加宽,无数据迁移无列变更 |
| `zzzz20260817130000_create_approval_form_field_revisions` | low | `CREATE TABLE IF NOT EXISTS` 新表 + 索引 | 新建表,幂等 |
| `zzzz20260818090000_add_policy_denied_action_to_approval_records` | **high** | 同第一条(15→16 枚举) | **同上,启发式误报** |
| `zzzz20260818120000_create_approval_usable_member_groups` | low | `createTable` 新表 + **条件式** ADD PRIMARY KEY(查 `pg_constraint` 先)+ 索引 | 新建表,幂等 |

报告把前两条标 high 的理由是「up 含看似非幂等的 CREATE TABLE 或 DROP」——扫描器看到 `DROP` 即 high,
这是它设计上的保守。实际 `DROP CONSTRAINT IF EXISTS` + 重建同名约束是**幂等的约束交换**。

## 2. 锁与验证行为(比"纯加宽"再深一层,如实)

- 两条 CHECK 迁移的 `ADD CONSTRAINT … CHECK` **不带 `NOT VALID`** ⇒ 会做**验证式全表扫描**,
  期间持 `ACCESS EXCLUSIVE`。staging 的 `approval_records` 行数小,扫描时长可忽略。
- **验证不可能因存量行失败**:新 CHECK 是旧 CHECK 的**严格超集**(只加枚举成员),满足旧约束的行
  必满足新约束。
- **无裸窗口**:Kysely migrator 单事务跑每条迁移,DROP→ADD 间 `ACCESS EXCLUSIVE` 一直持有,
  其他会话无法在约束缺位期间插入。
- down 路径带 `NOT VALID`(缩窄方向,已有 `handle`/`policy_denied` 行会让验证失败,作者刻意规避)——
  仅在回滚时相关,此处不涉及。

## 3. 对 Time Machine O-2 阶梯的爆炸半径(为什么 O-2 线不拦)

- 四条迁移**零 ALTER** 任何平台授权表 / `meta_links` / `meta_record*`。
- 唯一交点:`approval_usable_member_groups.created_by → users.id` **新增外键**(写该表对 `users`
  行取 `KEY SHARE`)。这是阶梯 §4 foreign-fence 形状的非多维表实例,**已被 canary 3.5a(#5032)
  纳入 L4/L5 演练**;它不阻断迁移应用本身。

## 4. 预填彩排清单(runbook 要求:`do_not_run_full_migrate` ⇒ 先在克隆/备份库彩排)

1. 取 staging DB 克隆或备份恢复库(审批线/ops 通道)。
2. 跑报告工件里的 `schema-probes.sql`(run `32321291505` 工件;只读,`BEGIN READ ONLY` 包裹)。
   **期望前置态**:`approval_records` 存在且带旧 CHECK;`approval_form_field_revisions`、
   `approval_usable_member_groups` **不存在**。若探针显示任一新表已存在,先查 `kysely_migration`
   是否有半应用痕迹再动。
3. 在克隆上跑 `migrate.ts`(全量;四条按 zzzz 序应用),确认:四条全 success、
   `approval_records_action_check` 为 16 枚举形、两张新表就位。
4. 彩排通过后按 runbook 对 staging 正式应用,然后**重跑一次 window-runner deploy**
   (`deploy_sha` 用当时 main 的全 40 位 SHA)——对齐报告应转 `pending=0`,deploy 不再 STOP。
5. 完成后知会 Time Machine 线:L0 的「staging pending ≠ 0」子项即可关闭。

## 5. 免责与边界重申

本便笺不构成迁移安全证明(runbook 原话:probe ≠ safety proof);彩排在克隆上**必须真跑**,
不能以本便笺替代。四条迁移的业务正确性归审批线;本便笺只回答「它们挡不挡 O-2 阶梯、
按什么清单彩排」两个问题。
