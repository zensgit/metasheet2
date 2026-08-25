# 审批明细表 × 多维表互通设计短文(含宜搭子表单对标)

日期:2026-08-25 · **v4(2026-08-26 三次修订)** · 状态:**PROPOSED**(§7 为五个独立裁决包:A/B/C/D1/D2)

> **v4 修订说明**(第三轮外审后 Codex 可执行性修订):①既有六元主账本、唯一索引与共享 helper
> **完全不动**,明细展开只增加逐行溯源子表,撤回 `claim_scope + row_index` 与 M1/M2 索引替换方案;
> ②明细展开新增判别式嵌套来源 `(detailFieldId, childFieldId)`、一次主 claim、整动作同事务、逐行
> 稳定事件 identity 与严格重放核对;③系统行上限固定为服务端权威 `200`,经既有认证 session payload 供 FE 使用,
> 不再写不存在的「FE/BE 共用常量」;④补历史快照 census、XLSX 原始单元格语义、并发/真实下游
> 去重/双明细同子字段 id 等判别门;⑤内部溯源落在新增子表,不虚构目标业务表中的强制列。
> §7 当前建议:A/B 的 v4 合同已可分别提交 owner ratify,C/D1/D2 deferred。
>
> **基线状态(2026-08-26):** #5168、#5169 已合 main;#5141 已关闭为 superseded,不是待办。
>
> **v3 修订说明**(第二轮外审 4 P2):①row_index 延展补全迁移/哨兵/回填/约束/索引重建/旧调用
> 兼容六件套;②系统行上限从「仅导入」扩为保存/发布/播种/手工添加/导入/提交六路径统一强制;
> ③datetime→date 撤销「截断」选项,v1 明确拒绝(防时区造值);④D 包拆为 codec/editor 与行公式
> 两份独立锁。该版「一次删旧索引且旧 helper 不变」与无嵌套来源/逐行事件 identity 的方案已由
> v4 作废。
>
> **v2 修订说明**:外部审阅(REQUEST CHANGES,绑定 v1 head `b3f79e385a`)提出 2 P1 + 5 P2,
> 全部经代码亲验属实并已整合。要点:①FWB v2 幂等键改为**延展既有业务键**而非另立;②FWB v1
> 实际**阻断 number**(exact-number stop rule,待 D0-D4),明细叶子类型实为 **8 种**,「类型天然
> 咬合」为误;③行公式不能直接「沿用审批条件引擎」(其公开合同强制 boolean 结果),且仓内**已有**
> FE-only 行小计派生 `lineDerivation.ts`(#3203 Gate A)须收敛;④FWB v2 不能替代导出;⑤v1.1 须
> 补行数边界合同;⑥**子列显隐已上线**而 v1 误列为待开发(幽灵待办类错误,自记);⑦共享单元格层
> 成本被低估(类型名非直接子集、编辑器内嵌 Yjs/附件/成员协议),v1.2 继承口径收窄为「提交前编辑能力」。

输入:宜搭「子表单」官方文档全文存档(2026-08-25)、FWB0 锁(已 RATIFY)、exact-number 停用规则
(PROPOSED 2026-07-21)、#3203 Gate A 行派生锁、B0-B2 明细/授权线交付(#5142/#5143)。

## 1. 判据:审批明细是「证据」,多维表行是「活数据」

审批实例提交后进服务端**不可变 `form_snapshot`**(FWB 锁 D4 明文依赖)。多维表行是持续演化的
协作状态。两条公理:

- **A1(冻结边界)**:任何互通设计必须保持「提交即冻结」;不存在审批单↔表的实时双向同步。
- **A2(三缝原则)**:关联记录(引用进)、FWB(批准后快照出)、automation 桥(表事件触发审批)。
  新能力必须落在三缝上,不开第四条。

三相成本分析(为何不做「表单内嵌可编辑网格」):提交前 1~20 行/单人/分钟级——嵌千行级协作网格
是阻抗错配;**审批中**要把按节点字段权限(#5143 已交付)投影到按人/角色的表权限——两个权限模型
的乘积,是嵌表方案的真实硬核成本;审批后「数据进表」已被 FWB 解决。宜搭「平铺方式」是表格在
移动端不成立的自供状——嵌网格同样要接这道题。

## 2. 互通通道全景

| 通道 | 方向 | 内容 | 状态 |
|---|---|---|---|
| 关联记录 | 表→审批 | 表单引用表中行;发布时 `assertRecordLinkTargetsReadableByCreator` | ✅ 已上线(单选) |
| 审批桥 | 表→审批 | 表事件自动发起审批(lease 机制) | ✅ 落 main,**旗 OFF** |
| FWB v1 | 审批→表 | 批准后,主表字段建行/经关联记录锚定更新;目标不信客户端。类型:**text/date/select**;**number 被 exact-number stop rule 阻断**(save+execute 双卡,待 D0-D4 服务端精确数值能力,刻意非环境旗) | ✅ RATIFIED+落地,**旗 OFF** |
| **FWB v2 明细展开** | 审批→表 | 明细 N 行→表 N 行 | ❌ §4,delta lock |
| **明细引用桥 v1.2** | 表→审批 | 重明细「先建后审」 | ❌ §5,证据门 |

自动化底盘现成(事件五族、event-fires 租约、durable-delivery、executor 事务守卫);相关旗全 OFF,
启用序列归 P2 线 owner 排期。

## 3. v1.1 原生补刀(轻明细,零架构变化)

范围:①复制行;②上/下移;③删除确认;④xlsx 批量导入到原生明细行(复用仓内 pinned SheetJS,
但使用审批域自己的有界解析 adapter,不直接依赖考勤 UI 模块;公开免登表单禁用导入);⑤序号列。

**行数边界合同(v4 固定数值与传输,审阅 P2-2/P2-5)**:
- 现状:`maxRows` 可不填,服务端仅校验非负整数,**无系统硬上限**;`minRows≥1` 时发起页初始
  仍播种空数组(不自动出首行)。因此部署前须只读 census:全部已存草稿/已发布版本中
  `minRows/maxRows > 200` 的字段,以及全部非终态实例/已存发起草稿中明细行数 `>200` 的快照。
  任一非零先出 owner disposition,不得用上线时静默截断修数。终态历史快照保持不可变;B 包启用前
  另按可能命中明细展开规则的批准快照做 census,不能把 A 包的非终态 census 冒充 B 包证据。
- **唯一权威值:**后端域模块导出 `APPROVAL_DETAIL_MAX_ROWS = 200`;复用现有认证
  `/api/auth/me` session bootstrap 的 `data.features`,在同一个 `buildFeaturePayload` 中增加
  `{ approvalDetailV11: boolean, approvalDetailMaxRows: 200 }`。不新建
  `/api/approvals/capabilities` 路由,避免被既有 `/api/approvals/:id` 参数路由遮蔽,也避免页面再发一条
  可独立失败的请求。Web 不定义第二个数字或另读一份旗,只从同一 session payload 同时取得开关与
  上限;payload 缺失/畸形时把 v1.1 视为关闭,不猜默认值。该 payload 只承载静态能力,不扩大模板/
  实例 ACL。提交终检始终直接使用后端常量,不信客户端回传。
- **模板合同:**作者显式写 `maxRows > 200` 时保存/发布均拒绝,不静默 clamp;省略 `maxRows` 时
  生效上限为 200;否则生效上限为显式 `maxRows`。`minRows/maxRows` 必须是非负安全整数且
  `minRows <= effectiveMaxRows`。
- **六路径统一:**①模板保存、②发布、③**新实例且无已存草稿**时真实播种恰 `minRows` 个独立
  空行(`minRows=0` 不播种;加载旧草稿绝不暗加行,只提示缺口)、④手工添加到限即禁、⑤ xlsx
  导入后总行数超限则**整批拒绝**(不追加、不截断)、⑥服务端提交按每个明细字段的生效上限终检。
  前五道是 UX/早拒,第六道才是权威合同。
- **发布与回滚:**能力置于新旗 `APPROVAL_DETAIL_V11_ENABLED` 后,exact-literal `'true'` 才显示/启用;
  旗登记全域 manifest,默认 OFF。旗 OFF 时既有保存/提交行为逐字节不变。census 清零或完成定点处置
  后才可在 staging 打开;回滚只关旗,不得删改用户已录入或已经提交的明细行。

**导入与行操作合同:**xlsx 只在浏览器 Worker 中解析,服务端不接收工作簿;扩展名只收 `.xlsx`,
文件上限固定 `10 MiB`,只读首个非空 sheet,并以 `sheetRows=effectiveMaxRows+2` 探测超限。Worker
超时或异常即终止并整批拒绝。这里承诺的是「文件字节 + 物化行数 + UI 线程隔离」,**不虚称仓内已有
zip-bomb 证明**。实现复用 pinned SheetJS 依赖,但不得复用考勤视图模块或多维表会把所有单元格
字符串化的 `parseXlsxBuffer`。

xlsx 必须显式把文件列映射到本明细字段的 child id,不按同名标题猜绑定;同一 child id 不得被两列
重复映射,且 adapter 在转换前保留原始单元格类型。v1 拒绝公式单元格(不信可能过期的 cached value),
导入 text/textarea/number/date/datetime/select;user 与 multi-select 没有无歧义
的文件语法,明确拒绝。date 只接收**文本单元格**中的严格 `YYYY-MM-DD`;datetime 只接收带 `Z`
或显式 offset 的 RFC3339 文本;Excel 日期序列、区域格式日期和无时区时间全部拒绝,不推断时区或
制造日期。number 只接受有限 JS number 或能无损转成现有审批 number 合同的规范十进制文本;
select 只接受配置中的稳定 option value,不按显示名猜值。错误报告仅给文件行号、目标列与错误码,
不回显业务值。

解析、映射、逐格校验全部成功后才以一次不可分状态替换追加到当前草稿;任一格错误、超时或超限都
整批零修改。复制生成独立行对象(后续编辑不联动原行);移动只改变顺序;删除须确认且不得突破
`minRows`;导入/复制/新增都经过同一个 `effectiveMaxRows` 判定。v1.1 的行动作是复制/上下移/
删除确认的**固定闭集**,系统内置;「自定义操作列」(模板作者自配动作/绑定回调)仍**不做**(§6a)。
两者不是一回事。

### 3.1 v1.1 验证门

1. `buildFeaturePayload`、保存/发布/提交三处都读取同一服务端常量;中和任一服务端上限调用点时
   其指定测试变红。approval-detail FE 模块不得定义独立数字上限,只能消费 `/api/auth/me` 的 session
   payload;不得新增会被 `/api/approvals/:id` 遮蔽的静态能力路由。
2. 省略 max、显式 200、201、`minRows=201`、`minRows>maxRows`、旧模板/发布版本/非终态快照
   超限 census 均有正负例;
   session payload 缺失或畸形时新增/播种/导入不可用,已有输入不被清空。
3. `minRows` 首次载入恰播种 N 个互不共享引用的行;复制后修改副本不改原行;上/下移、删除确认、
   minRows 禁删和到限禁加均有 mounted spec。
4. xlsx 显式映射、重复映射拒绝、公式单元格拒绝、全批成功、任一行错误整批零修改、导入后总数
   200/201、user/multi-select 拒绝、10 MiB 边界、Worker 超时、加密/损坏/空文件、date/datetime
   原始类型与时区负例均有判别测试;
   把日期序列或区域日期改成接受时对应测试必须红。
5. mounted spec 同时进入 approval web guard 与 `run-required-web-tests.sh`;在 1440/1024/390 真浏览器
   验证表格横向滚动、行操作和键盘等价路径。旗 OFF 截图与当前 main 一致。

## 4. FWB v2:明细行展开投递(审批→表)

一单中**一个指定明细字段**的 N 行 → 目标表 N 行。既有动作新增
`mode: 'create_detail_rows'` 与 `detailSourceFieldId`;不允许两个明细字段按位置 zip,也不允许笛卡尔积。
该 mode 只有 `APPROVAL_FWB_DETAIL_EXPANSION_ENABLED=true` 才能保存/启用/执行;旗 OFF 时 fail closed。
当前 main 的 `parseFwbWriteMode` 对未知 mode 已是拒绝语义,因此回滚到功能前镜像也只会拒绝该动作,
不得把它降级为旧 `create` 并误写一行。N=0 仍获取一次动作级主 claim,但写 0 个业务行、revision、
逐行溯源和 outbox;完整重放返回 `already_applied`。

### 4.1 来源寻址与类型矩阵

现有 `FwbFieldMapping.formFieldId` 只会读 `formValues[formFieldId]`,不能寻址
`formValues[detailFieldId][rowIndex][childFieldId]`。v2 把映射来源改成判别联合,旧形状仅作兼容输入:

```ts
type FwbMappingSource =
  | { kind: 'form_field'; fieldId: string }
  | { kind: 'detail_cell'; detailFieldId: string; childFieldId: string }
```

- 旧 `formFieldId` 在读取时规范化为 `form_field`,保存后仍可保持旧载荷字节等价;新明细动作必须写
  显式 `source`。`detail_cell.detailFieldId` 必须等于动作的 `detailSourceFieldId`。
- 规则保存/启用在**固定的已发布模板版本**上验证两级 id、字段类型和归属;child id 只在所属明细字段内
  唯一,因此禁止只存 `childFieldId`。execute 从实例的不可变 `form_snapshot` 逐行读取,并再次核对
  pinned template version;不得读取当前可变草稿 schema。
- 同一映射可引用顶层字段(每行重复)或该明细行的 child 字段;不能引用其他明细组。确认哈希覆盖
  `mode + detailSourceFieldId + 完整 source 联合 + target + sourceTemplateVersionId`。
- 源叶子 8 类(text/textarea/number/date/datetime/select/multi-select/user),目标闭集为
  text/date/select(number 待 D0-D4)。v1 矩阵:text/textarea→text;date→date;select→select,且
  选项使用 execute-time 目标闭集;datetime、multi-select、user、number 及其他所有格子明确拒绝。
  datetime 不截断,避免制造带时区语义的日期。

### 4.2 主 claim 不变,逐行溯源用 additive 子表

既有 `meta_fwb_action_applied`、六元业务键
`(instance_id, rule_id, action_key, node_key, entry_epoch, application_mode)`、
`uq_fwb_action_applied_business_claim` 与 `claimActionApplied` 的 INSERT/显式六列 `ON CONFLICT`
**逐字节不动**。明细动作仍只 claim 这一个动作级父行;`action_key` 已覆盖 action type 与完整规范化
config,所以其中自然包含 `mode/detailSourceFieldId/mappings/sourceTemplateVersionId`,不会与旧 create/
update 动作共域。v1 的 `(instanceId,rowIndex)`、v3 的七列索引与 v4 初稿的
`claim_scope + row_index`/M1-M2 方案全部作废。

新增单向溯源表,不替代主账本:

```sql
CREATE TABLE meta_fwb_detail_row_applied (
  action_claim_id text NOT NULL
    REFERENCES meta_fwb_action_applied(id) ON DELETE RESTRICT,
  row_index integer NOT NULL
    CONSTRAINT fwb_detail_row_applied_index_nonneg CHECK (row_index >= 0),
  target_record_id text NOT NULL
    CONSTRAINT fwb_detail_row_applied_record_nonblank CHECK (target_record_id ~ '[!-~]'),
  event_id text NOT NULL
    CONSTRAINT fwb_detail_row_applied_event_nonblank CHECK (event_id ~ '[!-~]'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_fwb_detail_row_applied PRIMARY KEY (action_claim_id, row_index),
  CONSTRAINT uq_fwb_detail_row_applied_event UNIQUE (action_claim_id, event_id)
)
```

- `row_index` 的 DB 约束只表达身份域的非负整数,**不把产品上限 200 编进持久化 schema**;200 由
  A 包服务端合同和 B 执行前终检负责,避免日后改上限需要改证据表。
- 父表 `result_ref` 不塞 JSON/ID 列表,可以保持 NULL;每个目标记录和事件的可追溯标识只存子表,
  仍然 values-free。`event_id` 不做全局 UNIQUE;项目既定合同允许不同 consumer/event type 语境下
  的稳定 id,这里仅强制同一父 claim 内每行不同。
- 迁移只有一次 additive create。上线前验证「表不存在或精确同形」,同名漂移对象 fail closed;
  旧镜像和 FWB-1/2/3 不读该表,因此迁移前后行为不变,无需删旧索引、replica census 或代码回滚下限。

### 4.3 一次父 claim、整批事务和严格重放

所有来源/类型/权限/目标字段、固定模板版本、逐格映射和 `N <= 200` 在第一笔写前完成。随后在
**同一个数据库事务**调用原 `claimActionApplied` 一次:

- `claimed`:按冻结顺序写 N 个 record、N 个 revision、N 个逐行溯源和 N 个 outbox。任一位置失败,
  包括第 k 行 record/revision/provenance/outbox,父 claim 与全部子写一并回滚;不存在可提交的部分态。
- `duplicate`:不得使用本次竞争者新生成而未落库的随机 `claimId`;必须用同一六元业务键 SELECT 已提交
  父行的 `id`,再读取其子表,并要求 row index **集合**精确等于 `0..N-1`(不能只比 count,`{0,2}`
  不是两行成功)、
  每行 `event_id` 等于本次纯函数推导值、`target_record_id` 非空。完全相等才返回
  `already_applied`;缺行、多行、错 event 或父行无子证据均以 values-free
  `fwb_detail_provenance_mismatch` 终止并走 required alert,绝不补写或重发。
- N=0:首次事务只留下父 claim;重放要求该父 claim 的子行集恰为空。这样 no-op 也有稳定审计身份,
  而不是每次都重新「成功」。

默认 PostgreSQL `READ COMMITTED` 下,竞争者的 `ON CONFLICT` 会等待赢家提交;duplicate 分支随后必须
用一条**独立** SELECT 取得新 statement snapshot,才能读取赢家同事务提交的完整子行。若未来改变
事务隔离级别,必须先有
等价并发证明。两个 worker 同抢时只能一个得到 `claimed`;赢家回滚则等待者可成为新赢家,赢家提交则
等待者只能走上述严格 replay。禁止 per-row claim、per-row commit 或失败后仅补剩余行。

### 4.4 逐行事件 identity 与溯源

现有 FWB 的 action 级 event id 不能供 N 行共用:automation event-fires 与 webhook 都会按 event id
去重。新增纯函数 `deriveFwbDetailRowEventId(fwbActionEventId, rowIndex)`,其第一参数必须是 executor
已经构造的 action-scoped `fwbEventId`(已含 base event、rule 与 actionKey),**不是裸 completion
event id**。函数使用域分隔、注入式 JSON 编码后 sha256,输出固定 printable-ASCII 形状
`fwb_detail_row_<64hex>`;禁止 attempt/fence/timestamp/random 进入 seed。同一冻结行跨重试得到同一 id,
不同行、不同 rule/action 得到不同 id。

每行 outbox 使用自己的派生 id,同一个 id 同时写入子表;真实下游测试必须证明两行产生两个
event-fires/两个 endpoint effect,完整重放不新增 effect。系统内部溯源由父账本六元业务键 +
子表 `(row_index,target_record_id,event_id)` + instance 指向的固定 template version/form_snapshot
构成;**不强制目标业务表存在名为 provenance 的列**。若产品需可见溯源列,作为普通显式映射另立
范围,不能伪装成当前已存在能力。重提产生新 instance,只追加新行,不更新旧实例产生的目标行。

### 4.5 验证门(缺一不可)

1. **Additive upgrade:**PG15 真库从旧 schema+旧父行执行唯一迁移;迁移前后原六列 helper 的首次
   claim/重放结果与 SQL 逐字节不变。子表 FK、非空、负 index、同父重复 index/event 分别按命名
   约束拒绝;同名漂移表必须让迁移失败,不能被 `IF NOT EXISTS` 吞掉。
2. **Parent claim/replay:**N=0/1/200 首次与重放均构造;两个 worker 同抢同一 N 行只能得到一个
   完整赢家。删除任一严格 replay 核对(行集/event/record id)时指定 corruption golden 必须红。
3. **Nested mapping:**两个明细字段复用同一 child id,只读取指定组;不存在/跨组/类型漂移在
   rule-save/rule-enable/execute 三时点 fail closed。顶层字段重复到每行有正控。
4. **Atomicity:**第 k 行 record/revision/provenance/outbox 四类故障逐一注入后,父 claim、N 类业务行、
   revision、子证据和 outbox 全部为 0;不存在「补剩余行」路径。
5. **Event identity:**两行→两个不同 outbox event id→真实 durable adapter→两个下游效果;
   同一 action 全量 replay→零新增效果。把 seed 退回裸 completion event 或所有行共用 action id
   时对应测试必须红。
6. **Cap/rollback:**execute 对 201 行在 claim 前拒绝;B 激活 census 覆盖可能命中规则的历史批准
   快照。旗 OFF 与功能前 main 对 `create_detail_rows` 都 fail closed,不得 fallback 到 create。
7. **Legacy:**FWB-1/2/3 现有真库套件数量不减;主表 migration/helper/index 无 diff,旧调用载荷与
   flag-OFF 行为逐字节不变。
8. **CI:**后端真库 spec 进入 `test (20.x)` 明确 run-list;新 mounted FE spec 同时进入
   approval web guard 与 `run-required-web-tests.sh`;不得以新文件默认发现作门控证据。
9. **事务预算:**在 staging 同款 PG15 镜像上构造 200 行、每行 record+revision+provenance+outbox 的
   整事务正控与中段失败回滚;记录 p95 和锁等待。若超出既有 executor/请求超时预算,激活前只能由
   owner 下调同一个服务端上限并重跑 A/B census 与全部边界测试,不得以 per-row commit 绕过原子性。

**定位:**FWB v2 是**批准后的分析/联动路径**,不是导出替代——它不覆盖草稿/驳回实例、不产出
Excel 文件、无回导。文件级导出(含主+子一并导出、编辑后回导)为独立缺口,是否立项见 §7-A。
新旗 `APPROVAL_FWB_DETAIL_EXPANSION_ENABLED` 默认 OFF、exact-literal `'true'`,登记全域 manifest;
启用前要求既有 durable/FWB 旗已通过各自 UAT、additive migration 已应用、B 历史快照 census 已
清零/逐项处置且 §4.5 merged-main 全绿。

## 5. v1.2 明细引用桥(表→审批,重尾场景)

形态不变:行先活在受治理多维表 → 表侧选中行发起审批 → 关联记录**多行模式**引用 → 提交时
**按行投影快照**进 form_snapshot(A1 保持)→ 批准后 FWB 照常。增量:关联记录多行化、行投影
快照、表侧发起入口。

**继承口径(v4 延续 v2 收窄结论)**:v1.2 使**提交前的编辑能力**自动继承表的更新(新列类型/
导入/AI 填充在编辑阶段全额可用);**提交后一切仍受 A1 冻结**,表的后续演化不改已冻结快照。
「自动继承全部未来更新」的旧表述作废。

**证据门(不变)**:出现真实重明细审批用例(>50 行或需协作预填/导入)前不开工。

## 6. 宜搭子表单逐项对标(v4 修正版)

| 宜搭能力 | 处置 | 依据 |
|---|---|---|
| 子字段类型/必填/选项、行删除、min/max 行数 | ✅ 已有(8 叶子类型) | detailField.ts;系统上限仍待 §3 实现 |
| 焦点稳定编辑 | ✅ 已有 | #5142 row-key |
| **按主表值/行内值控制子列显隐** | ✅ **已有**(v1 误列待开发,更正) | `visibleDetailColumnsForRow` 按行求值 + `pruneHiddenDetailRow` 提交前剪枝——看不见的不提交 |
| 行内计算列(小计) | ⚠️ **部分已有**:`lineDerivation`(#3203 Gate A)——FE-only、仅 product、backend 不校验不重算、声明坏则退化普通列 | 通用行公式=独立锁,§6b |
| 金额合计自动求和 | ⚠️ 已有但**限 amountConsistencyCheck 预置模板**,非通用可配 | 通用化另立小项,不并入 A |
| 草稿宽/发布严、按节点字段权限作用于明细 | ✅ 已有,反超项 | B0/#5143;宜搭无工作流节点级权限 |
| 复制行/上下移/删除确认/序号列/仅一条禁删 | → **v1.1** | 固定闭集行动作 |
| 批量导入(含免登禁用) | → **v1.1**(边界合同前置) | §3 |
| **Excel 导出/主+子一并导出/回导** | ❌ **独立缺口**(v4 延续 v2 更正:不由 FWB v2 覆盖) | 另立裁决,不并入 A |
| 报表分析、批后数据联动 | → **FWB v2**(批准后路径) | §4 |
| 大批量/多人协作预填 | → **v1.2**(证据门) | §5 |
| 平铺方式+折叠(移动端) | 不做;移动端另行实测原生明细 | §1 |
| 主题/斑马纹/列冻结/列宽/分页 | 不做 | 平台税;≤20 行无需 |
| 自定义操作列/回调/定制渲染 | 不做(声明式等价见 §6a) | 逃生舱=真表 |

## 6a. 宜搭「高级功能」处置(v4 修正)

其高级三件套本质是用户 JS:①任意代码进每个审批人浏览器=新攻击面;②证据问题——审计须答「批的
那一刻跑的哪版代码」;③养护。声明式等价映射:

| 用户实际要什么 | 我们的声明式等价 | 状态 |
|---|---|---|
| 按值控制子列显隐 | `visibleDetailColumnsForRow`+提交剪枝 | ✅ **已上线**(v1 误列,更正) |
| 行内计算列 | lineDerivation 已有(限 product/FE-only);通用行公式=独立锁 | ⚠️ 部分/§6b |
| 子列明细内唯一 | 声明式开关 | → v1.1.5(小) |
| 行数统计入表单字段 | min/maxRows 已有;联动=小加法 | → v1.1.5(小) |
| 操作列固定闭集动作 | 复制/上下移/删除确认 | → v1.1 |
| 定制渲染 | 不做;等价物=补充叶子类型 | — |

## 6b. 回传/JS 实况与行公式的真实路径(v4 更正)

- **回传:有且治理过**——`wait_for_callback`:持久化挂起(suspension row + suspended job),
  resume 跑尾段;legacy fail-closed。**用户 JS:无,系设计立场**(executor 无 eval;可编程性=
  16 动作闭集+公式字段+按钮+AI 字段)。
- **行公式不能写「沿用审批条件引擎」**(v1 表述作废):`ApprovalConditionFormula` 公开校验/执行
  合同**强制最终结果为 boolean**(内部虽可算数值)。且仓内已有 `lineDerivation`(FE-only、仅
  product、backend 不重算)。通用行公式=**独立 delta lock**,至少定:服务端权威重算、精度/舍入
  (与 exact-number D0-D4 线的关系)、错误语义(公式错→行怎么办)、快照语义(存值还是存式+值)、
  **与 lineDerivation 的收敛路径**(取代或扩展,不允许第三套并存)。
- 三公式引擎事实不变(`formula/engine.ts`、`multitable/formula-engine.ts`、条件公式),语法/限额
  对齐为长期项。

## 6c. 「超越」可证伪判据(v4 修正)

已反超(已交付+已验证,**七项**):按节点字段权限作用于明细、草稿宽/发布严、**子列按值显隐+提交
剪枝**、row-key 编辑正确性、每字段行数上限、不可变快照证据语义、行小计派生(限 product,带状态
注记)。金额自动求和降为「限预置模板」注记项。今天仍落后:复制/排序/删除确认、批量导入、
**文件级导出/回导**、移动端平铺、列冻结/列宽。刻意不对齐:用户 JS/定制渲染。

| 门 | 内容 | 过门后可主张 |
|---|---|---|
| S1 | v1.1 落地过门审 | ≤20 行场景**录入效率轴**打平+七项特有优势(**导出轴除外**) |
| S2 | 钉钉嵌入端移动渲染实测 | 超越主张无「平铺」豁口 |
| S3 | FWB v2 落地 | 批后明细自动进表——类别级差异 |
| S4 | v1.2 过证据门落地 | 毕业路径闭环——结构性超越 |

若未来独立的「文件导出/回导」切片立项并落地,S1 才恢复全轴口径;否则 S1 永久携带导出除外注记。
四门全过前,对外口径限于「对标中,七项已反超」。

## 6d. 能力继承通道与「从表取数」(v4 修正)

**继承通道**:
1. **v1.2 引用桥**=唯一自动通道,口径收窄为**提交前编辑能力**(§5)。
2. **共享单元格层(v4 延续「先抽合同」结论)**:审阅证实成本被低估——类型名**非直接子集**
   (审批 text/datetime/user vs 表 string/dateTime/person),且 `MetaCellEditor` 内嵌 Yjs 协同、
   附件、成员、关联记录协议,直接换组件=把表的运行时协议拖进审批表单。正确的第 0 步是抽
   **域中立的 codec/editor contract**(类型名映射表+纯值进出+无协同依赖),两域各自适配;
   是否值得抽,作为独立裁决(§7-D1)。
3. 类型注册表子集约定:保留,但以上述映射表为前提(名字都对不齐谈不上子集)。
4. 网格级能力永不继承。

**从表取数(表→明细行,值拷贝,A1 保持)**:
- (a) copy-in 多选导入:picker 多选化+列映射+服务端取值端点。量级:中。
- (b) 行级引用+伴生列:填单中可刷新,提交冻结为拷贝。量级:中-大。
- 安全底线:服务端以发起人身份过表 ACL;发布时目录校验;跨 org 不通。

## 7. 待 owner 裁决(v4:五个独立裁决包)

**A. v1.1 录入效率包 — 建议 RATIFY v4。**裁决面收窄为:①系统硬上限固定 **200**、
既有 session payload 传输与六路径合同按 §3;②复制/上下移/删除确认/序号列/xlsx 导入/minRows 播种开工;
③新旗默认 OFF,census 非零先逐项处置;④钉钉嵌入端 390px 真浏览器实测为 staging 激活前置。
**不并入 A:**文件导出/回导、通用金额求和,两者各自立项,不让小包膨胀。

**B. FWB v2 delta lock 包 — 建议 RATIFY v4。**裁决面为:①单一 detailSourceFieldId +
判别式来源;②既有六元父 claim/helper/index 零改动 + additive 逐行溯源表;③一次父 claim、N 行同事务、
严格 replay(含 N=0);④以 action-scoped FWB event 为父种子的逐行稳定 event id;⑤逐格类型矩阵;
⑥新实例只追加;⑦历史批准快照 census 与旧镜像 unknown-mode fail-closed;⑧§4.5 九道验证门。
任何一项写成「实现时再定」都视为未裁。owner 未逐项接受前仍为 PROPOSED,不得开实现旗。

**C. v1.2 引用桥包 — 建议 ACCEPT AS DEFERRED。**保留 `>50` 行或多人协作预填/导入的真实
证据门;确认继承只发生在提交前,不授权实现、不新开旗。

**D1. 共享编辑层包 — 建议 DEFER。**出现两个真实消费者并完成不含 Yjs/附件/成员协议的
bounded spike 前,不抽域中立 codec/editor contract。

**D2. 行公式包 — 建议 DEFER。**exact-number D0-D4 与服务端权威重算/舍入/错误/快照/
`lineDerivation` 收敛五项没有独立锁前,不实现第二套通用行公式。

不裁即维持现状:A1/A2 公理、三缝、拒绝用户 JS、C 的证据门四项为本文保留立场,不随裁决变动。
本文件仍是 PROPOSED,自身无 ratify 权;A/B 必须分别记录 owner 裁决,不得以合并文档代替 ratify。
