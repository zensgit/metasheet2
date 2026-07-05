# W1-2 权限金矩阵主体 SPEC(Tier-B gap #5)— 2026-07-05

> 性质:test-only spec(不提任何 runtime 改动)。Slice 1(OAPI allowlist⟺guard tripwire,#3574 + P2 `600e47e6d`)已出,本 spec 覆盖主体矩阵。
> 用途:§5 的批次可直接交给 Sonnet 档 agent 机械生成;每格断言先按本 spec 写 fail-first。
> 交付形态:本文件为预起草稿(W0 批次清空后转 docs PR)。

## §1 既有 goldens 盘点(已锁格,勿重复)

按套件(全部在 `packages/core-backend/tests/integration/`,另注 unit):

| 覆盖域 | 套件 | 已锁的格 |
|---|---|---|
| 导出 × 字段三态 | `multitable-permission-golden-d3d1` | FIELD {granted/denied/inherited} × export;view hidden-field 投影;canExport≡canRead(export-deny N/A 已文档化) |
| 写交集/write-own/view非门 | `multitable-permission-golden-d3d2` | sheet write-intersection(inherited/granted 200,read-only-row PATCH 403);record write-own(own 200/not-own 403);view-access=非门(契约);member-group 继承 mask |
| 列表读 authz+mask | `multitable-records-list-authz` | GET /records 游标列表 × 字段读掩码 |
| 单读/搜索/过滤 mask | `records-read-field-mask`,`readpath-search-filter-field-mask` | 交互读路径 layer-2∧3 掩码 |
| 写回显 mask | `write-echo-`,`create-echo-field-mask` | 写/建后 echo 掩码 |
| 汇总/链接/人员 mask | `records-summary-`,`summary-display-`,`link-summary-display-`,`person-summary-field-mask`,`person-member-group-restrict`,`person-restrict-route-parity` | 各汇总面掩码与路由对齐 |
| 外表 lookup 掩码族 | `lookup-foreign-field-mask-{view,export,write,create,aggregate,sibling-reads,convergence}` + `cross-sheet-related-echo-mask` | 外表字段权限跨面收敛 |
| 字段级写门 | `fieldperm-write-gate-patch` | field_permissions 写门 @ PATCH |
| 行级读拒 | `rowlevel-readdeny-{enforce,xrec,flag-endpoint}` | per-sheet flag 门控 'none' 拒;外表被拒记录的 lookup;flag 端点 |
| 记录锁 | `record-lock`,`record-lock-bypass` | 锁存储契约;锁横跨**每条**变更路径的 canary |
| 条件规则 | `conditional-rule-{enforce,trash}-realdb`,`conditional-rules-api` | 条件读/写规则执行与回收站交互 |
| 导出通道 | `export-permission-canary`(D3c mock),`export-allrows-maskroute-realdb` | 导出投影回归;全行导出走保掩码路由 |
| 记录历史 LOCK-3 | `record-history-field-mask`,`history-events(-hasmore)-realdb`,`history-audit-{grant,log,reveal,reveal-taint}-realdb` | 历史面掩码、计数不说谎、break-glass 审计、taint |
| 配置历史门 | `config-history-api-realdb`(T9-R3 per-entity WHERE 门),`config-history-{view,sheetconfig}-redaction` | read-gate≡write-gate;字面量脱敏 |
| OAPI 读 | `oapi1-token-read-realdb`,`oapi1-comments-read-realdb` | records:read/comments:read 面 + creator mask 栈(部分) |
| OAPI 写 | `oapi2a-{token,comments}-write-realdb`,`oapi2a-ratelimit`,`oapi-write-audit`(单元在 lib) | records:write/comments:write + 审计 + 限流 |
| OAPI 域 | `oapi-scope-guard-realdb`(4a per-base/sheet token),`oapi-token-create-scope.api` | scoped token 域收窄 |
| 跨 base | `cross-base-link-wall`,`link-optin`,`write-quota`,`base-{readable,writable}-resolver`,`cross-base-automation-write(+rule,+delete-lock)`,`seed-view/sheet-create-toctou`,`relation-aggregation`(authorized-reader),`mirror-readonly-enumeration`,`crossbase-mirror-writethrough(+concurrency)` | base 治理墙、opt-in、配额、自动化写、TOCTOU、镜像只读枚举、C2 写穿 W-A/B/C |
| 仪表盘 | `dashboard-chart-authz`,`chart-rowdeny`,`level-filter`,`filterinfo-oracle`,`preview-data` | 面 authz、行拒、层级过滤、**无 oracle** |
| 表单 | `form-context-submit-field-mask`,`public-form-flow`,`record-form.api` | 表单上下文/提交掩码、公表流 |
| 视图配置 | `viewconfig-filter-literal-redaction`,`viewconfig-resave-guard` | 过滤字面量脱敏、重存防降级 |
| 外表权限 API | `sheet-permissions.api` | lookup/rollup/link 汇总在外表无读时的脱敏(含 500 回归格) |
| 单元层 | `permission-derivation`,`permission-service`,`record-permissions`,`permission-rule-evaluator`,`oapi-read-allowlist`,`permissions-mixed`,`permissions-routes` + `multitable-oapi-allowlist-guard-tripwire`(slice 1) | 派生/解析/allowlist 结构守卫 |

**盘点结论**:读面掩码与单一修饰符的格已相当密;薄弱带集中在 **(i) 写侧修饰符组合、(ii) 非交互写入口(Yjs/token)与修饰符的交叉、(iii) 管理面 403 矩阵、(iv) 跨面等价性质、(v) denied≡missing 形状一致性**。

## §2 轴定义(代码锚点)

**Actor 档(A)** — `permission-service.ts:65-108`(码表)、`sheet-capabilities.ts:74-97`(derive)、`:105-116`(sheet-scope 覆盖)、write-own 归属条件 `:289-313`:
- A1 admin(isAdminRole→全能力) · A2 全局写(`multitable:write`) · A3 全局只读(`multitable:read`;canExport≡canRead `:96`) · A4 表级写(sheet-scope `SHEET_WRITE_PERMISSION_CODES`) · A5 表级 write-own(`*:write-own`,记录归属条件) · A6 无权限(含 hasAssignments 下的排除者) · A7 `mst_` token × scope∈{records:read, records:write, fields:read, comments:read, comments:write}(`oapi-read-allowlist.ts:13-89`)×(全域 / OAPI-4a base/sheet-scoped)

**面(S)**:S1 记录读(单/列表/汇总/视图聚合) · S2 记录写(PATCH/create/soft-delete/批 /patch) · S3 导出(xlsx + allrows maskroute) · S4 记录历史(events/detail/audit-reveal) · S5 配置历史(T9-R3) · S6 仪表盘 · S7 表单(context/submit/public) · S8 评论(交互 rbacGuard) · S9 OAPI(读/写) · S10 跨 base(link/automation/mirror/aggregation) · S11 Yjs bridge(scalar flush 写入口)

**修饰符(M)**:M1 字段掩码 layer-2(field_permissions 三态,含 member-group 继承)∧ layer-3(view hidden/readOnly/conditional) · M2 行级读拒(per-sheet flag `loadRowLevelReadDenyEnabled` `permission-service.ts:912` + `record_permissions` 'none' `:1013-1044`) · M3 记录锁(`locked/locked_by`,写路径 FOR UPDATE `record-write-service.ts:760`) · M4 条件规则 · M5 write-own 归属 · M6 base 级细粒度写码(`resolveBaseWritable` `:1557+`,与 sheet 写轴**不相交**——C2 crux 已文档化未 golden 化) · M7 taint(formula-over-masked-lookup chokepoint,已有结构守卫)

## §3 缺口清单(可达且未锁;附风险一行)

| # | 缺格 | 风险 |
|---|---|---|
| G-1 | **Yjs bridge 写入口 × A3-A6 档**(S11×A):锁定 scalar flush 对无写权者拒绝且零副作用、M2/M3/M4 门在桥接路径同样生效。**已知管道(非越权)**:bridge 构造 RecordPatchInput 经 `resolveSheetCapabilitiesForUser` 解析真实 capabilities("same path as REST",index.ts:2471-2473),由 yjs-record-bridge.ts:226 走 patchRecords 脊柱——授权机制在位;缺口性质=**未见 real-DB bridge-specific 权限矩阵,现有覆盖偏功能(yjs-scalar-* real-DB)与单元 hardening**,B1 goldens 的职责是钉住其持续生效 | 侧门写的**测试盲区**(非运行时漏洞);与"skip-when-unreachable"同级的经典盲区 |
| G-2 | **OAPI 写 × M2/M3/M4**(A7(records:write)×S2×M):token PATCH 命中 锁定记录/条件规则拒/行拒目标 | token 通道若少任一 re-gate = 交互档位被绕过 |
| G-3 | **M6 与 sheet 写轴不相交契约**(A×S2×M6):仅持 base 写码(无 sheet/全局写)者,交互记录 PATCH 必须 403 | C2 crux 的已文档化事实,无 golden 钉住,回归即静默提权 |
| G-4 | **OAPI 读掩码奇偶性全扫**(A7(read)×S1 全 5 路由×M1/M2):token 输出 ≡ 同 creator 交互掩码(逐路由差分) | allowlist 头注声明 Option A,但奇偶性仅部分路由有断言;泄漏类 |
| G-5 | **拒读形状一致性跨面——按既有 surface-specific 合同锁**(A×{S1,S3,S4}×M2):**不改现有合同**——单记录 GET 的既锁合同是 **403 + 无 data**(univer-meta.ts:4121-4126,golden readdeny-enforce.test.ts:88 已锁;条件规则单读同为 403),G-5 锁的是其余面的**缺席一致性**:列表缺席、summary/aggregate 不计数、导出缺席、历史缺席——即"被拒记录在聚合类/集合类面零存在痕迹",单读面维持 403 合同并断言 body 无 data/无字段回显。**明确非目标**:改成 denied≡missing(单读 404)是**读路径合同变更**,若 owner 想要真 no-oracle 语义须单独立 design/runtime slice,不属于本 test-only spec | 存在性 oracle 的集合面无系统断言;dashboard 已有 filterinfo-oracle,其余面缺 |
| G-6 | **管理面 403 矩阵**(A3/A4/A5/A6×字段/视图/权限/表配置 CRUD):非管理者对每条管理路由的拒绝 | permissions-routes 单元覆盖不等于集成层逐档矩阵;枚举式基本盘 |
| G-7 | **导出≡读掩码差分性质**(A×S3×M1+M2+M7):同 actor 导出输出 ⊆ 交互读输出(含行拒行、taint 列) | d3d1 锁字段三态,含行拒/多修饰符组合的差分未锁 |
| G-8 | **交互评论 × 表可见性**(A×S8):对无读权 sheet 的评论读/写是否泄漏存在性 | comments 走全局码 + rbacGuard,与 sheet 可见性的交叉薄 |

## §4 N/A 格(结构性不成立,不生成)

- 独立导出拒:`canExport≡canRead`(`sheet-capabilities.ts:96`,d3d1 已文档化)
- sheet-read / record-read 的无 flag 拒语义:grant-additive 模型(d3d2 §0 系统性发现)
- view-access 作为数据门:非门契约已锁(d3d2)
- OAPI `fields:write`/`views:*` scopes:尚不存在(audit 生态项),无可测
- OAPI 批删/硬删:allowlist 结构性排除(仅单记录软删)
- 历史窗口点亮面(permission-revert TOCTOU、T9-W tiers、PIT flags):**排除**,归其点亮阶梯

## §5 生成批次(交 Sonnet 档;每格 fail-first,命名 `multitable-permmatrix-<batch>-<slug>-realdb.test.ts`)

- **B1 侧门与写修饰符(最高险,先行)**:G-1(flush × A3/A4/A5/A6 四档 + flush×锁定/行拒各一)≈6 格;G-2(token 写×M2/M3/M4)3 格;G-3(base-写码不渗透)2 格。断言草图:副作用=0(版本/审计/revision 全无)+ 状态码/outcome 词汇不变。
- **B2 oracle/泄漏**:G-5 集合面缺席一致性(列表/summary/aggregate/导出/历史 各面"被拒=零痕迹"断言)+ 单读面 403 合同保持(403+无 data,**不引入 404**)≈8 格;G-4 五路由差分(token vs creator 掩码相等)5 格。
- **B3 管理面 403 矩阵**:G-6,4 档×4 域 CRUD ≈ 12-16 格(高度机械,表驱动生成)。
- **B4 差分性质与评论**:G-7 导出⊆读(3 修饰符组合)3 格;G-8 评论×可见性 3 格。

每批产出附带 verification MD 段落(golden 清单+跑证)并入金矩阵总账。

## §6 排除声明

历史窗口点亮面(见 §4 末条);slice 1 tripwire(已出);任何 runtime 变更提案(发现 runtime 缺陷→停,单开 fix PR,per d3d2 scope-lock §3)。
