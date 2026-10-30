# Plugin CI 并行化：设计与验证

本轮由 owner 批准开发、独立 Draft PR 和 CI。基线为 `2006826d772b9f693d878bff7d18bf275dead299`。合并、分支保护修改、部署及线上变更另批；不使用 Mac mini，不取消或重跑 #6640。

## 改动与执行图

原 `test (20.x)` 把清单、单元、checkpoint、多维表、审批、考勤等串行执行。现将它保留为最终汇总门，矩阵仍只有 `20.x`，检查名称不变。

1. `contracts` 无需安装依赖，执行原有全部前置清单及工作流守卫，并验证本次步骤迁移清单。
2. `permissions` 与 contracts 同时启动，先安装依赖，执行管理写路由清单、目录权限拒绝及 5xx 脱敏回归三个完整文件。
3. 两项前置检查均成功后，`unit`、`checkpoint`、`runtime-db`、`multitable-db`、`approval-db`、`attendance-db` 六组并行。每组内部沿用原步骤顺序。
4. `test (20.x)` 使用 `if: always()` 等待全部八组，要求结果集合完整且每项严格为 `success`。失败、取消、跳过、缺失或额外结果都拒绝通过。

所有测试组沿用原 GitHub 托管 Ubuntu 22.04 VM，保留现有 UID_MAP 兼容说明及 2027-04-17 退役日期。汇总门运行于 ubuntu-latest。没有改到持久化主机，也没有放宽动态或 self-hosted runner 选择。

每个真库组在不同 VM 上启动自己的 PostgreSQL 14。需要主库迁移的组各自从空库迁移，排除项与原工作流完全相同；checkpoint 组保留原协议自行创建隔离库的流程。考勤额外时区库的创建、清理保留。数据库名相同不意味着共享数据库。

前端只在考勤组构建一次；编译后的宜搭 CLI smoke 仍在 unit 组先构建后运行并清理 dist。不增加跨任务的 dist 下载或复用，不引入旧 head 产物。pnpm store 缓存保持原逻辑。

## 测试集合与门槛

原 test job 的 **129 个显式步骤、122 个 run 块**全部保留。只复制各组必需的 checkout、Node、依赖安装、PostgreSQL 和迁移准备步骤；安装失败日志和新增的组结果上传使用不同 artifact 名称。原测试步骤各执行一次；权限前置增加的三个文件仍包含于后续完整后端测试。

`scripts/ops/fixtures/plugin-tests-serial-baseline-20261030.json` 从冻结 Git 对象产生，记录原工作流哈希、129 步的语义哈希和所属组。新守卫逐步比对命令、参数、条件、环境、顺序及执行组；只允许明确列出的准备步骤复制和 artifact 名称调整。修改测试命令或新增测试时，需显式更新清单并审阅，不能通过检查时自动重写基线。

原有工作流守卫改为检查具体执行组及它与汇总门的严格依赖，继续保留原测试列表、数据库环境、EXPECT_DB、无过滤参数、权限拒绝等断言。无新增测试排除、过滤、passWithNoTests 或 continue-on-error。

pull_request / push / merge_group 触发、并发取消范围、另外四个 job 保持原语义。`test (20.x)` 与另外 12 项必需检查保持不变，没有改分支保护。现行 sealed-export provenance 测试明确断言 plugin-tests.yml 不是输入，本轮未修改任何既有 provenance pin，也未启用历史 P0 离线 execution-ledger 工具。

## 本机验证

使用 Node 20.20.2；所有日志留在本工作树 `artifacts/ci-parallel-validation/`。

- 权限前置及受影响的后端回归：7 文件 / 645 项通过。
- 宜搭三项修改过的工作流守卫及完整文件行为回归：52 项通过。
- 全部 24 个读取 Plugin CI 工作流的后端单元文件：965 项通过。
- 新增清单与汇总门回归：5 项通过，包括逐组失败、取消、跳过、缺失、未知结果以及实际 CLI 退出码。
- GitHub Actions 结构与表达式 actionlint 检查通过。完整 shellcheck 仍提示原脚本中的既有引号/未用变量问题；未为提速修改原脚本正文。
- sealed-export package provenance 验证通过，无 pin 更新。

其余工作流守卫回归与当前 Draft head 的 13 项必需 CI：在最终验证记录中按实际结果登记。本文件不预判远端成功。

本机初轮一次性并发启动全部守卫出现 Python 子进程超时，另发现旧守卫仍定位串行 test job；修复定位后，并发上限 4 的补验仍有一次同类超时；该文件独立补验 6/6 通过，串行整组亦曾遇到系统 Python 管道超时，失败文件继续独立补验。此本机限制单列，Linux Node 20 完整验证交由本 PR CI；不修改 CI 的原命令或解析超时。根目录没有适用于 scripts/ops 的 ESLint 配置，新增脚本由 Node 语法/行为回归及 Actions 校验验证，不将 ESLint 未配置记作通过。

## 耗时、交付与回退

#6640 固定 head `9fdf56bb44a9b85f563d9b934c075f262c644195` 的原 Node 20 job 实测 83 分 16 秒成功完成。按该次各原步骤相加，contracts 5.5 分钟、unit 20.1、checkpoint 8.0、runtime-db 9.4、多维表 15.3、审批 6.0、考勤 22.3。并行关键路径的粗估约 28–35 分钟，尚不包含不可预测的排队，不能视为实测提速或承诺。更多独立 VM 会增加重复安装/迁移及 Actions runner 分钟，主要收益是等待时间缩短。

远端需要确认：当前 Draft head 的八组均实际运行、汇总门成功、13 项必需检查全绿、完整测试收集与原集合相符，之后才登记实际耗时。不会为了追 main 或证据文字自动重启整轮验证。

工作流尚未合入时，main 和其他 PR 的 CI 不受本分支改变。以后若批准合入后发现调度回归，可另批 revert 此 PR，恢复原串行流程；无需改生产配置、回滚数据库或改变检查名。回退仍重新运行完整 CI。
