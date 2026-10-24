# SA-02：PLM 读取配置的待审材料、版本与生效边界

状态：2026-10-01 用户明确选择 §9 方案 A，允许对应本地实施；其余非授权范围不变。与实现分支分离，未开 PR、未合并、未部署。初稿日期：2026-09-30。

上位目标：[受控自助集成目标](integration-self-service-adaptation-goals-20260930.md)。本文件只决定备料 PLM 七组角色配置怎样复用和生效，不新增通用工作流引擎，也不替代原集成收敛方案。

## 1. 为什么不能只加“发布”按钮

事实基线为 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a`；以下 plugin 路径均相对 `plugins/plugin-integration-core/lib/`。

- `stock-preparation-table-actions.cjs:202` 的 `normalizeSource` 消费服务器配置；`:881` 注册表保存部署时动作，`:908` 只允许来源绑定覆盖连接指针。既有绑定 POST 在 `http-routes.cjs:1601` 只接受 `externalSystemId`。它不是任意 readPlan 发布口。
- 宿主 `packages/core-backend/src/plugin-runtime-config.ts:105` 从既有动作 JSON 配置提供 readPlan。普通 API 的 `read-source-config-store.cjs:232` 虽有版本机制，其 validator 只承认四类 API 读取模式，不能把 BOM 七组 SQL 角色伪装成其中一种。
- 普通预演的 `buildRevision`（`stock-preparation-table-actions.cjs:1484`）包含来源和 readPlan；大 BOM 使用持久化 `actionSnapshot`。基线的 apply-start / chunk 在 `http-routes.cjs:6769,6834` 只检查当前动作仍存在，随后继续消费旧快照，不比较当前执行配置。
- 只读闭环核查已在合成环境复现：plan 后更换来源 ID、plan 后改字段、approve 后换来源，旧任务仍能写。此处必须先补执行入口核对，再考虑在线生效。

## 2. 本轮先交付的边界

推荐分两层推进，不把离线材料称为在线生命周期完成：

| 层 | 能力 | 生效与授权 |
|---|---|---|
| B：可复用待审材料 | 用户编辑、结构校验、预览、下载、再次导入；合成布局走真实 BOM 展开 | 始终 `confirm-required` / `structure-only`。导入只改变本地草稿，不读取库、不改绑定、不批准、不发布 |
| A：持久版本与显式激活 | 独立 BOM 配置账本、状态迁移、审计、精确版本绑定、运行时复核 | 后续小批实现；新入口和授权合同按 GOV-08 单独交付，未启用前继续使用既有服务器受审配置 |

B 的部署仍沿用既有人工审查和服务器配置变更流程；把待审 JSON 的状态改为 `approved` **不是**批准手段。审查者需核对字段语义、只读权限、B2a 对象范围以及来源/目标绑定。部署和真实读取需另行授权。没有新增“信任上传文件”开关。

### 2.1 草稿导入合同

- 仅接受本工具生成的 schema v1 封装与七组字段角色；拒绝未知键、凭据、身份、SQL、其他 source kind 和自报批准状态。
- 文件/文本上限 128 KiB；只在浏览器解析，不上传、不存 localStorage。
- 成功导入后须重新生成结构预览；失败保留原字段，但清除旧预览，不允许下载旧结果冒充本次成功。
- 编辑、示例替换或新导入优先于尚未结束的旧文件读取；卸载组件后不接受迟到结果。
- 模板及字段名可能属于客户元数据；下载材料不能贴入公共 PR 或 values-free 审计面。

## 3. 先补大 BOM 配置变化失效

在既有 apply-start 和每次 chunk/resume 入口，比较当前有效动作与持久展开任务的动作快照：

1. 双方使用同一个 action normalizer；readPlan 使用真实 BOM normalizer。
2. 比较执行相关字段：来源句柄及作用域、读取计划、目标和字段映射、模板、根选择、carry/冲突策略、执行预算。对象键顺序不影响结果；仅动作的 `action.label` 不改变执行身份。模板整体保守纳入，包含字段顺序、ownership、版本和模板显示字段；修改模板显示名也需重新预演，不能宣称所有显示变化均被忽略。
3. 不同即固定、values-free 的 409，要求重新展开和预演；发生在目标探针、apply job 创建、checkpoint 推进和写入之前。既不改用新配置继续旧任务，也不退回旧快照继续。
4. 未变化、等价缺省配置可继续。原 B2a/C6、字段存在性、生产界限和 owner/tenant 门仍逐一执行，不以新比较替代。

保证范围是**每个应用入口的配置快照一致性**，不是配置修改与整个长任务原子互斥，不防同一请求校验后的并发配置更改，也不等于识别同一来源 ID 背后所有物理连接材料变化。后续持久激活需要单独的版本/代次控制，不能借此声称完整撤销语义。

验收使用真实路由注册、真实任务/计划/写入器及持久 Map 边界替身，重新注册路由并复用 storage 模拟部署变化。两入口分别去掉守卫都必须有独立红例；chunk 拒绝时写调用、checkpoint 和存储状态不变。

## 4. 在线生命周期 A 的最小合同

以下是分批实现合同；§7–8 记录本地实现进度，**不是当前线上已有功能**。

### 4.1 独立领域、三种身份

- `draft`：未生效的结构；保存不发起源读取。
- `approved`：完成配置审查的不可变版本；仍不意味着客户窗口或执行获准。
- `active pointer`：动作在精确作用域内显式引用某个 approved 版本。不能动态取 `latest`，不能将批准自动等同激活。
- `retired`：不再用于新执行；激活指针仍指向 retired 版本时 fail closed，不自动降级部署默认值。回退也是显式、审计的重新激活，不是读取失败时 fallback。

内容标识只证明“内容相同”，不是审批签名。执行身份另外绑定服务器确认的 tenant、workspace、action、来源及激活代次；同样 JSON 在另一个作用域不能继承批准。

### 4.2 存储与并发

- BOM 独立版本表和审计表，复用现有事务/内容寻址/CAS 机制，不改成普通 RSC mode。新迁移编号在实际落盘时协调分配，不预占号码。
- 不可变规范化配置，服务端版本号；`scope + action + system + content_key` 与 `scope + action + system + version` 唯一。相同内容不重复发版；retired 内容不能因重复保存自动复活。
- 新版本引用来源前，事务第一句固定 READ COMMITTED，然后通过 `external-system-pointer-lock.cjs` 取得来源 KEY SHARE；遇到唯一键竞争，重开事务有界重试。
- 状态 CAS、激活指针和对应 values-free 审计同事务；审计失败必须回滚。不能照搬既有 source-binding route 的事务后追加审计方式。
- 显式激活需独立 pointer/代次存储，或经专门迁移扩展既有 pointer 合同；两张版本/审计表本身不代表发布已完成。
- 外部系统删除保护必须计数新活引用（包括 draft），按 tenant + system，不按 workspace 漏算；新指针写入与删除使用同一锁协议。状态分类查询必须保证转换期间不漏计，缺表以外的查询失败不能当零。

### 4.3 授权与作用域

- 新版本及激活入口要求可信认证 tenant，不接受请求头填补无声明 token；已有 `resolveVerifiedClaimTenantId` 可作为严格来源的参考，不能依赖 W4 是否打开。
- 首版管理操作仅允许 workspace 显式 null；非 null 直接拒绝，不能仅把 query/body 字符串当成员授权。未来 workspace 管理需真实成员/管理能力另行裁决。版本查询及执行按实际匹配的精确作用域，不复制来源指针的 null/唯一 sibling 回退。
- 保存草稿、批准配置、激活动作是三种不同操作。确切 permission 与 owner 管理方式须在对应独立 ADR 中冻结并测试；本设计不通过“现有 integration:write 可调用 RSC approve”推导出新的批准权。
- 激活时与运行时都核同一来源、approved 状态、作用域及代次。裸 principal 的数据源 owner 门、B2a 的对象/窗口和 C6 目标约束仍保留。

### 4.4 生效后的失效语义

- 普通 dry-run/apply token 必须包含服务器确认的执行身份及激活代次；仅现有 readPlan 内容 hash 不足以宣称跨租户/工作区隔离。
- 大 BOM 在展开开始、计划生成、批准及每次 chunk/resume 都验证引用版本/代次；变化需重做，不把旧 job 改绑到新版本。
- 对激活/撤销与正在执行 chunk 的并发提供明确边界。首版可保证“下一个入口阻断”，若业务要求立即停止已进入的 chunk，须增加执行锁/租约协议及真库测试，不能宣传已有此保证。

## 5. 下一批的验收门

1. 先完成 B 的导入复用和本文件 §3，真实路径正反控制、去守卫变异、邻接回归和最终候选 provenance。
2. 再交 A 的 validator/store 与隔离 PostgreSQL 用例：并发 mint、同内容复用、状态 CAS、审计失败回滚、跨 tenant/workspace 拒绝、草稿/退役运行拒绝、删除/新建两种交错。
3. 权限与激活合同冻结后接新端点和运行时，不能在 store 单测全绿时宣称自助生效已交付。
4. 可扩既有 `external-system-delete-bind-lock-protocol.db.test.ts`；它已有真实数据库 CI 接线和 EXPECT_DB sentinel。内存 DB 不能代替事务/锁证据。
5. 未获真实客户/外发/部署授权时继续合成验证；不访问客户库，不发宜搭，不动 K3 禁写，不部署。发布/PR/合并也保持单独授权。

## 6. 回滚与发布拆分

- 本轮 B 不持久化；撤回 UI/import 代码不改变线上绑定或配置。
- 大 BOM 一致性检查会令配置已变化的旧任务返回 409；先重新预演，不删除 job 强行恢复。若撤回此修复，会重新暴露旧快照继续应用，必须明确风险。
- A 将来按“迁移 → 只读/未启用存储 → 获准激活接线”分批，另列部署及回滚文档；没有在任何现有环境执行迁移，§7 的迁移验证只在新建一次性合成实例进行。
- 本设计与实现已在不同本地分支；将来获准发布时继续保持独立 PR，不把本文件候选状态写成已批准决策。

## 7. 实现进度：仅账本子层（2026-09-30）

代码分支已新增严格 validator、独立版本/审计 store 和本地 087 迁移，接入来源删除计数。精确 scope、内容与版本双唯一约束、重复内容复用、单向状态迁移、审计原子性及删除/新引用锁协议已由真实 PostgreSQL 14 验证：原有 suite 扩展后 44/44，含 11 项新增场景；主审 6 个数据库守卫变异均致红，恢复后整套再次通过。当前仅是本地未提交代码，不把此结果标为设计已获批准、客户验收或线上发布。

截至该子层完成时，尚无新端点、active pointer、激活代次、宿主能力消费者或 UI→store 接线。后续 activation 存储进度见 §8；store 的可信 scope 参数仍不是授权。来源锁不承诺同 ID 配置冻结，v1 安全句柄约束也不承诺所有历史 ID 兼容。

## 8. 激活指针子层（本地实现，不开放入口）

087 尚未发布或在既有环境执行，因此直接在同一迁移加入独立 activation 表，不另建编号。每个精确 tenant/workspace/action 仅有一条 pointer；指向显式 approved version，保留 system/contentKey 和递增 generation。禁用保留行与代次；重新激活同内容也递增，不删除后从 1 开始。

- 激活事务：READ COMMITTED → 来源 KEY SHARE → 目标 version FOR UPDATE → pointer FOR UPDATE → CAS → 同事务审计。锁前的版本预读只用于发现来源；锁后重读/重新验证 approved，不能复用预读状态。
- 停用：version FOR UPDATE → pointer FOR UPDATE，比较锁前 hint 与当前 version/generation；旧版本已 retired 仍允许停用。没有 pointer→旧 version 的反向锁序。
- 显式激活校验目标版本并完整覆盖旧 pointer 内容；不要求旧 pointer 的 contentKey 与旧版本一致才能修复。运行读取与停用仍拒绝内容不一致。该选择不继承损坏内容、不授予额外权限；独立审查未发现该处边界缺口。
- 审计、首次插入、更新及 generation 同事务；并发首次插入的指定唯一冲突返回 409，不静默覆盖竞争者。代次溢出拒绝。
- `getActiveForRuntime` 仅返回精确 pointer→version；disabled、retired、错误来源/代次、内容损坏直接拒绝。加载版本后重查 pointer，拒绝读取期间的代次漂移。真正没有 pointer 才返回 null；此结果不是授权，也不保证随后运行与撤销原子互斥。

主审运行新建的一次性 PostgreSQL 14：既有 suite 扩展为 **54/54、零跳过**。新增 10 项 activation 场景覆盖两种首次竞争（同版本锁与不同版本唯一索引）、代次 CAS、退役两种交错、禁用与跨版本激活两种交错、删除锁等待、审计失败回滚。另有 node 11/11。9 个实际 PG 内存变异及 1 个 node 二次读取变异均致红，分别覆盖锁、锁后状态、approved、禁用、代次、scope、审计、唯一冲突翻译和读取中漂移；无生产文件变异落盘。

这些证据只背书存储合同。路由、UI 保存、实际执行用 resolver 尚未消费该层；不能称在线自助生效已完成。

## 9. 授权前置的读码纠偏与方案 A 裁决

以下路径基于代码工作树 HEAD `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` 加本批未提交变更；涉及文件截至本节核验未改变相应函数。

1. `packages/core-backend/src/services/tenant-principal-directory-boundary.ts:49` 明确不提供 workspace 检查：当前关系是 `user_orgs`，并无可供本端口使用的 user→workspace membership。`lib/http-routes.cjs:1393` 的 `resolveWorkspaceId` 只是 selector。此前“复用现有工作区成员校验”的前提撤回，不能靠换一个 helper 名称补成权限证明。
2. `packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:594` 的 registration 路径通过裸 principal 调用 `manager.assertAccess`（`:617`），只读注册元数据，不 connect；`:693` 返回 id/type/tenantId/scopeKind，没有 workspace 或 isReadOnly。新管理入口可以复用 owner 校验，但还必须拒绝 tenant-null legacy registration、要求 canonical Connection 且 returned tenant 与认证 tenant 精确一致。真实读取的 readonly 检查仍在 `:661` 的 authorize 路径，不能从 registration 冒称已测试可读。
3. `lib/http-routes.cjs:1284` 的严格 tenant helper 只接受 `authenticatedTenantId`，拒绝冲突来源；`packages/core-backend/src/auth/jwt-middleware.ts:101` 在 header 兼容回填前保留 JWT tenant。新管理入口必须直接使用该严格来源，不能依赖 W4 是否打开，也不能拿 `user.tenantId` 或旧 Binding tenant 自证。
4. `lib/stock-preparation-source-binding-store.cjs:232` 的 get 有 tenant-null 与单 workspace 回退，产出 `matchedWorkspaceId`。批准版本本身不复制这种回退；未来执行 resolver 必须携带同一次实际匹配 scope，不从请求 workspace 猜测。

2026-10-01 用户明确回复“同意按此实施”，选择下列 A；B 不在本批授权内：

- **已批准 A：首版仅 tenant-level（workspace 显式 null）管理 + 既有 integration admin 门 + 当前 Connection owner。** 保存、批准、激活/停用分别操作并审计，但不引入独立四眼审批；admin 不绕过 owner。非 null workspace 管理请求直接拒绝，不在其上伪造成员证明。已有工作区配置/业务读取路径不因此放宽或替换。
- **B：先新增真实 workspace membership/管理权限，再开放 workspace 范围。** 需要额外关系、权限撤销与迁移合同；仍是 admin 与 Connection owner 的交集，不能把普通 use/raw query 权限混入。

该裁决仅解锁 A 的本地开发及合成验证，不是客户读取、生产写入、外部发送、发布/合并或部署授权。设计仍独立于代码分支，未来按 GOV-08 分开发布。下面历史实施记录中的“权限待选”已由本次明确选择替代；实现尚需逐项验证，不因批准自动视为接线完成。

## 10. 已完成的执行子层与尚缺的入口覆盖

代码分支增加纯 `composeStockPreparationReadPlanAction`，只接收调用者传入的确切 activation/version/scope，校验 active/approved、version 身份及配置摘要，输出携带闭集执行身份的 action。身份的 workspace 来自实际绑定/激活作用域，不机械替换既有 `source.workspaceId` 连接选择字段。它不查 latest、不做网络或存储 I/O、不授予权限。

normalizer 保留并二次核验身份，普通 revision 与大 BOM 执行合同纳入身份；普通和后台 maxReadCount 被批准预算封顶，同时保留原来更低的有效预算。未激活的 shape/hash/后台倍率保持不变。真实 ledger→compose→dry-run/apply/后台 runner 的合成专用 suite 9/9，17 个身份/预算/兼容变异被抓住；其中 tenant/workspace/versionId 各只改一个身份字段仍能令旧合同失效。旧 generation token 实际 apply 零写拒绝，新 generation token 同路径写入合成边界。

**未接 index/routes/UI，不能称在线生效完成。** 后续执行用 resolver 须与仅取元数据的 registry 访问区分，覆盖普通 dry-run/apply、confirmation reconcile、mvp-persist、后台展开 start/run、plan、apply-start/每 chunk 和 source-preflight；持久 snapshot 入口不能因绕过 registry 漏掉重验。显式 preflight 源覆盖必须拒绝 A 计划被用于 B。所有真实读取仍需原有 facade owner/tenant 和 B2a，所有写入仍需 C6。

当前普通 apply 在源重算后比较 token revision，旧 token 会消耗且可能已读源；测试明确记录此行为，不宣传“读源前失效”。要保证下一个请求读源前拒绝旧代次，还需要入口对 token 身份做非消耗校验；要立即终止在飞 chunk 则另需执行锁/租约。已完成的身份 hash 不替代这些剩余接线。

## 11. SA-02G：双布局 canonical SQL 合成验收（不新增入口）

2026-09-30 本地验证合同。现前端草稿测试的两个布局经过真实 compiler/expander，但 SQL read 是内存替身；现 `scenario-b-synthetic-bom-source-run.test.ts` 真 PG 只覆盖扁平 feeder，`data-source-c3-keyset-realdb.test.ts` 只覆盖分页。两者没有把 canonical resolver、真实 owner facade 和七对象 BOM 展开串起来。因此补一项纵向证据，而不是再造演示或运行端口。

- 固定纯合成业务数据、两套表/列命名、两个不同 Connection 与 owner；草稿 compiler/导出再导入及真实 BOM normalizer 不替身。数据库布局按独立夹具定义，不从 compiler 输出反向造一套恰好匹配的数据。
- 两条链都通过真实 ConnectionResolver → 真实 data-source-plugin-facade / DataSourceManager → 真实 PostgresAdapter → 真实 expander。manager 注册元数据仅本次内存且 persist:false；不伪装为 HTTP/JWT 或持久批准/激活验收。
- 断言相同业务输出：订单 V1 不能被物料 V2 替代、多层数量/重复关系的预期不漂移；改映射无需改读取实现。交叉 owner、tenant 不一致、缺主体，以及合法但错误的映射须独立拒绝或不能产生正确预览；外部数据读取计数不能被另一道无关门掩盖。
- 使用已注册真实 DB suite 的扩展；主审掌管新建、随机身份、loopback/tmpfs PG。worker 不自行连库，不加载 `.env`，不连接任何既有实例。没有客户读取/写回，源表前后相同；数据库准备只属于本次临时夹具。
- 真路径先通过，再用精确内存变异分别删 owner/tenant/订单版本选择守卫取得行为 RED；最终生产字节不变。若暴露真实生产缺口，先报告并冻结最小修补合同，不扩大为通用重构。
- 本片仅测试与验证材料；无 endpoint、权限、runtime consumer、迁移、flag 或部署变更。§9 权限裁决仍是在线自助生效的前置，不因本片通过改称在线已完成。

本地验收结果：原 C3 suite 扩展为 15 项，真实 PG 最终候选两次 15/15、零跳过；三个精确内存降级分别为 owner 2红/13绿、Binding tenant 2红/13绿、订单版本传递13红/2绿。最后一个会令负例中的业务正控制先失败，不冒称13个独立漏洞。缺 DB 的真实泳道标记触发精确 collection error；六次仅本次临时数据库均已清理。独立只读审查无新增阻断，生产字节未改。详细命令、首次测试引号假设纠偏及证明边界见代码分支 `integration-self-service-plm-canonical-source-verification-20260930.md`；线上授权与接线仍未完成。

## 12. SA-02H：获准后的在线纵向接线（2026-10-01，本地候选已接通）

本节执行 §9 已获准的 A，不开启 workspace 共享、Automation 新动作或真实客户读取。实现与本设计继续保持不同工作树；未经另行授权不提交、推送、开 PR、合并或部署。

### 12.1 管理合同

复用 `/api/integration/stock-preparation/read-plan-configs` 前缀，所有请求显式声明 `managementScope: 'tenant'`；服务器固定 workspace 为 null，tenant 仅取 verified JWT，actor 仅取既有认证 principal。额外 body/query 属性拒绝，不能借 `workspaceId`、actor 或 tenant 选择管理对象。

| 方法/子路径 | 最小请求 | 返回 |
| --- | --- | --- |
| GET 根路径 | query: managementScope、systemId | 该来源的版本列表及当前动作指针 |
| POST 根路径 | managementScope、config | 已保存的不可变 draft/reused 版本 |
| POST `/:id/approve` | managementScope、systemId | 指定批准版本 |
| POST `/:id/retire` | managementScope、systemId | 指定退役版本 |
| POST `/:id/activate` | managementScope、systemId、expectedGeneration | 新代次的显式指针 |
| POST `/deactivate` | managementScope、systemId、expectedGeneration | 保留行及递增代次的 disabled 指针 |

每次入口均需既有 integration admin 与当前 Connection owner。仅接受同 tenant、null workspace 的 canonical SQL source Binding；Connection 元数据必须同 tenant、非 legacy、非 workspace scope。管理核验只读元数据，不 connect、不探测真实源、不回传 credentials 或整个 Binding。保存/批准/激活要求 source active；查询、退役和停用允许在 inactive source 上清理，但仍要求当前 owner。action 固定为既有 PLM 拉取 BOM 动作。

指针按 tenant/workspace/action 唯一，而非按 system 唯一。因此查询若需返回旧来源 B 的指针，或从 B 切到 A，必须同时核验 B/A 的当前 owner；不能仅凭 A 的 owner 覆盖他人指针。expectedGeneration 只负责防止旧状态覆盖，不代替所有权证明。

逐请求重新授权可阻止已完成的 owner transfer/rebind 后旧 owner 继续管理，但**不承诺 mutation 提交瞬间与 owner/rebind 原子互斥**：现有 metadata owner 来自宿主内存，来源 KEY SHARE 防删除，不冻结普通配置更新。首版不假造双读原子保证，也不新增宿主授权锁协议。

### 12.2 执行与界面

执行 resolver 与 metadata registry 分离；不把停用计划变成无法查看/取消任务。持有同一次 source-binding 匹配及其 `matchedWorkspaceId`，按实际精确作用域读取 activation，不能把 tenant-null 计划套到 sibling workspace。没有 ledger 服务/缺迁移/读取错误不是“没有 pointer”；只在真实查询确认没有 pointer 时保留部署配置路径。

普通 dry-run/apply、reconcile、MVP persist、后台 start/run/plan/apply-start/chunk 和 source-preflight 均重验。旧 token 增加服务端执行身份并做非消耗预检；旧 job snapshot 保持不可变，用当前合同对比，拒绝后不得读源或写目标。显式 preflight source override 不得把 A 的在线计划用于 B。仍保留最终 revision、owner/facade、B2a、C6 守卫；不会中断已经进入的 chunk。

扩展已有“备料 → 数据来源与体检 / 开始使用”的 PLM 草稿区域，不造新页面。默认保持纯本地编辑，用户显式进入租户级管理；管理范围与页面执行范围分开展示，不改浏览器 workspace、不偷改来源绑定。保存不自动批准/激活；审批和激活基于精确版本，不基于可变表单或 latest。没有执行状态查询时不得声称当前工作区已应用租户级计划。身份/权限/范围/目标变化和卸载均令异步旧响应失效。

### 12.3 发布前置与证据边界

087 仍为未发布候选迁移，部署必须先执行迁移再上线含 runtime 接线的代码；缺表时执行拒绝，不能为了兼容静默 fallback。端到端证据应包含真实 handler/ledger/runtime 生产组合、正负控制、单守卫变异和生产 bootstrap 接线。内存 DB 不背书事务；现有 54 项隔离 PG 证据复核与新增管理/执行证据分别列明。最终候选需要重新计算全部 provenance pin、跑完整 provenance 测试和邻接回归；实施中不将测试计划写成已通过。

### 12.4 本地审查收口

代码分支已接真实 bootstrap、六管理端点、已有面板及十个执行入口。management10/10、runtime25/25（含11个内存变异）、bootstrap1/1；主审另跑7个管理单守卫变异全部行为红；54项临时PG回归通过并清理。完整260套插件链259 Windows绿+1既有分隔符失败（整链exit1），原失败套WSL绿；完整provenance及66标量校验通过，不冒称远端CI/生产验收。

独立执行复核修复了三条具体路径：无action预检也按实际匹配scope查activation；已提供token但读取异常503且不消耗、不读源；reconcile保留原tenant-null绑定选择及legacy adapter hint。metadata-only仍不借公共投影造adapter。Grok4.7界面复核另修在途版本改选、同ID指针/版本内容不一致，以及审批/激活代次文案；KimiK3测试接线核查补新Vue spec-only触发。

逐请求撤权不等于在飞原子撤销；缺失/过期且服务端已无记录的token仍受原失效逻辑，不能从不存在的内容推断其历史online身份。管理facet仍是内存metadata替身，JWT HTTP与整站浏览器验收尚缺，不能把分别通过的测试拼成一条真实客户全链。

完整验证、模型职责、已知旧绑定UI遗留及文件冻结值见代码工作树 `docs/development/integration-self-service-plm-online-management-verification-20261001.md`。本文前面“未接index/routes/UI”的描述属于各历史阶段，当前实现状态以本节为准；未发布、未合并、未部署，总目标尚未完成。
