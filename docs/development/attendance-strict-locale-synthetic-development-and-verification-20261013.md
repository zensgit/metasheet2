# Strict Gates 合成目标就绪与 locale 验收 — 2026-10-13

状态：实现、两轮真实 Strict、locale、针对性测试及独立代码复核通过；439 张 public schema 基线表完整恢复读回、79 个业务表再校验及专属进程停止完成。本轮没有部署、修改真实 CI 变量或分支保护，未公开分支或创建 PR。

## 问题与修复

历史八次运营运行有共同配置阻断：Strict 和三次性能运行缺合成组织；locale 缺预期后端 SHA。Nightly/看板汇总上游失败，分支策略另报 STRICT_NOT_ENABLED。本轮只验收前置 Strict/locale 切片；不放宽校验或修正真实运营配置。

新建 Mac mini 专属数据库，运行全部 439 项 Kysely 迁移、零排除；建立两组规范 UUID 租户、三个生成账号及员工 namespace admission。通过真实登录、/auth/me、后端健康响应和前端代理核对身份。凭据、端点和具体资源标识仅保存在私有运行目录。

在原 main 的完整 Strict 中，API/权限配置通过，三个浏览器门槛失败：生产流程仍等待已移除的可见 quick-jump select；桌面/移动流程等待 Reload/刷新，而当前中文按钮为重载。修复仅适配共享导航 helper 和完整流程脚本的按钮文案，在现有行为 spec 中补回归，并加入现有必跑 Node CI 命令。保留已有命令和业务断言，没有改前端、后端、locale、身份 helper、schema、配置开关或阈值。

## 精确源码与模型分工

| 项目 | 身份 / 实际工作 |
|---|---|
| 冻结 main、实际后端及前端 checkout | c5ad041df1b71843b210f9b053a95967e41088ad |
| 实际修复消费者提交 | 8219e64e655fc986ba7c3fc25cf6b220f6143f5b |
| 本地分支 | codex/attendance-strict-locale-qualification-20261013 |
| Luna / medium | 只读工具、依赖、浏览器及旧专属进程核查；主执行者完成环境创建及运行 |
| Sol 6.1 / high | 离线身份边界验证；另一个实现实例完成导航/文案修复、行为回归及 mutation |
| Astra / high | 未参与实现的独立代码/证据复核、82 项测试、7 项 in-memory mutation |

后端/前端保持 main 冻结 checkout；消费者来自独立干净已提交 checkout。每份成功 Strict summary 分别记录 checkoutSha=消费者提交，以及 expectedDeploymentSha/observedDeploymentSha=实际后端提交，不能将消费者提交描述为部署版本。源码/工作流/设计锁五文件哈希在复核前后相同。

## 验证门槛

| 门槛 | 实际证据 | 结果 |
|---|---|---|
| 目标准备 | 全新合成数据库，439 项迁移；三个真实登录及租户证明；后端和前端代理健康 SHA | PASS |
| 实际入口负例 | Strict/locale 各验证缺组织、空组织、缺 SHA、错误 SHA、无替代凭据的第二租户 token | 10/10；导入/事件/角色等抽查表计数不变 |
| 刷新候选漂移 | 真实后端前的 loopback 代理返回有效第二租户 token；原权限配置脚本执行 | 终止，角色写入尝试 0，角色计数不变 |
| 新 UI 反例 | 原 main 完整 Strict 三个浏览器 TIMEOUT；最终回归 spec 对原消费者失败 | 9 个断言失败；未作为合格运行 |
| 实现测试与敏感性 | Sol 58 项针对性/邻居；5 项变异 | 全绿，五项均检出；源码恢复 |
| Mac Node 20 候选验证 | 9 个相关 Node spec，含原本本地缺依赖的 production-flow spec | 224/224；0 fail/skip |
| 完整质量 | Mac mini pnpm validate:all | exit 0 |
| 完整 Strict 第一轮 | API、权限配置、生产、桌面、移动浏览器；真实来源健康前后证明 | 五个业务门槛 PASS，contract/schema exit 0 |
| 完整 Strict 第二轮 | 同一消费者/后端/前端，间隔至少 90 秒；相同严格参数 | 五个业务门槛 PASS，contract/schema exit 0 |
| locale 浏览器 | 原 main 和修复消费者组合均实际执行；候选入口/出口 preflight | PASS；35 农历标签、节假日创建/删除、四个开关断言及中文页签 |
| 独立复核 | Astra 冻结五文件，82 项独立测试，7 项内存 mutation | 0 个待修复发现；七项检出 |
| 数据清理与停止 | 全表私有基线快照及 pg_dump，业务数据恢复、身份再读回、只停专属进程 | 439 张 public schema 基线表数据 SHA 相同；重启身份验证后 79 个业务表相同；三项专属服务停止 |

locale 的组织/SHA 配置验证通过真实 workflow 对应的前置 preflight 加消费者执行；没有把裸脚本的本地兼容行为误称为所有字段必校验。错误租户 Strict 负例移除了可用替代登录凭据：带正确租户凭据的纠正登录属于既有允许行为，不是校验绕过。

## 重放命令与数据恢复边界

在专属已提交消费者 checkout、准备好私有合成环境后：

```sh
node --test scripts/ops/attendance-acceptance-preflight.test.mjs scripts/ops/attendance-acceptance-wiring.test.mjs scripts/ops/attendance-import-scope.test.mjs scripts/ops/attendance-provision-user.test.mjs scripts/ops/attendance-locale-zh-workflow-contract.test.mjs scripts/ops/attendance-verifier-contract.test.mjs scripts/verify-attendance-locale-zh-smoke.test.mjs scripts/ops/attendance-import-perf-gate.test.mjs scripts/verify-attendance-production-flow.test.mjs
pnpm validate:all
bash scripts/ops/attendance-run-gates.sh
node scripts/verify-attendance-locale-zh-smoke.mjs
bash scripts/ops/attendance-validate-gate-summary.sh "$OUTPUT_ROOT" 1
ATTENDANCE_REQUIRE_PROVENANCE=true node scripts/ops/attendance-validate-gate-summary-schema.mjs "$OUTPUT_ROOT" 1
```

两次 Strict 顺序执行，locale 也顺序执行，避免全局 settings/roles 写入重叠。RUN_PREFLIGHT=false 仅表示 Docker 部署预检不适用于本地 native 合成进程，该门槛明确 SKIP；身份、实际 API 和五个业务门槛未跳过。可选 batch-resolve/job-recovery 保持现有 Strict workflow 的 false 默认，本轮不扩大切片。

隔离数据恢复为额外清理步骤，不冒充消费者自己的业务回滚。资格运行后的数据保留为私有快照，再在已核对专属 PG data directory 的同一合成数据库恢复私有基线，读取 439 张 public schema 基线表验证，随后重新验证测试服务身份及业务表状态并停止。重新验证后的差异仅为 users 与 user_sessions 中的登录／会话活动，单独列账；不作所有表零差异声明。实际健康 SHA 和三个真实登录／租户证明再次通过，随后后端 wrapper、实际 server、前端 PID 均不存在，PG status=stopped。

## 证据与限制

证据位于本聊天专属 artifacts/attendance-strict-locale-qualification-20261013：设计/源码哈希、模型实现与独立复核、目标/负例、两轮 Strict、locale、间隔、Mac 测试及质量、清理收据。原始浏览器图片、PG dump、账号/凭据和详细日志留在 Mac mini 私有目录，不进入公开报告。

- 原本本地 Node 24 缺少 Playwright/AJV 等依赖导致独立 production neighbor 未能加载；主执行者在 Mac Node 20 的 224 项验证中实际覆盖，不声称独立 reviewer 在 Mac/真实浏览器执行。
- 初次测试继承了验收变量、PATH 缺 pnpm；修正 harness 后同源码通过。初次第二租户负例错误提供有效目标租户凭据，已中止并恢复专属数据，不计为合格负例。第一次对既有 schema 做 clean restore 遇依赖错误，随后验证专属 PG 目录、只重建同一合成数据库并成功恢复。每项修正单列。最终数据恢复后首次健康等待期限不足，服务冷启动仍进行；延长等待后以实际健康/登录响应完成证明，没有把超时转换为成功。
- 初次浏览器原始日志路径后来复用；原失败 stdout/选择器诊断保留为明确的观察收据及会话输出，不声称被覆盖的原始文件仍存在。后续日志轮转使用唯一时间戳。
- 健康身份为实际后端 build 自报，辅以干净 Git checkout；不证明生产二进制/镜像和发布资产。前端为冻结源码的真实 Vite native 服务，不是生产镜像验收。
- Strict/locale 在入口/出口验证来源，不宣称每次业务写入之前都有原子的源码/租户证明。全局权限/设置作用面仅由全合成隔离环境承载。
- 未触发真实 GitHub 运营 workflow，未修改其变量或分支保护；历史运营门槛不会因本地通过自动变绿。性能规模、Nightly/看板及分支策略仍是后续切片。
- 本轮公开分支、新 PR/CI、合并及部署尚未执行；本报告为本地源码及隔离验证证据。
