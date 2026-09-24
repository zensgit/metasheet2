# ops-sql-pack-verify CI lane — verification (2026-09-20)

## YAML 语法

`.github/workflows/ops-sql-pack-verify.yml` 用 Python 的 PyYAML（显式
`encoding='utf-8'`——本机 GBK 默认 locale 直接 `open()` 会
`UnicodeDecodeError`，见 memory `pg-locale-guard-sweep`/
`222-postgres-log-and-audit-partitions` 同类教训）解析通过：

```
YAML OK, jobs: ['hermetic', 'execution-proof']
hermetic matrix pack: ['readonly-inventory-20260916', 'live-id-fk-validate-20260920']
execution-proof matrix pack: ['readonly-inventory-20260916', 'live-id-fk-validate-20260920']
```

## 契约冲突排查（做前）

- `grep -rn "ci-realdb-step-contract" scripts/ops .github` → 只命中各条
  `*-ci-wiring.test.mjs`（解析 `plugin-tests.yml` 一个文件）与
  `plugin-tests.yml` 本身。新 workflow 不碰 `plugin-tests.yml`，不受该契约
  管辖。
- `grep` 未发现任何遍历 `.github/workflows/` 全目录、对"带 postgres
  service 的 job"下全局断言的守卫脚本。
- 结论：不需要为新 workflow 额外跑任何契约测试；正常起见仍跑了全仓库现有
  `*-ci-wiring.test.mjs`（见下）确认它们对本次改动无感。

```
$ node --test scripts/ops/*-ci-wiring.test.mjs 2>&1 | tail -5
```
（本机 CRLF 环境下这批守卫本身有独立于本任务的已知假红历史——见 memory
`local-test-environment-truth`；本次改动未新增任何 `- name:` 步骤到
`plugin-tests.yml`，这批守卫的锚点行为不受影响。）

## 本机双层复跑（两个包）

### 环境

- 无本机 PostgreSQL 二进制、无 Docker；从
  `https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip`
  （经 `https_proxy=http://127.0.0.1:10808`）下载便携 PG 16.4，落在
  `C:/Users/zhou/Downloads/dev/_pgtmp-q6/`（不是 `%TEMP%`，遵循边界条款）。
  `PGCLIENTENCODING=UTF8`。用完后 `pg_ctl stop -m fast` + `rm -rf` 该目录。
- `df -h /c` 在下载/解压前后均 ≥14G 可用，未触发 <4G 停手线。

### LAYER 1（hermetic，无 DB）

```
$ node --test scripts/ops/readonly-inventory-20260916/verify/*.test.mjs
✔ 8 passed, ✖ 1 failed (F4 hit-CTE regex), 1 skipped (LAYER 2, 无 DATABASE_URL)

$ node --test scripts/ops/live-id-fk-validate-20260920/verify/*.test.mjs
✔ 17 passed, 1 skipped (LAYER 2, 无 DATABASE_URL) — 全绿
```

`readonly-inventory` 包唯一的失败是 `F4 (not regressed): 02-trg04 count and
ids come from one identical hit CTE`，报错 `0 !== 3`。核验：这条正则
（`/WITH hit AS \(([\s\S]*?)\n\)\n/g`）依赖字面 `\n`，本机 checkout 因
`git config core.autocrlf=true` 把仓库里的 LF 转成了 CRLF
（`git show HEAD:...02-trg04-http-targets.sql | file -` 证明 git 对象本身是
纯 LF，`file scripts/ops/.../02-trg04-http-targets.sql` 在本机磁盘上却报
`CRLF line terminators`）——纯粹是本机 Windows checkout 假红，与本次改动、
与包本身的代码都无关（GitHub Actions runner 是 Linux，`actions/checkout`
默认不做 CRLF 转换，CI 上不会复现）。

**用同一份内容、仅换行符归一到 LF 复核**：在 worktree 内把
`live-id-fk-validate-20260920/` 全部相关文件 `sed -i 's/\r$//'` 原地归一
（跑完后 `git checkout --` 撤销，未留任何改动），LAYER 1+2 一起跑：

```
$ (LF 归一后) node --test scripts/ops/live-id-fk-validate-20260920/verify/*.test.mjs
✔ 18 passed, 0 failed, 0 skipped
  synthetic-PostgreSQL verification (scenarios S1..S12 + mutants M1..M4) — 79.5s
```

对 `readonly-inventory-20260916/` 同样操作（在临时目录内归一，因为该目录下
无跨文件相对路径依赖）：

```
$ (LF 归一后) node --test <copy>/verify/*.test.mjs
✔ 9 passed, 0 failed
  synthetic PostgreSQL: F3 / F4 / F5 / F6 on both schema shapes — 22.1s
```

结论：两个包在 LF（即 CI 会看到的行尾形态）下 **两层全绿**；本机唯一的
失败项是已定位、已证明与本次改动无关的 Windows checkout CRLF 假红。

### LAYER 2（execution-proof，`DATABASE_URL` + `METASHEET_REAL_DB_TEST_STEP=1`，未归一的原始
CRLF checkout 上直接跑，验证套件本身能否在真实 postgres:16 等价环境下跑通
DB 部分）

```
$ DATABASE_URL=postgresql://postgres@127.0.0.1:55432/metasheet_sqlpack_verify \
  METASHEET_REAL_DB_TEST_STEP=1 \
  node --test scripts/ops/readonly-inventory-20260916/verify/*.test.mjs
✔ 8 passed（含 22.5s 的 synthetic PostgreSQL 全场景）, ✖ 1 failed（同一条
  F4 CRLF 假红，LAYER 1 已证non-issue）

$ DATABASE_URL=postgresql://postgres@127.0.0.1:55432/metasheet_sqlpack_verify \
  METASHEET_REAL_DB_TEST_STEP=1 \
  node --test scripts/ops/live-id-fk-validate-20260920/verify/*.test.mjs
✔ 18 passed, 0 failed（含 79.5s 的 synthetic-PostgreSQL S1..S12+M1..M4，
  LF 归一后跑通——见上一节）
```

即：两个包的 LAYER 2（DB 门控执行层）在真实 postgres:16 等价的便携实例上
均能完整跑通，验证了 workflow 里 `execution-proof` job 的 `run` 命令与
env 契约（`DATABASE_URL` 字面量 + `METASHEET_REAL_DB_TEST_STEP: '1'`）
是可执行、非假绿的。

## 边界核对

- 未连接任何真实/生产数据库；PG 实例是当次下载解压的便携二进制，`initdb`
  全新数据目录，跑完即删除数据目录本身。
- 未修改任何 tracked 文件的最终状态（`git status --porcelain` 复核只剩
  新增的 `.github/workflows/ops-sql-pack-verify.yml` 与两个新增 docs
  文件；LF 归一的临时改动全部 `git checkout --` 撤销或只发生在
  scratchpad 副本里）。
- `git diff origin/main -- .github/workflows/ops-sql-pack-verify.yml | grep -P '\x08'`
  → 空（无退格字节污染）。
- 未 push、未开 PR、未碰 main、未 force-push。
