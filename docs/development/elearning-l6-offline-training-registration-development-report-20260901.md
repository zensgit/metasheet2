# MetaSheet 云课堂 L6 线下培训生命周期与报名开发报告（2026-09-01）

> 状态：DRAFT / HOLD — IMPLEMENTED AND VERIFIED, NOT RELEASED
>
> 设计合同：`docs/development/elearning-plugin-design-lock-20260810.md`
>
> 实施设计：`docs/development/elearning-l6-offline-training-registration-design-20260901.md`
>
> 产品 head：`49ea490ade635304db319601d49c7a4a75a06889`
>（tree `a40a875fa67961b9ea63c7bace0b427ce6b99a52`）
>
> PR：#5412（OPEN / Draft / HOLD）

本文是 report-only 载体。报告提交不修改产品、测试、迁移、OpenAPI、workflow、selector 或 provenance 内容。

## 1. 交付结果

本轮形成一个默认 OFF 的 L6 纵向切片，覆盖：

- 不可变线下培训版本、日程目标和受邀成员快照；
- 发布、active/archived 等生命周期 authority；
- 动态 QR、签到/签退 append-only 证据；
- 报名开关、学员报名/取消和管理员稳定分页名册；
- 后端 service/PG adapter/route/runtime；
- 最小管理员与学员 Web 界面；
- closed OpenAPI；
- unit、real-DB、Web、required selector、flag manifest 与 provenance 接线。

该结果不改变线上培训主链，且不要求合并后才能继续线上课程验收。

## 2. Exact topology

| 项 | Exact value |
|---|---|
| PR base | `bcd5c300ec515bb613fa9cb866544ff624cf5b5c` |
| 产品 head | `49ea490ade635304db319601d49c7a4a75a06889` |
| 产品 tree | `a40a875fa67961b9ea63c7bace0b427ce6b99a52` |
| base-relative commits | 9 |
| base-relative files | 43 |
| PR state | OPEN / Draft / MERGEABLE / CLEAN |
| auto-merge | disabled |

九个提交按父链顺序为：

1. `f736e12c9` — attendance authority；
2. `b21ca1e1a` — Web surface；
3. `a49652e68` — current-main ancestry replay；
4. `a737997a5` — runtime pre-gate；
5. `d066add31` — OpenAPI；
6. `341784158` — CI selector union；
7. `bd76167fe` — attendance authority hardening；
8. `d8e416095` — audited lifecycle；
9. `49ea490ad` — registration vertical slice。

主线 base 是产品 head 的真实祖先；没有 force-push、squash 或伪造空 merge。

## 3. 文件范围

43 个 base-relative 文件按表面归类：

| 表面 | 内容 |
|---|---|
| Backend product | flag、两条迁移、service/PG adapter、route、pilot runtime/index wiring |
| Backend tests | 5 个 unit/neighbor 文件与 2 个 real-DB authority 文件 |
| Web product | client、admin/learner view 与标签 |
| Web tests | 3 个专属 spec 与 2 个邻接 view spec |
| OpenAPI | 2 个源文件、3 个 dist、SDK declaration 与 focused test |
| CI/shared | plugin-tests、vitest exclude、Web 双点 selector、wiring contract、flag manifest |
| Provenance | 官方 helper 生成的 sealed-export package pin |

没有新增 package、lockfile、外部服务或生产配置。

## 4. 关键实现

### 4.1 生命周期与出勤

管理员发布冻结 revision、目标窗口和受邀成员；状态变化、QR issuance、签到/签退均通过服务端 authority 写 append-only 台账。QR token 只返回一次，数据库只存 digest。请求重放与业务 effect 去重由不同 identity 承担。

### 4.2 报名

`registration_enabled` 进入发布快照。学员只能为本人、在同组织有效成员且命中受邀成员 revision 时登记；active/disabled/archive 负控 fail-closed。事件与请求台账不可改写，管理员名册通过稳定 user-id cursor 遍历全部结果。

### 4.3 客户端重试

Web 对 command 使用 payload-bound requestId：

- 同 payload 的网络或可重试失败复用；
- 服务端成功但权威列表刷新失败时仍复用；
- 只有列表状态收敛后才轮换；
- payload 变化立即换 identity。

### 4.4 租户与 DTO

组织、actor、事件时间和 authority 均来自服务端认证上下文。响应 parser closed-shape；OpenAPI 不公开 request hash、token digest、内部组织键或原始事件行。错误保持 values-free。

## 5. 模型与审阅来源

- Codex：唯一 writer、数据库/客户端 mutation、exact-head refute-first 审阅和本报告；
- 协调任务：PR/base/head/CI 终态独立回读；
- 本切片没有可核实的 Opus 5、Fable 5、Sonnet 5、Grok 4.6 或 Kimi K3 写入贡献，因此不虚构模型记录。

最终产品 head 的独立结论：P1=0 / P2=0 / P3=0。

## 6. 当前发布状态

| 动作 | 状态 |
|---|---|
| 产品实现 | 完成并冻结 |
| 本地 focused/required/real-DB 门 | 完成 |
| 产品 exact-head CI | 47 SUCCESS + 1 intentional SKIP |
| PR | OPEN / Draft / HOLD |
| Ready / merge | 未授权、未执行 |
| feature flag | 默认 OFF、未启用 |
| UAT | 未执行 |
| dispatch / staging / deploy | 未授权、未执行 |
| production / real tenant data | 未触及 |

## 7. 剩余边界

本切片不包含容量、候补、审批、助教、日历同步、地图、人脸、自动结业学分/证书、问卷或混培。产品当前优先收敛线上培训闭环；因此 #5412 的 owner gate 只决定该 L6 扩展是否落地，不阻断线上课程发布、学习、考试、评分和成绩验收。
