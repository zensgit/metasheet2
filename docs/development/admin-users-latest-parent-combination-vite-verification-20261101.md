# #6668 最新父提交与 #6676 组合验证、Vite 类型定位

## Linux 干净冻结安装续期（2026-11-01）

本轮专用 Linux 合成环境的安装与全部选定组合门槛已通过；最终 **Astra ultra 执行证据独立复核：bounded PASS**。下文原生验证与私有依赖投影保留为上一轮历史，不再把“尚未执行 Linux 冻结安装”视为当前状态。

源交付 tree 为 `2b9b3bc375c11208c6f62311d5071c46c5217fcc`，仅文档与源码资格 tree `515199600150a4822775ef395082dcb1e4013d9a` 不同。归档全部 14,221 项经独立审查；Linux 解包后的 Git tree 与交付 tree 完全相同。安装后、全部测试后和退出时的源码检查均为零差异。收尾 main/父/子远端 SHA 仍为下文冻结值。

### 环境与安装

- Mac mini 新建专用 VM，未启动或迁移旧环境；无用户目录挂载、应用端口发布或 Docker 默认 context 切换。
- 验证容器：Ubuntu 24.04、AMD64 用户空间、非 root 用户；Node20.20.2、pnpm10.16.1、`CI=true`。VM 为 ARM64，通过已有 Rosetta 执行 AMD64。
- 两个全新数据库容器分别对应 batch/recycle，均使用 `postgres:15-alpine`，实际 PostgreSQL15.19；镜像 ID/digest 已保留。
- 原始 `pnpm install --frozen-lockfile`，仅指定专属空 store；932 resolved/downloaded/added，**reused 0**，退出码 0。没有复制旧 node_modules、修改锁文件、回退非冻结安装或手工批准安装脚本。
- pnpm 默认安装脚本审批警告原样保留于 `install.log`：esbuild、protobufjs、vue-demi 的构建脚本被默认策略忽略；不宣称这些脚本已执行。未增加 `--ignore-scripts` 或绕过原策略。插件校验另保留 9 项原有 manifest warning，原门槛仍通过。
- 干净安装中 web、plugin-vue 和 Vitest 均解析同一版本 Vite5.4.21，进一步证实上一轮 TS2769 来自共享依赖漂移，而非需要修改业务源码或类型门槛。

### Linux 执行结果

证据位于 `artifacts/admin-review-fixes-20261101/linux-ci/`，不可与上一轮 `reanchor/` 原生证据混用。

| 门槛 | Linux 结果 | 证据 |
|---|---|---|
| 冻结安装、空 store、无旧模块复用 | PASS | `evidence/install.log`、`install.exit` |
| 前端原 workflow 三文件 | 131 passed | `evidence/guard.log` |
| 后端原 workflow 十文件 | 368 passed | `evidence/guard.log` |
| Flag 契约 | 48 passed / 0 failed / 0 skipped | `evidence/guard.log` |
| 原样完整 validate:all | PASS，包括前后端类型检查 | `evidence/guard.log`、`guard.exit` |
| batch 完整迁移与真实生产路由验证 | 461 个迁移、12 passed | `evidence/batch.log`、`batch.exit` |
| recycle 独立新库完整迁移及验证 | 461 个迁移、10 passed | `evidence/recycle.log`、`recycle.exit` |
| 安装后、最终和退出源码完整性 | 均退出 0 | `source-after-install.exit`、`source-final.exit`、`source-at-exit.exit` |
| 执行与清理最终状态 | primary=0、overall=0 | `primary-exit-code.txt`、`exit-code.txt` |

脚本逐字保留目标 workflow 的测试命令、文件、原 integration 配置与预算；没有减少测试、放宽超时、白名单或新增跳过。各 arm 失败即停止，未发生测试失败或盲重跑。

### 分工、保护与收尾

Grok 4.7 xhigh 实现专用验证 harness；Codex 实现隔离环境与调度；Astra ultra 独立预检最初指出四项执行器问题，均在任何安装/测试前修复：固定 daemon endpoint、只清理由本次创建的容器 ID、清理异常 fail-closed，以及失败路径也保留源码/镜像/harness 身份证据。预检随后 bounded PASS，文件与源码归档校验通过后才运行。

环境准备阶段另有两个已纠正的基础设施错误：Unix socket 路径过长、macOS tar 扩展属性不被 Linux 接受。它们均发生在业务验证前；原日志保留，不作为测试重跑。非 root 最终镜像在首次工作区安装前完成。

所有三台专属容器停止状态已核实；专用 VM 已停止，原 Docker 默认 context 未切换。仅保留专用缓存、合成数据及证据，未删除其他环境；收尾内置 SSD 约剩 57 GiB。源码、锁文件、CI 调度与门槛均未修改，没有提交、推送、合并或部署。

**资格边界：** 这是 Rosetta 模拟下的 Linux/AMD64 本地组合验证，不是原生 AMD64 托管 runner 的性能资格，也不是实际 GitHub CI。三个执行 arm 共享一次全新冻结安装，数据库独立新建；不能称为每个 GitHub job 各自干净安装。退出收据按 arm 记录，而不是逐条内部命令；应结合完整日志判断每个子步骤。实际远端 CI 仍待另行授权公开后执行。

Astra 最终复核核对 47 项 checksum（外层 evidence manifest 43 项，approved manifest 4 项）、全部 evidence 文件、完整测试日志及两库各 461 个不同迁移的相同顺序，未发现测试失败、跳过或命令减少；确认资源清理只涉及本次创建的三个容器。最终报告为 `linux-ci/astra-final-review.md`。补充的构建/启动日志、执行摘要和远端快照不在这两份 manifest 内，不据此声称整台共享主机全局空闲或持续不变。

## 范围和来源

仅本地整合、合成验证和独立复核；没有提交、推送、公开评论、合并或部署。没有读取客户数据、修改真实配置或其他工作树。

- main：`b0fc545ce696d2edbfbbd9c0bc3a21bc04bcdb2b`。
- 原父提交：`e456b07574799f5c043d58c92071dcfb4670fa5a`。
- 本轮父提交：`69a106f3c767346165f3cb98b59fa45dabb8ba55`。
- 子提交：`41babc4517fcc67944182de8594e8111a7038c36`。
- 上轮组合 tree：`4eaca3f40478c57d64b3d4c8d22753e70ec9376b`。
- 本轮完整源码 tree：`515199600150a4822775ef395082dcb1e4013d9a`，不是提交。工作树中的 apps/packages/workflows/scripts 与其相同；后续报告编辑不属于运行时代码。

这是两个 PR 加本地修复的组合资格，不是两个远端分支分别通过 CI 的声明。原父单独切片的历史证据保持历史范围。

## 整合决定

1. 保留最新父提交的四个生产根路由注册：先 authenticate、再 ensurePlatformAdmin、最后调用对应导出的批量 handler。回收站注册仍保留，不重复挂载批量辅助注册器。
2. 保留父提交固定的四类外层错误消息；不重新回显底层异常。
3. 保留本地角色替换、命名空间撤销见证、锁顺序、generation、旧恢复证据废止、自停用拒绝和身份冲突保护；子组合的墓碑写入拒绝、令牌拒绝与回收并发保护不变。
4. 父提交的类型辅助函数不是逐行复制：当前子计划已经用回收站取代 HARD_DELETE_UNSUPPORTED 分支，保留该旧拒绝辅助函数会引入无用代码。组合所有剩余计划使用 `plan.ok === false` 判别收窄；完整后端类型检查通过，错误分支仍返回计划的 status/code/message。
5. Grok 4.7 xhigh 完成固定 HTTP 服务的测试传输整合，九项原有测试与断言全部保留。最初五文件 Grok 任务在持续阅读、无补丁后被明确停止；Codex 接手运行时与登记表整合，不把无产出会话算作实现完成。
6. 数据库测试改为真实 `adminUsersRouter()` 入口，不再以独立辅助注册器替代生产注册；增加四个根批量入口的非管理员拒绝与目标数据不变断言。
7. 登记守卫仍逐 mount/gate 保留拒绝传播代表，另逐一覆盖四个批量根入口；没有用同门去重删掉此前批量失败路径覆盖。后端十文件从 365 增至 368 项。

## 合成验证

证据目录：`artifacts/admin-review-fixes-20261101/reanchor/`。

环境为专用原生合成 PostgreSQL 15、Node20.20.2、pnpm10.33.0。回收站专属库重新创建并完整执行 461 个迁移，真实计数为 **470 张 BASE TABLE 加 8 个 VIEW**；此前“478 张表”的表述应理解为 information_schema.tables 中的关系总数，而不是物理表数。环境停止证据见 `environment-stop.log`。

| 检查 | 结果 | 证据 |
|---|---|---|
| 后端领域、权限、角色边界、认证、调度器十文件 | 368 passed | `unit.log` |
| 前端批量与管理页三文件，Vite 对齐后重跑 | 131 passed | `web-vite5.log` |
| Flag 完整登记与契约 | 48 passed | `flags.log` |
| 真实生产批量路由、RBAC、锁、身份、证据 | 12 passed | `batch-realdb.log` |
| 回收、恢复、清除、版本竞态、令牌、迁移与墓碑 | 10 passed | `recycle-realdb.log` |
| 未改动的完整 validate:all | PASS | `quality.log` |
| 单独完整 web type-check，包括两个 verification 配置 | PASS | `web-typecheck.log` |
| 原 main Vite 配置，同依赖问题对照 | TS2769，exit 2 | `vite-before.log` |
| 相同配置，相同包字节，仅私有 Vite peer 对齐 | PASS，exit 0 | `vite-after.log`、`vite-resolution.json` |

两个数据库文件仍完整运行，未删测试、放宽超时、白名单或以数据库不可达跳过。已有 CI 测试链文件保留，本轮没有改工作流或调度。历史 mutation 红例仍属于上轮源码/运行环境，本轮没有把它们重新标为新头 mutation 结果。

## Vite 根因与最小处置

根 package.json override 和锁文件要求 Vite 5.4.21；共享安装中 web 与 plugin-vue 6.0.1 却绑定 Vite 7.3.7，Vitest 1.6.1 绑定 Vite 5.4.21。`defineConfig` 的 Vite 5 插件类型与 `vue()` 的 Vite 7 插件类型冲突，最终错误是 hook receiver 的 ConfigPluginContext/void 不兼容。

Astra ultra 只读确认该根因，并指出不能直接替换共享 `@vitejs` scope 下面的子链接。执行前先将本工作树的 scope 链接换成自有目录，再复制 plugin-vue 原包字节到专属诊断目录并显式绑定锁内 Vite/Vue/pluginutils。只替换自有 web 依赖链接，Vite 缓存目录同样私有化；canonical 的 Vite 仍为 7.3.7，没有改其依赖。

`project-vite-lock-peers.mjs`、包哈希和私有回滚链接收据记录该对照。web/plugin/Vitest 的 Vite 现为同一 5.4.21 realpath。没有修改 vite.config.ts、package.json、pnpm-lock.yaml、类型声明、skipLibCheck 或测试门槛。

**这是有界依赖对照，不是 frozen install。** 全部本地检查的通过不能证明整个依赖图与 CI 完全一致；Linux CI 和 pnpm10.16.1 的干净冻结安装仍未执行。推荐后续先在专属、空间充足的环境执行未修改锁文件的 frozen install，再运行原质量和测试链，而非给源码添加类型强转。

## 独立复核与证据边界

Astra ultra 对完整 tree `515199600150a4822775ef395082dcb1e4013d9a` 给出 **bounded PASS**：未发现可操作的整合回归，确认生产门、计划错误分支等价、旧修复保留和测试覆盖。结果存于 `astra-combined-review.md`；审阅者只读复核源码及日志，没有代替执行测试。

单独 `registry.log` 是扩展四入口失败传播代表之前的 188 项历史运行；最终 192 项登记守卫以 `unit.log` 为准，计入后端 368 项。既有 RBAC 查询拒绝在 Express 4 下无响应的基线行为未修复，此轮不将其包装为已解决。

证据生成时发现私有 index 的初次文件枚举遗漏原 index 中新增文件，`534920908ba3c71db6a219b509e207666f579c4c` 是无效的不完整快照，已明确撤回并通知审阅者，不可作为资格来源。正确快照 `515199600150a4822775ef395082dcb1e4013d9a` 包含全部新增文件，并以运行代码目录零差异校验。`combined.patch` 已重新生成。

收尾重新核对 main、父、子远端 SHA，均与本轮冻结来源相同。尚未公开或运行远端修复 CI，暂不合并、不部署。下一步权限不从本地绿色推导。

## 经批准公开后的实际 CI 补修

Owner 随后批准公开独立组合分支及 Draft PR，并确认目标仅为 #6668 与 #6676。组合提交 `d8e09698b3394c5a5505694881089f0b02a09086` 已创建 Draft #6685，未改变两个原 PR 分支，也未合并或部署。GitHub 生成的合并树与该提交相同；实际 CI 已执行，不再仅以本地 Linux 证据代替。

首轮 Plugin System Tests 的 contracts 失败来自新增管理员 DB 工作流中的动态路径 `admin-user-${{ matrix.slice }}-review.db.test.ts`：既有 attendance wiring 守卫静态解析时拆成无法对应任何测试的参数，因而 fail closed。两个管理员 PostgreSQL CI 矩阵任务本身均通过。相同 wiring 命令本地复现 322 项中 321 通过、1 失败。

仅将动态执行步骤拆成 batch/recycle 两个带矩阵条件的显式文件路径。仍为原有两个隔离数据库矩阵任务；安装、迁移、运行配置、测试集合及超时不变，未改静态守卫或白名单。修复后 `node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs` 为 322/322 通过，无跳过；`pnpm validate:all` 通过。Astra medium 对这项小范围工作流补修独立复核 bounded PASS，未发现测试丢失或不安全跳过。此补修须以新提交重新运行实际 CI，旧头通过项不作为新头绿色证据。

第二轮提交 `5b4fb974c773fa06b11d1bc843ac5c917de0025a` 的实际 CI 进一步发现三个接线遗漏：`adminUserBatch` 在 required-web 登记块中未按字母排序、未加入独立 token manifest，以及 recycle route 测试的五处 `request(app())` 被既有零债务 tripwire 拒绝。Plugin unit 共 3 个文件、9 项失败；保留失败证据，不用同头重跑掩盖。

Grok 完成三个文件的最小补修：移动既有 token 位置、manifest 仅新增该 token、四个 recycle 用例的五处请求改用项目已有 `usePinnedServer()`。请求方法、路径、正文、mock、断言和超时均保留，不改业务实现、守卫或白名单。四个受影响套件共 70/70 通过；manifest 检查确认 20 条 gating invocation 的 628 个 distinct tokens 与独立清单一致；`pnpm validate:all` 通过。Astra medium 静态独立复核 bounded PASS。新的提交仍须重新通过实际 GitHub CI；这不是全套 CI 已通过的声明。
