# 审批表单分组 Phase 1(切片 A-1 后端)— 验证 MD

- 锁文:`approval-form-group-entity-design-lock-draft-20260916.md`(**v2.13 RATIFIED 2026-09-18**)
- 设计 MD(同批交付):`approval-template-groups-phase1-design-20260918.md`
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A-1 后端`)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` #1–#7
- 私有真库:`metasheet2_lock_a`(§11 起的全部重跑均在此库上现场执行,非抄旧结果)
- **§1–§10 是 u3(CI 接线 + s6a 重钉)子单元的原始记录,原样保留,不重写**——其行号锚点基线 `85ddd2926`、worktree HEAD (`dba46e7c1`/`fbcf62caa`/`a2254950a`) 与 `origin/main`(`23dfdf417`)均为**该子单元当时的现场值**,时效性披露见 §9/§10.5;§11 起是本切片(A-1)收口时的**独立现场重跑**,覆盖锁文验收表的全部行(含 u3 未覆盖的 A/A′/A″/A‴/B/B′/B″/F/G/H/I′/J/K 与完整 mutation 台账),使用**当前** HEAD/merge-base,不沿用 §1–§10 的旧值
- 环境:node `v25.9.0`,python3 `Python 3.9.6`
- **§5 的「45」计数已被 §10 核实为错误,原句保留但视为已撤回,更正值见 §10.3**
- **§23 是新增的独立回流修复轮(2026-09-18,来自 A-3 设计门审的两条溢出发现 P1-3/P2-5),私有真库改用本轮新建的 `metasheet2_lock_a1_fix`(`createdb` + 全量 `migrate`)——与 §1–§22 使用的 `metasheet2_lock_a` 是两个不同的库,§23 内的所有命令行/计数以 `metasheet2_lock_a1_fix` 为准,不与 §1–§22 的库共享状态**

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

---

## 11. 本切片(A-1)收口验证 —— 起点

- 本节及以下(§11–§16)在 worktree HEAD `5c85c57e54e04fbf20b856873c6a0db00bd716ea`(design MD 提交,`git rev-parse HEAD` 现场核对)上执行——不是 `21c3b0512`;`git show --stat 5c85c57e5` 只改了 `approval-template-groups-phase1-design-20260918.md` 一个文件(1 file changed, 212 insertions),因此该提交上的**代码树**与 `21c3b0512`(本文档 §1–§10 记录时的 HEAD 之后、本切片实现完成时的 HEAD)逐字节相同,§13/§15 的全部命令与 mutation 结果不受这次纯文档提交影响。§17(本节)自身写入并提交后,HEAD 会再前进一次,届时的 SHA 见文末收尾核对。
- `origin/main` = merge-base = `89f1ecdee2c3b70205a318074824c834bc6a5c7e`(本分支是 `origin/main` 的直接后代,零漂移)。
- 私有库:`metasheet2_lock_a`(既有长期夹具库,`\d` 核对见 §11.1;非 u3 使用的 `_u3` 后缀库)。
- 覆盖范围:锁文 §6「期 1」门原文列出的验收行 **A / A′ / A″ / A‴ / B / B′ / B″ / E(前半)/ F / G / H / I / I′ / J / K**;**C / D / E 后半**按 §6 与设计 MD §1.2 是分期 3(A-4)范围,本节只记「不在本切片」,不佯装已验证。

### 11.1 迁移与 schema 现场核对(对锁文 §2,非抄迁移文件)

```
$ psql "postgres://localhost/metasheet2_lock_a" -c "\d approval_template_groups"
$ psql "postgres://localhost/metasheet2_lock_a" -c "\d approval_template_group_links"
```
输出的索引名(`atg_org_id_uni`、`atg_sort_unique` DEFERRABLE INITIALLY DEFERRED、`uq_atg_org_name_active` 部分唯一)、CHECK 名(`atg_org_nonblank`/`atg_name_nonblank`/`atg_sort_archived_pair`/`atgl_org_nonblank`/`atgl_state_check`)、复合 FK(`atgl_group_fk` → `approval_template_groups(org_id, id)`)与 PK(`approval_template_group_links_pkey` on `(org_id, template_id)`)逐条比对设计 MD §2 表,**字节形状一致**;迁移已应用、非幂等空跑(`pnpm exec tsx src/db/migrate.ts` 对该库无输出)。

## 12. 锁文验收表 → 测试文件 + 用例名 + lane(全表,含分期 3 的「不在本切片」行;锚点改用「符号 + 近似行号」,impl-gate-A-slice1-round4-20260918.md P3-1 收口)

**为什么改格式**:下表此前逐行记录「原 `:NNN`,修复轮 X +Y、修复轮 Z 再 +W……」这类逐提交位移算术——本轮(P2-1 提交)在 `it('§2(a)...'` 之前的块注释又插入了净 +8 行,P3-4 又在 `beforeAll` 里加了行,使 G/H/B″/I′/F 等行的数字**反复**位移,而这类算术本身就是易错、易漏更新的来源(本文档 §12/§18/§19 已经被同一问题打过好几次)。下表拆成两列:「用例名(逐字)」保留**完整**字符串(§13.2 承诺的「完整**当前**用例名见 §12 表」由这一列兑现,不是靠截断的前缀),行号列改成 `grep -n` 现场得到的近似值——`grep -F` 用这一列任意一段连续子串都能稳定定位,不受行号漂移影响,截断前缀不是必要条件:

| 验收行 | 判据摘要 | 测试文件 | 用例名(逐字) | 行(~,第 5 轮门审修复轮 2026-09-18 现场 `grep -nE "^ *(it|describe)\('"` 重跑值——上一版列头自称「本次重跑现场值」但实际是 `02c6bbe89` 那一刻的旧值,`b32a0b6fc` 之后从未真正重跑过,见 impl-gate-A-slice1-round5-20260918.md §3 P3-1) | lane |
|---|---|---|---|---|---|
| A | 同 org 同名活跃冲突 409;跨 org 可同名;归档后可重用 | `approval-template-groups-lifecycle.db.test.ts` | `A: same-org active-name conflict is 409; a different org may reuse the name; an archived name may be reused` | ~269 | `plugin-tests.yml` → `approval-real-db-integration`(`test (20.x)`,required) |
| A′ | 跨 org 不覆盖 | 同文件 | `A′: cross-org does not overlap — the SAME global template goes into DIFFERENT groups for DIFFERENT orgs` | ~296 | 同上 |
| A″ | 跨 org 挂接 404;复合 FK 兜底 23503 | 同文件 | `A″: cross-org link is 404 (org-scoped row-lock SELECT); the composite FK is the last-resort DB guard` | ~344 | 同上 |
| A‴ | org 只取 `authenticatedTenantId`(三格) | 同文件 | `A‴: org comes ONLY from req.authenticatedTenantId — body/query orgId rejected, forged header ignored, missing tenant fails closed` | ~376 | 同上 |
| B | 归档是一个事务;并发挂接见证已归档态 | 同文件 | `B: archive is one transaction (members unlinked, never deleted); a concurrent link blocks then sees the archived state` | ~424 | 同上 |
| B′ | 解除关联不回落 category;从未关联仍显示 | 同文件 | `B′ (DB-level predicate only, no display consumer until A-4): "no link row exists" — not "group_id IS NULL" — is the correct never-grouped predicate` | ~474 | 同上(**§13.5 披露**:本用例只做 DB 谓词层面演示,不经任何服务/路由代码) |
| B″ | 首次/重新挂接同一 upsert;并发首次挂接双成功 | 同文件 | `B″: first-link and re-link share ONE atomic upsert; two concurrent FIRST links to different groups both succeed, later commit wins` | ~888(第 6 轮门审修复轮现场重跑值,+44——第 5 轮记的是 ~844;本轮新增的 lifecycle `§2(d)` 用例插在 §2(c) 与 G 之间,把 G/H/B″/I′ 全部往下推了 44 行,§18.1/§18.2/§19.1 同族引用已同步重算,见 §25.4) | 同上 |
| C | `section=` 分节 | **不在本切片** — 锁文 §6「期 3」;`section` 查询参数在分期 1 不存在(A‴ 用例体内注释,`grep -n "Unknown .section=. token"` 现场定位,~419 附近自陈) | — | — | A-4 |
| D | category 后备(仅从未关联) | **不在本切片** — 同上;其底层 `NOT EXISTS` 判据已由 B′ 间接验证(见 §13.5),但 D 本身的展示/筛选端点属分期 3 | — | — | A-4 |
| E(前半:序号 + COMMIT 映射) | 并发建组 n+1/n+2;COMMIT 期 DEFERRABLE 映射 500;正控(裸 SQL 撞 `atg_sort_unique`/`atg_sort_archived_pair`);RR-默认池前提哨兵 | `approval-template-groups-serialization.db.test.ts`(本轮零改动,§4 已现场核对,九个锚点仍全中) | `sentinel: the service pool REALLY runs repeatable-read default — a bare-BEGIN generic transaction is RR`;`E positive control: two same-org active groups committing the SAME sort_order hit 23505 on atg_sort_unique at COMMIT, not at INSERT`;`E positive control: archiving without clearing sort_order hits the paired CHECK (atg_sort_archived_pair) immediately`;`E: two concurrent creates via the PRODUCTION path get sort_order n+1/n+2 — the RC pin lets the second read the freshly-committed MAX`;`E: negative control — an unrelated advisory key never blocks a concurrent create (sanity check on the pg_blocking_pids probe, not a mutation-2 gate — see K below for that)`;`E: COMMIT-time (not statement-time) DEFERRABLE violation on the production create path maps to 500 GROUP_SORT_CONFLICT` | ~161,~194,~221,~233,~278,~300 | 同上 |
| E(后半:并发重排) | 并发重排终态是其中一方完整排列 | **不在本切片** — 重排端点是分期 3(§6) | — | — | A-4 |
| F | 授权面:写端点 admin guard,读端点 `approvals:read` | lifecycle 文件 | `F: authorization — write endpoints require approvalTemplateAdminGuard, the list endpoint requires approvals:read; denial writes zero rows` | ~531 | `approval-real-db-integration` |
| G | 解档:干净态/同名活跃阻塞/改名冲入阻塞 | 同文件 | `G: unarchive — clean case; blocked by another ACTIVE group with the same name; blocked by a group renamed into that name` | ~813(第 6 轮修复轮 +44,原 ~769) | 同上 |
| H | 解除幂等 | 同文件 | `H: unlink is idempotent — never-linked, already-unlinked, and active-link cases` | ~855(第 6 轮修复轮 +44,原 ~811) | 同上 |
| I | I6 爆炸半径零(本地机械 diff) | 非 vitest 用例——本地命令(§6,已用现场 HEAD 重跑,见 §13.1) | — | — | 本地,非 CI |
| I′ | I6 行为门(自动化 actor 未变) | 同 lifecycle 文件 | `describe('I′: I6 explosion-radius behavioural gate — automation template-visibility actor is UNCHANGED by this slice'`(第 6 轮门审 P3-2:去掉此前多抄的结尾 `)`——文件里这一行结尾是 `', () => {`,不是 `')`,`grep -F` 照贴此前 0 命中,现在这段是真实源文件的字面子串,可直接命中);`(a) MAIN sees exactly {dept-scoped, role-scoped}, never the unseen template; CONTROL sees nothing (positive control)`;`(b) all three actor constructors return EXACTLY the ApprovalTemplateVisibilityActor key set at runtime (no stray optional field)` | describe ~928,(a) ~971,(b) ~999(第 6 轮修复轮 +44,原 ~884/~927/~955) | `approval-real-db-integration` |
| J | 多 org 成员脱困(403 + 前端选择器 + 未知 `section=` 400) | **后端半**:A‴ 用例体内 case (iii)(`noTenantRes`,~415 附近,A‴ 测试自陈「This is also J's only backend-observable leg」);**前端半 + 未知 token 400**:不在本切片(见设计 MD §1.3,归 A-2/A-4) | — | — | `approval-real-db-integration`(后端半) |
| K | 改名/建组/解档持 L0,阻塞可证伪 | serialization 文件(本轮零改动) | `K: an L0-only holder (no L1 row lock) stalls a concurrent CREATE in the same org`;`K: an L0-only holder stalls a concurrent RENAME of an existing group in the same org`;`K: an L0-only holder stalls a concurrent UNARCHIVE of an archived group in the same org` | ~328/~350/~372 | 同上 |

**行号免责声明(与 §3.1/§3.3 相同)**:以上 `~NNN` 是**第 5 轮门审修复轮(2026-09-18)现场重跑** `grep -nE "^ *(it|describe)\('"` 的结果(`lifecycle` 文件的 A/A′/A″/A‴/B/B′/B″/F/G/H/I′ 十一处锚点相对上一版**全部 +18**,根因是 `b32a0b6fc` 在 `beforeAll` 加了 18 行而这张表在那之后没有真正重跑过;`serialization` 文件本轮零改动,E/K 两组锚点现场核对与上一版逐字相同,未变)。这些仍然不是精确锚点,后续任何在这些用例**之前**的插入/删除都会使其整体位移;不要对着这些数字做位移算术,改用「用例名(逐字)」列的原样字符串重新 `grep -F` 现场定位——这一列的存在正是为了让 §13.2「完整当前用例名见 §12 表」这句话保持为真,不能再退化成截断前缀。E 行此前 6 个用例名里有 6 个带 `…` 截断(集中在这一行,见 impl-gate-A-slice1-round5-20260918.md §3 P3-4),本次已全部改写为完整字符串,`grep -F` 逐个可直接命中。

## 13. 命令逐字 + 结果关键行(现场重跑,`metasheet2_lock_a`)

### 13.1 迁移幂等确认

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" pnpm exec tsx src/db/migrate.ts
(无输出 — 迁移已是最新,幂等)
```

### 13.2 全量真库套件(EXPECT_DB=1,两个哨兵实跑而非 skip-green)

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    --reporter=verbose
```
关键行(逐字段摘录,当时现场逐字捕获,不因后续改名回填——完整**当前**用例名见 §12 表,全部 ✓):
```
✓ … sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)
✓ … A: same-org active-name conflict is 409; …
✓ … A′: cross-org does not overlap …
✓ … A″: cross-org link is 404 …
✓ … A‴: org comes ONLY from req.authenticatedTenantId …
✓ … B: archive is one transaction …
✓ … B′: unlinked-from-group templates show as ungrouped … （旧名,本用例已在修复轮 3/P2-3 改名,见 §20.2;§12 表已同步为新名,这里保留原始终端输出的逐字性,不回填）
✓ … F: authorization — write endpoints require approvalTemplateAdminGuard …
✓ … G: unarchive — clean case …
✓ … H: unlink is idempotent …
✓ … B″: first-link and re-link share ONE atomic upsert …
✓ … I′ … (a) MAIN sees exactly {dept-scoped, role-scoped} …
✓ … I′ … (b) all three actor constructors return EXACTLY …
✓ … sentinel: EXPECT_DB lane must have DATABASE_URL …
✓ … sentinel: the service pool REALLY runs repeatable-read default …
✓ … E positive control: two same-org active groups committing the SAME sort_order …
✓ … E positive control: archiving without clearing sort_order …
✓ … E: two concurrent creates via the PRODUCTION path get sort_order n+1/n+2 …
✓ … E: negative control — an unrelated advisory key never blocks a concurrent create …
✓ … E: COMMIT-time (not statement-time) DEFERRABLE violation …
✓ … K: an L0-only holder (no L1 row lock) stalls a concurrent CREATE …
✓ … K: an L0-only holder stalls a concurrent RENAME …
✓ … K: an L0-only holder stalls a concurrent UNARCHIVE …

 Test Files  2 passed (2)
      Tests  23 passed (23)
```
（EXPECT_DB=1 使两个 `itIfExpectDb` 哨兵**实际运行**而非条件跳过——这是全部「23/23」里真正跑到的 23 条,不存在被静默 skip 又计入绿的用例；在**同一个** `metasheet2_lock_a` 库上、不带 `EXPECT_DB=1` 现场重跑同一条命令,现场得到 `21 passed | 2 skipped (23)`(而非援引 §8/§10.4 在 `_u3` 库上的旧结果),两个跳过的正是这两个哨兵,与任何验收行无关,已用 `grep -nE "it\(|itIfExpectDb|describeIf"` 对两个文件逐条核对过没有遗漏的隐藏 `it.skip`。）

**CI 作用域披露(第 3 轮门审 P3-1,P3 卫生轮 2026-09-19 补全——此前三轮均已如实记录这一披露待补,现补上)**:`plugin-tests.yml` 全文 `EXPECT_DB` 计数为 **0**;这两个套件只接线进该 workflow,故其 `itIfExpectDb` 哨兵在 CI 中**不运行**(同一步骤另有 3 个既有文件也带同名哨兵,同样 dormant——它们各自另有专属的 `approval-realdb-*.yml` lane 设 `EXPECT_DB=1`,本切片两个新文件没有这样的专属 lane)。该 lane 今天对 missing-`DATABASE_URL` 的实际保护来自 `plugin-tests.yml:1578` 的 bash `: "${DATABASE_URL:?...}"`(先于 vitest 的 fail-closed),不是这两个哨兵。上面 §13.2 的 `EXPECT_DB=1` 运行是**本地**运行,不是这条 required lane 的行为。**哨兵在 `describeIfDatabase` 内部的嵌套放置本身维持不变**(第 3 轮门审当时的修法建议是移到模块顶层与同步骤 3 个既有兄弟对齐;第 4/6 轮门审复核后判定这是既有的、本切片独有部分在今天任何 lane 上零可观测差异的记账项,不作为本轮代码改动——移动测试拓扑属于对已结案范围决定的重新裁量,留给 owner 决定是否值得在开专属 lane 时一并做,见设计 MD §6)。

### 13.3 验收 I 本地 diff 取证(现场 HEAD 重跑)

```
$ MB=$(git merge-base origin/main HEAD); git diff --exit-code "$MB"..HEAD -- \
    packages/core-backend/src/multitable/automation-service.ts \
    packages/core-backend/src/multitable/automation-approval-template-access.ts; echo "exit=$?"
merge-base=89f1ecdee2c3b70205a318074824c834bc6a5c7e
exit=0
$ git cat-file -e HEAD:packages/core-backend/src/multitable/automation-service.ts && echo exists
exists
$ git cat-file -e HEAD:packages/core-backend/src/multitable/automation-approval-template-access.ts && echo exists
exists
```
（存在性正控通过,`exit=0` 是「零改动」而非「路径不存在」的假阳性,与 §6/§10.1 的方法论一致,只是换了现场 HEAD。）

### 13.4 两点接线 + s6a 现场核对(当前 HEAD,不沿用 §1/§2/§4 的旧值)

```
$ node --input-type=module -e "... isQuotedInTestExclude ..."
tests/integration/approval-template-groups-lifecycle.db.test.ts true
tests/integration/approval-template-groups-serialization.db.test.ts true

$ node --input-type=module -e "... isSuiteWiredInRealDbStep ..."
tests/integration/approval-template-groups-lifecycle.db.test.ts => approval step: true
tests/integration/approval-template-groups-lifecycle.db.test.ts => multitable step (must be false): false
tests/integration/approval-template-groups-serialization.db.test.ts => approval step: true
tests/integration/approval-template-groups-serialization.db.test.ts => multitable step (must be false): false

$ node -e "... computePackageProvenancePinSet ..."
computed: f08ea1addb3fd5f22ed1aa67624e2d746faedcdc87b432c7f7517ddc73801a6b
staged:   f08ea1addb3fd5f22ed1aa67624e2d746faedcdc87b432c7f7517ddc73801a6b
match: true

$ gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.contexts | length, .[]'
13
(13 个 context 逐字同 §10.2 记录;test (20.x) 在列)
$ gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.strict'
false
```

### 13.5 补充清单 #1 闭世界缺口(grep 计数,现场重跑)

```
$ grep -rl "approval-template-groups" scripts/ops/*.mjs; echo "exit=$?"
exit=1
```
零命中(`exit=1` 表示 grep 无匹配)——现场 HEAD 上依然**没有任何** `*-ci-wiring` 家族守卫覆盖这两个文件,§9 记录的闭世界缺口未被本次任何改动关闭(本切片也未新增守卫文件,维持披露)。

### 13.6 apps/web 零改动确认(J/A-2 拆分的机械佐证)

```
$ git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/web/
(无输出)
$ find apps/web -iname "*template-group*" -o -iname "*SessionOrgSwitcher*"
apps/web/src/composables/useSessionOrg.ts
```
（`apps/web` 目录零字节改动;唯一命中的文件是既有的 `useSessionOrg.ts`——考勤线原文件,本切片未新建/未复制泛化的 `SessionOrgSwitcher.vue`,与设计 MD §1.3/§6 的「前端半归 A-2」披露一致,不是遗漏。）

## 14. 补充清单(`impl-supplementary-gate-checklist-20260918.md`)逐条核

| # | 内容 | 核对结果 |
|---|---|---|
| 三线共用 #1 | `*-ci-wiring` 闭世界 | 未收口,见 §9/§13.5,披露维持 |
| 三线共用 #2 | `vitest.config.ts:42-45` 惯例覆盖需 PR body 写明 | 已在 `vitest.config.ts` 对应位置写入覆盖说明注释(§3 已记),PR body 需重申 |
| 三线共用 #3 | s6a 重钉 | 已重钉且现场核对匹配(§13.4);合并前时效性披露见 §4/§9 |
| 三线共用 #4 | 错误码不得降级成裸 HTTP 状态 | **⚠️ 第五次重算(2026-09-20,勘误 3 候选第 2 轮修复,见 §29):本格下面一切具体数字与行号均已失效,以 §14.1 末尾贴入的脚本输出为准 —— 20/15/5 与 `:538,543,555,562` / `:756` / `:606` 全部过期。**只有数字与行号失效**,本格关于「裸 403 命中的是共享中间件 `rbacGuardAny`,不在本锁错误码适用范围」以及「`APPROVAL_ACTOR_REQUIRED` 在本 harness 内不可达」的两条**定性论证仍然 OPERATIVE**。另:勘误 3 候选第 1 轮把「纯 CJK ⇒ 400 `GROUP_NAME_UNSUPPORTED`」用例改成了正向用例(§27.4),**当时未同步重算本格** —— 这是同一失效的第四次发生,本轮一并补上。** **机械前置动作(impl-gate-A-slice1-round4-20260918.md §2 P2-2 收口后新增,写在本行最前,任何一轮新增/删除用例后必须先跑再改数字)**:重跑 `scripts/dev/atg-verification-recount.sh`(脚本源码见该路径本身,不在本文档内重复粘贴;亦可手动逐条跑 §14.1 的三条命令),把输出原样贴回本行,不得手抄或沿用旧数字。**修复轮 1(2026-09-18,见 §18)重算,替换本行原「全部 10 个码逐条都有断言」的过强全称句——gate `impl-gate-A-slice1-round1-20260918.md` P2-4 机械计数(4 码零命中)证伪了原句,原句已撤回。修复轮 5(2026-09-18,见 §22)对本行第二次重算——gate `impl-gate-A-slice1-round2-20260918.md` P2-1 机械计数(在修复轮 4 新增两条裸 403 之后,本行未同步重算)证伪了当时的 15/13/2/`:492,497` 那组数字。gate `impl-gate-A-slice1-round4-20260918.md` P2-2 发现本行在修复轮 4(单一提交 `03ee9f4bb`,新增 P1-3 与 §2(c) 两条用例)落地后第三次未同步重算——这是同一失效的第三次发生。第 6 轮门审修复轮(2026-09-18,见 §25)第四次重算——本轮新增的 lifecycle `§2(d)` 用例(pin manager ⊄ guard 的真库回归,见 §2 P2-1)引入了第 6 个裸 `toBe(403)`,把 STATUS_COUNT/差额从 19/4 推到 **20/5**;`error.code).toBe(...)` 断言数不变,仍是 **15** 处(`§2(d)` 断言的是 `.error === 'Insufficient permissions'` 这个裸字符串,不是 `.error.code`,与 F 用例同族,不是一个新的专用码)。** 机械核对(现场 grep,非目测,第 6 轮修复轮现场重跑):两文件负例状态断言(`.status).toBe(4xx|500)`)共 **20** 处(`grep -noE "\.status\)\.toBe\((40[0-9]|500)\)" approval-template-groups-lifecycle.db.test.ts approval-template-groups-serialization.db.test.ts | wc -l`),配对的 `error.code).toBe(...)` 断言共 **15** 处(同一命令把 `\.status\)\.toBe` 换成 `error\.code\)\.toBe\('[A-Z_]+'\)`)——**逐行核对差额的 5 处**(`grep -n "toBe(403)" approval-template-groups-lifecycle.db.test.ts`)是 F 用例四个(**锚点改用符号 + 近似行号,理由同 §3.1**:`createAsNobody`/`listAsNobody`/`archiveAsNobody`/`linkAsNobody`,本 §14.1 重跑现场值 `:538,543,555,562`)加上新增的 `§2(d)` 一个(`:756`,同一原因:命中的是 `rbacGuardAny` 的裸拒绝)对非管理员/非授权主体的五个 403(第 6 个 `toBe(403)` 在 A‴(iii) 的 `noTenantRes` 处,~415,与 `SESSION_ORG_REQUIRED` 配对,不计入差额);这五处**不是**本锁引入的专用码之一,命中的是仓内既有、本锁未改动的共享中间件 `rbacGuardAny`(`src/rbac/rbac.ts:172-175`),该中间件对全仓所有路由(含 `/api/approval-templates` 自身)一律返回裸 `{ error: 'Insufficient permissions' }`(无 `code` 字段)——不在补充清单 #4「本锁错误码」的适用范围内。**逐码核对**(命令 `grep -oE "error\.code\)\.toBe\('<CODE>'\)" 两文件 | wc -l` 逐码跑,§3.3 设计 MD 的 10 个码全表 + 本轮新增的第 11 个码,数字与第 5 轮相比未变——本轮未新增/删除任何 `error.code` 断言):`GROUP_NOT_FOUND` 1、`GROUP_ARCHIVED` 1、`GROUP_NAME_TAKEN` 3、`GROUP_NOT_ARCHIVED` **1**(修复轮 1 新增,此前 **0**——§18)、`GROUP_SORT_CONFLICT` 1、`ORG_ID_NOT_ACCEPTED` 2、`SESSION_ORG_REQUIRED` 1、`GROUP_NAME_REQUIRED` **1**(修复轮 1 新增,此前 **0**)、`APPROVAL_GROUP_ID_REQUIRED` **1**(修复轮 1 新增,此前 **0**)、`APPROVAL_ACTOR_REQUIRED` **0**(仍无断言——`resolveApprovalActorId` 只在 `authenticate` 中间件已放行之后才被调用,触发它要求一个已验签但 `user.id`/`userId`/`sub` 三者皆缺的 token,本文件的 `tok()` helper 经 `/api/auth/dev-token` 铸造,不产出这种 token;记为「无断言,理由:本测试 harness 内不可达」,不当作遗漏補)、**`GROUP_NAME_UNSUPPORTED` 1**(回流修复新增,§3.3 设计 MD 全表尚未列这个码——见 P3-1,请求形状映射码,非锁文 ratify 码)。**(表外,不计入下面 11/10 分母)`APPROVAL_TEMPLATE_NOT_FOUND` 现 **2**(此前 **1**——§18.1 的 §2(b) 首次引入;§2(c) 新增第二处命中,复用同一码,非新码)。**11 码中 10 码有 `error.code` 断言、1 码(`APPROVAL_ACTOR_REQUIRED`)harness 内不可达而无断言。** mutation 台账(§15/§18/§25)每条红也均以「专用码不等」或「状态不等」精确报告,未见任何一条只查裸状态码就断言通过。 |
| lane A #5 | J/C 的「未知 `section=` ⇒ 400」挪分期 3 请示 | 已在设计 MD §1.2/§6 与 A‴ 测试注释(`:391-392`,原 `:386-387` +5)双重记录,owner 尚未回应,不阻塞本切片 |
| lane A #6 | 「1 落地」求值 = Draft PR 过门审 | 已按此定义推进(目标文档亦如此记录),本 MD 不重复裁决 |
| lane A #7 | 前端 spec 位置 `apps/web/tests/` | 不适用——本切片零前端改动(§13.6),留给 A-2 核对 |

### 14.1 §14 #4 机械计数——命令与输出原样贴入(impl-gate-A-slice1-round4-20260918.md P2-2 的硬性要求;本节是活证据,不是脚本源码的复制——脚本本体在 `scripts/dev/atg-verification-recount.sh`)

**这不是第一次也不是第二次现场重跑**:P2-2 刚收口时(commit `8a2a29a61`)跑出的是 `19/15/4`、行号 `:397,520,525,537,544`;随后 P3-4(commit `b32a0b6fc`)在 `beforeAll` 里加了行,把 F 用例那四行与 A‴(iii) 的 `noTenantRes` 一行全部往下推——**计数不变,行号又漂移了**。这正是本行反复失效的同一机制在同一轮内部又发生了一次。**第 6 轮门审修复轮(2026-09-18,见 §25)新增 lifecycle `§2(d)` 用例后第四次重跑**——这次计数本身也变了(不只是行号漂移):新用例带来第 6 个裸 `toBe(403)`,把 STATUS_COUNT/差额从 19/4 变成 20/5,`error.code` 配对数不变仍是 15。现在用脚本重跑到底,把最终值原样贴进来,不再手抄:

**P3-3 收口(第 5 轮门审)**:上一版本节此处声明「命令与输出原样贴入」,但实际是删节过的——删掉了脚本的「per-code breakdown」整节(17 行)与「how to use this output」整节(13 行),且把 `off-table code check` 那行表头的括注一并删掉了,删节处没有任何省略标记,与本节自己「换上新输出即可」的说明对不上(`diff` 核对见 `impl-gate-A-slice1-round5-20260918.md` §3 P3-3)。以下是第 5 轮门审修复轮现场重跑的**完整、未删节**输出:

```
$ bash scripts/dev/atg-verification-recount.sh
=== command 1: negative status assertions (.status).toBe(4xx|500)) across both files ===
$ grep -noE "\.status\)\.toBe\((40[0-9]|500)\)" approval-template-groups-lifecycle.db.test.ts approval-template-groups-serialization.db.test.ts | wc -l
20

=== command 2: paired error.code assertions across both files ===
$ grep -noE "error\.code\)\.toBe\('[A-Z_]+'\)" approval-template-groups-lifecycle.db.test.ts approval-template-groups-serialization.db.test.ts | wc -l
15

=== derived: difference (bare-403 assertions not paired with a code) ===
5

=== command 3: every toBe(403) line number in approval-template-groups-lifecycle.db.test.ts ===
$ grep -n "toBe(403)" approval-template-groups-lifecycle.db.test.ts
415:    expect(noTenantRes.status).toBe(403)
538:    expect(createAsNobody.status).toBe(403)
543:    expect(listAsNobody.status).toBe(403)
555:    expect(archiveAsNobody.status).toBe(403)
562:    expect(linkAsNobody.status).toBe(403)
756:    expect(groupRes.status).toBe(403)

=== per-code breakdown: every error.code).toBe('CODE') hit, both files, with line numbers ===
approval-template-groups-lifecycle.db.test.ts:282:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-lifecycle.db.test.ts:361:error.code).toBe('GROUP_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:387:error.code).toBe('ORG_ID_NOT_ACCEPTED')
approval-template-groups-lifecycle.db.test.ts:390:error.code).toBe('ORG_ID_NOT_ACCEPTED')
approval-template-groups-lifecycle.db.test.ts:416:error.code).toBe('SESSION_ORG_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:444:error.code).toBe('GROUP_ARCHIVED')
approval-template-groups-lifecycle.db.test.ts:577:error.code).toBe('GROUP_NAME_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:582:error.code).toBe('APPROVAL_GROUP_ID_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:606:error.code).toBe('GROUP_NAME_UNSUPPORTED')
approval-template-groups-lifecycle.db.test.ts:680:error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:724:error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:822:error.code).toBe('GROUP_NOT_ARCHIVED')
approval-template-groups-lifecycle.db.test.ts:840:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-lifecycle.db.test.ts:851:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-serialization.db.test.ts:323:error.code).toBe('GROUP_SORT_CONFLICT')

=== per-code counts (sorted, most-frequent first) ===
   3 'GROUP_NAME_TAKEN'
   2 'ORG_ID_NOT_ACCEPTED'
   2 'APPROVAL_TEMPLATE_NOT_FOUND'
   1 'SESSION_ORG_REQUIRED'
   1 'GROUP_SORT_CONFLICT'
   1 'GROUP_NOT_FOUND'
   1 'GROUP_NOT_ARCHIVED'
   1 'GROUP_NAME_UNSUPPORTED'
   1 'GROUP_NAME_REQUIRED'
   1 'GROUP_ARCHIVED'
   1 'APPROVAL_GROUP_ID_REQUIRED'

=== off-table code check: APPROVAL_TEMPLATE_NOT_FOUND (reused, not one of design MD §3.3's ratified codes) ===
approval-template-groups-lifecycle.db.test.ts:680:    expect((await res.json()).error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:724:    expect((await hiddenRes.json()).error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')

=== how to use this output ===
1. STATUS_COUNT / CODE_COUNT / their difference -> §14 三线共用 #4's "共 N 处" / "共 N 处" / "差额 N 处" numbers.
2. The toBe(403) line list -> the "F 用例" line-number citation (last line is usually the
   A'''(iii) noTenantRes 403, paired with SESSION_ORG_REQUIRED, NOT part of the F-block diff).
3. The per-code counts -> the "逐码核对" list. Any code present in this output but NOT in
   design MD §3.3's error-code table is a NEW code this round — call it out by name (see
   P3-1 in impl-gate-A-slice1-round4-20260918.md for the convention) and update the design MD
   table separately; do not silently fold it into the existing 10/9 (or whatever the current
   denominator is) without updating the fraction.
4. APPROVAL_TEMPLATE_NOT_FOUND is intentionally off-table (a link-visibility 404 reusing an
   existing code, not a ratified template-groups code) — track it in its own sentence, not in
   the N/M in-table fraction.
```

**结论**:计数现为 **20/15/5**(此前 `19/15/4`,变化来自本轮新增的 `§2(d)` 用例——见 §14 三线共用 #4 与 §25.4),**11 码中 10 码有断言不变**(本轮未新增/删除任何 `error.code` 断言);§14 表格正文里的行号已按本次重跑更新为「符号 + 近似行号」(F 用例四格 `~538/543/555/562`、新增的 `§2(d)` 一格 `~756`,A‴(iii) `~415`),不再钉裸数字——下一次任何人再往这两个文件里插代码,数字会再漂移,但这次不需要重新证明「哪几处该改」,直接重跑这个脚本、把上面这段代码块换成新输出即可(**本节自 P3-3 收口起,「换上新输出」意味着替换从 `$ bash scripts/dev/atg-verification-recount.sh` 到 `how to use this output` 结尾的整段,不得再删节任何一节**)。


#### 14.1-R2 第五次机械重算(2026-09-20,勘误 3 候选第 2 轮修复后;脚本输出**原样**贴入,未手抄、未删节)

触发条件(脚本自己的使用说明第 3 条):本轮新增 4 个 `it()`、新增一个**新错误码** `GROUP_NAME_TOO_LONG`。

```
$ bash scripts/dev/atg-verification-recount.sh
=== command 1: negative status assertions (.status).toBe(4xx|500)) across both files ===
$ grep -noE "\.status\)\.toBe\((40[0-9]|500)\)" approval-template-groups-lifecycle.db.test.ts approval-template-groups-serialization.db.test.ts | wc -l
22

=== command 2: paired error.code assertions across both files ===
$ grep -noE "error\.code\)\.toBe\('[A-Z_]+'\)" approval-template-groups-lifecycle.db.test.ts approval-template-groups-serialization.db.test.ts | wc -l
21

=== derived: difference (bare-403 assertions not paired with a code) ===
1

=== command 3: every toBe(403) line number in approval-template-groups-lifecycle.db.test.ts ===
$ grep -n "toBe(403)" approval-template-groups-lifecycle.db.test.ts
415:    expect(noTenantRes.status).toBe(403)
538:    expect(createAsNobody.status).toBe(403)
543:    expect(listAsNobody.status).toBe(403)
555:    expect(archiveAsNobody.status).toBe(403)
562:    expect(linkAsNobody.status).toBe(403)
1240:    expect(groupRes.status).toBe(403)

=== per-code breakdown: every error.code).toBe('CODE') hit, both files, with line numbers ===
approval-template-groups-lifecycle.db.test.ts:282:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-lifecycle.db.test.ts:361:error.code).toBe('GROUP_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:387:error.code).toBe('ORG_ID_NOT_ACCEPTED')
approval-template-groups-lifecycle.db.test.ts:390:error.code).toBe('ORG_ID_NOT_ACCEPTED')
approval-template-groups-lifecycle.db.test.ts:416:error.code).toBe('SESSION_ORG_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:444:error.code).toBe('GROUP_ARCHIVED')
approval-template-groups-lifecycle.db.test.ts:577:error.code).toBe('GROUP_NAME_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:582:error.code).toBe('APPROVAL_GROUP_ID_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:776:error.code).toBe('GROUP_NAME_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:831:error.code).toBe('GROUP_NAME_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:880:error.code).toBe('GROUP_NAME_REQUIRED')
approval-template-groups-lifecycle.db.test.ts:1006:error.code).toBe('GROUP_NAME_TOO_LONG')
approval-template-groups-lifecycle.db.test.ts:1016:error.code).toBe('GROUP_NAME_TOO_LONG')
approval-template-groups-lifecycle.db.test.ts:1024:error.code).toBe('GROUP_NAME_TOO_LONG')
approval-template-groups-lifecycle.db.test.ts:1032:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-lifecycle.db.test.ts:1164:error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:1208:error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:1306:error.code).toBe('GROUP_NOT_ARCHIVED')
approval-template-groups-lifecycle.db.test.ts:1324:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-lifecycle.db.test.ts:1335:error.code).toBe('GROUP_NAME_TAKEN')
approval-template-groups-serialization.db.test.ts:326:error.code).toBe('GROUP_SORT_CONFLICT')

=== per-code counts (sorted, most-frequent first) ===
   4 'GROUP_NAME_TAKEN'
   4 'GROUP_NAME_REQUIRED'
   3 'GROUP_NAME_TOO_LONG'
   2 'ORG_ID_NOT_ACCEPTED'
   2 'APPROVAL_TEMPLATE_NOT_FOUND'
   1 'SESSION_ORG_REQUIRED'
   1 'GROUP_SORT_CONFLICT'
   1 'GROUP_NOT_FOUND'
   1 'GROUP_NOT_ARCHIVED'
   1 'GROUP_ARCHIVED'
   1 'APPROVAL_GROUP_ID_REQUIRED'

=== off-table code check: APPROVAL_TEMPLATE_NOT_FOUND (reused, not one of design MD §3.3's ratified codes) ===
approval-template-groups-lifecycle.db.test.ts:1164:    expect((await res.json()).error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
approval-template-groups-lifecycle.db.test.ts:1208:    expect((await hiddenRes.json()).error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')

=== how to use this output ===
1. STATUS_COUNT / CODE_COUNT / their difference -> §14 三线共用 #4's "共 N 处" / "共 N 处" / "差额 N 处" numbers.
2. The toBe(403) line list -> the "F 用例" line-number citation (last line is usually the
   A'''(iii) noTenantRes 403, paired with SESSION_ORG_REQUIRED, NOT part of the F-block diff).
3. The per-code counts -> the "逐码核对" list. Any code present in this output but NOT in
   design MD §3.3's error-code table is a NEW code this round — call it out by name (see
   P3-1 in impl-gate-A-slice1-round4-20260918.md for the convention) and update the design MD
   table separately; do not silently fold it into the existing 10/9 (or whatever the current
   denominator is) without updating the fraction.
4. APPROVAL_TEMPLATE_NOT_FOUND is intentionally off-table (a link-visibility 404 reusing an
   existing code, not a ratified template-groups code) — track it in its own sentence, not in
   the N/M in-table fraction.
```

**逐条求值(按脚本「how to use this output」四步)**

1. **STATUS_COUNT / CODE_COUNT / 差额 = 22 / 21 / 1**(上一次记录的是 20 / 15 / 5)。
2. **`toBe(403)` 行号**:`415`(A‴(iii) `noTenantRes`,与 `SESSION_ORG_REQUIRED` 配对,**不计入**差额)、`538` / `543` / `555` / `562`(F 用例四个)、`1240`(`§2(d)`,原 `:756`,被本轮新增的用例整体下推)。命中的仍是仓内共享中间件 `rbacGuardAny` 的裸 `{ error: 'Insufficient permissions' }`,**不是**本锁的专用码——该定性结论未变。
3. **新码,按脚本要求点名不静默并入**:**`GROUP_NAME_TOO_LONG`,3 处断言**(`:1006` / `:1016` / `:1024`)。设计 MD §3.3 的错误码表**已在本轮同步新增该行**(含 255 的推导与残留),不是悄悄折进旧分母。
4. **`APPROVAL_TEMPLATE_NOT_FOUND` 仍是表外**(2 处,`:1164` / `:1208`),按脚本第 4 条单独记,不进 N/M 分数。

**本轮必须点名的两处「零断言」**

- **`GROUP_NAME_UNSUPPORTED` 现在是 0 处 `error.code` 断言**(`grep -c "GROUP_NAME_UNSUPPORTED"` 在 lifecycle 文件里是 2,但两处**都是注释**:`:617` / `:754`)。原因是勘误 3 候选第 1 轮把「纯 CJK ⇒ 400 `GROUP_NAME_UNSUPPORTED`」改成了正向用例(§27.4)——**候选下这个码对 `name` 本来就不该再可达**,所以这是预期结果、不是覆盖退化;但它当时**没有**回来重算本节,属于同一失效的第四次发生,现予补记。该码的两个 `org_id` 臂仍然可达,只是本套件不练它们的 `error.code`(它们练的是直连 SQL 的 23514,见 §28.3 用例 4)。
- **`APPROVAL_ACTOR_REQUIRED` 仍是 0 处**,理由未变(本 harness 的 `tok()` 经 `/api/auth/dev-token` 铸造,产不出「已验签但 `user.id`/`userId`/`sub` 三者皆缺」的 token),记为「无断言,理由:harness 内不可达」。

**⚠️ 这个普查自己的窄处(必须披露,不能让下一轮把它当成完备计数)**

脚本的两条正则是 `\.status\)\.toBe\(...\)` 与 `error\.code\)\.toBe\('...'\)` —— 它们要求 `)` **紧跟**在 `.status` / `error.code` 之后,因此**看不见**两种写法,而本轮新增的断言大量使用第一种:

```
$ grep -noE "\.status(,[^)]*)?\)\.toBe\((40[0-9]|500)\)" 两文件 | wc -l
27                                  # 放宽到带 message 形参后:27,脚本口径是 22

$ grep -noE "error\.code(,[^)]*)?\)\.toBe\('[A-Z_]+'\)" 两文件 | wc -l
22                                  # 同上:22,脚本口径是 21

$ grep -noE "\.status,[^)]*\)\.toBe\((40[0-9]|500)\)" approval-template-groups-lifecycle.db.test.ts
750:.status, `status for ${label}`).toBe(400)
879:.status, 'rename to U+3164 HANGUL FILLER').toBe(400)
1004:.status, '256 code points is OVER the cap').toBe(400)
1015:.status, 'btree-overflowing name must be a typed 400, not an opaque 500').toBe(400)
1031:.status, 'cap is applied to the TRIMMED name').toBe(409)
```

第二种写法是本轮新引入的**收集成数组再一次比较**(`:852` 的 `expect(observed).toEqual(… -> 400 GROUP_NAME_REQUIRED)`、以及 P3-7 表驱动用例的两个数组断言):它们一次断言 9 个 / 10 个值的状态与错误码,但**两条正则都数不到**。

⇒ **脚本口径 22/21/1 是下界,不是全量**。按 `feedback_single_definition_does_not_make_a_narrow_predicate_correct`:复用规范谓词会忠实继承其狭窄。本轮**不改脚本**(改它属于另一件事,且会让本轮与历次输出不可比),而是把这条窄处写成披露 + 上面三条放宽后的命令与输出,供门审与下一轮取用。**补充清单 #4 的实质结论不受影响**:差额里的裸状态断言仍然只有 `rbacGuardAny` 那一族,本轮新增的每一条状态断言都配了 `error.code`(或配在同一个数组元素里)。

## 15. Mutation 台账(每条:备份 → 改 → 跑 → 还原 → cmp;全部在 `metasheet2_lock_a` 上现场执行)

> **行号作用域说明(修复轮 1 追加)**:本节及以下 §16/§17 内所有 `routes/approvals.ts`/`ApprovalTemplateGroupService.ts` file:line 引用,记录的是**当时被 mutate 的那次 HEAD**(`252d01865`,门审报告 `impl-gate-A-slice1-round1-20260918.md` 审的同一 commit)——探针已全部还原,这些行号是「曾在此处做过什么、看到什么」的历史证据,不是「现在去这一行找」的活地图。修复轮 1(§18)在 `routes/approvals.ts` 顶部与内部新增了共 30 行(§3.1 设计 MD 脚注有精确位移表),本节列出的旧行号**未跟随重算**——按需核对时,用本节的函数名/端点路径重新 `grep -n` 现场行号,不要按此处数字直接跳转。§12(锁文验收表 crosswalk)与设计 MD §3.1/§3.2/§3.3/§5 是「活地图」,已在修复轮 1 里重新核对为当前 HEAD;§15/§16/§17 是「历史记录」,不重算。**§18.1/§18.2/§19.1 是第三类**:它们记录的是「修复轮 1/2 落地时那次 HEAD 上的行号」,曾经也是「历史记录、不重算」,但修复轮 5(§22.2,gate 第 2 轮 P3-2)已把其中会被读者当作导航用的六处 `file:line` 引用按当前 HEAD 现场重算并原地改写——读者今天可以把 §18.1/§18.2/§19.1 的行号当活地图用,但仍需留意:未来若再有代码提交插入行数,这三节会重新变回历史记录,除非再跑一次同样的重算。

统一流程:`cp <file> /tmp/mutation-backups/<file>.orig` 一次性备份 → 用 `sed -i.bak`/`python3` 精确改动 → 用 `-t "<用例名片段>"` 只跑受影响的一条用例 → `cp <backup> <file>` 还原 → `cmp <backup> <file>` 确认逐字节相同。收尾复核:`git status --porcelain` 与 `git diff --stat` 均为空(§16)。

| # | 目标(锁文命名的 mutation) | 改动 file:line | 命令关键结果 | 判定 |
|---|---|---|---|---|
| 1 | F:去掉写端点 guard | `routes/approvals.ts:1102`(删 `approvalTemplateAdminGuard`) | `expected 201 to be 403`(实收 201) | **RED**,还原后 `cmp` 相同 |
| 2 | G:去掉同名复核 | `ApprovalTemplateGroupService.ts:311-317`(删整块) | 测试**仍绿**(`1 passed`) | **INERT** — 见 §15.1 |
| 2′ | G/A 共享替代 mutation:禁用 `mapGroupConstraintError` 的 `uq_atg_org_name_active` 分支(`:137`) | 同上 + `:137` 改 `if (false && …)` | A:`expected 500 to be 409`(实收500,来自 `duplicate key value violates unique constraint "uq_atg_org_name_active"` 未被映射);G(仅 `:137` 单独改,`:311-317` 复原):**仍绿**——G 有第二层独立防护;G(`:311-317` **同时**删除 + `:137` 同时禁用):`expected 500 to be 409` | **RED**(A 单独 mutation 即红;G 需两处复合才红,见 §15.1) |
| 3 | H:去掉 `AND group_id IS NOT NULL` | `ApprovalTemplateGroupService.ts:397` | `expected 1789658151205 to be 1789658151183`(`unlinked_at` 被覆写为新时间戳) | **RED** |
| 4 | B:挂接路径去掉行锁下 `archived_at` 复核 | `ApprovalTemplateGroupService.ts:364-366`(删整块) | `expected 201 to be 409`(真并发,`waitUntilBackendBlockedByHolder` 实际停车) | **RED** |
| 5 | B′:后备判定改「`group_id IS NULL`」 | 无对应应用代码可改——见 §15.2 | — | **BLOCKED-with-reason**,见 §15.2 |
| 6 | B″(a):upsert 换裸 UPDATE | `ApprovalTemplateGroupService.ts:368-378` | `timed out waiting for backend blocked by holder`(MVCC 下 UPDATE 对不可见行 0 行,永不停车) | **RED** |
| 7 | B″(b):upsert 换裸 INSERT | 同上(删 `ON CONFLICT …` 子句) | `expected 500 to be 201`(裸 23505 未被映射) | **RED** |
| 8 | A′:主键改单列 `template_id`(真实 DDL,非测试自带的 TEMP TABLE 替身) | `metasheet2_lock_a` 上 `ALTER TABLE … DROP CONSTRAINT approval_template_group_links_pkey` + `ADD CONSTRAINT … PRIMARY KEY (template_id)` | `expected 500 to be 201`——实收 `there is no unique or exclusion constraint matching the ON CONFLICT specification`(42P10),而非锁文预言的「静默覆盖」 | **RED,但机制不同**,见 §15.3 |
| 9 | A″(a):挂接 SELECT 去掉 org 谓词(**修复轮 2 重写,见 §15.4**——原行记录的是被混淆的版本;下方是隔离版本在当前 HEAD 的现场结果) | `ApprovalTemplateGroupService.ts:358`(`linkApprovalTemplateToGroup` 内 `FOR UPDATE` 行,head `bdfe29974` 现场 `grep -n` 确认,非沿用旧记录数字) | 隔离改法(`org_id = $1 AND` → `$1::text IS NOT NULL AND`,保留对 `$1` 的引用避免绑定参数计数错配):`-t "A″"` → `expected 500 to be 404`,失败点是跨 org 断言 `:333`(现场 `grep -n` 确认),正控 `:328` 保持 201 未受影响 | **RED,判别力真实(隔离版本)**,机制见 §15.4 |
| 10 | A″(b):删复合 FK(真实 DDL) | `metasheet2_lock_a` 上 `ALTER TABLE approval_template_group_links DROP CONSTRAINT atgl_group_fk` | 裸 INSERT 断言从「rejects 23503」变成实际插入成功(`rowCount:1`,无异常) | **RED** |
| 11 | A‴(a):org 源改 `req.user.tenantId` | `routes/approvals.ts:361` | `expected 201 to be 403`(case iii 伪造头下写入成功) | **RED** |
| 12 | A‴(b):接受 `req.body.orgId` | `routes/approvals.ts:351-360` | `expected 201 to be 400`(case i 写入成功) | **RED** |
| 13 | I′(a):禁用 dept 析取项 | `ApprovalProductService.ts:4408`(`'dept'`→`'dept_disabled'`) | `expected 1 to be 2`(mainNames.size 掉到 1) | **RED**;`git diff`还原后为空 |
| 14 | I′(b):构造器加可选 `orgId` | `automation-approval-template-access.ts:92-93` | `Object.keys` 多出 `'orgId'`,`toEqual` 失败 | **RED**;还原后 `cmp` 与 I6 备份逐字节相同 |
| 15 | K(create):去掉 L0 | `ApprovalTemplateGroupService.ts:184` | `timed out waiting for backend blocked by holder` | **RED** |
| 16 | K(rename):去掉 L0 | `ApprovalTemplateGroupService.ts:214` | 同上 | **RED** |
| 17 | K(unarchive):去掉 L0 | `ApprovalTemplateGroupService.ts:298` | 同上 | **RED** |
| 18 | E(1):去掉显式 `SET TRANSACTION ISOLATION LEVEL` | `ApprovalTemplateGroupService.ts:183`(清空) | `expected 500 to be 201`(比锁文预言的「序号重复」更早触发:请求本身即 500) | **RED,信号比预言更早**,见 §15.5 |
| — | E(2):去掉 L0 | 同 K(create),无需重复施加 | 见 #15 | 由 K 覆盖(测试文件自身在 `:276-283` 已声明「E 负控不测这条」) |
| 19a | E(3)-a:仅禁用 `mapGroupConstraintError` 的 `atg_sort_unique` 分支 | `ApprovalTemplateGroupService.ts:140`(`if (false && …)`) | `expected 'APPROVAL_TEMPLATE_GROUP_CREATE_FAILED' to be 'GROUP_SORT_CONFLICT'`(实收前者,状态仍 500) | **RED(经码而非状态)** |
| 19b | E(3)-b:按测试文件头注释字面「删 `createApprovalTemplateGroup` 内 try/catch」 | `ApprovalTemplateGroupService.ts:181-182,198-201`(去掉服务层 try/catch) | 同 19a:`expected 'APPROVAL_TEMPLATE_GROUP_CREATE_FAILED' to be 'GROUP_SORT_CONFLICT'`——**仍是干净 500,不是「无响应」** | **RED,但不是文件注释宣称的失败模式**,见 §15.6 |
| 19c | E(3)-c:真正的「无响应」机制 —— 删**路由 handler 自己的** try/catch(`routes/approvals.ts:1127,1137-1139`,修复轮 1 后行号,原 `:1103,1113-1115`) | `routes/approvals.ts` | `Unhandled Rejection: ServiceError: Group sort order conflict …`;`Test timed out in 30000ms`(修复轮 3 现场重跑逐字;`vitest.integration.config.ts:19` 的 `testTimeout: 30000` 早于本切片存在,旧记录的 `20000ms` 在本 head 从未成立过,系记录错误而非漂移) | **RED,且是唯一真正复现「无响应/超时」的改动点**,见 §15.6 |

### 15.1 发现:G 的显式同名复核是「惯性冗余」,只有与 A 共享的 fallback 分支才是唯一防线

第一次按锁文字面(只删 `ApprovalTemplateGroupService.ts:311-317`)得到的是**惰性(inert)结果**:G 测试仍然全绿。根因是 `unarchiveApprovalTemplateGroup` 最终的 `UPDATE` 语句本身会撞 `uq_atg_org_name_active`(立即部分唯一索引),而 `mapGroupConstraintError` 把这个 23505 映射回**同一个** 409 `GROUP_NAME_TAKEN`——`ApprovalTemplateGroupService.ts:34-38` 的文件头注释已自陈这一点(「confirmed by mutation-testing this block out — no observable change」),本次现场复现验证了该注释所写属实。
真正让 G 落红的是**复合 mutation**(同时删 `:311-317` **且** 禁用 `:137` 的 `uq_atg_org_name_active` 分支)——而**仅**禁用 `:137`(`:311-317` 保留)对 G **单独测不出**(G 走的是自己的显式 `ServiceError` 抛出路径,`mapGroupConstraintError` 首行 `if (error instanceof ServiceError) return error` 直接放行,不经过 `:137` 分支);但**仅**禁用 `:137` 对 **A** 单独测得出红(A 的建组路径没有显式预检查,完全依赖 `:137` 这条分支)。
**结论(修复轮 2,gate `impl-gate-A-slice1-round1-20260918.md` P2-2 收口)**:锁文 G 行命名的那条「去掉同名复核」mutation,在本实现下不是判别性的——真正的判别性 mutation 是**共享的** `mapGroupConstraintError:137` 分支移除,它同时是 A 与 G(复合态)的证据来源。**这不是锁文的合同缺口**:门审逐字核过锁文,G 行只要求「同名冲入阻塞」这一个可观察行为,没有规定必须靠两层独立防御才算数;第二层(`mapGroupConstraintError:137` 的 `uq_atg_org_name_active` 分支)本来就是共享基础设施,建组(A)路径一开始就依赖它。真正的归因是**实现选择**:`unarchiveApprovalTemplateGroup` 在共享分支之上,自己又加了一次 UPDATE 前的显式 SELECT 预检查(§`ApprovalTemplateGroupService.ts:311-317`)。这一层在当前形状下**可以安全删除**——删除它不会引入 TOCTOU:同 org 的建组/改名/解档三条写路径共享同一个 `pg_advisory_xact_lock(hashtext('atg:'+org))`(L0),预检查与 UPDATE 之间不存在可被并发利用的窗口;也不会改变本套件任何一条用例的可观察结果(探针 2a/2b 已证明:单独删预检查、单独禁用 mapper 分支,两种单层改动都不改变对外行为)。保留它的理由 X 是:在 L0 临界区内提前退出、避免发起一次注定失败的写(省一次 UPDATE 尝试)——**这条理由较薄**:同样可以论证「少一次 SELECT 往返」在性能上可以忽略,是否值得为此保留一条对锁文验收零判别力的代码路径,不由本次修复单方裁定。**要求 owner 裁决**(二选一,均未在本轮实现):(a) 删除 `:311-317` 预检查,让 mapper 分支成为 G 唯一、判别性的防线,与 A 共享同一证据路径(回归探针 2b 的复合态观察);(b) 保留现状,明确接受「保留双层」是**实现选择**而非锁文要求——`unarchiveApprovalTemplateGroup` 的文件头注释与测试文件 `:591-` 处的注释均已改写,不再称为「合同缺口」(记忆:「源码文本断言≠行为断言」;这里更正的是**归因**,不是行为门本身——G 的验收断言此前与此后均为真判别力的绿)。

### 15.2 B′:无可改的应用代码路径 —— BLOCKED-with-reason

B′ 用例(`lifecycle.db.test.ts:447-495`(原 `:437-479`,修复轮 1 后 `:442-484`,修复轮 3/P2-3 在 `it(` 上方插入 5 行 NOTE 注释后再 +5;现场 `grep -n "it('B′\|rejectedPredicate"` 可核))的核心「mutation」是测试**自己内联的两条原始 SQL**(`NOT EXISTS(...)` 谓词 vs 被拒绝的 `group_id IS NULL` 谓词),两条查询都直接写在 `it()` 内,不经过任何 `ApprovalTemplateGroupService.ts` 或 `routes/approvals.ts` 的函数——因为 I2′ 定义的「后备显示判定」目前**没有任何服务/路由代码实现它**:能消费这个判据的中心页列表端点是 §6 分期 3(A-4)的 `section=` 端点,分期 1 尚未存在。
因此,「备份→改→跑→还原→cmp」这套流程在 B′ 这一行**没有目标可改**——不存在一个当前 HEAD 上的 `.ts` 文件包含「用 `group_id IS NULL` 判定后备」这行逻辑可以被 mutate。B′ 测试当前的形态是对**将来消费方必须遵守的不变量**的一次 DB 级机械论证,而不是对已交付代码的行为门。
**判定:BLOCKED-with-reason**——非因为验证失败或跳过,而是因为锁文 B′/D 行命名的 mutation 对象在本切片尚不存在于应用代码里;A-4 落地 `section=` 端点时,必须对**那个端点**重做这一行的 mutation 台账,不能援引本节的 B′ 记录为「已 mutation-tested」的证据。

### 15.3 A′:真实 DDL mutation 与测试自带替身的机制分歧

`lifecycle.db.test.ts:293-314`(原 `:288-309` +5) 里 A′ 用例自带一段「shape-proof mutation surrogate」——在**会话级 TEMP TABLE**(`ON COMMIT DROP`,从不碰真表)上模拟单列 PK 会导致「B 的挂接覆盖 A」。这段本身不是对真表/真服务代码的 mutation,是自包含的演示。
本次额外对**真实**`approval_template_group_links` 表做了 DDL mutation(`DROP CONSTRAINT approval_template_group_links_pkey` → `ADD CONSTRAINT … PRIMARY KEY (template_id)`),重跑 A′ 用例的**真实端点断言**(`linkA`/`linkB` 两次 `httpReq`)。结果不是锁文预言的「静默覆盖」,而是应用代码里 `ON CONFLICT (org_id, template_id)` 的仲裁索引不存在,触发 `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`,`linkA` 直接 500——比「静默覆盖」更早、更响亮地失败。
**结论**:A′ 行在**真实**代码路径上依然是可 mutation-discriminate 的(红,`expected 500 to be 201`),但红的**机制**与锁文文本描述的「覆盖」不同——是 `ON CONFLICT` 仲裁索引缺失,不是运行时的静默数据覆盖。测试自带的 TEMP TABLE 段落论证的是「如果真的允许覆盖会发生什么」,与「如果真的把 PK 改窄会发生什么」是两个不同的反事实,本节把两者都做了并分开记录。

### 15.4 A″(a):重写为隔离版本(修复轮 2,gate P2-5 收口)

**这一节被 gate `impl-gate-A-slice1-round1-20260918.md` 的 P2-5 点名重写,原文整段撤回,不是补充。**

原记录(门审报告已引用,现已撤回)写的是**被混淆的 mutation**:直接删除 `org_id = $1 AND`,SQL 文本不再引用 `$1`,但调用点仍传入 `[orgId, groupId]` 两个绑定参数,PostgreSQL 在参数数量与占位符不匹配时直接报错——这连**同 org 的正控格**(`ok.status` 应为 201)也一并炸掉,对「org 谓词是否真的在挡跨 org」**零判别力**(报错来自绑定参数计数不匹配,不是「跨 org 200 泄露」这个语义)。门审用**隔离版本**重跑并证伪了这一版记录的判定依据;本节按门审给出的隔离形状,在**本轮实际 HEAD**上重跑,不是照抄门审报告里对 `252d01865` 的旧输出。

**隔离改法**:保留对 `$1` 的引用(避免参数计数不匹配这个混淆项),把它从「过滤条件」降级为「恒真的哑引用」:

```
- `SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`
+ `SELECT archived_at FROM approval_template_groups WHERE $1::text IS NOT NULL AND id = $2 FOR UPDATE`
```

**现场执行**(head `bdfe29974`,`metasheet2_lock_a`,与 §18 同一 `cp`/改/跑/还原/`cmp` 流程,备份于 `/tmp/gateA-fix2-probe-backups/`):

```
$ cp packages/core-backend/src/services/ApprovalTemplateGroupService.ts \
    /tmp/gateA-fix2-probe-backups/ApprovalTemplateGroupService.ts.orig
$ python3 - <<'PYEOF'
# 替换 :358 行(现场 grep -n 确认的当前行号,非沿用旧记录)
old = "SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE"
new = "SELECT archived_at FROM approval_template_groups WHERE $1::text IS NOT NULL AND id = $2 FOR UPDATE"
# ... 精确单次替换,assert count==1
PYEOF
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "A″" --reporter=verbose
 ✗ A″: cross-org link is 404 (org-scoped row-lock SELECT); the composite FK is the last-resort DB guard
   AssertionError: expected 500 to be 404 // Object.is equality
   at tests/integration/approval-template-groups-lifecycle.db.test.ts:333:26
 Test Files  1 failed (1)
      Tests  1 failed | 14 passed | 1 skipped (16)
```

失败点精确落在跨 org 断言 `expect(cross.status).toBe(404)`(`:333`,现场 `grep -n "A″:"` 定位用例起点后手数确认),**同一测试内**先执行的正控 `expect(ok.status).toBe(201)`(`:328`)未报错(若正控本身失败,vitest 会在 `:328` 就中断,报告的行号不会是 `:333`)——这是「隔离」的字面含义:失败点单点落在跨 org 格,不再牵连正控。

**结论**:A″(a) 是**有判别力的 mutation**——去掉 `linkApprovalTemplateToGroup` 里 group 行锁 SELECT 的 org 谓词后,跨 org 请求会找到本不该看见的 group 行、拿到 `archived_at`(非空判定通过)、继续走到 upsert,upsert 因 `(org_id, group_id)` 与 `atgl_group_fk` 目标不匹配而在**写入侧**触发复合 FK 的 23503(未被 `mapGroupConstraintError` 映射,兜底 500)——**机制与锁文预言的「23503 而非 404」完全一致**,只是本节改写前的记录选错了改法、把噪音(参数计数报错)当成了信号。

**还原与确认**(§16 收尾流程的一部分,现场重跑):

```
$ cp /tmp/gateA-fix2-probe-backups/ApprovalTemplateGroupService.ts.orig \
    packages/core-backend/src/services/ApprovalTemplateGroupService.ts
$ cmp /tmp/gateA-fix2-probe-backups/ApprovalTemplateGroupService.ts.orig \
    packages/core-backend/src/services/ApprovalTemplateGroupService.ts && echo "cmp OK"
cmp OK
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "A″" --reporter=dot
 ✓ tests/integration/approval-template-groups-lifecycle.db.test.ts (16 tests | 1 skipped)
 Test Files  1 passed (1)
      Tests  15 passed | 1 skipped (16)
$ git status --porcelain
(空)
```

**行号作用域说明(比照 §15 开头的通用披露,本节额外声明)**:本节是**唯一**在本轮(head `bdfe29974` 之后)重新现场执行的 mutation 行——其余 §15/§16/§17 的行号与输出仍是 `252d01865` 的历史记录,不因本节重跑而重算(道理同 §15 开头的作用域说明)。`ApprovalTemplateGroupService.ts:358`(被 mutate 的那一行)与旧记录数字相同,这不是巧合而是因为修复轮 1 只改了 `routes/approvals.ts` 与 lifecycle 测试文件、未碰 `ApprovalTemplateGroupService.ts`(§18 头部已声明);但**测试断言的行号发生了移位**——旧记录引用的正控行是 `:323`,本节现场重跑得到的正控行是 `:328`、跨 org 断言行是 `:333`(均为修复轮 1 在该测试文件内新增用例导致的 +5 移位,与 §12 crosswalk 表「原 `:312` → 现 `:317`」记录的同一批移位一致)——三个数字**均为本次独立 `grep -n`/断言栈现场确认**,不是沿用旧记录未核实的数字,读者不应把 `:323` 当作本节仍然成立的引用。

### 15.5 E(1):比锁文预言更早的失败信号

去掉 `createApprovalTemplateGroup` 里的显式 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 后,测试文件自己的头部注释(`:19-25`)预言的红色签名是「COMMIT 撞 23505,最终以 `sort_order` 集合 `{1,2}` 校验失败」这一更细粒度的信号;现场重跑观察到的实际红,是**更早**的 `expect(res.status).toBe(201)` 断言就已经失败(实收 500,`GROUP_SORT_CONFLICT`,说明冲突同样在 COMMIT 期被检测并正确映射,只是比头部注释描述的「悄悄产生重复」更快被拦下)。两者都是该文件同一条 `it()` 块内的断言,红的判定成立,只是记录清楚具体命中哪一句。

### 15.6 E(3):测试文件头部注释描述的「无响应」机制定位有误,现场重新定位

`serialization.db.test.ts:27-33` 的头部注释字面写「delete the try/catch around `transaction(...)` in `createApprovalTemplateGroup`」会导致「the whole route handler's response never resolves」。现场按字面执行(仅删服务层 `ApprovalTemplateGroupService.ts` 里包裹 `transaction(...)` 的 `try/catch`,`routes/approvals.ts` 自己的 `try/catch` 保持不动)得到的是**干净的 500**(`APPROVAL_TEMPLATE_GROUP_CREATE_FAILED`),测试在 20 秒内正常返回并按错误码断言失败——**不是**注释描述的「无响应」。
根因:`routes/approvals.ts:1126-1140`(修复轮 1 后行号;P2-1 在此路由之前的挂接路由插入了新代码,行号相应下移,原 `:1102-1115`)的路由 handler**自己也有**一层 `try { … } catch (error) { handleApprovalsError(...) }`,与服务层的 `try/catch` 是**两层独立的**捕获,注释只算到了内层。只有把**外层(路由自己的)** `try/catch` 也一并删掉,才复现出「无响应」:现场移除 `routes/approvals.ts:1127` 的 `try {` 与 `:1137-1139` 的 `catch` 块后,重跑观察到 `Unhandled Rejection: ServiceError: Group sort order conflict`(来自 `mapGroupConstraintError` 正确算出的错误,只是无人接住)与 `Test timed out in 30000ms`(修复轮 3 现场重跑逐字;`vitest.integration.config.ts:19` 的 `testTimeout` 自该文件唯一一次提交起就是 `30000`——`git log --oneline -- packages/core-backend/vitest.integration.config.ts` 只有一条提交 `e0defbe26`,`20000ms` 在本仓历史上从未对这个文件成立过,是原始记录写错,不是后续漂移)——这才是锁文/测试注释共同预言的「Express 4 不接 async 拒绝 ⇒ 无响应」现象的真实、唯一复现点。
**结论**:E 行本身仍然被现有测试正确 mutation-discriminate(三种施法都产生红),但测试文件自己的头部注释对**具体机制**(哪一层 try/catch 是那道防线)的描述与当前代码结构不完全对应——这是「源码文本断言≠行为断言」的又一个实例(此处是**注释**而非应用代码本身),记入门审供参考,不改动测试文件或注释(不改代码)。

## 16. Mutation 台账收尾核对(零残留)

本节在**写入本文档之前**执行(与 §10.1 记录的教训一致:verdict 必须绑已发生的 SHA,不能靠「即将怎样」的预告)——因此下面的 `git status`/`git diff` **限定在代码路径**(`packages/ plugins/ .github/`),不含本文档自身正在被编辑的 `docs/` 路径(编辑中的文档必然会让未限定路径的 `git status --porcelain` 非空,那不是代码残留,是这次交付本身):

```
$ git status --porcelain -- packages/ plugins/ .github/
(无输出)
$ git diff --stat -- packages/ plugins/ .github/
(无输出)
$ cmp /tmp/mutation-backups/ApprovalTemplateGroupService.ts.orig packages/core-backend/src/services/ApprovalTemplateGroupService.ts && echo OK
OK
$ cmp /tmp/mutation-backups/approvals.ts.orig packages/core-backend/src/routes/approvals.ts && echo OK
OK
$ cmp /tmp/mutation-backups/ApprovalProductService.ts.orig packages/core-backend/src/services/ApprovalProductService.ts && echo OK
OK
$ cmp /tmp/mutation-backups/automation-approval-template-access.ts.orig packages/core-backend/src/multitable/automation-approval-template-access.ts && echo OK
OK
$ cmp /tmp/mutation-backups/migration.ts.orig packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts && echo OK
OK
$ psql "postgres://localhost/metasheet2_lock_a" -c "\d approval_template_group_links" | grep -c "atgl_group_fk\|approval_template_group_links_pkey"
2
```

两条 DDL mutation——A′ 的单列 PK、A″(b) 的复合 FK 删除——已在各自小节内当场 `ALTER TABLE` 复原,约束名核对与 §11.1 的原始 `\d` 输出逐字一致。这不只是「看起来一样」的断言:两条 `ADD CONSTRAINT`(`approval_template_group_links_pkey PRIMARY KEY (org_id, template_id)` 与 `atgl_group_fk FOREIGN KEY (org_id, group_id) REFERENCES approval_template_groups (org_id, id)`)都返回了 `ALTER TABLE`(无错误),而 PostgreSQL 在加回 PK/FK 时会**对表内现存全部行做校验**——若 mutation 期间产生的任何测试数据违反了这两条约束(跨 org 孤儿关联行、重复的 `(org_id, template_id)`),`ADD CONSTRAINT` 本身就会失败并报出具体违规行,而不是静默通过。两条都干净返回,等价于对「mutation 期间没有产生违反正常约束的持久脏数据」做了一次**由数据库自己执行**的全表校验,而不只是本节这句断言;这也解释了 A″(b) 小节里 `DELETE FROM approval_template_group_links WHERE linked_by = 'raw-bypass'` 返回 `DELETE 0`——测试自身的 `afterAll`/`trackOrg` 清理已经先行移除了那行,加回 FK 时因此无冲突可拒。

全部 19 条 mutation(含 1 条 inert→替代、1 条 blocked、3 条机制分歧记录)执行期间,应用代码文件字节级 `cmp` 与数据库约束的存在性 + 校验性核对均通过,无残留。

## 17. 未做 / 未验 / blocked-with-reason(如实列出)

1. **验收 C、D、E 后半** —— 不在本切片范围(锁文 §6「期 1」门本身未列 C/D/E 后半;设计 MD §1.2 已逐条引锁文 §/分期)。留给 A-4。
2. **验收 B′ 的 mutation 台账** —— 处置口径**并入 #3 的 owner 勘误桶**(修复轮 3,gate P2-3 收口;原记为自裁 BLOCKED-with-reason,与 #3/#5 是同一类锁文自相矛盾,不应自裁,理由见 #3)。技术事实不变,仍见 §15.2:I2′ 后备判定逻辑当前不存在于任何应用代码路径,无对象可 mutate;测试改为纯 DB 级说明性断言(`lifecycle.db.test.ts:494`,见 §20.2),A-4 落地 `section=` 端点时须对**那个端点**重做 mutation 台账。
3. **验收 J 的前端半**(session-org 选择器组件、403 后展示、选定后重试、`run-required-web-tests.sh` 令牌)、**未知 `section=` ⇒ 400**、以及**验收 B′**(上条)—— 三者是**同一类**锁文自相矛盾:锁文 §6「期 1」门把 J 后端半/B′ 列入本切片验收范围,但它们唯一的消费方(前端选择器组件、`section=` 列表端点)都排在 A-4(分期 3)才存在。原记录把 J/C 的 400 升 owner、把 B′ 自行判 BLOCKED,是**同一类问题两种处置口径**(违反判据集合自洽);统一改为**待 owner 勘误**,三者并列,不在本切片阻塞,归 A-2/A-4(设计 MD §1.2/§1.3/§6,补充清单 #5;§20.2 记录本轮的归并)。
4. **补充清单 #1 的闭世界缺口** —— 未收口(§13.5),`scripts/ops/approval-template-groups-ci-wiring.test.mjs` 新守卫文件留给后续单元或 owner 裁决。
5. **s6a 钉的时效性** —— 仅对本 push 前一刻的 `plugin-tests.yml` 字节成立(§4/§13.4);合并前必须重算,不在本单元范围内。
6. **重排端点(分期 3)的 E 后半判据** —— 代码尚未实现,自然也未验证。
7. **§15.6 揭示的测试文件头部注释机制描述偏差** —— 不属于代码缺陷(测试判定本身仍是有效的红/绿门),但建议后续修订 `serialization.db.test.ts:19-33` 的头部注释,把「哪一层 try/catch 是真正防线」写准确;本次遵守「不改代码」未做这处编辑,留给门审决定是否值得单独一个小改动 PR。
8. **§3.4(设计 MD)记录的实现者裁量**(重复归档复用 `GROUP_ARCHIVED`)—— 未获锁文文本背书,无验收行覆盖,门审需明确认可或要求改动。
9. **§3.5(设计 MD,修复轮 1 新增)记录的实现者裁量**(挂接可见性失败形状复用 `APPROVAL_TEMPLATE_NOT_FOUND`,404 而非发明新码)—— 同 #8,未获锁文文本背书(锁文只 ratify「要校验」,未点名失败码),无独立验收字母覆盖(附属于 I5/§2,不是锁文 §4 表的一行),门审需明确认可或要求改动;可达性披露见 §18.1。
10. **G 的双层防线定性(修复轮 2,gate P2-2 收口)**——`unarchiveApprovalTemplateGroup` 同时保留「显式预检查 + 共享 mapper 分支」两层同名冲突防御是**实现选择**,不是锁文要求;第一层(`:311-317`)可安全删除且不引入 TOCTOU(同 org 三条写路径共享同一把 L0),保留它的理由(避免 L0 临界区内一次注定失败的写)较薄。本轮**只更正了归因**(§15.1 结论重写 + 测试文件 `:591-` 注释同步,删除了「需要发明新 mutation」的被驳论断),未删除代码——门审需裁 (a) 删除预检查使 G 恢复单条 mutation 判别力,或 (b) 接受现状为实现选择。PR body 开出时需点名此项(与 #2/#8/#9 同批)。
11. **非 uuid 模板 id + 格式合法但不存在的组 id → 挂接端点响应从 404 变 500(修复轮 5,gate 第 2 轮 NIT 现场实测确认,§22.5)**——本切片新增的 §2 挂接可见性校验(`isApprovalTemplateVisibleForGroupLink`,先于 `linkApprovalTemplateToGroup` 内的组存在性检查执行)把「模板 id 是否合法 uuid」的检查时机提前到了组检查之前;对这一具体组合,修复前(mutation 探针还原到 P2-1 之前的调用路径,现场验证)是 404 `GROUP_NOT_FOUND`,修复后(当前 HEAD,未改代码,现场验证)是 500 `APPROVAL_TEMPLATE_GROUP_LINK_FAILED`。**这是真实的行为差异**,不是「今天不可达」的假设缺口(与 #9 不同类)。是否补一格验收测试是设计裁量,本轮不新增(范围控制);PR body 必须点名为已知行为差异,不能只写「未验证」。

## 18. 修复轮 1(2026-09-18)—— gate `impl-gate-A-slice1-round1-20260918.md` P2-1 / P2-4 收口

被审 head `252d01865`;本轮只动 `packages/core-backend/src/routes/approvals.ts`(+1 处 import、+1 处导出函数、+1 处调用点)与 `packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`(+4 处 import、+4 个新 `it()`、G 用例内 +3 行)——**不改 DDL、不改 `ApprovalTemplateGroupService.ts`、不改 `plugin-tests.yml`/`vitest.config.ts`**(两点接线与 s6a 钉不受影响,两文件仍是同一对既接线的文件,§1/§2/§4 结论不变)。P2-2/P2-3/P2-5/P3-* 本轮未处理,原状见 gate 报告。

### 18.1 P2-1 —— 挂接时按原谓词校验可见(§2 ratified 条款,此前既未实现也未披露)

**实现**(设计 MD §3.5 记录为实现者裁量的两点:落点与失败形状):
- `routes/approvals.ts` 新增导出函数 `isApprovalTemplateVisibleForGroupLink(templateId, actor)`——对 `approval_templates` 跑 `id = $1` 加 `applyTemplateVisibilityFilter`(复用 `ApprovalProductService.ts:4383-4419`,与列表/详情端点同一函数,不是新逻辑)。
- 链接端点(`POST /api/approval-templates/:id/group`,`:1153`)在校验 `groupId` 之后、调用 `linkApprovalTemplateToGroup` 之前调用它;不可见 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(复用 `:897` 同码),零行写入(`linkApprovalTemplateToGroup` 完全不被调用)。

**可达性披露(第 6 轮门审 P2-1 收口,第二次按实测重写,与设计 MD §3.5 同步——第 5 轮「按实测重写」换上的两句「guard ⊋ isTemplateManager(严格超集)」声明本身也被证伪,失效评估见 §25;这是对断言本身第二次求值,不是作废整节)**:`approvalTemplateAdminGuard` 的人口与 `isTemplateManager` 人口**互不包含**——manager 让 `applyTemplateVisibilityFilter` 短路、不加条件,但两个方向各有一个实测反例(方向一端到端实测;方向二的 guard 拒绝端到端实测,manager 判定由对导出解析器的直调实测,附负控——第 7 轮门审 P3-3 指出「两个方向都端到端」对方向二过强),谁都不是谁的子集。**方向一(guard 过、非 manager)**:guard 的最终兜底 `isAdmin(userId)`(DB 侧 `user_roles WHERE role_id='admin'`)与 `isTemplateManager` 读的 JWT 字段(`role`/`roles`/`permissions`)完全独立,能放行一个 JWT 层面不带任何 manager 声明的主体——§23.7 的 §2(c) 用例(纯 HTTP、真库,`vis3-dbadmin-*` 主体)对这类主体的 hidden 模板拿到 404 `APPROVAL_TEMPLATE_NOT_FOUND`,证明这条检查在生产可达路径上今天确实会因「看不见该模板」而拒绝,并没有退化成「模板是否存在」的检查(附带修好了一个既有空白:`mapGroupConstraintError` 未映射 `atgl_template_fk` 的 23503,此前对不存在的模板 id 会 500,现在 404)。**方向二(manager、guard 不过)**:一个仅持 guard 自己字面点名的权限码 `approval-templates:manage`(不含 namespace-admission 授予)的主体满足 `isTemplateManager` 的一条判定腿,但打 guard 守卫的建组端点拿到 403——新增的 §2(d) 用例(纯 HTTP + 对导出解析器的直调,同一权限声明形状,附负控)端到端实测这一点,与 §23.6 的 `ZZR4-EXACT-RESULT status=403`(perms 恰为该码)一致;机制是 `isTemplateManager` 的这条权限腿不带 admission 合取项,而 guard 的同名权限腿与 `isPermissionAllowedByNamespaceAdmission` 合取。曾被怀疑成立的另一条腿(通配权限码 `approval-templates:*` 单独过 guard)**不成立**——被 `isPermissionAllowedByNamespaceAdmission` 这个合取项挡住,实测与 guard 字面点名的码一样拿 403,全仓真实授予计数 0(§23.6 两次端到端证伪)。**生产 provisioning 路径是否恒同时授予两者未经实测,本节不作断言**——方向二的反例是在本测试 harness 的 `RBAC_TOKEN_TRUST` 配置下实测的。真正的判别力由三条腿共同验证:**§2(a)**(谓词直调,手写 `isTemplateManager: false` 的 actor,下方「两腿测试」小节的原始记录)+ **§2(c)**(纯 HTTP、真库,方向一反例,§23.7 新增的第三条腿)+ **§2(d)**(纯 HTTP + 直调,方向二反例,第 6 轮门审修复轮新增,附负控)。

**两腿测试**(`approval-template-groups-lifecycle.db.test.ts`,新增两个 `it()`,紧接 F 之后;**锚点改用「符号 + 近似行号」,impl-gate-A-slice1-round4-20260918.md P3-1 收口——此前三轮各自维护过一版「原 `:NNN`,某轮 +M」的位移记录,每次都在下一轮插入代码后失效,不再续写这类算术,下方 `~` 值是本 P3-1 提交现场 `grep -n` 所得**):
- `§2(a)`(块注释 + `it()` 本体,`grep -n "§2 link-time visibility" lifecycle.db.test.ts` 定位块注释起点,~622(第 5 轮门审修复轮重算,原 ~604 是 `b32a0b6fc` 之前的旧值,+18);`it('§2(a):`,~650(原 ~632,+18))——谓词直调:手写一个 `isTemplateManager: false` 的 actor(不经 HTTP/guard),对 dept 作用域内的模板返回 `true`、作用域外的返回 `false`、不存在的 `randomUUID()` 返回 `false`;并证明同一 hidden 模板对 `isTemplateManager: true` 的同一 actor 返回 `true`(manager 短路的机制证据,不只是断言)。
- `§2(b)`(`it('§2(b):`,~672(原 ~654,+18))——端点调用点:admin token(guard 内唯一可达的 actor 形状)对一个 `randomUUID()`(不存在)的模板 id 发起挂接 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`,`approval_template_group_links` 零行。

**Mutation 探针(两条,`cp` 备份 → 改 → 单独跑受影响用例 → `cp` 还原 → `cmp` → 全量重跑确认回绿;`/tmp/gateA-fix1-probe-backups/`)**:

| # | 目标 | 改动 | 命令关键结果 | 判定 |
|---|---|---|---|---|
| P2-1-M1 | `isApprovalTemplateVisibleForGroupLink` 内的 `applyTemplateVisibilityFilter` 调用 | 注释掉该行(只留 `id = $1`) | `-t "§2"`:`§2(a)` 红,`expected true to be false`(hidden 模板被判可见) | **RED ✓**——谓词半判别 |
| P2-1-M2 | 链接端点的可见性前置调用块 | 整块删除(不再调用 `isApprovalTemplateVisibleForGroupLink`) | `-t "§2"`:`§2(b)` 红,`expected 500 to be 404`(不存在的模板落到未映射的 `atgl_template_fk` 23503,`handleApprovalsError` 兜底 500) | **RED ✓**——调用点半判别 |

两条探针均单独执行、单独还原:`cmp approvals.ts.orig approvals.ts` 均 `OK`;还原后 `-t "§2"` 重跑均回绿;全文件套件收尾重跑 `Test Files 2 passed (2) / Tests 26 passed (26)`;`git status --porcelain` 在还原后为空。

### 18.2 P2-4 —— 10 个错误码的绝对断言(4 码零命中)+ `GROUP_NOT_ARCHIVED` 零覆盖

**补的三格**(均在 `approval-template-groups-lifecycle.db.test.ts`;**锚点改用「符号 + 近似行号」,impl-gate-A-slice1-round4-20260918.md P3-1 收口,理由同上——不再续写位移算术**):
- `GROUP_NOT_ARCHIVED`——在既有 `it('G: unarchive...` 用例(~813,原 ~769,+44,第 6 轮门审修复轮重算——本轮新增的 `§2(d)` 用例插在前面把它推后了 44 行)开头插入:对刚建的、仍活跃的 `g1` 直接调 `/unarchive` ⇒ 409 `GROUP_NOT_ARCHIVED`(`grep -n "GROUP_NOT_ARCHIVED" lifecycle.db.test.ts`,~819-822,原 ~775-778,+44),再继续 G 原有的归档/解档/同名冲突流程,不改动 G 原有断言。
- `GROUP_NAME_REQUIRED` / `APPROVAL_GROUP_ID_REQUIRED`——新增独立用例 `it('request-shape codes: ...`(~571,原 ~553,+18,紧接 F 之后、`§2` 系列之前):建组传全空白 `name` ⇒ 400 `GROUP_NAME_REQUIRED`;链接端点传空 body(无 `groupId`)⇒ 400 `APPROVAL_GROUP_ID_REQUIRED`。
- `APPROVAL_ACTOR_REQUIRED` 保持零覆盖,理由见 §14(修复轮 1)行:`authenticate` 中间件已放行之后才可能调用 `resolveApprovalActorId`,触发它要求一个已验签但 `user.id/userId/sub` 三者皆缺的 token,本文件的 `tok()` helper 铸不出这种 token——harness 内不可达,不是遗漏。

**§14 全称句撤回**——原句「本锁自己新增的全部 10 个码……逐条都有对应的 `error.code` 断言」为假(gate 机械计数:`GROUP_NOT_ARCHIVED`/`GROUP_NAME_REQUIRED`/`APPROVAL_GROUP_ID_REQUIRED`/`APPROVAL_ACTOR_REQUIRED` 四码原为零命中),已在 §14 表格原地改写为逐码计数 + grep 命令(`grep -oE "error\.code\)\.toBe\('<CODE>'\)" 两文件 | wc -l`,逐码跑),不再是全称句。

**Mutation 探针(三条,同一 `cp`/改/跑/还原/`cmp` 流程,`ApprovalTemplateGroupService.ts` 与 `approvals.ts` 均为既有生产代码、非本轮新写,探针用于证明新测试断言本身有判别力而非摆设)**:

| # | 目标 | 改动 | 命令关键结果 | 判定 |
|---|---|---|---|---|
| P2-4-M1 | `unarchiveApprovalTemplateGroup` 的 `archived_at === null` 分支(`:307`) | `if (false && row.archived_at === null)` | `-t "G:"`:`expected 200 to be 409` | **RED ✓** |
| P2-4-M2 | `requireName` 的空名判断(`:157`) | `if (false && !trimmed)` | `-t "request-shape codes"`:`expected 500 to be 400`(空名落到 DB 层 `atg_name_nonblank` CHECK,未映射码,兜底 500) | **RED ✓** |
| P2-4-M3 | 链接端点的 `groupId` 必填判断(`routes/approvals.ts:1186`) | `if (false && !groupId)` | `-t "request-shape codes"`:`expected 400 to be 404`(空 `groupId` 落到组行 `SELECT ... WHERE id = ''` 0 行 ⇒ `GROUP_NOT_FOUND`) | **RED ✓** |

三条探针逐条单独执行、单独还原、`cmp` 逐字节核对 `OK`;每条还原后单独重跑回绿;全部三条完成后,全文件套件收尾重跑 `Test Files 2 passed (2) / Tests 26 passed (26)`(与 §18.1 收尾共用同一次全量重跑);`git status --porcelain` 为空。

### 18.3 收尾证据(本轮结束时现场执行)

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  26 passed (26)
```
（此前 23/23,本轮 +4:`§2(a)`、`§2(b)`、`request-shape codes`、G 用例内新增的一条 `expect` 不新增用例计数——只有前三个是新 `it()`,第 4 处改动在既有 G 用例内部,故 23 + 3 = 26。）

```
$ pnpm exec tsc --noEmit -p .
```
（`packages/core-backend` 目录,exit 0,无输出;两个 `.db.test.ts` 仍在 `tsconfig.json` 的 `exclude` 里、不受此次 typecheck 覆盖——与 P3-10 记录的既有边界一致,未改变。）

```
$ git status --porcelain    (本轮全部 mutation 探针还原后)
(空)
```

本轮**不涉及** DDL、`plugin-tests.yml`、`vitest.config.ts`、s6a 钉——两点接线与 §1/§2/§4 的核对结论对本轮改动后的 HEAD 依然成立(新增的两个 `it()` 在既有已接线文件内,未新增文件)。

## 19. 修复轮 2(2026-09-18)—— gate `impl-gate-A-slice1-round1-20260918.md` P2-2 / P2-5 收口

被审对象是修复轮 1 落地后的 HEAD(`bdfe29974`);本轮只动 `docs/development/approval-template-groups-phase1-verification-20260918.md`(本文档自身,§15.1/§15/§17)与 `packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`(G 用例前 `:591-` 处的注释,纯注释改动,零行为代码)——**不改 DDL、不改 `plugin-tests.yml`/`vitest.config.ts`、不改任何 `.ts` 生产代码**(`ApprovalTemplateGroupService.ts`/`routes/approvals.ts` 的探针已全部还原,收尾 `cmp`/`git status` 见下)。P2-3/P3-6/P3-7/P3-8/P3-9/P3-10 本轮未处理,原状见 gate 报告,留给后续修复轮。

### 19.1 P2-2 —— G 的双层防线定性从「锁文合同缺口」改判为「实现选择」

**处置口径**:采用 gate 给出的选项 (b)——只更正归因,不删代码。选项 (a)(删除 `unarchiveApprovalTemplateGroup:311-317` 的预检查、让 G 恢复单条 mutation 判别力)会撤销 `ApprovalTemplateGroupService.ts:280-292` 文件头注释已明确论证过的一处实现决策,牵连 G/A/K(unarchive)三组探针与 §15.1 的重新执行,超出本轮「一到两条」的范围,且门审本身未指定也未验证任何替代形状——留给 owner 与后续实现轮裁决,本轮不代为决定。

**改动的两处**:
1. 验证 MD §15.1「结论」段——原句「这不是缺陷,是……已被架构自身文档化的现象」改写为:锁文 G 行只要求「同名冲入阻塞」这一可观察行为,不要求两层独立防御;第二层(`mapGroupConstraintError:137`)是共享基础设施,第一层(`:311-317` 的显式预检查)是本实现在其上追加的选择;该层可安全删除且不引入 TOCTOU(同 org 三条写路径共享同一把 L0 advisory lock,预检查与 UPDATE 之间没有可被并发利用的窗口);保留它的理由(避免 L0 临界区内一次注定失败的写)较薄,如实写明「较薄」而非包装成充分理由;明确请 owner 在 (a) 删除预检查 / (b) 接受现状为实现选择之间二选一。
2. 验证 MD §17 新增条目 #10,把这条实现者裁量并入 #8/#9 所在的「门审需明确认可或要求改动」桶,并注明 PR body 开出时需与 #2/#8/#9 同批点名。

**测试文件注释同步**(`lifecycle.db.test.ts`,`it('G: unarchive...` 正上方的整段块注释,以 `── G ──` 分隔符起始,`grep -n "── G ──" lifecycle.db.test.ts` 定位,~782(第 6 轮门审修复轮重算,原 ~738,+44——本轮新增的 `§2(d)` 用例插在前面把它推后了 44 行);**锚点改用「符号 + 近似行号」,impl-gate-A-slice1-round4-20260918.md P3-1 收口,不再续写「原 `:NNN` → 现 `:MMM`」的位移链——历史链见 §22.2,该节按当时的 head 记录,不重算**):删除被门审明确驳回的一句——「this is a lock-vs-implementation contract gap……since strengthening it would mean inventing a new mutation not in the lock」(门审原话:「不必发明锁文之外的新 mutation」,该句断言的前提是假的)。替换为:指出这是实现选择而非锁文缺口,第一层是在共享分支之上的额外添加,删除第一层即可恢复单条判别力且不触碰锁文文本要求任何东西,并指向验证 MD §15.1/§17 #10 的 owner 裁决点。**这是纯注释改动**,零行为代码变化。

**回归确认**(同一 `metasheet2_lock_a`,注释改动不需要 mutation 探针,只需确认套件仍然全绿且未引入语法/类型错误):

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  26 passed (26)
$ pnpm exec tsc --noEmit -p .
(无输出,exit 0)
```

用例计数不变(26,与 §18.3 收尾一致)——本条只改注释,不新增/删除任何 `it()`。

### 19.2 P2-5 —— 台账 #9(A″(a))改写为隔离版本

被门审点名「记录的失败点与机制都错」的那一行(§15 台账 #9、§15.4)**整段撤回重写**,不是追加订正:

- **旧版**(现已撤回):删除 `org_id = $1 AND` 后 SQL 不再引用 `$1`,而调用点仍传两个绑定参数 ⇒ PostgreSQL 直接报「参数数量与占位符不匹配」,把正控(`ok.status` 应为 201)也一并炸掉——对「org 谓词是否真的在挡跨 org」零判别力。
- **新版**(本轮现场执行,见 §15.4 全文重写):隔离改法 `org_id = $1 AND` → `$1::text IS NOT NULL AND`,保留对 `$1` 的引用以消除参数计数噪音。`metasheet2_lock_a` 上 `cp` 备份 → 改 → `-t "A″"` → 结果:失败点精确落在跨 org 断言(`expected 500 to be 404`);正控 `:328` 未报错——这是**推论,非独立观察**:vitest 在同一个 `it()` 内第一处 `expect` 失败即抛出并中断该用例,报告的失败行号是 `:333` 而非 `:328`,这一事实**蕴含** `:328` 处的断言先于 `:333` 执行且未抛出(若正控本身先失败,报告的行号会是 `:328`,不会是 `:333`)——本节与 §15.4 用同一条推论,§15.4 是完整表述,这里不重复展开 → `cp` 还原 → `cmp OK` → 单独重跑回绿 → 全量重跑回绿(见下)。

**结论变化**:旧版记录仍判定为"RED"但机制记错;新版确认 A″(a) **依然是有判别力的 mutation**,且机制与锁文预言一致(23503 复合 FK 兜底 500,而非 404)——这纠正的是**记录**,不是**判定**:A″ 这一行此前与此后都是真门,只是台账里写的失败点和原因是错的。

**重要澄清(与 P2-1 的调用路径变化无关)**:本条 mutation 的施法点是 `linkApprovalTemplateToGroup` 内 group 行的 `FOR UPDATE` SELECT(`ApprovalTemplateGroupService.ts:358`),该函数本身与修复轮 1 新增的 `isApprovalTemplateVisibleForGroupLink` 前置校验(`routes/approvals.ts`,校验的是**模板**可见性,不涉及 group 的 org 归属)是两个独立的检查点——现场重跑证实修复轮 1 的改动没有掩盖或提前拦截这条 mutation 的信号,红点仍然精确落在锁文预言的位置。

**全量回归**(与 §19.1 共用同一次重跑,§15.4 内已完整记录命令与逐字输出,不重复贴):`Test Files 2 passed (2) / Tests 26 passed (26)`;`git status --porcelain` 与 `git diff --stat` 均限定在 `packages/ plugins/ .github/` 路径下为空(方法论同 §16)。

### 19.3 收尾核对

```
$ git status --porcelain -- packages/ plugins/ .github/
(空)
$ cmp /tmp/gateA-fix2-probe-backups/ApprovalTemplateGroupService.ts.orig \
    packages/core-backend/src/services/ApprovalTemplateGroupService.ts && echo OK
OK
```

（本节写入过程中本文档自身仍在被编辑,`git diff --stat` 的插入/删除计数会随本节剩余段落继续变化——不在此处贴一个会在写完这句话之后立刻过期的数字,道理同 §10.1「verdict 必须绑已发生的 SHA,不能靠预告」。提交后的精确 diffstat 见对应 commit 的 `git show --stat`,提交信息里会写。这里只用范围受限的 `git status --porcelain -- packages/ plugins/ .github/` 断言**代码路径**零残留、`cmp` 断言生产代码文件字节级复原——这两条在本节写完之后依然成立,已改动的文件只有本文档与 `lifecycle.db.test.ts` 的注释块,没有触碰 DDL、`plugin-tests.yml`、`vitest.config.ts`、s6a 钉、或任何生产 `.ts` 文件的可执行代码。）

### 19.4 本轮未处理(原状留给下一轮)

P2-3(B′ 处置口径并入 owner 勘误桶)、P3-6(F 补齐归档/挂接两格)、P3-7(squash `f6e8ea2d8` 等 wip 提交)、P3-8(三处逐字/注释更正)、P3-9(闭世界守卫披露,同 §9/§13.5,不新建)、P3-10(typecheck 边界已写入验证 MD,无需重复)——按 gate 报告原文列出,未在本轮触碰。

## 20. 修复轮 3(2026-09-18)—— gate `impl-gate-A-slice1-round1-20260918.md` P2-3 / P3-8 收口

被审 head:`004350867`(修复轮 2 之后)。本轮只动本文档、设计 MD、`lifecycle.db.test.ts`、`serialization.db.test.ts`(均为注释/用例名/说明性断言标注)、`vitest.config.ts`(一处注释)——**不改 DDL、不改 `plugin-tests.yml`、不改任何生产 `.ts` 文件的可执行代码**(两处 mutation 探针已在 `metasheet2_lock_a` 上现场执行并 `cp` 复原,见 §20.1)。测试数量不变(26,同 §19)。P3-6/P3-7/P3-9/P3-10 本轮未处理,原状见 gate 报告,留给下一轮或 owner。

### 20.1 P3-8 —— 三处逐字/注释更正

**(a)§15.6 与台账 #19c 的 `Test timed out in 20000ms` 更正为 `30000ms`**:现场重做 E(3)-c 的隔离改法(仅删 `routes/approvals.ts` 建组路由 handler 自己的 outer try/catch,`:1127` 的 `try {` 与 `:1137-1139` 的 `catch` 块,服务层 `ApprovalTemplateGroupService.ts` 的 try/catch 保持不动——与门审 §15.6 描述的隔离方式一致):

```
$ cp packages/core-backend/src/routes/approvals.ts /tmp/gateA-fix3-probe-backups/approvals.ts.orig
$ python3 - <<'PY'   # 删除建组路由 handler 自己的 try { / } catch (error) { ... }
PY
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    -t "COMMIT-time" --reporter=verbose
 × E: COMMIT-time (not statement-time) DEFERRABLE violation on the production create path maps to
     500 GROUP_SORT_CONFLICT
   Unhandled Rejection: ServiceError: Group sort order conflict
     at mapGroupConstraintError (src/services/ApprovalTemplateGroupService.ts:141:14)
   Error: Test timed out in 30000ms.
$ cp /tmp/gateA-fix3-probe-backups/approvals.ts.orig packages/core-backend/src/routes/approvals.ts
$ cmp /tmp/gateA-fix3-probe-backups/approvals.ts.orig packages/core-backend/src/routes/approvals.ts && echo OK
OK
$ (单独重跑,回绿) ✓ E: COMMIT-time ... 1 passed
```

`30000` 与 `vitest.integration.config.ts:19` 的 `testTimeout: 30000` 一致。**机械核实这不是漂移**:该配置文件自创建以来只有一次提交,且该提交本身就写的是 `30000`——

```
$ git log --oneline -- packages/core-backend/vitest.integration.config.ts
e0defbe26 ci(attendance): publish a stable web guard check (#4585)
```

只有 1 条提交(计数:1),`30000` 从这份文件存在的第一天就是这个值,`20000ms` 在本仓历史上对这份配置**从未成立过**——旧记录是笔误,不是后来的漂移。已同步改写 §15.6 正文与台账第 19c 行,并顺带更正该处已过期的路由行号(`routes/approvals.ts:1103,1113-1115` → 现场 `:1127,1137-1139`,系修复轮 1 的 P2-1 在同文件更早处插入代码所致的行号下移,非本轮改动)。

**(b)`serialization.db.test.ts` 头部注释 mutation (4) 的未收尾自我更正**——原文先写「since there is no group-row lock left for it to queue behind」再用「... actually」推翻自己,是草稿思维过程留在交付件里。已重写成单一陈述:K 的 rename 腿屏障就是 L0 advisory lock 本身(holder 不取任何 L1 行锁),判别性 mutation 是删 `takeOrgLock` 的两行。纯注释改动,不影响任何 `it()` 的可执行内容。

**(c)`vitest.config.ts:1825` 附近注释说反了 isolation level 且借用了本文件没有的「goldens」措辞**——已重写为:生产走的是 RC(`createApprovalTemplateGroup` 内显式 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);本文件把连接池默认值强制成 RR,**刻意不同于生产**,目的是让那条 `SET` 的缺失/失效变得可观察(否则会静默读到过期的 RR 快照);并删除了「export/serialization goldens」这一无实指的借用措辞(本文件没有 golden 文件)。这是 `exclude` 数组内某一项的注释,数组内容(哪些文件被排除)零变化,不触发 s6a 重钉(s6a 只钉 `plugin-tests.yml`)。

**回归确认**(三处都是注释/逐字更正,唯一有代码语义的改动是(a)的探针已 cp 复原):

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  26 passed (26)
$ pnpm run type-check   # tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json
(无输出,exit 0)
```

### 20.2 P2-3 —— B′ 处置口径并入 owner 勘误桶;说明性断言标注;用例名收窄

门审的判定本身(BLOCKED-with-reason 的技术事实:I2′ 判定不存在于任何应用代码路径,§15.2)未被推翻,**被更正的是处置口径**:原验证 MD §17 #2 把 B′ 自行判定为「留给 A-4」的既成事实,而 §17 #3(J 前端半 + 未知 `section=` ⇒ 400)是**同一类**锁文自相矛盾(锁文 §6「期 1」门把该验收行列入本切片范围,但其唯一消费方要到 A-4 才存在)却走的是「升 owner 勘误」——同一类问题两种处置口径,违反「验收判据集合必须自洽」。

**改动**:
1. 验证 MD §17 #2/#3 重写(见上方对应 diff),三项(J 前端半、`section=`/`category` 互斥 400、B′)并列同一个 owner 勘误桶。
2. 设计 MD §6 表新增一行(B′,并入补充清单 #5 同桶),§7 收尾句「两条」改「三条」。
3. `lifecycle.db.test.ts` B′ 用例改动(纯注释/命名/断言旁注,零行为代码变化):
   - 用例名从「unlinked-from-group templates show as ungrouped, never falling back to category; never-linked templates still show category」(暗示了一个本切片不存在的展示行为)收窄为「B′ (DB-level predicate only, no display consumer until A-4): "no link row exists" — not "group_id IS NULL" — is the correct never-grouped predicate」(只claim它证明的东西:两条 SQL 谓词在 DB 层面的区分)。
   - `it()` 上方新增说明,指向 A-4/§15.2/§17 #2-#3。
   - `:494`(`expect(rejectedPredicate.rows[0].looks_never_grouped).toBe(true)`,现场 `grep -n "rejectedPredicate\|looks_never_grouped" lifecycle.db.test.ts` 核实行号)旁新增注释,明写这是「断言自己查询出的值等于自己」、按构造恒真、零 mutation 判别力,只是给人类读者解释被拒绝谓词的失败模式;并把行尾注释从「red under the rejected predicate」(暗示存在红态)改为「always true — see note above; not a gate」。

**回归确认**(与 §20.1 共用同一次全量重跑,§20.1 已贴,不重复):`Test Files 2 passed (2) / Tests 26 passed (26)`(用例数不变:改的是名字与注释,不是新增/删除 `it()`);`pnpm run type-check` exit 0。

### 20.3 收尾核对

```
$ git status --porcelain -- packages/ plugins/ .github/
(空)
$ cmp /tmp/gateA-fix3-probe-backups/approvals.ts.orig packages/core-backend/src/routes/approvals.ts && echo OK
OK
$ cmp /tmp/gateA-fix3-probe-backups/ApprovalTemplateGroupService.ts.orig packages/core-backend/src/services/ApprovalTemplateGroupService.ts && echo OK
OK
```

本轮触碰的文件仅限:本文档、设计 MD、`lifecycle.db.test.ts`、`serialization.db.test.ts`、`vitest.config.ts`(注释)——`git diff --stat`(提交时的精确计数见对应 commit 的 `git show --stat`)不包含任何生产 `.ts` 文件、DDL、`plugin-tests.yml`。s6a 钉不受影响(`plugin-tests.yml` 零改动)。

### 20.4 本轮未处理(原状留给下一轮)

P3-6(F 补齐归档/挂接两格)、P3-7(squash `f6e8ea2d8` 等 wip 提交——**本轮评估后确认无法在不 force-push 已推送分支的前提下完成**,squash 会改写已 push 到 `origin/feat/approval-template-groups-phase1` 的提交 SHA,需要 force,超出本轮授权范围,升级为需要 owner/门审明确批准 force-push 才能做)、P3-9(闭世界守卫披露,同 §9/§13.5,不新建)、P3-10(typecheck 边界已写入验证 MD,无需重复)。

## 21. 修复轮 4(2026-09-18)—— gate `impl-gate-A-slice1-round1-20260918.md` P3-6 收口;P3-7/P3-9/P3-10 结转确认

被审 head:`ff993d3ef`(修复轮 3 之后)。本轮只动 `lifecycle.db.test.ts`(F 用例内追加两段断言,零其他文件)与本文档——**不改 DDL、不改 `plugin-tests.yml`/`vitest.config.ts`、不改任何生产 `.ts` 文件的可执行代码**(两条 mutation 探针已在 `metasheet2_lock_a` 上现场执行并 `cp` 复原,见 §21.2)。

### 21.1 P3-6 —— F 补齐归档 / 挂接两格

Gate 指出 F 只覆盖锁文点名的三个写动作(建组/归档/挂接)中的一个(建组),归档、挂接两格的 403 拒绝断言缺失,虽然今天三条路由共享同一个字面 `approvalTemplateAdminGuard` 常量、覆盖缺口不构成活缺陷,但锁文按名逐格,验收表就该按名逐格。

**改动**(`packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`,均在既有 `F: authorization...` 用例内追加,零新增 `it()`):
- `:498-503` 用例上方新增块注释,记录 P3-6 的处置理由(逐字见文件)。
- `:521`:`createAsAdmin` 的响应体现在被解出 `group` 变量(此前只断言 `status`,未取 body),供归档/挂接两格复用同一个 admin 建出的组作固定装置。
- `:525-530`(归档格):`nobody` 对该组调 `/archive` ⇒ 断言 `403`(`:528`);并直接查 `approval_template_groups.archived_at` 断言仍为 `NULL`(`:530`,零写入,不是只看状态码)。
- `:532-540`(挂接格):新建一个模板,`nobody` 对它调 `/group`(带 `groupId`)⇒ 断言 `403`(`:535`);并查 `approval_template_group_links` 计数断言为 `0`(`:540`)。

**Mutation 探针(两条,`cp` 备份 → 改 → 单独跑 `-t "F:"` → `cp` 还原 → `cmp` → 单独重跑回绿 → 全量重跑回绿;`/tmp/gateA-fix4-probe-backups/`)**:

| # | 目标 | 改动 | 命令关键结果 | 判定 |
|---|---|---|---|---|
| P3-6-M1 | `/api/approval-template-groups/:id/archive` 路由的 `approvalTemplateAdminGuard` | 从路由参数表整体删除该 guard(`routes/approvals.ts:1154`) | `-t "F:"`:`expected 200 to be 403`,失败行精确落在新增的 `archiveAsNobody` 断言(`:528`) | **RED ✓**——归档格有判别力 |
| P3-6-M2 | `/api/approval-templates/:id/group`(POST,链接端点)的 `approvalTemplateAdminGuard` | 从该路由参数表删除该 guard(`routes/approvals.ts:1177`;同名 `DELETE .../group`(`:1204`,取消挂接端点)未动,仅改 POST 一行) | `-t "F:"`:`expected 201 to be 403`,失败行精确落在新增的 `linkAsNobody` 断言(`:535`) | **RED ✓**——挂接格有判别力 |

两条探针逐条单独执行、单独还原:`cmp /tmp/gateA-fix4-probe-backups/approvals.ts.orig packages/core-backend/src/routes/approvals.ts` 均 `OK`;每条还原后单独重跑 `-t "F:"` 回绿;全部完成后全文件套件收尾重跑:

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  26 passed (26)
```

（用例数不变:26,与 §20 一致——本轮只在既有 F 用例内追加 `expect`,未新增/删除任何 `it()`。）

```
$ pnpm run type-check   # tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json
(无输出,exit 0)
```

### 21.2 收尾核对

```
$ git status --porcelain -- packages/ plugins/ .github/
 M packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts
$ cmp /tmp/gateA-fix4-probe-backups/approvals.ts.orig packages/core-backend/src/routes/approvals.ts && echo OK
OK
```

生产代码文件(`approvals.ts`)经两条 mutation 探针后字节级复原;唯一实际改动是测试文件内的追加断言。`git diff --stat -- packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts` 的精确插入/删除计数见对应 commit 的 `git show --stat`。DDL、`plugin-tests.yml`、`vitest.config.ts` 本轮零改动,s6a 钉不受影响。

### 21.3 P3-7 / P3-9 / P3-10 结转确认(不重复处置,只确认原判仍然成立)

三条在 §19.4/§20.4 已各自拿到处置说明,本轮逐条重新核实原判在当前 HEAD 上依然成立,不是简单抄写:

- **P3-7**(squash `f6e8ea2d8` 等 wip 提交):`git log --oneline origin/main..HEAD` 现场重跑,`f6e8ea2d8`/`93e57198e`/`0d2ed3389` 三个提交仍在分支历史中且已推送到 `origin/feat/approval-template-groups-phase1`(`git rev-parse HEAD` 与 `git rev-parse origin/feat/approval-template-groups-phase1` 相同)。squash 会改写这些已公开提交的 SHA,需要 `git push --force`,而本轮硬规矩明确「不用 force」——**disposition 不变**:升级为需 owner/门审明确批准 force-push 才能做,本轮不代为决定,不尝试变通(例如不做「新增一个 revert-and-redo 提交」这种绕过,因为那不是 gate 要求的「squash 成可读历史」,是另一种历史形状,属于同类「另造更窄同类物」的裁量越界)。
- **P3-9**(两个新真库套件无 `*-ci-wiring` 守卫):现场重跑 `grep -rl "approval-template-groups" scripts/ops/*.mjs`,`exit=1`(零命中,与 gate 报告一致,census 结论未变);未新建守卫——gate 原文本身已判定这不是阻塞项(「我不把它记为阻塞项」),补充清单 #1 的文义是「普查」而非「必须新建」,census 已完成,**disposition 不变**:已披露的残留,留给后续需要新建守卫时的独立切片,不在本轮范围内新建。
- **P3-10**(typecheck 证据 + `.test.ts` 不在 `tsc` 覆盖范围):本轮 §21.1 已现场补跑 `pnpm run type-check`(exit 0),延续 §18.3/§19/§20.1 每轮都补跑一次的做法;`tsconfig.json` 的 `exclude` 含 `**/*.test.ts` 这条既有仓内边界在 §18.3 已写入本文档且未变化,**disposition 不变**:不需要为同一条边界重复新写一遍说明。

三条均确认「原判仍然成立、无需改变处置」,不是遗漏未做。至此,gate 报告 P1/P2/P3 全部条目(P2-1 至 P2-5、P3-6 至 P3-10;P3-7/P3-8 与 P3-9/P3-10 表述见上)均已在修复轮 1–4 中处置完毕(修复实现,或改写归因/账目,或——仅 P3-7 一条——因触碰硬规矩边界而升级为待 owner 批准 force-push,记录在案,不由本轮代为决定)。

## 22. 修复轮 5(2026-09-18)—— gate `impl-gate-A-slice1-round2-20260918.md`(第 2 轮门审)P2-1 / P3-2 收口

被审 head:`5b3d6310c`(修复轮 4 之后;第 2 轮门审的被审 head 与此相同)。**提交内容是纯文档改动**——最终 `git diff` 只有本文档(`docs/development/approval-template-groups-phase1-verification-20260918.md`)一个文件,改的是 §12/§14/§17/§18.1/§18.2/§19.1 的行号与计数引用,§15 开头的行号作用域说明(新增一句为 §18.1/§18.2/§19.1 定性),以及新增的 §22.5(NIT 现场实测)——**零 `.ts` 改动、零 DDL、零 `plugin-tests.yml`/`vitest.config.ts` 改动落地**。P2-1/P3-2 两条本身是台账/行号勘误,不需要 mutation 探针(探针证明的是代码断言的判别力,这两条没有改动任何断言或代码),回归确认走的是「套件仍然全绿 + typecheck 仍然 exit 0」,同 §19.1 对纯注释改动的处理方式;但本轮**顺带核实了 NIT**(门审留白的一条行为差异事实),核实过程对 `routes/approvals.ts` 与测试文件各做了一次 mutation 式探针(`cp` 备份 → 改 → 跑 → 还原 → `cmp`),过程见 §22.5,收尾两个文件均字节级复原,不计入本轮的净代码改动。

### 22.1 P2-1 —— §14 补充清单 #4 的机械计数在修复轮 4 之后为假,现场重算

第 2 轮门审指出:补充清单 #4 那一行记录的「两文件负例状态断言共 15 处、配对 `error.code` 断言共 13 处、差额 2 处(`:492,497`)」,是修复轮 1 落地时的数字;修复轮 4(P3-6)往 F 用例里新增了两条裸 403(归档格 `archiveAsNobody`、挂接格 `linkAsNobody`),把负例状态断言总数推高到了 17,而配对断言仍是 13,差额应为 4,门审点名的两个行号在当前 HEAD 上也不是那两条 403。

现场重算(与门审报告使用同一条命令):

```
$ grep -noE "\.status\)\.toBe\((40[0-9]|500)\)" \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts | wc -l
      17
$ grep -noE "error\.code\)\.toBe\('[A-Z_]+'\)" \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts | wc -l
      13
$ grep -n "toBe(403)" tests/integration/approval-template-groups-lifecycle.db.test.ts
388:    expect(noTenantRes.status).toBe(403)
511:    expect(createAsNobody.status).toBe(403)
516:    expect(listAsNobody.status).toBe(403)
528:    expect(archiveAsNobody.status).toBe(403)
535:    expect(linkAsNobody.status).toBe(403)
```

17/13/差额 4,与门审报告数字一致;`:388` 与 `SESSION_ORG_REQUIRED` 配对(A‴(iii)),不计入差额;裸 403 的四处是 `:511`(`createAsNobody`)/`:516`(`listAsNobody`)/`:528`(`archiveAsNobody`,修复轮 4 新增)/`:535`(`linkAsNobody`,修复轮 4 新增)。**结论未变**:四处全部命中仓内既有、本锁未改动的共享中间件 `rbacGuardAny`(裸 `{ error: 'Insufficient permissions' }`,无 `code` 字段),不在补充清单 #4「本锁错误码」的适用范围内——错的只是台账数字,已在 §14 表格原地改写为 17/13/差额 4 与四个正确行号,并加注「修复轮 5 第二次重算」的历史脚注(第一次重算是修复轮 1,见 §18.2 撤回原全称句)。

### 22.2 P3-2 —— §12 验收映射表 / §18.1 / §18.2 / §19.1 的行号在修复轮 4 之后集体漂移,现场重算

第 2 轮门审的第二条发现:修复轮 4 之后,F 及其后的全部用例(F 自身、request-shape codes、`§2(a)`/`§2(b)`、G、H、B″、I′)整体下移;同时修复轮 3 曾把 E 前半头部注释从 6 行改成 5 行,造成 E/K 两组行号 off-by-one——分支里此前有两个专门的「recompute line citations」提交(`bdfe29974` 对应修复轮 1、`ff993d3ef` 对应修复轮 3),修复轮 4 之后没有第三个,属於已建立的纪律漏了一次。

现场逐条重新核对(命令为原样逐字输出,非目测重排;`\s` 是 GNU 扩展,macOS 系统 `grep` 不保证支持,改用可移植的 `-E "^ *(it|describe)\("`):

```
$ grep -nE "^ *(it|describe)\('" tests/integration/approval-template-groups-lifecycle.db.test.ts
242:  it('A: same-org active-name conflict is 409; a different org may reuse the name; an archived name may be reused', async () => {
269:  it('A′: cross-org does not overlap — the SAME global template goes into DIFFERENT groups for DIFFERENT orgs', async () => {
317:  it('A″: cross-org link is 404 (org-scoped row-lock SELECT); the composite FK is the last-resort DB guard', async () => {
349:  it('A‴: org comes ONLY from req.authenticatedTenantId — body/query orgId rejected, forged header ignored, missing tenant fails closed', async () => {
397:  it('B: archive is one transaction (members unlinked, never deleted); a concurrent link blocks then sees the archived state', async () => {
447:  it('B′ (DB-level predicate only, no display consumer until A-4): "no link row exists" — not "group_id IS NULL" — is the correct never-grouped predicate', async () => {
504:  it('F: authorization — write endpoints require approvalTemplateAdminGuard, the list endpoint requires approvals:read; denial writes zero rows', async () => {
544:  it('request-shape codes: GROUP_NAME_REQUIRED (blank name) and APPROVAL_GROUP_ID_REQUIRED (missing groupId)', async () => {
569:  it('§2(a): the exported visibility predicate — visible to a non-manager in its own scope, hidden outside it, and false for a nonexistent id', async () => {
591:  it('§2(b): the link endpoint 404s APPROVAL_TEMPLATE_NOT_FOUND (zero rows written) for a template id that does not exist', async () => {
638:  it('G: unarchive — clean case; blocked by another ACTIVE group with the same name; blocked by a group renamed into that name', async () => {
680:  it('H: unlink is idempotent — never-linked, already-unlinked, and active-link cases', async () => {
713:  it('B″: first-link and re-link share ONE atomic upsert; two concurrent FIRST links to different groups both succeed, later commit wins', async () => {
753:  describe('I′: I6 explosion-radius behavioural gate — automation template-visibility actor is UNCHANGED by this slice', () => {
796:    it('(a) MAIN sees exactly {dept-scoped, role-scoped}, never the unseen template; CONTROL sees nothing (positive control)', async () => {
824:    it('(b) all three actor constructors return EXACTLY the ApprovalTemplateVisibilityActor key set at runtime (no stray optional field)', async () => {
$ grep -nE "^ *(it|describe)\('" tests/integration/approval-template-groups-serialization.db.test.ts
161:  it('sentinel: the service pool REALLY runs repeatable-read default — a bare-BEGIN generic transaction is RR', async () => {
194:  it('E positive control: two same-org active groups committing the SAME sort_order hit 23505 on atg_sort_unique at COMMIT, not at INSERT', async () => {
221:  it('E positive control: archiving without clearing sort_order hits the paired CHECK (atg_sort_archived_pair) immediately', async () => {
233:  it('E: two concurrent creates via the PRODUCTION path get sort_order n+1/n+2 — the RC pin lets the second read the freshly-committed MAX', async () => {
278:  it('E: negative control — an unrelated advisory key never blocks a concurrent create (sanity check on the pg_blocking_pids probe, not a mutation-2 gate — see K below for that)', async () => {
300:  it('E: COMMIT-time (not statement-time) DEFERRABLE violation on the production create path maps to 500 GROUP_SORT_CONFLICT', async () => {
328:  it('K: an L0-only holder (no L1 row lock) stalls a concurrent CREATE in the same org', async () => {
350:  it('K: an L0-only holder stalls a concurrent RENAME of an existing group in the same org', async () => {
372:  it('K: an L0-only holder stalls a concurrent UNARCHIVE of an archived group in the same org', async () => {
```

A/A′/A″/A‴/B/B′(在 F 之前)未受影响,行号不变;F/request-shape/§2(a)/§2(b)/G/H/B″/I′(在 F 及其后)与 E 前半/K(off-by-one)全部按上方现场输出改写:

- §12 表:F→`:504`、G→`:638`、H→`:680`、B″→`:713`、I′→`describe:753`/`(a):796`/`(b):824`、E 前半 6 格→`:161,194,221,233,278,300`、K 三格→`:328,350,372`(均已在表格原地写入「原 `:NNN`」+ 变更原因,不是裸替换数字)。
- §18.1:`§2(a)` 块注释+用例体 `:521-552`→`:558-589`;`§2(b)` `:554-568`→`:591-605`。
- §18.2:G 用例内 `GROUP_NOT_ARCHIVED` 插入点 `:594-`/`:598-602`→`:638-`/`:643-647`;request-shape 用例 `:507-519`→`:544-556`。
- §19.1:G 用例正上方整段块注释 `:591-`→`:607-637`。

**因果链现场重算(不是估算)**——用 `git show <commit>:<path> | grep -n "it('X:"` 在每个中间提交上定位同一用例,得到精确的、按提交归因的位移(而不是把「差多少行」笼统摊给「插入约 37 行」):

```
$ for c in 252d01865 b352ee8de bdfe29974 888d01a81 004350867 cbaa1bc13 ff993d3ef 5b3d6310c; do
    ln=$(git show $c:packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts | grep -n "it('F:" | head -1 | cut -d: -f1)
    echo "$c  F@:$ln"
  done
252d01865  F@:480
b352ee8de  F@:485    ← 修复轮 1(P2-1/P2-4 代码提交):顶部新增 3 处 import,净 +5
bdfe29974  F@:485    ← 纯文档提交(recompute citations),不动测试文件,F 不变
888d01a81  F@:485    ← 纯文档提交(P2-2/P2-5 归因改写),不动测试文件,F 不变
004350867  F@:485    ← 纯文档提交(§19.2 措辞),不动测试文件,F 不变
cbaa1bc13  F@:498    ← 修复轮 3 代码提交(P2-3/P3-8 合并 + 字面值修正):+13(B′ 上方 NOTE 注释等)
ff993d3ef  F@:498    ← 纯文档提交(recompute citations after fix round 3),不动测试文件,F 不变
5b3d6310c  F@:504    ← 修复轮 4(P3-6)在 F 用例正上方插入 6 行块注释:+6(F 用例体内部另插入 18 行,不影响 F 自身的 it() 行号,但会顺移其后的 G/H/B″/I′)
```

同法核对 G(`it('G:`)在同一组提交上的位置:`525→594(+69,round1)→614(+20,round3的cbaa1bc13)→638(+24,round4的5b3d6310c:F内部18行+F上方6行块注释)`——`+20` 与 `+24` 相加正是 §12 表原先写的「+44」,现已按提交拆分并逐个验证,不再是一个笼统数字。H/B″/I′ 与 G 同一组三次提交下的位移完全相同(`+69`/`+20`/`+24`),因为它们与 G 之间没有插入任何行。

**缓解事实,不构成豁免**:§12 表同时给了逐字用例名,用例名全部未变——按仓内「按测试名钉,不按行号」的纪律,表格在改动前也仍可用;但门审既已点名,行号本应准确,本轮如实重算并写入,不以「用例名兜底」为由不改。

### 22.3 回归确认(纯文档改动,无需 mutation 探针)

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  26 passed (26)
$ pnpm run type-check   # tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json
(无输出,exit 0)
$ git status --porcelain
 M docs/development/approval-template-groups-phase1-verification-20260918.md
```

零 skip,26/26 与修复轮 1–4 及本轮之前一致(用例数不变——本轮未新增/删除任何 `it()`);typecheck exit 0;`git status --porcelain` 只有本文档一处改动,`.ts`/DDL/`plugin-tests.yml`/`vitest.config.ts` 均未触碰。

**s6a 钉不受影响,机械核对(不是仅凭「未改 plugin-tests.yml」的推断)**:s6a 的 `PINNED_EVIDENCE_FILES`(`plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs:254-297`)是一份固定的具名文件清单(10 个 `relativePath` 条目,含 `pluginTestsWorkflow` → `.github/workflows/plugin-tests.yml`),本轮唯一改动的文件不在这份清单里:

```
$ grep -c "approval-template-groups-phase1-verification-20260918.md" \
    plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs
0
$ git diff 5b3d6310c..HEAD --name-only
docs/development/approval-template-groups-phase1-verification-20260918.md
```

本轮改动的唯一文件既不在 `PINNED_EVIDENCE_FILES` 清单里,也不是 `PINNED_MODULE_RELATIVE_DIR` 下的 S1–S6 具名模块——s6a 的重算条件是「改了清单里的文件」,本轮零命中,不需要重钉,这是清单本身的事实而不是对因果的猜测。

### 22.4 本轮未处理 —— 第 2 轮门审报告剩余条目的处置说明(P3-3/P3-4 待下一轮修复;P3-5/P3-6/NIT 为记录性重确认)

- **P3-3**(serialization 头部 mutation 配方点名一个全仓不存在的函数 `takeOrgLock`,且同一注释块 mutation (3) 的机制记录与 §17 #7 的「本次未编辑该注释」自相矛盾):**未处理,留给下一修复轮**——这是测试文件内的注释改动(不是本文档),按本步「选一到两条」的范围,本轮选择了 P2-1/P3-2 这两条纯文档计数/行号修复,未把 P3-3 一并纳入,不是遗漏,是范围控制。下一轮的修法**不需要新造措辞**:同一注释块里 mutation (2) 已经写对了(「delete the `pg_advisory_xact_lock` line」),mutation (4) 只需照抄 (2) 的措辞、把函数名从 `takeOrgLock` 换成 `pg_advisory_xact_lock` 那一行即可,不必发明新的描述方式。
- **P3-4**(「guard 人口 ⊆ manager」是零 grep 计数的全称断言,承重两件事,今日成立但断言形式不成立):**未处理,留给下一修复轮**——同上,理由同 P3-3,且第 2 轮门审自己已经把这条的反例证伪过程、差集与计数(`approval-templates:*` 全仓授予 0 处)写全了,下一轮的工作是把这些证据抄写进 `routes/approvals.ts:396-399` 的代码注释、设计 MD §3.5、本文档 §18.1,不需要重新调查。
- **P3-5**(结转;`wip` 提交 `f6e8ea2d8`/`93e57198e`/`0d2ed3389` 仍在历史里;squash 需 force-push,超出本轮授权的措辞应改为「本 lane 选择不 force-push」):第 2 轮门审对第 1 轮 §21.3 的 disposition 重新核实后仍判「结转,不代 owner 裁」,并额外指出 PR body 措辞需要改正(不是「因授权限制无法 squash」,而是「本 lane 选择不 force-push」)。**disposition 不变**:本轮 `git log --oneline origin/main..HEAD` 重新确认三个 wip 提交仍在、仍已 push(见下方核对),不 squash、不 force-push;PR body 措辞的改正留到开 Draft PR 时一并处理(本切片当前无 PR 可改)。
- **P3-6**(结转;两个新真库套件仍无 `*-ci-wiring` 守卫):第 2 轮门审重新做了 census(`grep -rl "approval-template-groups" scripts/` 零命中 + 5 个同 step id 守卫 `node --test` 16/16 绿)并维持第 1 轮判定「已披露残留,非阻塞」。**disposition 不变**:本轮不新建守卫,留给需要新建时的独立切片,开 PR 时 body 需点名。
- **NIT**(非 UUID 模板 id 可能让失败点从 404 前移到 500;门审明确「未实测,不作结论」):**本轮已实测,门审留白的是「事实」不是「测试用例」,两者要分开处置**——把「要不要新增一格验收测试」的设计裁量,和「这条行为差异是否真实存在、需不需要在 §17/PR body 披露」的事实问题分开:前者确实是范围扩张,本轮不新增测试,留给 owner/下一次设计复核;后者是本轮**必须核实**的既有事实,不核实就不能对 owner 说「不确定」——现场验证过程与结果见下方 §22.5(新增小节),结论:**这是本切片自己的 P2-1 修复引入的一个真实行为差异**(非 UUID 模板 id + 一个格式合法但不存在的组 id 时:修复前 404 `GROUP_NOT_FOUND`,修复后 500 `APPROVAL_TEMPLATE_GROUP_LINK_FAILED`),已写入本文档 §17 与下方 §22.5,PR body 开出时必须点名为已知行为差异,不能只留一句「未验证」。

```
$ git log --oneline origin/main..HEAD | grep -E "^[0-9a-f]+ wip:|^f6e8ea2d8|^93e57198e|^0d2ed3389"
0d2ed3389 fix(approval): close orgId array bypass; correct stale error-code docstring
93e57198e fix(approval): scope group-archive unlink UPDATE to org_id
f6e8ea2d8 wip: carry step-agent changes forward (to be squashed by the lane)
```

P3-5 的三个提交现场核对仍在分支历史中,均已 push(`git rev-parse HEAD` = `git rev-parse origin/feat/approval-template-groups-phase1`)。

### 22.5 NIT 现场实测(不是新增测试用例,只是核实门审留白的事实是否属实)

门审的 NIT 写的是「未实测,不作结论」,不是「不重要,不用查」——一条会改变生产响应码的行为差异,若不核实就写进披露清单,等于对 owner 说了一句自己都没验证的话。核实方法沿用本文件既有的 mutation 探针纪律(`cp` 备份 → 改 → 单独跑 → `cp` 还原 → `cmp`),这里改的是「让本轮 P2-1 的新代码失效」以还原修复前的行为,而不是改断言。

**场景选择**:门审原句含糊地把「模板 id 非 uuid」和「组不存在」两件事混在一起说。拆成两个精确场景现场探测:

| 场景 | 模板 id | 组 id | 修复前(禁用 §2 校验块) | 修复后(当前 HEAD) |
|---|---|---|---|---|
| (1) 组存在 | `not-a-uuid` | 一个真实建出的组 | 500(见下)| 500(未变) |
| (2) 组不存在但格式合法 | `not-a-uuid` | `randomUUID()`,未落库 | **404** `GROUP_NOT_FOUND` | **500** `APPROVAL_TEMPLATE_GROUP_LINK_FAILED` |

**场景 (1)**(临时 `it()`,`approval-template-groups-lifecycle.db.test.ts`,§2(b) 之后,跑完即删,零残留):对当前 HEAD 直接发起 `POST /api/approval-templates/not-a-uuid/group`(`groupId` 指向一个真实建出的组):

```
ZZGATE-R5-NIT-PROBE result: 500 {"ok":false,"error":{"code":"APPROVAL_TEMPLATE_GROUP_LINK_FAILED","message":"Failed to link approval template to group"}}
```

日志确认根因是新代码本身(`isApprovalTemplateVisibleForGroupLink` 的 `SELECT ... WHERE id = $1`,`templateId` 直接吃 `req.params.id`):`error":"invalid input syntax for type uuid: \"not-a-uuid\""`,`at isApprovalTemplateVisibleForGroupLink (…/routes/approvals.ts:413:18)`。但这一格**不足以证明是本轮引入的变化**——组存在时,修复前的旧路径(`linkApprovalTemplateToGroup` 的 `INSERT ... VALUES ($1, $2, …)`,`$2` 是同一个非法 `templateId`,该列同样是 `uuid` 类型)同样会在 INSERT 上抛同一个 22P02。`mapGroupConstraintError`(`ApprovalTemplateGroupService.ts:133-145`)不认这个错误码——机械核对,不是目测:

```
$ grep -c "'22P02'\|\"22P02\"" packages/core-backend/src/services/ApprovalTemplateGroupService.ts
0
```

该函数只处理 `error instanceof ServiceError`(原样返回)与 `pgErr.code === '23505'` 的两个具名约束分支,零处理 22P02,原样 `return error` 交给路由层 `catch` 的通用 500 兜底——所以场景 (1) 组存在时,修复前后都会走到未被映射的 22P02,**都是 500,零变化**,只是错误发生的语句不同(修复前是 INSERT,修复后是新增的 SELECT)。

**场景 (2)** 才是判别点:用一个**语法合法但未落库**的组 id(`randomUUID()`)。

- **修复后(当前 HEAD,未改任何代码)**:
  ```
  ZZGATE-R5-NIT-PROBE-2 result: 500 {"ok":false,"error":{"code":"APPROVAL_TEMPLATE_GROUP_LINK_FAILED","message":"Failed to link approval template to group"}}
  ```
- **修复前(mutation 模拟,不是真的切到 `252d01865` 那次提交)**:注释掉 `routes/approvals.ts:1191-1194` 的 §2 可见性校验块,还原到本轮 P2-1 之前的调用路径,`cp` 备份 → 改 → 跑 → 还原 → `cmp OK`。没有直接 checkout 旧提交的原因:测试文件顶部按名导入 `isApprovalTemplateVisibleForGroupLink`(本轮才新增的导出),整体换成旧版 `approvals.ts` 会让这个导入在运行时找不到该导出、连测试文件本身都跑不起来——mutation 式禁用是能在**同一个测试文件**下精确还原「调用路径回到 P2-1 之前」这件事的唯一办法,不是图省事的替代:
  ```
  ZZGATE-R5-NIT-PROBE-2 result: 404 {"error":{"code":"GROUP_NOT_FOUND","message":"Group not found"}}
  ```
  机制:`linkApprovalTemplateToGroup` 先对**组**做 `SELECT ... WHERE org_id = $1 AND id = $2 FOR UPDATE`(`$2` 是格式合法的 `groupId`,不报 22P02),`locked.rows.length === 0` ⇒ 抛 `ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')`——这一步在触碰非法 `templateId` 之前就返回了,所以修复前根本走不到会抛 22P02 的那条语句。修复后,§2 校验块在调用 `linkApprovalTemplateToGroup` **之前**就先对 `templateId` 做 `SELECT`,不管 `groupId` 是否存在都会先在这里抛 22P02。

**结论(真实、非推断)**:本切片新增的 §2 挂接可见性校验,把「模板 id 是否为合法 uuid」的检查时机从**组检查之后**移到了**组检查之前**——对「模板 id 非法 + 组 id 合法但不存在」这一个具体组合,响应从 404 `GROUP_NOT_FOUND` 变成了 500 `APPROVAL_TEMPLATE_GROUP_LINK_FAILED`。这是本切片自己的修复引入的真实行为差异,不是「今天不可达」的假设性缺口(与 P3-4 的「今天不可达」不同类,不要混同处置)。**范围判断**:是否要为这一格补验收测试是设计裁量(NIT 本身不构成阻塞、不构成本轮修复项),但「这条差异存在」是必须写入披露的事实——已写入本文档 §17 与 PR body 待写清单。

**收尾(两条探针均已还原,零残留)**:
```
$ cmp /tmp/approvals-nit-backup.ts packages/core-backend/src/routes/approvals.ts && echo OK
OK
$ cmp /tmp/nit-probe-backup.orig packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts && echo OK
OK
$ git status --porcelain
 M docs/development/approval-template-groups-phase1-verification-20260918.md
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  26 passed (26)
```

**本轮小结**:第 2 轮门审的 1 P2(阻塞)+ 5 P3 + 1 NIT 中,P2-1(阻塞项)与 P3-2 本轮完成实际修复;P3-3/P3-4 明确留给下一修复轮(范围控制,非遗漏);P3-5/P3-6 完成「记录性重确认」(disposition 未变);NIT 完成**现场实测**并确认是真实行为差异,已写入披露,是否补验收测试留给设计裁量。gate 报告的 verdict 是「只差 P2-1 一条」DRAFT-READY,本轮已把该条闭合;P3-3/P3-4 不影响 DRAFT-READY 判定(门审原文:两条都是 P3),但仍需下一轮处置才算「全部处理完」。

## 23. 回流修复(2026-09-18,来自 A-3 设计门审)

**来源**:`design-gate-A3-phase2-20260918.md`(分期 2 backfill 切片的独立门审报告)在审查 A-3 提案时,对**已落地的 A-1 代码**(本切片,`0144932ac`)做了两处溢出发现,要求回流:P1-3(实测 M5,`atg_name_nonblank` 拒绝纯中文名 ⇒ A-1 端点今天就是 500)与 P2-5(`routes/approvals.ts:396-399` 的「guard population ⊆ manager」注释是过强声明,现场核对为假)。P2-5 与本文档 §22.4 已记录的 P3-4(第 2 轮门审「零 grep 计数的全称断言」,本轮之前一直标注「留给下一修复轮」)是**同一条发现**——本节就是那个「下一修复轮」,不是新开的独立工作。

本节全部实测在私有库 `metasheet2_lock_a1_fix`(`createdb` + 全量 `migrate`,`Pending: 0`)上现场执行,worktree `/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-groups`(分支 `feat/approval-template-groups-phase1`)。

### 23.1 P1-3 —— 复现:私有库上 `createApprovalTemplateGroup(org, '人事')` ⇒ 裸 `DatabaseError` 23514 ⇒ 端点 500

```
$ npx tsx repro-cjk-name.mjs   # createApprovalTemplateGroup(org, '人事', 'probe-actor')
name: error
constructor: DatabaseError
code: 23514
constraint: atg_name_nonblank
statusCode: undefined
message: new row for relation "approval_template_groups" violates check constraint "atg_name_nonblank"
```

这与 A-3 门审 M5 的现场测量逐字一致(`code=23514 constraint=atg_name_nonblank statusCode=undefined`,`ServiceError` 之外的裸 `DatabaseError`)。`handleApprovalsError`(符号定位,`grep -n "function handleApprovalsError" routes/approvals.ts`,~546-566——**锚点改用「符号 + 近似行号」,impl-gate-A-slice1-round4-20260918.md P3-1 收口**,上一版写的 `:509-524` 在本轮已漂移)只对 `error instanceof ServiceError` 特判,裸 `DatabaseError` 落到函数尾部的通用 500 兜底——即端点 `POST /api/approval-template-groups {name:'人事'}` 今天确实是 500,不是假设。

### 23.2 修法 —— 在既有 23505 映射的同一处(`mapGroupConstraintError`)把 23514 映射为 400 `GROUP_NAME_UNSUPPORTED`

改动位置:`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`,`mapGroupConstraintError`(与既有 `uq_atg_org_name_active`/`atg_sort_unique` 的 23505 分支同一个函数,同一处堆叠 `if`,不是新开一条映射路径)。

```ts
const NONBLANK_CHECK_CONSTRAINTS = new Set(['atg_name_nonblank', 'atg_org_nonblank', 'atgl_org_nonblank'])
// … 既有 23505 分支之后 …
if (
  pgErr && typeof pgErr === 'object' && pgErr.code === '23514'
  && typeof pgErr.constraint === 'string'
  && NONBLANK_CHECK_CONSTRAINTS.has(pgErr.constraint)
) {
  return new ServiceError(
    '当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误',
    400,
    'GROUP_NAME_UNSUPPORTED',
    { constraint: pgErr.constraint },
  )
}
```

三个约束(`atg_name_nonblank`/`atg_org_nonblank`/`atgl_org_nonblank`)一并映射——任务书点名的集合;后两个是防御性的(路由层已在 `resolveApprovalTemplateGroupOrgId` 里对空白 `org_id` 先行 403,正常路径到不了它们,详见服务文件里新增的文档注释)。**如实披露:`atg_org_nonblank`/`atgl_org_nonblank` 这两条分支本轮零行为覆盖**——§23.3 的真库用例只打了 `atg_name_nonblank`;`mapGroupConstraintError` 未导出,没有绕过路由层直接命中这两条分支的单元测试路径;这两条分支目前只受 tsc 编译检查与代码走查保护,是本轮已知但未关闭的覆盖缺口,不是被验证过的行为,留待日后若要单独测试它们时需要先导出该函数或新造一条能绕过路由层前置校验的调用路径。**不放宽 CHECK**——`atg_name_nonblank` 本身仍是 `CHECK (name ~ '[!-~]')`,一个纯中文名依然建不出组;改变的只是失败的**形状**(400 + 具名错误码 + 携带 `constraint` 字段,而不是不透明的 500)。这是请求形状映射,不是 DDL 变更,不需要 owner 闸;§23.4 是另外一条、且是 DDL 的、确实需要 owner 裁决的勘误请示。

**用词披露**:`ServiceError` 的 `message` 字段本轮用了中文原句「当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误」——这是本文件里**唯一**一条非英文的 `ServiceError` message(其余六个既有错误码的 message 全是英文),且「owner 勘误」是内部治理词汇,不是面向最终用户的产品文案,原样出现在一个生产 HTTP 响应体里。这不是疏忽:任务书原文逐字要求「错误体带 constraint 名与一句『当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误』」,本节按字面执行,`{constraint}` 放进 `details`、这句话放进 `message`——两者任务书都点了名,`details` 已经满足「错误体带 constraint 名」,message 的中文/内部措辞是对任务书那句原文的直接落实,不是本轮自行引入的风格漂移。若这条错误信息将来要国际化或改用面向用户的措辞,是一次独立的、需要另行裁量的改动,不属于本回流修复的范围。

**补充披露(impl-gate-A-slice1-round4-20260918.md P3-3,处置=如实披露,不改动断言)**:`lifecycle.db.test.ts`(`grep -n "toContain" lifecycle.db.test.ts | grep -i 锁文` 定位,~593-594)用 `expect(cjkBody.error.message).toContain('当前锁文 CHECK 只接受可打印 ASCII')` + `.toContain('owner 勘误')` 把上面这两句中文子串**冻结成了测试断言**——这与「message 本身是任务书原句的直接落实」是两件事:后者说的是这句话**从哪来**(如实、有出处),前者说的是这句话**现在被谁钉住**(未来想国际化或改面向用户的措辞,必须同时改这两行断言,而单纯改测试断言在后续门审眼里可能被误读成「测试被放宽以掩盖行为降级」,即便实际情况是「文案本来就该改」)。**本轮选择不动断言**(§0 硬规矩:不擅自决定合同层面的取舍;报告建议的收窄方向——把断言改成「`message` 非空 + `details.constraint` 命中」——虽然技术上可行且不会削弱 M1 mutation 的判别力(该 mutation 已经通过 `details.constraint` 与 `status` 两个字段独立判别,不依赖 `message` 文案),但那是对「这句文案算不算需要维护的公开合同」的一次实质裁决,不是本轮该单方面做的收窄):**如果/当** owner 就 §23.5 的 `atg_name_nonblank` CHECK 勘误做出裁决(改或不改 DDL),这两行 `toContain` 断言应该在同一次改动里被owner 一并裁决是否收窄——不要等到国际化需求出现时才发现测试把内部治理词汇焊死在了公开响应体的契约里。

复现同一探针(未改任何测试文件,只改了服务文件)确认已修复:

```
$ npx tsx repro-cjk-name.mjs   # 修复后,同一调用
name: ServiceError
constructor: ServiceError
code: GROUP_NAME_UNSUPPORTED
statusCode: 400
message: 当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误
```

### 23.3 永久回归用例(真库,HTTP 端到端)

新增 `it('P1-3 (design-gate A-3, 2026-09-18): a pure-CJK group name maps to 400 GROUP_NAME_UNSUPPORTED, not a raw 500 — an ASCII name in the same org still succeeds', …)`(`approval-template-groups-lifecycle.db.test.ts`,紧跟在既有 `request-shape codes` 用例之后):对同一 org,`POST /api/approval-template-groups {name:'人事'}` ⇒ 400 + `error.code === 'GROUP_NAME_UNSUPPORTED'` + `error.details.constraint === 'atg_name_nonblank'` + 错误消息同时包含「当前锁文 CHECK 只接受可打印 ASCII」与「owner 勘误」两个子串(响应体必须同时携带约束名与 owner 勘误提示,任一半被静默降级都会重新掩盖 500 掩盖过的同一件事);零行写入(`SELECT … WHERE org_id=$1 AND name=$2` 命中 0 行);**正控**:同一 admin、同一 org,一个 ASCII 名字(`HR ${TS}`)仍然 201——证明这是请求形状映射,不是把整条创建路径或 guard/鉴权判成了拒绝。

### 23.4 mutation(把 23514 映射删掉 ⇒ 用例红)

遵守本仓 mutation 探针纪律:`cp` 备份 → 改 → 单独跑受影响用例 → `cp` 还原 → `cmp` 逐字节核对。

```
$ md5 src/services/ApprovalTemplateGroupService.ts
MD5 (…/ApprovalTemplateGroupService.ts) = f59e76d76070f065e6d214485913fe1a
# 删除 mapGroupConstraintError 里新增的整个 23514 if 块（python3 精确文本替换，非手工编辑）
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "P1-3" --reporter=dot
 ❯ … P1-3 … a pure-CJK group name maps to 400 GROUP_NAME_UNSUPPORTED …
   AssertionError: expected 500 to be 400 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 17 skipped (18)
# 还原
$ cp /tmp/a1-fix-probe/ApprovalTemplateGroupService.ts.orig src/services/ApprovalTemplateGroupService.ts
$ cmp /tmp/a1-fix-probe/ApprovalTemplateGroupService.ts.orig src/services/ApprovalTemplateGroupService.ts && echo RESTORED-IDENTICAL
RESTORED-IDENTICAL
$ md5 src/services/ApprovalTemplateGroupService.ts
MD5 (…/ApprovalTemplateGroupService.ts) = f59e76d76070f065e6d214485913fe1a
```

删掉映射后,同一用例从 400 变红成 500——mutation 证明这条映射是承重的,不是装饰性断言。还原后 MD5 与还原前逐字节一致。

### 23.5 owner 勘误请示(原文,来自 A-3 门审 O2,verbatim 转述,本节不擅自采纳)

> **逐句失效标记(第 8 轮门审 P2-3 收口,2026-09-20)。本节不作废** —— 它正是 owner 要读来回答那条请示的材料,整节 void 会让它读不成。只有下列两句失效,其余句子仍 OPERATIVE:
>
> | 本节原句 | 在当前 head 上的求值 |
> |---|---|
> | 「本轮的修法(§23.2)是请求形状映射,**不触碰 DDL**」 | **已为假**。本分支确实改了 DDL:`atg_name_nonblank` 的谓词被改写为勘误 3 候选。见 §27/§28。 |
> | 「`atg_name_nonblank` 这条 CHECK 本身在本切片结束时**与 ratify 时逐字相同**」 | **已为假**。同上。两处 `org_id` CHECK(`atg_org_nonblank`/`atgl_org_nonblank`)仍与 ratify 时逐字相同 —— 这一半仍成立,并由 §28 的真库用例正向断言。 |
>
> | 本节原句 | 求值 |
> |---|---|
> | 「锁 §2 的约束清单是 ratify 对象,只有 owner 能改」 | **仍 OPERATIVE**。本分支上的改动是**候选**,不是采纳;ratify 仍待 owner 亲写一句话。 |
> | 「若 owner 批准,需要一次新的、独立的、含 DDL 迁移的 Draft PR」 | **仍 OPERATIVE**,且这就是本分支的性质(未开 PR、未合并、未应用)。 |
> | 请示中被提议的谓词 `CHECK (btrim(name) <> '')` | **已被替换**,不是被作废:第 8 轮门审 P2-1 证伪了它(`btrim/2` 默认裁剪集只有 ASCII 空格);请示按「勘误 3(重拟)」选项 (i) 重拟,谓词见 §28.1。**请示本身仍然开着,等 owner 回答。** |

设计门审 `design-gate-A3-phase2-20260918.md` §5 O2 原文:「`atg_name_nonblank CHECK (name ~ '[!-~]')` 拒绝纯中文名 —— **锁 §2 约束清单勘误**,且是 A-1/#5852 上的活缺陷」,默认值「建议改成 `CHECK (btrim(name) <> '')`;在 owner 裁决前,A-3 按 changesRequired #3 跳过+披露」。

**这是本切片(A-1)未采纳、也不能采纳的一条**:锁 §2 的约束清单是 ratify 对象,只有 owner 能改;本轮的修法(§23.2)是请求形状映射,不触碰 DDL,`atg_name_nonblank` 这条 CHECK 本身在本切片结束时与 ratify 时逐字相同。**待 owner 裁决**:是否将 `CONSTRAINT atg_name_nonblank CHECK (name ~ '[!-~]')` 改为 `CHECK (btrim(name) <> '')`(真正表达「非空白」,不歧视非 ASCII/CJK)——若 owner 批准,需要一次新的、独立的、含 DDL 迁移的 Draft PR(本 worktree/本切片明确不做,按硬规矩不动 DDL、不应用迁移到共享库)。在 owner 勘误落地前,§23.2/§23.3 的 400 映射是**唯一**能做的缓解:仍然拒绝纯中文名,但拒绝的形状从不透明 500 变成携带约束名与勘误提示的 400。

### 23.6 P2-5 —— `routes/approvals.ts:396-399` 「guard population ⊆ manager」是过强声明;本节自己的第一版修法换上了另一条实测为假的声明(impl-gate-A-slice1-round4-20260918.md §2 P2-1 收口,本段整段重写)

**本节的更正史,如实记录,不隐去**:本节第一版把下面反例 (1)(通配码)写成既成事实,论证只引了 `hasPermissionCode` 的资源前缀展开,漏掉了 `rbacGuardAny` 权限腿的第二个合取项。这不是新发现——**第 2 轮门审早就端到端实测过同一条并证伪**(见 `impl-gate-A-slice1-round3-20260918.md` §3 P3-3:「第 2 轮已自造反例并自证伪(`approval-templates:*` 持有者被 `rbac/namespace-admission.ts` 挡在 guard 外,实测 403;全仓授予计数 0)」)。本节第一版把 A-3 设计门审 P2-5 的**静态代码阅读**结论逐字誊回了正文,没有回读第 2 轮已有的实测记录。**第 4 轮门审独立复测,同样 403,是第二次证伪**(`impl-gate-A-slice1-round4-20260918.md` §2 P2-1)。以下是重写后如实的现场核对:

- `hasPermissionCode`(`rbac/rbac.ts:21-25`)对权限码确实做资源前缀通配展开:`permissionCodes.includes('approval-templates:*')` 能匹配到 `approval-templates:manage`。**但这只是 `rbacGuardAny` 权限腿的一个合取项**(`rbac/rbac.ts:134-142`):`requestUserHasResolvedPermission(requestUser, code) && await isPermissionAllowedByNamespaceAdmission(userId, code)`。`approval-templates` 是一个 admission-controlled resource(`namespace-admission.ts:139` 的 `derivePermissionNamespace` 对它返回非 null;`approvals` 才在 `:11` 的 `NON_NAMESPACED_PERMISSION_RESOURCES` 里被豁免),所以在**没有**额外 namespace-admission 授予的前提下,第二个合取项判假——`approval-templates:*` **与** guard 自己字面点名的 `approval-templates:manage` **两者都拿 403**,这是端到端实测(见下方五行输出),不是推断。这个「通配码过 guard」的主体形状只有在同一主体**另外**持有 `approval-templates` 的 namespace-admission 授予时才存在;全仓真实授予(migrations/seeds 里对 `role_permissions`/`user_permissions` 写入这个 code 的行)计数为 **0**——仓内命中这个字符串的位置全部是描述该机制的注释/文档,不是授予数据。
- `rbacGuardAny` 的最终兜底 `const adminCheck = await isAdmin(userId); if (adminCheck) next()`(`rbac.ts`)直接查 DB(`user_roles WHERE role_id='admin'`),与 `req.user.role`/`.roles`/`.permissions`(JWT 声明,`isTemplateManager` 读的就是这几个字段)完全独立——一个只在 DB 侧持 `user_roles(role_id='admin')`、JWT 里不带任何 admin/manager 声明的主体,**过 guard 但非 manager**。**这是本轮唯一被端到端实测支撑的反例**(§23.7 的 §2(c) HTTP 用例 + 其 mutation 负控:把 `resolveApprovalTemplateVisibilityActor` 的 `isTemplateManager` 硬编码为 `true` 会让隐藏模板一格从 404 变红 201;另有一条独立负控——删掉 §2(c) fixture 里那行 `user_roles` INSERT,建组请求从 201 变 403——证明这条 fixture 唯一的 guard 凭据就是那一行,不是别的腿顺带放行的)。

**判别式实测**(处女库 `metasheet2_gate_a_r4`,临时 `it()`,跑完按 `cp`→改→单独跑→还原→`cmp` 纪律核对;两条正控证明 token 传递路径本身是通的,唯一的判别变量是 namespace admission):

```
ZZR4-WILDCARD-RESULT   status=403 body={"error":"Insufficient permissions"}   ← perms='approval-templates:*'
ZZR4-WILDCARD-LINK     status=403 body={"error":"Insufficient permissions"}   ← 同主体打 link 端点
ZZR4-EXACT-RESULT      status=403 body={"error":"Insufficient permissions"}   ← perms='approval-templates:manage'(guard 自己字面点名的码!)
ZZR4-NONNS-CONTROL     status=201 ...                                          ← perms='approvals:admin-templates'(非 namespaced,正控)
ZZR4-STARSTAR-CONTROL  status=201 ...                                          ← perms='*:*'(正控)
```

真实计数(不是目测;修正 P3-5 指出的命令/输出形状不对齐——`grep -c ... -r` 对目录会逐文件打印 `路径:计数`,不会打印单独一个 `0`,这里改用会话时刻真实可重跑的形式)。**这条命令本身也被复核过一次**:第一版限定在 `packages/core-backend/src/db/migrations packages/core-backend/src/db/seeds` 两个目录并 `2>/dev/null` 吞掉了错误——而 `packages/core-backend/src/db/seeds` **根本不存在**(`ls` 返回 `No such file or directory`),意味着那条命令的「零命中」里有一半是对着一个不存在的路径扫出来的,不是真的扫过、确认没有;另外 `grep -rn ... | grep -i "role_permissions\|user_permissions"` 要求权限码字符串与表名**同一行**,一条跨行的 `INSERT INTO role_permissions (...)\n  VALUES (..., 'approval-templates:*', ...)` 会被这条管道漏掉。改用**全仓**(不限 `src/`,不限迁移/种子目录)搜这个字面量,再人工确认每一处命中的**上下文**是不是真授予,而不是靠管道二次过滤:

```
$ grep -rn "approval-templates:\*" . --include="*.ts" --include="*.vue" --include="*.sql" --include="*.json" --include="*.md" 2>/dev/null | grep -v node_modules | wc -l
12
```

12 处命中,逐一读上下文分类:4 处在本文档(本节的说明性文字 + 一处 `ZZR4-WILDCARD-RESULT` 判别式实测的日志转录字符串,不是数据库写入)、3 处在 `lifecycle.db.test.ts`(块注释)、4 处在 `routes.ts`(块注释)、1 处是 §18.1/P3-4 记录里的转述。**零处**出现在 `query(...)`/`INSERT INTO`/JSON 种子数据这类真正写库的上下文里——全部是散文或代码注释里描述这个字符串本身,不是把它当值写进 `role_permissions`/`user_permissions` 表。这是比「migrations/seeds 目录零命中」更宽、也更站得住的判定范围,与上面「全仓真实授予计数为 0」的措辞现在对得上。

**修法**(第二次重写——第一次重写换上的「guard ⊋ manager」结论本身也被第 6 轮门审 P2-1 证伪,不再留一条无限定的包含关系断言):先后撤回两句被证伪的过强声明——「guard population ⊆ manager population ⊆ sees everything」(原始声明)与「guard population ⊋ manager population(严格超集,不是子集也不是相等)」(第一次重写的替代声明)。新结论是:guard population 与 manager population **互不包含**,两个方向各有一个实测反例(方向一端到端实测;方向二的 guard 拒绝端到端实测,manager 判定由对导出解析器的直调实测,附负控——第 7 轮门审 P3-3 指出「两个方向都端到端」对方向二过强),谁都不是谁的子集——**方向一(guard 过、非 manager)**靠 DB 侧 `isAdmin` 腿(上方 `ZZR4-*` 记录 + §23.7 的 §2(c) 用例);**方向二(manager、guard 不过)**靠仅持 `approval-templates:manage` 这一个码本身(不含 namespace-admission 授予)的主体——上方 `ZZR4-EXACT-RESULT status=403` 这条记录当时只被读成「通配码腿的证伪证据之一」,没有同时被读成「manager 未必过 guard」的反例,本轮新增的 lifecycle `§2(d)` 用例把这一点钉成真库回归(附负控)。通配码那条腿今天仍不存在端到端可达形式,只有在额外持有 namespace-admission 授予时才存在,而全仓零处这样的授予,这一点未变。**生产 provisioning 路径上是否恒有「授予 `approval-templates:manage` 必同时授予对应 namespace admission」未经实测,本节不作断言**——上述两个方向的反例均在本测试 harness 的 `RBAC_TOKEN_TRUST` 配置下实测。**同一份结论有多处副本,均已按上述措辞第二次一并改写**:`routes/approvals.ts`(`isApprovalTemplateVisibleForGroupLink` 上方块注释)、设计 MD §3.5(`:169`)、本文档 §18.1(`:704`)、以及本节;§24.5 的机械扫描脚本本轮同步加宽,覆盖「⊋」/「严格超集」/「strict superset」等此前遗漏的表述(见 §25)。全部改动均为纯注释/MD/测试,**不改变任何运行时行为**——本节改写的是「这段注释对现有行为的描述」,不是行为本身。

### 23.7 真库用例:guard 通过但非 manager 的主体,link 端点的可见性过滤仍生效

**构造方法**:走 §23.6 修正后点名的、唯一被端到端实测支撑的反例(DB 侧 `isAdmin`)——它不需要新造任何 RBAC 授予关系,只需一行 `user_roles` INSERT,在既有测试 harness(`tok()` 走 `RBAC_TOKEN_TRUST=true` 的可信 token 路径)下**最干净可构造**:

1. `dev-token` 铸一个 `roles=user, perms=''`(**不含任何 admin/manager 声明**)、`tenantId=org` 的 token;
2. 直接对该 `userId` 执行 `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`——这是该主体唯一的「admin」痕迹,只在 DB 侧,JWT/`req.user` 上什么都没有;
3. 用该 token 打 `POST /api/approval-template-groups`(`approvalTemplateAdminGuard` 把守的写端点)—— **201**,证明 guard 确实放行了这个在 JWT 层面看起来毫无特权的主体(guard-pass 实证 #1);
4. 用同一 token 对一个 `visibility_scope={type:'dept', ids:['其他部门']}`(该主体的 `departmentIds` 为空,不含这个部门)的模板发起 `POST /api/approval-templates/:id/group` —— **404 `APPROVAL_TEMPLATE_NOT_FOUND`**,不是 403(guard-pass 实证 #2:如果 guard 没放行,任何子用例都会先 403,不会走到可见性判定这一步),零行写入;
5. 同一 token、同一 guard,对一个 `visibility_scope` 默认 `{type:'all', ids:[]}` 的模板发起同样的请求 —— **201**(正控:证明这是可见性过滤在起作用,不是整个端点对这个主体失灵)。

```
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "§2\(c\)" --reporter=dot
 ✓ …§2(c): a DB-side-admin actor (guard passes; NOT isTemplateManager) still has its LINK request visibility-filtered
 Test Files  1 passed (1)
      Tests  1 passed | 17 skipped (18)
```

**mutation**(同一纪律,`cp` 备份 → 改 → 单独跑 → 还原 → `cmp`):在 `resolveApprovalTemplateVisibilityActor` 里把 `isTemplateManager` 硬编码成 `true`(模拟「guard population ⊆ manager」这句被撤回的声明若为真时的行为):

```
$ md5 src/routes/approvals.ts
MD5 (…/approvals.ts) = 058c6cd157611be3f86f089986c5b4f0
# isTemplateManager: true,  // MUTATION PROBE(临时)
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "§2" --reporter=dot
 ❯ …§2(c): a DB-side-admin actor …
   AssertionError: expected 201 to be 404 // Object.is equality
 Tests  1 failed | 2 passed | 15 skipped (18)
# 还原
$ cp /tmp/a1-fix-probe/approvals.ts.orig src/routes/approvals.ts
$ cmp /tmp/a1-fix-probe/approvals.ts.orig src/routes/approvals.ts && echo RESTORED-IDENTICAL
RESTORED-IDENTICAL
$ md5 src/routes/approvals.ts
MD5 (…/approvals.ts) = 058c6cd157611be3f86f089986c5b4f0
```

硬编码 `isTemplateManager: true` 后,§2(c) 的隐藏模板一格从 404 变红成 201(可见性过滤被短路),而 §2(a)/§2(b) 两条既有用例仍绿——精确定位到 §2(c) 新增的 hidden-template 断言才是这条用例的判别力所在,不是可见模板那一格(那一格无论 manager 与否都应该 201,本身没有判别力,只是正控)。还原后 MD5 与还原前逐字节一致。

**结论**:这条真库用例证明了「存在过 guard 但非 manager 的主体,走到 link 端点时可见性过滤仍生效」——`applyTemplateVisibilityFilter` 不是靠 `isTemplateManager` 的短路才「恰好」安全,guard 与可见性判定是两个独立生效的判断层,即便某个主体绕过了 `isTemplateManager` 的识别(如本用例),可见性过滤仍然会把它限制在能看到的模板范围内。这**不是**说撤回的那句过强声明没有安全后果——它错误描述了一个不变量的**成立范围**(把「对多数今天真实存在的管理员成立」误写成「对整个 guard 人口成立」),如果日后有代码路径**依赖**「guard 人口就是 manager 人口」这个假设(例如一条「guard 通过就跳过可见性检查」的优化),那才会真正引入漏洞——本节的用例正是防止这类依赖被引入的回归锚点。

### 23.7a P3-4 收口 —— §2(c) 授予平台管理员角色的清理从「只靠 afterAll」改为「beforeAll 前置幂等扫 + afterAll 双保险」(impl-gate-A-slice1-round4-20260918.md P3-4)

**报告发现的残留风险**:§2(c) 往 CI 共享库 `metasheet_test` 写 `user_roles(user_id='vis3-dbadmin-<TS>', role_id='admin')`,清理只在 `afterAll`;如果进程在 INSERT 之后、`afterAll` 之前被中断(超时/OOM/`onTaskUpdate` 家族的间歇),会在共享库里留下一行**平台管理员**——这与文件里其它 fixture(留下的是 dept/role 作用域角色行)不同级,而且下一次运行(不同的 `TS`)永远不会去清理上一次运行留下的这一行,因为清理数组 `dbGrantedAdminUserIds` 只认本次运行自己 push 进去的 userId。

**已实现的修法**(不是仅披露——`beforeAll` 新增一条前置幂等 sweep,见 `lifecycle.db.test.ts` 的 `beforeAll` 块):
```ts
await query(`DELETE FROM user_roles WHERE user_id LIKE 'vis3-dbadmin-%' AND role_id = 'admin'`)
```
这条 sweep 匹配的是**跨运行稳定的字面前缀**(`vis3-dbadmin-`,不含 `TS` 后缀),不是本次运行的具体 userId——所以它能清掉**任意一次更早的、被中断的**运行留下的孤儿行,即便那次运行的 `TS` 与本次不同。这把「谁来清理孤儿行」从「本次运行自己的 afterAll(如果它跑到)」变成了「下一次运行开始时的前置清理(不依赖上一次运行是否跑完)」——前置清理天然抗中断,后置清理不抗。

**为什么不做「事务内」或「唯一临时用户」**(报告给的两个替代方案,均评估后放弃,理由记录):
- **事务内**:这一行 `user_roles` 授予必须在提交后仍然可查(`approvalTemplateAdminGuard` 是 HTTP 请求处理链路里的独立查询,不与测试代码共享事务/连接),整个用例的判别力恰恰来自「这行数据对后续 HTTP 请求可见」——放进一个不提交的事务会让 guard 查不到这行,测试本身就失效,不是清理方式的选择问题。
- **唯一临时用户**:`userId` 已经是 `TS` 后缀的唯一值(不会与并发运行的其它 `TS` 冲突),问题从来不是「本次运行内的唯一性」,而是「跨运行的孤儿累积」——换一个「更唯一」的 userId 生成方式不会让孤儿行消失,只会让每个孤儿行的 `user_id` 都长得不一样,反而让前缀 sweep 失去唯一可用的抓手。**前缀 sweep 是唯一同时满足「本次运行不冲突」与「能清理不知道具体是哪次运行留下的孤儿」这两个要求的方案**。

**残留(如实标注,不是新引入,是缓解后的剩余量)**:如果连续两次运行都在 INSERT 之后、下一次 `beforeAll` 运行之前被中断(需要恰好在测试库长期无人运行的窗口内连续发生),孤儿行仍会短暂存在,直到再有一次这个文件的运行执行到 `beforeAll`。这与「完全消灭孤儿窗口」不同,但比「只能靠这次运行自己跑完」的原状好——多次连续中断需要比单次中断更巧合的时机。

anchor:`packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`(`beforeAll` 前置 sweep,`grep -n "vis3-dbadmin-%" lifecycle.db.test.ts` 定位,~236)

### 23.8 本切片(A-1)真库套件全量重跑(含新增两条用例)

```
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 \
    pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=dot
 Test Files  2 passed (2)
      Tests  28 passed (28)
```

28 = 原 26(§22.3 最后一次确认的数字)+ 本轮新增 2(§23.3 的 P1-3 回归用例、§23.7 的 §2(c) 用例);零 skip、零 fail。

```
$ npx tsc --noEmit -p .
(无输出,exit 0)
$ git status --short
 M packages/core-backend/src/routes/approvals.ts
 M packages/core-backend/src/services/ApprovalTemplateGroupService.ts
 M packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts
```

只有这三个文件被改动;`.github/workflows/plugin-tests.yml`、`vitest.config.ts`、任何迁移文件均未触碰。

### 23.9 s6a / ci-wiring 守卫(未受影响,机械核对)

本轮**未**修改 `plugin-tests.yml`(§23.8 的 `git status --short` 已确认),两个新用例都是加进**已经**被该 workflow 显式清单点名的既有文件(`approval-template-groups-lifecycle.db.test.ts`),不是新增文件——s6a 的重算条件是「改了 `PINNED_EVIDENCE_FILES` 清单里的文件(含 `pluginTestsWorkflow` → `.github/workflows/plugin-tests.yml` 整个文件的 sha256)」,本轮零命中:

```
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
✔ __tests__/sealed-export-package-provenance.test.cjs
tests 1
pass 1
fail 0
```

`ci-wiring` 人口方面:`grep -rl "approval-template-groups" scripts/ops/*.test.mjs` 零命中(与本文档 §22.4 P3-6 记录的既有残留一致——这两个真库文件至今不受任何 `*-ci-wiring.test.mjs` 保护,只受 `plugin-tests.yml:1578` 一带的 bash `:?` 哨兵保护),本轮未新建守卫(未新增文件,不属于本轮任务范围),该既有残留原样保留、不在本节重复披露。

### 23.10 required 检查 `test (20.x)` 的全量命令逐字复现

**范围说明(先诚实划界,避免过强声明)**:`test (20.x)` 是一个横跨整个 monorepo 的巨型必需 job(`.github/workflows/plugin-tests.yml` 的 `test:` job,`node-version: [18.x, 20.x]` 矩阵,`if: matrix.node-version == '20.x'` 的步骤单独就有数十个,覆盖 e-learning/BPMN/multitable/考勤/attendance/dingtalk 等与本切片无关的域)。本节**没有**重跑该 job 里的每一步——那会跑数十个与本次改动零重叠的域,耗时且不产生额外判别力。本节逐字复现的是该 job 里**唯一**收纳了本切片两个真库文件的那一步——`Run approval real-DB integration (...)`(`id: approval-real-db-integration`),按 workflow 原文**逐字**(文件列表、`--config`、`--reporter` 全部照抄,只把 `DATABASE_URL` 换成本会话的私有库)整段跑一次,而不是像 §23.3/§23.8 那样只跑本切片自己的两个文件——这是「读 .github/workflows 里对 core-backend 的真实步骤,跑全量 vitest」这条要求里「全量」的落地方式:全量 = 该 required 步骤点名的**全部** 79 个文件一起跑一次,不是收窄到本切片改的文件。

逐字来源(`sed -n '1568,1659p' .github/workflows/plugin-tests.yml`,原文照抄,79 个 whole-file 路径,以 `tests/integration/approval-template-groups-lifecycle.db.test.ts`/`…-serialization.db.test.ts` 两个文件收尾):

```
- name: Run approval real-DB integration (directory endpoints + P1-C field redaction + P1-B add_sign/reduce_sign + direct_manager create/start + A/E/B/D/G cross-lane acceptance + dept_head sync-plumbing carry-forward + continuous_managers chain walk + common template presets + DT-OPS-01 deprovision selection goldens)
  id: approval-real-db-integration
  if: matrix.node-version == '20.x'
  env:
    DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test
  run: |
    : "${DATABASE_URL:?DATABASE_URL is required for approval real-DB integration}"
    pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
      tests/integration/approval-directory-endpoints.api.test.ts \
      … (79 个文件,原文逐字,详见 .github/workflows/plugin-tests.yml:1580-1658) …
      tests/integration/approval-template-groups-lifecycle.db.test.ts \
      tests/integration/approval-template-groups-serialization.db.test.ts \
      --reporter=dot
```

本会话唯一的替换是 `DATABASE_URL`(`postgres@localhost:5432/metasheet_test` → `postgresql://localhost:5432/metasheet2_lock_a1_fix`,私有库,不是共享的 `metasheet_test`);`: "${DATABASE_URL:?...}"` 哨兵、`--config vitest.integration.config.ts`、`--reporter=dot`、79 个文件路径的顺序与拼写逐字未改。实测:

```
$ export DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix"
$ pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    <79 个文件,逐字同 plugin-tests.yml:1580-1658> --reporter=dot
 Test Files  79 passed (79)
      Tests  880 passed | 5 skipped (885)
   Duration  171.07s (transform 3.12s, setup 211ms, collect 34.82s, tests 96.92s, environment 5ms, prepare 2.27s)
$ echo "EXIT_CODE=$?"
EXIT_CODE=0
```

79/79 文件全绿,880/885 用例通过(5 skip 是既有文件里的既有 skip,与本轮改动无关,未新增/未减少);退出码 0。这条命令覆盖了本切片改动触及的两个文件,以及与它们在同一个 required 步骤里的其余 77 个真库文件(含大量 directory/dingtalk/attendance 域文件)——证明本轮改动(`ApprovalTemplateGroupService.ts`/`routes/approvals.ts` 的改动)不仅没有破坏本切片自己的用例,也没有破坏同一个 required 步骤下其余 77 个文件的既有断言(这两个改动的文件被其它 approval 域真库套件通过 import 间接触达时,行为保持兼容)。

**no-DB 单元测试 lane(`test (20.x)` job 的另一半:`pnpm --filter @metasheet/core-backend test`,`vitest.config.ts`,不需要 DB)—— 也整体重跑了,不是靠 grep 推断覆盖面**。第一版本节曾打算用 `grep -rl "ApprovalTemplateGroupService\|resolveApprovalTemplateVisibilityActor\|isApprovalTemplateVisibleForGroupLink" packages/core-backend/tests/unit` 零命中来论证「未受影响」——**这条 grep 本身范围不够**:它只查了 `tests/unit` 这一个子目录,而 `vitest.config.ts` 没有 `include:`,默认 glob 覆盖整个包(`exclude` 列表之外的一切 `*.test.ts`/`*.spec.ts`),`tests/integration/approval-attachment-routes.test.ts` 就不在那份 `exclude` 清单里、也不在 `tests/unit` 下——而它通过 attachment 路由间接消费 `resolveApprovalTemplateVisibilityActor`(该函数的导出注释原话就是「Exported for the approval-attachment upload route」),grep 只按目录取样,已经先漏掉了一个真实消费方。按目录取样的 grep 不足为凭,于是改为**直接跑这条 lane 本身**:

```
$ unset DATABASE_URL   # 该 CI 步骤在 job 里排在 db:migrate 之前，DATABASE_URL 未设，若带着它跑就是在核对另一条命令
$ cd packages/core-backend && CI=true pnpm exec vitest run --reporter=dot
 Test Files  931 passed | 175 skipped (1106)
      Tests  14713 passed | 1604 skipped (16317)
   Duration  67.65s (…)
```

（`"test": "vitest"` 脚本本身是 watch 模式,本地必须用 `exec vitest run` 或 `CI=true` 让 vitest 自己探测到 CI 环境切换成一次性运行,否则会挂起而不是给出结果——这条踩坑点记入本节,免得下次照抄命令又卡在 watch 模式上;`DATABASE_URL` 必须**不设**,因为这条 CI 步骤在 job 顺序里排在 `db:migrate` **之前**,带着 `DATABASE_URL` 跑会激活所有 `describeIfDatabase` 套件,变成核对一条与 CI 实际执行的命令不同的命令。）

931/931 文件通过、175 skip(`describeIfDatabase` 在无 `DATABASE_URL` 下的正常跳过,与本轮改动无关)、14713/14713 用例通过、零失败、退出码 0(见 `grep -c "FAIL"` 命中的 8 处逐一核对:全部来自一个仓内既有的 mutation-testing 元测试,其用例名字面包含单词 `FAIL`,不是真实失败);`approval-attachment-routes.test.ts`(34/34)特别核对通过。结合 §23.8 的 `tsc --noEmit -p .`(对整个包含 `tests/` 的 package 做完整类型检查,已确认零错误)与上面 79 文件 real-DB 全绿,构成本轮改动对 core-backend 两条主要 required 检查通路(真库 + no-DB 单测 + 类型检查三者)零回归的现场证据链,而不是「关键符号零引用」这一条本身范围不足的推断。

### 23.11 提交与推送

本回流修复(§23)唯一提交:`03ee9f4bb6c7eb67349da5cda332cf4e4d6ceaac`(`fix(approval): map CJK-name CHECK violation to 400, correct guard/manager overclaim`)——**NIT 收口(impl-gate-A-slice1-round4-20260918.md §5 NIT)**:上一版本节只写「不在此重复粘贴 SHA」,本轮门审指出这样这份 MD 自身就不带 provenance,已改为直接写死 SHA。

`impl-gate-A-slice1-round4-20260918.md` P2/P3 收口(本次修复,commit 列表以 `git log --oneline 03ee9f4bb..HEAD -- docs/development/approval-template-groups-phase1-verification-20260918.md packages/core-backend/src/routes/approvals.ts packages/core-backend/src/services/ApprovalTemplateGroupService.ts packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts docs/development/approval-template-groups-phase1-design-20260918.md scripts/dev/atg-verification-recount.sh` 现场输出为准,§23.12 附最终 SHA 列表):见 §23.12。

### 23.12 impl-gate-A-slice1-round4-20260918.md 处置表 + 最终验证证据链

**逐条处置**(commit SHA 均为完整 40 字符,`git log --oneline 03ee9f4bb..b32a0b6fc` 现场核对,4 个提交,无 squash、无 force):

| 项 | 处置 | commit | 备注 |
|---|---|---|---|
| P2-1(通配腿反例实测为假) | **已修复**——三份副本(生产注释/测试注释/本文档 §23.6-§23.7)一并改写,唯一被实测支撑的反例改为 DB 侧 `isAdmin`,写明第 2 轮与第 4 轮各证伪一次 | `f7b929700` | 纯注释/文档,零运行时行为变化;M4 判别式实测(五行输出)复述进 §23.6 |
| P2-2(§14 #4 机械计数第三次为假) | **已修复**——按 `8a2a29a61` 当时的 head 重算 19/15/差额 4/`:397,520,525,537,544`(第 5 轮门审修复轮之后,`b32a0b6fc` 在 `beforeAll` 加行使其再漂移一次;本 head 的当前值见 §14/§14.1:`:415,538,543,555,562`),逐码表补 `GROUP_NAME_UNSUPPORTED`(1)、`APPROVAL_TEMPLATE_NOT_FOUND` 改 2,分母改 11/10;新增机械前置动作 + `scripts/dev/atg-verification-recount.sh` | `8a2a29a61` | 脚本已现场跑通(见下方证据),后续任何新增/删除用例后必须先跑这个脚本再改数字 |
| P3-1(全组锚点集体漂移) | **已修复**——设计 MD §3.1/§3.3/§3.4、验证 MD §12/§14.1/§18.1/§18.2/§19.1/§23.1/§23.6 全部改用「符号 + `grep -n` 定位 + 近似行号」,不再维护逐提交位移算术;§12 表另修复 4 行意外多出的单元格并恢复「用例名(逐字)」列 | `a687e2591`(设计 MD)+ `02c6bbe89`(验证 MD)+ 后续自查提交(见本节自指记录) | 设计 MD §3.3 同时补 `GROUP_NAME_UNSUPPORTED` 行并入 §3.4 owner 裁量桶(报告原话「并入 §3.4 的 owner 裁量桶」);未被报告点名、本轮**未**顺带修的同类陈旧行号是设计 MD §3.5 与**设计 MD**(非验证 MD)§4.2——超出本轮枚举范围,如实披露,不算已收口;§4.2 比一般漂移更差,详见「未做的事」段 |
| P3-2(atg_org_nonblank/atgl_org_nonblank 零覆盖) | **确认披露属实,不升级,不改动**(报告verdict 本身就是「不升级」)| — | 报告原话:「我确认这条披露属实且措辞恰当,不升级」——本轮无对应代码/文档改动 |
| P3-3(中文 message 被测试冻结成合同) | **如实披露,未改动断言**——收窄断言在技术上可行(`details.constraint` 已独立承担 M1 mutation 的判别力),但是否收窄是一次合同层面的裁决,留给 owner 与 §23.5 的 `atg_name_nonblank` CHECK 勘误一并做 | `02c6bbe89` | PR body 待补充这条披露(硬规矩不许本轮自己动 PR;交下一次能编辑 PR 的环节补) |
| P3-4(平台管理员授权行清理只靠 afterAll) | **已修复**——`beforeAll` 增加前缀幂等 sweep,且用「插入孤儿行 → 只跑不相关的 sentinel 用例 → 核对孤儿行消失」的隔离实测确认是 sweep 本身在清理,不是巧合;评估并否决了「事务内」「更唯一的临时用户」两个替代方案,理由记录在案 | `b32a0b6fc`(代码)+ `02c6bbe89`(文档) | 残留风险(连续两次运行都被打断)已如实标注为缓解后的剩余量,不是消灭 |
| P3-5(§23.6 grep 命令/输出形状不对齐) | **已修复**——随 P2-1 一起重写,换成会话时刻真实可重跑的两段管道命令(`grep -rn` 接 `grep -i` 过滤),并现场核对输出为空 | `f7b929700` | 与 P2-1 同一提交,因为两者改的是同一段落 |
| NIT(§23.11 不写 SHA) | **已修复**——写死本回流修复的提交 SHA `03ee9f4bb6c7eb67349da5cda332cf4e4d6ceaac`,并在本节追加本次全部 4 个修复提交的 SHA | `02c6bbe89` | 见上表与下方最终 SHA |

**最终验证证据链(本次修复收尾,head `b32a0b6fc5c075ef6136670ec305c7fa0ad71c37`,私有库 `metasheet2_lock_a1_fix`)**:

```
$ pnpm type-check                                            # 全仓,含 apps/web 两个 verification tsconfig
exit 0(core-backend / apps/web 均 Done,零错误)

$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  28 passed (28)

$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
tests 1 / pass 1 / fail 0                                    # s6a 钉,未受本轮影响(plugin-tests.yml 零改动)

$ node --test --test-concurrency=1 scripts/ops/*-ci-wiring.test.mjs
tests 476 / pass 476 / fail 0                                # 全绿,本次未复现第 4 轮报告记录的 2 条 ETIMEDOUT(环境噪音,非分支缺陷)

$ export DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix"
$ bash -e /tmp/gateA-fix1-required-step.sh                   # .github/workflows/plugin-tests.yml `approval-real-db-integration` 步骤 run: 体逐字抽取,79 个测试文件参数,bash -e 执行
 Test Files  79 passed (79)
      Tests  880 passed | 5 skipped (885)
REQUIRED_STEP_EXIT=0                                         # 与本文档 §14/§23.10 记录的 79/880/5 skip 逐字相符

$ env -u DATABASE_URL CI=true bash -e -c 'pnpm --filter @metasheet/core-backend test'   # 同 job 的 no-DB 单测 lane
 Test Files  931 passed | 175 skipped (1106)
      Tests  14713 passed | 1604 skipped (16317)
NODB_EXIT=0                                                   # 与 §23.10 记录逐字相符

$ git diff --exit-code 03ee9f4bb..HEAD -- packages/core-backend/src/db/migrations/
exit 0                                                        # DDL 零改动,硬规矩满足

$ git diff --name-status 03ee9f4bb..HEAD
M  docs/development/approval-template-groups-phase1-design-20260918.md
M  docs/development/approval-template-groups-phase1-verification-20260918.md
M  packages/core-backend/src/routes/approvals.ts
M  packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts
A  scripts/dev/atg-verification-recount.sh
                                                               # ApprovalTemplateGroupService.ts 本轮未改动;新增文件仅一个脚本,非测试/非 DDL

$ git status --porcelain
(空)

$ git log --oneline 03ee9f4bb..HEAD
b32a0b6fc test(approval): sweep orphaned §2(c) admin grant in beforeAll (gate P3-4)
02c6bbe89 docs(approval): recompute verification MD anchors, disclose P3-3/P3-4 dispositions (gate P3-1/P3-3/P3-4/NIT)
a687e2591 docs(approval): recompute design MD anchors as symbol + approximate line (gate P3-1)
8a2a29a61 docs(approval): recount §14 error-code census, add machine recount script (gate P2-2)
f7b929700 fix(approval): retract falsified wildcard-permission guard claim (gate P2-1)
```

**本次修复未做的事(如实列出,自我复核后更正一处措辞不准)**:未合并、未 undraft、未开/动 PR、未动 `origin/main`、未应用任何迁移到共享库、未改锁文、DDL 文件零字节改动(`atg_name_nonblank` 放宽仍是 owner 勘误项,原样待裁)。**更正**:设计 MD §3.4 本轮**已经**改写(`a687e2591`,补第二条 owner 裁量项 + 符号化锚点),上一版这里把它和 §3.5 混在一起写成「未触碰」是错的——真正未被本轮触碰的只有设计 MD §3.5(挂接可见性失败形状那条实现者裁量)与**设计 MD**(不是验证 MD)§4.2「本切片实际取锁点」表。§4.2 的处境比「陈旧行号」更差,不宜轻描淡写:该节标题写着「当前 HEAD」,但表内 `transaction(...)`(`:182`)一类行号现场核对**已经是假的**(`createApprovalTemplateGroup` 里 `transaction(` 实际在 ~225,不在 182)——这是一个**先于本轮存在**的过强声明("当前"二字本身就不成立),不是本轮新引入的,也不在 `impl-gate-A-slice1-round4-20260918.md` §5 P3-1 表格枚举的锚点范围内,本轮未修,如实标注为「既有条件,不算本轮账上,但比一般的行号漂移更值得下一轮优先处理,因为它连『当前』这个自我描述都不成立」。验证 MD 自己的 §22.2 是历史变更链(记录「从 X 改到 Y」),按惯例不重算,不在此列。

**自指记录**:上面的 commit 列表在写作过程中已经被写它自己的那些提交追上过不止一次(编号会继续动,不再在这里钉一个会立刻过期的序数)——这正是 NIT 项本身想避免的那类「文档自己不带 provenance」的变体:一份记录自己提交历史的文档,写作过程本身就会产生新的提交。不补序数,只补规则:本节之后的每一次改动都只应是「改这份文档本身」(表格转义、措辞更正、补充披露),不再涉及生产代码/测试代码——那些已经在 P2-1/P2-2/P3-1/P3-4 四个提交里做完了。完整、无歧义的提交列表以**推送前最后一次** `git log --oneline 03ee9f4bb..HEAD` 现场输出为准,不要相信本节里任何写死的计数或序数。

## 24. 撤回扫描(第 5 轮门审修复轮,2026-09-18)—— P2-1 的机械扫描,不再逐处枚举

**被审 head**:`2cf81bcaa53f5d20c345f52334610fc6e7e9dd06`(第 5 轮门审报告 `impl-gate-A-slice1-round5-20260918.md` verdict:NEEDS-FIX,0 P1 / 1 P2 / 4 P3)。

### 24.0 根因(报告原话,逐字)

> 第 4 轮把副本**枚举**成三处,本轮就照三处逐条改,没有做成一次扫描。

第 4 轮门审(P2-1)点名了三份副本(`routes/approvals.ts` 块注释、`lifecycle.db.test.ts` 块注释、本文档 §23.6),回流修复轮逐一改写了这三处,但设计 MD §3.5 与本文档 §18.1 里同一族的两句声明——写在早于第 4 轮的提交里、从未被列进那三份副本的枚举——继续以现时事实的口吻站着,直到第 5 轮门审读到分支自己的 §2(c) 真库用例才发现它们已被证伪。本节按枚举改成扫描,并把扫描做成脚本,供第六轮及以后的任何一次修复直接复用。

### 24.1 扫描范围与命令

范围**不是**固定文件列表,而是 `git diff --name-only origin/main..HEAD` 现场给出的分支 diff 集合——**本节不再钉一个绝对文件数(第二次订正)**:第 6 轮门审 P3-1 指出上一版写死的「11 个文件」漏算了脚本自己,当时现场重跑补成「12 个」(`.github/workflows/plugin-tests.yml`、两份设计/验证 MD、迁移文件、`routes/approvals.ts`、`ApprovalTemplateGroupService.ts`、两个测试文件、`vitest.config.ts`、s6a 钉、`atg-verification-recount.sh`、`atg-retraction-sweep.sh` 自身);但这个数字本身就依赖 `origin/main` 当时的位置——本节落笔之后 `origin/main` 已经继续前进(现场重跑此刻是 **59 个文件**,含大量与本分支主题无关、只是因为 `origin/main` 与本分支基线之间自然产生差异的文件),把「12」写成本轮的现时事实与把「⊋」写成现时事实是同一种错误(钉一个会随时间漂移的数)。**判定规则不受文件数影响**——**第 7 轮门审 P3-1 指出上一版这里写的「新增文件零命中」本身是假的,现更正**:`origin/main` 漂移带来的文件里确有包含关系符号/词的命中(如 `plugin-attendance/index.cjs:83` 的迟到/严重/缺勤三层嵌套用了 `⊇`、`packages/core-backend/src/routes/univer-meta.ts:7045` 的字段类型收窄用了 `⊂`,以及分散在 `univer-meta.ts`/`CommentService.ts`/`ai-bulk-job-service.ts`/`plugin-integration-core` 等文件里的多处 `subset`/`superset`),逐条读过上下文后**均为不相关主题**,不含任何 `guard population`/`isTemplateManager`/`approvalTemplateAdminGuard` 主题的包含关系断言(分类清单见 §25.5)。所以扫描的判定标准是「命中经核对后是否落在本切片 guard/manager 主题上」,不是「命中数(或文件数)是否为零」——两者都会随 `origin/main` 前进而变化,钉零跟钉一个具体数字是同一种错误。权威文件数与命中数以脚本现场打印的输出为准,不在本节的正文里另写一个会过期的绝对值。搜的表述(当时 11 个模式,任务书原文列出的每一种撤回表述各一条,外加中文版「guard 人口 ⊆」与英文 `wildcard permission`/`sees everything`):`⊆`、`每个 *actor`、`isTemplateManager *= *true`、`没有.{0,6}HTTP *可达`、`今天.{0,6}HTTP *可达路径`、`纯 *HTTP *测试.*无法制造`、`guard population`、`guard *人口`、`sees everything`、`wildcard permission`、`通配权限码.*过 *guard`(**第 6 轮修复轮已把这个模式集加宽到 22 个,见 §25.5**)。命令与用法说明见 §24.5 的脚本本身(`scripts/dev/atg-retraction-sweep.sh`),不在本节重复贴脚本源码。

### 24.2 修复前命中清单(现场执行,file:line + 原句,逐条读过)

除 `⊆`/`guard population` 两个模式在 `.github/workflows/plugin-tests.yml:1295`(多维表 `export⊆read differential` 步骤名,与本切片的 guard/manager 主题**无关**,模式误命中)与 `routes/approvals.ts:1692,1715`(同一文件里另一段 `export ⊆ read(detail)` 差分权限注释,同样是不同端点、不同主题的无关命中)之外,全部命中逐条读过上下文,分类如下:

**(A)现时断言,判定为活的 P2-1(2 处,均已改写,见 §24.3)**:

1. `docs/development/approval-template-groups-phase1-design-20260918.md:169`(设计 MD §3.5):
   > …能通过守卫的每个 actor,`resolveApprovalTemplateVisibilityActor` 都会把它判成 `isTemplateManager = true`(两个 guard 码都在 `isTemplateManager` 的判定并集里)…所以今天**没有**任何 HTTP 可达路径能让这条校验因「看不见该模板」而 404;它今天在生产流量下只等价于「模板是否存在」的检查…

2. `docs/development/approval-template-groups-phase1-verification-20260918.md:672`(验证 MD §18.1,修复前行号):
   > …`approvalTemplateAdminGuard` 的人口 ⊆ `isTemplateManager`…今天没有 HTTP 可达路径能让这条检查因「看不见该模板」而拒绝…纯 HTTP 测试在当前 guard 形状下无法制造一个「过 guard 但非 manager」的反例。

两句均被本分支自己的 `lifecycle.db.test.ts` §2(c) 用例(`vis3-dbadmin-*` 主体,guard 通过、`isTemplateManager` 为 false,对 hidden 模板打 link 端点拿到 404)证伪——该用例在本 head 是绿的(28/28,见 §24.6),不是「测试写了没跑」。

**(B)已是合法的历史/撤回叙事,原文原样保留,不改动**:验证 MD `:1057`(§22.4,「今日成立但断言形式不成立」的历史披露)、`:1131`(§23 来源转述,「注释是过强声明,现场核对为假」)、`:1222`(§23.6 标题,「是过强声明;本节自己的第一版修法…」)、`:1248`(§23.6 修法段,「撤回『…』这句最初的过强声明」)、`:1269`(§23.7 mutation 说明,「模拟…这句被撤回的声明若为真时的行为」)、`:1291`(§23.7 结论,「这不是说撤回的那句过强声明没有安全后果」);`routes/approvals.ts:401,403,409`(CORRECTED 块注释,逐句叙述「an earlier version…claimed」「Round 2's gate already…falsified」「does NOT, by itself, pass the guard」);`lifecycle.db.test.ts:690`(「"guard population ⊆ manager population", which is false」)。这些命中全部是「叙述一件已经被撤回/证伪的事」,不是把撤回的断言当成今天的事实重申——按脚本 §24.5 的判定规则,归类 (3),合法,不动。

**分类修正(第 6 轮门审 P2-1 指出,本轮采纳)**:上一版本表把 `routes/approvals.ts:428`(「the true relationship is still guard population ⊋ manager population」)与 `:401/403/409` 并列归入上面 (B) 类,判定为「叙述已撤回之事」——**这是误分类**:`:401/403/409` 三句叙述的是「早前版本声称过 X,后来被证伪」,时态和主语都指向历史;而 `:428` 那句话本身不是在叙述历史,它是本节(与设计 MD §3.5、验证 MD §18.1/§23.6/§24.3 同批)当时新写/沿用的**现时结论**(「guard ⊋ manager,严格超集」),只是这个结论后来被第 6 轮门审的真库探针证伪。分类当时的错误在于:扫描脚本只负责报告命中,不负责判断一句「结论式陈述」本身是否为真;人工分类时把 `:428` 的语法外壳(「CORRECTED 块注释」「逐句叙述」)与 `:401/403/409` 归了同一类,而没有意识到 `:428` 自己就是那五份「guard ⊋ manager」副本之一(见 §2 P2-1 的机械枚举)。**处置**:`routes/approvals.ts:428` 已从上面的 (B) 类移出,与设计 MD `:169`、验证 MD `:704`/`:1280`/`:1541` 一并按第 6 轮门审 P2-1 的措辞重写为「互不包含」,不再是「历史叙事,不改动」——见 §25.1/§25.2。

### 24.3 逐条改写处置

- **设计 MD §3.5**(`:169`):第 5 轮修复轮当时整段按实测重写为「guard ⊋ manager(严格超集,不是子集)」,把 §2(c) 的 DB 侧 `isAdmin` 反例当作这句话唯一的支撑腿——**这句话本身被第 6 轮门审 P2-1 证伪**(见 §25):它隐含要求「每一个 isTemplateManager 主体都能过 guard」,这个方向从未被验证过,且被本文档自己 §23.6 记录的 `ZZR4-EXACT-RESULT status=403`(perms 恰为 guard 字面点名的码)直接反驳。第 6 轮修复轮已把这一段改写为「互不包含,两方向各有一个端到端实测反例」的措辞,不再使用任何包含符号(§25.1)。
- **验证 MD §18.1**(修复前 `:672`,第 5 轮修复轮现场重算后 `:704`):同段同改,当时措辞与设计 MD §3.5 对齐——**同样被第 6 轮门审 P2-1 证伪并已按 §25.1 的措辞第二次改写**,不再是只贴一条指向 §23.6/§23.7 的失效标记就了事,而是把那句话本身重写成如实的版本。
- **扫描命令写进文档**(任务书 (iii)):脚本 `scripts/dev/atg-retraction-sweep.sh`,与 `scripts/dev/atg-verification-recount.sh` 同目录、同「机械前置动作」地位——§24.1/§24.5 是它在文档里的落点,下一轮任何人怀疑又漏了副本,先跑这个脚本,不再手工枚举文件名或表述。**第 6 轮门审 P2-1 发现这个脚本的模式集本身窄于它要防的东西(见下方 §24.2 的分类修正与 §25.5 的加宽)**,已在第 6 轮修复轮加宽并重跑,见 §25.5。

### 24.4 P3-1 / P3-2 / P3-3 / P3-4 处置(本轮一并收口,均为纯文档改动)

| 项 | 处置 |
|---|---|
| P3-1(lifecycle 锚点整体 +18,§12 列头自称「本次重跑现场值」) | **已修复**——§12 全表 11 个 `it/describe` 锚点(A/A′/A″/A‴/B/B′/B″/F/G/H/I′)现场 `grep -nE "^ *(it|describe)\('"` 重算,`serialization.db.test.ts` 侧的 E/K 两组锚点现场核对与旧值逐字相同(该文件本轮零改动,不重算);列头改为如实描述(哪一轮、哪次重跑、为什么此前的“本次”不是本次);B″ 格的自述错误(声称已处理 P3-4 漂移,实际贴的还是漂移前的值)一并改写;§18.1 两处、§18.2 三处、§19.1 一处同族的 lifecycle 锚点同步重算(+18) |
| P3-2(§23.12 处置表「按本 head 重算…`:397,520,525,537,544`」是 `8a2a29a61` 当时的旧值) | **已修复**——改为「按 `8a2a29a61` 当时的 head 重算」,并补一句指向本 head 当前值(`:415,538,543,555,562`,§14/§14.1 已是这组数字) |
| P3-3(§14.1 自称「命令与输出原样贴入」,实际删掉了「per-code breakdown」「how to use this output」两节并改写了一行表头) | **已修复**——现场重跑 `scripts/dev/atg-verification-recount.sh`,把完整、未删节的输出重新贴入(含此前缺失的两节与准确的表头括注),不再使用会隐藏删节的贴法 |
| P3-4(§12「用例名(逐字)」E 行 6 个用例名带 `…` 截断,与该列「保留完整字符串」的承诺不符) | **已修复**——E 行 6 个用例名(sentinel 一条 + 两条 `E positive control` + 三条 `E:` 系列)全部改写为完整字符串,与 `serialization.db.test.ts` 现场 `grep -F` 逐字匹配 |

### 24.5 机械脚本:`scripts/dev/atg-retraction-sweep.sh`

新增文件,与既有的 `scripts/dev/atg-verification-recount.sh`(§14.1)同等地位——**不判定**哪些命中是活的、哪些是历史叙事(那需要读上下文,交给人),只保证**扫描范围**(跟随分支 diff,不是写死的文件名单)与**表述覆盖**(11 个模式,逐条独立打印,而不是合并成一个大 alternation 让判别力被吞掉)不再依赖记忆去枚举。用法与判读规则写在脚本自身的 `--how to use this output--` 里(与 recount 脚本同一约定),不在本节重复。

### 24.6 修复后复跑(逐条核对每一处命中;不是简单数「命中数降到 0」)

**先如实纠正一件事**:完成 §24.3 的两处改写、并把 §24.1/§24.2 这两节写进本文档之后,重跑同一脚本,`每个 *actor`/`isTemplateManager *= *true`/`没有.{0,6}HTTP *可达`/`今天.{0,6}HTTP *可达路径` 这四个模式**并没有**降到零命中——本节自己在 §24.2 里逐字引用了两句被撤回的原句(作为「命中前是什么样子」的证据,与 §22.4/§23.6 引用「guard population ⊆ manager」的惯例相同),这两条引用本身会被同一脚本命中。如果这里写「四个模式降为 zero hits」,那句话本身就会被下一次机械重跑的人当场戳穿(记忆:`feedback_absolute_claim_sweep_must_be_mechanical`,绝对断言必须机械自扫,不能凭印象写)——所以改成逐条核对,不用命中数当判据:

| 命中位置 | 内容 | 归类 |
|---|---|---|
| 验证 MD `:1530`、`:1533` | §24.2 §(A) 的两条逐字引用(被撤回原句,`>` 引用块,紧邻「已被证伪」的说明) | 证据性引用,与 §22.4/§23.6 同惯例,合法 |
| 验证 MD `:1521`、`:1525`、`:1537`、`:1560` | §24.1/§24.2/§24.6 自己的元讨论(列出被搜索的模式字符串本身、分类说明) | 元讨论,不是断言,合法 |
| 验证 MD `:704`、设计 MD `:169` | §24.3 改写后的新文本,用「不再是……」「——不成立——」这类否定句点名被撤回的旧表述 | 已改写的正文,否定句提及,不是重申,合法 |
| 验证 MD `:1089/1163/1254/1280/1301/1323` | §24.2 §(B) 已列出的既有历史叙事(§22.4/§23.6/§23.7) | 未改动,legitimate,与 §24.2 判定一致 |
| `routes/approvals.ts:401/403/409/428`、`lifecycle.db.test.ts:690` | 既有 CORRECTED 注释与测试注释(第 4/5 轮已改写) | 未改动,legitimate,与 §24.2 判定一致 |
| `.github/workflows/plugin-tests.yml:1295`、`routes/approvals.ts:1692,1715` | 无关主题的模式误命中(`export⊆read` 差分权限,与本切片 guard/manager 无关) | 假阳性,与 §24.2 判定一致 |

**逐条核对完毕,零处**是「把已撤回的断言当成今天的事实重申」——这才是 P2-1 真正要归零的东西,不是 grep 命中数本身(命中数会因为本节自己讨论撤回这件事而永远大于零,这是写「撤回记录」这类文档不可避免的自指现象,和 §23.11/§23.12 已经承认过的「文档记录自己的提交历史」是同一类问题)。**判定:P2-1 归零目标(现时断言,而非 grep 命中数)达成。**

### 24.7 行为侧收尾证据(现场执行,`metasheet2_lock_a1_fix`)

```
$ pnpm exec tsc --noEmit -p packages/core-backend
exit 0

$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  28 passed (28)
```

28/28,与第 5 轮门审报告记录的基线逐字相符——**本轮零行为改动**(只动了两份 MD 与新增一个纯报告脚本),这不是巧合,是必然:改动范围里没有任何一处触碰 `.ts` 生产/测试代码或 DDL。

```
$ git diff --stat 2cf81bcaa53f5d20c345f52334610fc6e7e9dd06 -- . ':!scripts/dev/atg-retraction-sweep.sh'
 docs/development/approval-template-groups-phase1-design-20260918.md         |  2 +-
 docs/development/approval-template-groups-phase1-verification-20260918.md   | 78 +++++++++++++++-------
 2 files changed, 56 insertions(+), 24 deletions(-)
$ git status --porcelain
 M docs/development/approval-template-groups-phase1-design-20260918.md
 M docs/development/approval-template-groups-phase1-verification-20260918.md
?? scripts/dev/atg-retraction-sweep.sh
```

**自指披露(与 §23.11/§23.12 同一问题)**:上面这段 `git diff --stat` 是在起草本 §24 节**当中**现场跑的,之后本节自己又继续增长了若干行(写这句披露本身也是)——所以这份 diff-stat 的行数不是本次提交最终 `git diff --stat 2cf81bcaa..HEAD` 的确切值,但它证明的**性质**(改动范围仅限两份 MD + 一个新增的纯报告脚本,零 `.ts`/DDL 改动)不会因为本节自己再多几行文档而改变——真正的最终数字以提交后 `git show --stat <本轮提交 SHA>` 现场输出为准(推送前核对,不在本节回填,避免重蹈 §23.11 曾经出现过的「文档记录自己的提交历史」自指循环)。

### 24.8 提交与推送

本节记录的 P2-1/P3-1/P3-2/P3-3/P3-4 五项处置,提交与推送方式同 §23.11 的约定:不在本节钉死 commit SHA(写下的瞬间就会过期),完整、无歧义的提交列表以**推送前最后一次** `git log --oneline 2cf81bcaa..HEAD` 现场输出为准。硬规矩重申(本轮全程遵守,现场核对):未合并、未 undraft、未开/动 PR、未动 `origin/main`、未应用任何迁移到共享库、未改锁文(`approval-form-group-entity-design-lock-draft-20260916.md` 零改动)、DDL 文件零改动、**本轮零代码行为改动**(只有两份 MD 与一个新增的纯报告脚本)。

## 25. 修复轮 6(第 6 轮门审修复轮,2026-09-18)—— gate `impl-gate-A-slice1-round6-20260918.md` P2-1(「⊋」也是假的)+ P3-1..4 收口

**被审 head**:`a789422b516f9e9ab6949c2cc0762a5daabc6be7`(第 6 轮门审报告 `impl-gate-A-slice1-round6-20260918.md`,verdict:NEEDS-FIX,0 P1 / 1 P2 / 4 P3)。

### 25.0 根因(报告原话概述,不隐去)

第 5 轮修复轮(见 §24)把被证伪的「guard population ⊆ manager」改写成「guard population ⊋ manager population(严格超集)」——这句替代声明本身也是假的:它隐含要求「每一个 `isTemplateManager` 主体都能过 guard」,而这个方向从未被验证过,并且被本文档自己 §23.6 记录的 `ZZR4-EXACT-RESULT status=403`(`perms='approval-templates:manage'`,guard 自己字面点名的码)直接反驳。第 6 轮门审用真库三臂探针(HTTP 打建组端点 403 + 直调解析器 `isTemplateManager=true`)当场证伪。这是同一失败模式(撤回一条过强声明、换上另一条同族过强声明)第二次发生在这份文档里,记忆 `feedback_second_narrower_artifact_is_contract_narrowing` / `feedback_absolute_claim_sweep_must_be_mechanical` 点名的正是这一类。

### 25.1 P2-1 —— 5 处活断言逐条改写(机械核对,不按数量按位置)

| 位置 | 处置 |
|---|---|
| `routes/approvals.ts:428`(生产源码注释) | 已重写为「CORRECTED A THIRD TIME」段落——机制(manager 权限腿无 admission 合取,guard 权限腿有)+ 两个方向各一条端到端反例(§2(c)/§2(d))+ 明确不对生产 provisioning 路径作断言。零行为改动(纯注释),`git diff` 逐行核对每一处改动行首字符均为 `//`(见 §25.8)。 |
| 设计 MD §3.5(`:169`) | 已重写为「互不包含」措辞,结构与 approvals.ts 的新注释对齐(机制 + 方向一 + 方向二 + provisioning 未测免责)。 |
| 验证 MD §18.1(`:704`,现场重算) | 同段同改,与设计 MD §3.5 对齐,并显式标注这是对断言本身的**第二次**求值。 |
| 验证 MD §23.6 修法段(`:1280`,现场重算) | 「修法」段整段重写:先后撤回 `⊆` 与 `⊋` 两句被证伪的声明,给出互不包含的新结论,并点名三处副本(routes 注释、设计 MD §3.5、本文档 §18.1)均已同步改写。 |
| 验证 MD §24.3 处置表(`:1541`,现场重算) | 「设计 MD §3.5」「验证 MD §18.1」两行处置说明本身也在用现时口吻重申「guard ⊋ manager」——已改写为过去时叙述(「第 5 轮修复轮当时…写为…,这句话本身被第 6 轮门审证伪」),不再是现时结论。 |

**逐条改写用「带证据与配置的形式」,不再写第三条无限定断言**(报告修法 (ii) 的要求):机制引用具体代码位置(`resolveApprovalActorPermissions`/`rbac.ts:134-142,146-152`);方向一反例引用 §2(c)(既有);方向二反例引用新增的 §2(d)(§25.3);结论明确加上「本测试 harness 的 `RBAC_TOKEN_TRUST` 配置下实测,不对生产 provisioning 路径断言」的限定语,不再写包含符号。

### 25.2 §24.2 分类修正(误分类改正)

§24.2 的「(B)已是合法的历史/撤回叙事」表此前把 `routes/approvals.ts:428` 与 `:401/403/409` 并列,判定为「叙述已撤回之事」——这是误分类:`:428` 不是叙述历史,是当时的现时结论,只是碰巧用了「CORRECTED」这个词头,被人工分类时和真正叙述历史的 `:401/403/409` 归了同一类。已在 §24.2 原文后追加一段「分类修正」说明这个错误的机制(扫描脚本不判断陈述真假,人工判断被语法外壳误导),并把 `routes/approvals.ts:428` 从 (B) 类的引用列表里移出,指向本节的重写处置。**这一格的错误本身也被记录下来,不是静默改正**——按记忆 `feedback_supersession_marker_must_evaluate_not_void` 的纪律,标记贴到具体那句话上,不是笼统说「表格已更新」。

### 25.3 新增真库用例:`lifecycle.db.test.ts` §2(d),钉住 manager ⊄ guard(集合事实,不描述后果)

**用例**:`it('§2(d): a permission code that satisfies isTemplateManager does not, by itself, satisfy approvalTemplateAdminGuard — pins the direction §2(c) does not cover', …)`,紧接 §2(c) 之后、G 之前(`lifecycle.db.test.ts:746`)。

- **Arm A(HTTP,真库)**:`dev-token` 铸 `roles='user', perms='approvals:read,approval-templates:manage'`、`tenantId=org` 的主体,打 `approvalTemplateAdminGuard` 把守的 `POST /api/approval-template-groups` ⇒ **403**,并且额外断言响应体 `error === 'Insufficient permissions'`(裸字符串,无 `code` 字段)——这是判别式断言,不是单纯的 `notEqual` 类弱判据:它把「guard 自己拒绝了」与「guard 放行、后面别的逻辑（如 `SESSION_ORG_REQUIRED`,`{ok:false,error:{code,...}}` 形状)返回 403」区分开,后者不会命中这个字符串形状的断言。
- **Arm B(直调导出的解析器)**:把**同一个**权限声明数组(`MGR_PERMS = ['approvals:read','approval-templates:manage']`)喂给 `resolveApprovalTemplateVisibilityActor`,返回 `isTemplateManager === true`。Arm A 与 Arm B 使用同一个字面量数组构造(不是两份分别手写、只是长得像的形状),可证明两臂测的是同一个声明集合。
- **负控**:只持 `approvals:read`(去掉 `approval-templates:manage`)的同形状 actor,`isTemplateManager === false`——隔离出到底是哪个权限码在起作用,而不是「随便一个 plain user 都不是 manager」这种无判别力的负控。

**不含 P3-4 披露内容**:用例名与全部注释只描述「manager 判定与 guard 判定互不包含」这一集合事实;**第 7 轮门审 P3-4 指出上一版本句本身就是一块不必要的指路牌(点名了被保密内容的主题)**,现改为不点名主题的措辞——本节不含门审报告 🔒 项点名的保密内容(保密纪律,见任务书 🔒)。

**mutation 探针**(`cp` 备份 → 改 → 单独跑 → 还原 → `cmp`,证明 Arm A 打中的是生产机制而不是测试自己的期望值):

```
$ md5 packages/core-backend/src/rbac/rbac.ts
9004e0b288164a0fe19814922c768c70
# 把 rbacGuardAny 权限腿的 `&& await isPermissionAllowedByNamespaceAdmission(userId, code)` 合取项
# 替换为 `&& true /* MUTATION PROBE(temporary) */`(python3 精确文本替换,仅改动一处已解析出的第一条权限腿)
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "§2\(d\)" --reporter=verbose
 ✗ §2(d): a permission code that satisfies isTemplateManager does not, by itself, satisfy approvalTemplateAdminGuard …
   AssertionError: expected 201 to be 403 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 18 skipped (19)
# 还原
$ cp /tmp/gate6-fix-probe/rbac.ts.orig packages/core-backend/src/rbac/rbac.ts
$ cmp /tmp/gate6-fix-probe/rbac.ts.orig packages/core-backend/src/rbac/rbac.ts && echo RESTORED-IDENTICAL
RESTORED-IDENTICAL
$ md5 packages/core-backend/src/rbac/rbac.ts
9004e0b288164a0fe19814922c768c70
```

去掉 namespace-admission 合取项后,Arm A 从 403 变红成 201——mutation 证明 Arm A 的判别力落在 `rbacGuardAny` 真正取决于 admission 检查这条机制上,不是装饰性断言。还原后 MD5 与还原前逐字节一致(`rbac.ts` 不在本轮最终 diff 里,见 §25.8——探针改了又原样还原,不留痕迹)。

### 25.4 §14 三线共用 #4 重算(新增用例后必先跑再改数字)

新增 §2(d) 引入第 6 个裸 `toBe(403)`,把计数从 `19/15/4` 推到 **`20/15/5`**。已按 `scripts/dev/atg-verification-recount.sh` 现场重跑的输出重写 §14 表格正文那一格与 §14.1 的完整命令块(包含此前完整的 per-code breakdown / how-to-use 两节,未删节)。逐码核对(11 码中 10 码有 `error.code` 断言)数字未变——本轮没有新增/删除任何 `error.code` 断言,只新增一个不配 `code` 字段的裸 403(与 F 用例同族)。

### 25.5 `atg-retraction-sweep.sh` 加宽 + 复跑,零活断言(不是零命中)

**加宽内容**(任务书④):
1. 6 个包含关系符号:`⊆ ⊇ ⊂ ⊃ ⊋ ⊊`(此前只有 `⊆`/`⊋`)。
2. 6 个包含关系词:`子集`/`超集`/`严格超集`/`strict superset`/`subset`/`superset`(此前没有任何一个)。
3. 报告 P3-3 点名的两处被窄化模式,还原成裸词:`纯 *HTTP *测试.*无法制造` → `无法制造`;`通配权限码.*过 *guard` → `通配权限码`。
4. 脚本自己的「how to use this output」指引同步重写——旧指引第 2 条建议「用 guard ⊋ manager 这句改写」,这句建议本身现在是被证伪的措辞,已改成「两个方向都已被证伪一次,不要写第三条无限定包含断言,写『互不包含 + 两个方向各一条反例』」。

模式总数从 11 个升到 22 个(`⊆⊇⊂⊃⊋⊊` 6 个 + 中英文词共 16 个)。

**复跑结果(22 个模式,现场执行于本轮修复轮当时的 `origin/main` 位置,不在本节整段粘贴——本节按类别汇总分类,复现命令是 `bash scripts/dev/atg-retraction-sweep.sh`,任何人可自行重跑核对)。下表的具体命中处数(如「11 处」「9 处」)与「输出总长」是当时那次重跑的快照——与 §24.1 同一订正:`origin/main` 之后继续前进,今天重跑扫描到的文件数与总行数都会更大(独立核对见下方脚注),但**分类结论不受影响**:新增的文件里确有若干处命中包含关系符号/词(见下表新增行「main 漂移文件」),逐条核对后均为不相关主题;没有一处以现时口吻重申 `⊆`/`⊋` 关系——每次重跑都应当只读「零处**现时重申**」这一句(不是「零处命中」),不应该把某次重跑的文件数/行数/命中数快照当成需要每轮维护的正文数字**:

| 命中类别 | 代表位置 | 判定 |
|---|---|---|
| 6 个符号模式(`⊇⊂⊃⊊`)——脚本自身声明处外 | `⊃`/`⊊` 两个符号在脚本自身之外**零**命中;`⊇`(`plugin-attendance/index.cjs:83`,迟到/严重/缺勤三层嵌套的 JS 表达式)与 `⊂`(`univer-meta.ts:7045`,字段类型收窄的代码注释)各一处——**第 7 轮门审 P3-1 更正,上一版此处误写为「零处出现在其它文件」** | 元讨论(脚本声明处)+ 2 处 main 漂移文件命中,均与 guard/manager 主题无关(见下方「main 漂移文件」行) |
| main 漂移文件(`origin/main` 前进带来的差集,非本分支产物;命中数会随 `origin/main` 继续前进而变化,不作为正文常量维护) | `⊇`/`⊂` 各一处(同上一行);`subset` 多处(`apps/web` 的 stock-prep 权限矩阵/自动化规则编辑器测试、`univer-meta.ts` 字段还原/公式脏检查、`CommentService.ts`/`ai-bulk-job-service.ts`、`plugin-integration-core` 测试与路由);`superset` 多处(`univer-meta.ts` 字段收窄、`plugin-attendance/index.cjs` 考勤值列全集、`plugin-integration-core` 测试) | 全部主题为字段类型/考勤嵌套/评论未读数/stock-prep 权限矩阵等,逐条读过,**零处**涉及 `approvalTemplateAdminGuard`/`isTemplateManager` |
| `⊆` 的全部命中(11 处) | `.github/workflows/plugin-tests.yml:1295`(`export⊆read` 步骤名,无关主题)、`routes/approvals.ts:401,403,1703,1726`(历史叙事/无关主题)、`lifecycle.db.test.ts:690`(「which is false」)、验证 MD 六处(§22.4/§23 来源转述/§23.6 标题与修法段/§23.7 mutation 说明,均为历史叙事)、脚本自身文本 | 全部 (B)历史叙事 或 (C)无关主题误命中,零处现时重申 |
| `⊋` 的全部命中(9 处) | 设计 MD `:169`、验证 MD `:705/:1281/:1540/:1544`(均已改写为「互不包含」正文,内含对旧措辞的否定式/历史式提及)、`routes/approvals.ts:403`(「flipped ⊆ to ⊋」,历史叙事)、`:1700`(`list⊋detail`,无关主题)、脚本自身文本 | 全部合法——改写后的正文用「不再是……」这类否定句提及旧符号,不是重申 |
| 4 个既有中文短语模式(`每个*actor`/`isTemplateManager*=*true`/`没有…HTTP*可达`/`今天…HTTP*可达路径`) | 全部落在验证 MD `:1531/:1534` 的 `>` 引用块内(§24.2 展示「命中前长什么样」的原句引用) | 证据性引用,与 §22.4/§23.6 同惯例,合法 |
| `无法制造`/`通配权限码`(两个被还原的裸词) | 元讨论(`:1522`)、`>` 引用块(`:1534`)、脚本自身文本、以及**正确的否定式断言**(「通配权限码…不成立」,设计 MD `:169`/验证 MD `:705`) | 合法——否定式断言是当前如实的结论,不是撤回声明的重申 |
| `guard population`/`guard*人口`/`sees everything`/`wildcard permission` | 历史叙事、元讨论、`routes/approvals.ts:409` 的正确否定式断言(「a wildcard permission code does NOT, by itself, pass the guard」)、`:1324` 的**条件句**(「如果日后有代码路径依赖…那才会引入漏洞」,不是断言依赖今天存在) | 全部合法 |
| `子集`/`超集`/`严格超集`/`strict superset` | 全部落在(a)本轮改写后的正文里用「互不包含」「谁都不是谁的子集」这类**否定式**表述、或(b)引用/叙述第 5 轮那句被证伪的旧措辞(明确标注「已证伪」) | 全部合法,零处现时重申「A 是 B 的子集/超集」 |
| `subset` | `.github/workflows/plugin-tests.yml`(无关 CI 步骤命名)、`routes/approvals.ts:2223`(Wave 2 WP3 无关功能的 `subset`)、`vitest.config.ts`(无关的「F2 security-critical subset」)、**新增的 `§2(d)` 注释本身**(`lifecycle.db.test.ts:721,743`,均为「not a subset relation」「neither one a subset of the other」的**否定式**表述)、脚本自身文本 | 全部合法/无关主题,§2(d) 的两处是本轮新写的正确否定式断言 |
| `superset` | 验证 MD `:1281`(历史叙事,引用被撤回的旧措辞)、**`routes/approvals.ts:429`**(本轮新写的「`"superset" conclusion above is itself false`」,明确点名旧结论已被推翻)、脚本自身文本 | 全部合法——`:429` 是对旧结论的否定,不是重申 |

**逐条核对完毕,零处**以现时事实口吻重申任何一个方向的包含关系(`⊆` 或 `⊋`)。这不是「grep 命中数为零」(本节起草当时命中数是 63 处左右,因为讨论「撤回了什么」这件事本身必然会提到被撤回的措辞;这个「63」本身也只是那次重跑的快照,不是本节要维护的正文数字——理由同上一段与 §24.1 的订正),而是「零处现时重申」——与 §24.6 建立的判读标准一致,按同一份规程复核。**独立复核脚注(P3 卫生轮 2026-09-19 现场重跑,第三次快照——第一次 12 文件/约 230 行、第二次 59 文件/约 357 行,均已按上一段的订正原则不当正文常量)**:扫描文件数现为 **159**(仍全部是 `origin/main` 自身前进带来的差集,不是本分支产物),22 个模式合计命中数随之继续增长。**这一次确实贡献了新的符号/词命中**(`⊇`/`⊂` 各一处、`subset`/`superset` 各若干处,见上表「main 漂移文件」行的逐条分类)——上一版这里写的「47 个新增文件零处贡献新命中」是**第 7 轮门审 P3-1 证伪的那句假话本身**,不是历史记录,已按 P3-1 的要求整段改写,不再重复这个断言。**分类结论(零处现时重申 guard/manager 包含关系)不受影响**:所有新增命中逐条读过,主题分别是字段类型转换、考勤三层嵌套、评论未读数、stock-prep 权限矩阵等,没有一处触及 `approvalTemplateAdminGuard`/`isTemplateManager`。

### 25.6 P3-1 / P3-2 / P3-3 / P3-4 处置(本轮一并收口)

| 项 | 处置 |
|---|---|
| P3-1(§24.1 自述「本轮为 11 个文件」,实际 12 个——脚本没把自己算进去) | **已修复(两次,第 7 轮门审 P3-2 指出本行原描述的是中间状态,现更正为最终状态)**:本轮修复轮当时先补成「本轮为 12 个文件」(枚举列表补上 `atg-retraction-sweep.sh` 自身);同一次编辑随后又整段去掉了绝对文件数,改为「以脚本现场打印的 `git diff --name-only origin/main..HEAD` 为准」(§24.1 现文)——这一行此前只记了第一步,漏记了第二步,本轮已按最终状态改写 |
| P3-2(§12 表 I′ 行用例名多抄了一个 `')`,`grep -F` 照贴 0 命中) | **已修复**——去掉尾部多余的 `)`,现在这段是文件里那一行(`', () => {` 结尾)的真实字面子串,`grep -F` 现场核对可直接命中(见本节改写处的核对说明) |
| P3-3(`atg-retraction-sweep.sh` 模式集窄于它要防的东西) | **已修复**——见 §25.5,6 个符号 + 6 个包含词 + 两处还原成裸词的窄化模式,共 22 个模式;复跑到零活断言 |
| P3-4(保密纪律,不得写进任何仓内文件) | **未写入任何仓内文件,措辞已按第 7 轮门审 P3-4 收紧**——本节、§2(d) 用例的命名与注释、以及本轮任何一处提交信息均只描述「manager 判定与 guard 判定互不包含」这一集合事实,不含门审报告 🔒 项点名的保密内容;该内容仅保留在仓外 `reviews/` 目录的门审报告里 |

### 25.7 行为侧收尾证据(现场执行,`metasheet2_lock_a1_fix`)

```
$ pnpm --filter @metasheet/core-backend exec tsc --noEmit
(无输出,exit 0)

$ DATABASE_URL="postgresql://localhost:5432/metasheet2_lock_a1_fix" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  2 passed (2)
      Tests  29 passed (29)
```

29/29(此前 28/28,+1 是本轮新增的 `§2(d)` 用例)——`packages/` 下唯一的行为文件改动是新增测试本身(纯增量,零删除,见 §25.8),`routes/approvals.ts` 的改动逐行核对全部是 `//` 注释行,DDL 与 `ApprovalTemplateGroupService.ts` 零改动。

### 25.8 `git diff --stat` 证据(只动注释/测试/MD/scripts)

**订正(本节第二次现场重跑)**:本节第一次起草时贴的数字(设计 MD `45 ++++++++-------`、总计 `137 insertions(+)`)本身就是那次自指披露里明说「不预期数字会再漂移」的反例——§25.4–§25.9 那之后仍在继续把内容写进本文档,本节自己的这次现场重跑就把验证 MD 的净增行数从 `45` 推到了下面这个更大的数,而这次重跑同样会被本次订正自身的编辑再推一点。这不是隐藏掉重新计数、悄悄换个数字了事——上一次「不预期再漂移」的判断错了,原句与错误一并留痕在这里,而不是删掉重写:

```
$ git diff --stat a789422b516f9e9ab6949c2cc0762a5daabc6be7 -- .
 docs/development/approval-template-groups-phase1-design-20260918.md         |   2 +-
 docs/development/approval-template-groups-phase1-verification-20260918.md   | 184 ++++++++++++++++++---
 packages/core-backend/src/routes/approvals.ts                               |  25 ++-
 .../approval-template-groups-lifecycle.db.test.ts                           |  44 +++++
 scripts/dev/atg-retraction-sweep.sh                                         |  64 +++++--
 5 files changed, 276 insertions(+), 43 deletions(-)

$ git diff a789422b516f9e9ab6949c2cc0762a5daabc6be7 -- packages/core-backend/src/routes/approvals.ts | grep -E '^[+-]' | grep -vE '^[+-]//|^\+\+\+|^---'
(无输出——approvals.ts 的每一处改动行都以 `//` 开头,零生产代码行为改动)

$ git diff a789422b516f9e9ab6949c2cc0762a5daabc6be7 -- packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts | grep -E '^-' | grep -v '^---'
(无输出——测试文件零删除,§2(d) 是纯增量插入)
```

**行为面结论(不受上述数字漂移影响——这四个文件的内容早已冻结,只有验证 MD 自己还在增长)**:5 个改动文件里,`ApprovalTemplateGroupService.ts`、DDL 迁移文件、`vitest.config.ts`、s6a 钉均**零改动**(不在本轮 diff 里);`routes/approvals.ts` 的 25 行改动逐行核对全部是注释;`lifecycle.db.test.ts` 的 44 行改动逐行核对全部是新增(零删除);两份 MD 与 `atg-retraction-sweep.sh` 按定义就是文档/脚本。**本轮生产代码行为改动数 = 0**,与任务书硬规矩「生产代码零行为改动(允许:注释、测试、MD、scripts/dev)」逐字相符——这一条结论不依赖验证 MD 自己的行数,`approvals.ts`/`lifecycle.db.test.ts` 两条 grep 证据在本节两次重跑之间逐字未变。

**自指披露,第二次(与 §23.11/§23.12/§24.7 同一问题,上面那次「不预期再漂移」的预测已被推翻,不再重复同一个错误预测)**:验证 MD 对自己行数的度量必然滞后一步——任何写进本节的数字,在落笔的瞬间就已经不包括这次落笔本身。本节到此为止不再新增大段落(§25.9 只补提交信息,通常是数行);**唯一权威的数字是推送前最后一次现场重跑 `git diff --stat a789422b516f9e9ab6949c2cc0762a5daabc6be7 -- .` 的输出**,不是本节写死的这一份——这不是本节没做到位,而是同一份文档统计自己改动量这件事在结构上就做不到「文档写完的瞬间数字仍准」,与 §23.11/§23.12/§24.7 指出的是同一类问题。

### 25.9 提交与推送

本节记录的 P2-1/P3-1/P3-2/P3-3/P3-4 五项处置,提交方式同 §23.11/§24.8 的约定:不在本节钉死 commit SHA,完整、无歧义的提交列表以**推送前最后一次** `git log --oneline a789422b5..HEAD` 现场输出为准。硬规矩重申(本轮全程遵守,现场核对):只在指定 worktree 内工作;未 `git checkout --`、未 `git reset --hard`、未 stash 丢弃;mutation 探针全部 `cp` 备份 → 改 → 单独跑 → 还原 → `cmp`(§25.3);未合并、未 undraft、未开/动 PR、未动 `origin/main`、未应用任何迁移到共享库;未改锁文(`approval-form-group-entity-design-lock-draft-20260916.md` 零改动);DDL 文件零改动;**本轮生产代码零行为改动**(§25.8);P3-4 保密纪律全程遵守,不得公开披露的内容只出现在仓外 `reviews/` 目录。

## 26. P3 卫生轮(2026-09-19)—— 第 7 轮门审(全部 4 条)+ 第 3 轮门审仍开放条目的处置表

**起点**:`a728ed65532918e3726171d0c42f44d6be7e0ba9`(第 7 轮门审 `impl-gate-A-slice1-round7-20260918.md` 的「被审 head」,即本轮编辑前的 HEAD;第 3 轮门审 `impl-gate-A-slice1-round3-20260918.md` 审的是更早的 `0144932ac`,其 6 条 P3 中 3 条已在第 4/5/6 轮修复轮里通过后续 gate 的重写关闭,本表对每一条现场核对现状,不假设未变)。**范围**:任务书指定的两份报告(第 7 轮、第 3 轮),不含中间第 4/5/6 轮门审自己的 P3(它们的处置已被各自下一轮门审复核为如实,不在本轮任务书点名范围内)。

### 26.1 处置表

| # | 来源 | 原文一句(压缩) | 处置 |
|---|---|---|---|
| 1 | 第 7 轮 P3-1 | §24.1/§25.5「新增文件里没有一处命中…包含关系符号或词」——现场重跑发现假(`index.cjs:83` 的 `⊇`、`univer-meta.ts:7045` 的 `⊂` 等确有命中,均无关主题) | **CLOSED-MD**——§24.1、§25.5 抬头/符号表格行/脚注四处全称否定改写为「已核对、均为不相关主题」的分类判定;commit 见 §26.3 |
| 2 | 第 7 轮 P3-2 | §25.6 的 P3-1 处置行只记「已修复——改为『本轮为 12 个文件』」这个中间态,漏记同一次编辑后来又整段去钉绝对数的最终态 | **CLOSED-MD**——处置行改写为「已修复(两次)」,补上第二步 |
| 3 | 第 7 轮 P3-3 | 设计 MD `:169`、验证 MD `:705`/`:1281` 概括「两个方向各有一个**端到端实测**反例」——方向二(manager 判定腿)是对导出解析器的直调,不是端到端 HTTP | **CLOSED-MD**——3 处概括句改写为「方向一端到端实测;方向二 guard 拒绝端到端实测,manager 判定由直调实测,附负控」;`routes/approvals.ts` **未改动**(生产注释本就写对,第 7 轮 §7 已核实,改它只会破坏其 stripped-comment md5 证据链) |
| 4 | 第 7 轮 P3-4 🔒 | 验证 MD `:1641`(§25.3)、`:1704`(§25.6 表)两处新增的「未提及可见性短路或列表端点后果」——虽是否定句,但点名了被保密内容的主题 | **CLOSED-MD**——两处改为不点名主题的措辞(「本节不含门审报告 🔒 项点名的保密内容」);本节与本表自身同样不重复该主题词 |
| 5 | 第 3 轮 P3-1(a) | 两个新真库套件的 `itIfExpectDb` 哨兵嵌套在 `describeIfDatabase` 内部,与同步骤 3 个既有兄弟(顶层放置)不一致 | **DEFERRED-owner 项**——第 4 轮门审("与第 3 轮 P3-1 的披露一致,本轮未变化")与第 6 轮门审复核后均未要求移动测试拓扑,原因是该 lane 今天不设 `EXPECT_DB`,放在哪一层都是同样 dormant,本切片独有的部分零可观测差异;移动拓扑属于对已结案范围决定的重新裁量,留给 owner 在决定是否为这两个套件开专属 lane 时一并做(design MD §6 已有对应行) |
| 6 | 第 3 轮 P3-1(b) | 验证 MD §13.2 一直未写「该 lane 不设 `EXPECT_DB`、哨兵在 CI 不运行、真正保护是 bash `:?`」这句作用域披露 | **CLOSED-MD**——§13.2 补上该披露段,现场核对 `plugin-tests.yml` 的 `EXPECT_DB` 计数为 0、`:1578` 的 `DATABASE_URL:?` 仍在 |
| 7 | 第 3 轮 P3-2(= 第 2 轮 P3-3) | `serialization.db.test.ts` 头部 mutation 配方 (4) 点名一个全仓不存在的函数 `takeOrgLock`,且写成「两行」 | **CLOSED-注释**——改写为实际形状(`renameApprovalTemplateGroup` 内单行内联的 `pg_advisory_xact_lock` 调用),措辞照抄配方 (2);纯 JSDoc 注释改动,`git diff` 核对改动行全部以 `*` 开头 |
| 8 | 第 3 轮 P3-3(= 第 2 轮 P3-4) | `routes/approvals.ts:396-399`「guard population ⊆ manager」是零 grep 计数的全称断言 | **CLOSED(已由第 6 轮修复轮闭合,第 7 轮门审确认零处活断言)**——本轮登记备查,无新增改动;与本轮 #1/#3 是同一条注释链的后续更正,已在其中一并核对 |
| 9 | 第 3 轮 P3-4(= 第 2 轮 P3-5) | `git log` 里仍有 `wip: carry step-agent changes forward (to be squashed by the lane)` 提交 | **DEFERRED-owner 项**——squash 需要 force-push,本轮硬规矩明确禁止("不 force"、"绝不 git reset --hard"精神下的同类限制);现场核对该提交仍在(`f6e8ea2d8`),仍已 push,不影响任何验收结论 |
| 10 | 第 3 轮 P3-5(= 第 2 轮 P3-6) | 两个新真库套件仍无 `*-ci-wiring.test.mjs` 守卫 | **DEFERRED-owner 项**——design MD §6 已有「未排期,留给后续单元或 owner 裁决是否现在做」一行(本轮核对仍在、仍准确);新建守卫文件是范围扩张,不是本轮「测试/注释/MD/scripts 层闭合」的机械修复,维持既有处置 |
| 11 | 第 3 轮 P3-6(ii) | 设计 MD §6「留给后续切片的项」未收录 P2-1 引入的响应形状副作用(非法 `templateId` + 不存在的 `groupId`:404→500) | **CLOSED-MD**——补一行,点名机制与验证 MD §22.5 出处,不涉及行为改动 |
| 12 | 第 3 轮 P3-6(iii) | 建议下一切片给 `mapGroupConstraintError` 补 22P02 → 400 映射 | **DEFERRED-需行为改动**——改服务层代码,超出本轮「零生产代码行为改动」范围,已通过 #11 的 MD 行转交后续切片 |
| 13 | 第 3 轮 NIT | `applyTemplateVisibilityFilter` 对 `actor === undefined` 的 fail-open 分支(`!actor` 直接放行)未被任何用例实测,只有静态可达性论证 | **DEFERRED-owner 项**——新增用例是范围扩张;静态论证(链接 handler 上 `visibilityActor` 不可能为 `undefined`,因两次调用共享同一个 `resolveApprovalActorId(req)`)第 2/3 轮门审均未提出异议,维持原状 |

### 26.2 撤回类改动的全分支零命中扫描

本轮撤回/更正的是四句**曾经站着的全称否定/过强概括**(表中 #1/#3 的原文),不是新引入的断言,按记忆 `feedback_absolute_claim_sweep_must_be_mechanical` 的纪律,扫描目标是"这四句被撤回的原文本身"是否还以现役断言的身份存在于分支任何文件:

```
$ git grep -F -c "新增的这些文件里没有一处命中" -- . | awk -F: '{s+=$2} END{print s+0}'   → 0
$ git grep -F -c "新增的文件里没有一处命中任何一个包含关系符号或词" -- . | awk -F: '{s+=$2} END{print s+0}'  → 0
$ git grep -F -c "没有一处贡献新的命中" -- . | awk -F: '{s+=$2} END{print s+0}'                          → 0
$ git grep -F -c "两个方向各有一个端到端实测反例" -- . | awk -F: '{s+=$2} END{print s+0}'                  → 0
$ git grep -F -c "未提及可见性短路或列表端点后果" -- . | awk -F: '{s+=$2} END{print s+0}'                  → 0
$ git grep -F -c "不描述可见性短路或列表端点后果" -- . | awk -F: '{s+=$2} END{print s+0}'                  → 0
```
六句全部 **0 命中**。唯一的例外性命中是「零处出现在其它文件」——只出现一次,在本轮自己新写的 §25.5 表格行里,作为**引用**上一版误写的原句加引号呈现(「上一版此处误写为『……』」),与本文档一贯的历史引用惯例一致,不是重申。

**`atg-retraction-sweep.sh` 复跑(P3 卫生轮 2026-09-19,现场执行,22 个模式)**:范围内文件数 **159**(`origin/main` 继续前进的自然结果,非本分支产物);逐条核对本轮新增/改写的段落自身命中(引用 `⊇`/`⊂`/`subset`/`superset` 等符号描述漂移文件的具体命中位置)均为**元讨论/引用**,不是重申;**零处**以现时事实口吻断言 `approvalTemplateAdminGuard`/`isTemplateManager` 的任一方向包含关系——分类结论与第 6 轮修复轮(§25.5)一致,详见本文档 §24.1/§25.5(本轮已更正)。

### 26.3 提交与推送

（推送前以 `git log --oneline a728ed655..HEAD` 现场输出为准,不在此钉 SHA——同一自指问题见 §23.11/§24.7/§25.8,本节沿用同一约定。）

### 26.4 私有处女库重跑 + tsc(现场执行,命令与输出原样贴入)

```
$ dropdb --if-exists metasheet2_p3hygiene_r1 && createdb metasheet2_p3hygiene_r1
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_p3hygiene_r1" \
  MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,\
049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,\
20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql \
  pnpm --filter @metasheet/core-backend db:migrate
  … migration "zzzz20260918090000_create_approval_template_groups" was executed successfully
  MIGRATE_EXIT=0   （本切片迁移为最后一条 executed,与 round1-7 各轮门审记录一致)

$ DATABASE_URL="postgresql://localhost:5432/metasheet2_p3hygiene_r1" EXPECT_DB=1 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
  Test Files  2 passed (2)
       Tests  29 passed (29)      零 skip      VITEST_EXIT=0   （与第 7 轮门审的 29/29 一致——本轮零测试断言改动,只改了 serialization 文件的 JSDoc 头部注释)

$ pnpm --filter @metasheet/core-backend exec tsc --noEmit
  TSC_EXIT=0   （零行输出）

$ dropdb --if-exists metasheet2_p3hygiene_r1
  DROP_EXIT=0（处女库已按硬规矩用完即删,不留存）
```

### 26.5 `git diff --stat` 证据(只动注释/测试/MD/scripts)

**自指注记(同 §23.11/§24.7/§25.8/§25.8 一贯的问题)**:下方是本节自身这次落笔**之前**两个提交的现场输出——本节写完之后,记录本节内容的这次提交会再产生一行验证 MD 自己的 diffstat,这个数字从落笔的瞬间起就已经过期。**唯一权威的数字是推送前最后一次现场重跑** `git diff --stat a728ed655..HEAD`。

```
$ git diff --stat a728ed65532918e3726171d0c42f44d6be7e0ba9..HEAD
 docs/development/approval-template-groups-phase1-design-20260918.md         |  3 ++-
 docs/development/approval-template-groups-phase1-verification-20260918.md   | 21 ++++++++++++---------
 .../approval-template-groups-serialization.db.test.ts                       |  7 +++++--
 3 files changed, 19 insertions(+), 12 deletions(-)
```

三个文件:两份 MD + 一个测试文件的 JSDoc 头部注释(逐行核对,见提交 2 的记录,改动行全部以 `*` 开头)。**零 `packages/*/src` 文件、零 DDL、零 `scripts/dev` 之外的文件**——本表数字尚不含本节自身这次提交,权威判读见上方自指注记。

## 27. 勘误 3 候选的技术验证(2026-09-19,待 owner 确认)

> **逐句失效标记(2026-09-20)。本节不作废** —— 它是候选 v1 的完整证据记录,门审要据它核对「v1 到底被测了什么、漏了什么」。求值:
>
> - 本节所有关于**谓词内容**的句子(`CHECK (btrim(name) <> '')`、「非空白」、27.1/27.4/27.5 里引用该谓词的每一处)**已失效** —— 该谓词被第 8 轮门审 P2-1 证伪并已被 REDRAFT v2 取代,现行谓词见 §28.1。
> - 本节关于**治理边界**的句子(27.0「不是 ratify/合并/应用的许可」、归属纠正那一段)**仍 OPERATIVE**,§28 照此执行。
> - 27.2 关于 `mapGroupConstraintError` 分支「保留不删」的处置**仍 OPERATIVE**(§28.5 沿用)。
> - 27.3 记录的反引号事故**仍 OPERATIVE**,并在 §28.1 又新增了同族的一次反斜杠事故。
> - 27.5 的 mutation(CHECK 改回 `~ '[!-~]'`)对 v1 有效,但**对 v2 判别力不足**:它只打「接受这一半」。v2 的三条探针见 §28.4,其中 M-A 就是「把旧实现跑一遍」。

### 27.0 状态声明(先于任何证据)

**Erratum 3 是 CANDIDATE——PROPOSED,未 ratify,不是「已授权」。** 本节记录的一切(下方 27.1-27.7 的迁移/服务层/测试改动与全绿证据)都只是**技术验证**,不构成 ratify、合并或迁移应用的许可,也不是对 §23.5「owner 勘误请示」的自我批准。

**归属纠正(2026-09-19,owner 本人指出)**:本轮更早的一次落笔曾把「owner 的『并行可收口分组中文 CHECK 的勘误,但不要把它夹进撤销修复』」误记为对勘误 3 本身的批准,并在迁移文件、服务层注释里写成「owner-ratified 2026-09-19」——owner 同日纠正:那句话是**审阅建议**,不是对勘误 3 的批准,也没有裁定「只改 `name`、保留两处 `org_id` CHECK」这个具体形状。本节与迁移/服务层的措辞已按此边界改写(见 27.1/27.2);锁文自己的「勘误 3」抬头条目与 `lock-errata-proposed-grouping-v2.13-20260919.md` 是这次归属纠正的权威口径,本节照抄,不另造新措辞。

**单列请示(逐字,等 owner 亲自确认,不在本节被回答)**:是否批准**仅**将 `approval_template_groups.atg_name_nonblank` 的谓词由 `name ~ '[!-~]'` 改为 `btrim(name) <> ''`,而 `atg_org_nonblank` / `atgl_org_nonblank` 两处 `org_id ~ '[!-~]'` **保持不变**?

### 27.1 迁移改动(候选,DDL 未应用到任何共享/staging/生产库)

`packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts`:`atg_name_nonblank` 的谓词由 `CHECK (name ~ '[!-~]')` 改为 `CHECK (btrim(name) <> '')`(现场行号 `:63`);`atg_org_nonblank`(`:40`)与 `atgl_org_nonblank`(`:101`)两处 **不变**。列上方的多行注释按 27.0 的措辞重写为「Erratum 3 CANDIDATE (PROPOSED 2026-09-19, pending owner confirmation …NOT owner-ratified, NOT authorized)」,并记录了一个本轮修复的真实事故:该注释块位于 `sql\`...\`` 标签模板字面量内部,更早一版注释里内嵌了反引号(用反引号包住标识符,如常规 JSDoc 注释的写法)——这在模板字面量内部会提前终止字符串,`tsx`/`esbuild` 转译时报 `Expected ";" but found "lock"`(实测,现场复现见下方 27.3);已改为不含任何反引号字符的写法,并在注释里加了一句显式提醒,防止未来编辑再引入同一个错误。

### 27.2 服务层改动(候选,零行为收窄)

`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`:

- 文件头 JSDoc(`GROUP_NAME_UNSUPPORTED` 段落)与 `NONBLANK_CHECK_CONSTRAINTS` 上方的块注释、`mapGroupConstraintError` 自己的文档注释——三处「owner-ratified」措辞全部改写为「Erratum 3 CANDIDATE (PROPOSED 2026-09-19, pending owner confirmation — NOT owner-ratified, NOT authorized)」,并补充「见锁文自己的『勘误 3』抬头条目」的出处指引。
- `mapGroupConstraintError` 里 23514 → `GROUP_NAME_UNSUPPORTED` 的映射分支**保留,未删除**——该分支的 `atg_name_nonblank` 成员在本候选分支上已不可达(CHECK 谓词变了,不会再对 `name` 触发 23514),但删除它是一次未经 owner 确认就收窄错误码映射面的单方面决定,不是本候选被授权做的事;分支上新增行内注释说明这一点,`org_id` 的两个成员不受影响、仍是 defense-in-depth 生效路径。
- `requireName`(仅 trim + 非空校验,不含 ASCII 限制)**未改动**——这本来就不含 ASCII 限制,与候选变更方向一致,不需要动。
- 错误消息文案(`'当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误'`)**未改动**——按硬规矩「不做收窄删除,避免夹带」,该文案是否需要跟着候选的裁决结果调整,留给 owner 与 DDL 裁决一并做。

### 27.3 迁移文件语法事故与修复(mutation 之外的一次真实红,现场记录)

修复 27.1 提到的反引号问题之前,`db:migrate` 在私有库上现场报错:

```
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_a1_erratum" \
    MIGRATION_EXCLUDE="008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql" \
    pnpm --filter @metasheet/core-backend db:migrate
failed to migrate
Error: Transform failed with 1 error:
.../zzzz20260918090000_create_approval_template_groups.ts:44:25: ERROR: Expected ";" but found "lock"
```

改用不含反引号的措辞后,同一条 `db:migrate` 命令在同一私有库上干净执行到底(见 27.6)。记入本节是因为这个语法问题是**本轮接手时既有的、未提交状态里就带着的缺陷**(候选迁移的注释块在被交接前就已内嵌反引号),不是本轮新引入的——本轮的贡献是发现并修掉它,顺带证明了这份未提交候选此前从未被实际跑过 `db:migrate`。

### 27.4 测试改动:此前「CJK ⇒ 400 GROUP_NAME_UNSUPPORTED」用例改为正向

`packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`(现场行号 `:600`):design-gate A-3 回流修复轮(2026-09-18)新增的 `it('P1-3 (design-gate A-3, 2026-09-18): a pure-CJK group name maps to 400 GROUP_NAME_UNSUPPORTED, …')` 改写为 `it('Erratum 3 candidate (pending owner confirmation): a pure-CJK group name creates 201 with the name read back verbatim, renames to another CJK name 200, and a blank name is still 400', …)`,同一个位置,断言方向反转以匹配候选分支现状:

1. `POST /api/approval-template-groups {name:'请假'}` ⇒ **201**,响应体 `group.name === '请假'`,并直接 `SELECT name FROM approval_template_groups WHERE org_id=$1 AND id=$2` 核对 DB 行的 `name` 逐字等于 `'请假'`(不只信响应体回显)。
2. `PATCH /api/approval-template-groups/:id {name:'培训'}` ⇒ **200**,响应体与 DB 行的 `name` 都变成 `'培训'`。
3. `POST … {name:'   '}` ⇒ **400** `GROUP_NAME_REQUIRED`——这一步走的是 `requireName` 的应用层 trim+非空校验(在任何 DB 往返之前就短路),与候选是否改动 DB 层 CHECK 无关;记入本用例是为了在同一处把「候选不改变空白名仍被拒绝」这件事说清楚,不是声称这条断言由 DB 层 `btrim` CHECK 把关。
4. 正控延续自被取代的旧用例:同一 org 一个 ASCII 名字仍然 **201**——候选是放宽,不是收紧。

两个真库文件总用例数**不变**(29 个),因为这是对既有一条 `it` 的重写,不是新增测试。

### 27.5 mutation(CHECK 改回 `~ '[!-~]'`,私有库重建 ⇒ 中文用例红)

遵守本仓 mutation 探针纪律:`cp` 备份 → 改 → 单独跑受影响用例 → `cp` 还原 → `cmp` 逐字节核对。这里的「改」是 DDL 谓词本身,所以还需要重建私有库(仅 source 文件的 mutation 不够——CHECK 已经落进已迁移的 schema 里)。

```
$ md5 src/services/../db/migrations/zzzz20260918090000_create_approval_template_groups.ts
MD5 (…) = 3c3f7ea5e534c25b9a0fa71de8805a95
# python3 精确文本替换：CHECK (btrim(name) <> '') → CHECK (name ~ '[!-~]')（唯一一处，替换前校验命中数=1）
$ dropdb --if-exists metasheet2_a1_erratum && createdb metasheet2_a1_erratum
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_a1_erratum" MIGRATION_EXCLUDE="…（同 27.1 六个排除项）…" \
    pnpm --filter @metasheet/core-backend db:migrate
  … migration "zzzz20260918090000_create_approval_template_groups" was executed successfully
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_a1_erratum" EXPECT_DB=1 \
    pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts -t "Erratum 3 candidate" --reporter=verbose
 ❯ … Erratum 3 candidate (pending owner confirmation): a pure-CJK group name creates 201 …
   AssertionError: expected 400 to be 201
 Test Files  1 failed (1)
      Tests  1 failed | 18 skipped (19)
# 还原
$ cp /tmp/a1-erratum3-probe/migration.orig.ts src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts
$ cmp /tmp/a1-erratum3-probe/migration.orig.ts src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts && echo RESTORED-IDENTICAL
RESTORED-IDENTICAL
$ md5 src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts
MD5 (…) = 3c3f7ea5e534c25b9a0fa71de8805a95
```

把 `name` 的 CHECK 改回可打印-ASCII-only 后,私有库重建 + 重新迁移,同一用例的第一个断言从 201 变红成 400(`GROUP_NAME_UNSUPPORTED`,响应体证据未逐条重复贴出,机制与 §23.4 的旧 mutation 一致,只是方向相反)——证明这条 CHECK 谓词是本用例正向断言的承重点,不是装饰性断言。还原后 MD5 与还原前逐字节一致。

### 27.6 私有处女库(`metasheet2_a1_erratum`)重跑 + tsc(现场执行,命令与输出原样贴入)

```
$ dropdb --if-exists metasheet2_a1_erratum && createdb metasheet2_a1_erratum
$ DATABASE_URL="postgresql://localhost:5432/metasheet2_a1_erratum" \
  MIGRATION_EXCLUDE="008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql" \
  pnpm --filter @metasheet/core-backend db:migrate
  … migration "zzzz20260918090000_create_approval_template_groups" was executed successfully
  （本切片迁移仍是最后一条 executed，与历史各轮一致）

$ DATABASE_URL="postgresql://localhost:5432/metasheet2_a1_erratum" EXPECT_DB=1 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=dot
  Test Files  2 passed (2)
       Tests  29 passed (29)      零 skip

$ pnpm --filter @metasheet/core-backend exec tsc --noEmit
  （零行输出，退出码 0）
```

### 27.7 required 检查 `test (20.x)` 的全量命令逐字复现(同 §23.10 的方法论,换成本候选私有库)

同 §23.10 的划界:只逐字复现该 required job 里点住本切片两个真库文件的那一步(`id: approval-real-db-integration`,79 个 whole-file 路径,来源 `.github/workflows/plugin-tests.yml:1579-1658`,现场核对行号未变),把 `DATABASE_URL` 换成本轮私有库,其余(排除列表、`--config`、`--reporter`、79 个文件路径顺序与拼写)逐字未改:

```
$ export DATABASE_URL="postgresql://localhost:5432/metasheet2_a1_erratum"
$ export EXPECT_DB=1
$ pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run <79 个文件，逐字同 plugin-tests.yml:1579-1658> --reporter=dot
 Test Files  79 passed (79)
      Tests  886 passed (886)
   Duration  132.46s
```

79/79 文件全绿、886/886 全过、零 skip、零失败。**与 §23.10 记录的历史基线(880 passed | 5 skipped，885 总数)对不上**——这是预期的分支自然漂移,不是本候选引入的效应:§23.10 是 round-7/8 时期的一次性快照,此后这条分支上落了大量与 A-1 无关的 docs/test 卫生轮提交(见文件顶部 git log,`fbb5b38d8` 等一串 `docs(approval)`/`test(approval)` 提交),会独立改变同一批 79 个文件里其它文件的用例数与 skip 数;本节唯一的判读点是「79/79 文件、零失败」,不是这个总数是否与某个历史快照相等。

**no-DB 单元测试 lane 未在本轮单独重跑**——27.1/27.2 的改动只触及 `db/migrations/`(不参与 no-DB lane)与 `services/ApprovalTemplateGroupService.ts` 的注释/文档字符串(零可执行语句改动;`requireName`、`mapGroupConstraintError` 的运行时逻辑逐字未变,唯一的运行时差异来自 DDL 本身,不在这条 lane 的覆盖范围内),真库套件(27.6/27.7)与 `tsc --noEmit`(27.6)已经覆盖了本轮唯一有行为差异的层面(DB CHECK 谓词);因此判定 no-DB lane 与本轮零重叠,不必为零改动的一层重复跑一次仅由 CI 编排巧合放在同一 job 里的独立 lane。

### 27.8 设计 MD §2 同步

`approval-template-groups-phase1-design-20260918.md` §2.1/§2.2 两张约束表各加一列「候选(2026-09-19,待 owner 确认)」,标注哪些行受本候选影响(仅 `atg_name_nonblank` 一行「是」,`atg_org_nonblank`/`atgl_org_nonblank` 两行显式标「候选未改」,其余行「不受影响」),并把候选分支下的现场行号与原 ratified 行号并列列出。

### 27.9 前瞻披露:A-3 与本候选的耦合点

A-3(分期 3,`?category=`/`/categories`,尚未在本分支落地)的 `classifyBackfillCategory` 对 CJK `category` 值的 skipped 处置,在候选被批准后需要同步复核——候选改变的是 `approval_template_groups.name` 这一列的 CHECK,不是 `approval_templates.category`,两者目前是不同的列、不同的校验路径,但 A-3 设计门审(`design-gate-A3-phase2-20260918.md` §5 O2)本身就是本候选的源头,若 owner 批准候选,A-3 落地时该函数对 CJK 输入的处置逻辑应当回头核对是否仍然合理,不能假定两处独立无关。本节仅记录这个耦合点,不预判 A-3 该怎么改——`classifyBackfillCategory` 在本分支尚不存在,无代码可动。

### 27.10 提交与推送

（推送前以 `git log --oneline <起点>..HEAD` 现场输出为准,不在此钉 SHA——同一自指问题见 §23.11/§24.7/§25.8/§26.3,本节沿用同一约定。）

## 28. 勘误 3 候选 REDRAFT v2 的技术验证(2026-09-20,待 owner 确认)

> **逐句求值标记(2026-09-20,第 1 轮门审 `impl-gate-A-slice1-name-rule-candidate-round1-20260920.md` 之后,见 §29)。本节整体**仍然有效**,只有下面点名的句子被求值为假或被替换 —— 不作废整节:**
>
> | 本节位置 | 原句 | 求值 | 处置 |
> |---|---|---|---|
> | §28.2 第 1 段末 | 「纯空白/纯不可见名**一律**是 400 `GROUP_NAME_REQUIRED`,永远落不到 23514 或 500」 | **假**(门审实测 7 个码位经真实 HTTP 端点 201 入库) | 已在原句处改写为受限断言 + 残留;闭合该缺口的是 §29 的应用层规则 |
> | §28.2「已披露缺口」段 | 缺口清单 | **不全**(漏 U+000B / U+000C) | 已在原句处补齐 |
> | §28.3 用例 2 / 用例 3 的标题 | `every blank/invisible-only name` | 量词**为假** | 测试标题已改为「枚举集」措辞,见 §29.4 |
> | §28.4 末句 | 「重跑 **32/32 全绿**」 | **假**(实为 30 passed / 2 skipped) | 已在原句处改正 |
> | §28.1 谓词的 `E' \t\r\n'` 写法 | 「逐字照提案」 | **成员集仍逐字**,但**拼写已改** | 四个控制/空格成员改写为 `' ' || chr(9) || chr(13) || chr(10)`,集合不变,见 §29.5 |
>
> 本节其余每一句(就地改迁移的前提、s6a 钉不覆盖、locale 无关、两处 `org_id` 逐字未动、M-A/M-B/M-C/N-1 的红绿)**均未被求值为假,仍然 OPERATIVE**。


**Erratum 3 仍是 CANDIDATE —— PROPOSED,未 ratify,不是「已授权」。** 本节记录的一切都只是技术验证,不构成 ratify、合并或迁移应用的许可。本分支未开 PR、未合并、未 undraft、未向 `metasheet_v2` / `metasheet_test` / `metasheet_testbed_main` 或任何共享/staging/prod 库应用过任何迁移;全部真库证据来自本次自建的一次性库 `metasheet2_namerule_impl_20260920`(owner 角色 `ms2testbed`,非超级用户),用完即 `dropdb`。

### 28.0 为什么有 v2:第一版候选被第 8 轮门审证伪

`impl-gate-A-slice1-round8-20260919.md` 对第一版候选(`CHECK (btrim(name) <> '')`)判 NEEDS-FIX,3 P2:

- **P2-1** —— 该谓词被描述成「非空白(允许任意字符)」,但 PostgreSQL `btrim/2` 的**默认裁剪集只有 ASCII 空格**。全 U+200B(或 U+3000 / TAB / LF / U+FEFF)组成的名字照样过 CHECK;应用层 `requireName` 的 JS `.trim()` 也不裁 U+200B/200C/200D/2060 ⇒ 这一族**同时穿透两道闸**,`POST {name:"<U+200B>"}` 201 入库,得到一个在任何界面都看不见的分组。
- **P2-2** —— 候选谓词「该拒绝什么」这一半**零测试覆盖**:把整条 CHECK 换成 `CHECK (true)`,29/29 仍全绿。
- **P2-3** —— §23.5 的两句绝对断言在该 head 上已为假且无失效标记(本轮已收口,见 §23.5 顶部的逐句求值表)。

owner 同日原话:「我之前建议的简单 `btrim(name)` 也不够覆盖纯不可见字符,应以修订后的名称规则验收,不能直接沿用旧建议。」

### 28.1 谓词(逐字照「勘误 3(重拟)」选项 (i))

```
CONSTRAINT atg_name_nonblank CHECK (
  btrim(name, E' \t\r\n' || chr(12288) || chr(8203) || chr(8204) || chr(8205)
                || chr(8288) || chr(65279)) <> ''
)
```

裁剪集 = ASCII 空格 / TAB / CR / LF + U+3000 全角空格 + U+200B/200C/200D 零宽(非)连接符 + U+2060 词连接符 + U+FEFF BOM。**locale 无关**(不走 `iswspace`/`[[:alnum:]]`),规避 15-alpine musl 轴。两处 `org_id` CHECK **逐字未动**。

**源码写法的行为级证明(不是论证)**:该谓词写在 `sql\`...\`` 标签模板字面量内部,反斜杠必须**加倍**才能让 PostgreSQL 收到提案的原文。迁移跑完后直接对比两串:

```
-- A:迁移产出的 CHECK
SELECT encode(convert_to(pg_get_constraintdef(oid),'UTF8'),'hex') FROM pg_constraint WHERE conname='atg_name_nonblank';
-- B:把提案文本原样喂给 psql 建的 TEMP 表的同名 CHECK
⇒ byte_equal = t   (IDENTICAL: migration-emitted CHECK == proposal text verbatim)
```

**存储态的一条披露(不修,照提案逐字保留)**:因为提案文本用的是 `E' \t\r\n'`,`pg_get_constraintdef` 读回来的约束定义里**含真实的 CR 与 LF 字节**。任何对 `pg_dump` 产物做换行归一(CRLF→LF)的流水线都会**静默地把 CR 从裁剪集里删掉**,而约束名、报错码都不会变。这是选择「逐字照提案」的已知代价,列出来供 owner 连同谓词一并裁;把它改成 `chr(13)` 之类等价写法在字符集上完全一致,但那是**另造一个更窄的同类物**,不是本候选被授权做的事。

**本轮真实事故(记录下来,防止下一次编辑再犯)**:第一版落笔把提案文本写进上方**注释**时用了单反斜杠。JS 模板字面量把 `\t\r\n` 变成真的 TAB/CR/LF,那个 CR/LF **在句子中间结束了 SQL 行注释**,后半句被当成 SQL 解析,`db:migrate` 报 `syntax error at or near "'. A single backslash would be consumed`(PG 侧 `scanner_yyerror`,line 1192)。与该文件里既有的「反引号会提前终止模板」是同一族陷阱;注释里现在写明了这一条,并且**连散文里的反斜杠也一律加倍**。

### 28.2 应用层镜像(`ApprovalTemplateGroupService.ts` `requireName`)

`name.trim()` → `name.replace(/^[\s\u200B\u200C\u200D\u2060]+|[\s\u200B\u200C\u200D\u2060]+$/g, '')`。

JS 的 `\s` 与 `String.prototype.trim` 的裁剪集相同,已覆盖空格/TAB/CR/LF/U+3000/U+FEFF,**唯独不含** U+200B/200C/200D/2060 —— 正是 P2-1 那一族。补上这四个之后,应用层集合是 DB 集合的**严格超集**,方向是对的:`requireName` 返回的任何名字**按构造**已满足 CHECK,所以 `requireName` 返回的名字**不可能**违反 CHECK。~~所以纯空白/纯不可见名一律是 400 `GROUP_NAME_REQUIRED`,永远落不到 23514 或 500。~~ **⚠️ 这半句(全称量词)经第 1 轮门审实测为假**:两个集合**都不含**的码位两层都不拦 —— U+00AD / U+180E / U+2800 / U+3164 / U+034F / U+FE0F / U+115F 经真实 HTTP 端点 **201 入库**,且列表端点原样返回。正确的受限表述:**「本函数返回的名字按构造满足 CHECK」为真;「任何不可见名都被 400」为假**。闭合该缺口的不是这个镜像,而是 §29 引入的**应用层可见字符规则**(镜像永远补不上:被镜像的集合本身就不含这些码位)。

**这条「超集」断言的承重证据是行为,不是源码文本**:§28.3 用例 2 把 DB 集合里的六个值**逐个经生产路由**打进去,断言的是 `error.code === 'GROUP_NAME_REQUIRED'`(不是 23514、不是 500);用例 1 的 padded 名字证明「裁剪」这一半真的发生了。手边还跑过一条 `node -e` 的集合包含检查(DB 集合每个码位都被新 pattern 裁掉),但那条只读**重新敲进 shell 的**正则,是源码文本论证,**不作为承重证据**,只当交叉验证记录。

它是**裁剪**不是**拒绝**(镜像 `btrim` 的语义):`U+200B + 'HR' + U+200B` ⇒ 201,库里存的是 `'HR'`;内部零宽(`'a' + U+200B + 'b'`)原样保留。**已披露的可接受后果**:`'H' + U+200B + 'R'` 与 `'HR'` 在 `uq_atg_org_name_active` 下是两个不同的名字,而渲染起来一模一样 —— 这是选项 (i) 接受内部不可见字符的设计后果,不是缺陷。

**已披露缺口(写成断言,不写成散文)**:裁剪集逐字照 owner 提案,因此**不含** U+00A0 NBSP、**U+000B VT、U+000C FF**、U+1680、U+2000–U+200A、U+202F、U+205F、U+2028/9(**U+000B / U+000C 是第 1 轮门审 P3-2 指出的漏列,已补**);也**不含**另一族完全不同的不可见码位 U+00AD / U+180E / U+2800 / U+3164 / U+034F / U+FE0F / U+115F(第 1 轮门审 P2-1,见 §29)。直连 SQL 插入 NBSP-only 名字**会成功**;经生产路由则 400(JS `\s` 含 U+00A0)。§28.3 的用例把这一对(直插成功 / 走路由 400)**两半都断言**,所以这条披露是可机核的行为事实,不是会腐烂的散文。

### 28.3 真库用例(`approval-template-groups-lifecycle.db.test.ts`,4 个 `it`,替换掉原来那 1 个)

| # | 用例 | 断言 |
|---|---|---|
| 1 | 有可见字符的名字 | `请假` / `休暇申請` / `🎉庆祝` / `'a'+U+200B+'b'` / ASCII 正控 ⇒ **201**,响应体与 DB 读回**逐字节**相同;纯中文改名到另一个纯中文名 ⇒ **200**;`U+200B U+3000 HR-padded-<TS> U+FEFF U+2060` ⇒ **201 且存的是 `HR-padded-<TS>`**(这一条才分得清「裁剪」与「拒绝」两种镜像设计) |
| 2 | 空白/纯不可见名走**生产路由** | `''` / `' '` / `U+3000` / `U+200B×2` / `U+FEFF` / `TAB+LF` 六个值 ⇒ **400 且 `error.code === 'GROUP_NAME_REQUIRED'`**;该 org 下写入 **0 行**。**钉的是错误码不是状态码** —— 见 M-C。 |
| 3 | 同样六个值走**直连 SQL** | `INSERT INTO approval_template_groups …` ⇒ **23514 `atg_name_nonblank`**(证明 CHECK 本身承重,不只靠应用层);同一语句形状的**正控**:`报销` ⇒ 成功;**已披露缺口对**:NBSP-only 直插**成功** + 同值走路由 **400 `GROUP_NAME_REQUIRED`** |
| 3b | rename 路径(与 create 共用 `requireName`) | `PATCH {name: U+200B×2}` ⇒ **400 `GROUP_NAME_REQUIRED`**,且原名字未被改动。「共用同一个 helper」是源码文本断言,这一行把它变成行为断言 |
| 4 | 两处 `org_id` CHECK 未变 | `atg_org_nonblank`:`组织` 直插 ⇒ 23514,ASCII org 正控 ⇒ 成功;`atgl_org_nonblank`:同样一负一正(`group_id IS NULL` + `unlinked_at` 非空,让复合 FK 在 MATCH SIMPLE 下不参与,确保被测的就是 org_id 的 CHECK);并从 `pg_constraint` **读活目录**断言两条谓词仍含 `~ '[!-~]'` 且**不含** `btrim`。**排序在 JS 里做,不用 SQL `ORDER BY conname`** —— 文本排序依赖 collation,两个约束名恰好在下划线处分叉:macOS Homebrew 的 `en_US.UTF-8`(近似字节序)下 `_`(0x5F)< `l`,`atg_` 在前;glibc 的 `en_US.utf8`(ISO 14651 把标点降到主级之下)比较的是 `atgorgnonblank` vs `atglorgnonblank`,`l` < `o`,两行**反过来**。CI 用 `ankane/setup-postgres`(glibc,PG 14),本地是 Homebrew PG 15 —— 写成 `ORDER BY` 就是一条「本地绿 CI 红」的断言,正是 `finding_prod_pg15_never_tested` 点名的盲区 |

### 28.4 mutation(cp 备份 → 改 → 重建私有库 → 跑 → cp 还原 → cmp 全部逐字节一致)

| 探针 | 改动 | 观察到的红 |
|---|---|---|
| **M-A**(= 跑一遍旧实现) | 迁移谓词 → 第一版候选 `btrim(name) <> ''` | 用例 3(直连 SQL)**红**:`promise resolved "Result{ command: 'INSERT' …}" instead of rejecting`。用例 2(走路由)**仍绿** —— 这正是两条必须并存的理由,也正是 P2-1 当初漏出去的机制。1 failed / 21 passed |
| **M-B** | 迁移谓词 → `CHECK (true)`(第 8 轮门审自己那条证伪探针,原样重跑) | 用例 3 **红**。1 failed / 21 passed ⇒ **P2-2 关闭**(同一条探针下,上一轮是 29/29 全绿) |
| **M-C** | `requireName` → 退回裸 `.trim()` | 用例 2 **红**,且红在**错误码**:`expected 'GROUP_NAME_UNSUPPORTED' to be 'GROUP_NAME_REQUIRED'`;用例 1 也红(padded 名字)。**状态码两边都是 400**,所以只断言 status 的写法对这条 mutation 判别力为零 —— 这是本轮特意钉 `error.code` 的原因。2 failed / 20 passed |

| **N-1**(负控,不是 mutation) | 用例 4 的查询强行加 `ORDER BY conname DESC` | **仍绿** —— 证明那条断言在 JS 里 `.sort()` 之后**与 DB 行序无关**,不是「恰好本机 collation 排对了」。这是上面那条 collation 陷阱的行为级闭合 |

三条 mutation 与 N-1 **都是在最终版测试文件上重跑的**(修复轮改过测试文件,按「越界盾不护新行」全门重跑,不沿用第一轮的红)。还原后 `cmp` 对迁移与服务两个文件均逐字节一致,重跑 **30 passed / 2 skipped(32)**(~~32/32 全绿~~ —— 第 1 轮门审 P3-3:那 2 条是 `itIfExpectDb` 的 anti-skip-green 哨兵,`EXPECT_DB` 未置位时是 skip,**skip 不是 pass**,按 `feedback_被触发≠被验证` 必须分开写)。

### 28.5 为什么是**就地改迁移**而不是新增后续迁移(前提已推导,不是照抄任务书)

`up()` 用的是 `CREATE TABLE IF NOT EXISTS`。这意味着**在任何已经把 `zzzz20260918090000` 记进迁移历史的库里,改过的这份文件什么都不会做** —— 不报错、不告警、旧 CHECK 原封不动。所以「就地改」只有在「该迁移在任何环境都没应用过」成立时才是对的策略,这个前提必须推导,不能承接。

- `git cat-file -e origin/main:packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts` ⇒ **ABSENT on origin/main**(`origin/main = 6ea19e2dea6c1e6dc87f5c0d7635ae6fc4f3e1c6`)。
- 生产的部署与迁移只由 `docker-build.yml` 手动 dispatch 从 main 走(见 `feedback_deploy_migration_check` / 基础设施记录)⇒ **没有任何已部署环境可能跑过它**。
- 这与 20260919 探针文档对 #5852 记的 `[DDL: not applied]` 一致。

⇒ 前提成立,就地改是唯一能让生产从不短暂带着错约束的做法。

仓库侧也确认没有**强制**另一条路的守卫:对迁移文件名做全仓 grep(排除 `node_modules`/`.git`),除迁移文件自身外只有 4 处文档引用与 1 处服务层注释,**没有任何 digest/registry/exclude 清单命中**;`MIGRATION_EXCLUDE` 六项里没有它,`SUPERSEDED_LEGACY_SQL_MIGRATIONS` 里没有它,`scripts/ci` 下只有 `lint-sql-migrations.sh`(只扫 `.sql`)与 `validate-migration-exclude.sh`(warn-only 且未接入任何 workflow)。`computePackageProvenancePinSet` 的 s6a 钉不覆盖这些路径 —— 改动前后 `sealed-export-package-provenance.test.cjs` 都 OK,**未重算、未手改任何钉**。

### 28.6 本轮明确**没有**做的事

未合并、未 undraft、未开/动 PR、未动 `origin/main`、未改任何已 ratify 锁文正文(`reviews/` 下的 `*lock*` 文件只读)、未向任何共享/staging/prod 库应用迁移、未删除任何不是本轮创建的 worktree/库/文件。`mapGroupConstraintError` 的 23514 → `GROUP_NAME_UNSUPPORTED` 分支与 `NONBLANK_CHECK_CONSTRAINTS` 里的 `atg_name_nonblank` 成员**保留未删**(与第一版候选同样的理由:删它是一次未经 owner 确认的映射面收窄);该分支的中文 message 现在只对两个 `org_id` 成员准确,**如实披露、不改写** —— 那句话被本文件的 `toContain` 断言冻结成了响应体合同,改它是合同裁决,不是候选该单方面做的事。

---

## 29. 勘误 3 候选 —— 第 2 轮修复(2026-09-20,仍待 owner 确认)

**状态先于证据:勘误 3 依旧是 CANDIDATE / PROPOSED,未 ratify、未授权、未合并、未 undraft、未向任何共享/staging/prod 库应用迁移。** 本节的一切都是**技术验证**,不构成 ratify、合并或迁移应用的许可。全部真库证据来自本轮自建的一次性库 `metasheet2_namerule_r2_20260920`(owner 角色 `ms2testbed`,`rolsuper=f`),用完即 `dropdb`。

修的是 `impl-gate-A-slice1-name-rule-candidate-round1-20260920.md` 的 **1 P2 + 7 P3**(该报告对 head `68fb0e2968e7f67fb0b9623273f372788562a883` 判 NEEDS-FIX)。

### 29.0 两层结构的重新划分(这是本轮的设计变化,请 owner 一并裁)

第 1 轮门审的 P2-1 不是「谓词写错了」,而是**候选写下的话比它做到的事大**:应用层是 DB 裁剪集的**镜像**,而两个集合都不含的码位两层都不拦。镜像永远补不上这个洞 —— 被镜像的东西本身就没有它。所以本轮把两层的**职责**重新划分:

- **(a) 应用层 = 主规则(primary)**。不再是镜像。名字必须含至少一个**可见字符**,否则 400 `GROUP_NAME_REQUIRED`(**错误码沿用既有,不新造**)。
- **(b) DB 层 = 防线(defence-in-depth)**。谓词**成员集逐字保留** owner 提案的十个码位(**不扩枚举** —— 扩它属于再一次勘误,不是实现者能单方面做的事),但把「任何空白或纯不可见名都 400」的**全称断言**改写为「**枚举集 + 明示残留**」:直连 DB 绕过应用层时,U+00AD / U+180E / U+2800 / U+3164 / U+034F / U+FE0F / U+115F 等**仍然可以入库**,真库用例以 `RESIDUE` 命名**正向断言**这一点,不假装它们被拒。

### 29.1 ⚠️ 主会话给的谓词 `/[\p{L}\p{N}\p{P}\p{S}]/u` 单独用**不够** —— 实测,不是推断

任务书点名用 `/[\p{L}\p{N}\p{P}\p{S}]/u` 判定「可见字符」。落笔前先对门审点名的七个码位求值,结果是**其中三个带着可见的 general category**:

```
$ node -e '...\p{gc=...} 探针...'
U+00AD match_LNPS= false cats= C,Cf
U+180E match_LNPS= false cats= C,Cf
U+2800 match_LNPS= true  cats= S,So      ← BRAILLE PATTERN BLANK 是 So
U+3164 match_LNPS= true  cats= L,Lo      ← HANGUL FILLER 是 Lo
U+034F match_LNPS= false cats= M,Mn
U+FE0F match_LNPS= false cats= M,Mn
U+115F match_LNPS= true  cats= L,Lo      ← HANGUL CHOSEONG FILLER 是 Lo
```

⇒ **照字面实现会让 7 个里的 3 个继续 201 入库**,而任务书同时要求「7 个码点各加一条应用层 400 用例」—— 两条要求互斥。这条冲突有**行为级证据**,不是读文档读出来的:见 §29.6 的 **M-2**(把谓词换成裸 `/[\p{L}\p{N}\p{P}\p{S}]/u`,U+2800 / U+3164 / U+115F 三行立刻变回 `201 CREATED`)。

**落地取舍(请 owner 连同勘误一并裁)**:保留 `\p{L}\p{N}\p{P}\p{S}` 作为正向主类,再**排除两件东西**:

1. `\p{Default_Ignorable_Code_Point}` —— Unicode **自己的属性**,不是本文件维护的清单,覆盖 U+00AD / U+180E / U+034F / U+FE0F / U+3164 / U+115F / U+1160 / U+061C / U+2065 / 变体选择符与 tag 区;
2. **U+2800** —— 它**不是** default-ignorable,是本谓词里**唯一一个显式例外**。

**残留写成残留,不写成闭合**:除 U+2800 外,任何「general category 属 L/N/P/S 但在某些字体下渲染为空白」的码位仍会被接受。本规则**不声称**对「一切不可见」闭合;它声称拒绝 (i) JS `\s` 全集、(ii) DB 裁剪集、(iii) 每一个 default-ignorable 码位、(iv) 只由 Mark/Control/Separator 构成的名字、(v) U+2800 —— 每一条都有经生产路由的断言。

> **⚠️ 失效标记(第 2 轮门审 P3-2 / 第 3 轮修复,求值而非作废整节)。** 上一句的**前半**(谓词拒绝这五类)**仍然成立**,由构造保证:(iii) 是写在模式里的 Unicode 属性,(iv) 由「必须落在 L/N/P/S」直接推出。**失效的是最后一个分句**「每一条都有经生产路由的断言」——(iii)(iv) 是无穷类,任何套件都不可能逐一断言。本节其余判据(两条排除项、残留写法、M-2 证据)**不受影响,仍然 OPERATIVE**。套件实际经生产路由提交并观察到 400 的码点清单、以及为两条排除项各自造的见证用例,见 §30.3。

### 29.2 应用层规则(`ApprovalTemplateGroupService.ts`)

| 部分 | 内容 | 位置 |
|---|---|---|
| (1) 边缘裁剪(**装饰性**) | `String.prototype.trim` 的集合(JS `\s`)∪ `U+200B/200C/200D/2060` ∪ `U+00AD/180E/034F/2800/3164/115F/1160`。仍是 DB 裁剪集的**严格超集**,所以本函数返回的任何名字**按构造**满足 CHECK。**故意不裁**变体选择符 U+FE00–U+FE0F:裁了会把尾部 emoji 的呈现改写(`'报销☺️'` → `'报销☺'`);它们由 (2) 拒绝 | `ApprovalTemplateGroupService.ts` `NAME_EDGE_TRIM_CLASS` / `NAME_EDGE_TRIM_PATTERN`(**第 3 轮改实现不改集合**:符号现为 `NAME_EDGE_TRIM_CODE_POINTS` + `trimNameEdges` 线性扫描,`NAME_EDGE_TRIM_CLASS` 只作为被扫描比对的**规格**保留;成员集逐个码点等价,见 §30.2) |
| (2) 可见字符要求(**承重**) | 裁剪后必须含至少一个字符,**既**在 `\p{L}\p{N}\p{P}\p{S}`,**又**不在 `\p{Default_Ignorable_Code_Point}` 且不是 `U+2800`。否则 400 `GROUP_NAME_REQUIRED` | `NAME_INVISIBLE_CLASS` / `NAME_VISIBLE_CHAR_PATTERN` |
| (3) 长度上限 | `GROUP_NAME_MAX_LENGTH = 255`,按**码点**计(与 PG `char_length` 同口径),在任何 DB 往返**之前**判;超限 400 `GROUP_NAME_TOO_LONG`,`details` 带 `maxLength` / `actualLength`。**⚠️ 第 3 轮修复改了两处**:① 计数不再用 `[...s].length`(会为每个码点分配一个数组元素),改成 `countCodePoints` 的索引循环;② 这个闸**移到了裁剪与可见字符判定之前**,读的是**提交值**而不是裁剪后的值 —— 这是一条行为变化,见 §30.2 | `GROUP_NAME_MAX_LENGTH` / `countCodePoints` / `requireName` |

**255 是怎么来的(P3-1 的「读列定义」在这里落空,必须说清)**:任务书说「读迁移里列定义决定字符数上限」——**该列是 `text`,没有长度上限可读**。所以这个上限是**应用层的候选决定**,用两条可核事实**推导**而不是发明:
1. **仓内先例**:人工输入的显示名在本仓的惯例是 `varchar(255)`(`roles.name` / `permissions.name` / `views.name` …,`20250924190000_create_rbac_tables.ts:10` 等);
2. **数量级安全**:255 码点最多 1020 UTF-8 字节,`uq_atg_org_name_active` 的 btree 索引元组上限是 2704 字节,余出约 1.6 KB 给 `org_id` 与元组开销。

**残留,明示**:btree 上限本身没动。**直连 SQL** 仍可撞 `54000`(用例里有正向断言);`org_id` 是 `req.authenticatedTenantId`、从不由调用方提供,所以经路由不可达。**锁 §2 没有长度条款,这是一条新增**,与勘误 3 一并等 owner 的话。

### 29.3 DB 层(迁移)

- **成员集逐字未扩**:仍是十个码位。
- **拼写改了一处(P3-6)**:`E' \t\r\n'` → `' ' || chr(9) || chr(13) || chr(10)`。原因:PG 在 DDL 解析期就把转义串求值,`pg_get_constraintdef()` 读回来的约束定义里含**真实 0x09/0x0d/0x0a 字节**;任何对 `pg_dump` 产物做 CRLF→LF 归一的流水线会**静默地把 CR 从裁剪集里删掉**,而约束名与错误码分毫不变。现场证据:

```
$ psql -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='atg_name_nonblank'"
CHECK ((btrim(name, (((((((((' '::text || chr(9)) || chr(13)) || chr(10)) || chr(12288)) || chr(8203)) || chr(8204)) || chr(8205)) || chr(8288)) || chr(65279))) <> ''::text))

$ psql -tAc "SELECT encode(convert_to(pg_get_constraintdef(oid),'UTF8'),'hex') FROM pg_constraint WHERE conname='atg_name_nonblank'"
434845434b202828627472696d286e616d652c20282828282828282827202 73a3a74657874207c7c2063687228392929207c7c206368722831332929
207c7c206368722831302929207c7c206368722831323238382929207c7c2063687228383230332929207c7c2063687228383230342929207c7c2063
687228383230352929207c7c2063687228383238382929207c7c20636872283635323739292929203c3e2027273a3a746578742929

$ psql -tAc "SELECT 'has_CR='||(position(chr(13) in pg_get_constraintdef(oid))>0)::text
             ||' has_LF='||(position(chr(10) in pg_get_constraintdef(oid))>0)::text
             ||' has_TAB='||(position(chr(9) in pg_get_constraintdef(oid))>0)::text
             FROM pg_constraint WHERE conname='atg_name_nonblank'"
has_CR=false has_LF=false has_TAB=false
```

  hex 里 `2720 273a3a` = `' '::`,其后全是 `chr(NN)` 函数调用,**没有任何 0x0d / 0x0a / 0x09 裸字节**。集合等价另有行为证明:十个成员逐个喂给 `btrim(v, <新拼写>)` 全部得空串,可见名 `hr` 不受影响(§29.6 的 M-4 进一步证明每个成员单独承重)。

- **披露改写**:迁移注释里的「KNOWN AND DISCLOSED GAP」段不再自述为「非空白保证」,改成**枚举集 + 两族明示残留**(空白族补上 U+000B/U+000C;另加 Cf/filler 族七个),并写明**闭合这两族的是应用层,不是这条 CHECK**。

### 29.4 逐条处置(门审 1 P2 + 7 P3)

| 门审条目 | 处置 | 落点(符号定位;行号随编辑漂移) |
|---|---|---|
| **P2-1** 五处全称断言为假,7 码位经真实 HTTP 201 入库 | **已修**:应用层新增可见字符要求(7/7 现在 400);五处断言全部改写为受限断言 + 明示残留;新增**两个**真库用例把两半都钉成行为 | 服务层 `requireName` / `NAME_VISIBLE_CHAR_PATTERN`;迁移 `atg_name_nonblank` 上方注释块;验证 MD §28.2(就地改写)+ 本节;测试 `…ROUND-2 FIX (gate round 1 P2-1)…` 与 `…RESIDUE…` 两个 `it` |
| **P3-1** 超长名 → 54000 → 不透明 500 | **已修**:应用层 255 码点上限,400 `GROUP_NAME_TOO_LONG`;新增用例含边界(255 ⇒ 201 / 256 ⇒ 400)、btree 溢出名(⇒ 400 而非 500)、rename 腿、裁剪先于计数;直连 SQL 的 54000 作为 **RESIDUE 正向断言**保留 | 服务层 `GROUP_NAME_MAX_LENGTH` / `requireName`;测试 `…(gate round 1 P3-1)…` |
| **P3-2** 披露清单漏 U+000B / U+000C | **已修** | 迁移注释 `(a)` 族;验证 MD §28.2「已披露缺口」段 |
| **P3-3** 「32/32 全绿」实为 30 passed / 2 skipped | **已修**(就地改正,并写明 skip≠pass 的理由) | 验证 MD §28.4 末句 |
| **P3-4** `GROUP_NAME_UNSUPPORTED` 文案不适用 + 免修理由经核为假 | **已修**:删掉「被 `toContain` 冻结」这条假理由(我自己重跑 `grep -rn "只接受可打印 ASCII" packages apps` ⇒ **唯一命中就是那行源码本身**,无任何测试断言它),并把 message 改成对三个成员**都准确**的表述;**错误码不动**(改码才是公开合同变更) | 服务层 `mapGroupConstraintError` 的 23514 分支 |
| **P3-5** 内部零宽与唯一索引视觉同形 | **不修,写进披露**(owner 已接受为选项 (i) 的设计后果);本轮补上同族的内部 U+2800 | 服务层 `requireName` 文档注释 |
| **P3-6** 约束定义含真实 CR/LF 字节 | **已修**,hex 证明见 §29.3 | 迁移谓词 |
| **P3-7** 裁剪集十个成员只有 U+200B 被隔离证过 | **已修**:新增**表驱动**用例,十个成员各自 (i) 单独作整名 ⇒ 直连 DB 23514、(ii) 单独夹在两个中文之间 ⇒ 经路由 201 且**逐字节存回**;两半都用**收集成数组再一次比较**的写法,红的时候整张矩阵都打印出来 | 测试 `…(gate round 1 P3-7): EACH of the ten trim-set members…` |

### 29.5 真库数字(现场执行,**不是抄的**)

```
$ createdb -U postgres -O ms2testbed metasheet2_namerule_r2_20260920      # owner rolsuper=f
$ DATABASE_URL=postgresql://ms2testbed:***@localhost:5432/metasheet2_namerule_r2_20260920 npx tsx src/db/migrate.ts
  ... zzzz20260918090000_create_approval_template_groups was executed successfully ...
  EXIT=0      # 非超级角色全量迁移,零 42501

$ npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=dot
 Test Files  2 passed (2)
      Tests  34 passed | 2 skipped (36)
```

**34 passed / 2 skipped(36)**,不是「36/36 全绿」—— 那 2 条是 `itIfExpectDb` 的 anti-skip-green 哨兵(未置 `EXPECT_DB` 时是 skip)。上一轮同一份清单是 **30 passed / 2 skipped(32)**,本轮 **+4 个 `it`**。

> **⚠️ 失效标记(第 3 轮修复)。** 这三个数字是 head `88bc46486eb99870d91237e2b9aeca53aa9d58d4` 的现场输出,**对那个 head 仍然为真**,但**不再描述当前树** —— 第 3 轮加了 3 个 `it`。当前数字在 §30.4,**以那里的现场输出为准**;本行不手改数字(`feedback_record_fix_rounds_only_delete_never_handwrite_numbers`)。同理下面 `CI=true pnpm … test` 的全量数字也按 §30.4 重读。

```
$ pnpm --filter @metasheet/core-backend type-check
  EXIT=0

$ CI=true pnpm --filter @metasheet/core-backend test
 Test Files  947 passed | 175 skipped (1122)
      Tests  15091 passed | 1609 skipped (16700)
  EXIT=0
```

(第一次跑全量时有 46 个**文件级**红,全部是 `Cannot find module 'zod'` 之类 —— 我的 `node_modules` 软链没覆盖 `plugins/*`;补齐后 **EXIT=0、零断言失败**。这是环境缺口,不是候选引入的红,两次输出都留着。)

PG:`PostgreSQL 15.17 (Homebrew, aarch64)`。

### 29.6 mutation 台账(`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`,四条全部自跑)

| 探针 | 改动 | 观察到的红(**原文**) | 数字 | 还原 |
|---|---|---|---|---|
| **M-1**(删掉应用层 (a)) | `requireName` 退回第 1 轮的纯镜像:裁剪类退回 `\s\u200B\u200C\u200D\u2060`,删掉 `!NAME_VISIBLE_CHAR_PATTERN.test(trimmed)` | `AssertionError: expected [ …(9) ] to deeply equal [ …(9) ]`,数组 diff **九行全变**:`"U+00AD SOFT HYPHEN -> 400 GROUP_NAME_REQUIRED"` → `"… -> 201 CREATED"`,U+180E / U+2800 / U+3164 / U+034F / U+FE0F / U+115F / U+2800×3 / (U+3164+U+00AD) 同 | `1 failed / 24 passed / 1 skipped (26)` | `cmp` IDENTICAL |
| **M-2**(把谓词换成任务书字面的裸类) | `NAME_VISIBLE_CHAR_PATTERN` → `/[\p{L}\p{N}\p{P}\p{S}]/u`,裁剪类同时退回第 1 轮 | 同一条用例红,但数组 diff **只有三族变**:`U+2800 BRAILLE PATTERN BLANK -> 201 CREATED`、`U+3164 HANGUL FILLER -> 201 CREATED`、`U+115F HANGUL CHOSEONG FILLER -> 201 CREATED`(以及派生的 `U+2800 x3`、`U+3164 + U+00AD`);U+00AD / U+180E / U+034F / U+FE0F **仍是 400** | `1 failed / 24 passed / 1 skipped (26)` | `cmp` IDENTICAL |
| **M-3**(删长度闸) | 删掉 `requireName` 里的 `GROUP_NAME_MAX_LENGTH` 分支 | `AssertionError: 256 code points is OVER the cap: expected 201 to be 400`(`- 400 / + 201`) | `1 failed / 24 passed / 1 skipped (26)` | `cmp` IDENTICAL |
| **M-4**(per-member 判别力,P3-7) | 迁移裁剪集里**只删** `chr(65279)`(U+FEFF),其余九个保留;`dropdb`+`createdb`+重跑迁移 | 两条红,归因由构造确定:① 表驱动用例的数组 diff **只有一行变** `"U+FEFF BYTE ORDER MARK -> 23514 atg_name_nonblank"` → `"U+FEFF BYTE ORDER MARK -> ACCEPTED"`,另外九个成员原样;② 原有用例 3 的 `promise resolved "Result{ command: 'INSERT', …}" instead of rejecting` | `2 failed / 23 passed / 1 skipped (26)` | `cmp` IDENTICAL |

> **⚠️ 失效标记(第 3 轮修复,逐条求值)。** 上表四条 mutation 的**结论**(可见字符守卫承重 / 任务书字面谓词不够 / 长度闸承重 / 裁剪集 per-member 承重)**全部仍然成立**;失效的只是 **M-1 与 M-2 那两个数组 diff 的行数**:NEITHER-SET 夹具在第 3 轮从 9 行增加到 11 行(新增两行见证用例),所以「九行全变」「(9)」这些**计数**是 head `88bc46486e` 的事实,不是当前树的。当前树下同形 mutation 的逐行观测在 §30.5(MUT1-R3 / MUT-R3-D / MUT-R3-E),现场跑出,不是把旧数字加二。M-3 / M-4 的观测不受影响。

**M-2 是本轮最重要的一条**:它是「任务书点名的谓词单独用不够」这句话的**行为级证据**,不是我读 Unicode 表得出的论断。**M-4 的边界**:它隔离验证的是十个成员中的 **U+FEFF** 这一个;但与第 1 轮不同,表驱动用例现在给**每个成员**都带了独立的、会出现在数组 diff 里的标签,所以「哪个成员不再承重」是**可读的事实**而不是推断 —— 第 1 轮 P3-7 的残留(其余九个没有独立断言)由此关闭,剩下的只是「没有对每个成员各跑一次 mutation」这一条成本残留。

每条 mutation 都先用 `diff` 证明文件**真的变了**(不是无效 mutation),红的**原因**逐条核过(不是 setup 失败),还原后 `cmp` 对服务与迁移两个文件均**逐字节一致**。

### 29.7 本轮明确**没有**做的事

未合并、未 undraft、未开/动 PR、未动 `origin/main`、未改任何已 ratify 锁文正文(`reviews/` 下 `*lock*` 只读)、未向 `metasheet_v2` / `metasheet_test` / `metasheet_testbed_main` / `metasheet_testbed_todo_20260920` 或任何共享·staging·prod 库应用迁移、未删除任何不是本轮创建的 worktree/库/文件、未扩 owner 提案的十码位枚举集、未新造 `GROUP_NAME_UNSUPPORTED` 之外的既有码的替代品(新增的只有 `GROUP_NAME_TOO_LONG`,任务书点名)。`mapGroupConstraintError` 的 23514 分支与 `NONBLANK_CHECK_CONSTRAINTS` 的 `atg_name_nonblank` 成员**保留未删**(删它仍是未经 owner 确认的映射面收窄)。

**本轮另外三条主动披露(不修,写出来供门审取用)**

1. **`incompressibleName()` 用 `Math.random()`** —— P3-1 用例里那条「直连 SQL 仍可撞 `54000`」的 RESIDUE 断言,输入是**随机**的 2000 个 CJK 码点(≈6000 字节,对 btree 的 2704 字节上限有约 2.2 倍余量,pglz 压不动随机数据)。余量足够宽,不预期 flake;但**万一 CI 红,那一次的输入是不可复现的**。本轮不改这个 helper(固定种子会让「不可压缩」这件事变成写死的假设);记为已知的非确定性输入。
2. **`GROUP_NAME_TOO_LONG` 是一个新的公开错误码,本分支上零前端消费方** —— 本轮 diff **0 个 `apps/web` 文件**,前端不会对它做任何特殊呈现(落到通用错误提示)。与 §27.9 的前瞻披露同形:这是**前瞻耦合点**,不是被漏掉的合同新增,A-2/A-3 接前端时需要一并处理。
3. **本次补跑 §14.1 之后,代码文件逐字节未动** —— `git diff <上一提交> -- packages/` 为空,即 §29.5 的真库/tsc/全量数字仍然对应当前树;本次补跑只改了 `docs/`。

**给 owner 的三个待裁点**:
1. **可见字符规则的两条排除项**(`Default_Ignorable_Code_Point` + U+2800)—— 这是候选在 owner 提案之外**新增的判据**,请连同勘误 3 一并裁;
2. **255 码点长度上限** —— 锁 §2 无此条款,是新增;
3. **`GROUP_NAME_UNSUPPORTED` 的 message 改写** —— 错误码未动,但响应体文案变了。


---

## 30. 勘误 3 候选 —— 第 3 轮修复(2026-09-20,仍待 owner 确认)

**状态先于证据:勘误 3 依旧是 CANDIDATE / PROPOSED,未 ratify、未授权、未合并、未 undraft、未向任何共享/staging/prod 库应用迁移。** 本节全部是**技术验证**,不构成 ratify、合并或迁移应用的许可。真库证据来自本轮自建的一次性库 `metasheet2_namerule_r3_20260920`(owner 角色 `ms2testbed`,`rolsuper=false`),用完即 `dropdb`。

修的是 `impl-gate-A-slice1-name-rule-candidate-round2-20260920.md` 的 **1 P1 + 3 P3**(该报告对 head `88bc46486eb99870d91237e2b9aeca53aa9d58d4` 判 CHANGES-REQUESTED)。该报告同时确认第 1 轮的 1 P2 + 7 P3 **全部真闭合**,本轮未动那八条的实现。

### 30.1 P1-1 —— 边缘裁剪的复杂度

第 2 轮把边缘裁剪写成 `new RegExp('^[类]+|[类]+$', 'gu')`。**带量词、锚在 `$` 的重复**在不匹配时要从每一个起始位置重试一遍,所以对「可见字符 + 长裁剪类串 + 可见字符」这种形状,代价随**提交长度的平方**增长;而第 2 轮新增的 255 长度闸写在 `.replace(正则)` **之后**,对它零缓解。`express.json` 的 10mb 上限意味着这个长度由调用方决定。

本轮的修法是**两个彼此独立的改动,每一个单独就能闭合它**——两个都留下,作为纵深:

1. **裁剪改成线性扫描**。`trimNameEdges` 用索引循环从两端向内走,成员判定是 `Set.has`;没有模式,也就无从回溯。**成员集逐字未变**:`NAME_EDGE_TRIM_CLASS`(第 2 轮那个字符类)作为**规格**保留下来,新增用例把它与实现用的码点集合在 **0..0x10FFFF 全区间逐个码点**比对,`mismatches = []`。所以「集合没变,变的只是写法」是机械核过的事实,不是注释里的声明。
2. **长度闸移到最前面**。`requireName` 现在先用 `countCodePoints`(索引循环,不用 `[...s].length` —— 那会为每个码点分配一个数组元素)数**提交值**的码点数,超过 `GROUP_NAME_MAX_LENGTH` 直接 400 `GROUP_NAME_TOO_LONG`;裁剪与可见字符判定都排在它后面,于是这两步永远不会走超过 255 个码点。`details.actualLength` 仍是**完整的真实计数**(不短路),不是「至少 N」。

`NAME_VISIBLE_CHAR_PATTERN` 本身**未改**:它是「负向前瞻 + 单个字符类」,没有任何量词,引擎每次尝试前进一个位置,不存在可回溯的重复。

### 30.2 这带来一条行为变化(单独列为 owner 待裁点,不并进第 2 轮那条)

第 2 轮的上限量的是**裁剪后**的名字,所以 `U+200B U+3000 + <255 可见> + U+FEFF U+2060`(提交 259 码点、裁剪后 255)是**被接受**的。第 3 轮的上限量**提交值**,同一个输入现在是 400 `GROUP_NAME_TOO_LONG`,`details.actualLength = 259`。

**裁剪本身没有被跳过**,这一点单独钉住:一个 251 码点的名字先建好,再用同样四个填充字符包起来提交(255 码点,**在上限之内**)——它照旧被裁回 251,撞上同名唯一索引,得到 **409 `GROUP_NAME_TAKEN`**。两个方向都在用例里,因为只留一个的话,「上限挪了位置」和「裁剪不跑了」在观测上是同一个样子。

第 2 轮用例里那句「cap is applied to the TRIMMED name / 409」的断言**已被本轮改写**,改写处写明了它被取代。这条行为变化是 owner 的 **待裁点 4**(见 §30.7)。

### 30.3 P3-1 / P3-2 / P3-3 —— 三条全称句改枚举 + 两条排除项各自补见证

| 门审条目 | 处置 | 落点 |
|---|---|---|
| **P3-1**(迁移注释「400s **every** value in (a) and (b) … for **every one of them**」) | **已修**:改成「**实测清单 + 推导残留**」。经生产路由提交并观测到 400 的:(a) 族只有 U+00A0;(b) 族全部七个 + 四个由它们拼出的混合名;本 CHECK 自己十个成员里的 U+0020 / TAB / LF / U+3000 / U+200B / U+FEFF。(a) 族其余的 U+000B / U+000C / U+1680 / U+2000–U+200A / U+202F / U+205F / U+2028 / U+2029 **写明是由谓词推出、不是测出来的**(它们都在 `String.prototype.trim` 的集合里,而裁剪集含该集合 —— 这层包含关系本身由 §30.1 的全区间扫描用例机械断言) | 迁移 `atg_name_nonblank` 上方注释块 |
| **P3-2**(服务层「(iii) **every** default-ignorable …(iv) **every** M/C/Z-only name … **each of which** the real-DB suite asserts」) | **已修**:把「谓词按构造闭合这五类」和「套件实际断言了哪些」**拆成两句**,后者列出真实提交过的码点清单,并明说 (iii)(iv) 是无穷类、任何套件都不可能逐一断言 | 服务层 `requireName` 文档注释 (2) |
| **P3-3**(NIT:9 行 NEITHER-SET 里 8 行其实由边缘裁剪兜住,不是被称作「load-bearing half」的可见字符规则) | **已修,并且不止改注释**:注释按实测重写(哪一行由哪一半关掉);同时补了**两行**新夹具,把 owner 那两条待裁的排除项各自变成有见证的断言 —— 第 2 轮之后 U+2800 / U+3164 / U+115F 都进了裁剪集,任何**边缘位置**的实例都被 (1) 先吃掉,于是 (iii) 和 (v) 两条排除项在套件里**只有探针证据、没有用例证据**。新两行把被排除的码点夹在两个 U+FE0F 之间(U+FE0F 不在裁剪集,边缘不动),让它留在**内部**走到 (2):`U+FE0F U+3164 U+FE0F` 见证 `Default_Ignorable_Code_Point`,`U+FE0F U+2800 U+FE0F` 见证 U+2800 例外。§30.5 的 MUT-R3-D / MUT-R3-E 证明**各自只翻自己那一行** | 测试文件 `NEITHER_SET_INVISIBLES` 夹具及其上方注释 |

> **U+FE0F 的准确说法(顺带纠正第 2 轮的一处含糊)**:U+FE0F 之所以被 (2) 拒,是因为它的 general category 是 `Mn`,**正类 `\p{L}\p{N}\p{P}\p{S}` 就已经不收它**,并不是靠 default-ignorable 那条排除项。这也是为什么单独一行 U+FE0F **不能**给排除项 (iii) 当见证,必须另造上面那两行。

### 30.4 真库与全量数字(现场执行,不是抄的)

```
$ createdb -U postgres -O ms2testbed metasheet2_namerule_r3_20260920     # rolsuper=false
$ DATABASE_URL=postgres://ms2testbed@localhost:5432/metasheet2_namerule_r3_20260920 pnpm run db:migrate
  ... zzzz20260918090000_create_approval_template_groups was executed successfully ...
  EXIT=0        # 非超级角色全量迁移,零 42501

# CI 那份清单、CI 那个调用形状(workflow 不设 EXPECT_DB)
$ npx vitest run --config vitest.integration.config.ts \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=dot
 Test Files  2 passed (2)
      Tests  37 passed | 2 skipped (39)

# 同一份清单,置 EXPECT_DB=1(哨兵不再 skip)
      Tests  39 passed (39)

$ pnpm --filter @metasheet/core-backend type-check
  EXIT=0

$ CI=true pnpm --filter @metasheet/core-backend test
 Test Files  947 passed | 175 skipped (1122)
      Tests  15091 passed | 1609 skipped (16700)
  EXIT=0

$ node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
  sealed-export-package-provenance.test.cjs OK      EXIT=0

$ scripts/dev/atg-verification-recount.sh
  负向状态断言 22 / 配对 error.code 断言 22 / 差额 0
```

**37 passed / 2 skipped(39)**:那 2 条仍是 `itIfExpectDb` 的 anti-skip-green 哨兵(CI 的真库步骤不设 `EXPECT_DB`)。上一轮同一份清单是 **34 passed / 2 skipped(36)**,本轮 **+3 个 `it`**(全区间等价扫描 / 直接计时 / 经路由计时)。

**本轮新增的路由计时用例写成普通 `it`,不是 `itIfExpectDb`** —— 这是故意的:`plugin-tests.yml` 的真库步骤里 `grep -c EXPECT_DB` = 0,写成 `itIfExpectDb` 会在 CI 里 skip-green。本文件的 DB 闸是 `describeIfDatabase`,`itIfExpectDb` 只留给那条哨兵。

`plugin-tests.yml` 本轮**未改**,所以 s6a 的 `pluginTestsWorkflow` 钉**不需要重算**(上式 EXIT=0 即为核对)。

PG:`PostgreSQL 15.17 (Homebrew) on aarch64-apple-darwin25.2.0`。

### 30.5 mutation 台账(`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`,六条全部自跑)

两个改动**各自单独就能闭合 P1-1**,所以单靠一条路由计时用例分不清哪一半承重 —— 那正是「无效 mutation 看起来像没用的测试」的形状。因此每一半各有自己的 oracle,下表逐条写明**谁在什么改动下变红**:

| 探针 | 改动 | 观察到的红(**原文**) | 数字 | 还原 |
|---|---|---|---|---|
| **MUT-R3-A**(计时断言的负控:证明这条断言真的在看钟) | 直接计时用例的 `CEILING_MS` 200 → 0.0001 | `AssertionError: visible + run + visible took 0.1ms, ceiling 0.0001ms (timings: visible + run + visible -> 0.1ms): expected 0.05316699999957564 to be less than 0.0001` | `1 failed / 28 skipped (29)` | `cmp` IDENTICAL |
| **MUT-R3-B**(只退回裁剪,保留长度闸) | `trimNameEdges` 改回 `value.replace(new RegExp('^[类]+|[类]+$','gu'), '')` | `AssertionError: visible + run + visible took 16860.6ms, ceiling 200ms (timings: visible + run + visible -> 16860.6ms): expected 16860.559332999997 to be less than 200` | `1 failed / 2 passed / 26 skipped (29)` —— **路由计时用例仍绿**(长度闸单独就够),全区间等价用例仍绿 | `cmp` IDENTICAL |
| **MUT-R3-C**(把 `requireName` 整体换回第 2 轮实现:正则裁剪在前、长度闸在后) | 见改动名 | ① 路由计时:`AssertionError: visible + run + visible took 16533.3ms through the route, ceiling 2000ms: expected 16533.322792 to be less than 2000`;② 顺序:`AssertionError: the cap reads the SUBMITTED value, not the trimmed one: expected 409 to be 400` | ① `1 failed / 2 passed / 26 skipped (29)`(直接计时用例仍绿 —— `trimNameEdges` 没被改);② `1 failed / 28 skipped (29)` | `cmp` IDENTICAL |
| **MUT1-R3**(第 2 轮 MUT1 在新夹具上重跑) | `requireName`:`if (!trimmed || !NAME_VISIBLE_CHAR_PATTERN.test(trimmed))` → `if (!trimmed)` | `expected [ …(11) ] to deeply equal [ …(11) ]`,**11 行里恰好 3 行翻**:`U+FE0F VARIATION SELECTOR-16`、`U+FE0F + INTERNAL U+3164 + U+FE0F`、`U+FE0F + INTERNAL U+2800 + U+FE0F` 三行 `-> 201 CREATED`;其余 8 行仍 400 | `1 failed / 28 skipped (29)` | `cmp` IDENTICAL |
| **MUT-R3-D**(删 (iii) 排除项) | `NAME_INVISIBLE_CLASS` 去掉 `\p{Default_Ignorable_Code_Point}` | 数组 diff **只有一行变**:`U+FE0F + INTERNAL U+3164 + U+FE0F … -> 201 CREATED` | `1 failed / 28 skipped (29)` | `cmp` IDENTICAL |
| **MUT-R3-E**(删 (v) 例外) | `NAME_INVISIBLE_CLASS` 去掉 `\u2800` | 数组 diff **只有一行变**:`U+FE0F + INTERNAL U+2800 + U+FE0F … -> 201 CREATED` | `1 failed / 28 skipped (29)` | `cmp` IDENTICAL |

**MUT1-R3 的读法**:它证明可见字符判定**承重**(有行变红),同时把 P3-3 那句话变成实测 —— 11 行里只有 3 行真的走到 (2),其余 8 行是被边缘裁剪关掉的。**MUT-R3-B 与 MUT-R3-C 合起来**才是「两半各自承重」的证据:B 只红直接计时用例、C 只红路由计时与顺序用例。

每条 mutation 都先 `grep` 确认文件**真的变了**(不是无效 mutation),红的**原因**逐条核过(不是 setup 失败),还原后 `cmp` 对服务与测试两个文件均**逐字节一致**。

### 30.6 对 §29 的逐句求值(失效标记贴在那句话上,不作废整节)

| §29 的句子 | 第 3 轮求值 | 处置 |
|---|---|---|
| §29.1 末「(i)–(v) …**每一条都有经生产路由的断言**」 | 前半(谓词拒绝这五类)**仍真**;最后一个分句**假**(无穷类) | 已在原处贴失效标记 + 指向 §30.3 |
| §29.2 (1) 行的位置列 `NAME_EDGE_TRIM_PATTERN` | 符号**已变**(`NAME_EDGE_TRIM_CODE_POINTS` + `trimNameEdges`);**集合未变** | 已在原处标注 |
| §29.2 (3) 行「按码点计(`[...s].length`)…在任何 DB 往返之前判」 | 「在 DB 往返之前」**仍真**;`[...s].length` 与「裁剪后再判」**已变** | 已在原处标注 |
| §29.5「34 passed / 2 skipped(36)」及全量数字 | 对 head `88bc46486e` **仍真**,不描述当前树 | 已标注,当前数字见 §30.4,**未手改旧数字** |
| §29.6 M-1 / M-2 的「九行全变 / (9)」 | **结论仍真**,**计数已过期**(夹具 9 → 11 行) | 已标注,当前逐行观测见 §30.5 |
| §29.6 M-3 / M-4、§29.3 全部、§29.4 的 P2-1/P3-1..P3-7 处置 | **未受影响,仍 OPERATIVE** | 不动 |

### 30.7 本轮明确**没有**做的事,与给 owner 的**四**个待裁点

未合并、未 undraft、未开/动 PR、未动 `origin/main`、未改任何已 ratify 锁文正文、未向 `metasheet_v2` / `metasheet_test` / `metasheet_testbed_*` 或任何共享·staging·prod 库应用迁移、未删除任何不是本轮创建的 worktree/库/文件、未扩 owner 提案的十码位枚举集、未改任何错误码、未改 `plugin-tests.yml`、未改 `NAME_VISIBLE_CHAR_PATTERN` 的谓词本体。

**待裁点(前三条是第 2 轮的,原样结转;第四条是本轮新增)**:

1. **可见字符规则的两条排除项**(`Default_Ignorable_Code_Point` + U+2800)—— owner 提案之外的新增判据。**本轮变化**:这两条现在各有一个**会变红的见证用例**(§30.5 的 MUT-R3-D / MUT-R3-E),不再只有探针证据。
2. **255 码点长度上限** —— 锁 §2 无此条款,是新增。
3. **`GROUP_NAME_UNSUPPORTED` 的 message 改写** —— 错误码未动,响应体文案变了。
4. **【新】长度闸的度量对象从「裁剪后」改成「提交值」** —— 这是一条**行为变化**,不是纯内部重构:提交 259 码点、裁剪后 255 的名字,第 2 轮接受(或按同名 409),第 3 轮是 400 `GROUP_NAME_TOO_LONG`。它随第 2 项(上限本身)一起裁,但**单独列出**,因为即便 owner 接受 255 这个数,「量哪个值」仍是一个独立的取舍。
