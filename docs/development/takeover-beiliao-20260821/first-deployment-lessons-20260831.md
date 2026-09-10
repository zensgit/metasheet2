REVIEW-BASE: 42d87e57f2e6be41b05d4ca12dd918196f94c0cf

# 首次真机部署的教训审计(2026-08-31)

> **地位**:审计文档,不是发明。表中每一项都必须能在仓库里指到 commit/PR/代码行;查不到的候选项一律在文中标注"未在仓库找到证据",不计入故障表。values-free——不出现主机名、凭据、客户业务值;PLM 列名仅保留仓库已记录的字段 id(如 `Bom_ExAttr1`)。
> **审计范围**:备料/BOM 备料线(`plugins/plugin-integration-core`)首次真机部署(2026-08-29~30,222 环境)暴露的问题,以及随后两天(#5338→#5363)修复它们的提交。
> **方法**:逐条候选故障对照 `git log`、受影响文件与提交正文核实;凡候选表述与仓库证据不符,已就地改写并标注改写理由(见文末"对候选清单的修正")。

---

## 1. 故障表

| # | 现象 | 根因(一行) | 状态 | 早期拦截手段 |
|---|---|---|---|---|
| F1 | 有人手拟沙箱表 objectId,被拒但拒绝语不说明合法命名空间,操作员需翻源码 | 422 校验只报错误、不报"何为可接受" | **已关闭** — `983724d8f`(#5342):`SANDBOX_OBJECT_ID_NAMESPACE` 具名常量,响应体新增 `requiredNamespace` | preflight/manifest 提前展示命名空间(现有:`app.manifest.json` `objectIdNamespace` 字段;`stock-preparation-preflight.cjs` `PACK_TARGET_MISSING` blocker) |
| F2 | 同一会话两人各自手拟不同沙箱 objectId,pack 声明 A、实际建表叫 B,dry-run 报"缺目标"但从不提 pack 自己声明的名字 | 表创建的"取名"这一步交给了人,而非由清单/pack 单一声明来源 | **已关闭** — `4ade0bef9`(#5345,STOCK_PREP_PACK_TARGET_MISSING blocker,fix 引用 pack 自己声明的 id);制度化为 `07730e7c3`(#5360)manifest 中 `objectIdPolicy: from-config` + `objectIdFrom.configSurface: customerPack` | preflight `PACK_TARGET_MISSING`/`SANDBOX_ALLOWLIST_MISSING_TARGET` 两个 blocker;`stock-prep-acceptance-bootstrap.mjs` 步骤 2 objectId 只读 pack 声明,"从不发明、从不取自 env、从不取自 argv" |
| F3 | 受管表默认建在 `base_legacy`(界面名 "Migrated Base"),字段名为英文模板名,操作员找不到表、看不懂列,当日人工建 base、搬表、改 66 处表头 | 表/字段的**显示名**不是清单字段,建表逻辑无中文默认 | **已关闭** — `94cefb026`(#5359):模板加 `labelZh`,`MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE` 控制建表时用哪套名,默认 `en`(未设即今天所有部署的状态,拼写错误也回退 `en`,不得阻塞建表) | manifest §12(`multitable-application-model-20260830.md` §11)把显示名列为清单字段;`assertSandboxObjectId`/`ensure` 幂等——本项仍不含"落哪个 base"的清单化,见遗留事项 §4 |
| F4 | 首次部署时 `canManageFields` 派生自 `canWrite`,凡持 `multitable:write`(含备料操作员,须填人工列)即可删除/改列结构 | "能填值"与"能改结构"是同一权限档 | **已关闭** — `17a548b82`(#5357):新码 `multitable:manage-schema`,seed 迁移零自动持有者,`access.ts` 与 `sheet-capabilities.ts` 两处派生同用一个 policy 函数 | 71 项 actor×route 权限矩阵测试(`multitable-manage-schema-permission-matrix.test.ts`);`multitable-application-model-20260830.md` §12 表格已把"删字段"列为交付说明必备条目 |
| F5 | ext_ 映射的 mapper 已合入(#5118),但两条刷新路由只传 `installedFieldProperties`,从不传 `extFieldMapping`,生产代码零处构造该映射,`ext_` 列永远空 | mapper 建好但**未接线**——"建好"与"可达"是两回事 | **已关闭** — `1258b3d06`(#5126,wire the ext_ field mapping from server config) | preflight `EXT_FIELD_MAPPING_NOT_CONFIGURED` blocker(现有);bootstrap 验收判据 1 直接断言目标表 `ext_` 列非空,而非只信任 apply 计数 |
| F6 | (F5 之后仍发现)pack 的 `targetObjectId` 硬编码为 canonical,apply 对 canonical 无条件 403(仅许 sandbox),两个集合不相交,`ext_` 列装不到能写的目标上,mapper 算出的值在写入前一层被静默丢弃 | pack 的"装列目标"与 apply 的"可写目标"两个不变量互斥,且从未有人验证过交集非空 | **已关闭**(随沙箱命名空间引入)——`stock-preparation-target-provisioning.cjs` 允许 pack 装到 `plm_stock_preparation_sandbox` 命名空间;记录见 `beiliao-production-go-live-gate.md:26-34` | preflight `PACK_TARGET_INCOMPLETE` blocker;bootstrap 判据 1 直接读目标表单元格而非信任写入路径的返回值 |
| F7 | 装列(pack)与写行(apply)是两道独立授权,`STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 允许清单里没有 pack 声明的目标时,**装列会成功、写行才被拒**——这是最费时间的晚失败形态 | 两道授权在时间上分离,却没有统一的早期检查同时验两者 | **已关闭** — `4ade0bef9`(#5345)`SANDBOX_ALLOWLIST_MISSING_TARGET` blocker 把两者放进同一次 preflight 读 | 同上;`app.manifest.json` configSurfaces 中 `sandboxWriteAuthorization` 已把该风险写成 note |
| F8 | 一个持有 hold 的计划被验收脚本报告为"失败"而非"待处理" | 验收脚本早期版本未区分 `manual_confirm_required`(计划被 hold)与真实失败;运行过的部署天然带着前一操作员留下的 hold | **已关闭** — `822a00526`(#5351)`stock-prep-acceptance-bootstrap.mjs`:`heldCount>0` 时返回 `skip()` 而非 `fail()`,步骤顺序把 confirmation-queue(排空 hold)放在 acceptance-dry-run **之前**(见脚本 258-259 行注释"ORDER IS LOAD-BEARING") | preflight 之外新增的 E1 语义测试(`STOCK_PREP_APPLY_SANDBOX_ONLY` 之外);脚本本身即拦截手段 |
| F9 | Postgres 折叠未加引号的标识符,一个用带引号驼峰命名建的源表读回报 "relation does not exist" | 大小写混合标识符必须全程加引号访问,探针/验收脚本未处理 | **已关闭**(纳入教训清单,机制见脚本头)——`stock-prep-acceptance-bootstrap.mjs` 头部注释第 2 段明确记录该坑并入编排逻辑 | 建源向导层面尚无结构化校验(仅脚本注释记录);建议第二客户检查清单显式核对 |
| F10 | 一个 external system 连接测试成功后仍处于 `inactive`,reconcile 拒绝读它 | `resolveTestedStatus` 刻意不在成功测试后静默启用一个显式设为 inactive 的系统 | **已关闭** — `stock-prep-acceptance-bootstrap.mjs` 步骤 4(source-wiring)显式把状态置为 active,而非依赖测试副作用 | bootstrap 步骤本身;preflight 未覆盖此项,见遗留事项 |
| F11 | 探针(source-discovery-probe)对 SQL Server 报 TLS 拒绝:`encrypt:true` 要求设置 TLS servername,裸 IP 地址不被接受,探针**完全连不上**用 IP 访问的现场主机(常态) | 未按"主机名 vs 裸 IP"分支决定是否协商加密 | **已关闭** — `bbc3afcbc`(#5338)缺陷 1:主机名保持加密,裸 IP 协商关闭加密 | 4 个回归测试(29/29,含每个缺陷各一个) |
| F12 | 探针里 `SUM(...) AS rowCount` 破坏 SQL 解析(`ROWCOUNT` 是 SQL Server 保留字),报错指向派生表别名而非真实原因,读来像 join 语义问题 | 未转义保留字 | **已关闭** — `bbc3afcbc`(#5338)缺陷 2:`[rowCount]` 加方括号,同病的 `AS rows` 一并改名 | 同上 |
| F13 | `sys.partitions.rows` 的 `SUM()` 是 bigint,驱动以**字符串**形式返回,`typeof` 判定失手,每张表的行数都判为未知,未知行数按"超上限"处理(fail-closed 设计),**全部表被筛掉**,探针报告"零字典表"——一个看起来像正确答案的假阴性 | `typeof value === 'bigint'` 没覆盖驱动把 bigint 序列化为字符串的情形 | **已关闭** — `bbc3afcbc`(#5338)缺陷 3,commit 正文标注"this was the dangerous one";修复见 `source-discovery-probe.mjs:133`(`coerceRowCount`) | 同上;并且此修复本身证明了"零结果"不能被当作天然可信——需要一条"零结果时必须能解释为什么"的纪律,见 §2 |
| F14 | 探针的 leak-guard(values-free 自检)对普通词误报:表名里含 `workshop` 撞上敏感词、被采样值恰是当年时间戳数字(`2026`)、schema 标识符与其他表未匹配值巧合相等 | 朴素 `includes()` 匹配,未按整叶匹配/纯数字排除/自身已产出标识符扣除来收窄 | **已关闭** — `bbc3afcbc`(#5338)缺陷 4;提交同时披露**一个残留误报仍未修**(某本地化 2 字符值),探针继续 fail-closed 拒绝落盘,后续项目跟踪(per-table 而非全局值集合的作用域收紧) | 探针自身即拦截手段(拒绝打印而非静默漏出);commit 正文明确"disclosed rather than papered over" |
| F15 | O1' 冲突矩阵草案(`o1-conflict-matrix-20260829.md` 自声明基线)标题声称"封闭 13 词表"、`duplicate_expanded_key` 的 `canonical_row_exists` 标"否",Q5 supersede 标"已实现",三处均据以做 owner 决策 | 复核未亲验源码,依赖草稿自身陈述;`c2_row_error` 是 `rowError.type \|\| 'c2_row_error'` 的无校验透传伞名(实发 BOM expander 10 种);`:806 if (existingKeyed.has(key))` 恰在行存在时触发,矩阵却记为"不存在" | **已关闭** — `codex-post-merge-review-receipt-20260829.md` §7(E1/E2/E3),并入库为 `o1-conflict-matrix-20260829.md` 就地修正版(REVIEW-BASE `69bc848e9`) | 亲验源码而非仅信任审阅方陈述("两个验证器分歧时,不取多数、不取先到,亲手看代码" —— 回执文末教训) |
| F16 | O1' A→B→A(指纹先变后复原)场景下,旧 `superseded` 行的 `decisionId` 与复现指纹重算结果相同,exact 分支直接 `continue`,不 reopen、不开新 pending,该 `stableDecisionKey` 永久不可确认 | supersede 逻辑只在"当轮候选"上跑,未处理指纹振荡回退到已 superseded 版本的情形 | **已关闭**(fail-safe 但需修)—— `81b2c1905`(#5312,W-4:reopen-on-return) | `O1' ruling` Q5 已裁定沿用现有语义 + 4(a) 修复;新增回归测试覆盖振荡场景(非严格单调 rev) |
| F17 | reconcile 竞态:lease 只在 acquire/release 两端,无续租/心跳,`leaseId` 只守 takeover CAS、不守写;TTL 短于写耗时时慢持有者与抢锁者双双成功,产生重复 active 行 | lease 无 fencing,过期抢锁路径无测试覆盖 | **已关闭**(同 W-4)—— `81b2c1905`(#5312:lease renew + lost-abort) | `codex-post-merge-review-receipt-20260829.md` §4(c) 实测复现(TTL 60ms 场景);测试补齐 |
| F18 | operation claim 非原子:get→set→read-back,`PluginStorage.set` 是无条件 upsert,不是 CAS | 存储层缺唯一性约束,靠应用层三步模拟原子性 | **已关闭** — `582036bd2`(#5313,W-3:migration 078,`claim_key` PK) | `03a2561bd`(#5320,O1-C)real-pg exactly-one-winner 证明测试 |
| F19 | K3 外部写围栏只认 `kind==='erp:k3-wise-webapi'`,通用 `http` adapter 可 POST 到任意 objectConfig path,存在"HTTP 打到 K3 URL"的第三条路未被围栏覆盖 | "K3 命名 connector 恒拒"被误读成"K3 端点永久不可达",实际只挡了具名 connector 一条路 | **已关闭**(措辞收紧 + 补门)——`149f93b56`(#5314,W-1c:default-deny 通用出站写门);回执 `codex-post-merge-review-receipt-20260829.md` finding 1 | HG v1.2 §10.1/§6 措辞收紧(W-6,文档项) |

---

## 2. 模式归纳

对候选五类逐一核验并按仓库证据调整措辞:

### 2.1 创建时不完整(F1/F2/F3/F6/F9)
表/列被创建出来,但创建时缺的东西——命名空间校验、显示名、可写目标——要等人工事后补。**规则**:任何"建对象"的动作,其身份(objectId/命名空间)、称呼(显示名)、可写位置(band/目标表)三者必须在同一次 `ensure` 调用里一起就位,不能分成"先建、再人工补"两步。`multitable-application-model-20260830.md` §11/§12 把这条写成了清单纪律(标识不可变、显示名清单字段、band 可改性表)。

### 2.2 静默失败(F5/F12/F13/F14 部分/F16)
最危险的一类不是报错,而是**看起来像对的答案**——F13 的"零字典表"、F5 的"ext_ 列存在但空"、F16 的"决策看起来还在但永久卡死"。**规则**:任何"零结果/空值/无变化"的返回都必须能被独立证明是"真的没有"而不是"管道断了"——F13 的修复本身就是这条规则的体现(bigint 强转);bootstrap 判据不信任 apply 的返回计数,而是直接读目标表单元格(见 F6/F8 早期拦截手段列)。

### 2.3 拒绝但不说明何为可接受(F1/F2)
422/403 报错说"错在哪"但不说"对的是什么样",逼操作员翻源码或试错。**规则**:每条拒绝必须自带一条可直接复制执行的"fix"——`stock-preparation-preflight.cjs` 的每个 blocker 都带 `fix.run`(方法+路径+JSON,或 `KEY=value`),这正是 F1/F2 事故催生的设计(见 `4ade0bef9` commit 正文)。

### 2.4 无法产生现实的封闭测试(F11/F13/F14/F17)
探针与并发相关的缺陷全部只在真实环境(带真实 SQL Server / 真实并发写)才现形——合成/mock 测试全绿。**规则**:hermetic 测试证明不了"对真实驱动/真实时序也成立";发布前必须留一次对真实依赖(真库、真表、真并发)的验收步骤,`stock-prep-acceptance-bootstrap.mjs` 与 `source-discovery-probe.mjs` 就是把"第一次对真机跑"的产出固化为可重跑脚本,而不是让下一次部署重新用人工跑一遍侦察。

### 2.5 身份由人选择而非声明(F1/F2/F6)
objectId、目标表这些"名字"曾经允许操作员手拟,而系统的一部分(pack/apply)已经对这个名字有隐含期待。**规则**:任何跨模块共享的身份值只能有一个声明来源(pack 的 `targetObjectId`,或清单的 `objectIdPolicy: fixed`),其余各处一律"读"不"造"——`07730e7c3` manifest 把这条固化为 `objectIdPolicy: fixed | from-config` 两种声明形态,不留第三种"人拟"。

### 2.6 (新增,由 F15 校正候选清单)审阅本身可能是错的
候选清单未列这一类,但仓库证据(F15)显示复核文档本身也会带着"未亲验源码"的系统性错误进入 owner 决策。**规则**:涉及 owner 决策的复核结论,必须以 `file:line` 亲验为准,而非信任另一份复核文档的自陈;两个独立验证代理分歧时不取多数、亲手看代码(`codex-post-merge-review-receipt-20260829.md` 结尾教训)。

---

## 3. 第二客户检查清单

**装前**
1. [ ] 沙箱表 objectId **不手拟**——跑 `stock-prep-acceptance-bootstrap.mjs` 步骤 2,objectId 只从已配置 customer pack 的 `targetObjectId` 读取(F1/F2/F6 的拦截点)。
2. [ ] 跑 `GET /api/integration/stock-preparation/preflight`,按 `blockers[].fix.run` 顺序修到 `ready:true`——覆盖 F1/F2/F5(部分)/F6/F7 七个已知 code:`CONFIRMATION_LEDGER_NOT_READY` / `CUSTOMER_PACK_NOT_CONFIGURED` / `PACK_TARGET_MISSING` / `PACK_TARGET_INCOMPLETE` / `EXT_FIELD_MAPPING_NOT_CONFIGURED` / `SANDBOX_MODE_NOT_ENABLED` / `SANDBOX_ALLOWLIST_MISSING_TARGET`(`stock-preparation-preflight.cjs:97-114`)。
3. [ ] `MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE=zh-CN` 显式设置(F3 的拦截点;未设默认回退英文模板名,这是当前所有已部署实例的状态)。
4. [ ] 探针连接目标源前确认:目标是裸 IP 还是主机名(F11 已修但需知晓行为分支);源库若含大小写混合标识符,建源时全程加引号访问(F9,脚本注释记录,**尚无结构化校验**——本项是缺口,见下)。
5. [ ] 操作员角色权限核对:凡只需填人工列的角色,**不应**持有 `multitable:manage-schema`(F4 的拦截点;seed 迁移默认零自动持有者,需显式按角色授予)。

**装中**
6. [ ] `node scripts/ops/source-discovery-probe.mjs` 对真实源跑一次,核对字典表检出比例是否接近 1.00(而非仅关注"零错误退出")——F13 教训:零结果不是天然可信的正确答案。
7. [ ] ext_ 映射配置后,跑一次 dry-run,人工核对至少一行的 `ext_` 目标非空,而不是只看 apply 计数(F5/F6 教训,bootstrap 判据 1 已固化此点)。
8. [ ] external system 连接测试成功后,显式核对/设置其 `status=active`——不要依赖测试成功自动启用(F10,`resolveTestedStatus` 故意不做这件事)。

**装后**
9. [ ] `node scripts/ops/stock-prep-acceptance-bootstrap.mjs` 全量跑一遍,预期干净部署 6 OK / 2 SKIP / 0 FAIL,两条验收判据 PASS(见脚本头与 `r7-build-manifest.md` §二.4)。
10. [ ] 若报告"仍有 N 组 held",这是**待办不是故障**(F8 教训)——先工作确认队列,再看验收结果。
11. [ ] 人工确认:确认队列工作台 `/stock-prep` 可见、四张受管表仍在预期 base 下、四项围栏姿态(production Apply / K3 / B2a / 出站写门)未变(`r7-build-manifest.md` §三)。

**本清单尚未覆盖的缺口(明确列出,不假装已覆盖)**
- 受管表落哪个 base(F3 只解决了字段/表**显示名**,未解决"建在哪个 base"的清单化——`multitable-application-model-20260830.md` §11 原文承认这点,仅提出"应该声明",未实现)。
- Postgres 标识符大小写折叠(F9)目前只是脚本注释里的一条教训,没有 preflight blocker 或建源向导层面的结构化校验。
- 探针的 TLS/裸 IP 分支(F11)与保留字转义(F12)已修复在探针脚本内,但**建源向导本身**(customer pack / 数据源注册页面)尚不复用这条判断逻辑——仅探针路径受益。

---

## 4. 遗留事项

| id | 一句话陈述 | 归属 |
|---|---|---|
| L-1 | base 改名 API 不存在——`packages/core-backend/src/routes/univer-meta.ts` 仅注册 `GET /bases`(:6950)与 `POST /bases`(:6994),无 `PATCH`/`PUT /bases/:id`;`multitable-application-model-20260830.md` §11 提出"应用自有 base 名"应是清单字段,但当前无 API 可在装完后改 base 名,只能装时建对 | 我方(需先补 API 才能兑现 §11 的承诺) |
| L-2 | S-1「字段创建时的一次性提示」——**未在仓库中找到可引用的文档或代码**。任务候选清单点名此项,但 `source-onboarding-self-service-design-20260830.md` 全文未出现该编号或对应机制,`docs/`/`plugins/` 均未搜到匹配。建议 owner 明确该项当前记在何处,或确认它尚未立项 | owner(需先定位或确认未立项) |
| L-3 | F-1:pack 尚不能声明 `formula` 类型字段——`STOCK_PREPARATION_FIELD_TYPES` 冻结为 `string/number/boolean/date/select`(`stock-preparation-templates.cjs:11`),公式列今天只能由客户装完后自行添加;若要成为清单一部分需处理字段存在性校验、循环依赖检测、与 apply 的交互(`multitable-application-model-20260830.md` §13) | 我方(需 owner 排期,已注明是独立设计,非加枚举值) |
| L-4 | F-2 剩余一半:「总图日期」来源仍未定——`multitable-application-model-20260830.md` §13 已确认此为需求日期公式唯一的硬缺口,候选包括 PLM 某列 / 订单交期 / 人工填,**该文档没有编号到 §16 的"答案"**(仓库现存版本只有 §0-5、§11-14,无 §15/§16;任务描述中"§16 的 F-2 答案"在当前 main 上不存在,可能是尚未合入的草稿或对文档结构的误记)。客户侧已确认这是 PLM 侧字段而非订单/人工填,但具体是哪一列仍未落定 | 客户(只有客户能定,§13 原文) |

---

## 对候选清单的修正

- **保留且验证为真**(F1、F2、F3、F4、F5(合并 F6)、F8、F9、F11、F12、F13):候选表述基本准确,已补充精确根因/提交/拦截手段。
- **F5 根因改写**:候选写"ext 映射声明了不存在的源列",仓库证据(`beiliao-production-go-live-gate.md:26-34`)显示真实根因是**两层**——(a) mapper 已合入但两条刷新路由从未传参(#5126 修);(b) 即便传参,pack 目标与 apply 目标互斥导致 `ext_` 列根本装不到可写位置。候选把这两层合并简化成"声明了不存在的列",证据不支持这个具体措辞,已改写为 F5/F6 两条。
- **F10(pm2 持有 env)未采纳**:全仓搜索显示该问题出自 `docs/development/onprem-bootstrap-harden-development-20260422.md` #518,是 2026-04-22 考勤线 Pilot R1 的 on-prem 引导问题,与备料线首次真机部署(222,2026-08-29/30)无关联证据。未列入故障表。
- **Get-ChildItem -Exclude 未采纳**:全仓(含 `docs/development/takeover-beiliao-20260821/` 与 `scripts/ops/*.ps1`)未找到该缺陷的记录;r7 的"build manifest"文档描述的是版本合并清单而非文件复制脚本缺陷。未列入故障表,亦未在 r7 文档中找到"lib/ 整目录被跳过"的记录。
- **"零视图导致整个 base 打不开"未采纳**:未在 `docs/development/takeover-beiliao-20260821/` 或 `platform-overall-design/` 任一文档中找到该现象的记录。已在遗留事项外单独排除,不计入故障表或检查清单(避免臆造)。
- **O1' 矩阵/复核链(F15-F19)属新增**:候选清单未提及,但属于同一时间窗(2026-08-29)、同一批"首次真机部署后暴露"的治理层缺陷,且均可精确指到 commit,故补入故障表,不归入候选五类而单列 §2.6。

---

## 附录 A:三条现场故障的补录(2026-08-31,r7 升级当日)

本审计以**仓库可引证**为准绳,因此把三条"当日发生、尚未落库"的故障列为不采纳。这个判断在方法上是对的
(不编造引证),但结论不完整——**三条都真实发生过**,证据是当日的实测输出而非既有提交。现补录并给出实测证据,
使其与 F1–F19 同等可用。这本身也是一条方法教训:**只审仓库的审计看不见"刚发生但还没写进仓库"的故障**,
故障补录必须在事发当日完成,否则下一次审计仍会漏掉。

| 编号 | 故障 | 根因 | 实测证据 | 状态 |
|---|---|---|---|---|
| **F20** | **受管表建成后没有视图,导致该表打不开,并使整个 base 无法打开** | `ensureObject` 只建 sheet 与字段,不建 `meta_views` 行;多维表打开 base 需渲染每张表的默认视图 | 直查该部署:pack 装过的沙箱表 views=3(pack 建角色视图),确认账本 / 正式主表 / 第二张沙箱表 **views=0**;手工插入三条 grid 视图后 base 方可打开 | 数据已手工修复;**代码修复在途**(受管表建成即可用) |
| **F21** | **base 建后无法改名** | 后端只有 `GET /bases` 与 `POST /bases`,**无改名路由**;前端亦无调用 | 查 `routes/univer-meta.ts` 路由表;当日改名系直接改库,非正常路径 | **未修**,见开放项(跨车道) |
| **F22** | **升级复制插件时整个 `lib/` 被跳过,预检文件缺失** | PowerShell `Get-ChildItem -Exclude` **不过滤递归中的目录**,用它排除 `node_modules` 时连同目录层一并漏拷 | r7 换包后核对:包内有 `stock-preparation-preflight.cjs`,目标机没有;改为逐文件遍历后 lib 文件数 324→326,预检与工作台权限模块到位 | 已修(改用逐文件遍历);**升级脚本尚未固化该做法** |

### F20 归入"创建时不完整",且是该类中最贵的一例

它与"表名是英文"(F3)、"表落进 `base_legacy`"(F4)同形:**建表时该做而没做**。三者合起来给出该类的完整规则:

> **受管对象创建完成 = 人能找到(对的 base)、能打开(有默认视图)、能读懂(本地语言表头)。三者缺一,创建就不算完成。**

F20 比另两者更严重:前两者是"难用",它是**打不开**,而且会**牵连整个 base**——一张受管表的缺陷,阻断了与它无关的其他表。

### F22 归入"封闭测试无法产生现实",且指向一个新面

此前该类的例子都在**应用代码**上(假件测不出 bigint 变字符串、保留字、TLS)。F22 说明**部署脚本本身**同样适用:
`-Exclude` 的行为在小样本上看不出来,只有真的拷一个含 `node_modules` 的插件目录才暴露。**升级脚本也需要真机演练,
而不是只在纸面上检查步骤。**

### 对开放项的补充

- **V-1 受管表建成即带默认视图**(我方,在途)——F20 的代码修复;安装器的必需品,否则每装一次应用就产生一张打不开的表。
- **V-2 base 改名 API 与入口**(跨车道,须走公约)——F21;在它落地前,替代手段是**建时起对名字**,这又一次说明显示名必须由应用清单声明。
- **V-3 升级脚本固化"逐文件遍历"拷贝**(我方)——F22;并在换包后加一条"关键文件存在性"断言,而不是靠人核对。
