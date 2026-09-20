# 数据源删除侧事务化 + FOR UPDATE（PR-A）验证记录

- 日期：2026-09-20（本机 +08:00）
- 分支：`fix/data-source-remove-transactional-lock`，基线 `origin/main` = `0708051ca`
- 设计：`data-source-remove-transactional-lock-design-20260920.md`
- 环境：Windows 11 / Node 25 / pnpm 9.15 / vitest 1.6.1；所有命令在独立 worktree 内执行，主检出未动

## 1. 改动面

| 文件 | 变化 |
|---|---|
| `packages/core-backend/src/data-adapters/DataSourceManager.ts` | `countExternalSystemReferences(id, executor?)`；`removeDataSource` 引用检查 + 软删/硬删合入一个事务，首句 `FOR UPDATE`；409 按 code 透出；无 db 旁路；块注释明确「时序 A 未关闭 / PR-B 待裁」 |
| `packages/core-backend/tests/unit/data-source-remove-ordering.test.ts` | fake db 重构为带执行者标签的有序语句日志 + 真回滚的暂存副本 + 事务记录；既有 9 条用例升级为锁序断言；新增 5 条 W7-B 用例 |
| `packages/core-backend/tests/unit/data-source-scope.test.ts` | fake db 加 `transaction()` 与 `select()/forUpdate()` 直通 |
| `packages/core-backend/tests/unit/data-source-visibility-authority-matrix.test.ts` | 同上 |
| `docs/development/data-source-remove-transactional-lock-{design,verification}-20260920.md` | 本记录 |

未改：`routes/data-sources.ts`、任何迁移、插件、`.github/`。

## 2. 基线红（改源码、未改替身时）

```
pnpm exec vitest run --config vitest.config.ts \
  tests/unit/data-source-remove-ordering.test.ts tests/unit/data-source-scope.test.ts \
  tests/unit/data-source-visibility-authority-matrix.test.ts tests/unit/outbound-sql-write-gate.test.ts
→ Test Files 3 failed | 1 passed (4)
   全部失败根因一致：TypeError: this.db.transaction is not a function
   （outbound-sql-write-gate 的 Proxy 替身吞掉任意方法，因此不红）
```
这就是任务书说的「真正的剩余工作在测试替身」。

## 3. 修替身后：相关 spec 全绿

```
pnpm exec vitest run --config vitest.config.ts tests/unit/data-source-*.test.ts \
  tests/unit/outbound-sql-write-gate.test.ts tests/unit/plm-workbench-datasource-ownership.test.ts
→ Test Files 19 passed (19)
        Tests 350 passed (350)
```
覆盖了 17 个 `data-source-*` spec（含所有引用 `routes/data-sources` 的相邻 spec）+ 两个引用 `removeDataSource` 的邻居。

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit
→ exit 0
```

## 4. 变异自证（内存级，源码盘上不动）

方法：一份**未提交**的 vitest 配置（`w7ba-mutation.vitest.config.ts`，运行后已删除；副本留在会话 scratchpad）在 vite `transform` 钩子里按环境变量 `W7BA_MUTATION` 对 `DataSourceManager.ts` 做字符串替换。每个锚点必须命中且唯一，否则该次运行直接抛错——变异没打中就没有证据。检出是 CRLF（`core.autocrlf=true`），转换前先归一到 LF。目标 spec：`data-source-remove-ordering.test.ts`（17 条，未变异时 17/17 绿）。

| # | 变异（等价于源码改动） | 结果 | 变红的守卫（节选） |
|---|---|---|---|
| M0 | `this.db.transaction().execute(cb)` → 直接在 `this.db` 上跑 cb（不开事务） | **10 failed / 7 passed** | 所有 `@trx` 顺序断言、`transactions` 长度、①、写失败回滚 |
| M1 | 删掉 `.forUpdate()` | **8 failed / 9 passed** | 顺序断言首项由 `for-update:` 变为 `select:data_sources:`，含路由 happy path |
| M2 | `const db = executor ?? this.db` → `const db = this.db` | **6 failed / 11 passed** | ②「计数在同一 trx」、所有含 `count:*@trx` 的顺序断言；②-敏感性用例因变异而转绿（它断言的正是 `@db`），证明 fake 分得清执行者 |
| M3 | 计数提到事务之前（检查与写不再原子） | **8 failed / 9 passed** | 顺序断言（`count@db` 出现在 `for-update` 之前）、①（事务数为 0）、失败计数不再走 500 翻译 |
| M4 | 删掉 409 按 code 透出（409 被翻译成 500） | **3 failed / 14 passed** | 单元层三条 409 用例（含 ①）；路由层 409 用例保持绿——路由自己的顾问性预计数已先返回 409，符合设计 §2 |
| M5 | 事务内先写后计数 | **8 failed / 9 passed** | ①（`soft-delete` 被发出）、`writes` 为空断言、顺序断言 |
| M6 | 删掉无 db 旁路里的计数 | **1 failed / 16 passed** | 仅 ③（纯内存 manager：spy 计数为 3 时不再 409） |

每条新守卫至少被一个变异证明会红；每个变异至少让一个守卫红。M4 的路由层结果同时证明「路由预计数」与「事务内计数」是两道门，删掉后者的透出只影响直接调用 manager 的路径。

## 5. 卫生检查

```
git diff origin/main | grep -cP '\x08'   → 0   （Edit 工具 \b 退格陷阱）
git diff | grep -cP '\r'                 → 0   （CRLF 噪声）
git status --short                       → 仅 4 个 M 文件 + 2 个新 docs；变异配置已删除
```
values-free：改动与文档不含主机 / IP / 口令 / appKey / 租户 id；测试里的 `DRIVER_POISON` 是 #5784 既有的**伪造**驱动文案，用来断言它不外泄。

## 6. 残余与未覆盖（如实）

- **时序 A（删除在前、绑定在后）未关闭**：需 PR-B 的 live-only FK；PR-B 改 `force` 语义，待 owner 三选一（设计 §6）。
- **legacy 形态（`config.dataSourceId`，无 FK）** 的「绑定在飞」竞态不受本刀保护；只有已提交的 legacy 绑定会被事务内计数看见。
- **42P01 在事务内变为 fail-closed**（500 而非 0）：迁移 057 保证表存在，属姿态变化非活路径；保住 fail-open 需 SAVEPOINT，留 PR-B。
- **未做真 PG 端到端并发复跑**：本刀的锁序与 READ COMMITTED 论证沿用残件在 PG 16.9 上的实证（设计 §3），本轮只做替身级与变异级验证；PR-B 落地时应把时序 A/B 两个脚本一并做成 realdb 泳道用例。
- **不计数的其它指针表**（stock-prep source binding 等）仍在删除守卫视野之外，既有缺口。
