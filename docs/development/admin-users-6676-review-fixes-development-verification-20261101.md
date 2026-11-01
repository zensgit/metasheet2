# #6668 / #6676 本地修复收尾与验证

> 本文保留上一轮记录。最新父提交整合、生产入口组合验证、Vite 依赖对照与质量门槛续期，见同目录 `admin-users-latest-parent-combination-vite-verification-20261101.md`；下文远端整合待办与 Vite HOLD 是历史状态。

## 结论

本地冻结候选的审阅问题已修复，Astra ultra 限定源码复核 PASS；**最新远端 PR 整合和完整质量门槛仍 HOLD**。没有提交、推送、公开评论、合并或部署；未访问真实租户或修改真实开关。

主线基线：`b0fc545ce696d2edbfbbd9c0bc3a21bc04bcdb2b`。原父 PR：`e456b07574799f5c043d58c92071dcfb4670fa5a`；子 PR：`41babc4517fcc67944182de8594e8111a7038c36`。先独立修复并冻结父切片，再集成子切片。父报告为 `admin-users-6668-review-fixes-development-verification-20261101.md`。

收尾核对发现远端父 PR 已前进到 `155caa075e4593183f0c5f128b1e671c243dc2bd`，新增 `d6d93d957c`、`155caa075e`：生产批量路由改由 `admin-users` 的平台管理员门注册，并补类型收窄与固定错误消息。main 和子 PR 未变。本地补丁没有覆盖这两项并行提交；旧头验证不能当作新头证据。下一步应保留这两项修改，重放本地业务修复，再重新运行受影响的路由/权限及组合验证。

## 实现与独立复核

- Grok 4.7 high 实现父切片；Grok 4.7 Fast high 实现子切片的令牌状态查询、默认关闭开关、登记和单元测试。
- 子切片的广域 Grok 会话长时间没有改动，已明确终止；Codex 接手并发、事务与隔离数据库验证，不把未产出会话算作实现完成。
- Astra ultra 独立只读复核：父初轮六项问题均修复；子初轮新增两个问题（purged-only JWT、已计划批量写回墓碑）均修复。最终 PASS 仅针对本地冻结候选，不是远端新头、测试执行、合并或部署许可。
- 定时清除重新锁定账户，并比较选择时的删除版本和当前到期时间。人工确认清除与自动到期清除保持区分。
- 回收管理员先获取共享事务锁；生命周期写入遵守命名空间与用户锁顺序，generation、旧恢复证据废止、令牌撤销同事务提交。
- 清除角色沿用中央角色写入和命名空间撤销见证，不再直接删除 `user_roles`。
- JWT、钉钉和 API token 共同拒绝 deleted/purged 两个标记；批量计划执行时在锁内再次检查标记，个人资料、角色和状态写入同一事务。
- 清理调度器默认 OFF，仅 `USER_RECYCLE_SWEEPER_ENABLED` 精确 `'true'` 可启动；原禁用/测试环境保护仍保留。错误日志不回显异常内容。

## 运行环境与证据纠正

Mac mini 内置 SSD 空间不足，本轮未在那里启动环境。使用专用原生 macOS PostgreSQL 15 合成数据库，未连接默认、staging 或客户数据库。子库完整执行 461 个迁移，478 张 public 表。

早期命令指定了不存在的 Homebrew Node20 路径，实际上回退到 Node24.14.1，不能作为 Node20 证据。发现后创建仅本工作区使用的运行器链接，显式验证 Node20.20.2、pnpm10.33.0 以及两个 workspace 中的实际 Node 版本，再重跑组合测试。最终证据均使用 `node20-*.log`；不把早期日志追认成 Node20。未安装或升级依赖。原生 macOS 仍不等价于 Linux CI；CI 声明 pnpm10.16.1，版本差异保留。

## 验证矩阵

| 门槛 | 最终本地结果 | 证据 |
|---|---|---|
| 后端领域、权限登记、角色边界、认证、调度器 | 365 passed / 10 files | `node20-unit.log` |
| 前端批量帮助器及管理页邻近文件 | 131 passed / 3 files | `node20-web.log` |
| Flag manifest 及完整性扫描 | 48 passed | `node20-flags.log` |
| 父功能在子组合上的真实 JWT/PG 验证 | 8 passed | `node20-batch-realdb.log` |
| 回收站真实 PG/令牌/并发/迁移 | 10 passed | `node20-recycle-realdb.log` |
| 后端 `tsc --noEmit` | PASS | `node20-backend-typecheck.log` |
| 工作流 YAML 与堆叠 PR 触发 | PASS | `workflow-parse-final.log` |
| 完整 `validate:all` | HOLD | `node20-quality.log` |
| 原 main 配置的同依赖对照 | 同样 Vite TS2769 | `node20-baseline-typecheck.log` |
| 远端修复分支 CI | 未运行 | 没有公开本地补丁 |

完整质量失败位于未修改的 `apps/web/vite.config.ts:28`，Vite/Vitest 插件类型不兼容；不能用针对性绿色替代完整门槛。没有改断言、放宽超时、删测试或以服务不可达跳过。

真实回归包括：两管理员相互回收时保留最后管理员；过期选择遇到恢复后重新回收（新期限未来、期限仍过期两种）；只延长期限；真实自动清理传递版本见证及正向清除；旧目录恢复调用拒绝；生命周期 generation；令牌撤销及独立 purged 标记；迁移 down/up、索引及身份保留并事务回滚；批量计划已读后遇到回收/清除提交时拒绝资料与角色写入。

Mutation 在独立源码副本执行，候选源码未变异：父角色撤销/generation/自停用/身份/序列化/撤销见证均红；子到期与版本三个负例红、管理员锁红且真实数据库观察到移除锁后零存活管理员、generation 红、purged token 红、墓碑重写两个负例红、默认开关五个负例红。早期 mutation 使用 Node24，证据与最终 Node20 全套正向执行分列，不宣称所有 mutation 都在 CI 同版本执行。

## CI 测试链

新增领域守卫包含前端三文件和后端十文件；前端批量测试同时加入 required web chain。新增真实数据库 workflow 的 matrix 为 batch/recycle，每个独立 job 都从完整迁移开始，避免“最后管理员”夹具被另一套测试污染。两个 PR 触发均无目标分支过滤，可覆盖堆叠 PR。登记扫描保留原族并增加从源码读取的 `USER_RECYCLE_*_ENABLED` 族，保留 missing/phantom 双向检查，未加入逃逸白名单。没有改分支保护或真实 CI 变量。

## 交付与剩余门槛

证据目录：`artifacts/admin-review-fixes-20261101/`。`parent-combined.patch`、`child-combined.patch` 和 tree 收据分别保存父修复与子增量；尚未形成提交，禁止直接覆盖远端父分支。检查点记录当前状态。

剩余顺序：保留并整合父新头 `155caa075e45` → 重验生产路由注册及子组合 → 在匹配 CI 的干净依赖环境定位 Vite 类型问题 → 经明确公开授权后运行真实 CI。保持不合并、不部署。专用数据库与本轮 Grok/审阅会话在证据保存后停止；不删除其他环境或缓存。
