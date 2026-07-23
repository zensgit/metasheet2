# 审批、自动化与 Canvas 组合收口设计锁（2026-07-22）

**状态：IMPLEMENTED ON DRAFT STACK #4540 -> #4524 -> #4531 -> #4539 / OWNER REVIEW REQUIRED**

本文锁定两条必须一起验证的产品线：可视化审批 Canvas，以及审批表单/过程/结果写回多维表的数据闭环。
它不授权合并、UAT、部署或 flag 变更，也不把来源 PR 的独立绿灯当成组合态证明。

## 1. 产品验收目标

普通用户无需接触 JSON、节点 key、边 key 或目录对象 id，即可：

1. 在画布上建立串行、条件和并行审批，配置审批人、条件、抄送、字段权限与汇合策略；
2. 查看模板版本差异，把历史版本恢复成新的 draft，并再次通过当前校验；
3. 把独立审批表单值、审批节点确认值和最终结果映射到多维表新记录或受约束的已有记录；
4. 在崩溃、重投和并发执行下维持业务净效果一次，并留下 revision、ledger 和 outbox 证据。

## 2. 权威边界

- `ApprovalGraph` 与后端 normalization/validation 是唯一流程语义；画布、列表和检查器只编辑同一 draft。
- 保存、发布、克隆后编辑和历史恢复都必须经过相同的后端拓扑校验。
- FWB 只走自动化执行链，复用同事务 claim + record mutation + revision + chained outbox；不得新增旁路写入。
- 前端选择器和校验用于可用性，权限、记录存在性、字段类型和映射确认均由服务端重新判定。
- durable、Class A、Class B、FWB、attachments 与 Canvas V2 的默认值保持 OFF。

## 3. 锁定不变量

### 3.1 拓扑与画布

1. 条件分支和并行分支可组合；每条运行时可达的 parallel path 都必须到达声明的 join。
2. 校验按运行时配置边、默认边和真实 fallback 遍历，忽略无配置的 stray edge；前后端规则必须镜像。
3. 空分支、直达 fork-to-join、跨汇合和部分路径遗漏 fail closed，普通错误不泄露内部 key。
4. 画布节点显示业务名称或业务类型；审批人、角色、表单字段和抄送只用 typed picker，不显示原始 id。
5. 鼠标、Enter、Space 和受约束的语义重排必须等价；不提供运行时无法接受的跨区域拖排。
6. 桌面检查器保持窄栏；窄屏改为全宽且自动揭示，不产生页面级横向滚动。
7. 公式条件必须至少依赖表单字段、聚合值、发起人属性或成员关系；纯字面量/无动态依赖公式在创建、更新、
   发布和历史恢复时 fail closed，历史遗留静态公式在运行时不得捕获全部流量。AST 两侧结构完全相同的
   `==`/`>=`/`<=` 比较也按恒真捕获拒绝，历史模板运行时跳过并继续后续/default 分支。对必填数值字段，
   authoring 还须依据已配置的 `min/max` 保守拒绝可证明恒真的比较；无法证明的一律保留，不用采样值猜测语义。

### 3.2 模板版本

1. 已发布版本不可变；恢复历史只能创建新版本，不能覆盖旧版本或切换当前已发布指针。
2. diff/restore 按管理权限、组织、模板 id 和版本归属绑定，拒绝跨模板恢复和 stale restore。
3. 恢复产生的新 draft 必须重新执行当前拓扑、表单和规则校验。

### 3.3 数据写回

1. 仅 approved 且模板版本匹配的实例可执行写回；拒绝、撤回、跳转、超时和半完成节点不得半写入。
2. 新建记录和更新已有记录是显式模式；已有记录只能来自模板固定的 record-link 字段。
3. 保存时验证配置者权限与确认哈希，执行时重查目标记录、锁、目标 schema 和字段写权限。
4. 缺失、越权、锁定和不可写统一为 values-free 的 `linked_record_unavailable`，不得形成存在性 oracle。
5. 映射是 all-or-nothing。隐藏、未映射、未知选项、非法日期或失配字段不得进入记录、日志或错误正文。
6. v1 不开放 number 映射。保存确认、执行新建和执行更新均以 values-free 的
   `exact_number_mapping_unavailable` fail closed；不得把金额、数量或近似数值写成业务事实。数值 envelope
   校验器的存在不等于生产 number 路径可达，D0-D4 仍是独立设计、实现与验收线。
7. record-link 的 submit 与 picker 都必须同时重查 base-read、sheet-read、字段可见性及审批权限；不得因调用
   picker、持有通用 multitable read 或猜中记录 id 而绕过目标 Base 的读取边界。
8. claim、record mutation、revision 与 chained outbox 同事务；重复事件和重复 action identity 不得二次写入。

### 3.4 附件

1. production 只允许 S3；本地存储在 production fail closed 为 503。
2. 每文件 20 MB、每字段 10 个、每次提交 50 MB；SVG/HTML/XML/可执行文件永久拒绝。
3. bind 与 GC 使用对称状态守卫；任何竞态最多留下可回收 orphan，不得留下“引用存活但 blob 已删”。
4. poison-at-claim、fence-CAS、prefix-scoped reconciler 和 object-store 删除都必须有真库正反例。

## 4. 组合纪律

#4510 数据根与 #4433 -> #4538 Canvas 栈重叠 22 个关键文件，包括 `TemplateAuthoringView.vue`、拓扑工具、
`ApprovalProductService`、路由、executor 和 CI run-list。因此二者不能作为“文件不重叠”的独立落地线处理。

Draft #4540 是 Canvas 与数据根唯一经过组合冲突解析的根；#4524 -> #4531 -> #4539 是重排到该根上的唯一 FWB child
序列。来源 PR 可以保留为审阅证据，但不得与 #4540 重复 squash，也不得跳过 child 依赖顺序。
组合解析必须保留：

- 数据线的附件、FWB、typed picker、values-first dry-run 与安全门；
- Canvas 线的共享检查器、运行时路径遍历、版本恢复、导航和语义重排；
- required web 常驻门，以及源码/规格对 `approval-web-guard` 的双路径触发。

## 5. 本轮明确不宣称

- 任意边自由重连、跨条件/并行区域拖排、大图虚拟化；
- 逐节点版本 cherry-pick、三方版本合并；
- 原生移动端 bottom-sheet 编排；
- 所有 number/decimal 写回；当前生产链仅承诺 text、select、date 与 record-link，数值能力须由 D0-D4 独立解锁；
- 真实企业 UAT、生产 flag 开启和运行指标达标。

这些项目需要独立设计锁，不能由本组合 MD 宣称完成。
