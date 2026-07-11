# 文件证据安全 / 存储完整性线 — 设计 + 验证记录（2026-07-10）

> **状态**：自主开发层已全部落地 `main` 并各过独立 opus 对抗审（0 P1/P2）。
> **本文不是收官声明**：硬化池状态仍 **OPEN**，等 owner 复审；余下 owner 决策项在文末单列。
> 命名遵循 [[completion-claim]] 纪律——本文档记录「已落地什么、如何验证」，不宣布「全部开发好了」。

## 线的由来
本线源于 owner 对考勤硬化池的三轮复审：F1（资源级 ACL）/ F2（tombstone-first 删除）/ H2（magic-byte 前缀筛查）
合入后，暴露出更深的存储层根因——打卡照片作为敏感证据接入通用文件接口后，既有存储层缺口的暴露面变化，
不能再作为 OUT 排除。owner 逐刀显式授权解除存储/权限层红线，遂有 F3/F5/F6。

设计锁（已提交 `main`）：
- `files-acl-tombstone-f1f2-design-lock-20260710.md`（F1/F2）
- `files-storage-integrity-f3-design-lock-20260710.md`（F3）
- F5/F6 设计裁决见本文 §F5 / §F6（未单独出设计锁文件，合并记于此）。

---

## §F1+F2 — 资源级 ACL + tombstone-first 删除（PR #4055）
**缺陷**：`routes/files.ts` 的 list/info/download/delete 四端点**无资源级 ACL**——任何登录用户可枚举/读/删他人考勤照片；
删除顺序（storage 先删→DB 删败）会重造悬挂证据。
**裁决**：四端点 owner-or-admin，否则 404（防枚举，不用 403 泄漏存在性）+ anonymous 哨兵三端拒；删除改 tombstone-first
（DB 先 `deleted_at`，物理后删；物理失败仍 200，blob 留补偿清理，绝不留悬挂 DB 证据）。
**验证**：opus 对抗审 APPROVE 0 P1/P2；四端点 ACL + 404 防枚举 + tombstone 顺序注入测试双向；两 NIT 已修。

## §F3 — storage-key DB 权威直读（PR #4063 → main `7d4cb8027`）
**缺陷**：①〔P1〕`LocalProvider.upload` `join(basePath, clientPath, filename)` 无 containment、无独占 → `../` 逃逸 +
同名覆盖；②〔P2〕upload 发 uuid 但重启 `scanDirectory` 用 md5(relpath) → download(uuid) 404，考勤照片 + multitable
附件两线同时击穿；③〔P2〕`loadActiveFileOwner` 把 missing 与 deleted 都折 null → admin 对 tombstoned 仍可读。
**裁决（G1-G9）**：G1 服务器 `<uuid>/<safeBasename>` 忽略客户端 path、id 派生；G2 `resolveWithinBase` 写读双 containment +
`wx` 独占；G3 `storage_key` 列 + `downloadByKey` DB-key 直读绕内存索引（无 warmup 假绿）；G5 迁移 backfill + 受控
runtime fallback；**POISON 碰撞策略**（碰撞组全 poison 无赢家 / provider 前拒 / 读路径在 fallback 之前判 poison→硬 404，
绝不被原 URL 重推洗掉 / 保留原 url + 可审计冲突清单 / 未识别异常·DB 错误才整笔 abort）；G7 三态 ACL（deleted→404
含 admin）；G8 multitable 三路径同修；迁移单事务原子化。
**验证**：opus 对抗审 APPROVE 0 P1/P2；三攻击面逐条证伪失败（路径穿越各变体 / poison-不被-fallback-洗〔盘上放真 blob
仍 404〕/ admin-绕-tombstone）；mutation M1-M6 逐一红→还原；八测试矩阵 real-DB + real-fs 真跑；迁移原子化双失败路径
schema+data 双验。审 MD `/tmp/pr4063-f3-review-claude-20260710.md`。

## §F5 — blob 补偿删除 + delete 路径根因修（PR #4072 → main `0012422fe`）
**缺陷 / 发现**：F2 tombstone-first 在物理删失败时留孤儿 blob，需后台对账回收。核合并 F3 代码更发现 delete 路由物理删
仍是 `storage.delete(id)`（by uuid → 内存索引 → 与 F3 修前 read 同源的漂移：重启后 md5 索引找不到 uuid，blob **每次**
成孤儿，非仅罕见失败）。
**裁决（GF5 逐门）**：
- GF5-1 新增 `files.blob_purged_at` 消费列（现有 orphan-retention 用 `deleted_at` 当标记，与 F5 入口 `deleted_at IS
  NOT NULL` 相反，天真 sweep 会**无限重删**）；sweep 查询 `deleted_at IS NOT NULL AND blob_purged_at IS NULL AND 过 grace`。
- GF5-2 新增 `deleteByKey(storageKey)`（Local：`resolveWithinBase` + `fs.unlink`，**ENOENT 吞成成功=幂等**；S3/Impl 对称）。
- GF5-3 poison（复用 `isPoisonedStorageKey`，与 F3 同源）+ null storage_key 跳过物理删；GF5-3b 删前
  `count(*) WHERE storage_key=$key AND blob_purged_at IS NULL AND id<>$id`=0 才删（防误删碰撞组共享 blob）。
- GF5-7 **delete 路由根因修**：`storage.delete(id)` → 解析 storage_key（持久 / E-fallback / poison-skip）→ `deleteByKey` →
  成功（含 ENOENT）stamp `blob_purged_at`，失败留 null（sweep 兜）；`missing` 分支不变；ACL 门 + tombstone 顺序原封。
- GF5-6 独立 setInterval sweep（照抄 attachment-orphan-retention 骨架，env 门默认 OFF，unref，grace 防竞态，无 leader
  lock——幂等 + ENOENT ⇒ 跨实例 at-least-once 安全）。
**验证**：opus 对抗审 APPROVE 0 P1/P2；攻击面全证伪（ACL untouched / tombstone 顺序 / poison-never-deleteByKey /
containment / 删失败不 stamp / 无限重删）；7/7 mutation 红→还原；八矩阵 real-DB + real-fs 真跑；CI gate 确认真库跑非死测。
审 MD `/tmp/pr4072-f5-review-claude-20260710.md`。**残尾（design-lock 明示边界，非缺陷）**：null-storage_key 行 route-time
非-ENOENT 删失败后 sweep 不回收（行已 tombstone→证据完整，仅盘空间对极端 legacy 边角未回收）。

## §F6 — 存储层死码 + doc 清理（PR #4076 → main `a9ceef97e`）
**scope 诚实收缩**：原目标「退役 scanDirectory/md5 漂移底物」经侦察证**不可行**——该内存索引仍是 missing-state legacy
blob（无 DB 行的 pre-S2 文件，admin download/info/delete 靠启动扫盘定位）+ multitable `deleteAttachmentBinary` +
两处 upload 回滚的**活底物**。故 F6 缩为死码 + doc 清理，**非安全/功能修**。
**裁决（GF6 逐门）**：GF6-1 删死码 `S3StorageProvider` 组（class + `createS3Service` + export + 13 个 S3* 接口，−420 行；
编译安全、零 importer、无 env 触发、`aws-sdk` 非依赖）；GF6-2 内存索引/scanDirectory 家族**只注解不物理删**（活底物保留）；
GF6-3 修迁移注释第三处 stale `'abort' (DEFAULT)`→poison；GF6-4 注释 inert `file:deleted` payload。
**验证**：opus 对抗审 APPROVE 0 P1/P2；15 个 S3 符号 PR 树零剩余引用、tsc 0（死码铁证）；活底物全保（`deleteByKey`
三处真功能 + 内存索引家族）；OUT 边界一寸未越；5 个真-DB 套 + 单测全绿。审 MD `/tmp/pr4076-f6-review-claude-20260710.md`。

---

## §owner 复审 + F9 修复 — owner CHANGES-REQUESTED（2026-07-10）

前批（F1–F6）各过独立 opus 对抗审 0 P1/P2 后，**owner 亲自复审又挖出 3 个 P2**——opus 两轮都漏。
如实记录（不留「全 opus-clean」的假象）：

| owner 挖出（P2） | 本质 | F9 修法 |
|---|---|---|
| **P2-1** multitable 正常删除仍走漂移内存索引 + cleanup 不回收正常软删行 | 我在 F5 把 multitable delete 显式 OUT = **sibling 半修** | `deleteAttachmentBinary` 改 `deleteByKey(storage_path)`（消漂移）+ Option A 补偿（新 `blob_purged_at` 列 + 补偿 sweep，草稿 sweep 连带 stamp） |
| **P2-2** files delete 的 URL fallback key 未回写 → 失败后 `storage_key=NULL` 被 F5 sweep 排除永不重试 | F5 delete↔sweep 交互洞 | resolve 上移 + 原子 `UPDATE … deleted_at=now(), storage_key=COALESCE(…) WHERE deleted_at IS NULL`（避开「tombstone 后独立 UPDATE→no-op」坑） |
| **P2-3** F5 sweep poison/shared-key 只 skip 不写终态 → head-of-line 饿死后面可清理 blob | F5 sweep 批次逻辑洞 | SQL 候选阶段 `NOT starts_with(storage_key, FILES_POISON_KEY_PREFIX)` 排除 poison；owner 点名 `batchSize=1 + oldest-poison + newer-valid` 测已加 |

外加 P3（test NUL 字节转义 + F5 四 env 进 .env.example）。

**F9 = PR #4094 → main `66f9edae5`**（Sonnet impl）：opus **深审 APPROVE 0 P1 / 0 新 P2**，4/4 mutation 红→还原；
且专门做了 **Part-2「同类再猎」——无第四类**（无别的 sibling 漂移删路径、无新 sweep 饿死、回收洞 airtight）。
审 MD `/tmp/pr4094-f9-review-claude-20260710.md`。

**教训（进本线永久记录）**：
1. **opus「0 P1/P2」在本线不足以预测 owner 验收**——owner 更深复审三次挖出 opus 漏的问题（F1/F2→F3、F5→3 P2）。
2. **「已在别处修」≠「这条平行路径也修了」**——sibling delete 路径必须一起修，否则半修 = P2（P2-1 即此）。
3. 补偿 sweep 默认 OFF 是**故意**（复用默认-ON 的 cleanup flag 会在下次 deploy 静默删每条历史软删 blob）；主修（deleteByKey +
   交互同步 stamp）是 always-on，与 gate 无关；仅残留真失败尾的补偿受 env 门。

---

## 落地清单
| 刀 | PR | main sha | 模型 | opus 审 |
|---|---|---|---|---|
| F1+F2 | #4055 | — | — | APPROVE 0 P1/P2 |
| F3 | #4063 | `7d4cb8027` | opus impl | APPROVE 0 P1/P2·M1-M6 红 |
| F5 | #4072 | `0012422fe` | sonnet impl | APPROVE 0 P1/P2·7/7 mutation 红 |
| F6 | #4076 | `a9ceef97e` | sonnet impl | APPROVE 0 P1/P2 |
| **F9**（owner-P2 修复） | #4094 | `66f9edae5` | sonnet impl | APPROVE 0 P1/**0 新** P2·4/4 mutation 红·Part-2 再猎无第四类 |

迁移 on `main`：`zzzz20260710140000_add_files_storage_key.ts`（F3）+ `zzzz20260710150000_add_files_blob_purged_at.ts`（F5）
+ `zzzz20260711090000_add_multitable_attachments_blob_purged_at.ts`（F9）。

## 余下 = owner 决策 / ops / 红线（**非自主开发项**；自主开发层已尽）
> 说明：以下**不是**我在拖延的「开发」——是定义上非自主的项（红线只 owner 能解、tracker 是 owner 的账、env 是部署动作）。
1. **硬化池关闭 / tracker 状态**：owner 复审后判定；本文与自主层**均未触碰 tracker**、未宣布关池（状态仍 OPEN）。
2. **F4 审批人 read grant 实现**：新授权路径（权限层，须 owner 逐刀显式授权）+ 无活需求方（审批 UI 未渲染照片）→ 设计已定
   （见 §owner 决策项引用的 f4-design-lock；机制 A，复用批准门 `assertAttendanceRequestApprovalAllowed`，与本线零碰撞），**实现 gated**。
3. **retention env prod 启用**（ops）：`FILES_ORPHAN_BLOB_RETENTION_ENABLED` / `MULTITABLE_ATTACHMENT_BLOB_RETENTION_ENABLED`
   默认 OFF；启用兜住残留真失败尾（**不影响主修生效**——主修 always-on）。
4. **F7 深度图片校验**：owner 已接受 lazy-forgery 威胁为 P3 → 默认不做。
5. **listFiles 接口移除 + setStorage/getStorage plugin 契约移除**（F8，cosmetic）：公开接口/插件契约收窄，非局部死码，留 owner 决策；暂停。
6. **N1 NIT（后补）**：`isDatabaseSchemaError` 未认 42703（undefined_column）；F9 后 default-ON 草稿 sweep 耦合新列，
   deploy-before-migrate 窗口优雅降级不崩、迁移后自愈，仅日志文案影响。

## 部署提示
本线引入两个新迁移。按 deploy SOP：镜像拉取部署前 diff pending migrations、**先迁移后代码**、验证一次 auth round-trip。
