# 审批表单分组 Phase 1(切片 A-1 后端)— 验证 MD

- 锁文:`approval-form-group-entity-design-lock-draft-20260916.md`(**v2.13 RATIFIED 2026-09-18**)
- 设计 MD(同批交付):`approval-template-groups-phase1-design-20260918.md`
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A-1 后端`)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` #1–#7
- 私有真库:`metasheet2_lock_a`(§11 起的全部重跑均在此库上现场执行,非抄旧结果)
- **§1–§10 是 u3(CI 接线 + s6a 重钉)子单元的原始记录,原样保留,不重写**——其行号锚点基线 `85ddd2926`、worktree HEAD (`dba46e7c1`/`fbcf62caa`/`a2254950a`) 与 `origin/main`(`23dfdf417`)均为**该子单元当时的现场值**,时效性披露见 §9/§10.5;§11 起是本切片(A-1)收口时的**独立现场重跑**,覆盖锁文验收表的全部行(含 u3 未覆盖的 A/A′/A″/A‴/B/B′/B″/F/G/H/I′/J/K 与完整 mutation 台账),使用**当前** HEAD/merge-base,不沿用 §1–§10 的旧值
- 环境:node `v25.9.0`,python3 `Python 3.9.6`
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

## 12. 锁文验收表 → 测试文件 + 用例名 + lane(全表,含分期 3 的「不在本切片」行)

| 验收行 | 判据摘要 | 测试文件 | 用例名(逐字) | lane |
|---|---|---|---|---|
| A | 同 org 同名活跃冲突 409;跨 org 可同名;归档后可重用 | `approval-template-groups-lifecycle.db.test.ts:242`(原 `:237`,修复轮 1 后 +5) | `A: same-org active-name conflict is 409; a different org may reuse the name; an archived name may be reused` | `plugin-tests.yml` → `approval-real-db-integration`(`test (20.x)`,required) |
| A′ | 跨 org 不覆盖 | 同文件 `:269`(原 `:264` +5) | `A′: cross-org does not overlap — the SAME global template goes into DIFFERENT groups for DIFFERENT orgs` | 同上 |
| A″ | 跨 org 挂接 404;复合 FK 兜底 23503 | 同文件 `:317`(原 `:312` +5) | `A″: cross-org link is 404 (org-scoped row-lock SELECT); the composite FK is the last-resort DB guard` | 同上 |
| A‴ | org 只取 `authenticatedTenantId`(三格) | 同文件 `:349`(原 `:344` +5) | `A‴: org comes ONLY from req.authenticatedTenantId — body/query orgId rejected, forged header ignored, missing tenant fails closed` | 同上 |
| B | 归档是一个事务;并发挂接见证已归档态 | 同文件 `:397`(原 `:392` +5) | `B: archive is one transaction (members unlinked, never deleted); a concurrent link blocks then sees the archived state` | 同上 |
| B′ | 解除关联不回落 category;从未关联仍显示 | 同文件 `:447`(原 `:437`,修复轮 1 +5、修复轮 3 再 +5——round 3 在 `it(` 上方插入了 5 行 NOTE 注释,见 §20.2) | `B′ (DB-level predicate only, no display consumer until A-4): "no link row exists" — not "group_id IS NULL" — is the correct never-grouped predicate`(修复轮 3 收窄前的原名见 §13.2 逐字记录 / §20.2) | 同上(**§13.5 披露**:本用例只做 DB 谓词层面演示,不经任何服务/路由代码) |
| B″ | 首次/重新挂接同一 upsert;并发首次挂接双成功 | 同文件 `:713`(原 `:669`,修复轮 1 后 +75,修复轮 4 在 F 内插入约 37 行使其再顺移 +44 到 `:713`——已在修复轮 5/§22 现场重算,见 P3-2) | `B″: first-link and re-link share ONE atomic upsert; two concurrent FIRST links to different groups both succeed, later commit wins` | 同上 |
| C | `section=` 分节 | **不在本切片** — 锁文 §6「期 3」;`section` 查询参数在分期 1 不存在(A‴ 测试文件 `:391-392`(原 `:386-387` +5)自陈) | — | A-4 |
| D | category 后备(仅从未关联) | **不在本切片** — 同上;其底层 `NOT EXISTS` 判据已由 B′ 间接验证(见 §13.5),但 D 本身的展示/筛选端点属分期 3 | — | A-4 |
| E(前半:序号 + COMMIT 映射) | 并发建组 n+1/n+2;COMMIT 期 DEFERRABLE 映射 500;正控(裸 SQL 撞 `atg_sort_unique`/`atg_sort_archived_pair`);RR-默认池前提哨兵 | `approval-template-groups-serialization.db.test.ts:161,194,221,233,278,300`(原 `:162,195,222,234,279,301`,修复轮 3 把头部注释从 6 行改成 5 行后全表 off-by-one,已在修复轮 5/§22 现场 `grep -n "^  it("` 重算,见 P3-2) | `sentinel: the service pool REALLY runs repeatable-read default — a bare-BEGIN generic transaction is RR`(harness 非空转前提);`E positive control: two same-org active groups committing the SAME sort_order hit 23505 on atg_sort_unique at COMMIT, not at INSERT`;`E positive control: archiving without clearing sort_order hits the paired CHECK (atg_sort_archived_pair) immediately`;`E: two concurrent creates via the PRODUCTION path get sort_order n+1/n+2 …`;`E: negative control — an unrelated advisory key never blocks a concurrent create …`;`E: COMMIT-time (not statement-time) DEFERRABLE violation on the production create path maps to 500 GROUP_SORT_CONFLICT` | 同上 |
| E(后半:并发重排) | 并发重排终态是其中一方完整排列 | **不在本切片** — 重排端点是分期 3(§6) | — | A-4 |
| F | 授权面:写端点 admin guard,读端点 `approvals:read` | 同 lifecycle 文件 `:504`(原 `:485`,修复轮 2/3 在其之前的 B′ 用例上方累计插入注释使其顺移 +19,已在修复轮 5/§22 现场 `grep -n` 重算,见 P3-2) | `F: authorization — write endpoints require approvalTemplateAdminGuard, the list endpoint requires approvals:read; denial writes zero rows` | `approval-real-db-integration` |
| G | 解档:干净态/同名活跃阻塞/改名冲入阻塞 | 同文件 `:638`(原 `:594`,修复轮 1 后 +69,此后修复轮 4 在 F 内插入约 37 行使其再顺移 +44——已在修复轮 5/§22 现场重算,见 P3-2) | `G: unarchive — clean case; blocked by another ACTIVE group with the same name; blocked by a group renamed into that name` | 同上 |
| H | 解除幂等 | 同文件 `:680`(原 `:636`,同上顺移 +44,已重算) | `H: unlink is idempotent — never-linked, already-unlinked, and active-link cases` | 同上 |
| I | I6 爆炸半径零(本地机械 diff) | 非 vitest 用例——本地命令(§6,已用现场 HEAD 重跑,见 §13.1) | — | 本地,非 CI |
| I′ | I6 行为门(自动化 actor 未变) | 同 lifecycle 文件 `describe:753`,`(a):796`,`(b):824`(原 `:709`/`:752`/`:780`,同上顺移 +44,已在修复轮 5/§22 重算) | `(a) MAIN sees exactly {dept-scoped, role-scoped}, never the unseen template; CONTROL sees nothing (positive control)`;`(b) all three actor constructors return EXACTLY the ApprovalTemplateVisibilityActor key set at runtime (no stray optional field)` | `approval-real-db-integration` |
| J | 多 org 成员脱困(403 + 前端选择器 + 未知 `section=` 400) | **后端半**:同 A‴ 用例第 (iii) 格(`:382-389`,原 `:377-384` +5,A‴ 测试自陈「This is also J's only backend-observable leg」);**前端半 + 未知 token 400**:不在本切片(见设计 MD §1.3,归 A-2/A-4) | `approval-real-db-integration`(后端半) |
| K | 改名/建组/解档持 L0,阻塞可证伪 | `approval-template-groups-serialization.db.test.ts:328,350,372`(原 `:329,351,373`,同 E 前半的 off-by-one,已重算) | `K: an L0-only holder (no L1 row lock) stalls a concurrent CREATE in the same org`;`K: an L0-only holder stalls a concurrent RENAME of an existing group in the same org`;`K: an L0-only holder stalls a concurrent UNARCHIVE of an archived group in the same org` | 同上 |

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
| 三线共用 #4 | 错误码不得降级成裸 HTTP 状态 | **修复轮 1(2026-09-18,见 §18)重算,替换本行原「全部 10 个码逐条都有断言」的过强全称句——gate `impl-gate-A-slice1-round1-20260918.md` P2-4 机械计数(4 码零命中)证伪了原句,原句已撤回。修复轮 5(2026-09-18,见 §22)对本行第二次重算——gate `impl-gate-A-slice1-round2-20260918.md` P2-1 机械计数(在修复轮 4 新增两条裸 403 之后,本行未同步重算)证伪了下方 15/13/2/`:492,497` 那组数字,现按修复轮 4 之后的 HEAD 重算替换。** 机械核对(现场 grep,非目测):两文件负例状态断言(`.status).toBe(4xx\|500)`)共 **17** 处(`grep -noE "\.status\)\.toBe\((40[0-9]\|500)\)" approval-template-groups-lifecycle.db.test.ts approval-template-groups-serialization.db.test.ts \| wc -l`),配对的 `error.code).toBe(...)` 断言共 **13** 处(同一命令把 `\.status\)\.toBe` 换成 `error\.code\)\.toBe\('[A-Z_]+'\)`)——**逐行核对差额的 4 处**(`grep -n "toBe(403)" approval-template-groups-lifecycle.db.test.ts`)是 F 用例(`lifecycle.db.test.ts:511,516,528,535`,分别对应 `createAsNobody`/`listAsNobody`/`archiveAsNobody`/`linkAsNobody`)对非管理员的四个 403(第 5 个 `toBe(403)` 在 `:388`,是 A‴(iii) 的 `noTenantRes`,与 `SESSION_ORG_REQUIRED` 配对,不计入差额);这四处**不是**本锁引入的专用码之一,命中的是仓内既有、本锁未改动的共享中间件 `rbacGuardAny`(`src/rbac/rbac.ts:172-175`),该中间件对全仓所有路由(含 `/api/approval-templates` 自身)一律返回裸 `{ error: 'Insufficient permissions' }`(无 `code` 字段)——不在补充清单 #4「本锁错误码」的适用范围内。**逐码核对**(命令 `grep -oE "error\.code\)\.toBe\('<CODE>'\)" 两文件 \| wc -l` 逐码跑,§3.3 设计 MD 的 10 个码全表):`GROUP_NOT_FOUND` 1、`GROUP_ARCHIVED` 1、`GROUP_NAME_TAKEN` 3、`GROUP_NOT_ARCHIVED` **1**(修复轮 1 新增,此前 **0**——§18)、`GROUP_SORT_CONFLICT` 1、`ORG_ID_NOT_ACCEPTED` 2、`SESSION_ORG_REQUIRED` 1、`GROUP_NAME_REQUIRED` **1**(修复轮 1 新增,此前 **0**)、`APPROVAL_GROUP_ID_REQUIRED` **1**(修复轮 1 新增,此前 **0**)、`APPROVAL_ACTOR_REQUIRED` **0**(仍无断言——`resolveApprovalActorId` 只在 `authenticate` 中间件已放行之后才被调用,触发它要求一个已验签但 `user.id`/`userId`/`sub` 三者皆缺的 token,本文件的 `tok()` helper 经 `/api/auth/dev-token` 铸造,不产出这种 token;记为「无断言,理由:本测试 harness 内不可达」,不当作遗漏補)。**10 码中 9 码有 `error.code` 断言、1 码(`APPROVAL_ACTOR_REQUIRED`)harness 内不可达而无断言。** mutation 台账(§15/§18)每条红也均以「专用码不等」或「状态不等」精确报告,未见任何一条只查裸状态码就断言通过。 |
| lane A #5 | J/C 的「未知 `section=` ⇒ 400」挪分期 3 请示 | 已在设计 MD §1.2/§6 与 A‴ 测试注释(`:391-392`,原 `:386-387` +5)双重记录,owner 尚未回应,不阻塞本切片 |
| lane A #6 | 「1 落地」求值 = Draft PR 过门审 | 已按此定义推进(目标文档亦如此记录),本 MD 不重复裁决 |
| lane A #7 | 前端 spec 位置 `apps/web/tests/` | 不适用——本切片零前端改动(§13.6),留给 A-2 核对 |

## 15. Mutation 台账(每条:备份 → 改 → 跑 → 还原 → cmp;全部在 `metasheet2_lock_a` 上现场执行)

> **行号作用域说明(修复轮 1 追加)**:本节及以下 §16/§17 内所有 `routes/approvals.ts`/`ApprovalTemplateGroupService.ts` file:line 引用,记录的是**当时被 mutate 的那次 HEAD**(`252d01865`,门审报告 `impl-gate-A-slice1-round1-20260918.md` 审的同一 commit)——探针已全部还原,这些行号是「曾在此处做过什么、看到什么」的历史证据,不是「现在去这一行找」的活地图。修复轮 1(§18)在 `routes/approvals.ts` 顶部与内部新增了共 30 行(§3.1 设计 MD 脚注有精确位移表),本节列出的旧行号**未跟随重算**——按需核对时,用本节的函数名/端点路径重新 `grep -n` 现场行号,不要按此处数字直接跳转。§12(锁文验收表 crosswalk)与设计 MD §3.1/§3.2/§3.3/§5 是「活地图」,已在修复轮 1 里重新核对为当前 HEAD;§15/§16/§17 是「历史记录」,不重算。

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

## 18. 修复轮 1(2026-09-18)—— gate `impl-gate-A-slice1-round1-20260918.md` P2-1 / P2-4 收口

被审 head `252d01865`;本轮只动 `packages/core-backend/src/routes/approvals.ts`(+1 处 import、+1 处导出函数、+1 处调用点)与 `packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`(+4 处 import、+4 个新 `it()`、G 用例内 +3 行)——**不改 DDL、不改 `ApprovalTemplateGroupService.ts`、不改 `plugin-tests.yml`/`vitest.config.ts`**(两点接线与 s6a 钉不受影响,两文件仍是同一对既接线的文件,§1/§2/§4 结论不变)。P2-2/P2-3/P2-5/P3-* 本轮未处理,原状见 gate 报告。

### 18.1 P2-1 —— 挂接时按原谓词校验可见(§2 ratified 条款,此前既未实现也未披露)

**实现**(设计 MD §3.5 记录为实现者裁量的两点:落点与失败形状):
- `routes/approvals.ts` 新增导出函数 `isApprovalTemplateVisibleForGroupLink(templateId, actor)`——对 `approval_templates` 跑 `id = $1` 加 `applyTemplateVisibilityFilter`(复用 `ApprovalProductService.ts:4383-4419`,与列表/详情端点同一函数,不是新逻辑)。
- 链接端点(`POST /api/approval-templates/:id/group`,`:1153`)在校验 `groupId` 之后、调用 `linkApprovalTemplateToGroup` 之前调用它;不可见 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(复用 `:897` 同码),零行写入(`linkApprovalTemplateToGroup` 完全不被调用)。

**可达性披露(与设计 MD §3.5 一致,不重复夸大)**:`approvalTemplateAdminGuard` 的人口 ⊆ `isTemplateManager`,而 manager 让 `applyTemplateVisibilityFilter` 短路、不加条件——今天没有 HTTP 可达路径能让这条检查因「看不见该模板」而拒绝;它在生产流量下退化为「模板是否存在」的检查(附带修好了一个既有空白:`mapGroupConstraintError` 未映射 `atgl_template_fk` 的 23503,此前对不存在的模板 id 会 500,现在 404)。真正的可见性判别力只在**直接调用**导出函数时才被验证(两条腿,理由见「判据本身也要被攻击/单一定义防漂移不防定义太窄」两条纪律——纯 HTTP 测试在当前 guard 形状下无法制造一个「过 guard 但非 manager」的反例)。

**两腿测试**(`approval-template-groups-lifecycle.db.test.ts`,新增两个 `it()`,紧接 F 之后;**行号已在修复轮 5/§22 按修复轮 4 之后的现场 HEAD 重算,原 `:521-552`/`:554-568` 是本轮(修复轮 1)落地时的行号,后续三轮插入代码使其漂移,详见 P3-2/§22**):
- `§2(a)`(`:558-589`,含双腿说明的块注释)——谓词直调:手写一个 `isTemplateManager: false` 的 actor(不经 HTTP/guard),对 dept 作用域内的模板返回 `true`、作用域外的返回 `false`、不存在的 `randomUUID()` 返回 `false`;并证明同一 hidden 模板对 `isTemplateManager: true` 的同一 actor 返回 `true`(manager 短路的机制证据,不只是断言)。
- `§2(b)`(`:591-605`)——端点调用点:admin token(guard 内唯一可达的 actor 形状)对一个 `randomUUID()`(不存在)的模板 id 发起挂接 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`,`approval_template_group_links` 零行。

**Mutation 探针(两条,`cp` 备份 → 改 → 单独跑受影响用例 → `cp` 还原 → `cmp` → 全量重跑确认回绿;`/tmp/gateA-fix1-probe-backups/`)**:

| # | 目标 | 改动 | 命令关键结果 | 判定 |
|---|---|---|---|---|
| P2-1-M1 | `isApprovalTemplateVisibleForGroupLink` 内的 `applyTemplateVisibilityFilter` 调用 | 注释掉该行(只留 `id = $1`) | `-t "§2"`:`§2(a)` 红,`expected true to be false`(hidden 模板被判可见) | **RED ✓**——谓词半判别 |
| P2-1-M2 | 链接端点的可见性前置调用块 | 整块删除(不再调用 `isApprovalTemplateVisibleForGroupLink`) | `-t "§2"`:`§2(b)` 红,`expected 500 to be 404`(不存在的模板落到未映射的 `atgl_template_fk` 23503,`handleApprovalsError` 兜底 500) | **RED ✓**——调用点半判别 |

两条探针均单独执行、单独还原:`cmp approvals.ts.orig approvals.ts` 均 `OK`;还原后 `-t "§2"` 重跑均回绿;全文件套件收尾重跑 `Test Files 2 passed (2) / Tests 26 passed (26)`;`git status --porcelain` 在还原后为空。

### 18.2 P2-4 —— 10 个错误码的绝对断言(4 码零命中)+ `GROUP_NOT_ARCHIVED` 零覆盖

**补的三格**(均在 `approval-template-groups-lifecycle.db.test.ts`;**行号已在修复轮 5/§22 按修复轮 4 之后的现场 HEAD 重算**,原 `:594-`/`:598-602`/`:507-519` 是本轮落地时的行号):
- `GROUP_NOT_ARCHIVED`——在既有 G 用例(`:638-`)开头插入:对刚建的、仍活跃的 `g1` 直接调 `/unarchive` ⇒ 409 `GROUP_NOT_ARCHIVED`(`:643-647`),再继续 G 原有的归档/解档/同名冲突流程,不改动 G 原有断言。
- `GROUP_NAME_REQUIRED` / `APPROVAL_GROUP_ID_REQUIRED`——新增独立用例 `request-shape codes: ...`(`:544-556`,紧接 F 之后、`§2` 系列之前):建组传全空白 `name` ⇒ 400 `GROUP_NAME_REQUIRED`;链接端点传空 body(无 `groupId`)⇒ 400 `APPROVAL_GROUP_ID_REQUIRED`。
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

**测试文件注释同步**(`lifecycle.db.test.ts:607-637`,G 用例正上方的整段块注释;原记录 `:591-` 是本轮落地时的行号,已在修复轮 5/§22 按修复轮 4 之后的现场 HEAD 重算,见 P3-2):删除被门审明确驳回的一句——「this is a lock-vs-implementation contract gap……since strengthening it would mean inventing a new mutation not in the lock」(门审原话:「不必发明锁文之外的新 mutation」,该句断言的前提是假的)。替换为:指出这是实现选择而非锁文缺口,第一层是在共享分支之上的额外添加,删除第一层即可恢复单条判别力且不触碰锁文文本要求任何东西,并指向验证 MD §15.1/§17 #10 的 owner 裁决点。**这是纯注释改动**,零行为代码变化。

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

被审 head:`5b3d6310c`(修复轮 4 之后;第 2 轮门审的被审 head 与此相同)。**本轮是纯文档改动**——只动本文档(`docs/development/approval-template-groups-phase1-verification-20260918.md`)的 §12/§14/§18.1/§18.2/§19.1 五处行号与计数引用,**零 `.ts` 改动、零 DDL、零 `plugin-tests.yml`/`vitest.config.ts` 改动**,不需要 mutation 探针(探针证明的是代码断言的判别力,本轮没有改动任何断言或代码,只改文档里记录的行号/计数,回归确认走的是「套件仍然全绿 + typecheck 仍然 exit 0」,同 §19.1 对纯注释改动的处理方式)。

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

第 2 轮门审的第二条发现:修复轮 4 在 F 用例内插入约 37 行后,F 之后的全部用例(F 自身、request-shape codes、`§2(a)`/`§2(b)`、G、H、B″、I′)整体下移;同时修复轮 3 曾把 E 前半头部注释从 6 行改成 5 行,造成 E/K 两组行号 off-by-one——分支里此前有两个专门的「recompute line citations」提交(`bdfe29974` 对应修复轮 1、`ff993d3ef` 对应修复轮 3),修复轮 4 之后没有第三个,属於已建立的纪律漏了一次。

现场逐条 `grep -n "^\s*it('\|^\s*describe('"` 重新核对(命令与结果):

```
$ grep -n "^\s*it('\|^\s*describe('" tests/integration/approval-template-groups-lifecycle.db.test.ts
242:  it('A: ...     269:  it('A′: ...     317:  it('A″: ...     349:  it('A‴: ...
397:  it('B: ...     447:  it('B′ (DB-level predicate only...     504:  it('F: ...
544:  it('request-shape codes: ...                                569:  it('§2(a): ...
591:  it('§2(b): ...                                               638:  it('G: ...
680:  it('H: ...                                                   713:  it('B″: ...
753:  describe('I′: ...    796:    it('(a) ...    824:    it('(b) ...
$ grep -n "^\s*it('" tests/integration/approval-template-groups-serialization.db.test.ts
161:  it('sentinel: ...   194:  it('E positive control: ... SAME sort_order ...
221:  it('E positive control: ... archiving ...                    233:  it('E: two concurrent creates ...
278:  it('E: negative control ...                                  300:  it('E: COMMIT-time ...
328:  it('K: ... CREATE ...   350:  it('K: ... RENAME ...   372:  it('K: ... UNARCHIVE ...
```

A/A′/A″/A‴/B/B′(在 F 之前)未受影响,行号不变;F/request-shape/§2(a)/§2(b)/G/H/B″/I′(在 F 及其后)与 E 前半/K(off-by-one)全部按上表现场重算的数字改写:

- §12 表:F→`:504`、G→`:638`、H→`:680`、B″→`:713`、I′→`describe:753`/`(a):796`/`(b):824`、E 前半 6 格→`:161,194,221,233,278,300`、K 三格→`:328,350,372`(均已在表格原地写入「原 `:NNN`」+ 变更原因,不是裸替换数字)。
- §18.1:`§2(a)` 块注释+用例体 `:521-552`→`:558-589`;`§2(b)` `:554-568`→`:591-605`。
- §18.2:G 用例内 `GROUP_NOT_ARCHIVED` 插入点 `:594-`/`:598-602`→`:638-`/`:643-647`;request-shape 用例 `:507-519`→`:544-556`。
- §19.1:G 用例正上方整段块注释 `:591-`→`:607-637`。

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

零 skip,26/26 与修复轮 1–4 及本轮之前一致(用例数不变——本轮未新增/删除任何 `it()`);typecheck exit 0;`git status --porcelain` 只有本文档一处改动,`.ts`/DDL/`plugin-tests.yml`/`vitest.config.ts` 均未触碰,s6a 钉不受影响(未改 `plugin-tests.yml`)。

### 22.4 本轮未处理 —— 第 2 轮门审报告剩余条目的处置说明(P3-3/P3-4 待下一轮修复;P3-5/P3-6/NIT 为记录性重确认)

- **P3-3**(serialization 头部 mutation 配方点名一个全仓不存在的函数 `takeOrgLock`,且同一注释块 mutation (3) 的机制记录与 §17 #7 的「本次未编辑该注释」自相矛盾):**未处理,留给下一修复轮**——这是测试文件内的注释改动(不是本文档),按本步「选一到两条」的范围,本轮选择了 P2-1/P3-2 这两条纯文档计数/行号修复,未把 P3-3 一并纳入,不是遗漏,是范围控制。
- **P3-4**(「guard 人口 ⊆ manager」是零 grep 计数的全称断言,承重两件事,今日成立但断言形式不成立):**未处理,留给下一修复轮**——同上,理由同 P3-3,且第 2 轮门审自己已经把这条的反例证伪过程、差集与计数(`approval-templates:*` 全仓授予 0 处)写全了,下一轮的工作是把这些证据抄写进 `routes/approvals.ts:396-399` 的代码注释、设计 MD §3.5、本文档 §18.1,不需要重新调查。
- **P3-5**(结转;`wip` 提交 `f6e8ea2d8`/`93e57198e`/`0d2ed3389` 仍在历史里;squash 需 force-push,超出本轮授权的措辞应改为「本 lane 选择不 force-push」):第 2 轮门审对第 1 轮 §21.3 的 disposition 重新核实后仍判「结转,不代 owner 裁」,并额外指出 PR body 措辞需要改正(不是「因授权限制无法 squash」,而是「本 lane 选择不 force-push」)。**disposition 不变**:本轮 `git log --oneline origin/main..HEAD` 重新确认三个 wip 提交仍在、仍已 push(见下方核对),不 squash、不 force-push;PR body 措辞的改正留到开 Draft PR 时一并处理(本切片当前无 PR 可改)。
- **P3-6**(结转;两个新真库套件仍无 `*-ci-wiring` 守卫):第 2 轮门审重新做了 census(`grep -rl "approval-template-groups" scripts/` 零命中 + 5 个同 step id 守卫 `node --test` 16/16 绿)并维持第 1 轮判定「已披露残留,非阻塞」。**disposition 不变**:本轮不新建守卫,留给需要新建时的独立切片,开 PR 时 body 需点名。
- **NIT**(非 UUID 模板 id 可能让失败点从 404 前移到 500;门审明确「未实测,不作结论」):**记录性,不构成本轮修复项**——门审本身未跑这个用例,只从列类型与语句顺序推断,标注为未验证并交给实现方自行决定是否值得加一格。本轮不加这一格测试:加与不加是设计裁量(是否要把这一格纳入验收范围),不是「断言无判别力」需要修的那类缺陷,补一格属于范围扩张,按硬规矩「修复不得扩范围」,留给 owner/下一次设计复核决定是否要求这一格。

```
$ git log --oneline origin/main..HEAD | grep -E "^[0-9a-f]+ wip:|^f6e8ea2d8|^93e57198e|^0d2ed3389"
f6e8ea2d8 wip: carry step-agent changes forward (to be squashed by the lane)
93e57198e fix(approval): scope group-archive unlink UPDATE to org_id
0d2ed3389 fix(approval): close orgId array bypass; correct stale error-code docstring
```

P3-5 的三个提交现场核对仍在分支历史中,均已 push(`git rev-parse HEAD` = `git rev-parse origin/feat/approval-template-groups-phase1`)。

**本轮小结**:第 2 轮门审的 1 P2(阻塞)+ 5 P3 + 1 NIT 中,P2-1(阻塞项)与 P3-2 本轮完成实际修复;P3-3/P3-4 明确留给下一修复轮(范围控制,非遗漏);P3-5/P3-6/NIT 三条完成「记录性重确认」——disposition 均未变化,已如实写入。gate 报告的 verdict 是「只差 P2-1 一条」DRAFT-READY,本轮已把该条闭合;P3-3/P3-4 不影响 DRAFT-READY 判定(门审原文:两条都是 P3),但仍需下一轮处置才算「全部处理完」。
