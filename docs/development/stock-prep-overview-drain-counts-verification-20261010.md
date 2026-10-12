# 项目总览刷新计数修复与验证 — 2026-10-10

刷新期间收到的事件会由同一次 writer 排空并更新总览，但此前刷新返回值和审计只包含首轮计数。这会遗漏成功更新、未变更判断、重复行/孤儿行删除以及后续计数读取。本修复在 writer 完成后合并一次 drain summary，成功响应与 `REFRESH_INCOMPLETE` 审计使用同一份完整计数。

范围沿用 [项目表 ADR §5 / R-37](takeover-beiliao-20260821/adr-stock-prep-project-sheets-20261008.md)。基线为 `9bbbdb29e352527b93164490d17f759d321ddb68`，分支为 `codex/overview-drain-counts-20261010`。Sol 6.1 实现和测试，Astra 独立审阅，父级复核与提交。

## 计数契约与设计

| 字段 | 含义 |
| --- | --- |
| `projectCount` | 首轮有界登记行快照的数量；不累加 drain |
| `countedCount` / `unreadableCount` | 成功/未成功的计数读取尝试；同一项目可贡献多次，计数发生在随后写入之前 |
| `boundedCount` | 成功读取达到分页上限的次数，属于 `countedCount` 的子集 |
| `rowsCreated` / `rowsUpdated` / 删除计数 | 已成功完成的对应操作次数；失败的操作不计入 |
| `rowsUnchanged` | 已完成的无需修改判断次数；不是物理写入数 |

三个读取计数不是去重后的项目数；行操作计数也不是最终行数。排空时某次写入失败，其他已经完成的操作仍计入 incomplete 审计。合并发生在 busy 拒绝之后、最终成功/不完整判断之前，无新增重试、查询或写入。

首轮审阅发现旧页面文案把 `unreadableCount` 当成项目数，并断言数字未更新。本次将中英文提示改为失败读取的次数，并提示查看各项目的「截至」时间。同一项目两次失败可返回 `projectCount=1, unreadableCount=2`；首次失败、后续成功仍保留一次失败尝试，但不再误报最终数字未更新。

错误 HTTP details 仍仅为原有的 `objectId`、`failedProjectCount`、`projectCount`；summary/cause 不进入 HTTP 错误响应。开关关闭、锁冲突、权限、失败项目的 dirty 标记沿用现有行为。无新开关、迁移或外部系统动作。

## 验证结果

本地 Node.js `v24.14.1`、pnpm `10.33.0`，复用已安装依赖。以下为合成数据和隔离测试，不能替代部署或客户验收。

| Gate | 结果 |
| --- | --- |
| 后端 overview 整文件 | Sol 与 Astra 分别运行，均 **38/38** |
| 前端 overview 整文件 | Sol 与 Astra 分别运行，均 **37/37** |
| 相邻 project-reads / project-target-routes | 退出码 **0**；project-reads **5/5** |
| 相邻 operator-home | **94/94** |
| 最终 `pnpm validate:all` | 退出码 **0**，含插件验证、lint、类型检查 |
| sealed-export package provenance | 整文件测试退出码 **0**；未修改冻结 pins |
| 测试链登记 | **243** 个套件已登记、0 个有意排除；这不是本地执行全部 243 个套件 |
| 读取计数变异 | 不合并 `unreadableCount` → 后端 **36 通过 / 2 失败**（O-27、O-29e） |
| 首轮遗漏基线 | 最终后端测试加载未修复模块 → **33 通过 / 5 失败**（O-20、O-26b、O-27、O-29c、O-29e） |
| 旧文案变异与恢复 | 前端 **34 通过 / 3 失败**；恢复保存字节后 **37/37** |
| Astra 最终审阅 | **approve**，首轮 P2 已解决；新增 P1/P2 均为 **0** |
| 真实组件浏览器验证 | 中英文各验证 2 个失败次数场景；无业务 API/外部请求、无 page error |
| 并行 #6318 兼容性 | 自动合并成功；组合后的 plugin overview **43/43** |
| CI 接线 | backend chain 一次登记；frontend 两点均命中，变更分类为 relevant |
| 合并、部署、迁移、开关启用 | 本次未执行 |

主要命令：

```bash
node plugins/plugin-integration-core/__tests__/stock-preparation-project-overview.test.cjs
pnpm --filter @metasheet/web exec vitest run --watch=false tests/StockPreparationProjectOverview.spec.ts
node plugins/plugin-integration-core/__tests__/stock-preparation-project-reads.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-project-target-routes.test.cjs
node plugins/plugin-integration-core/__tests__/test-chain-completeness.test.cjs
node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
pnpm --filter @metasheet/web exec vitest run --watch=false tests/StockPreparationOperatorHome.spec.ts
pnpm validate:all
```

`integration-guard.yml` 实际调用 plugin test chain 和 `scripts/ops/integration-guard-run-web-specs.sh`；后者与 `apps/web/scripts/run-required-web-tests.sh` 都包含唯一的 `StockPreparationProjectOverview` 执行 token。无需修改 workflow 或链表。接线证明与远端运行结果分开；远端 CI 应核对关联 PR 当前 head 的真实步骤，不能从本地结果推断。

并行验证固定 #6318 head 为 `9f396f26c4e3bc854a460ccbdfc35428bfb04f79`，组合 tree 为 `74bde2f764ac936a9055933f0952a7bd850d792a`。43 个用例仅验证组合 plugin 子树的 overview 套件，其他依赖来自冻结基线；不构成整个 #6318 的审阅或上线验收。未修改该 PR。

## 冻结的审阅字节

| 文件 | SHA-256 |
| --- | --- |
| `plugins/plugin-integration-core/lib/stock-preparation-project-overview.cjs` | `dd19d09ba05a9cda9ef8b5832e91574050009a66a0b0f83beb4bbb43235376ae` |
| `plugins/plugin-integration-core/__tests__/stock-preparation-project-overview.test.cjs` | `52553b4cf4f526f5aca1fcbacb90a9a76bffb49f8d0f4cc4ee89ced151512722` |
| `apps/web/src/services/integration/stockPreparation/plainLanguage.ts` | `71de7cd39e8dbebaebec00ce358a94360190d2ef5022facc4c42c3e3eb414e96` |
| `apps/web/tests/StockPreparationProjectOverview.spec.ts` | `8018f02796e60fbc1f9590991e652c53f7757b9e1a3070a655ce5b4c105d2232` |

原始日志、变异恢复记录、两轮审阅、组合验证和浏览器 receipt 留在本任务的私有 `artifacts/overview-drain-counts-20261010/`。仅下面两张合成数据截图随 PR 保存；它们由真实 `StockPreparationOperatorHome.vue` 和注入的合成 targetApi 渲染，不是 staging 截图。

![中文：一个项目，两次失败的读取尝试](../../artifacts/overview-drain-counts-20261010/screenshot-zh.png)

![English: one project, two failed count reads](../../artifacts/overview-drain-counts-20261010/screenshot-en.png)
