# Material Reconciliation D2 — 绑定底座设计锁（Binding Substrate Design Lock）

**状态:PROPOSED（2026-07-21;等 owner ratify;ratify 仅解锁 D2 实现,不授权 D3a+ 任何运行时）**

Charter:`stock-preparation-v2-material-master-reconciliation-charter-20260719.md`(RATIFIED,
owner 2026-07-21,OD-V2-1..7 全按推荐)。本锁 = charter §7 **D2 行**的设计门交付物:
**场景实例与绑定版本库**——§3 绑定对象落物理表、§4.1 指针权威 `active`、§4.5 生命周期
(前两层:Preflight 记录 / Activate 事务)、`systemContentKey` 内容键派生与钉住。
D1 冻结合同(#4507 `1f06ecea9` + #4511 `749ba92d0` 四轮 corrective)是本锁的不可改前提。

## 1. 范围与非范围

**D2 交付**:迁移 068(四张绑定物理表)+ `material-reconciliation-binding-store.cjs`
(生命周期事务)+ 三个内容键派生的字节级冻结 + `/api/material-reconciliation` 绑定族路由
(default-OFF)+ 独立权限判定 + **本插件首个真库测试通道**(`DATABASE_URL`-gated CJS
harness + plugin-tests.yml 接线——现存插件测试全 hermetic,无可复用通道)+ 真库测试电池
(§7 映射表)。

**明确不在 D2**(违反即审阅红线):
- run/snapshot/diff/claim 的任何运行时(D3a);preflight **探测引擎**(外部连通性/分页/
  一致性证明能力探测,D3a)——D2 只实现 preflight **结果记录**的状态迁移;
- Run-start / Commit 两层重验(§4.5 第 3/4 层,D3a);
- comparator / 六桶(D3b);UI(D4/D5);值面读(OD-V2-4 另门);flag 开启/试点(D6);
- `integration_external_systems` 注册表本身的任何 schema 变更(charter §2.3:create-only
  版本化属独立设计门)。

## 2. 物理表(迁移 `068_create_material_reconciliation_binding_tables.sql`)

### 2.1 命名裁决:objectId ↔ 物理表名

`plugins/plugin-integration-core/lib/db.cjs:25` 强制经插件 DB 助手访问的表以
`integration_` 为前缀(`ALLOWED_PREFIX` 守卫,:40-49);D1 冻结 objectId 前缀为
`material_reconciliation_`(templates lib:31)。裁决:**objectId 是逻辑名,物理表加
`integration_` 前缀**——先例即 stock-prep(066 `integration_stock_prep_audit`):

| D1 objectId(冻结) | 物理表(本锁冻结) |
|---|---|
| `material_reconciliation_scenario` | `integration_material_reconciliation_scenario` |
| `material_reconciliation_binding_version` | `integration_material_reconciliation_binding_version` |
| `material_reconciliation_binding_member` | `integration_material_reconciliation_binding_member` |
| `material_reconciliation_binding_audit` | `integration_material_reconciliation_binding_audit` |

索引/约束名超 PG 63 字符限制,统一用短前缀 `mr_`(如
`uniq_mr_binding_version_scenario_pair`)。

### 2.2 建表(业务列与 D1 冻结模板 1:1——scenario 无任何模板外列;numbered SQL 流,up-only,幂等)

迁移走 `packages/core-backend/migrations/`(0NN 流,下一号 **068**;该流由
`migration-provider.ts` 与 Kysely TS 流合并,`allowUnorderedMigrations`)。四表均非
zzzz 表、且只引用同迁移内表与既有 0NN 表,**无 zzzz 依赖**(zzzz-ordering 陷阱不触发;
`integration_read_source_configs`/`integration_external_systems` 均为 0NN 流既有表,D2
不加列)。样式循 057:`TEXT PRIMARY KEY`、`tenant_id TEXT NOT NULL`、闭 CHECK 词表、
`IF NOT EXISTS` 幂等、`uniq_`/`idx_` 命名。

```sql
CREATE TABLE IF NOT EXISTS integration_material_reconciliation_scenario (
  scenario_id                TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL,
  title                      TEXT CHECK (title IS NULL OR char_length(title) <= 200),
  active_binding_version_id  TEXT,            -- 唯一权威指针(§4.1);可 NULL
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_material_reconciliation_binding_version (
  binding_version_id    TEXT PRIMARY KEY,
  scenario_id           TEXT NOT NULL REFERENCES integration_material_reconciliation_scenario(scenario_id),
  tenant_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('draft_candidate','preflight_passed','approved','superseded','revoked')),
  contract_version      TEXT NOT NULL,
  binding_fingerprint   TEXT NOT NULL,        -- internalOnly(§3 冻结;响应投影禁出)
  baseline_lineage_key  TEXT NOT NULL,        -- internalOnly
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at         TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  CONSTRAINT uniq_mr_binding_version_scenario_pair UNIQUE (scenario_id, binding_version_id)
);

-- 复合 FK:指针在数据库层不可能指向他场景的绑定(§4.1;charter 冻结形态)。
-- PG 无 ADD CONSTRAINT IF NOT EXISTS,以 DO 块吞 duplicate_object 保幂等(up-only 流重跑安全)。
-- 语义蓄意依赖默认 MATCH SIMPLE:指针 NULL(清指针态)跳过约束——合法;非 NULL 则强制
-- (scenario_id, binding_version_id) 全配。**永不改 MATCH FULL**(会把 NULL 指针判违约)。
DO $$ BEGIN
  ALTER TABLE integration_material_reconciliation_scenario
    ADD CONSTRAINT fk_mr_scenario_active_pointer
    FOREIGN KEY (scenario_id, active_binding_version_id)
    REFERENCES integration_material_reconciliation_binding_version (scenario_id, binding_version_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS integration_material_reconciliation_binding_member (
  member_id                    TEXT PRIMARY KEY,
  binding_version_id           TEXT NOT NULL
    REFERENCES integration_material_reconciliation_binding_version(binding_version_id),
  role                         TEXT NOT NULL CHECK (role IN
                                 ('engineering_material_master','enterprise_material_master')),
  approved_config_version_id   TEXT NOT NULL,
  system_content_key           TEXT NOT NULL,  -- internalOnly;§3 派生
  connector_capability_version TEXT,
  consistency_proof_mechanism  TEXT CHECK (consistency_proof_mechanism IN
                                 ('SOURCE_SNAPSHOT_TXN','IMMUTABLE_SNAPSHOT_TOKEN','MONOTONIC_VERSION_PIN')),
  CONSTRAINT uniq_mr_binding_member_role UNIQUE (binding_version_id, role)
);

CREATE TABLE IF NOT EXISTS integration_material_reconciliation_binding_audit (
  audit_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  scenario_id         TEXT NOT NULL,
  binding_version_id  TEXT,
  action              TEXT NOT NULL CHECK (action IN
                        ('candidate_created','preflight_passed','approved','activated',
                         'superseded','revoked','pointer_cleared','pointer_switched')),
  actor_id            TEXT,
  at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mr_binding_audit_scenario
  ON integration_material_reconciliation_binding_audit(tenant_id, scenario_id);
```

裁决记录:
- **audit 表无 FK**:append-only 永存(retention `permanent`),追加不得被引用竞态阻塞;
  完整性由「同事务写入」保证(§4 事务规格),不靠 FK;
- **无 `updated_at` 列、无触发器**(对抗验证吸收):D1 冻结 scenario 为 `pointer_cas_only`
  且字段五列**不含** `updated_at`——加列即违反冻结写入纪律。指针变更时间由审计行
  (`pointer_switched`/`pointer_cleared` 的 `at`)派生,一处权威。binding_version 的
  status/superseded_at/revoked_at 由事务显式落时间戳;member/audit 不可变——**全四表无触发器**;
- `title` 是唯一用户自由文本:列级 CHECK ≤200 字符 + 路由请求校验双层承重(断言的不变量
  必须被强制,不留「有界」空话);
- **不建 `WHERE status='active'` 部分唯一索引**——charter §4.1 明文拒绝
  status-authoritative 变体,两套权威语义不得并存(058 先例保留给 D3a `runIdentityKey`);
- 跨租户完整性:FK 不含 tenant;租户隔离由 store 全部查询强制 `tenant_id = ?` + §7
  跨租户负控测试承重(与 charter 冻结的复合 FK 形态一致,不擅自加宽)。
- **迁移-模板一致性守卫**(CJS 合同测试):对四表逐一断言迁移 SQL 的列名/CHECK 词表与 D1
  冻结模板的 fields/select vocab/uniqueness **机器对账**(解析 068 文本 vs
  `MATERIAL_RECONCILIATION_TEMPLATES`),防手写漂移。

## 3. 内容键与指纹(字节级冻结;charter 只冻结到语义层,本锁补齐字节层)

三键均 **internalOnly**:进库、进日志皆可,**任何 API 响应/UI/审计行禁出**(§6 投影
allowlist + 泄漏测试承重)。裸 SHA 内部保存合规(charter §8.2b-8:公开表面才要求
HMAC/不出现)。

### 3.1 `configContentKey` ——**引用既有键,不新造**

≡ `integration_read_source_configs.content_key`(read-source-config-store.cjs:101-103
`contentKeyFor`:sha256 over 排序键 `stableStringify(content)`,version 字段剔除;
approved 版本内容不可变,S1 校验为唯一入口)。D2 在候选创建时从 approved 版本行**读取**
该列;不重算、不另立算法——一键一权威。

### 3.2 `systemContentKey`(P1-2 内容键单轨;本锁冻结派生)

- **输入(闭集)**:`integration_external_systems` 行的 `(kind, config)` 两列——charter
  「连接器/源类别」=`kind`;「端点身份、认证主体引用」=`config` JSONB(057 注释:
  base_url/host/port/db_name/account_set_id/env 等**非密码字段**)。
- **明确排除**(逐项理由):`name`(展示标签,非身份);`credentials_encrypted`(密文;
  凭证**轮换**≠系统身份变更,且密文重加密会造成假漂移);`status`/`last_tested_at`/
  `last_error`(运营态);`workspace_id`/`project_id`(作用域,系统行 id 已被 config
  version 的 systemId 引用锚定);时间戳。
- **编码与哈希**:`sha256hex( 'metasheet:mr:system-content-key:v1|' + stableStringify({ kind, config }) )`
  ——`stableStringify` 与 3.1 同一 idiom(排序键,引用同一实现,不复制粘贴);域前缀防
  跨键碰撞。`config` 为 JSONB 经驱动解析后的 JS 值,stableStringify 落键序规范化。
- **钉住与重验面**:候选创建时按 member 的 approved config version 行的 `systemId` 读系统
  行、派生、写入 `member.system_content_key`;Activate 事务内**重算当前值 == 钉住值**,
  漂移 ⇒ fail-closed(§5.4)。任何 `kind`/`config` 就地修改都会漂移——**宽即是特性**
  (charter:任何身份承载字段就地变更 ⇒ 键漂移 ⇒ fail-closed)。

### 3.3 `bindingFingerprint` / `baselineLineageKey`(charter §4.6 公式的字节化)

```text
roleTuple(role)     = lp(role) + lp(configContentKey) + lp(systemContentKey) + lp(connectorCapabilityVersion // '')
bindingFingerprint  = sha256hex('metasheet:mr:binding-fingerprint:v1|' + lp(roleTuple('engineering_material_master')) + lp(roleTuple('enterprise_material_master')))
baselineLineageKey  = sha256hex('metasheet:mr:baseline-lineage-key:v1|' + lp(contractVersion) + lp(bindingFingerprint))
```

`lp` = 4 字节大端长度前缀 + UTF-8(NFC)字节——裸拼接禁止(§8.2b-15 反拼接碰撞纪律,
与 D1 codec 同款;D2 store 自带小型 `lp` 助手,goldens 钉住)。角色序固定为词表序
(engineering 先),不按输入序。两键在**候选创建事务**内计算并落列,此后不可变
(create-only);baselineLineageKey 语义:配置内容/系统身份/连接器能力/契约版本任一变
⇒ 新 key(charter L435-437),由「输入全部来自钉住值」构造性保证。

## 4. 生命周期事务规格(store:`material-reconciliation-binding-store.cjs`)

状态机 = D1 冻结 `MR_BINDING_STATUSES`/`MR_BINDING_TRANSITIONS`(单向;`active` 非存储
状态,是「被指针指向」的派生谓词)。每个操作 = **恰一个 PG 事务**;审计行与业务写**同
事务**;所有查询强制 `tenant_id` 限定(租户仅从认证主体派生,任何 body/query 的
tenant/workspace/project steering 在 I/O 前拒绝——`resolveAuthUserTenantId` 先例)。

| 操作 | 迁移 | 事务内容 | 审计(同事务) |
|---|---|---|---|
| `createScenario` | — | 插 scenario(指针 NULL) | **无**——冻结审计词表无 scenario 级动作;裁决:D2 不审计场景创建,补动作需 D1 词表版本升级,不在本锁 |
| `createBindingCandidate` | →`draft_candidate` | 插 binding_version + **恰两个** member(角色词表全覆盖,缺/重即拒);读 approved config 版本行(approved-only,`getForRuntime` 先例)取 `configContentKey`+`systemId`;读系统行派生并钉 `systemContentKey`;算两指纹落列 | `candidate_created` |
| `recordPreflightPassed` | `draft_candidate`→`preflight_passed` | 状态迁移(探测引擎 D3a;本操作只收**values-free 结果引用**,无自由文本) | `preflight_passed` |
| `approve` | `preflight_passed`→`approved` | 状态迁移 | `approved` |
| `activate` | 指针切换(+旧版 `superseded`) | **§5 全文** | `activated` + `pointer_switched` + (旧版存在时)`superseded` |
| `revoke` | `approved`→`revoked` | **§5.5** | `revoked` + `pointer_cleared` **或** (`pointer_switched` + 替代版激活审计) |

非法迁移(跳级、终态再迁、重复同态)⇒ fail-closed `MR_BINDING_STATE_INVALID`(409)。
`superseded` **只能**由 activate 事务落下(无直接 API)——「被后续版本正常替代」语义。

## 5. Activate / Revoke 事务全文(D2 的心脏)

### 5.1 权威分层(charter §4.1 冻结)

- **数据库权威**:单列指针构造性单选 + 复合 FK(不可能指向他场景)+ `SELECT … FOR UPDATE`
  行锁(scenario 行)串行化并发激活;
- **应用 CAS**(`expectedActiveBindingVersionId` 与当前指针比对)只负责**陈旧请求检测**
  ⇒ 友好 409 `MR_STALE_ACTIVATION`,**不承担最终一致性**。

### 5.2 activate(tenant, scenarioId, bindingVersionId, expectedActiveBindingVersionId)

单事务顺序:
1. `SELECT scenario FOR UPDATE`(tenant 限定;不存在 ⇒ 404);
2. CAS:当前指针 ≠ expected ⇒ 409 `MR_STALE_ACTIVATION`(负者友好退出,§8.2b-1);
3. 目标版本读取:属同 scenario + 同 tenant + status=`approved`(`preflight_passed` 未审批
   /终态 ⇒ 409 `MR_BINDING_STATE_INVALID`);
4. **信当下,不信 preflight**(§4.5 第 2 层)逐 member 重验——charter §4.1 要求「同事务
   锁定验证或 approved-version CAS,机制由实现锁冻结」,本锁冻结为 **`SELECT … FOR SHARE`**:
   a. approved config 版本行 **FOR SHARE 重读**(阻塞并发 retire 直至本事务提交,关闭
      「重验后、提交前被 retire」残窗):仍存在且 `status='approved'`(retired/易主/悬空 ⇒
      **422** `MR_CONFIG_NOT_APPROVED`——422-非-404 循 dangling-config 先例:404 会误读
      为「无此系统」);tenant 归属再证;
   b. 系统行 **FOR SHARE 重读** + `systemContentKey` 重算 == member 钉住值(≠ ⇒ **422**
      `MR_SYSTEM_IDENTITY_DRIFT`,P1-2 fail-closed);(D3a 的 run-start/commit 层仍各自
      再重验——本锁不以 FOR SHARE 替代后两层);
   c. 能力契约:系统 `capabilities.read === true` 且 member 的
      `consistency_proof_mechanism`(如已声明)仍 ∈ 冻结三机制(⇒ 否则 422
      `MR_CAPABILITY_CONTRACT_INVALID`);
5. 指针切换;旧被指版本(如有):`approved`→`superseded` + `superseded_at`;
6. 审计三连(§4 表)落行;提交。

任一步失败 ⇒ **整事务回滚**——不存在半激活。

### 5.3 外部网络零参与

Activate 事务内**零外部 I/O**(charter §4.5 第 1 层:探测只在 Preflight 层、绝不进
数据库事务)。第 4 步全部是本库行重读 + 纯计算。测试形态(裸负断言空转,禁):对
adapter/HTTP client 模块打 spy,activate 全程**零调用**;**配正控**——同一测试断言
activate 真完成了工作(指针已切、审计行已落)。不对裸 socket 断言(PG 连接本身走 socket)。

### 5.4 revoke(tenant, scenarioId, bindingVersionId, { replacementBindingVersionId? })

单事务:
1-2. 同 5.2 的行锁 + tenant 限定;
3. 目标版本读取:**`scenario_id = :scenarioId AND tenant_id = ?` 限定**(与 5.2 第 3 步同构;
   仅按 body 的 bindingVersionId 裸查是跨场景逃逸面——他场景版本 ⇒ 404
   `MR_BINDING_VERSION_NOT_FOUND`,零写入)。状态裁决:**仅 `approved` 可 revoke**——候选/
   preflight 阶段的废弃 = 永不 approve、自然搁浅,状态机不添终态;`superseded` 不可 revoke
   (已非现役,历史不改写);
4. `status`→`revoked` + `revoked_at`;
5. 若该版本**正被指针指向**:
   - 无 replacement ⇒ 指针置 NULL,审计 `pointer_cleared`;
   - 有 replacement ⇒ 对 replacement **完整执行 5.2 第 3-4 步全量重验 + 指针切换**
     (rev-4/§8.2b-16:仅保证指针不悬空**不合格**);**明确不执行 5.2 第 5 步的
     「旧被指版本→superseded」子步**——出局版本在本事务是被 `revoked`,不是被替代,
     不得出现 revoked+superseded 双戳;审计 `pointer_switched` + `activated`;
6. 审计 `revoked`;提交。失败整滚——**不存在「已 revoked 仍被指」窗口**(§8.2b-11)。

### 5.5 崩溃语义

全部不变量由单事务原子性承载:任意点崩溃 ⇒ 整滚,无中间态残留。D2 **无**跨事务状态机,
故无 D3a 的 claim 释放/卡死吸收态问题(那属 §8.2b-13/14,D3a 门)。

## 6. 路由、权限、flag(family:`/api/material-reconciliation`)

- **注册**:循 http-routes.cjs `ROUTES` 表 + `registerIntegrationRoutes` 既有机制;store 在
  `index.cjs activate()` 构造入 services 包。**stock-prep 路由/形状/错误码/OFF 行为逐字节
  不变**(§3 独立性第 6 条,守卫测试)。
- **flag**:每请求以 D1 冻结谓词 `isMaterialReconciliationFlagValueEnabled(process.env.MULTITABLE_MATERIAL_RECONCILIATION_ENABLED)`
  判定(**严格字面 `'true'`**,D1 测试钉死;不采 trim/lowercase idiom——两种 idiom 并存
  时以 D1 冻结合同为准)。OFF ⇒ 整族 **404 `NOT_FOUND`**(feature-invisible;attendance
  异步导入先例)——非 403 变体:未启用的能力不对外承认存在。
- **权限**(OD-V2-3 独立词表;**不接受任何 `integration:*`**):
  `requireMaterialReconciliationAccess(req, action)`——`role:admin` 或
  `material-reconciliation:admin` 全通;`read` ⇒ 三者任一;`operate` ⇒ operate/admin
  (D2 无 operate 路由,词表占位给 D3a run);`admin` ⇒ admin。无 user ⇒ 401
  `UNAUTHENTICATED`。
- **路由族**(方法/路径/权限):

| 路由 | 权限 | 语义 |
|---|---|---|
| `POST /scenarios` | admin | createScenario |
| `GET /scenarios` / `GET /scenarios/:id` | read | 列表/详情(active 为派生字段:指针值) |
| `POST /scenarios/:id/binding-versions` | admin | createBindingCandidate(body 只含两 member 的 approvedConfigVersionId + title 类元数据;**systemId/URL/SQL 出现即 400 拒绝**) |
| `POST /binding-versions/:id/preflight-passed` | admin | recordPreflightPassed |
| `POST /binding-versions/:id/approve` | admin | approve |
| `POST /scenarios/:id/activate` | admin | activate(body: bindingVersionId + expectedActiveBindingVersionId) |
| `POST /scenarios/:id/revoke` | admin | revoke(body: bindingVersionId + replacementBindingVersionId?) |
| `GET /scenarios/:id/binding-versions` | read | 版本历史(status/时间戳/contract_version;**无指纹无键**) |
| `GET /binding-versions/:id/members` | read | member 投影(role + approvedConfigVersionId;**无 system_content_key**) |
| `GET /scenarios/:id/audit` | read | 审计行(闭动作+句柄+时间,无自由文本) |

- **响应投影 allowlist**(构造性 values-free):每路由显式字段白名单;
  `binding_fingerprint`/`baseline_lineage_key`/`system_content_key` 永不序列化(泄漏测试:
  植入可辨识值,断言不出现于任何响应);错误面只闭码,`inferHttpStatus`/`sendError` 既有
  管道。`title` 为用户自命名场景元数据(有界长度),非物料面数据——物料编码/名称/规格
  等在 D2 数据模型中**不存在**,构造性排除。
- **D2 无新增日志/telemetry 面**;如实现中确需诊断日志,按 charter §4.2 闭词表纪律 +
  leak-bait 同刀退出条件(§7 追加行),不得后补。

## 7. 退出条件 → 测试映射(charter D2 行 + §8.2b 相关行;全部同 PR 交付)

**真库通道是本刀新建产物**(对抗验证吸收,P1):plugin-integration-core 现存测试全部
hermetic mock-db,integration-guard 步骤明文「no DB」,plugin-tests.yml 零引用本插件——
**不存在可复用的真库通道**。D2 交付内含:`DATABASE_URL`-gated 真库 CJS harness
(无库则显式 skip 并打印原因,循 describeIfDatabase 语义;唯一租户 id 防共享库夹具冲突)
+ plugin-tests.yml 新步骤(postgres service 下运行)。§1 交付清单同步含此项。

| # | 退出条件(charter) | 测试(真库=本刀新建 harness;合同=CJS 链→integration-guard) |
|---|---|---|
| 1 | 指针 CAS 并发(§8.2b-1) | 真库**构造并发**:两连接 barrier 同刻 activate 同场景 ⇒ 恰一胜出、负者 409 `MR_STALE_ACTIVATION`;禁顺序论证 |
| 2 | 复合 FK 负控(§8.2b-1) | 真库:SQL 直改指针指向他场景绑定 ⇒ PG FK 错;store 层同构造 ⇒ 拒 |
| 3 | revoke 清指针同事务(§8.2b-11) | 真库:revoke 被指版本(无替代)⇒ 单事务后指针 NULL + `revoked`;注入第 5 步后失败 ⇒ 整滚,指针/状态皆不变——不存在「已 revoked 仍被指」可观测窗口 |
| 4 | 替代版本全量重验(§8.2b-16) | 真库:revoke 带 replacement,replacement 的 config 已 retire / 系统身份已漂移 ⇒ **整事务失败**(仅指针不悬空不放行);正控:合格 replacement ⇒ 切换+`activated` 审计 |
| 5 | 跨租户负控 | 真库:B 租户对 A 的 scenario/bindingVersion 全操作 ⇒ 404/403 fail-closed,零写入 |
| 6 | 系统身份就地变更判别(§8.2b-10 Activate 层) | 真库:候选创建后 UPDATE 系统行 `kind` 或 `config` 任一字段 ⇒ activate 422 `MR_SYSTEM_IDENTITY_DRIFT`;正控:未变更 ⇒ 通过;`name`/凭证密文/status 变更 ⇒ **不**漂移(排除面正控) |
| 7 | preflight/activate 间 config retire(§8.2b-2) | 真库:approve 后 retire config ⇒ activate 422 `MR_CONFIG_NOT_APPROVED` |
| 8 | 状态单向 + 无存储 `active`(§8.2b-11) | 合同+真库:全部非法迁移矩阵拒;`status='active'` 直写 ⇒ CHECK 红;store 无任何写 `active` 路径 |
| 9 | member 恰两角色 + 唯一 | 真库:缺角色/重角色/未知角色 ⇒ 拒(store 400 + `uniq_mr_binding_member_role` PG 红双层) |
| 10 | 审计同事务 + 无自由文本 | 真库:每操作后审计行动作/数量精确断言;失败注入 ⇒ 审计行同滚(无孤儿审计);合同:audit 无自由文本字段(D1 已钉,D2 复验响应面) |
| 11 | 三键 goldens + 变异 | 合同:`systemContentKey`/`bindingFingerprint`/`baselineLineageKey` 各 ≥2 组钉死 hex;变异电池:去域前缀/裸拼接(构造跨分量碰撞对)/角色按输入序/排除列混入(name 入键) ⇒ 各红 |
| 12 | flag OFF=404 + 权限矩阵 | 合同:OFF 全族 404;非 `'true'` 字面值(`'TRUE'`/`'1'`)⇒ OFF;权限矩阵(无权/read/operate/admin × 全路由);`integration:admin` **不**通过(OD-V2-3 负控) |
| 13 | internalOnly 零泄漏 | 合同:植入辨识值于三键列,遍历全路由响应断言不出现 |
| 14 | steering 拒绝 | 合同:body/query 带 tenantId/systemId/URL/SQL ⇒ 任何 I/O 前 400 拒绝计数 |
| 15 | 迁移-模板机器对账(§2.2) | 合同:068 SQL 解析 vs D1 冻结模板逐列/逐词表对账 |
| 16 | stock-prep 逐字节不变(§3-6) | 既有 stock-prep 合同测试全绿 + 无 stock-prep 文件 diff(PR 构造性保证) |
| 17 | supersede 正控(拆分测的另一半) | 真库:active=A 时 activate B ⇒ A=`superseded`+`superseded_at` 落戳+`superseded` 审计(与 `revoked`/`revoked_at` 判然两分),指针=B |
| 18 | 跨场景 revoke 逃逸负控(§5.4-3) | 真库:同租户 revoke(scenarioA, B场景的版本) ⇒ 404 `MR_BINDING_VERSION_NOT_FOUND`,零写入 |
| 19 | NULL 指针合法(MATCH SIMPLE 正控) | 真库:新场景指针 NULL 合法;revoke 无替代清指针为 NULL 成功;**MATCH FULL 永不引入**(迁移文本守卫) |

变异纪律:**commit 后 mutate、跑后还原、树干净**(本线两次踩坑已入台账)。

## 8. 错误码闭词表(D2 新增;经 `sendError` 管道)

`MR_STALE_ACTIVATION`(409)/`MR_BINDING_STATE_INVALID`(409)/`MR_CONFIG_NOT_APPROVED`
(422)/`MR_SYSTEM_IDENTITY_DRIFT`(422)/`MR_CAPABILITY_CONTRACT_INVALID`(422)/
`MR_ROLE_SET_INVALID`(400)/`MR_STEERING_REJECTED`(400)/`MR_SCENARIO_NOT_FOUND`(404)/
`MR_BINDING_VERSION_NOT_FOUND`(404)。未知内部错折 500,消息 values-free。

## 9. 实现分工(owner 模型分配指令,2026-07-21)

- **fable5(主循环)**:store 事务核心(§5)、三键派生、路由接线;
- **sonnet5(子代理)**:迁移 068、测试电池 §7 全表、脚手架;
- **opus4.8(子代理)**:本锁对抗验证 + 实现后 refute-first 深审(事务不变量/权限);
- **codex(`gpt-5.6-sol`)**:事务/权限独立复核(charter §7 D2 行建议列;`spark-5.3`
  账号不支持,已实测)。

## 10. Forward ledger(不在 D2,记账防丢)

- D3a:preflight 探测引擎、run-start/commit 重验(§4.5 第 3/4 层)、claim-first dedup +
  `SET LOCAL lock_timeout`、§8.2b-13/14/14b 崩溃注入、**per-source `decimalTransit`**、
  **上游 kind 收敛**(两项 D1 遗留合同记账);
- D3b:六桶(独立设计门);D4/D5:UI;D6:实体机试点;
- scenario 创建审计动作:需 D1 审计词表版本升级,独立小刀;
- `integration_external_systems` create-only 版本化:独立设计门(charter §2.3)。
