# 审批附件主闸 ON:前置核对单 + (a)(b) 两路 UAT 剧本(F2-A1,2026-09-30)

**本文件只是文书,不授权任何动作。** 执行普查、S3 配置、打开 `APPROVAL_ATTACHMENTS_ENABLED`、UAT 都属 owner / ops。
本包的 SQL 与自检不连接任何非一次性库。

- 行号基线:main `cffd5dacbc`。#5476 的内容以其头 `f8cefdbc2` 为准(OPEN、未合入)。
- 前置顺序的来源:审批对标飞书 P2–P4 切片计划(2026-09-30)§4 F2-A1、§5 Q1,以及其「第 5 轮复验更正」R5-1 / R5-3 / R5-4。
  这是计划与复验的建议,**待 owner 确认,不是 owner 裁决**。
- 配套:
  - 顶层普查包 `scripts/ops/approval-attachment-canary-census-20260930/`
  - 设计 / 验证说明 `docs/development/approval-attachment-canary-readiness-pack-20260930.md`

---

## 1. 两份普查,各管什么

| | detail 内嵌普查(#5476) | 顶层普查(本包) |
|---|---|---|
| 文件 | `scripts/ops/approval-detail-attachment-census.sql`(在 OPEN #5476 里,未进 main) | `scripts/ops/approval-attachment-canary-census-20260930/01-top-level-attachment-census.sql` |
| 数的形状 | `detail` 组的 `columns` 里有 `attachment` | `form_schema.fields` 顶层有 `attachment` |
| 主闸 ON 后这类版本行会怎样 | 走校验的读者报错(见 §2 G3 与 §5) | 不报错。它是合法字段类型(`ApprovalProductService.ts:1007`),旗控扫描只拒 detail 形状(`:2366-2372`)。ON 后发起页出现真实上传口(`ApprovalNewView.vue:522`) |
| 在本核对单里的角色 | **硬门**:(b) `matching_versions` = 0 | **owner 取舍输入**:读数交 Q1 (a) / (b) 选择,本文件不把它写成门 |
| 处置 | 依 #5476 处置(owner) | Q1 (b) 的「先定这些模板的处置」,形态由 owner 定 |

本包不复制 #5476 的 SQL,也不含 detail 形状谓词;自检钉住了这一点。

---

## 2. 主闸 ON 前置顺序(按序,前一步不成立就停)

### G1 — #5476 写路径半已部署到**该环境**(或由条件切片 F2-A0 承接)

依据 R5-3:现 main 在主闸 OFF 时,有四条写路径仍会新增 detail 形状的命中行。

- `restoreTemplateVersion` 写入:`ApprovalProductService.ts:6466`
- `createTemplate` 写入:`:6541`
- `updateTemplate` 写入:`:6695`
- `cloneTemplate` 写入:`:7166`

原因:

- `attachment` 在 `FORM_FIELD_TYPES` 里(`:1007` 起)。
- `DETAIL_LEAF_FIELD_TYPES` 没有排除它(`:1114-1122`)。
- 唯一的拒绝在 `assertFormSchema` 内,且只在主闸 ON 时生效(`:2366-2372`)。

所以只有 #5476 写路径半部署之后,(b) 才不再增长,G2 的读数才稳定。

### G2 — 在该环境实跑 #5476 普查,读 (b)

- 读数的时间戳必须**晚于 G1 的部署时间**。早于部署的读数作废。
- 运行方式:只读角色、整文件、保留日志。#5476 那份文件没有完成行,不完整只能靠退出码和结果块判断:

```bash
psql "$READONLY_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET default_transaction_read_only = on' \
  -f scripts/ops/approval-detail-attachment-census.sql > detail-attachment-census.log 2>&1
echo "rc=$?"   # 必须是 0,并且日志里 (a)(b)(c)(c-detail) 四个结果块都在;否则判「未完成」,不是「零」
```

- 判据**只看 (b) 段 `matching_versions`**。
  - (b) 对 `approval_template_versions` 全表计数,不分状态(`#5476 census :115-123`)。
  - 不要用 (a) 代替:(a) 取 active 优先(`:102-104`),而模板读取取 latest 优先(`ApprovalProductService.ts:6343`、`:13824`)。**(a) = 0 不代表读取安全**。

### G3 — (b) = 0 才继续;(b) > 0 ⇒ 停

(b) > 0 时,**没有应用内处置手段**(R5-4)。已核事实:

- **应用内无法让 (b) 变小**:
  - 对 `approval_template_versions` 的 UPDATE 只有一处(`ApprovalProductService.ts:6886`),只改 `status` / `publish_note`。
  - 应用内没有删除模板或版本的路径。
  - 「作者另发新版本」只能让 latest / active 指向干净版本,旧行仍在 (b) 里。
  - 已冻结在旧版本上的实例照旧读旧行(实例冻结读取:`:13643-13648`)。
- **直接删行不可行**:
  - `approval_published_definitions.template_version_id` 是 `ON DELETE CASCADE`(`zzzz20260411120100_approval_templates_and_instance_extensions.ts:43`)。
  - `approval_instances.template_version_id` 与 `published_definition_id` 是 `ON DELETE SET NULL`(同文件 `:107-108`)。
  - 删一条被实例冻结的版本行,会连带删掉其发布定义,并把实例的两个指针置空。
- **停用模板不是处置**:
  - 停用不改变任何读路径。
  - ON 态下停用本身就是「已落库但返回 500」(§5 P2)。

⇒ 只剩两条路,**都需 owner 另行授权**:

1. 原位改写这些版本行的脚本。须附备份、幂等与执行证明。它改动的是冻结历史。
2. 主闸 ON 搁置。

本计划内没有承接第 1 条的切片。

**定位 (b) 命中行**:#5476 普查只有 (b) 计数和一个 `LIMIT 50`、只列有实例版本的 (c-detail) 定位段(`#5476 census :150-171`)。
要给 R5-4 的处置划定范围,需要一个无上限、values-free 的 detail (b) 定位段。它**不在本包**:

- 它应随 #5476 落地(owner 作为 #5476 的评审意见处置),或由 F2-A0 承接。
- 本包只交付顶层形状的定位段。

### G4 — 同时跑本包的顶层普查,读数交 owner

```bash
psql "$READONLY_DATABASE_URL" -X -v schema=public \
  -f scripts/ops/approval-attachment-canary-census-20260930/01-top-level-attachment-census.sql \
  > top-level-attachment-census.log 2>&1
grep '^INVENTORY_RESULT' top-level-attachment-census.log   # 没有这一行 ⇒ 未完成,不是「零」
```

- (b) `matching_versions` = 0:对应 Q1 (a)——ON 后事实上只有过程附件可用,表单附件待 rung 4。
- (b) > 0:对应 Q1 (b)——「先定这些模板的处置,再 ON」。处置形态由 owner 定,本文件不预设。
  - 计划 r3 那句「处置不得为保留 + 依赖只读容忍」说的是 detail 形状,不是顶层形状。
  - 顶层形状在两种旗态下都是合法字段,不会因此报错。
- 定位段 `(b-locate)` 每个命中版本一行,不设上限,行数必须等于 (b) `matching_versions`。它会告诉 owner:
  - 这一版是不是发起页读的那版(`is_fill_page_version`);
  - 是不是上传口接受的 active 版(`is_active_version`);
  - 冻结了多少实例。
- (d) 段按 JSON 类型数已存值。`string` / `object` 是主闸 OFF 时收下的旧值;ON 后详情页不再内联显示它们(`apps/web/src/approvals/detailField.ts:588`、`attachmentRefs.ts:77,104`,静态判读)。见 UAT A9。
- #5476 部署后顶层形状**照样能**经 API 新增(它是合法字段),所以这份读数也要在 G6 复读。

### G5 — §3 前置核对单逐项打勾

### G6 — ON 前当场复读 G2 与 G4

- 两份普查在翻开关之前**当场**再跑一次,并保留日志。
- G2 的 (b) 必须仍为 0。
- G4 的读数若与交给 owner 的那份不同,先交 owner 再决定。

### G7 — ON,然后立即按 §4 / §5 跑 UAT

---

## 3. 前置核对单(每项附 `cffd5dacbc` 上的 file:line)

| # | 项 | 期望 / 做法 | 依据 |
|---|---|---|---|
| C1 | 三支附件迁移已应用 | `zzzz20260715210000_create_approval_attachments`、`zzzz20260721120000_approval_attachments_scan_and_purge_dedup`、`zzzz20260822130000_approval_attachments_process_binding` 三行都在 `kysely_migration` 里(只读 SELECT 核)。最后一支的文件头原文:「`APPROVAL_ATTACHMENTS_ENABLED` must never be turned ON in an environment that has not applied this migration」 | `packages/core-backend/src/db/migrations/zzzz20260822130000_approval_attachments_process_binding.ts:8-9` |
| C2 | S3 配置完整 | 生产必须 `NODE_ENV=production`,并同时给 `APPROVAL_ATTACHMENT_S3_BUCKET` 与 `APPROVAL_ATTACHMENT_S3_REGION`,缺一即视为未配置。可选 `APPROVAL_ATTACHMENT_S3_ENDPOINT`,必须是 https,除非 `APPROVAL_ATTACHMENT_S3_ALLOW_HTTP=true`。可选 `APPROVAL_ATTACHMENT_S3_FORCE_PATH_STYLE`。客户端构造时没有显式凭据 ⇒ 走 SDK 默认凭据链(静态判读) | `services/approval-attachment-s3.ts:44-46`、`:47-60`、`:65`、`:87-91`;`services/approval-attachment-runtime.ts:91-104`;锁 §7 / §9 O3 |
| C3 | 启动探针真的通过 | **启动成功 ≠ S3 可用**。生产配置不全时不会中止启动:路由照挂、`storageAvailable:false`,上传 / 下载返回 503 `storage_unavailable`,日志是 warn「incomplete S3 configuration in production」。只有已解析的存储 put→delete 探针失败才会中止启动。要看到的是两行 info:「Approval attachment storage: built-in S3 object-store provider (probe ok)」与「Approval attachment pipeline initialized (APPROVAL_ATTACHMENTS_ENABLED)」 | `services/approval-attachment-runtime.ts:394-410`;`routes/approval-attachments.ts:202`;`index.ts:4334-4355`(`:4349` info、`:4351-4354` 中止) |
| C4a | `APPROVAL_ATTACHMENTS_ENABLED` | 值写成精确的 `true`。解析是 trim 后大小写不敏感(`'TRUE'` 也开),是否预期是计划记下的未裁项 | `routes/approval-attachments.ts:128-130`;锁 §9 `:684` |
| C4b | `APPROVAL_ATTACHMENT_MAX_SIZE` | **代码不读这个键**。上限是常量:单文件 20 MB、每字段 10 个、每次提交 50 MB,与锁 §9 / O1 的取值一致。设了也无效;本包不提锁勘误 | `services/approval-attachment-validation.ts:30-34`;锁 §9 `:685`、`:693-694` |
| C4c | `APPROVAL_ATTACHMENT_UNBOUND_RETENTION_HOURS` | 不设 ⇒ 168(7 天);取值范围 1–8760 | `services/approval-attachment-runtime.ts:490`;锁 §9 `:686` |
| C4d | `APPROVAL_ATTACHMENT_SCAN_ENABLED` | **必须不设或为 false**。设为 true 会中止启动:启动时要求注入扫描器,而现 main 的启动调用没有注入。风险声明:ON 后上传的文件一律 `scan_state = unscanned`,v1 没有杀毒引擎(锁 §10 第 4 条 OUT OF SCOPE) | `index.ts:4343`(未传 `scanHook`);`services/approval-attachment-runtime.ts:392`;`services/approval-attachment-scan.ts:39-47`;锁 §9 `:687` |
| C5 | 前端开关只来自后端 | 前端的 `approvalAttachments` 读 `GET /api/auth/me` 返回的 `features.approvalAttachments`,它就是后端主闸。生产前端构建不得打开本地覆盖(`import.meta.env.DEV` 或 `VITE_ALLOW_FEATURE_OVERRIDE=true` 时,`localStorage.metasheet_features` 能单独把上传口打开)。因此「看得见上传口」不是主闸已开的证据,见 UAT A1 | `routes/auth.ts:1922`、`:1949`、`:301`;`apps/web/src/stores/featureFlags.ts:131-134`、`:170-191`、`:380-384` |
| C6 | 锁抬头「8 场景验收」 | 锁抬头原文:「the attachment feature plus every related flag stay **OFF** until the full implementation + 8-scenario acceptance pass」。它指哪一组场景是 Q2(owner 未裁;是否即 FWB S1–S8 矩阵 UNVERIFIED)。未裁之前本项不能打勾 | 锁 `approval-attachment-pipeline-design-lock-20260709.md:3` |
| C7 | 单主闸,无子开关 | 过程附件与表单附件共用一个主闸;Lock-9 OD-L9-11(a) 明确否决子开关。ON 即两路同时生效 | `approval-lock9-handler-process-attachments-20260819.md:495-499` |
| C8 | 回退姿态 | 主闸 OFF ⇒ 路由工厂返回 null、运行时返回 null,什么都不挂、不起 worker。但:① Lock-9 迁移一旦有 `bind_kind='process'` 行,`down` 拒绝(只能回退开关,不能回退迁移);② OFF 期间 GC worker 不运行,未绑定的上传不会被清扫,直到再次 ON(静态判读) | `routes/approval-attachments.ts:133-134`;`services/approval-attachment-runtime.ts:386`;`zzzz20260822130000_…process_binding.ts:11-13` |
| C9 | 普查读数 | G2 (b) = 0、G4 已交 owner 且 owner 已就 Q1 取舍、G6 当场复读完成 | §2 |

---

## 4. UAT 通用规则(R5-1)

**打开详情页不是有效探针。**

- 详情 GET `GET /api/approvals/:id` 走 `ApprovalBridgeService.getApproval`(`routes/approvals.ts:4641,4671`)。
- 它把冻结 schema 原样挂上,不校验(`ApprovalBridgeService.ts:1001-1007`)。
- 所以在 ON 态下,命中 detail 形状的实例**详情照常打开**。

真正的故障形态是「**已落库但返回 500**」(`APPROVAL_TEMPLATE_SCHEMA_INVALID`)。探针必须是**写动作**,并覆盖三处同形点:

| 探针 | 入口 | 为什么会在提交之后才报错 |
|---|---|---|
| P1 实例动作 | `POST /api/approvals/:id/actions`(`routes/approvals.ts:3832`);另有 `/approve` `:3995`、`/reject` `:4313` | 动作事务 COMMIT 之后才调 `ApprovalProductService.getApproval`(如 `:12049-12050`、主路径 `:13480`),其中按冻结版本 `asFormSchema` 校验(`:13643-13648`) |
| P2 停用 / 启用模板 | `POST /api/approval-templates/:id/archive` `:1857`、`/unarchive` `:1871` | `transitionTemplateStatus`:UPDATE `:6977-6980`,COMMIT `:6987`,之后构造 DTO `:6988`(读 latest 行) |
| P3 纯元数据 PATCH | `PATCH /api/approval-templates/:id` `:1768`(只改名称 / 描述 / 分类 / 可见范围 / SLA) | 取 latest `:6716`,COMMIT `:6729`,之后构造 DTO `:6735` |

**探针返回 500 时**:

- **不要重试**。动作已经落库,重试可能撞 409,评论类动作可能重复。
- 先用 GET 核实状态(实例详情 / 模板详情)。
- 立即把主闸改回 OFF,记录实例 / 模板 id 与时间,交 owner。

**在哪里探**:

- 只在 owner 指定的 canary 模板 / 实例上探。P2 / P3 是真实写入:停用后要启用回来,PATCH 后要改回原值。
- G3 成立时生产上不存在 detail 形状的行,所以 ON 后的 P1–P3 是冒烟,期望全部 2xx。
- 想验证探针本身灵敏(阳性对照),**只能在用后即弃的一次性环境里做**,不要在共享 staging 上做:
  - 种下的 detail 形状行没有应用内手段删掉(§2 G3);
  - 那个环境的 (b) 会永久 > 0。
  - 这一步可选,需 owner 授权。

---

## 5. UAT (a) — 表单附件(P2-1(a))

- 环境:staging 或其它非生产环境。
- 前提:模板编排 UI 在 rung 4 之前不能创建 attachment 字段(`apps/web/src/approvals/templateAuthoring.ts:87`),测试模板只能由管理员经 API 创建。
- 生产上走 Q1 (a) 时没有这类模板,A2–A8 不适用;生产只做 A1、A9 与 §4 的冒烟探针。

| 步 | 操作 | 期望 |
|---|---|---|
| A1 | 以普通成员登录,`GET /api/auth/me` | `features.approvalAttachments === true`。清掉浏览器 `localStorage.metasheet_features` 后仍为 true(排除 C5 的本地覆盖) |
| A2 | 管理员经 API 创建并发布一个测试模板:顶层一个 `attachment` 字段,另有一个普通文本字段 | 创建 / 发布 2xx。再跑一次顶层普查:(b) `matching_versions` +1,定位段多一行,`is_active_version = t`、`is_fill_page_version = t` |
| A3 | 成员打开该模板的发起页 | 出现真实上传口:`data-testid="approval-attachment-upload"`,文件框 accept `.pdf,.jpg,.jpeg,.png,.txt,.csv`(`ApprovalNewView.vue:521-529`)。B2-28 禁用占位不再显示 |
| A4 | 上传一个允许类型的小文件 | `POST /api/approval/attachments` → 201 `{ id, sizeBytes }`(`routes/approval-attachments.ts:208-209`、`:265`) |
| A5 | 负例:不允许的类型;单文件 > 20 MB;同一字段提交 11 个附件 id 发起 | 分别被拒:415 `rejected`(`approval-attachment-validation.ts:86-92`);413 `rejected` / `file_too_large`(`routes/approval-attachments.ts:150-157`);413 `APPROVAL_ATTACHMENT_CAP_EXCEEDED` 且整单回滚(`ApprovalProductService.ts:8681-8688`)。上限常量见 `approval-attachment-validation.ts:30-34` |
| A6 | 提交发起 | 2xx。实例的 `form_snapshot[字段 id]` 是附件 id 数组(只读 SELECT 核类型即可,不看值) |
| A7 | 详情页查看附件;参与者下载;非参与者下载 | 详情经 `POST /api/approval/attachments/refs` 解析并显示附件(`:601-602`);参与者 `GET /api/approval/attachments/:id/download` 成功;非参与者得到 values-free 404 `not_found`(`routes/approval-attachments.ts:370-417`) |
| A8 | **探针**:对该实例做一次通过 / 驳回;对该模板停用再启用;对该模板做一次纯元数据 PATCH 再改回 | 全部 2xx,且随后 GET 的状态与动作一致(§4 P1–P3) |
| A9 | **观察项,不判通过 / 失败**:G4 (d) 段有 `string` / `object` 旧值时,打开一张这类实例的详情页 | 记录现象:ON 后这些旧值不再内联显示(`detailField.ts:588`;`attachmentRefs.ts:77,104` 只认 id 数组;静态判读),交 owner |
| A10 | 回退演练:主闸改回 OFF,重启 | 发起页回到 B2-28 占位;`POST /api/approval/attachments` 不再注册(404);启动日志无附件初始化行 |

---

## 6. UAT (b) — 过程附件(P2-1(b),Lock-9)

- v1 只有 `comment` 这一种载体。其它动作带 `attachmentIds` 会被拒(`packages/core-backend/src/types/approval-product.ts:1009-1018`;`ApprovalProductService.ts:11736-11747`)。
- 环境同 §5。准备一张停在审批节点的测试实例。

| 步 | 操作 | 期望 |
|---|---|---|
| B1 | **用户席位**审批人(轮到他)打开详情页 | 出现过程附件上传口 `data-testid="approval-comment-attachment-upload"`(`ApprovalDetailView.vue:1025-1028`) |
| B2 | 该审批人上传 | `POST /api/approval/attachments/process`,表单字段 `stagedInstanceId` = 实例 id → 201(`routes/approval-attachments.ts:303-304`、`:366`) |
| B3 | 负例:带 `fieldId` 或 `templateId`;缺 `stagedInstanceId` | 400 `process_attachment_has_no_field`;400 `staged_instance_id_required`(`:314-321`) |
| B4 | 负例:非席位成员 / 发起人 / 抄送人直接调上传接口 | 403 `forbidden`(`:322-325`,席位 fail-fast) |
| B5 | **探针**:该审批人提交一条 `comment`,`attachmentIds` = B2 的 id | 2xx;详情页显示这条评论带的附件;随后 GET 状态一致 |
| B6 | 负例:在 `approve` 动作上带 `attachmentIds` | 400 `APPROVAL_ATTACHMENT_ACTION_NOT_ALLOWED`(`ApprovalProductService.ts:11736-11747`) |
| B7 | 非席位成员 / 发起人 / 抄送人打开详情页 | 看不到过程附件上传口 |
| B8 | **角色席位审批人**(经角色而非个人被派到该节点)打开详情页并上传 | **NOT RUN,直到 F2-A2 合入并部署到该环境**。现 main 的上传口门是 `attachmentPipelineEnabled && isMyTurn`(`ApprovalDetailView.vue:1026`),`isMyTurn` 只认用户席位(同文件 `:1020-1024` 的注释写明「A role-seated approver whose upload the server would accept sees no uploader here」)。F2-A2 落地前,这一格**不得记为 PASS**,也不得用 B1 代替 |

---

## 7. 不在本包 / 残留

- **detail (b) 定位段**:见 §2 G3。随 #5476(owner 评审意见)或 F2-A0 落地。
- **#5476 普查 (a) 段 active 优先**:与模板读取 latest 优先不一致(§2 G2)。建议 owner 作为 #5476 的评审意见处置;本包零 PR 操作。
- **owner 未裁**:
  - Q1:放行形态,以及 #5476 处置 ①合入 / ②F2-A0。
  - Q2:8 场景所指(C6)。
  - C4a 的解析宽松是否预期。
- **F2-A2 依赖**:UAT B8 在它落地前恒为 NOT RUN。
- **未执行**:本剧本在任何环境都**没有跑过**。普查只在一次性库上跑过(读数见设计 / 验证说明)。
