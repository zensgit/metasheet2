# 审批表单分组 Phase 1 — u3(CI 接线 + s6a 重钉)验证记录

- 锁文:`approval-form-group-entity-design-lock-draft-20260916.md`(RATIFY,行号锚点基线 `85ddd2926`)
- 任务书:`impl-taskbook-A-grouping-20260918.md` §3 CI 接线清单
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` #1–#3
- 子单元:u3「CI 接线 + s6a 重钉」
- worktree HEAD(§1–§9 原始记录时):`dba46e7c1ad5c6092943029e96d8f5ad30c11f42`(分支 `feat/approval-template-groups-phase1-u3`,当时未提交)
- worktree HEAD(§10 二次核验的起点,即本节改动前的父提交):`fbcf62caa08fc429d3158c77bfab4d0d2e7bc8f3`
- 本节(§10)自身所在提交:`a2254950a`(见 §10.1 末尾的逐字 diffstat 核对)
- `origin/main`:`23dfdf417686b931a515bf03abbce1d6471c3098`
- 环境:node `v25.9.0`,python3 `/usr/bin/python3` `Python 3.9.6`
- **§5 的「45」计数已被 §10 核实为错误,原句保留但视为已撤回,更正值见 §10.3**

## 1. CI 接线 #1 — `vitest.config.ts` exclude

追加两条到 `packages/core-backend/vitest.config.ts` 的 `test.exclude` 数组:

- `tests/integration/approval-template-groups-lifecycle.db.test.ts`
- `tests/integration/approval-template-groups-serialization.db.test.ts`

用仓内既有的 `scripts/ops/ci-realdb-step-contract.mjs` 导出函数核对(而非肉眼读 diff):

```
$ node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { isQuotedInTestExclude } from './scripts/ops/ci-realdb-step-contract.mjs';
const cfg = readFileSync('packages/core-backend/vitest.config.ts', 'utf8');
for (const f of [
  'tests/integration/approval-template-groups-lifecycle.db.test.ts',
  'tests/integration/approval-template-groups-serialization.db.test.ts',
]) { console.log(f, isQuotedInTestExclude(cfg, f)); }
"
tests/integration/approval-template-groups-lifecycle.db.test.ts true
tests/integration/approval-template-groups-serialization.db.test.ts true
```

## 2. CI 接线 #2 — `plugin-tests.yml` 显式清单

两文件追加进「Run approval real-DB integration tests」步骤(`approval-real-db-integration`,`test (20.x)` 必需 leg 上执行)的 whole-file vitest 参数列表,紧跟在既有
`tests/integration/approval-lock9-process-attachments-realdb.db.test.ts` 之后。用同一模块的 `isSuiteWiredInRealDbStep` / `REAL_DB_STEP_IDS` 核对落点(而不是只核对字节存在,还核对没有落进 multitable 步骤):

```
$ node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { REAL_DB_STEP_IDS, isSuiteWiredInRealDbStep } from './scripts/ops/ci-realdb-step-contract.mjs';
const wf = readFileSync('.github/workflows/plugin-tests.yml', 'utf8');
const files = [
  'tests/integration/approval-template-groups-lifecycle.db.test.ts',
  'tests/integration/approval-template-groups-serialization.db.test.ts',
];
for (const f of files) {
  console.log(f, '=> approval step:', isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.approval, f));
  console.log(f, '=> multitable step (must be false):', isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.multitable, f));
}
"
tests/integration/approval-template-groups-lifecycle.db.test.ts => approval step: true
tests/integration/approval-template-groups-lifecycle.db.test.ts => multitable step (must be false): false
tests/integration/approval-template-groups-serialization.db.test.ts => approval step: true
tests/integration/approval-template-groups-serialization.db.test.ts => multitable step (must be false): false
```

`isSuiteWiredInRealDbStep` 内部核验的是该步骤的四钉可执行性(`if: matrix.node-version == '20.x'` + `env.DATABASE_URL` + `vitest.integration.config.ts` + whole-file 参数),不是裸文本包含。

## 3. `vitest.config.ts:42-45` 在地惯例的覆盖(补充清单 #2)

`vitest.config.ts` 该处注释原话是「excluded from the no-DB job … / NOT plugin-tests.yml (s6a sha256-pinned provenance input)」——本次追加的两个文件**故意覆盖**这条在地惯例,因为锁 §6 已裁定分期 1 的两个新真库套件进 `plugin-tests.yml`(唯一经 `test (20.x)` required 的真库步骤)。已在 `vitest.config.ts` 对应位置写入覆盖说明(见该文件 diff 中的注释块),不是静默偏离。

## 4. CI 接线 #6 — s6a sha256 重钉

`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的 `evidenceFiles.pluginTestsWorkflow` 覆盖 `.github/workflows/plugin-tests.yml` 的整文件字节 sha256(见
`sealed-export-package-provenance.cjs:298-310`,`sha256File` 对文件字节原样 hash,无归一化)。改动 #2 动了该文件字节,必须重算。

不是手工 `sha256sum`,而是用仓内同一份计算逻辑(`computePackageProvenancePinSet`,与验证器共享同一 `sha256File`)现算并与已写入清单里的值逐字比对:

```
$ node -e "
const m = require('./plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs');
const pins = m.computePackageProvenancePinSet(process.cwd());
const staged = require('./plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json');
console.log('computed:', pins.evidenceFiles.pluginTestsWorkflow);
console.log('match:', pins.evidenceFiles.pluginTestsWorkflow === staged.evidenceFiles.pluginTestsWorkflow);
"
computed: f08ea1addb3fd5f22ed1aa67624e2d746faedcdc87b432c7f7517ddc73801a6b
match: true
```

**时效性披露(任务书 :244)**:此值只对**本 worktree HEAD 当前的 `plugin-tests.yml` 字节**成立。若在 Draft PR A 合并之前 main 上有任何其他 PR(哪怕与本线无关)先改动了 `plugin-tests.yml`,这枚 sha256 钉会失效,必须在**准备合并前**重新跑上面这条命令再核一次——不能假设起草时的值到合并时仍然有效。合并前的重算不在本子单元范围内(u3 只做起草期这一次)。

## 5. 补充清单 #1 —「新文件必须逐个普查」的机械核对结果

`scripts/ops/ci-realdb-step-contract.mjs:99-102`(`REAL_DB_STEP_IDS`)本身不含 `FILES` 数组;该数组存在于消费方——45 个 `*-ci-wiring.test.mjs` 之中,每个 family 各自持有并各自被 `plugin-tests.yml` 显式 `run:` 一次(**不是** glob 自动发现;逐个核实见下)。

普查结果(两条独立证据):

1. **零覆盖**——`approval-template-groups` 未出现在任何既有 `*-ci-wiring` 家族的源码或运行输出里:
   ```
   $ grep -rl "approval-template-groups" scripts/ops/*.mjs
   (无输出)
   ```
2. **全量兄弟套件回归**(`node --test scripts/ops/*-ci-wiring.test.mjs`,476 个测试,120.6s):
   ```
   ℹ tests 476
   ℹ pass 475
   ℹ fail 1
   ```
   唯一失败:`scripts/ops/elearning-v01-auth-ci-wiring.test.mjs`,`Error: ... spawnSync python3 ETIMEDOUT`(476 个测试并发抢 `python3` 子进程导致的资源竞争超时,与本次改动无关——单独重跑该文件:
   ```
   $ node --test scripts/ops/elearning-v01-auth-ci-wiring.test.mjs
   ℹ tests 3
   ℹ pass 3
   ℹ fail 0
   ```
   3/3 通过,确认是环境瞬态,不是本次改动引入的回归)。其余 475 个测试(含 `t2-source-freeze-ci-wiring.test.mjs`、`t2gate-collision-mechanism-ci-wiring.test.mjs` 里「both real-DB steps in plugin-tests.yml carry their stable ids and satisfy all four pins」这类跨步骤全量断言)全绿——说明本次在 approval 真库步骤里新增的两个 whole-file 参数没有破坏任何既有兄弟守卫。

**结论(披露,不是掩盖)**:目前**没有任何已存在的 CI 守卫**会在未来有人不慎从 `plugin-tests.yml`/`vitest.config.ts` 移除这两个文件的接线时报红——这是一个真实的、未收口的闭世界缺口,而不是「补充清单 #1 已解决」。收口方式是新增一个专属 `scripts/ops/approval-template-groups-ci-wiring.test.mjs`,但该模式下每个 `*-ci-wiring.test.mjs` 都需要在 `plugin-tests.yml` 里再加一个显式 `- name: ... / run: node --test scripts/ops/<file>` 步骤才会被执行(不是自动发现——已用 `grep -n "ci-wiring" .github/workflows/*.yml` 核实：45 个守卫文件对应 45 处独立 `run:` 调用,无 glob)。这与「另建 `.github/workflows/plugin-tests.yml` 的第 7 处步骤改动」等价,超出 u3 名下「显式清单(两文件)+ s6a 重钉」这两处改动的范围,且会使本节 §4 刚核验过的 s6a 钉再次失效(合并前还要再重算一次)。**故本子单元不新建该守卫文件,留作后续单元或 owner 裁决的披露残留**,不归入「已完成」。

同时否决的备选方案:把两文件塞进既有 `scripts/ops/approval-data-closure-ci-wiring.test.mjs` 的 `files` 数组——该文件的名字与自带注释明确把自己限定在 attachment/data-closure 家族(`approval-attachment-*` + 两个 multitable FWB 定点),塞入语义不相关的分组套件是「另造同类物即合同变更」同族的 scope drift,且该文件不在 u3 名下的文件集里,未采用。

## 6. 验收 I(本地 diff 取证,任务书 :190)

锁文/任务书裁定验收 I「不进 CI」,要求的是**本地(非 CI)** 的一次性 diff 取证,贴入 PR 验证 MD,且**不得为其新建测试文件**:

```
$ MB=$(git merge-base origin/main HEAD); echo "merge-base=$MB"
merge-base=d944a1276a65b01a33701486b31b7b3eddf588ae

$ git diff --exit-code "$MB"..HEAD -- \
    packages/core-backend/src/multitable/automation-service.ts \
    packages/core-backend/src/multitable/automation-approval-template-access.ts
(无输出)

$ echo "exit=$?"
exit=0
```

`git diff --exit-code` 无输出本身不是证据——退出码才是:`exit=0` 表示自 `origin/main` 分叉点（`d944a1276a65b01a33701486b31b7b3eddf588ae`）到本 worktree HEAD（`dba46e7c1ad5c6092943029e96d8f5ad30c11f42`）之间,这两个 multitable 自动化源文件**逐字节零改动**——分组 phase 1 的实现没有触碰这条平行路径,满足验收 I。未为此新建测试文件。

**存在性正控(§10 补,原始记录漏做)**:`git diff --exit-code A..B -- <path>` 对一个两端都不存在的路径同样退出 0——「无输出 + exit=0」本身不能区分「零改动」与「该路径压根不在树里」。用 `git cat-file -e` 证明两个路径在 HEAD 确实存在:

```
$ git cat-file -e HEAD:packages/core-backend/src/multitable/automation-service.ts && echo "automation-service.ts: exists"
automation-service.ts: exists
$ git cat-file -e HEAD:packages/core-backend/src/multitable/automation-approval-template-access.ts && echo "automation-approval-template-access.ts: exists"
automation-approval-template-access.ts: exists
```

两文件均存在,§6 的 `exit=0` 因此确实是「逐字节零改动」而非「路径不存在时的假阳性」。同时把 diff 与退出码核对合成一条复合命令重跑(消除跨两次 shell 调用的 `$?` 语义漂移):

```
$ MB=$(git merge-base origin/main HEAD); git diff --exit-code "$MB"..HEAD -- \
    packages/core-backend/src/multitable/automation-service.ts \
    packages/core-backend/src/multitable/automation-approval-template-access.ts; echo "exit=$?"
exit=0
```

## 7. 本次改动清单(u3 名下文件集,截至本记录)

```
$ git diff --stat origin/main..HEAD -- \
    packages/core-backend/vitest.config.ts \
    .github/workflows/plugin-tests.yml \
    plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
```

- `packages/core-backend/vitest.config.ts` — exclude 两条 + 覆盖惯例注释
- `.github/workflows/plugin-tests.yml` — approval 真库步骤 whole-file 参数追加两条
- `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` — `pluginTestsWorkflow` 重钉(§4 已核验)

## 8. 本地复现 CI 接线的真实调用(私有 DB)

除 §1/§2 的静态核对外,另在私有库 `metasheet2_lock_a_u3` 上原样复现了 `plugin-tests.yml` 里 approval 真库步骤对这两个文件的调用形态(同一 `vitest.integration.config.ts`、同一 `--reporter=dot`):

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a_u3" pnpm exec tsx src/db/migrate.ts
(无输出 — 迁移已是最新,幂等)

$ DATABASE_URL="postgres://localhost/metasheet2_lock_a_u3" pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    --reporter=dot
✓ tests/integration/approval-template-groups-lifecycle.db.test.ts (13 tests | 1 skipped) 3012ms
✓ tests/integration/approval-template-groups-serialization.db.test.ts (10 tests | 1 skipped) 1320ms
Test Files  2 passed (2)
     Tests  21 passed | 2 skipped (23)
```

两文件在真实 Postgres 下均可被 CI 接线里那条命令逐字执行且全绿(21 passed / 2 skipped,0 failed)——不只是「路径存在」的静态断言,是端到端复现。跳过的 2 条不属于 u3 范围(测试内容/skip 条件由实现分组服务与端点的单元负责,此处只作为「接线可执行」的佐证,不对测试内容本身背书)。

## 9. 未完成 / 披露残留

- **补充清单 #1 的闭世界缺口未收口**(见 §5,计数已在 §10.3 更正):需要新建 `scripts/ops/approval-template-groups-ci-wiring.test.mjs` + `plugin-tests.yml` 新增一个 `run:` 步骤,超出 u3 本次名下文件集,留给后续单元或 owner 裁决是否现在做。
- **s6a 钉的时效性**(见 §4):合并前必须对当时的 `plugin-tests.yml` 字节重算一次,不能沿用本记录里的值。

## 10. 二次核验(同一子单元,续做;不新增 wiring 改动)

§1–§9 是起草期(worktree HEAD `dba46e7c1`)的原始记录,随后与 §2/§4 的 `plugin-tests.yml`/`vitest.config.ts`/s6a 钉改动一起提交为 `fbcf62caa`(本节写入前的 HEAD)。本节在**不改动任何 wiring 文件**的前提下,补做 advisor 复核指出的三处欠证,并核对任务书 CI 接线 #7。

### 10.1 §6 的 HEAD 是否仍然成立

`fbcf62caa` 自身的 diff 只触碰 `.github/workflows/plugin-tests.yml`、`packages/core-backend/vitest.config.ts`、`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 与本文档,不触碰 §6 点名的两个 multitable 源文件(逐字核对下方 diff --stat 的路径列表):

```
$ git show --stat fbcf62caa | tail -n +5
 .github/workflows/plugin-tests.yml                 |   2 +
 ...template-groups-phase1-verification-20260918.md | 171 +++++++++++++++++++++
 packages/core-backend/vitest.config.ts             |  18 +++
 .../vectors/s6a-package-provenance-pins.json       |   2 +-
 4 files changed, 192 insertions(+), 1 deletion(-)
```

四个改动路径中没有 `automation-service.ts` / `automation-approval-template-access.ts`,所以 §6 在 `dba46e7c1` 处核验过的「零改动」结论,在当前实际 HEAD `fbcf62caa` 处**依然成立**(把 §6 的复合命令换成 `origin/main..fbcf62caa` 重跑一次,与 §6a 的 `origin/main..HEAD` 是同一个结果,因为期间唯一的中间提交没碰这两个文件):

```
$ git diff --exit-code origin/main..fbcf62caa -- \
    packages/core-backend/src/multitable/automation-service.ts \
    packages/core-backend/src/multitable/automation-approval-template-access.ts; echo "exit=$?"
exit=0
```

**这一句本身也不能只用「即将怎样」的承诺来写**——上一版在提交发生前就断言了它的效果,而验证纪律的教训正是「verdict 必须绑 SHA」,不能靠预告。§10(本节)实际落地为提交 `a2254950a` 之后,现场核对该提交的 diffstat:

```
$ git show --stat a2254950a | tail -n +5
 ...template-groups-phase1-verification-20260918.md | 121 ++++++++++++++++++++-
 1 file changed, 119 insertions(+), 2 deletions(-)
```

`a2254950a` 改动的唯一路径就是本文档,不含 `vitest.config.ts` / `plugin-tests.yml` / s6a 钉三者中任何一个字节——这是**已发生的核对结果**,不是写在提交之前的预告。因此 §4 的 s6a 值与 §1/§2 的接线核对结果在 `a2254950a` 之后依然成立,回归终止于此。若再有下一次追加编辑,须对那次追加编辑重复同样的「diffstat 落地后再核对」顺序,不能重犯本节修正前的错误(先写「将不失效」,后才提交)。

### 10.2 任务书 CI 接线 #7 — 分支保护 required contexts(push 前核对,不得沿用锁文数字)

```
$ gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.contexts | length, .[]'
13
contracts (strict)
contracts (dashboard)
pr-validate
test (20.x)
contracts (openapi)
web-tests
stock-prep PowerShell 5.1 acceptance
attendance-web-guard
integration-guard
ssh host-key pin contract (fail-closed known_hosts)
observation-kit contract (read-only SQL census + runbook gating)
recovery-schema-drift
Approval browser verify (chromium)
$ gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.strict'
false
```

2026-09-17 快照:13 个 required contexts(与锁文引用的 2026-09-17 快照数字一致,`strict=false`),`test (20.x)` 在列、`test (18.x)` 不在列——本单元 §1/§2 把两个新真库套件钉进「唯一经 `test (20.x)` required 的真库步骤」这条前提,在 push 前重新核验后依然成立。这是本子单元自己 push 前的核对,不代表合并时刻仍然成立(合并前要再核一次,与 §4 的 s6a 时效性披露同理)。

### 10.3 更正 §5 的「45」— 机械计数

§5 原句「该数组存在于消费方——45 个 `*-ci-wiring.test.mjs`……每个 family 各自持有并各自被 `plugin-tests.yml` 显式 `run:` 一次(不是 glob 自动发现)」与「45 个守卫文件对应 45 处独立 `run:` 调用,无 glob」两处「45」均为**未经命令核实的估计数**,现场重数:

```
$ ls scripts/ops/*-ci-wiring.test.mjs | wc -l
      38
$ grep -oE 'scripts/ops/[A-Za-z0-9_-]+-ci-wiring\.test\.mjs' .github/workflows/plugin-tests.yml | sort -u | wc -l
      36
$ comm -23 <(basename -a scripts/ops/*-ci-wiring.test.mjs | sort -u) \
           <(grep -oE '[A-Za-z0-9_-]+-ci-wiring\.test\.mjs' .github/workflows/plugin-tests.yml | sort -u)
approval-browser-ci-wiring.test.mjs
stock-prep-browser-ci-wiring.test.mjs
$ grep -rl "approval-browser-ci-wiring\|stock-prep-browser-ci-wiring" .github/workflows/
.github/workflows/approval-browser-verify.yml
.github/workflows/stock-prep-browser-verify.yml
```

更正后的准确形状:仓内 `*-ci-wiring.test.mjs` 家族共 **38** 个文件,其中 **36** 个在 `plugin-tests.yml` 的无 DB `test` job 里各有(或共享)一条 `run: node --test …` 调用,另外 **2** 个(`approval-browser-ci-wiring.test.mjs`、`stock-prep-browser-ci-wiring.test.mjs`)根本不在 `plugin-tests.yml` 里,而是各自被独立的 `approval-browser-verify.yml` / `stock-prep-browser-verify.yml` 调用。「1 个守卫文件 = 1 处独立 `run:`」这句也不是严格 1:1——`t2gate-collision-mechanism-ci-wiring.test.mjs` 那一步(`.github/workflows/plugin-tests.yml:505`)把它与 `t2gate-runbook-values-free-contract.test.mjs` 两个文件合在同一条 `run: node --test a.test.mjs b.test.mjs` 里执行。

**这处更正不改变 §5/§9 的实质结论**:无论准确计数是 38/36/2 还是原句声称的 45,§5 的核心断言——`grep -rl "approval-template-groups" scripts/ops/*.mjs` 零命中,即没有任何现存 `*-ci-wiring` 守卫覆盖这两个新文件——不依赖这个数字,该 grep 本身已单独给出且未受影响。「45」是伴随性的背景计数错误,不是被撤回的判定;更正它是因为**记忆**「绝对断言自扫必须机械化」要求所有全称/计数断言必须挂命令,不能靠估读。

### 10.4 私有 DB 复跑(新鲜时间戳,确认未回归)

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a_u3" pnpm exec tsx src/db/migrate.ts
(无输出 — 迁移已是最新,幂等)
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a_u3" pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    --reporter=dot
Test Files  2 passed (2)
     Tests  21 passed | 2 skipped (23)
```

与 §8 记录的结果逐字段一致(21 passed | 2 skipped)——§1/§2/§4 的静态核对与 §8 的端到端复现在本次二次核验时段依然成立;同一批 `node --input-type=module` 静态核对(`isQuotedInTestExclude` / `isSuiteWiredInRealDbStep`)与 §4 的 `computePackageProvenancePinSet` 比对也已重跑,结果与 §1/§2/§4 记录的值逐字相同(未重复贴出)。

### 10.5 本节结论

- §6 的验收 I 结论补齐存在性正控后依然成立(§10.1)。
- 任务书 CI 接线 #7 已在 push 前核对,13 个 required contexts、`strict=false`、`test (20.x)` 在列的前提不变(§10.2)。
- §5/§9 的「45」计数错误已更正为 38 个守卫文件(36 个在 `plugin-tests.yml`、2 个在各自独立的 browser-verify workflow),且更正不影响「零覆盖」判定本身(§10.3)。
- 本节新增的核对全部是**只读命令**,未修改 `vitest.config.ts` / `plugin-tests.yml` / s6a 钉,§1/§2/§4 记录的字节级证据与本次提交的 s6a 值不受影响,无需重算。
- §9 的两条披露残留(闭世界缺口未收口、s6a 钉合并前需重算)维持不变,未被本节关闭。
