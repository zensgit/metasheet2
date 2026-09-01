# MetaSheet 云课堂 L6 线下培训生命周期与报名实施设计（2026-09-01）

> 状态：DRAFT / HOLD — DERIVED IMPLEMENTATION DESIGN, NOT A SECOND DESIGN LOCK
>
> 唯一设计合同：`docs/development/elearning-plugin-design-lock-20260810.md`
>
> 产品代码：`49ea490ade635304db319601d49c7a4a75a06889`
>（tree `a40a875fa67961b9ea63c7bace0b427ce6b99a52`）
>
> PR：#5412（Draft / HOLD）

本文只解释已 ratify 合同中 L6「线下培训」切片的实现边界，不新增或改写合同。它不授权 Ready、merge、feature flag 启用、UAT、dispatch、deploy 或 production。

## 1. 目标与产品边界

本切片实现一个默认关闭的线下培训生命周期：管理员发布不可变培训版本及受邀成员快照，控制培训状态，签发短时动态 QR；受邀学员查看活动、签到/签退，并在发布版本允许时登记或取消报名；管理员查看稳定分页的报名名册。

该能力与既有线上课程闭环彼此独立。它不替代「视频课程发布 → 指派/可见 → 学习 → 考试 → 评分 → 成绩」主路径，也不要求线上培训以线下报名模型作为前置条件。当前产品优先级可继续以线上闭环为主，#5412 保持 Draft/HOLD 不构成阻断。

明确不包含：

- 容量、候补名单与报名审批；
- 助教、讲师排班与日历同步；
- 地图定位、人脸或设备指纹签到；
- 线下结业自动发学分或证书；
- 满意度问卷、混培项目和外部通知投递；
- 任何生产 flag 启用或真实组织数据接入。

## 2. 运行门与权限

- 总闸：`ELEARNING_ENABLED`；
- 独立能力闸：`ELEARNING_OFFLINE_TRAINING_ENABLED`；
- 两者都必须为 exact literal `true`，默认均为 OFF；
- 管理端写操作只接受服务端认证组织与全局 `elearning:admin`；
- 学员端只接受服务端认证的组织与本人 actor；
- 客户端不得提交或覆盖 `org_id`、actor、事件时间、序列号和请求摘要；
- flag 关闭时不创建运行时端口、不访问数据库。

## 3. SoR 与不可变量

### 3.1 生命周期

`elearning_offline_trainings` 是 head；发布内容冻结在 `elearning_offline_training_revisions`，日程目标与受邀成员分别冻结在 revision-owned target/member 行。发布后不原地改写版本内容。

生命周期状态变化写入 append-only 状态事件与请求台账；合法转换由服务端 authority 判定。取消、归档和撤回不通过覆盖历史事实实现。

### 3.2 QR 与出勤

- QR challenge 只保存摘要、上下文、动作和短时有效期；
- token 明文不落库；
- 每个请求使用稳定 request identity，重放返回原结果；
- 同 key 异 payload 返回 values-free conflict；
- 签到/签退事件 append-only，唯一 effect 阻止并发重复；
- 学员必须属于发布时冻结的受邀成员快照，且培训处于允许操作的生命周期状态。

### 3.3 报名

发布版本冻结 `registration_enabled`。报名只允许：

1. 当前组织内有效成员；
2. 命中该 revision 的不可变受邀成员行；
3. 培训处于 active；
4. 该 revision 明确启用报名；
5. actor 与报名用户相同。

报名与取消写入 `elearning_offline_registration_events`，请求摘要写入 `elearning_offline_registration_requests`。两表均禁止 UPDATE、DELETE 和 TRUNCATE；修正通过后续事件表达。请求锁与 effect 锁分离：同 payload 重放收敛为原事件，异 payload 冲突不回显用户值。

### 3.4 名册读取

管理员名册使用稳定 user-id keyset cursor。跨页响应必须保持严格前进；客户端拒绝重复、倒退或形状不闭合的 cursor，不允许静默截断到前 50 行。

## 4. 接口与界面

后端提供 closed-shape 的发布、状态变化、QR、签到/签退、学员列表、报名/取消和管理员报名名册端点。OpenAPI 只公开业务标识、状态和服务端时间，不返回组织内部键、actor authority、request hash、token digest 或原始台账行。

Web 只提供最小管理端和学员端区块：

- 管理端发布活动、管理状态、签发 QR、查看报名名册并继续加载；
- 学员端查看受邀活动、签到/签退、报名/取消；
- 同一逻辑请求在 transport/error 或成功后刷新失败时复用 requestId；
- 只有权威列表刷新收敛后才轮换 requestId；
- 所有技术状态通过现有中英文标签呈现。

## 5. 数据库权威与迁移纪律

迁移采用单一 Kysely TS 流：

- `zzzz20260901100000_create_elearning_offline_training.ts`；
- `zzzz20260901150000_create_elearning_offline_registration.ts`。

迁移 replay 通过 `pg_catalog` 审计列类型/nullability/default、复合外键、唯一约束、check、trigger event/level/timing、函数 OID/source、无 `WHEN`、无 `UPDATE OF`。已有结构不等价时 fail-loud；down 在存在权威事实时拒绝破坏性回滚。

## 6. 验收合同

切片只有同时满足以下条件才可进入 owner 的后续决策门：

1. flag OFF 时运行时无新端口和数据库访问；
2. 跨组织、非成员、非受邀、disabled、archived 等负控全部拒绝；
3. request replay/conflict 与并发 effect serialization 可判别；
4. append-only trigger、迁移 drift、down refusal 有真实 PostgreSQL 反例；
5. Web、OpenAPI、后端 unit/real-DB selector 均进入 required CI；
6. exact-head CI 与独立 refute-first review 无 P1/P2；
7. 任何 Ready、merge、UAT、flag、deploy、production 仍需独立授权。

## 7. 当前处置

产品代码和证据已冻结在 #5412。由于当前业务方向优先收敛线上培训闭环，本切片可保持 Draft/HOLD 作为合同内 L6 研究交付；它的 owner gate 不是线上课程 MVP 的产品阻断。
