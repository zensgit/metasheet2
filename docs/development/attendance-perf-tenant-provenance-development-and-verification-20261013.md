# 考勤导入性能验收：租户校验与源码来源绑定 — 2026-10-13

状态：本轮授权的实现、Mac mini 测试、独立复核及合成运行验收已完成。重放后的 `validate:all` exit 0。本轮未部署，未修改运营环境配置，公开发布尚未授权。

## 问题与行为

原性能消费者刷新 token 后仅检查用户标识，没有重新验证服务器返回的租户；性能 workflow 虽绑定组织，却没有要求后端运行版本。真实子进程 HTTP 复现中，错误租户、缺失源码身份、错误源码身份均能执行五个导入操作并生成成功 summary。

本次在导入消费者入口和每次认证请求尝试前验证精确租户及后端源码身份；刷新候选先验证后采用，所有 `ACCEPTANCE_*` 失败沿重试、异步轮询、恢复、读回及回滚路径终止，不生成成功 summary。重试使用当前已验证 token 的 Authorization。绑定模式拒绝重定向。

- 三个绑定选择器全部未定义，保留原本本地未绑定兼容行为。
- 任意选择器存在（含空字符串），必须完整提供合成组织、相同 ORG_ID、相同期望租户以及完整小写 40 位预期后端 SHA。部分配置不能降级为未绑定。
- `checkoutSha` 从消费者自身 Git 根目录读取；环境伪造值和外部 cwd 不覆盖它。`expectedDeploymentSha` 必须明确指定，`observedDeploymentSha` 来自实际健康响应；二者必须一致。消费者和后端 SHA 可以不同，分别记录。
- baseline/highscale/longrun 三个工作流增加现有合成组织和预期 SHA 字段。缺失变量会阻断；没有修改仓库变量、默认启用开关、触发器或定时任务。
- 原有 Node ops CI 命令取并集，保留 scope/history/window-runner/production-flow 命令并新增行为测试。没有前端 spec 变更或依赖/lockfile 变更。

设计锁：`docs/development/attendance-perf-tenant-provenance-design-lock-20261013.md`。

## 冻结源码与模型分工

| 项目 | 精确身份 / 工作 |
|---|---|
| 初始基线 | `625d18ae47671d0010c0b8cb1629ac4cd427df17` |
| 重放基线 | `e2345ab6b4a1aa68e59fff756dc258de5659e785`；上游两项审批/多维表前端 PR，不改变后端、性能消费者及相关工作流 |
| 运行验证消费者代码提交 | `660282b6755664164ac494d399de0f3d5ec2b43b` |
| 实际合成后端提交 | `625d18ae47671d0010c0b8cb1629ac4cd427df17`；相关后端、考勤插件和共享 preflight 路径与重放基线字节一致 |
| 实现 | Sol 6.1 / high，最小消费者 helper、生命周期接入、55 项子进程 HTTP 测试、工作流绑定 |
| 独立复核 | Astra / high，未参与实现；0 个可复现阻碍，另做 24 个对抗用例及五种独立 mutation |
| 环境 | Luna / medium 完成初始核查但传输未完成；主执行者接手新建数据库、完整迁移、实际后端和最终运行验证 |

八个被复核文件在重放前后 SHA256 一致。代码提交之后的本报告属于文档补充，真实运行 provenance 指向上表的代码提交，不能把文档提交号描述为实际运行版本。

## 设计门槛与验证结果

| 门槛 | 证据 | 结果 |
|---|---|---|
| 原缺口复现 | 实际原消费者 HTTP 子进程，错误租户/缺失或错误后端 SHA 仍完成五个操作和成功 summary | 已复现 |
| Mac Node 20 行为与邻居 | 10 个相关 spec，含 locale 生命周期、作用域、preflight/wiring、长跑和高规模 runner 邻居 | 197/197，0 fail/skip |
| Mutation 敏感性 | 独立合成源码副本分别移除租户证明、来源证明、请求尝试校验、刷新错误终止、最新 Authorization | 五项对应断言均失败；字节恢复后 55/55，0 skip |
| 独立复核 | Astra 在冻结八文件上执行 119 个选定用例（含 24 个额外对抗例）及五个 in-memory mutants | 0 个待修复发现 |
| 完整质量检查 | Mac mini `pnpm validate:all` | 重放后 exit 0；初始候选亦 exit 0 |
| 合成数据库准备 | 全新数据库，全部 Kysely 迁移，无排除；两合成组织、两账号真实登录及 /auth/me，实际源码健康证明和模板接口 | 439 项迁移成功；就绪证明通过 |
| 实际消费者负例 | 错误租户、错误后端 SHA、空 SHA、部分绑定，逐例前后比较记录/批次/明细/事件表计数 | 4/4 阻断；计数不变、无 summary |
| 实际消费者正例 | preview、同步 commit+rollback、异步 commit+rollback；每例 3 行，读回实际 provenance、健康身份及批次 | 3/3 通过；0 failed rows |
| 回滚数据读回 | 两个 commit 批次状态 rolled_back；考勤记录/事件均为 0 | 无考勤记录残留；保留 2 批次、6 明细审计元数据 |
| 清理 | 仅本轮专属后端进程组及数据库停止 | 已停止；其他会话环境未动 |

Astra 的独立测试以内存输出替代测试文件写入，证明请求控制流及 summary 对象，不作为物理文件落盘证明。父执行者的 Mac Node 20 测试和真实消费者验收实际写入并读回 summary。

## 可重放命令与证据

在专用消费者 checkout（依赖已准备）执行：

```sh
node --test scripts/ops/attendance-import-scope.test.mjs scripts/ops/attendance-history-reconcile.test.mjs scripts/ops/attendance-acceptance-preflight.test.mjs scripts/ops/attendance-import-perf-payload.test.mjs scripts/ops/attendance-import-perf-gate.test.mjs scripts/ops/attendance-run-perf-highscale.test.mjs scripts/ops/attendance-import-perf-longrun-workflow-contract.test.mjs scripts/ops/attendance-acceptance-wiring.test.mjs scripts/ops/attendance-verifier-contract.test.mjs scripts/verify-attendance-locale-zh-smoke.test.mjs
pnpm validate:all
git diff --check
```

本次实际 Mac Node 版本 `v20.20.2`、pnpm `10.16.1`。来源证明在每次请求前执行；成功报告包含消费者 checkout、预期后端、观察后端及证明来源四个字段。

本聊天专用 `artifacts/attendance-perf-tenant-provenance-20261013/` 保存：八文件哈希、重放读回、后端源码等价检查、独立复核、Mac 验证及 mutation 收据、七项运行结果、清理收据。原始日志与账号、数据库凭据、合成资源标识只保留在专用私有运行目录，不进入本报告或 PR。

## 限制与交接

1. tenant/health 证明与导入请求是顺序 HTTP 操作，不能证明服务器端原子性。晚发生的校验失败可能留下先前批次；不能绕过验证进行盲目回滚，应在已确认的合成目标中处置。
2. `checkoutSha` 代表 Git HEAD，不对任意 dirty 内容做证明。本次真实消费者运行于干净已提交 checkout，另以八文件哈希绑定复核与测试代码。
3. 额外证明请求计入现有 wall-clock 时间，阈值未调整。本轮每例 3 行用于正确性验收，不证明高规模吞吐或运营 SLO。
4. 初始 token 不可验证时直接终止；上游 resolver 负责提供有效初始凭据。错误刷新候选不得恢复旧 token 后继续导入。
5. GitHub 运营目标变量、定时性能/Strict/看板、真实环境验收、公开分支/新 PR/CI、合并和部署均未执行。当前可交付为本地代码提交、设计锁、测试和验证 MD；新公开发布需要 owner 单独授权。
