# MetaSheet 云课堂 L5 新员工培训开发报告（2026-08-31）

> 状态：DRAFT / HOLD — LOCAL LANDING CANDIDATE，NOT A RELEASE CLAIM
>
> 设计合同：`docs/development/elearning-plugin-design-lock-20260810.md`（§11 L5「新员工自动指派+周报」）
>
> 已验证代码 checkpoint：`f8f29007379d58b70728d7935aec91d353591c95`
>（tree `1a91fbcf4febaa64200f0eb69bd36dafb70917c1`）
>
> 本报告不授权 Ready、merge、feature flag、dispatch、deploy、UAT 或 production。

## 1. 本切片交付

本切片把设计锁中的 L5 新员工培训收成一条默认关闭的纵向产品链：

1. 全局管理员创建、退役 onboarding policy；policy 钉住已发布培训计划，按部门或职位规则匹配，带入职窗口、完成截止日和周报开关。
2. 钉钉目录用户详情可提供规范化 `hire_date`，但只有 `ELEARNING_ENABLED`、`ELEARNING_CONTENT_ENABLED`、`ELEARNING_ASSIGNMENT_ENABLED` 三个 exact-true 条件同时满足时才允许持久化或产生 onboarding 作业。
3. 目录同步激活、成员资格重新激活及 pending-user activation 都在调用方已有数据库事务内 enqueue；权威检查或 enqueue 失败使整个调用方事务回滚。
4. 缺失的权威入职日期只把该用户判为不符合条件，不让整次目录同步失败；已有 `users.hire_date` 永不被 provider 值覆盖。
5. `elearning_jobs` 只承载稳定 occurrence identity；assignment effect 由效果侧唯一键防重，worker 租约重领不产生第二次指派。
6. 周报只保存按组织汇总的计数，人数小于 5 时所有数值保持 `null`，不伪造 0，也不写入个人答案、轨迹或成绩。
7. 管理端提供 policy 创建/退役和周报查看；OpenAPI 使用 closed request/response 与 suppressed/visible 判别联合。

所有云课堂 flag 仍默认 OFF。没有真实租户读取、外部消息发送、部署或生产启用。

## 2. 权威与事务边界

| 边界 | 合同 |
|---|---|
| 组织与操作者 | `org_id`、actor 仅来自认证上下文；policy、计划、成员、job、effect、report 均做 same-org 检查 |
| 目录事件 | 复用目录同步或用户激活的调用方事务；helper 不自行提交 |
| 入职日期 | provider 日期先规范化；只填数据库空值；flag OFF 时不进入持久化参数 |
| 请求幂等 | `(org_id, request_id)` + canonical request hash；同载荷 replay，异载荷 values-free 409 |
| 作业幂等 | `(org_id, kind, occurrence_key)`；worker claim 不是业务防重真相 |
| 指派效果 | 全局 effect identity 唯一；先验证 active same-org principal、policy 和 plan，再写效果 |
| 周报 | immutable aggregate row；小样本阈值固定 5，suppressed 行不保存可推导数值 |
| 降级与错误 | closed code，禁止回显用户输入、组织值、内部 SQL 或 provider 载荷 |

## 3. 提交拓扑

| 顺序 | exact commit | 作用 |
|---|---|---|
| 1 | `031c9ac97e` | policy 与 assignment authority |
| 2 | `f9042c900d` | 周度聚合报告 |
| 3 | `9a035e8187` | PostgreSQL SoR 与迁移权威 |
| 4 | `f61bc65157` | runtime、插件 worker 与窄 port |
| 5 | `1e6a0d39af` | 管理端 Web 产品面 |
| 6 | `31939b184c` | 目录 lifecycle 接线 |
| 7 | `81d0d0fcb5` | lifecycle flag/事务/空日期修复 |
| 8 | `75c4513118` | OpenAPI closed contract |
| 9 | `21f3d489c8` | true-merge `main@25635e67db`，零冲突、产品路径零交集 |
| 10 | `9c910e2404` | development / verification 报告初稿 |
| 11 | `f8f2900737` | shared selector 严格并集、wiring contract 与 provenance 重算 |

最终 merge 的父顺序为：

- first parent：`75c451311809870a8ec177011ace625a9a3012d2`
- second parent：`25635e67db5145a5998499c4adc8f030e156daf7`

相对 second parent 的 onboarding 产品投影为 44 个文件。主线新增的 25 个备料/来源探测文件由 Git 自动并入，没有人工解冲或产品改写。

## 4. 文件面

| 面 | 数量 | 路径 |
|---|---:|---|
| Web 产品与测试 | 6 | `apps/web/src/services/elearningOnboarding.ts`；`apps/web/src/views/ElearningAdminView.vue`；`apps/web/src/views/ElearningOnboardingAdminSection.vue`；三份对应 spec |
| Core 产品 | 12 | activation、directory sync/lifecycle、onboarding migration/route/assignment/policy/report、pilot runtime、plugin type/index 接线 |
| Core unit/real-DB | 13 | onboarding policy/assignment/routes/report/lifecycle/wiring、目录/激活邻接及 `elearning-onboarding.db.test.ts` |
| OpenAPI | 7 | `src/base.yml`、`src/paths/elearning.yml`、focused test 与四份官方生成物 |
| plugin-elearning | 6 | worker、index/package 接线及 onboarding/reminder/stats 三份测试 |

精确文件清单以以下可复现命令为准：

```bash
git diff --name-status 25635e67db5145a5998499c4adc8f030e156daf7..21f3d489c8d376aa656c411bb04b1a9bc285617e
```

在 44 个产品/测试/OpenAPI 文件之外，最终本地候选还包含：

- 6 个 shared CI/provenance 文件：backend unit 与 real-DB 双点接线、Web 双点接线、机械 wiring contract 和官方 provenance pin；
- 2 份本开发/验证报告。

因此 `main@25635e67db..f8f2900737` 的代码与报告文件面共 52 个；其中 shared 提交严格限定为已授权的 6 个路径。

## 5. 明确未完成

1. 当前只有本地 exact-tree 证据；尚无该 onboarding head 的远端 exact-head CI。
2. 尚未 push、创建 Draft PR、转 Ready 或 merge。
3. 所有能力仍默认 OFF；未做真实目录租户、浏览器 UAT、第三方通知、staging 或 production 验收。
4. 本切片只完成 L5 onboarding；不表示 L0–L6 整体完成，也不包含 Time Machine 整表恢复。

## 6. 模型与验证来源

- Codex：唯一 writer；合同收敛、实现、真库验证、main replay 与本报告。
- Sol high：pre-merge 审阅发现 flag OFF 持久化、pending activation、空 hire date 和测试证明力问题；前三项已在 `81d0d0fcb5` 关闭。merge-head 复审超过 bounded cutoff 后被关闭，状态为“无 terminal verdict”，不作为通过依据。
- Luna：shared selector 机械复核超过 bounded cutoff 后关闭，状态同样为“无 terminal verdict”，不作为通过依据。
- Grok 4.6：早期 bounded 只读审阅未在 cutoff 前形成 terminal verdict，不作为通过依据。
- 未调用无真实入口的 Opus 5、Fable 5 或 Sonnet 5，也未虚构其贡献。

## 7. 下一步

1. 对 `f8f2900737` 启动 bounded Sol/Terra/Luna 只读 exact-head 复审，要求已知 P1/P2=0；超时必须据实记录，不阻塞主路径。
2. push 前复核 `origin/main` 仍精确为 `25635e67db...`；若漂移则停止，不自行 replay。
3. 主线稳定时 ordinary push 并创建一个 Draft/HOLD PR，等待远端 exact-head CI。
4. Ready、merge、flag、UAT 与部署继续分别等待 owner 授权。
