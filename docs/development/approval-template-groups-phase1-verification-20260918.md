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
| A | 同 org 同名活跃冲突 409;跨 org 可同名;归档后可重用 | `approval-template-groups-lifecycle.db.test.ts:237` | `A: same-org active-name conflict is 409; a different org may reuse the name; an archived name may be reused` | `plugin-tests.yml` → `approval-real-db-integration`(`test (20.x)`,required) |
| A′ | 跨 org 不覆盖 | 同文件 `:264` | `A′: cross-org does not overlap — the SAME global template goes into DIFFERENT groups for DIFFERENT orgs` | 同上 |
| A″ | 跨 org 挂接 404;复合 FK 兜底 23503 | 同文件 `:312` | `A″: cross-org link is 404 (org-scoped row-lock SELECT); the composite FK is the last-resort DB guard` | 同上 |
| A‴ | org 只取 `authenticatedTenantId`(三格) | 同文件 `:344` | `A‴: org comes ONLY from req.authenticatedTenantId — body/query orgId rejected, forged header ignored, missing tenant fails closed` | 同上 |
| B | 归档是一个事务;并发挂接见证已归档态 | 同文件 `:392` | `B: archive is one transaction (members unlinked, never deleted); a concurrent link blocks then sees the archived state` | 同上 |
| B′ | 解除关联不回落 category;从未关联仍显示 | 同文件 `:437` | `B′: unlinked-from-group templates show as ungrouped, never falling back to category; never-linked templates still show category` | 同上(**§13.5 披露**:本用例只做 DB 谓词层面演示,不经任何服务/路由代码) |
| B″ | 首次/重新挂接同一 upsert;并发首次挂接双成功 | 同文件 `:594` | `B″: first-link and re-link share ONE atomic upsert; two concurrent FIRST links to different groups both succeed, later commit wins` | 同上 |
| C | `section=` 分节 | **不在本切片** — 锁文 §6「期 3」;`section` 查询参数在分期 1 不存在(A‴ 测试文件 `:386-387` 自陈) | — | A-4 |
| D | category 后备(仅从未关联) | **不在本切片** — 同上;其底层 `NOT EXISTS` 判据已由 B′ 间接验证(见 §13.5),但 D 本身的展示/筛选端点属分期 3 | — | A-4 |
| E(前半:序号 + COMMIT 映射) | 并发建组 n+1/n+2;COMMIT 期 DEFERRABLE 映射 500;正控(裸 SQL 撞 `atg_sort_unique`/`atg_sort_archived_pair`);RR-默认池前提哨兵 | `approval-template-groups-serialization.db.test.ts:162,195,222,234,279,301` | `sentinel: the service pool REALLY runs repeatable-read default — a bare-BEGIN generic transaction is RR`(harness 非空转前提);`E positive control: two same-org active groups committing the SAME sort_order hit 23505 on atg_sort_unique at COMMIT, not at INSERT`;`E positive control: archiving without clearing sort_order hits the paired CHECK (atg_sort_archived_pair) immediately`;`E: two concurrent creates via the PRODUCTION path get sort_order n+1/n+2 …`;`E: negative control — an unrelated advisory key never blocks a concurrent create …`;`E: COMMIT-time (not statement-time) DEFERRABLE violation on the production create path maps to 500 GROUP_SORT_CONFLICT` | 同上 |
| E(后半:并发重排) | 并发重排终态是其中一方完整排列 | **不在本切片** — 重排端点是分期 3(§6) | — | A-4 |
| F | 授权面:写端点 admin guard,读端点 `approvals:read` | 同 lifecycle 文件 `:480` | `F: authorization — write endpoints require approvalTemplateAdminGuard, the list endpoint requires approvals:read; denial writes zero rows` | `approval-real-db-integration` |
| G | 解档:干净态/同名活跃阻塞/改名冲入阻塞 | 同文件 `:525` | `G: unarchive — clean case; blocked by another ACTIVE group with the same name; blocked by a group renamed into that name` | 同上 |
| H | 解除幂等 | 同文件 `:561` | `H: unlink is idempotent — never-linked, already-unlinked, and active-link cases` | 同上 |
| I | I6 爆炸半径零(本地机械 diff) | 非 vitest 用例——本地命令(§6,已用现场 HEAD 重跑,见 §13.1) | — | 本地,非 CI |
| I′ | I6 行为门(自动化 actor 未变) | 同 lifecycle 文件 `describe:634`,`(a):677`,`(b):705` | `(a) MAIN sees exactly {dept-scoped, role-scoped}, never the unseen template; CONTROL sees nothing (positive control)`;`(b) all three actor constructors return EXACTLY the ApprovalTemplateVisibilityActor key set at runtime (no stray optional field)` | `approval-real-db-integration` |
| J | 多 org 成员脱困(403 + 前端选择器 + 未知 `section=` 400) | **后端半**:同 A‴ 用例第 (iii) 格(`:377-384`,A‴ 测试自陈「This is also J's only backend-observable leg」);**前端半 + 未知 token 400**:不在本切片(见设计 MD §1.3,归 A-2/A-4) | `approval-real-db-integration`(后端半) |
| K | 改名/建组/解档持 L0,阻塞可证伪 | `approval-template-groups-serialization.db.test.ts:329,351,373` | `K: an L0-only holder (no L1 row lock) stalls a concurrent CREATE in the same org`;`K: an L0-only holder stalls a concurrent RENAME of an existing group in the same org`;`K: an L0-only holder stalls a concurrent UNARCHIVE of an archived group in the same org` | 同上 |

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
关键行(逐字段摘录,完整用例名见 §12 表,全部 ✓):
```
✓ … sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)
✓ … A: same-org active-name conflict is 409; …
✓ … A′: cross-org does not overlap …
✓ … A″: cross-org link is 404 …
✓ … A‴: org comes ONLY from req.authenticatedTenantId …
✓ … B: archive is one transaction …
✓ … B′: unlinked-from-group templates show as ungrouped …
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
| 三线共用 #4 | 错误码不得降级成裸 HTTP 状态 | **修复轮 1(2026-09-18,见 §18)重算,替换本行原「全部 10 个码逐条都有断言」的过强全称句——gate `impl-gate-A-slice1-round1-20260918.md` P2-4 机械计数(4 码零命中)证伪了原句,原句已撤回。** 机械核对(现场 grep,非目测):两文件负例状态断言(`.status).toBe(4xx\|500)`)共 **15** 处(`grep -noE "\.status\)\.toBe\((40[0-9]\|500)\)"` 两文件合计),配对的 `error.code).toBe(...)` 断言共 **13** 处——**逐行核对差额的 2 处**是 F 用例(`lifecycle.db.test.ts:492,497`)对非管理员/非读者的两个 403;这两处**不是**本锁引入的专用码之一,命中的是仓内既有、本锁未改动的共享中间件 `rbacGuardAny`(`src/rbac/rbac.ts:172-175`),该中间件对全仓所有路由(含 `/api/approval-templates` 自身)一律返回裸 `{ error: 'Insufficient permissions' }`(无 `code` 字段)——不在补充清单 #4「本锁错误码」的适用范围内。**逐码核对**(命令 `grep -oE "error\.code\)\.toBe\('<CODE>'\)" 两文件 \| wc -l` 逐码跑,§3.3 设计 MD 的 10 个码全表):`GROUP_NOT_FOUND` 1、`GROUP_ARCHIVED` 1、`GROUP_NAME_TAKEN` 3、`GROUP_NOT_ARCHIVED` **1**(修复轮 1 新增,此前 **0**——§18)、`GROUP_SORT_CONFLICT` 1、`ORG_ID_NOT_ACCEPTED` 2、`SESSION_ORG_REQUIRED` 1、`GROUP_NAME_REQUIRED` **1**(修复轮 1 新增,此前 **0**)、`APPROVAL_GROUP_ID_REQUIRED` **1**(修复轮 1 新增,此前 **0**)、`APPROVAL_ACTOR_REQUIRED` **0**(仍无断言——`resolveApprovalActorId` 只在 `authenticate` 中间件已放行之后才被调用,触发它要求一个已验签但 `user.id`/`userId`/`sub` 三者皆缺的 token,本文件的 `tok()` helper 经 `/api/auth/dev-token` 铸造,不产出这种 token;记为「无断言,理由:本测试 harness 内不可达」,不当作遗漏補)。**10 码中 9 码有 `error.code` 断言、1 码(`APPROVAL_ACTOR_REQUIRED`)harness 内不可达而无断言。** mutation 台账(§15/§18)每条红也均以「专用码不等」或「状态不等」精确报告,未见任何一条只查裸状态码就断言通过。 |
| lane A #5 | J/C 的「未知 `section=` ⇒ 400」挪分期 3 请示 | 已在设计 MD §1.2/§6 与 A‴ 测试注释(`:386-387`)双重记录,owner 尚未回应,不阻塞本切片 |
| lane A #6 | 「1 落地」求值 = Draft PR 过门审 | 已按此定义推进(目标文档亦如此记录),本 MD 不重复裁决 |
| lane A #7 | 前端 spec 位置 `apps/web/tests/` | 不适用——本切片零前端改动(§13.6),留给 A-2 核对 |

## 15. Mutation 台账(每条:备份 → 改 → 跑 → 还原 → cmp;全部在 `metasheet2_lock_a` 上现场执行)

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
| 9 | A″(a):挂接 SELECT 去掉 org 谓词 | `ApprovalTemplateGroupService.ts:358` | `expected 500 to be 201`(bind 参数数量与占位符不匹配报错,而非「跨 org 200 泄露」) | **RED,机制见 §15.4** |
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
| 19c | E(3)-c:真正的「无响应」机制 —— 删**路由 handler 自己的** try/catch(`routes/approvals.ts:1103,1113-1115`) | `routes/approvals.ts` | `Unhandled Rejection: ServiceError: Group sort order conflict …`;`Test timed out in 20000ms` | **RED,且是唯一真正复现「无响应/超时」的改动点**,见 §15.6 |

### 15.1 发现:G 的显式同名复核是「惯性冗余」,只有与 A 共享的 fallback 分支才是唯一防线

第一次按锁文字面(只删 `ApprovalTemplateGroupService.ts:311-317`)得到的是**惰性(inert)结果**:G 测试仍然全绿。根因是 `unarchiveApprovalTemplateGroup` 最终的 `UPDATE` 语句本身会撞 `uq_atg_org_name_active`(立即部分唯一索引),而 `mapGroupConstraintError` 把这个 23505 映射回**同一个** 409 `GROUP_NAME_TAKEN`——`ApprovalTemplateGroupService.ts:34-38` 的文件头注释已自陈这一点(「confirmed by mutation-testing this block out — no observable change」),本次现场复现验证了该注释所写属实。
真正让 G 落红的是**复合 mutation**(同时删 `:311-317` **且** 禁用 `:137` 的 `uq_atg_org_name_active` 分支)——而**仅**禁用 `:137`(`:311-317` 保留)对 G **单独测不出**(G 走的是自己的显式 `ServiceError` 抛出路径,`mapGroupConstraintError` 首行 `if (error instanceof ServiceError) return error` 直接放行,不经过 `:137` 分支);但**仅**禁用 `:137` 对 **A** 单独测得出红(A 的建组路径没有显式预检查,完全依赖 `:137` 这条分支)。
**结论**:锁文 G 行命名的那条「去掉同名复核」mutation,在本实现下不是判别性的——真正的判别性 mutation 是**共享的** `mapGroupConstraintError:137` 分支移除,它同时是 A 与 G(复合态)的证据来源。这不是缺陷,是与 commit `236f9dac8`(「correct two inert mutation claims in group real-DB suites」)同一族的、已被架构自身文档化的现象;记入此处是让门审看到**台账里的红**而非只信任源码注释里的断言(记忆:「源码文本断言≠行为断言」)。

### 15.2 B′:无可改的应用代码路径 —— BLOCKED-with-reason

B′ 用例(`lifecycle.db.test.ts:437-479`)的核心「mutation」是测试**自己内联的两条原始 SQL**(`NOT EXISTS(...)` 谓词 vs 被拒绝的 `group_id IS NULL` 谓词),两条查询都直接写在 `it()` 内,不经过任何 `ApprovalTemplateGroupService.ts` 或 `routes/approvals.ts` 的函数——因为 I2′ 定义的「后备显示判定」目前**没有任何服务/路由代码实现它**:能消费这个判据的中心页列表端点是 §6 分期 3(A-4)的 `section=` 端点,分期 1 尚未存在。
因此,「备份→改→跑→还原→cmp」这套流程在 B′ 这一行**没有目标可改**——不存在一个当前 HEAD 上的 `.ts` 文件包含「用 `group_id IS NULL` 判定后备」这行逻辑可以被 mutate。B′ 测试当前的形态是对**将来消费方必须遵守的不变量**的一次 DB 级机械论证,而不是对已交付代码的行为门。
**判定:BLOCKED-with-reason**——非因为验证失败或跳过,而是因为锁文 B′/D 行命名的 mutation 对象在本切片尚不存在于应用代码里;A-4 落地 `section=` 端点时,必须对**那个端点**重做这一行的 mutation 台账,不能援引本节的 B′ 记录为「已 mutation-tested」的证据。

### 15.3 A′:真实 DDL mutation 与测试自带替身的机制分歧

`lifecycle.db.test.ts:288-309` 里 A′ 用例自带一段「shape-proof mutation surrogate」——在**会话级 TEMP TABLE**(`ON COMMIT DROP`,从不碰真表)上模拟单列 PK 会导致「B 的挂接覆盖 A」。这段本身不是对真表/真服务代码的 mutation,是自包含的演示。
本次额外对**真实**`approval_template_group_links` 表做了 DDL mutation(`DROP CONSTRAINT approval_template_group_links_pkey` → `ADD CONSTRAINT … PRIMARY KEY (template_id)`),重跑 A′ 用例的**真实端点断言**(`linkA`/`linkB` 两次 `httpReq`)。结果不是锁文预言的「静默覆盖」,而是应用代码里 `ON CONFLICT (org_id, template_id)` 的仲裁索引不存在,触发 `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`,`linkA` 直接 500——比「静默覆盖」更早、更响亮地失败。
**结论**:A′ 行在**真实**代码路径上依然是可 mutation-discriminate 的(红,`expected 500 to be 201`),但红的**机制**与锁文文本描述的「覆盖」不同——是 `ON CONFLICT` 仲裁索引缺失,不是运行时的静默数据覆盖。测试自带的 TEMP TABLE 段落论证的是「如果真的允许覆盖会发生什么」,与「如果真的把 PK 改窄会发生什么」是两个不同的反事实,本节把两者都做了并分开记录。

### 15.4 A″(a):参数计数不匹配掩盖了「跨 org 泄露」的语义信号

删除 `ApprovalTemplateGroupService.ts:358` 的 `org_id = $1 AND` 后,SQL 文本里不再引用 `$1`,但调用点仍传入 `[orgId, groupId]` 两个绑定参数——PostgreSQL 在参数数量与占位符不匹配时直接报错,连**同 org 的正控格**（`ok.status` 应为 201)也一并变红。这是一个比「跨 org 静默放行」更早触发的失败信号,但仍然是该行代码改动导致的确定性红,判定为有效 mutation(红),只是记录清楚失败的具体断言点是控制组的 `expect(ok.status).toBe(201)`(`:323`),不是后续的跨 org 断言。

### 15.5 E(1):比锁文预言更早的失败信号

去掉 `createApprovalTemplateGroup` 里的显式 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 后,测试文件自己的头部注释(`:19-25`)预言的红色签名是「COMMIT 撞 23505,最终以 `sort_order` 集合 `{1,2}` 校验失败」这一更细粒度的信号;现场重跑观察到的实际红,是**更早**的 `expect(res.status).toBe(201)` 断言就已经失败(实收 500,`GROUP_SORT_CONFLICT`,说明冲突同样在 COMMIT 期被检测并正确映射,只是比头部注释描述的「悄悄产生重复」更快被拦下)。两者都是该文件同一条 `it()` 块内的断言,红的判定成立,只是记录清楚具体命中哪一句。

### 15.6 E(3):测试文件头部注释描述的「无响应」机制定位有误,现场重新定位

`serialization.db.test.ts:27-33` 的头部注释字面写「delete the try/catch around `transaction(...)` in `createApprovalTemplateGroup`」会导致「the whole route handler's response never resolves」。现场按字面执行(仅删服务层 `ApprovalTemplateGroupService.ts` 里包裹 `transaction(...)` 的 `try/catch`,`routes/approvals.ts` 自己的 `try/catch` 保持不动)得到的是**干净的 500**(`APPROVAL_TEMPLATE_GROUP_CREATE_FAILED`),测试在 20 秒内正常返回并按错误码断言失败——**不是**注释描述的「无响应」。
根因:`routes/approvals.ts:1102-1115` 的路由 handler**自己也有**一层 `try { … } catch (error) { handleApprovalsError(...) }`,与服务层的 `try/catch` 是**两层独立的**捕获,注释只算到了内层。只有把**外层(路由自己的)** `try/catch` 也一并删掉,才复现出「无响应」:现场移除 `routes/approvals.ts:1103` 的 `try {` 与 `:1113-1115` 的 `catch` 块后,重跑观察到 `Unhandled Rejection: ServiceError: Group sort order conflict`(来自 `mapGroupConstraintError` 正确算出的错误,只是无人接住)与 `Test timed out in 20000ms`——这才是锁文/测试注释共同预言的「Express 4 不接 async 拒绝 ⇒ 无响应」现象的真实、唯一复现点。
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
2. **验收 B′ 的 mutation 台账** —— BLOCKED-with-reason,见 §15.2:I2′ 后备判定逻辑当前不存在于任何应用代码路径,无对象可 mutate;A-4 落地 `section=` 端点时须补做。
3. **验收 J 的前端半**(session-org 选择器组件、403 后展示、选定后重试、`run-required-web-tests.sh` 令牌)与**未知 `section=` ⇒ 400** —— 不在本切片,归 A-2/A-4(设计 MD §1.3,补充清单 #5)。
4. **补充清单 #1 的闭世界缺口** —— 未收口(§13.5),`scripts/ops/approval-template-groups-ci-wiring.test.mjs` 新守卫文件留给后续单元或 owner 裁决。
5. **s6a 钉的时效性** —— 仅对本 push 前一刻的 `plugin-tests.yml` 字节成立(§4/§13.4);合并前必须重算,不在本单元范围内。
6. **重排端点(分期 3)的 E 后半判据** —— 代码尚未实现,自然也未验证。
7. **§15.6 揭示的测试文件头部注释机制描述偏差** —— 不属于代码缺陷(测试判定本身仍是有效的红/绿门),但建议后续修订 `serialization.db.test.ts:19-33` 的头部注释,把「哪一层 try/catch 是真正防线」写准确;本次遵守「不改代码」未做这处编辑,留给门审决定是否值得单独一个小改动 PR。
8. **§3.4(设计 MD)记录的实现者裁量**(重复归档复用 `GROUP_ARCHIVED`)—— 未获锁文文本背书,无验收行覆盖,门审需明确认可或要求改动。
9. **§3.5(设计 MD,修复轮 1 新增)记录的实现者裁量**(挂接可见性失败形状复用 `APPROVAL_TEMPLATE_NOT_FOUND`,404 而非发明新码)—— 同 #8,未获锁文文本背书(锁文只 ratify「要校验」,未点名失败码),无独立验收字母覆盖(附属于 I5/§2,不是锁文 §4 表的一行),门审需明确认可或要求改动;可达性披露见 §18.1。

## 18. 修复轮 1(2026-09-18)—— gate `impl-gate-A-slice1-round1-20260918.md` P2-1 / P2-4 收口

被审 head `252d01865`;本轮只动 `packages/core-backend/src/routes/approvals.ts`(+1 处 import、+1 处导出函数、+1 处调用点)与 `packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`(+4 处 import、+4 个新 `it()`、G 用例内 +3 行)——**不改 DDL、不改 `ApprovalTemplateGroupService.ts`、不改 `plugin-tests.yml`/`vitest.config.ts`**(两点接线与 s6a 钉不受影响,两文件仍是同一对既接线的文件,§1/§2/§4 结论不变)。P2-2/P2-3/P2-5/P3-* 本轮未处理,原状见 gate 报告。

### 18.1 P2-1 —— 挂接时按原谓词校验可见(§2 ratified 条款,此前既未实现也未披露)

**实现**(设计 MD §3.5 记录为实现者裁量的两点:落点与失败形状):
- `routes/approvals.ts` 新增导出函数 `isApprovalTemplateVisibleForGroupLink(templateId, actor)`——对 `approval_templates` 跑 `id = $1` 加 `applyTemplateVisibilityFilter`(复用 `ApprovalProductService.ts:4383-4419`,与列表/详情端点同一函数,不是新逻辑)。
- 链接端点(`POST /api/approval-templates/:id/group`,`:1153`)在校验 `groupId` 之后、调用 `linkApprovalTemplateToGroup` 之前调用它;不可见 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(复用 `:897` 同码),零行写入(`linkApprovalTemplateToGroup` 完全不被调用)。

**可达性披露(与设计 MD §3.5 一致,不重复夸大)**:`approvalTemplateAdminGuard` 的人口 ⊆ `isTemplateManager`,而 manager 让 `applyTemplateVisibilityFilter` 短路、不加条件——今天没有 HTTP 可达路径能让这条检查因「看不见该模板」而拒绝;它在生产流量下退化为「模板是否存在」的检查(附带修好了一个既有空白:`mapGroupConstraintError` 未映射 `atgl_template_fk` 的 23503,此前对不存在的模板 id 会 500,现在 404)。真正的可见性判别力只在**直接调用**导出函数时才被验证(两条腿,理由见「判据本身也要被攻击/单一定义防漂移不防定义太窄」两条纪律——纯 HTTP 测试在当前 guard 形状下无法制造一个「过 guard 但非 manager」的反例)。

**两腿测试**(`approval-template-groups-lifecycle.db.test.ts`,新增两个 `it()`,紧接 F 之后):
- `§2(a)`(`:521-552`,含双腿说明的块注释)——谓词直调:手写一个 `isTemplateManager: false` 的 actor(不经 HTTP/guard),对 dept 作用域内的模板返回 `true`、作用域外的返回 `false`、不存在的 `randomUUID()` 返回 `false`;并证明同一 hidden 模板对 `isTemplateManager: true` 的同一 actor 返回 `true`(manager 短路的机制证据,不只是断言)。
- `§2(b)`(`:554-568`)——端点调用点:admin token(guard 内唯一可达的 actor 形状)对一个 `randomUUID()`(不存在)的模板 id 发起挂接 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`,`approval_template_group_links` 零行。

**Mutation 探针(两条,`cp` 备份 → 改 → 单独跑受影响用例 → `cp` 还原 → `cmp` → 全量重跑确认回绿;`/tmp/gateA-fix1-probe-backups/`)**:

| # | 目标 | 改动 | 命令关键结果 | 判定 |
|---|---|---|---|---|
| P2-1-M1 | `isApprovalTemplateVisibleForGroupLink` 内的 `applyTemplateVisibilityFilter` 调用 | 注释掉该行(只留 `id = $1`) | `-t "§2"`:`§2(a)` 红,`expected true to be false`(hidden 模板被判可见) | **RED ✓**——谓词半判别 |
| P2-1-M2 | 链接端点的可见性前置调用块 | 整块删除(不再调用 `isApprovalTemplateVisibleForGroupLink`) | `-t "§2"`:`§2(b)` 红,`expected 500 to be 404`(不存在的模板落到未映射的 `atgl_template_fk` 23503,`handleApprovalsError` 兜底 500) | **RED ✓**——调用点半判别 |

两条探针均单独执行、单独还原:`cmp approvals.ts.orig approvals.ts` 均 `OK`;还原后 `-t "§2"` 重跑均回绿;全文件套件收尾重跑 `Test Files 2 passed (2) / Tests 26 passed (26)`;`git status --porcelain` 在还原后为空。

### 18.2 P2-4 —— 10 个错误码的绝对断言(4 码零命中)+ `GROUP_NOT_ARCHIVED` 零覆盖

**补的三格**(均在 `approval-template-groups-lifecycle.db.test.ts`):
- `GROUP_NOT_ARCHIVED`——在既有 G 用例(`:594-`)开头插入:对刚建的、仍活跃的 `g1` 直接调 `/unarchive` ⇒ 409 `GROUP_NOT_ARCHIVED`(`:598-602`),再继续 G 原有的归档/解档/同名冲突流程,不改动 G 原有断言。
- `GROUP_NAME_REQUIRED` / `APPROVAL_GROUP_ID_REQUIRED`——新增独立用例 `request-shape codes: ...`(`:507-519`,紧接 F 之后、`§2` 系列之前):建组传全空白 `name` ⇒ 400 `GROUP_NAME_REQUIRED`;链接端点传空 body(无 `groupId`)⇒ 400 `APPROVAL_GROUP_ID_REQUIRED`。
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
