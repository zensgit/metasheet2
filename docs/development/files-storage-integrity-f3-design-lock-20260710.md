# F3 存储层完整性安全刀 design-lock — 2026-07-10

> Status: **RATIFIED**（owner 复审 #4055 三 findings + 三追加验收点；autonomous 主循环 ratify，
> 基于 2026-07-10 侦察报告 @ origin/main 2331a33d，实现基线 @ 9dba447fb 已含 F1/F2 #4055）。
> owner 已预授权：锁写清调用方/旧数据迁移/readiness 后即进实现。
> **这是安全刀**（P1 路径穿越 + 存储完整性）——权限/存储层红线由 owner 本轮 findings 明示解除。
> 实现分支 `claude/files-storage-integrity-f3-20260710`；refs #3925。

## 缺陷（owner findings，代码已确认 @ 实现基线）

- **F3-1〔P1〕路径穿越 + 同名覆盖**：`StorageService.ts` `LocalStorageProvider.upload`（~L209）——
  `filePath = options.path ? path.join(options.path, filename) : filename`（~L211，path/filename 客户端可控）→
  `path.join(basePath, filePath)` → `fs.writeFile` 无 containment、无独占。`../` 逃逸；两人同名 `photo.jpg`
  覆盖同一物理文件；随机 uuid fileId（~L213）与物理路径脱钩，`exists(uuid)` 检查形同虚设。
  入口：`files.ts` upload 路由 ~L90 `req.body.path` + ~L94 `originalname`。
- **F3-2〔P2〕重启 ID 漂移**：upload 发 uuid（~L213），重启 `scanDirectory` 用 `md5(relpath)`（~L186）→
  DB 存 uuid、重启后内存索引换 md5 → `download(uuid)` 404，但考勤 G2 / multitable 均凭 DB 行仍认。
  **同一 bug 击穿考勤照片 + multitable 附件下载两条线**（`univer-meta.ts` ~L15567 → `readAttachmentBinary`
  → `storage.download(uuid)`，经内存索引）。
- **F3-3〔P2〕admin 绕 tombstone**：`loadActiveFileOwner`（`files.ts` ~L39）`WHERE deleted_at IS NULL`
  把 missing 与 deleted 都折成 `null`；`filesAclAllowsAccess`（`filesAcl.ts` ~L91）`admin → true` 优先 →
  admin 对 tombstoned（blob 残留）仍可 info/download。

## 设计裁决（G1-G9 = 审阅逐门表）

- **G1 物理 key 服务器生成、id 派生（消 F3-1 覆盖+穿越 + F3-2 漂移根因）**：`LocalStorageProvider.upload`
  **忽略客户端 `path` 决定物理布局**；物理 key = `<uuid>/<safeBasename>`（uuid 目录唯一 ⇒ 无覆盖；
  `safeBasename` = 客户端 filename 仅取 `path.basename`（先把 `\` 归一化为 `/`）并剥控制字符 + 前导点，
  纯展示、进不了 containment 之外）。`id = uuid`（该 key 的父目录段，**可从 path 确定性还原**）。
  客户端 originalname 仅入 `StorageFile.filename`（展示）/ `url` / files.meta.filename（已存）/
  multitable original_name（已存）。**扁平 uuid 布局**（不保留 sheetId/fieldId 客户端组织布局，见 OUT）。
- **G2 containment 断言 + 独占创建（F3-1 纵深防御）**：共享 `assertWithinBase(basePath, key)` —— 写盘/读盘前
  `path.resolve(basePath, key)` 必须 `=== resolve(basePath)` 之下（`startsWith(resolve(basePath)+sep)`，
  且不等于 base 本身），否则 `throw`（即使 key 已服务器生成，作硬底；读路径同样过 containment）；
  `fs.writeFile(..., { flag: 'wx' })` 独占，**Buffer 与 Readable-concat 两分支都加**（uuid 目录理论无碰撞，wx 兜 bug）。
- **G3 DB 行 = id 权威、按 id 读不依赖内存扫描（满足 owner 验收点 A readiness + 多实例 + F3-2）**：
  `files` 表加 `storage_key text`（migration，backfill 见 G5）；upload 持久化 `storage_key`；
  download/info 由 **DB `storage_key` 直接定位物理文件**（新 provider 方法 `downloadByKey(key)` 走确定路径，
  **不经 `scanDirectory` 内存索引，且下载路径彻底移除 `getFileInfo(id)` 内存预检**——否则冷索引会在
  `downloadByKey` 之前先 404，默默作废 G3/测试 5）。info 路由对 active 行**完全由 DB 行服务**（meta 的
  contentType/filename/size + row.url + storage_key + created_at），不碰内存索引 → 重启后首请求即可读，
  无 warmup 假绿窗口。`missing`（无 DB 行的极老遗留对象）+ admin 回落旧内存索引路径（byte-identical，见 G7）。
- **G4 rebuild 稳定性**：`scanDirectory` 对新布局 `<uuid>/<safeBasename>` 令 `id = <uuid> 目录段`
  （确定性还原，非 md5）；旧扁平文件回落 md5（现行为，vestigial）——但 id 查询已走 DB `storage_key`，
  rebuild 不再是 id 权威，漂移面消失。`md5`/`overwrite` 死分支（`enhanced-plugin-context` `setStorage`，
  经确认全仓零外部调用者、且 read/write 键不匹配本就是死读）不再走 overwrite；每次写新 uuid 文件——
  死路径可接受（G4 授权），非本刀新增回归。
- **G5 旧文件兼容（owner 验收点 B，backfill/fallback）**：
  - files：migration 加 `storage_key` 列 + JS backfill——旧行物理位置 = `url` 去 baseUrl 前缀
    （侦察证实 `url = ${baseUrl}/${filePath}`，`filePath` = 旧物理相对路径 = 新语义的 key）。backfill 保守：
    仅当 `url` 以配置 baseUrl 前缀开头才回填，否则留 `NULL` 交 runtime fallback（避免错误非空值遮蔽正确回落）。
    回填后旧 uuid 凭 `storage_key` 直接定位旧物理文件，**部署后旧考勤证据不 404**。
  - multitable_attachments：已有 `storage_path` 列（storeAttachment 一直写入物理路径）→ download 改走
    `storage_path` 直读（同 G3），**无需 backfill**（旧行 storage_path 已是正确物理路径）。
  - runtime fallback：`storage_key` 为空的极老 files 行 → 读时回落 `url` 去 baseUrl 派生 key（防 backfill 遗漏；
    files.ts 用与 getStorageService 同一 `STORAGE_BASE_URL || 默认` 计算 baseUrl，与 provider basePath 成对）。
- **G6 provider 不变量（owner 验收点 C）**：设计锁声明不变量「**upload 返回的 fileId 在进程重启/新实例后仍指向
  同一物理对象**」。逐 provider 核对：LocalProvider 经 G3 `storage_key` 直读满足（id=uuid，key 由 DB 权威）；
  S3StorageProvider（死代码，OUT，不激活）天然 `id === key === path`（`download(fileId)` 即 `getObject(key)`），
  确定性、无内存索引、无 md5 rebuild，本就符合不变量——不改其 upload，但补 `downloadByKey`（= `download`）
  以统一接口，不留「只修本地扫描」的分叉。
- **G7 admin-tombstone 三态（F3-3，最小面全在 `files.ts`+`filesAcl.ts`）**：`loadActiveFileOwner` → 改
  `loadFileRecord`，去 `deleted_at IS NULL`、SELECT 带 `deleted_at`/`storage_key`/`url`/`meta`/`created_at`，返
  `{ state:'missing' } | { state:'active', ownerId, storageKey, url, meta, createdAt } | { state:'deleted' }`；
  `filesAclAllowsAccess` 对 `deleted` **含 admin 全员 false（404-for-all）**，`active` owner-or-admin，
  `missing` admin-only（#4055 现状）。delete 路由分支改按 `record.state`：`active` → tombstone-first（现行为）；
  `missing`+admin → 旧 exists-gated storage.delete；`deleted` 在 ACL 门即 404（含 admin），
  **不再二次 tombstone/删 blob**（blob 补偿删除是独立后台任务，OUT）。
- **G8 波及 multitable 三路径必须同验（侦察 ⚠#1，别留 sibling 半修）**：附件 upload（`storeAttachment`
  ~L400，`uploaded.path` 现为服务器 key，`storage_path` 持久化不变）/ download（`readAttachmentMetadata`
  ~L469 增返 `storagePath`；`readAttachmentBinary` ~L497 改按 `storagePath` 走 `downloadByKey` 直读，
  legacy `storageFileId` 回落）/ cleanup（`attachment-orphan-retention` ~L78 按 `storage_path`，已幸存，验不回归）
  三条真跑通过。两处 basePath 解析（`univer-meta` `ATTACHMENT_PATH` ~L466 vs orphan-retention
  `DEFAULT_ATTACHMENT_PATH` ~L30）对齐核对——同为 `process.env.ATTACHMENT_PATH || join(cwd,'data','attachments')`，一致。
- **G9 测试矩阵（owner 定，八条全真跑，新增 LocalProvider 专项单测——当前零覆盖）**：
  1. 同名双用户上传 → 两独立物理对象不覆盖；2. `../`+编码/反斜杠变体路径穿越 → 拒绝不逃逸 basePath；
  3. 服务重启后按原 fileId 仍可下载；4. tombstone+blob 残留 → owner 404；
  5. **重启后第一请求立即下载**（不留 warmup，防异步索引假绿——G3 的 DB 直读探针；**新实例/冷索引**下证明）；
  6. **新旧格式文件同时存在** → 两者都可访问（backfill/fallback 生效）；
  7. **两次同名上传后分别下载** → 各自字节不变（隔离非最后写赢）；
  8. **tombstone+blob 残留时 owner 与 admin 均 404**（G7 gate）。
  mutation ≥5 刀：拆 containment→#2 红 / 拆 uuid-key 用回 filename→#1&#7 红 / 拆 DB 直读回内存索引（含恢复
  `getFileInfo` 预检）→#5 红 / 拆 backfill/url-fallback→#6 红 / 拆 deleted-404-for-all→#8 admin 分支红。

## OUT（本刀不做，逐项点名）

- S3 provider 实装（死代码，不激活；仅声明不变量符合、补 `downloadByKey` 接口统一）。
- 审批人查看照片的 approval-scoped read grant（#4055 已记的命名后续）。
- 内存索引彻底删除（若仍被 legacy list-scan / missing+admin 回落用则保留；本刀只让 id 查询绕开它，不强拆）。
- blob 补偿删除后台任务（#4055 F2 已记；`storage.delete` 失败仍 200+warn+行失效；deleted 态不重删 blob）。
- 客户端 path 作为组织布局的能力（attachment-service 的 sheetId/fieldId 分组不保留 → 物理扁平化 uuid；
  侦察证无检索方依赖该布局，orphan-retention 只需 (id, storage_path) 一致，与人类可读布局无关）。**最小面：扁平 uuid。**

## owner 三追加验收点 → 实现映射

- **A. 启动就绪性（async index 假绿陷阱）**：`buildFileIndex()` 是 fire-and-forget（~L146 构造器未 await）。
  采用 owner 建议 ②——**按 id 读取不依赖内存扫描完成**：G3 `downloadByKey(storage_key)` 确定性定位，
  下载路径移除 `getFileInfo(id)` 内存预检，info 对 active 行全由 DB 服务。测试 5 用**新 provider 实例**
  （冷索引，`buildFileIndex` 未装入该 id）证明首请求即可下载 → 无 warmup 窗口。
- **B. 旧文件兼容（backfill / runtime fallback）**：G5 —— migration `storage_key` 列 + 保守 JS backfill
  （strip baseUrl）+ files.ts runtime fallback（storage_key 空时 url 派生 key）；multitable 用现成 storage_path。
  测试 6 证明新旧格式共存两者都可访问。
- **C. provider 一致性（不变量跨 provider 统一）**：G6 —— 不变量「upload 返回 fileId 重启后仍指同一对象」
  逐 provider 核对：Local（storage_key 直读）/ S3（id===key===path，死码天然符合）。设计锁写清并补 `downloadByKey`
  统一接口，不让云 provider 语义继续分叉。

## 缺陷根因 → 门映射

- 统一 ID/key（服务器派生、原名仅 metadata、独占创建、containment）→ 消 F3-1 覆盖+穿越、消 F3-2 重启漂移；
  验收点 A（readiness=G3 DB 直读）、B（backfill=G5）、C（provider 不变量=G6）是其正确落地三道护栏。
- `loadFileRecord` 三态化（missing/active/deleted，deleted→404-for-all 含 admin）→ 消 F3-3 admin 绕 tombstone；
  测试 8 是其 gate。

## 固定节奏 + 模型

impl = **opus**（安全刀，跨 files/multitable/storage 三处，最重）；fresh worktree off origin/main；WIP 早推。
commit 分层：migration / storage-service / files-route-acl / multitable-parity / tests。
→ opus 对抗审（权限+存储层最重攻击面）→ **owner 复审**（硬化池关闭由 owner 判定）→ 验证 MD。
tracker 保持 OPEN 至 owner 复审通过。**不合并、不开下一切片。**
