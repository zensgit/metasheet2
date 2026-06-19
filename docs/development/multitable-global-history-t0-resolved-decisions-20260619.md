# 全局历史与时点恢复 — T0 已决项(resolved decisions / ratify object)

> **状态**:**T0 — review-only,no runtime。** 本文解决 `multitable-global-history-pit-restore-design-lock-20260619.md` §8 的 7 个 open decisions + 锁定**首刀数据模型形态**与 **MVP 边界**,作为 owner 的 **ratify 对象**。ratify 后才进 T1 runtime(届时才有 migration / route / flag —— 本 T0 不引入任何)。
> **基线**:`origin/main`(`meta_record_revisions` 已带 snapshot/source/actor_id/changed_field_ids/version/created_at,uuid PK,无 sequence;`recordRecordRevision` 是 revision 写入的单一 chokepoint)。

## 0. 一页结论

首刀(MVP)= **read-only 全局历史中心**,projection-on-read 跑在**现有** `meta_record_revisions` 上(遵 LOCK-1:history 是 read model,不建并行写主键)。唯一新增的写侧改动 = 给现有 revision 写入**盖一个确定性 `batch_id`**(LOCK-12:一次用户动作 = 一个 batch),**不是**并行 history 存储。T5–T9(restore/preview/PIT/config)保持 gated。

## 1. §8 七项 open decisions —— 已决

### D1 投影如何产生(materialize / backfill / project-on-read)→ **project-on-read + 确定性 batch_id 戳**(recommended)
- **read model = project-on-read**:`history_batches` / `history_changes` 是对**现有 `meta_record_revisions`** 的**只读投影**(group + permission-filter on read),不落新写主键 —— 遵 LOCK-1。
- **但**纯 project-on-read 的 batch 分组**会失败**自身 T1 测试「bulk update = ONE batch」:`meta_record_revisions` **无 txn/request id**,时间窗启发式会**错拆/错并**一次动作。**故 D1 = 给现有 revision 写入加一个确定性 grouping key**:
  - **新增列**:`meta_record_revisions.batch_id text NULL`(+ index `(sheet_id, batch_id)`);
  - **戳入点**:`recordRecordRevision`(单一 chokepoint)接受 `batchId`;调用方**一次用户动作生成一个 `batch_id`**(create/update/delete/restore/bulk = 同一 action 内同一 id);
  - **这不是并行写主键**:它是现有 append-only 日志上的一个分组列,不复制行、不另立事实源 —— LOCK-1 不破。
  - **旧行(无 batch_id)**:投影时回退 LOCK-12 启发式(同 actor + 同 source + 时间窗)并标 `provenanceQuality='legacy'`;不假装确定性。
- **deferred 规模路径**:若未来超大规模,materialize-via-background-job(物化 `history_batches`)是单独优化,不在 MVP。

### D2 MVP 范围(one base / one sheet / all sheets in a base)→ **one base(含 base 内全部 sheet)**
全局历史中心 = **base 级**入口,聚合 base 内各 sheet 的变更。跨 base 搜索 = gated(TODO §4)。

### D3 首版 source 枚举 → **复用 `meta_record_revisions` 现有 source 值**,映射到设计枚举
现有值:`rest` / `multitable` / `admin` / `automation` / `import` / `restore` / `global-rbac` / `button`。映射到设计 `manual | api | automation | import | ai | restore | system`:
- `rest` / `multitable` / `button` → **manual**(交互写);`admin` / `global-rbac` → **system**;`automation` → **automation**;`import` → **import**;`restore` → **restore**;(`ai` 暂无对应 source,留枚举位,无数据)。
- **锁**:映射是投影层的纯函数,单一真相;新 source 值新增只改这一处。

### D4 read model 保留承诺 → **MVP 无独立保留策略**
read model 是对现有 revisions 的投影(无独立存储),**继承 revisions 生命周期**;retention / checkpoint 是设计锁 §6 的耦合区,**随 restore/PIT 一起再决**(T5+/T8),不在 read-only MVP。

### D5 preview token 形态(persisted / signed / cache)→ **deferred(T5,gated)**;倾向**短时签名 payload**(绑 strategy+scope,非持久行)。不在 MVP。

### D6 batch restore 最大体量 / async 阈值 → **deferred(T6/T8,gated)**。不在 MVP。

### D7 config 变更是否进首版投影 → **完全 deferred(T9,gated)**;首版投影**不**捕获 config/schema/view 变更。

## 2. 首刀数据模型形态(ratify 重点)

- **唯一 schema 改动** = `meta_record_revisions.batch_id text NULL` + `idx_meta_record_revisions_sheet_batch (sheet_id, batch_id)`。无新表。
- **投影(read-only)**:
  - `history_batches` = `meta_record_revisions` 按 `batch_id` 分组(legacy 行按启发式)→ batch summary(actor/source/action/time/visibleAffected{Record,Field}Count)。
  - `history_changes` = 组内逐行(record_id, changed_field_ids, before/after via snapshot, version)。
  - **排序确定性(LOCK-11)**:`created_at DESC, version DESC, id DESC`(现表无 sequence,不假设)。
  - **权限(LOCK-3)**:row rule-deny → 整条 record 不出现在 list/detail/**count**;field-mask → 仅隐字段值/名;count 用 **visibleAffected\***(post-filter),raw 不返回非 admin。

## 3. MVP 边界(锁)
**runtime 首批仅**:**T1**(batch_id 戳 + project-on-read 投影 + 路由)+ **T4**(permission-safe query + LOCK-3 real-DB security goldens —— load-bearing 交付物)→ 之后 **T2 ∥ T3**(read-only FE,可并行)。**T5/T6(restore 经 preview)+ T8(PIT restore)+ T9(config)保持 gated**,各自独立 opt-in。

## 4. T0 自证(review-only)
- 本 PR **docs-only**:无 migration、无 route、无 flag、无 FE。
- ratify 后,T1 才引入 `batch_id` migration + `recordRecordRevision` 戳入 + 投影路由;T4 紧随补 LOCK-3 goldens。
