# #6991 备料项目交付清理 · 验证记录

**结论：本地专项测试和浏览器交互通过，真实 PostgreSQL 验收待执行。** 生产启用及合并须等真库结果。验证使用合成项目。主线基线为 `6babc578ec`。[开发说明](./stock-preparation-project-delete-development-20261127.md) · [设计锁](./stock-preparation-project-delete-design-lock-20261127.md)

## 按需求验收

| 门槛 | 本地得到的证据 | 仍需真库验证 |
|---|---|---|
| G1 预览与归属 | 盘点器覆盖专表、手填与回收站、共享表正反向关联；归属冲突会拒绝，内容改变会使相同数量的预览失效。 | 在真实 schema 分别执行只拉取、只登记和二者兼有的预览及确认。 |
| G2 管理员与验证码 | 路由覆盖伪造租户头、无当前租户凭据、权限降级和拒绝访问；服务覆盖错误、过期、换租户／操作者／项目、重放。 | 验证真实权限行锁与两个数据库连接并发确认时只提交一次。 |
| G3 同事务与审计 | 模拟清理中途失败、审计异常、审计未实际插入，均未提交；迁移动作词表与存储词表通过一致性检查。 | 运行 PostgreSQL 故障触发器，逐项比对项目、登记、表、字段、明细与审计快照。 |
| G4 工作台与隔离 | Chromium 走通预览、取消、输入、提交与刷新；前端测试覆盖切换租户、切换项目和迟到响应。缓存测试覆盖旧读回填及同号重建。 | 从真实接口检查旧链接、总览、侧栏、同租户其他项目与另一租户同号项目，并验证通用接口的托管保护。 |
| G5 调度与重建 | 已删除且未重建时，关闭清理开关后旧拉取入口仍返回 ABSENT；调度器专项测试只发起 dry-run，并把该轮记为跳过。 | 沿正常接口以同号重建，验证空表及旧批次、待办、权限和缓存均未回流。 |
| G6 名额与设置 | 真实数据库用例包含 200 个登记（含归档），检查满额拒绝、释放一个名额和租户设置前后一致。 | 在隔离库运行该用例。 |

## 已运行

| 检查 | 结果 |
|---|---|
| 插件删除专项 `node --test plugins/plugin-integration-core/__tests__/stock-preparation-project-delete-*.test.cjs` | 20 项通过，0 跳过。加上相邻的 MVP 生成和项目表合同文件后，共 22 项通过。 |
| 邻近插件路径 | 写锁、归档、项目表路由及存储、权限矩阵、审计存储、迁移动作、后台试算、大 BOM、自动化入口等文件分别通过。后台试算返回 202 后仍持有活动锁，直至终态结果持久化。 |
| 工作台回归 | 5 个 Vitest 文件共 306 项通过，其中 15 项为删除专项。范围含项目页、工作台、首页、项目目录和删除组件。浏览器截图使用受控合成 API 响应。 |
| 缓存与迁移 | 表元数据缓存专项和相邻用例 14 项通过；迁移发现、闸门和时间戳唯一性测试 29 项通过。源码和编译产物的迁移发现结果均为 494 项。 |
| 配置、构建与契约 | 后端构建通过，备料前端专项类型检查通过，OpenAPI 构建、SDK 生成和契约检查通过，开关清单 92 项通过，仓库 lint 通过。插件清单验证为 13/13，有 9 条警告。 |
| 调度器 | ABSENT、ARCHIVED 及其他 409 的 3 个专项通过。完整文件 40 项中 38 项通过，另外 2 项依赖本地 HTTP 监听，沙箱返回 `listen EPERM`。 |

守卫变异检查分别移除租户绑定、指纹比较、审计行数检查，或放宽专表和旧共享表的归属证明、旧表缓存身份比对、已删项目的调度拦截、前端验证码匹配。对运行记录另有三次独立变异，分别移除旧作业归属、活动作业拒绝和实际删除行数检查。对应测试均出现失败；恢复实现后重跑通过。

## 复验命令

在仓库根目录运行本地专项。

```sh
node --test plugins/plugin-integration-core/__tests__/stock-preparation-project-delete-*.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-dry-run-jobs.test.cjs
node --test --test-name-pattern '409 STOCK_PREPARATION_PROJECT_ABSENT|409 STOCK_PREPARATION_PROJECT_ARCHIVED|any OTHER 409' scripts/ops/__tests__/stock-preparation-scheduled-pull.test.mjs
pnpm --filter @metasheet/web exec vitest run --watch=false tests/StockPreparationProjectDelete.spec.ts tests/StockPreparationProjectBoard.spec.ts tests/StockPreparationWorkspace.spec.ts tests/StockPreparationOperatorHome.spec.ts tests/StockPreparationOperatorProjectDirectory.spec.ts
pnpm --filter @metasheet/web type-check:verification-stock-prep
pnpm --filter @metasheet/core-backend build
pnpm openapi:build
pnpm openapi:guard
```

双登记交付演练会在独立测试库中通过调度器对合成 PLM 适配器执行试拉和写入，通过多维表 HTTP 接口手填一行，再经专用接口预览、确认。它复用原调度配置重跑，核对只收到一次 ABSENT、源读取次数未增加，并以同号重建空表。三种项目状态的矩阵另用固定夹具逐项比较前后数据。该演练已编写，本次未运行。

真实 PostgreSQL 用例已注册在 `plugin-tests.yml` 现有的 real-DB 步骤。在**专用空测试库**设置 `DATABASE_URL` 并使用同一 CI 的迁移和数据库初始化步骤后运行以下命令。环境标记能让缺少数据库 URL 的任务失败，避免把跳过当作通过。

```sh
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/stock-preparation-p4-repair-once-realdb.test.ts
```

本地 PostgreSQL 15 的 `initdb` 在创建共享内存时收到 `EPERM`，Docker 套接字也不可用。数据库用例仅确认已注册并可被 Vitest 收集。迁移实际应用／回滚、安装库权限、并发锁行为、额满释放、大数据量下的占锁时间均需要真实数据库证据。

仓库级 `pnpm validate:all` 在 `tsx` CLI 建立本地 IPC 时被沙箱阻止。使用 `node --import tsx scripts/validate-plugin-manifests.ts` 单独验证了同一清单脚本。继续单独运行 `pnpm type-check`，停在 `apps/web/vite.config.ts` 的 Vite 5/7 插件类型冲突；从上述主线基线提取原配置，配合同一组本地依赖可独立复现。前端应用类型检查和备料专项类型检查均已单独运行。

## 浏览器证据

[预览界面](./assets/stock-preparation-project-delete-20261127/preview.png) · [删除后返回目录](./assets/stock-preparation-project-delete-20261127/success.png)

**指纹边界。** 确认时比较范围、内容及可用的行版本。某条记录在两个请求之间新建又被物理移除，并且所有持久痕迹都消失时，当前方案无法从两次盘点区分这种历史；未把这类瞬时变化作为已通过项。
