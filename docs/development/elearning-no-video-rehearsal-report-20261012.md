# 云课堂（plugin-elearning）本地启用演练报告 — onprem-r65，无视频

> 入库说明（2026-10-12，开发机·备料线协调方）：本报告由本地演练代理撰写，协调方核对了关键结论（考试运行时要求视频开关：`packages/core-backend/src/elearning/feature-flags.ts` 中 `isElearningExamSurfaceEnabled` 要求 `isElearningWatchSurfaceEnabled`），并抽查了截图。截图与 jsonl 证据留在开发机，未入库。配套启用手册：[elearning-no-video-trial-operator-guide-20261012.md](elearning-no-video-trial-operator-guide-20261012.md)。

- 授权：owner 2026-10-12「先做云课堂本地演练，不带视频」。
- 被测代码：tag `onprem-r65` = `6d4e9fc385e58a6c06814619c74c60aec206b354`（本机 worktree，detached，`git status` 干净，源码零改动）。
- 环境：本开发机。便携 PG16（仅本机监听，`--locale=C`）；后端 = 本地 `tsc` 构建的 dist，用 plain node 启动（不是 pm2-runtime），NODE_ENV=production，仅本机监听；Web = 本地 `vite build`（VITE_BASE_PATH 未设，即 `/`），由小型静态服务器 + /api 反代提供。
- 全程未联系演示机、未接触钉钉、S3/对象存储、邮件、GitHub。`ELEARNING_MEDIA_ENABLED`、`ELEARNING_WATCH_CHALLENGE_ENABLED`、`ELEARNING_NOTIFICATIONS_ENABLED` 全程未设置。
- 证据（留在开发机 scratch，未入库）：`evidence/*.jsonl`（已脱敏，全量扫描未发现口令、JWT、bcrypt、邀请令牌）、`evidence/rows-*.json`、`evidence/ui/*.png`（17 张截图，只有合成数据）。

## 与演示机的偏差（读结论前先看）

1. 演示机跑的是在线包 + pm2-runtime；这里是同一 commit 的本地构建，用 plain node。启动日志的业务行应当一致，进程管理那部分不一致。
2. worktree 的 `plugins/` 下还有若干开发插件（example-plugin、plugin-test-a/b 等），离线包里没有；它们和云课堂无交互。
3. 管理员账号用的是与 bootstrap-admin 脚本相同的 SQL 写入，因为两个脚本在本机 psql 16 下直接失败（见发现 F1）。
4. Redis：模板里只有 `REDIS_HOST/REDIS_PORT`，没有 `REDIS_URL`。按代码，`db/redis.ts` 只读 `REDIS_URL`，未设置时返回 null；APIGateway 日志为 `redis circuit breaker store: memory fallback`。本演练把 REDIS_PORT 指向一个没人监听的端口，后端正常运行，日志无 redis 连接错误。结论：本演练覆盖的路径不需要 Redis。

## 分步结果

| 步骤 | 结果 | 要点 / 耗时 |
| --- | --- | --- |
| R0 准备 | 通过 | `pnpm install --frozen-lockfile` 2 s（已是最新）；后端 build 37 s；web build 105 s；新建库后执行迁移 14 s；`kysely_migration` = **438**；`elearning_*` 表 **70** 张 |
| R1 账号 | 通过（有发现） | admin：与脚本等价的 SQL + `POST /api/admin/directory/local/accounts`（建本地组织锚点和成员关系）。其余账号走 `POST /api/admin/users`（即「用户管理 → 新建用户」），**「所属组织」选 default**。另建一个不选组织的 `elnoorg` 作对照。第一轮建号漏选组织，这 4 个号已删掉重建（R1-seed-users.jsonl 是第一轮记录） |
| R2 全关 | 通过 | 应用目录里没有「学习中心」卡片；`/api/platform/apps/elearning` 404；`/api/elearning-app/installation` 404 `feature_disabled`；`/api/elearning/*` 没有挂载，返回 Express 默认 404 HTML；插件页显示 plugin-elearning `inactive`；`/health` 200 |
| R3 运维开开关并重启 | 通过 | 开 7 个开关后重启，6 s 开始监听，无崩溃，无存储探针。与全关相比，启动日志只多两行：`Loaded 15 event types`（全关时为 0）和 `Plugin route registered: plugin-elearning GET /api/elearning/capabilities`。没有专门的「云课堂已启用」日志行。插件状态自动变为 `active` |
| R4 平台管理员安装 + 启用 | 通过 | 「应用 → 学习中心 → Open shell」进入 /apps/elearning，点 `Install` 后为 `inactive`，再点 `Enable` 变为 `active`（每步 <100 ms）。重复 Install 是幂等的；非管理员 403；无组织 403 `ORG_CONTEXT_REQUIRED`；body 多带字段 400。启用后只有管理员能看到卡片，学员要等 R5 完成后才能看到 |
| R5 角色 | 通过（有发现） | **只分配角色不够**：分配 `plugin_elearning_viewer/operator` 后，用户权限里仍然没有 elearning:*。还要在「用户管理 → 插件使用 → elearning → 开通插件使用」打开准入，权限才生效（见 F5）。角色模板：viewer = read；operator = read/write/grade/stats；admin = 再加 admin |
| R6 教师建课（无视频） | 部分通过（关键结论） | 见下文「无视频能做什么」。operator 不能建课（403），teacher 要拿到 `plugin_elearning_admin` 才能建课 |
| R7 学员 | 部分通过 | 学习、自学报名、练习、人工积分、证书都能用；**正式考试不可用**（`/api/elearning/exams/...` 404 `not_found`）；「完成课程 / 登录」积分规则可以发布，但不会触发（见 F3）；分析数据被抑制或导出失败（见 F9、F10）；plain 用户和无组织用户被干净地拒绝 |
| R8 回滚再开 | 通过 | 关掉开关重启：所有入口消失，数据不动（`elearning_*` 共 73 行，关前 = 关后 = 再开后，逐表一致）。再开开关重启：安装状态仍为 `active`，**管理员不用重新启用**；学员的完成记录、15 积分、证书都还在。「启用」按钮的怪癖复现了，另外新发现「停用」会跨重启保留（见 F6、F7） |
| R9 界面 | 通过 | Playwright 1.57 + Chromium，真实登录，17 张截图在 `evidence/ui/`。学员在界面上点开文章、做练习都成功（「回答正确。」）。plain 访问 /learn 和 /admin/elearning 会被重定向到 /home；直接访问 /apps/elearning 显示 `API error: 404 Not Found Platform app not found.` |

## 关键问题：不开视频，课程里能放什么？

在 r65、MEDIA 关闭的条件下逐一实测：

| 内容 | 能否建 / 发布 | 学员侧 | 证据 |
| --- | --- | --- | --- |
| 图文文章（富文本 HTML） | 能，「云课堂管理 → 文章与链接课程」 | 点「打开并记录完成」，正文在页面里展示，状态记为完成 | R6/R7；截图 learner1-course-article-opened.png |
| 外部链接（仅 https） | 能 | 点击即记为完成（完成依据为 `weak_server_recorded_launch`） | 同上 |
| 文章 + 链接组成的课程 | 能发布（2 项用时 152 ms）、能指派、能开放自学 | 全部打开后课程状态为「已完成」，学习档案计入「内容课程」 | R6/R7 |
| 视频 + 客观题课程（页面顶部那张表单） | **不能**。表单照常显示，但「发布并指派」按钮是灰的，页面没有任何说明；直接调 API 得到 404 `{"error":"not_found"}`，`POST /api/elearning/media` 得到 Express 404 | — | 截图 teacher-course-editor.png；R6 |
| 题库 / 试卷 / 正式考试（「题库与考试」区） | 能建（xlsx 导入 3 题、组卷 100 分、考试发布成功） | **学员没有任何入口可以参加**：考试运行时要求 MEDIA（`feature-flags.ts:115-121`）；而且考试类课程项只由「视频+考试」发布流程创建（`elearning-course-publish.ts:646-648`），已发布的试卷考试挂不进内容课程 | R6/R7 |
| 刷题练习（以试卷为来源） | 能 | 能用：顺序 / 随机 / 错题本，提交后即时判对错，错题进入错题本，下发题目不带答案 | R7；截图 learner1-practice-result.png |
| 自学报名 | 能。前提是给课程设置可见范围规则，而这一步**没有界面**，只能调 API（见 F8） | 学员在列表里看到「自学」课程，可以报名 | R6/R7 |
| 积分 / 称号 / 证书 | 人工加分、称号阶梯、证书模板与签发都能用 | 钱包显示 +15「人工调整」，称号升为「学习达人」，「我的证书」里有证书 | R7b；截图 learner1-practice-result.png |

结论：**不开视频时，云课堂相当于「图文/外链课程 + 指派/自学 + 刷题练习 + 人工积分/证书」。正式考试和自动判分的考试成绩拿不到**（练习会判对错，但不进考试成绩，也不产生 pass_exam 积分）。教师碰到视频那一步时，按钮是灰的，没有任何提示；后端返回的是干净的 404 拒绝，不报错、不崩溃。

## 每个角色实际看到的界面

- 运维：开开关并重启后，日志里除了上面两行，没有专门的提示。
- 平台管理员：顶部「应用」→ 卡片「学习中心」→「Open shell」→ 英文的「Cloud classroom installation」区块 → `Install` → `Enable`。状态显示原始单词 `inactive` / `active`。区块里有「Opt in to learning notifications」勾选框，不要勾。
- 教师（plugin_elearning_admin）：从「应用 → 学习中心 → Quick entry → 云课堂管理」或直接打开 /admin/elearning。页面最上方是视频表单（不可用），往下依次是「文章与链接课程」「学习门户」「学分规则 / 称号 / 证书」「分析」「刷题练习」，最后是「题库与考试」（需要点开）。文章正文要在文本框里**直接写 HTML**；指派对象要填**用户 ID（UUID）**。
- 学员：登录后 /home「我的应用」里出现「学习中心」卡片，点「进入」到 /learn。顶部导航栏没有学习中心入口。页面依次是我的学分、我的证书、学习档案、刷题练习、课程卡片。副标题写着「考试仅在服务端确认视频完成后开放。」，无视频部署下会让人误解。截止日期显示为原始 ISO 字符串，例如 `2026-10-19T06:25:02.872Z`。
- plain 用户：/home 里没有学习中心；/learn 被重定向到 /home；API 返回 403 `Insufficient permissions`。
- 无组织用户：所有云课堂 API 返回 403 `ORG_CONTEXT_REQUIRED`。

## 发现清单

严重度：高 = 会挡住启用或误导 owner 做决定；中 = 运维或教师会踩坑，有绕行办法；低 = 体验或文案问题。

| # | 类型 | 位置（r65） | 复现 | 预期 vs 实际 | 严重度 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Bug（环境相关） | `scripts/ops/multitable-onprem-bootstrap-admin.ps1:254`；`scripts/ops/attendance-onprem-bootstrap-admin.sh:197,234,324` | 在 Windows 上用 psql 16.10 跑任一 bootstrap-admin 脚本 | 预期能建管理员；实际 psql 把连接串后面的 `-v/-X/-A/-t` 全部当作多余参数忽略（`extra command-line argument ... ignored`），`:'v_user_id'` 报语法错，脚本失败（没有写入任何行）。是否命中取决于目标机 psql 的版本和平台；演示机已有管理员，所以不挡本次启用 | 中 | 把连接串放到参数末尾，或改用 `-d "$URL"` |
| F2 | 能力缺口（设计） | `packages/core-backend/src/elearning/feature-flags.ts:115-121`；`services/elearning-course-publish.ts:646-648` | MEDIA 关闭时调 `POST /api/elearning/exams/items/:id/start`，或发布视频+考试课程 | 正式考试在运行时要求 MEDIA；试卷考试虽然能发布，但学员没有入口 | 高（影响 owner 决定「不带视频」能不能演示考试） | 二选一：①演示时只承诺练习；②开发「考试独立成课程项」，不依赖 MEDIA |
| F3 | Bug / 产品缺口 | 规则面：`services/elearning-credit-surface.ts:22-30`、`apps/web/src/services/elearningCredit.ts:12-20`；唯一接上的发放点：`services/elearning-credit-postgres.ts:282`（只被 exam / exam-expiry / manual-grading 调用） | 发布 `complete_course` 10 分和 `login` 1 分两条规则，学员完成课程并多次登录 | 预期加分；实际钱包为 0，`elearning_credit_decisions` 为 0 行。在 r65 树里用 grep 只找到 pass_exam 的发放路径，所以其余 6 种行为的规则发布后不会生效 | 中 | 界面只列出已接线的行为；或者补上 complete_course 的发放 |
| F4 | 权限设计缺口 | 内容/题库/积分写操作一律 `rbacGuard('elearning','admin')`（`services/elearning-pilot-runtime.ts:395-400`）；`routes/elearning-admin-access.ts:50-58` 把 elearning:admin 等同为全局管理员；安装 PUT 只要求 elearning:admin（`routes/elearning-app-installation.ts:92-93`） | operator 角色建课得到 403；升为 admin 角色后，教师在 /apps/elearning 看到 `canManage: true` | 没有「只能建课」的角色；能建课的教师同时也能停用整个应用 | 中 | 新增作者角色，或把安装/停用收紧到平台管理员 |
| F5 | 体验 / 文档缺口 | `routes/admin-users.ts:4848-4886`（分配角色时不开通准入，`disabledNamespaces = []`），对比新建用户时的 `:4156-4163`（会自动开通） | 给已有用户分配 plugin_elearning_* 角色后查 `/api/auth/me` | 预期获得 elearning 权限；实际要再点「插件使用 → elearning → 开通插件使用」才生效 | 中 | 写进运维手册（已写）；或者分配角色时同时开通准入 |
| F6 | Bug（已知怪癖，r65 仍在） | `routes/admin-routes.ts:602-611`；`plugins/plugin-elearning/index.cjs:41-43`；`apps/web/src/views/PluginManagerView.vue:231-233` | 开关关闭时在插件页点「启用」 | 接口返回 200 `success:true`，但 `runtime.status:"inactive"`，页面无任何提示；注册表被写成 `enabled` | 低 | 运行时不是 active 时返回非 2xx，或提示「需要先开部署开关」 |
| F7 | Bug（新发现） | `routes/admin-routes.ts:620-635`（停用写入注册表 `disabled`）；插件只负责注册 `/api/elearning/capabilities`（`index.cjs:54`） | 开关开着时在插件页点「停用」，然后重启 | 停用跨重启保留：plugin-elearning 保持 inactive，`/api/elearning/capabilities` 返回 Express 404。而核心业务路由（例如 `/api/elearning/me/courses`）仍然返回 200，前端读不到能力就会显示功能关闭。要回到插件页点「启用」才能恢复（已验证可恢复） | 中 | 运维手册预检里加一条「插件页 plugin-elearning 必须是 active」（已写）；把插件开关和核心路由的状态统一 |
| F8 | 界面缺口 | `routes/elearning-pilot.ts:1086`（`PUT /api/elearning/courses/:courseId/scope`）；在 `apps/web/src` 里 grep 不到调用方 | 想让学员自学报名 | 只能调 API 设置可见范围；界面上只有「指派」（还得填用户 UUID） | 中 | 加可见范围编辑界面 |
| F9 | 设计行为，需要写进文档 | `services/elearning-analytics-export-storage.ts:63-65` | 生产模式下发起分析导出 | 任务状态变为 `failed` / `STORAGE_UNAVAILABLE`。代码在 production 下固定使用不可用存储，所以导出按钮在演示机上一定失败 | 中 | 生产模式下隐藏导出按钮或给出说明；或者接入存储（需要 owner 决定） |
| F10 | 文档缺口 | `services/elearning-analytics-suppression.ts:3`（最小人数 5）；分析按部门统计 | 部门统计 | 本地组织默认没有部门，只能用 API 建（`/api/admin/directory/local/*`，没有界面）；部门不足 5 人时显示 `suppressed:true`；日报只统计到前一天（当天查询返回 404 `not_found`） | 低 | 演示前说明：小样本下分析看不到数字 |
| F11 | 界面 / 文案 | `apps/web/src/views/ElearningAdminView.vue:7-232`（视频表单没有 v-if）、`:333`、`services/elearning.ts:788-796`；`views/elearningLabels.ts:243,312` | MEDIA 关闭时打开 /admin/elearning 或 /learn | 视频表单仍然排在第一位，按钮是灰的但不说明原因；学员页副标题写着需要视频 | 低 | 按 capabilities.media 隐藏视频表单或加提示；改副标题文案 |
| F12 | 界面 | `apps/web/src/views/ElearningAppInstallationSection.vue:2-30` | 打开 /apps/elearning | 整个区块是英文，状态显示原始英文单词，出错时显示 `elearning_installation_request_failed`；通知开关虽然显示，但 NOTIFICATIONS 部署开关是关的 | 低 | 汉化；部署开关关闭时隐藏通知勾选框 |
| F13 | 界面 | `views/ElearningContentAdminSection.vue:101-109`、`ElearningAdminView.vue`「指派对象（用户 ID）」；`ElearningLearnerView.vue:54` | 指派课程；查看截止日期 | 指派要求填 UUID；截止日期显示原始 ISO 字符串 | 低 | 换成人员选择器；格式化日期 |
| F14 | 运维 / 文档 | `apps/web/src/views/UserManagementView.vue:103-124`（所属组织默认选「不指定组织」） | 建号时不选组织 | 该用户访问云课堂全部返回 403 `ORG_CONTEXT_REQUIRED`。在 r65 web 里没找到事后补组织的界面（`/api/admin/directory/local/accounts` 只有 API） | 中 | 运维手册要求建号时选组织（已写）；补一个「加入组织」的界面 |
| F15 | 低 | `/health` 的 `pluginsSummary` | 开关关闭 | 报告 `active:13, failed:0`，而插件页显示 plugin-elearning 是 `inactive` | 低 | 让健康检查的计数与插件页口径一致 |

正面结果（验证过）：文章 HTML 被服务端清洗（`<script>`、`onerror` 被剥掉，见 R6）；练习下发的题目不含答案；各类越权请求（学员建课、学员指派、学员给自己加分、学员停用应用、学员读管理接口）都返回 403；开关关闭期间数据完整保留；重新打开开关后不用重新安装或启用。

## 未覆盖 / 不确定

- pm2-runtime 下的重启方式、nginx 前置和演示机真实数据没有演练。演示机上的插件注册表里 plugin-elearning 是什么状态（F7）我不知道，需要上机后先只读查看。
- 视频、视频观看挑战、通知按授权不测。正式考试的判分、`pass_exam` 积分、人工阅卷在无视频条件下走不到，所以没有覆盖。
- F3 的结论来自对 r65 树的 grep 加一次运行实测，前提是没有其他异步生产者。我等了大约 2 分钟，任务表里也没有对应的 job。
- 截图在 1366×2600 视口下拍摄。应用的滚动容器在内部，超出视口的部分截不到。
