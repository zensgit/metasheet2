# 外部 API 读取自助化(数据库及系统连接线)— 开发及验证报告 — 2026-07-02

## 1. 这条线是什么

数据库及系统连接线(data-source & system-integration,#1709)在 2026-06-30 close-out(C3 WebAPI-LIST keyed PASS + C4 BOM read)后,延伸为**外部 API 读取自助化**:把第三方 API **读取**接入标准化为顾问/管理员自助配置能力。核心是 S0 锁定的**两层模型**——配置层(受信顾问:定义端点/模式/键/容器/字段映射,平台保存时校验+版本化+审计)与运行层(终端用户/清洗流:只能选**已审批**预设并提供业务键,永远带不进原始端点/过滤器/请求体/响应路径)。**读取可配置;写/删除保持 owner-gated + sandbox-first,不在本线。**

本报告记录该线从方向锁到全量落地的 as-built 状态与验证证据。至此,**S0→S3 阶梯全部合并,本线开发完成**。

## 2. 阶梯 as-built(9 级,每级独立 opt-in,全部 MERGED)

| 级 | 内容 | PR | 合并 SHA |
| --- | --- | --- | --- |
| S0 | 方向 design-lock:两层模型/保存时校验/凭证引用/values-free 证据/read-only | #3424 | 40fd4bb18 |
| S1 | 配置模型+校验器:四读取模式;`isSafeRelativeReadPath` 皇冠守卫(拒 scheme/协议相对/反斜杠/遍历/全部 %-编码) | #3430 | 138728196 |
| S2 锁 | smoke wizard 设计锁:10 条锁;S2 拆 a/b/c 各自独立 opt-in | #3439 | b4410288e |
| S2-a | probe 契约 + values-free 证据 schema(纯函数;平台固定 5s/10 行常量) | #3445 | efa49a56c |
| S2-b | 固定 locate-container probe 运行时 + 路由(本线首次真实外呼;write 档) | #3466 | 87e0695fb |
| S2-c | 保存版本 + 审计持久化:迁移 062 双表;content-key 幂等 + 家族版本铸造(事务 + 双 UNIQUE 兜底 + 23505 分类);draft→approved→retired fail-closed 状态机;6 条顾问路由 | #3470 | 3c7f4e21a |
| S3-1 | 通用配置驱动读取执行器(纯模块):数据面 fieldMap 抽取;复用 S2-b 出站构造器(单一事实源);resolver_lookup 显式 fail-closed 延后 | #3473 | ba1a636bd |
| S3-2 | 运行层读取路由:`POST /read-source-configs/:id/read`;approved-only;严格 `{inputs}` 体 allowlist;read 档 = S0 运行层 | #3475 | e82deb7de |
| S3-UI | 顾问自助面板(IntegrationWorkbenchView):列表/S1 表单/探测/保存版本/审批/审计;allowlist 证据渲染 | #3471 | 95882baea |

配套基建(本线前置,已在 close-out 前合并):#3416 读取标准化设计锁(四模式)、read-smoke 谱系(#3229/#3231/C1-C4)。

## 3. 安全锁对照(as-built)

S2 设计锁 10 条 × 实际落点:

1. **契约只进 S1 归一化配置** — S2-a `normalizeReadSourceProbeContract` 强制字节归一化(`config_not_normalized`)+ 严格顶层 allowlist;S3-1 复用同一契约;具名输入旁挂、双向 fail-closed(该有没给/不该有给了都拒)。
2. **出站边界** — 仅注册系统解析(后端 `getExternalSystemForAdapter` 凭证上下文);probe/read 执行时都**重跑** `isSafeRelativeReadPath`(纵深防御,拒绝时 adapter 不会被创建);S2-b 路由 `:id`↔config.systemId 一致性在加载系统**之前**检查;host-allowlist 未引入、守卫零放宽。
3. **probe 行为** — locate-container(own-property 点径遍历,原型键永不解析)+ shape 检查 + 可选 bounded smoke;行值/字段键永不出现在证据。
4. **证据 values-free** — 全部出口经 S2-a `readSourceProbeEvidence`(计数/布尔/粗枚举/容器 `{type, arrayLength}`);错误分类只比较 name/code/status;UI 侧再加一层 allowlist 归一化(冻结词表镜像:11 错误码/8 错误类型/8 形状类型)。
5. **持久化只存结构** — 存 S1 归一化 JSONB + systemId 引用 + 版本/状态/审计;永不存解析后 base URL/凭证/probe 响应;审计 detail 仅 `{version}`/`{from,to}` 粗枚举。
6. **content-key 幂等** — 哈希输入=归一化结构(**剔除 version 字段**,systemId 含入、凭证按构造不可能出现);同内容 no-op 复用(200)/异内容铸新版本(201);db.transaction 原子 + (family,content_key)+(family,version) 双 UNIQUE 兜底 + 23505 分类恢复(内容冲突→复用重查;版本冲突→限 3 次重试);retired 同内容 → 409 `content_retired` 显式拒绝。
7. **超时/上限平台固定** — 5s/10 行 S2-a 常量;请求体无此字段(契约拒绝),不可由顾问/终端用户提供。
8. **no-write** — overlay 只加 `operations:['read']`;S1 拒写形键;全链测试断言 upsert/save/submit/audit 零调用。
9. **OUT 项未触碰** — 无写/删除、无终端用户自由表单、无通用框架越界(S3-1/-2 严格限于读取执行)、无 host-allowlist。
10. **授权分层** — 配置面(save/approve/retire/probe)= integration **write** 档;消费面(list/get/audit + 运行层 read 路由)= **read** 档;运行层只能触达 **approved** 版本(draft/retired → 409),无路径触发 probe 或铸版本。

**数据面 vs 证据面(S0 独有约束)** — S3-1 硬分离:映射值只出现在 `data` 字段(且只含 fieldMap 目标列,未映射原始字段被丢弃);`evidence` 恒为 values-free 词表。哨兵泄漏扫描双向锁定(必须出现在 data / 必须不出现在 evidence)。fieldMap 缺失 → `field_map_required` fail-closed(无字段映射即无数据面)。

## 4. 对抗审查(ultracode 多 agent)

三个实现 PR 在合并前各经一轮「多视角审查 → 逐条对抗反驳验证」workflow(review 视角互盲,verify 默认反驳、需给出决定性代码行):

| 对象 | 视角×agent | 确认缺陷 | 处置 |
| --- | --- | --- | --- |
| S3-1 执行器(#3473) | 5 视角,15 agents | 3(resolver_lookup 静默降级为 single_record【major】/数组容器内非对象行伪造全 null 记录/boundedSmoke 证据自相矛盾) | 全部修复+测试锁定(6d138349e→squash 入 ba1a636bd) |
| S2-c 持久化(#3470) | 5 视角,20 agents | 7(版本铸造竞态无事务无兜底【major】/审计非原子/retired 内容静默复用/config.version 双语义污染 content-key/非预期字段名回显 400【values-free 缺口】/迁移测试失锚正则/存储断言缺口) | 全部修复+测试锁定(8c8582d6d→squash) |
| S3-UI(#3471) | 3 视角,9 agents | 5(错误 code/reason 未钳制入 DOM【major】/词表 vs 形状匹配/切换系统残留证据/无斜杠 readPath 致 probe 400/S1 errors 数组丢弃) | 全部修复+测试锁定(add3b3bd0→squash) |
| S3-2 接线(#3475) | workflow 因订阅额度触顶未执行 | — | 人工对照三视角完成(租户 scope 姿态与 sibling 路由一致;错误类平级无 instanceof 遮蔽;防御性 catch 标注;补路由级 kind-mismatch 用例) |

共 15 项确认缺陷,合并前全部修复。UI↔后端契约另做人工逐点对账(路由/camelCase/信封/200-201/scope 传参)通过。

## 5. 验证证据

- **每 PR 门禁**:插件全套件(node 18/20,含新增 5 个测试套件:probe-runtime / config-store / config-migration / read-runtime / 路由套件扩展)、`verify:integration-k3wise:poc`、`pnpm lint`、`pnpm type-check`、CI 全部 required checks;#3473/#3471 各经历一次 BEHIND-required-checks 竞态,按 rebase→等绿→立即合并 SOP 收敛。
- **泄漏扫描矩阵**(测试内嵌):key 值、行值、字段键、host、readPath、凭证、tenant/base id——对成功与失败响应、审计行、错误详情逐一断言不出现;UI 侧 DOM 级泄漏测试(带非法字段的伪造证据/敌意 code/reason 不入 DOM)。
- **并发语义**:23505 双路径(内容键/版本键)模拟测试;乐观 where 状态跃迁;竞态修复经 PG-faithful mock 复现验证。
- **前端**:面板 spec 18/18;既有 workbench 双 spec 79/79 不回归;vue-tsc 走仓库脚本。

## 6. 仍然 OUT(显式,不随本线关闭解锁)

写/删除(C6 dry-run→sandbox→owner 生产门纪律,另一轨道)、host-allowlist 放宽、终端用户自由表单接入、每系统新凭证路径、**resolver_lookup 运行层执行**(选择语义未设计,S3-1 显式 `mode_not_supported` fail-closed,后续单独设计锁)、marker-gating 强制(S1 声明延后)。

## 7. 使用摘要(顾问视角)

注册外部系统(既有)→ 工作台「读取源配置」新建配置(S1 表单,四模式)→ **定位容器探测**(values-free 证据确认容器/形状)→ **保存版本**(幂等,同内容复用)→ **审批**(draft→approved)→ 运行层经 `POST /read-source-configs/:id/read` 以业务键消费,得到 fieldMap 数据面 + values-free 证据。retire 下线版本(approved→retired,运行层立刻 409)。
