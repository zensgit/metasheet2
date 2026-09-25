# 审批表单分组 Phase 1(切片 A-2 前端)— 验证 MD

- 锁文:`approval-form-group-entity-design-lock-draft-20260916.md`(**v2.13 RATIFIED 2026-09-18**)
- 设计 MD(同批交付):`approval-template-groups-phase1-fe-design-20260918.md`
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片「A 分组 / A-2 前端脱困」)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md`(三线共用 #1–#4、lane A #5–#7)
- worktree HEAD(本文档写作起点):`cb6d7fa9f97b02438f0d0f36c8fb955870f9e2e8`;分支 `feat/approval-template-groups-phase1-fe`,堆叠在 `feat/approval-template-groups-phase1`(A-1,尖端 `0144932ac67e80a81f204dd6c6e502d000112276`,与本分支的 merge-base 相同——零漂移)。**抬头 stale 披露(P3 卫生轮,2026-09-19,gate `impl-gate-A2-round1-20260918.md` P3-4)**:门审对象 head 是 `d3097be00`(晚两个 docs-only 提交);本轮又对 A-1 尖端做了一次 rebase(A-1 自身已跑过一轮同名 P3 卫生轮并带入了 `origin/main` 后续提交)并在其上追加了本文档 §12 的卫生修复。§1–§11 的 `file:line` 锚点已在卫生轮对当前 HEAD 复核仍成立;§12 是本轮新增内容,以卫生轮结束时的 HEAD 为准(见 `git log`)。
- 私有真库:`metasheet2_lock_a2`(本文档全新创建,§4 起的迁移重跑均在此库现场执行)——**其角色是一次性 fixture,不是 staging/prod**:创建它、对它跑迁移不构成对锁文「含 DDL 只 Draft、不应用、不合并」约束的违反(该约束管的是把 DDL 应用到共享/生产数据库或合并 PR,不是本地一次性验证库);它承载的迁移链是 **A-1 继承的 DDL**,不是 A-2 自己新增的(A-2 零迁移文件,见 §4.1)。本切片(A-2)自身三份新 spec 全部 mock 网络层、零 DB 依赖(见 §4.2)——这是本文档"现在重跑"这句话对 A-2 实际买到的东西:三份 spec 的活体重跑(§1),不是一条新的 DB 覆盖路径。
- 环境:`node -v` → `v25.9.0`;`pnpm -v` → `10.33.0`

## 1. 锁文验收表 → 测试文件 + 用例名 + lane(全表,含不在本切片的行)

| 验收行 | 判据摘要 | 本切片(A-2)覆盖 | 测试文件 | 用例名(逐字) | lane |
|---|---|---|---|---|---|
| **J(前端半)** | 403 `SESSION_ORG_REQUIRED` → 展示选择器 → 选定后重试 → 201;单 org 成员从不见到选择器 | **是,本切片核心** | `apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts` | `single-org member: list loads clean on mount, the selector is never shown, and no session-org call is ever made`;`a 403 SESSION_ORG_REQUIRED on create shows the switcher; selecting an org retries the SAME create and gets 201`;`a 403 SESSION_ORG_REQUIRED on the initial mount-time list load shows the switcher; selecting an org retries the SAME list load` | `run-required-web-tests.sh` → `web-tests`(job `web-tests`,**required**,§2.1);`approval-web-guard.yml`(job `approval-web-guard`,advisory,同 §2.1) |
| J(客户端层,`.code` 不降级为裸状态码) | 同上,客户端函数级 | 是 | `apps/web/tests/approvalTemplateGroupsClient.spec.ts` | `acceptance J: a 403 SESSION_ORG_REQUIRED throws ApprovalApiError with the code intact (not collapsed to a generic message)`;`every write endpoint surfaces its failure code the same way (not just the list endpoint)` | 同上 |
| J(未知 `section=` 令牌 ⇒ 400) | — | **不在本切片** — `section=` 到分期 3(A-4)才存在;补充清单 #5 owner 勘误请示未决 | — | — | A-4 |
| J(共享组件本身,非集成) | `SessionOrgSwitcher` 的通用文案/覆盖文案/错误提示渲染 | 是,组件隔离层 | `apps/web/tests/SessionOrgSwitcher.spec.ts` | `emits an explicit choice with the generic default copy (no domain-specific wording baked in)`;`renders caller-supplied copy overrides in place of the generic defaults`;`shows the error hint and stays hidden when there is nothing to show` | 同上 |
| C(中心页 `section=` 分节) | — | **不在本切片** | — | — | A-4 |
| D(category 后备) | — | **不在本切片** | — | — | A-4 |
| A/A′/A″/A‴/B/B′/B″/E/F/G/H/I/I′/K | 后端事务/锁序/授权/序号不变量 | **不在本切片** — 全部属 A-1(已独立验证,见 A-1 验证 MD §12) | — | — | A-1 |

**J 行拆分口径**:与 A-1 设计 MD §1.3 一致——锁文 §6「期 1」门原文把 J 整行记在期 1 门下,但目标文档切片清单把前端半独立列为 A-2。本文档只对前端半(展示选择器 + 重试 + 单 org 成员不可见)与客户端层(`.code` 保真)出具验证,不佯称已验证 J 的「未知 `section=` 令牌 400」半句——那半句本切片不可满足,已在设计 MD §1.2/§7 与补充清单 #5 披露。

## 2. CI 两点接线 — 命令逐字 + 结果关键行(现场重跑,当前 HEAD)

### 2.1 分支保护 required contexts(push 前核对,不沿用 A-1 记录的旧值)

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

2026-09-18 现场核对:13 个 required contexts、`strict=false`,与 A-1 记录的 2026-09-17 快照数字一致(未变化)。`web-tests` 在列;`approval-web-guard`(本切片改动的 workflow 的 job id)**不在列**——确认它是 advisory,不是本切片改动能触碰到的合并门;三份新 spec 的 required 覆盖来自 `web-tests` job 里的 `run-required-web-tests.sh`:

```
$ grep -n "run-required-web-tests\|^name:\|^jobs:\|^  web-tests:" .github/workflows/web-tests.yml
23:name: Web Tests
38:  web-tests:
77:        run: bash apps/web/scripts/run-required-web-tests.sh
```

`name: Web Tests` → job id `web-tests`,与 required contexts 列表里的 `web-tests` 字符串对应;该 job 第 77 行调用本切片改过的 `run-required-web-tests.sh`。`approval-web-guard.yml` 自身文件头(`:9-13`)也自陈「Scope (deliberately TARGETED...)」——本切片改动的两处 `paths:` 只影响这个 advisory workflow 何时触发,不改变它是否 required。

### 2.2 s6a / `plugin-tests.yml` 未受影响(必须对 A-1 尖端取 diff,不能对 `origin/main` 取——A-1 学到的教训)

```
$ BASE=$(git merge-base feat/approval-template-groups-phase1 HEAD); echo "base=$BASE"
base=0144932ac67e80a81f204dd6c6e502d000112276
$ git diff --exit-code "$BASE"..HEAD -- .github/workflows/plugin-tests.yml; echo "exit=$?"
exit=0
$ git cat-file -e HEAD:.github/workflows/plugin-tests.yml && echo "plugin-tests.yml: exists"
plugin-tests.yml: exists
```

（若误对 `origin/main` 取 diff,会把 A-1 自己两行的追加也算进来,得到非空 diff——这正是 A-1 §10.1 记录过的同一类基线错误,本节改用正确的 A-1 尖端作为基线,`exit=0` 才是「A-2 自己零改动 `plugin-tests.yml`」的真实断言;存在性正控通过,`exit=0` 不是路径不存在的假阳性。）

s6a 钉重算(用仓内同一份计算逻辑,而非手工 sha256sum):

```
$ node -e "
const m = require('./plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs');
const pins = m.computePackageProvenancePinSet(process.cwd());
const staged = require('./plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json');
console.log('computed:', pins.evidenceFiles.pluginTestsWorkflow);
console.log('staged:  ', staged.evidenceFiles.pluginTestsWorkflow);
console.log('match:', pins.evidenceFiles.pluginTestsWorkflow === staged.evidenceFiles.pluginTestsWorkflow);
"
computed: f08ea1addb3fd5f22ed1aa67624e2d746faedcdc87b432c7f7517ddc73801a6b
staged:   f08ea1addb3fd5f22ed1aa67624e2d746faedcdc87b432c7f7517ddc73801a6b
match: true
```

已应用钉(A-1 落地时算的)与当前 HEAD 现算的值逐字相同——A-2 不需要重新提交这枚钉。**时效性披露(与 A-1 §4 同一纪律)**:此结论只对当前 HEAD 的 `plugin-tests.yml` 字节成立,合并前若有其他 PR 先改了该文件,须重算。

### 2.3 令牌机械计数 + 双向子串碰撞扫描(现场重算,不沿用实现者提交里的旧计数)

```
$ python3 - <<'EOF'
def extract_run_line(path, marker):
    with open(path) as f:
        content = f.read()
    for line in content.splitlines():
        if line.strip().startswith(marker):
            return line
    return None

run_sh = extract_run_line('apps/web/scripts/run-required-web-tests.sh', 'exec npx vitest run')
tokens = run_sh.split()
assert tokens[0:4] == ['exec', 'npx', 'vitest', 'run']
body = [t for t in tokens[4:] if t != '--reporter=dot']
new3 = ['SessionOrgSwitcher.spec.ts', 'approvalTemplateGroupsClient', 'ApprovalTemplateGroupsPanel']
old = [t for t in body if t not in new3]
print("run-required-web-tests.sh total tokens (excl --reporter=dot):", len(body))
print("old:", len(old), "new present:", [t for t in body if t in new3])
collisions = [(n, o) for n in new3 for o in old if n in o or o in n]
print("collisions new-vs-old:", collisions)
EOF
run-required-web-tests.sh total tokens (excl --reporter=dot): 396
old: 393 new present: ['SessionOrgSwitcher.spec.ts', 'approvalTemplateGroupsClient', 'ApprovalTemplateGroupsPanel']
collisions new-vs-old: []
```

```
$ grep -n "run: pnpm --filter @metasheet/web exec vitest run" .github/workflows/approval-web-guard.yml
925:        run: pnpm --filter @metasheet/web exec vitest run approval-fwb-mapping-config approval-fwb-mapping-editor --reporter=dot
1026:        run: pnpm --filter @metasheet/web exec vitest run approval-attachment-download ... SessionOrgSwitcher.spec.ts approvalTemplateGroupsClient ApprovalTemplateGroupsPanel --reporter=dot
```

（:925 是同文件另一个不相关 job 的两 token 短命令,与本切片无关;本切片改的是 :1026 那一条。）

```
$ python3 - <<'EOF'
with open('.github/workflows/approval-web-guard.yml') as f:
    text = f.read()
gl = [l for l in text.splitlines() if l.strip().startswith('run: pnpm --filter @metasheet/web exec vitest run')][1]
after = gl.split('vitest run', 1)[1]
toks = [t for t in after.split() if t != '--reporter=dot']
new3 = ['SessionOrgSwitcher.spec.ts', 'approvalTemplateGroupsClient', 'ApprovalTemplateGroupsPanel']
old = [t for t in toks if t not in new3]
print("approval-web-guard.yml :1026 token count (excl --reporter=dot):", len(toks))
print("old:", len(old), "new present:", [t for t in toks if t in new3])
collisions = [(n, o) for n in new3 for o in old if n in o or o in n]
print("collisions new-vs-old:", collisions)
EOF
approval-web-guard.yml :1026 token count (excl --reporter=dot): 106
old: 103 new present: ['SessionOrgSwitcher.spec.ts', 'approvalTemplateGroupsClient', 'ApprovalTemplateGroupsPanel']
collisions new-vs-old: []
```

**更正实现者提交里的一处措辞**(commit `f3d7c69c9` 曾在 `run-required-web-tests.sh` 的注释里写"394 tokens"/"395 tokens"——那是开发过程中逐个添加 token 时的中间快照,不是最终计数;本节现场重算的最终值是 396(run-required-web-tests.sh)与 106(approval-web-guard.yml :1026),已在 `cb6d7fa9f`(同一分支的后续提交)里就近似问题做过一次修正,本节是**本文档自己的独立重算**,不是转抄该提交的说法。**声明范围的更正**:碰撞扫描只证明「3 个新 token 与各自文件里的旧 token 之间」双向子串扫描为空——不断言旧 token 集合内部彼此无碰撞(旧集合里确实存在如 `approval-record-link`/`approval-record-link-picker` 这类前缀碰撞,是既有惯例,与本切片无关,本切片不引入新的此类碰撞)。

**P3 卫生轮再更正(2026-09-19,§12.9;经复核修正)**:本节最初的这条更正说"本三个新 token 因此在此前的每一个 HEAD 上都没有真正进入 required 的 `web-tests` job"——这句全称式判断是错的,已被独立复核门审(`p3-hygiene-gate-A2-20260919.md` §P2-1)证伪并撤回。准确的表述是:上面这次"396"计数(在 `cb6d7fa9f`/`d3097be00` 这两个更早的 head 上现场重算)本身**是对的**——那两个 head 上只有**一条** exec 行,三个新 token 全在其中,`web-tests` job 确实跑到了它们。重复行是后来一次 rebase(committer date 09-18 20:56:36)才制造出来的,只影响 `5d0f780f5`/`b1e5c745f` 这两个更晚的 head(该 head 上有两条 exec 行,三个 token 落在从未执行的那一条上)。修复(合并两行为一)后,唯一存活的 `exec` 行的最终 token 数是 **397**,不是 396。完整根因、逐 head 核对与影响声明见验证 MD §12.9,不在此处重复。

**Token 实际解析验证(现场跑,非静态断言)**——见 §1 的三份 spec 均已现场跑绿;此外验证「`SessionOrgSwitcher.spec.ts` 全文件名 token 是否真的会连带匹配到 `AttendanceSessionOrgSwitcher.spec.ts`」(设计上的已知重复覆盖,非缺口):

```
$ pnpm --filter @metasheet/web exec vitest run SessionOrgSwitcher.spec.ts approvalTemplateGroupsClient ApprovalTemplateGroupsPanel --reporter=verbose
✓ tests/SessionOrgSwitcher.spec.ts > SessionOrgSwitcher > emits an explicit choice with the generic default copy (no domain-specific wording baked in)
✓ tests/SessionOrgSwitcher.spec.ts > SessionOrgSwitcher > renders caller-supplied copy overrides in place of the generic defaults
✓ tests/SessionOrgSwitcher.spec.ts > SessionOrgSwitcher > shows the error hint and stays hidden when there is nothing to show
✓ tests/AttendanceSessionOrgSwitcher.spec.ts > AttendanceSessionOrgSwitcher > emits an explicit choice and never writes a punch/history orgId input
✓ tests/approvalTemplateGroupsClient.spec.ts > approval template group client (design lock v2.13 §6 phase 1) > listApprovalTemplateGroups: GETs the list endpoint and unwraps { groups }
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > createApprovalTemplateGroup: POSTs { name } and unwraps { group }
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > renameApprovalTemplateGroup: PATCHes /:id with { name }
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > archiveApprovalTemplateGroup / unarchiveApprovalTemplateGroup: POST the /:id/(un)archive legs
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > linkApprovalTemplateToGroup: POSTs /api/approval-templates/:id/group with { groupId }, unwraps { link }
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > unlinkApprovalTemplateFromGroup: DELETEs /api/approval-templates/:id/group, resolves on 204 with no body read
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > acceptance J: a 403 SESSION_ORG_REQUIRED throws ApprovalApiError with the code intact (not collapsed to a generic message)
✓ tests/approvalTemplateGroupsClient.spec.ts > ... > every write endpoint surfaces its failure code the same way (not just the list endpoint)
✓ tests/ApprovalTemplateGroupsPanel.spec.ts > ApprovalTemplateGroupsPanel — acceptance J (design lock v2.13 §4) > single-org member: list loads clean on mount, the selector is never shown, and no session-org call is ever made
✓ tests/ApprovalTemplateGroupsPanel.spec.ts > ... > a 403 SESSION_ORG_REQUIRED on create shows the switcher; selecting an org retries the SAME create and gets 201
✓ tests/ApprovalTemplateGroupsPanel.spec.ts > ... > a 403 SESSION_ORG_REQUIRED on the initial mount-time list load shows the switcher; selecting an org retries the SAME list load

 Test Files  4 passed (4)
      Tests  15 passed (15)
```

`SessionOrgSwitcher.spec.ts` 的 full-filename token 确认真的连带跑了 `AttendanceSessionOrgSwitcher.spec.ts`(2 文件 4 用例)——重复覆盖,不是缺口:该文件已在同一命令的第 477 行自己的专属 token 下独立 required,本行重跑它不改变覆盖面。4 文件 15 用例,全部现场绿。

## 3. 考勤闭世界 session-spec census — byte-unchanged + 活体重跑(锁文 §2「多 org 成员」,第 8 轮 P3-b 的对象)

```
$ BASE=0144932ac67e80a81f204dd6c6e502d000112276
$ git diff --exit-code "$BASE"..HEAD -- \
    apps/web/src/views/attendance/AttendanceSessionOrgSwitcher.vue \
    apps/web/src/composables/useSessionOrg.ts; echo "exit=$?"
exit=0
$ git cat-file -e HEAD:apps/web/src/views/attendance/AttendanceSessionOrgSwitcher.vue && echo exists
exists
$ git cat-file -e HEAD:apps/web/src/composables/useSessionOrg.ts && echo exists
exists
```

两个文件字节零改动(存在性正控通过)。活体重跑该 census 自身的 spec(它的 `sessionSpecs` 数组在 `:72` 是硬编码闭世界,新增一个共享 session 组件正是这类 census 最容易被意外收窄的场景):

```
$ pnpm --filter @metasheet/web exec vitest run attendance-web-guard-workflow --reporter=verbose
✓ ... attendance web guard workflow contract > runs makeup regressions in both unit gates and the dedicated browser lane
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/composables/authPrincipal.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/composables/useAuth.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/composables/useSessionOrg.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/composables/useAttendanceSessionGuard.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/utils/api.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/utils/explicitSessionOrg.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/services/attendance/effectiveCalendar.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/src/services/attendance/teamAvailability.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/tests/useAuth.spec.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/tests/useSessionOrg.spec.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/tests/AttendanceSessionOrgSwitcher.spec.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/tests/useAttendanceSessionGuard.spec.ts
✓ ... > selects explicit session change in both push and PR classifiers: apps/web/tests/api.spec.ts
✓ ... > executes the exact session spec in domain and required commands: useAuth
✓ ... > executes the exact session spec in domain and required commands: useSessionOrg
✓ ... > executes the exact session spec in domain and required commands: AttendanceSessionOrgSwitcher
✓ ... > executes the exact session spec in domain and required commands: useAttendanceSessionGuard
✓ ... > creates one stable check for every pull request
✓ ... > keeps this contract spec in the classifier and targeted run list
✓ ... > keeps the group-context route host proof in the classifier and targeted run list
✓ ... > keeps the fix 1/fix 2 navigability-audit specs in the classifier and targeted run list
✓ ... > keeps attendance-admin tenant-boundary specs in the classifier and targeted run list
✓ ... > keeps employee 常用 icon specs in the classifier and targeted run list

 Test Files  1 passed (1)
      Tests  24 passed (24)
```

24/24 绿——考勤闭世界 census 未被本切片收窄。

## 4. 私有库 `metasheet2_lock_a2` — 创建 + 迁移重跑 + 零 DB 依赖 grep

### 4.1 A-2 自身零迁移文件(先证明"重放的是谁的 DDL")

```
$ BASE=0144932ac67e80a81f204dd6c6e502d000112276
$ git diff --stat "$BASE"..HEAD -- packages/core-backend/src/db/migrations/; echo "exit=$?"
exit=0
```

空 diffstat——A-2 对 A-1 尖端零迁移改动,下面重放的是 A-1 继承下来的 DDL 链,不是 A-2 自己的。

### 4.2 三份新 spec 的零 DB 依赖(先证明"重跑 DB 对这三份 spec 本身买不到什么")

```
$ grep -cE "DATABASE_URL|new Client|new Pool|require\('pg'\)|from 'pg'|describeIfDatabase" \
    apps/web/tests/SessionOrgSwitcher.spec.ts apps/web/tests/approvalTemplateGroupsClient.spec.ts apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts
apps/web/tests/SessionOrgSwitcher.spec.ts:0
apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts:0
apps/web/tests/approvalTemplateGroupsClient.spec.ts:0
```

三份均为 0——它们的唯一网络出口是 `vi.mock('../src/utils/api', ...)`(`ApprovalTemplateGroupsPanel.spec.ts:14`)或 `vi.stubGlobal('fetch', ...)`(`approvalTemplateGroupsClient.spec.ts:60` 等),`SessionOrgSwitcher.spec.ts` 甚至没有任何网络调用(纯 props/emit 组件测试)。

### 4.3 创建私有库 + 迁移重放 + 幂等确认

```
$ createdb metasheet2_lock_a2; echo "exit=$?"
exit=0
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a2" pnpm exec tsx src/db/migrate.ts
...
migration "zzzz20260918090000_create_approval_template_groups" was executed successfully
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a2" pnpm exec tsx src/db/migrate.ts
(无输出 — 第二次幂等空跑)
```

迁移链干净应用到 A-1 的 `create_approval_template_groups` 为止(A-1 验证 MD §11.1 已对同一张表的 schema 做过 `\d` 逐条核对,本节不重复);第二次运行零输出确认幂等。**这次 DB 重放证明的是**"这条继承来的 DDL 链在一个全新的私有库上仍然干净可应用"——一次环境健全性确认,**不是** A-2 本身获得了新的 DB 测试覆盖(见 §4.2)。

## 5. 数据模型 / 错误码机械核对(设计 MD §2 的命令来源)

### 5.1 DTO 字段 ↔ 后端映射函数(AST 级提取比较)

```
$ python3 - <<'EOF'
import re
fe = open('apps/web/src/approvals/api.ts').read()
def fields_of(iface, src):
    m = re.search(iface + r" \{(.*?)\n\}", src, re.S)
    return re.findall(r"^\s*(\w+)[?:]", m.group(1), re.M)
fe_group = fields_of(r"export interface ApprovalTemplateGroupDTO", fe)
fe_link = fields_of(r"export interface ApprovalTemplateGroupLinkDTO", fe)
be = open('packages/core-backend/src/services/ApprovalTemplateGroupService.ts').read()
def obj_fields(fn, src):
    m = re.search(r"function " + fn + r"\(row.*?\{\s*return \{(.*?)\n  \}", src, re.S)
    return re.findall(r"^\s*(\w+):", m.group(1), re.M)
be_group = obj_fields("mapGroupRow", be)
be_link = obj_fields("mapLinkRow", be)
print("group match:", fe_group == be_group, fe_group)
print("link  match:", fe_link == be_link, fe_link)
EOF
group match: True ['id', 'orgId', 'name', 'sortOrder', 'createdBy', 'createdAt', 'updatedAt', 'archivedAt']
link  match: True ['orgId', 'templateId', 'groupId', 'linkedBy', 'linkedAt', 'unlinkedAt']
```

### 5.2 错误码联合双向核对(18 码)

```
$ python3 - <<'EOF'
import re
fe_codes = set(['APPROVAL_ACTOR_REQUIRED','APPROVAL_GROUP_ID_REQUIRED','APPROVAL_TEMPLATE_GROUP_ARCHIVE_FAILED','APPROVAL_TEMPLATE_GROUP_CREATE_FAILED','APPROVAL_TEMPLATE_GROUP_LINK_FAILED','APPROVAL_TEMPLATE_GROUP_LIST_FAILED','APPROVAL_TEMPLATE_GROUP_RENAME_FAILED','APPROVAL_TEMPLATE_GROUP_UNARCHIVE_FAILED','APPROVAL_TEMPLATE_GROUP_UNLINK_FAILED','APPROVAL_TEMPLATE_NOT_FOUND','GROUP_ARCHIVED','GROUP_NAME_REQUIRED','GROUP_NAME_TAKEN','GROUP_NOT_ARCHIVED','GROUP_NOT_FOUND','GROUP_SORT_CONFLICT','ORG_ID_NOT_ACCEPTED','SESSION_ORG_REQUIRED'])
routes = open('packages/core-backend/src/routes/approvals.ts').read()
svc = open('packages/core-backend/src/services/ApprovalTemplateGroupService.ts').read()
combined = routes + svc
be_codes = set(c for c in fe_codes if f"'{c}'" in combined or f'"{c}"' in combined)
print("missing in backend:", fe_codes - be_codes)
print("all 18 matched:", len(be_codes) == 18)
EOF
missing in backend: set()
all 18 matched: True
```

反向(后端多出的、前端不该重复的码)已在设计 MD §2.2 用 `grep -n "ORG_ID_NOT_ACCEPTED\|SESSION_ORG_REQUIRED\|APPROVAL_PARTICIPANT_DIRECTORY_FAILED\|VALIDATION_ERROR" packages/core-backend/src/routes/approvals.ts` 现场核对:`APPROVAL_PARTICIPANT_DIRECTORY_FAILED`(:1238,目录搜索端点,非分组端点)与 `VALIDATION_ERROR`(:850/:1839/:1892/:2643 等,跨多个不相关端点的通用码)确认与七个分组端点无关,前端联合类型不多不少。

### 5.3 org 参数防呆(前端函数签名零 orgId 形参)

```
$ sed -n '1162,1219p' apps/web/src/approvals/api.ts | grep -c "orgId"
0
```

七个函数体内(不含类型定义/注释区间外)零次出现 `orgId`,与设计 MD §3.2 的断言一致。

### 5.4 事务/锁语义零命中(设计 MD §4「不适用」的证据)——含一次自我更正

**第一版命令(如实记录曾经跑过、且给出了错误结论的样子)**:

```
$ git diff --stat 0144932ac67e80a81f204dd6c6e502d000112276..HEAD --name-only | xargs grep -ciE "BEGIN|COMMIT|pg_advisory|FOR UPDATE|new Client|new Pool" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}'
15
```

这条命令在本文档定稿前**未被亲自执行过**就写成了「全部为 0」——这本身就是记忆「验证站点被自己的负控污染」与「绝对断言自扫必须机械化」两条纪律要打的那类错误:补写时才现场跑,发现真实结果是 **15**,不是文档原先声称的 0。逐文件定位(`xargs grep -ciE ... apps/web/scripts/run-required-web-tests.sh apps/web/tests/templateCenterI18n.spec.ts ... docs/development/*.md`)后确认全部 15 处命中都是假阳性,零处是真实的 SQL/事务代码:

- `run-required-web-tests.sh` 10 处:`grep -oiE` 逐个提取后全部是散文里的单词 `commit`(如 `committed-edit-only`、`grid-commit-reliability`、`this slice's commit body` 等 git 语境的「提交」)与 1 处 `new client`(散文「the four new client methods'」,指本切片新增的客户端函数,不是 `new Client()` 数据库连接),與 SQL 完全无关。
- `templateCenterI18n.spec.ts` 1 处:同样是散文 `commit body`(i18n 守卫的既有注释,与本切片无关的既有内容)。
- 两份本文档自身(design MD 1 处、verification MD 3 处):**自指命中**——本文档引用锁文/A-1 术语时逐字写了 `BEGIN`/`COMMIT`/`pg_advisory`/`FOR UPDATE` 这些词本身(例如上面这段更正文字和 §2.2/§4 的行文),`--stat --name-only` 把这两份新提交的文档也算进"改动文件"列表,于是文档讨论"这些关键词"这件事本身触发了搜索这些关键词的命令。
- 未在上面列出的还有 1 处落在 A-2 自己新增的 `run-required-web-tests.sh` exec 行内(即 §2.3 已核对过的那一整行 token 列表新增了三个 token 时带出的散文,同一个「commit」/「new client」假阳性来源,不是新的事务代码)。

**更正后的命令(限定在实际的生产代码 + spec 源码,排除 CI 脚本散文注释与本 MD 文档自身,并额外用"只看新增行"的形式复核)**:

```
$ grep -ciE "BEGIN|COMMIT|pg_advisory|FOR UPDATE|new Client|new Pool" \
    apps/web/src/approvals/api.ts \
    apps/web/src/components/SessionOrgSwitcher.vue \
    apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue \
    apps/web/src/views/approval/TemplateCenterView.vue
apps/web/src/components/SessionOrgSwitcher.vue:0
apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue:0
apps/web/src/approvals/api.ts:0
apps/web/src/views/approval/TemplateCenterView.vue:0

$ git diff 0144932ac67e80a81f204dd6c6e502d000112276..HEAD -- \
    apps/web/src/approvals/api.ts apps/web/src/components/SessionOrgSwitcher.vue \
    apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue apps/web/src/views/approval/TemplateCenterView.vue \
    apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts apps/web/tests/SessionOrgSwitcher.spec.ts \
    apps/web/tests/approvalTemplateGroupsClient.spec.ts apps/web/tests/approvalTemplateCenterCategory.spec.ts \
    apps/web/tests/approvalTemplateGovernance.spec.ts apps/web/tests/templateCenterI18n.spec.ts \
  | grep -E "^\+" | grep -ciE "BEGIN|COMMIT|pg_advisory|FOR UPDATE|new Client|new Pool"
0
```

四个生产代码文件本身零命中;把范围扩到六个 spec 文件、且只看新增的 `+` 行(而非整份既有文件的历史内容),同样零命中。**这才是设计 MD §4「不适用」实际站得住的证据**;第一版的「15 处全零」表述是错的,15 才是曾经现场跑出的真实数字,0 是收窄到正确范围后的真实数字——两个数字都记录在案,不是用后者掩盖前者。

## 6. 闭世界缺口披露(与 A-1 §5/§9 同一性质,对象不同)

```
$ grep -rl "run-required-web-tests\.sh\|approval-web-guard\.yml" scripts/ops/*.mjs
scripts/ops/elearning-media-ci-wiring.test.mjs
$ grep -n "run-required-web-tests\.sh\|approval-web-guard\.yml" scripts/ops/elearning-media-ci-wiring.test.mjs | head -3
20:const REQUIRED_WEB = join(repoRoot, 'apps/web/scripts/run-required-web-tests.sh')
792:test('run-required-web-tests.sh keeps existing tokens and adds a distinct twenty-seven-file elearning invocation', () => {
```

唯一命中的既有 `*-ci-wiring` 守卫(`elearning-media-ci-wiring.test.mjs`)只断言它**自己**的 27 个 elearning token 仍在文件里,不是一个通用的"任何 token 被删都报红"闭世界守卫。用本切片的三个 token 名单再单独确认零命中:

```
$ grep -rl "SessionOrgSwitcher\.spec\.ts\|approvalTemplateGroupsClient\|ApprovalTemplateGroupsPanel" scripts/ops/*.mjs
(无输出)
```

**结论(披露,不是掩盖)**:目前没有任何既有 `*-ci-wiring` 守卫会在未来有人不慎从 `run-required-web-tests.sh` 或 `approval-web-guard.yml` 里移除这三个 token 时报红——与 A-1 §5/§9 披露的闭世界缺口同一性质,不同对象。未新建专属守卫,留给后续单元或 owner 裁决是否现在做(见设计 MD §6)。

## 7. Mutation 台账(每条:备份 → 改 → 跑 → 还原 → cmp)

面板有两处独立的 `err.code === 'SESSION_ORG_REQUIRED'` 分支(`loadGroups`/`onCreate` 各一处);提交 `15a6733ec` 的目的正是证明两处分支各自独立被覆盖(而非只覆盖了其中一个,另一个被同一条用例路径顺带带过)。本节亲自跑两条 mutation 复核这个断言,而不是转述该提交的说法。

### 7.1 Mutation #1 — 删除 `loadGroups` 的 `SESSION_ORG_REQUIRED` 分支

```
$ cp apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue /tmp/ApprovalTemplateGroupsPanel.vue.bak
```

改动(`loadGroups` 的 catch 块,`:134-139`,删掉 if 分支,直接落进 `loadError`):

```diff
   } catch (err) {
-    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
-      handleSessionOrgRequired(loadGroups)
-      return
-    }
     loadError.value = err instanceof Error ? err.message : String(err)
```

```
$ pnpm --filter @metasheet/web exec vitest run ApprovalTemplateGroupsPanel --reporter=verbose
✓ single-org member: list loads clean on mount, the selector is never shown, and no session-org call is ever made
✓ a 403 SESSION_ORG_REQUIRED on create shows the switcher; selecting an org retries the SAME create and gets 201
× a 403 SESSION_ORG_REQUIRED on the initial mount-time list load shows the switcher; selecting an org retries the SAME list load
  → expected null not to be null

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

**结果**:精确只有「initial mount-time list load」那一条变红,「create」那一条(走的是 `onCreate` 分支,未被此次 mutation 触碰)与「single-org member」正控都保持绿——判别力精确落在被改动的那一个分支上。

```
$ cp /tmp/ApprovalTemplateGroupsPanel.vue.bak apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue
$ cmp /tmp/ApprovalTemplateGroupsPanel.vue.bak apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue && echo "cmp: byte-identical"
cmp: byte-identical
```

### 7.2 Mutation #2 — 删除 `onCreate` 的 `SESSION_ORG_REQUIRED` 分支

```
$ cp apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue /tmp/ApprovalTemplateGroupsPanel.vue.bak
```

改动(`onCreate` 的 catch 块,`:154-159`,同样删掉 if 分支):

```diff
   } catch (err) {
-    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
-      handleSessionOrgRequired(() => onCreate())
-      return
-    }
     loadError.value = err instanceof Error ? err.message : String(err)
```

```
$ pnpm --filter @metasheet/web exec vitest run ApprovalTemplateGroupsPanel --reporter=verbose
✓ single-org member: list loads clean on mount, the selector is never shown, and no session-org call is ever made
× a 403 SESSION_ORG_REQUIRED on create shows the switcher; selecting an org retries the SAME create and gets 201
  → expected null not to be null
✓ a 403 SESSION_ORG_REQUIRED on the initial mount-time list load shows the switcher; selecting an org retries the SAME list load

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

**结果**:与 7.1 互补——精确只有「create」那一条变红,「initial mount-time list load」保持绿,证明这两条用例确实各自独立覆盖各自的分支(而不是其中一条对另一条的分支有隐性判别力)。

```
$ cp /tmp/ApprovalTemplateGroupsPanel.vue.bak apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue
$ cmp /tmp/ApprovalTemplateGroupsPanel.vue.bak apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue && echo "cmp: byte-identical"
cmp: byte-identical
$ git diff --stat -- apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue
(无输出 — 干净)
```

### 7.3 未做的 mutation(如实披露)

- `SessionOrgSwitcher.vue` 自身(`hintText` 的四路计算属性、`onChange` 的 trim/空值短路)未做 mutation——它是纯展示组件,三条既有用例已覆盖默认文案/覆盖文案/错误提示三种渲染路径,但未逐条 mutation 验证每一路的判别力;留作未验项(§10)。
- `approvalTemplateGroupsClient.spec.ts` 的七个函数体(URL 拼接、method、body 序列化)未做 mutation——`SESSION_ORG_REQUIRED` 一条已验证错误管道保真(本节 §7.1/7.2 验证的是消费方,不是该文件本身的编码正确性),其余六个函数的 URL/method 断言留作未验项(§10)。

## 8. 既有 spec 接缝回归(设计 MD §5「接缝」表最后一行)

```
$ pnpm --filter @metasheet/web exec vitest run approvalTemplateCenterCategory approvalTemplateGovernance templateCenterI18n --reporter=verbose
...(28 条用例列表省略,全部 ✓)...
 Test Files  3 passed (3)
      Tests  28 passed (28)
```

三份既有 spec(设计 MD §5 提到的 mock 接缝补丁对象)在面板无条件挂载后全部 28/28 绿,确认接缝补丁生效、无回归。

## 9. TypeScript 编译(全量 `vue-tsc -b`,非增量抽样)

```
$ pnpm --filter @metasheet/web exec vue-tsc -b
(无输出 — 零类型错误)
```

全量 build 模式(`-b`)零输出,含本切片新增/改动的全部 `.ts`/`.vue` 文件在内的整个 `apps/web` 包类型检查通过。

## 10. 补充清单逐条核(lane A #5–#7;三条 lane 共用 #1–#4 已在设计 MD §3.4/§1.2 逐条求值,不重复)

| # | 内容 | 本切片求值 |
|---|---|---|
| lane A #5 | J 行「未知 `section=` 令牌 400」与 C 行「`category`/`section` 同现 400」— 请示 owner 挪到 A-4 | **未决**——本切片未做,PR body 需披露(设计 MD §7 已列) |
| lane A #6 | 分期门「1 落地」的求值(门审通过 vs 已合并)— 请示 owner 定义为「Draft PR 过门审」 | **未决**——本切片按此口径撰写文档,但未获 owner 确认(设计 MD §7 已列) |
| lane A #7 | 前端 spec 位置:须在 `apps/web/tests/`,不得在 `src/**/__tests__/` | **已满足,机械核对**:`find apps/web -name "<三份新 spec>" -not -path "*/node_modules/*"` 三次均只命中 `apps/web/tests/` 下的路径;`find apps/web/src -type d -name "__tests__"` 零命中(仓内本就没有这个目录) |

## 11. 未做 / 未验(如实列出)

- **J 行「未知 `section=` 令牌 ⇒ 400」**:不在本切片,`section=` 到 A-4 才存在(补充清单 #5,owner 未决)。
- **C 行「`?category=` 与 `section` 同现 ⇒ 400」**:同上。
- **闭世界缺口**(§6):无既有 `*-ci-wiring` 守卫覆盖本切片新增的三个 token 在两处 wiring 文件里的存在性,未来误删不会被任何现存守卫捕获。
- **`SessionOrgSwitcher.vue` 与 `approvalTemplateGroupsClient.spec.ts` 六个非 J 函数的 mutation 覆盖**(§7.3):未做,留作后续单元。
- **分组重命名/归档/解档/挂接/解除关联的 UI 端到端验证**:客户端函数已隔离测试(§1「J(客户端层)」行以外的另外 5 条用例覆盖了这些函数的 URL/method/序列化,但没有对应 UI,因此没有「用户点击某按钮触发某函数」这一层集成验证)——设计 MD §1.2 已披露这是本切片有意的最小范围,不是遗漏,但也确实"未验"这一层。
- **`approval-web-guard.yml` 的 job 本身是否真的会在 CI 环境(而非本地)绿**:本文档全部命令都在本地 worktree 执行,未触发实际 GitHub Actions 运行；`web-tests`/`approval-web-guard` 两个 workflow 在 CI 上的真实运行结果留给 Draft PR 开出后的 CI 状态检查,本文档不能也不应该冒称已验证 CI 环境本身。
- **owner 请示条款**(补充清单 #5、#6):见 §10,均未决,不阻塞本切片 Draft PR,但完成声明需如实标注"待 owner 回应"而非"已裁决"。

## 12. P3 卫生轮(2026-09-19)— 处置表 + 一条卫生轮自身发现的缺陷

对象:`impl-gate-A2-round1-20260918.md`(A-2 前端第 1 轮门审,DRAFT-READY,0 P1/0 P2/8 P3)。本轮硬规矩:生产代码零行为改动,只许测试/注释/MD/scripts/dev;不动 PR 状态与 body;不改锁文。以下处置表逐条对应报告 §5 的 P3-1..P3-8,外加卫生轮自己在核对 P3-4 时发现的一条独立缺陷(编号 P3-9)。

### 12.0 前置:本轮先对栈底 rebase

本 lane 是 Draft PR #5854(`feat/approval-template-groups-phase1-fe`),堆叠在 `feat/approval-template-groups-phase1`(A-1)之上。A-1 自己已经跑过一轮同名的 P3 卫生轮(`fbb5b38d8 docs(approval): P3 hygiene disposition table + evidence (sec26)`)并把 `origin/main` 的后续提交带了进来,本分支落后于新尖端。本轮第一步 `git rebase origin/feat/approval-template-groups-phase1`——**零冲突**(git 自动跳过 33 个内容已存在于新尖端的重复提交,只重放了本分支真正独有的 8 个提交),随后 `git push --force-with-lease` 一次同步远端。旧尖端 `5d0f780f53dffd006c27634aca2cbc8503859627` → rebase 后尖端 `b1e5c745f8fbc6d63987223d3af1e56b9b835ef5`(§12.11 diffstat 的起点)→ 本卫生轮结束时尖端 `1bd6c2e1d04fb6487fabf84a8cae132c96e5e49e`。

### 12.1 处置表

| # | 报告原文一句 | 处置 | 证据 / commit |
|---|---|---|---|
| P3-1 | 挂载点爆炸半径普查是手工的,真实挂载人口是 5 份 spec(含 `approval-e2e-permissions.spec.ts:565`、`approval-e2e-lifecycle.spec.ts:629`)而两份 MD 只点名 3 份 | CLOSED-MD | 本节 §12.2 补齐 5 行人口表 + 命令,并把「无回归」措辞改窄为「替换式 mock 的三份已补;`...actual` 的两份经实跑确认不受影响」 |
| P3-2 | `ApprovalTemplateGroupErrorCode` 全仓零消费方,18 码与后端的重合只由一次性脚本保证,无常驻守卫,后端改码时前端联合类型会静默腐烂 | CLOSED-MD(取报告给出的第二个选项——收窄 `.code` 类型需要改生产代码 `api.ts`,本轮禁止) | 本节 §12.3 登记腐烂风险到「未验/风险」清单 |
| P3-3 | 新 token 把被刻意隔离的考勤会话 spec(`:477` 单进程池)拉回默认池重跑一遍;A-2 自己会铸 token 的 `ApprovalTemplateGroupsPanel.spec.ts` 也没放隔离行 | CLOSED-MD(说明,不挪动 token——挪动需要重新验证隔离池夹具和两处闭世界 census,风险/收益不对称,本轮不做) | 本节 §12.4 |
| P3-4 | `run-required-web-tests.sh` 注释里「lands in a later slice」已 stale(该 slice 已落地);token 计数注释仍是「394/395」快照;两份 MD 抬头 HEAD 仍是 `cb6d7fa9f`(被审 head 晚两提交) | CLOSED-测试+注释(计数)/ CLOSED-注释(措辞)/ CLOSED-MD(抬头) | commit 修 `run-required-web-tests.sh` 三处注释;两份 MD 抬头见 design MD 本次编辑 + 本节 §12.0 |
| P3-5 | 正控「单 org 成员从不见到选择器」对应的 `toBeNull()` 断言在自己的夹具下永远不可能红(mock 对 session-orgs 端点只会 throw,组件自身 `v-if` 已经因 `orgs` 为空把它藏掉);承重的是旁边的调用普查断言 | DEFERRED-需重构夹具(记录了一次已验证不成立的候选修法,不落地;**理由口径已更正,见 §12.5 复核修正**——是范围/风险判断,不是"规矩不允许") | 本节 §12.5——尝试过给 `/api/auth/session-orgs` 补一个非空返回值,亲跑 M6 复现证明**仍然不解决**(`loadGroups()` 自己的成功分支会把 `showSessionOrgSwitcher` 重新置回 `false`,覆盖掉 `handleSessionOrgRequired` 刚置的 `true`);已用 `cp` 备份 → 改 → 跑 → 验证不成立 → 用 `cp` 逐字节还原两个文件(测试文件与生产文件都已确认零残留改动) |
| P3-6 | 共享组件常量 DOM id(`session-org-switcher-select`)+ 面板从不传 `hasUsableClaim`,与考勤宿主行为有差异,两份 MD 未记 | CLOSED-MD | 本节 §12.6 |
| P3-7 | 目标文档 DoD 要求「切片 = 分支 + Draft PR」,报告写门审时尚无 Draft PR;#5/#6 披露还没进 PR body | DEFERRED-🔒不可操作(硬规矩禁止本轮动 PR 状态与 body) | 本节 §12.7——Draft PR #5854 现已存在(报告当时的「无 PR」已 stale);PR body 待披露的两句原文见 §12.7,留给下一次允许编辑 PR body 的轮次原样粘贴 |
| P3-8 | 两个新前端面(`SessionOrgSwitcher.vue`、`ApprovalTemplateGroupsPanel.vue`)在 `templateCenterI18n.spec.ts:765` 的 i18n 闭世界硬编码文件清单之外 | CLOSED-测试 | `apps/web/tests/templateCenterI18n.spec.ts` 新增两条守卫测试(见 §12.8),亲跑正向格(注入未翻译中文字符串)证明判别力,`cp` 备份/还原,`cmp` 字节相同 |
| P3-9(卫生轮自身发现,不在原报告 8 条内) | `run-required-web-tests.sh` 里存在两份几乎相同的 `exec npx vitest run ...` 巨行——第一份(旧)在前、含本切片三个新 token 的那份(重复)在后;bash `exec` 无条件替换进程,第一份一执行,后面整个脚本(含第二份)永不到达。三个新 token 因此**从未被 `web-tests` required job 实际跑过**,报告 §1.4「令牌解析验证」与两份 MD §1/§2.1/§2.3 的「required 覆盖」结论在当前 HEAD 上是假的 | CLOSED-测试+脚本(scripts/dev,允许本轮改) | 本节 §12.9——merge 两行为一行,三个新 token 移到唯一存活行的 `--reporter=dot` 前;`bash -n` 通过;merged 后 token 计数从 394/395(报告口径)变为 **397**;`pnpm --filter @metasheet/web exec vitest run SessionOrgSwitcher.spec.ts approvalTemplateGroupsClient ApprovalTemplateGroupsPanel --reporter=dot` 现场 4 文件 15 用例全绿 |
| 复核修正(2026-09-19)— P2-1 | 独立复核门审(`p3-hygiene-gate-A2-20260919.md` §P2-1)证伪本节原 §12.9 的根因("实现者在死副本上继续追加、无人发现")、全称撤回("此前的每一个 HEAD 上都是假的")、以及由此产生的错误"影响声明"三处;逐 commit numstat 核对显示真根因是 rebase/三方合并对单条超长 exec 行的复制(`2699e0a07` 17+/1− vs `2ef7add98` 17+/0−),且 `cb6d7fa9f`/`d3097be00` 两个更早 head 上本无重复、结论本就成立 | CLOSED-MD | §12.9 全文重写(根因表、逐 head 核对表、真机制段、机械前置段、更正后的影响声明);代码修复(合并两条 exec 行)不回退;diffstat 见 §12.12 |
| 复核修正(2026-09-19)— 报告自身 P3-1 | 同一份复核报告 findings §P3-1(对应本文档 §12.5/原处置表 P3-5):§12.5 把 DEFERRED 的理由写成"超出本轮闭合定义"(暗示规矩不允许),但拆用例/改夹具形状本身落在本轮允许的"测试"改动类别内;真实理由是范围/风险判断 | CLOSED-MD(理由口径更正,处置本身仍是 DEFERRED,不落地) | §12.5 末段重写;diffstat 见 §12.12 |
| **第三次修正(2026-09-19,`p3-hygiene-gate2-A2-20260919.md`)— P2-1** | 上一轮把 §12.9 的叙事改对了,但同一批被证伪的句子("were ever exercised … until this commit"全称式、"96c512876 added the duplicate copy rather than editing in place"根因、"three later commits kept appending … without anyone noticing"、"tail -1 / first-match … picked the wrong one")在 `apps/web/scripts/run-required-web-tests.sh:1237-1248` 的生产脚本注释里逐字、无限定地存活——本轮未碰这个文件,§12.12 的自扫又带 `-- '*.md'` 限定,结构上看不见 `.sh` | CLOSED-注释 | `apps/web/scripts/run-required-web-tests.sh` 该注释块按本节 §12.9 的真机制改写(rebase 复制根因、`2699e0a07`/`2ef7add98` 的编辑↔追加对照);**exec 行零改动**(改前后 `grep -c "^exec npx vitest run" apps/web/scripts/run-required-web-tests.sh` 均为 1,该行 md5 均为 `03f7fa1797a449fc9b5c2df6ff3e6351`) |
| **第三次修正 — P2-2** | §12.12 的"撤回类改动自扫"不是真实命令输出:前两条把 `git grep -n` 的多行输出压成一句括号内概括(真实命中 5/3 条而非转录暗示的 1 条);第三条"零命中"与"不是引用后限定这种保留形式"两句都被同一条命令的真实输出推翻(真实命中 2 条,其中一条恰恰就是那种保留形式) | CLOSED-MD | 本节自扫块换成逐字重跑的真实命令(去掉 `-- '*.md'`,改全仓 `-- .`,只取 `file:line`);三条命中数改为如实的 5/3/2 并逐条判读,不再假装零命中或压缩成一行 |
| **第三次修正 — P3-1** | `scripts/dev/atg-exec-line-post-rebase-check.sh` 的 Check 2(现 Check 3)只实现了"不丢"(`comm -23` 超集判定),`extract_tokens_from_stream` 的 `sort -u` 又把重复证据抹掉,"不重复"这半条判据零覆盖 | CLOSED-脚本 | 新增独立 Check 2(在现有 Check 1 之后、REF_A/REF_B 之前无条件运行):比较当前 exec 行的原始(未去重)token 列表长度与去重后长度,不等则 FAIL 并打印重复 token;mutation 复现 review 原探针(exec 行插入重复 `ApprovalTemplateGroupsPanel`)从 PASS/exit 0 变为 FAIL/exit 2,`cp` 备份/还原、`cmp` 字节相同 |
| **第三次修正 — P3-2** | Check 2(现 Check 3)在 `git show "$REF:$SCRIPT_PATH"` 解析失败时被 `2>/dev/null \|\| true` 吞掉,`TMP_A`/`TMP_B` 静默变空,并集缩小,`comm` 无缺失,打印 PASS;`:113-115` 的 `if …; then : ; fi` 是纯死代码 | CLOSED-脚本 | 新增 `ref_resolves()`(`git rev-parse --verify --quiet "<ref>^{commit}"` + `git cat-file -e "<ref>:<path>"`),Check 3 运行前先验两个 ref,任一不resolve 立即 FAIL 退出码 4;删除死代码 `if` 块;mutation 复现 review 原探针(`deadbeef1 deadbeef2`)从 PASS/exit 0 变为 FAIL/exit 4 |
| **第三次修正 — P3-3** | 脚本头部自称"a real precondition gate, not a reporting-only tool",与 §12.12"不构成'守卫'"互相矛盾 | CLOSED-脚本 | 头部改为"a manual precondition … NOT wired into any CI workflow or vitest config",并列出验证依据(`git grep` 该脚本名在 `.github/`、`package.json`/vitest 配置零命中);与 §12.12 措辞不再冲突(**第四次修正更正**:原文此处写"现场 `git grep -n "real precondition gate\|reporting-only tool" -- .` 零命中"——不准确。`apps/web/scripts/run-required-web-tests.sh` 那份脚本文件内确为零命中,旧措辞已被完全替换,这是稳定不漂移的判据;但**本 MD 文件**内该命令会命中本行自身(把旧措辞放进引号转述)以及本文档下文每一处再讨论这条更正的地方——命中数因此不是固定的 1,会随文档篇幅增长而增长,不写死具体数字,现场执行该命令查看当前值) |
| **第三次修正 — P3-4** | §12.9 点名的 `2699e0a07`/`2ef7add98`/`96c512876`/`cb6d7fa9f`/`d3097be00`/`5d0f780f5`/`b1e5c745f`/`0144932ac`/`cb9cdf9f6`/`f3137d0de` 十个 SHA 在本 PR 当前谱系(`git merge-base --is-ancestor`)全部 NOT-ANCESTOR,PR 读者 clone 后不可复核 | CLOSED-MD | 两张表各补一列"当前谱系对应件"(按 author date + commit subject 精确匹配,并用 `git patch-id --stable` 交叉验证——除 `2699e0a07` 本身无独立对应件、其"编辑既有行"的形状已被后续 rebase 吸收成"追加"外,其余 9 个均定位到唯一、可达、patch-id 相符的当前谱系提交) |
| **第三次修正 — P3-5** | §12.12"本轮未再次 rebase"字面成立但读起来像"谱系自上次门审未变",而本轮基线 `c41710ab0` 本身就是把上一门审 head `f3137d0de` 重放到 `origin/main` 新尖端的产物,75 条祖先 hash 全变 | CLOSED-MD | §12.12 硬规矩段改写为如实的谱系陈述:`f3137d0de` → `c41710ab0`(rebase 保活,树逐字节不变)→ `f9cb22666`(本节改写提交,当时的分支尖端);`f9cb22666` 之后(本轮)未再 rebase |
| **第四次修正(2026-09-19,`p3-hygiene-gate3-A2-20260919.md`)— P2-1** | 上一轮改写进 `apps/web/scripts/run-required-web-tests.sh:1240-1242` 的注释自带一条可测量为假的提交归属断言:说原始提交 `2699e0a07` 就地编辑这条 exec 行「to add the three tokens」,而实测该提交只加了三个 token 里的一个(`SessionOrgSwitcher.spec.ts`);另两个是后来才落到这条行上的 | CLOSED-注释 | 该注释块改为「to add only the FIRST of the three tokens」,补记 `approvalTemplateGroupsClient`/`ApprovalTemplateGroupsPanel` 分别在 `1e55c39b8`(author date 2026-09-18 07:10:50)、`bc66e283e`(author date 2026-09-18 07:33:18)才落到这条行上——`git log --format='%h %ad %s' --date=format:'%m-%d %H:%M:%S' -S'<token>' -- apps/web/scripts/run-required-web-tests.sh` 对两个 token 各自核对,均以该提交为最早命中;`diff <(0144932ac 排序 token) <(2699e0a07 排序 token)` 只有一行差异(`SessionOrgSwitcher.spec.ts`),398→399。**exec 行零改动**:改前后 `grep -c '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh` 均为 1,该行 md5(`grep '^exec npx vitest run' … \| md5`)改前改后均为 `03f7fa1797a449fc9b5c2df6ff3e6351`,sha256 均为 `da4a2ba1e04c1d341c2cee05d1e50360e82408d792f305f51dd5370ebe77b30d` |
| **第四次修正 — P3-1** | §12.9 第二张表「当前谱系对应件」一列在 3/7 行上与本行自己的测量值相反(`cb6d7fa9f`→`3a30f6ba2` exec 行数 1 vs 2;`d3097be00`→`6e24b8854` 1 vs 2;`0144932ac`→`a33f55796`「尚不含」vs「含有」`StockPreparationDataSourceRegistry`),邀请读者做一次必然失败的交叉核对,且原文无任何提示 | CLOSED-MD | §12.9 第二张表后补一段读数警告(现场 `git show <sha>:apps/web/scripts/run-required-web-tests.sh \| grep -c '^exec npx vitest run'` 逐条核对三行对应件),点名三处不同;每格字面断言本身仍为真,只是不能跨行拿对应件复现本行读数 |
| **第四次修正 — P3-2** | 本节 P3-3 那一行括号内「现场 `git grep -n "real precondition gate\|reporting-only tool" -- .` 零命中」被同一条命令在本 head 上证伪(命中该行自身) | CLOSED-MD | 改写为「`.sh` 文件内零命中(不随 MD 自身编辑漂移的判据),MD 内命中数随本文档引用该措辞的次数增长,不写死具体数字」;`git grep -n "real precondition gate\|reporting-only tool" -- .` 现场重跑对 `.sh` 恒为零命中,对本 MD 命中数取决于当次执行时文档已写了几处引用(本次修正在 P3-3 行、本行、下方对账表三处都会引用同一短语做说明,故 ≥3,具体数字请现场执行该命令,不在本行写死) |
| **第四次修正 — P3-3** | §12.12 自扫第三条判读段引用的硬编码行号 `:644` 在**被审 head**(`7dc349c7c37e6ed470f6db84a43ee03ea660ff86`,本次修正前的分支尖端)上是空行(`git show 7dc349c7c:docs/development/approval-template-groups-phase1-fe-verification-20260918.md \| sed -n '644p'` → 空),真实引文段落早已下移;该行号是原样抄自上一份门审报告(`p3-hygiene-gate2-A2-20260919.md` §P2-2 表格)的过期锚点 | CLOSED-MD | 改用符号锚点——段落标题「影响声明更正(2026-09-19 复核修正)」+ 现场 `git grep -n "影响声明更正" -- <本文件>` 定位,**不在本行写死具体行号**(**第五次修正:此处原有的"该行号在编辑过程中先后移动到哪几个位置"的叙述已删除——那是未提交工作树的中间状态,没有命令能把它重跑出来**);**注**:本次修正提交完成后,工作树里物理行号 `:644` 已因本节新增内容变成别的一句话(不再是空行),这是预期内的行号漂移,不构成新发现——`:644` 空行这一事实断言的对象自始至终是「被审 head」这一个固定 commit,不是"当前文件的第 644 行"这个会漂移的坐标 |
| **第四次修正 — P3-4** | §12.13 的 `--stat` 快照已过期(原文写死的插入行数与被审 head 上现场重跑的值不一致;**第五次修正按"不手写任何数字"的纪律把这两组数字一并删除,不在本行转录**) | CLOSED-MD(该行本身已自我披露为"一次性快照供参考,不作判据";按任务书要求就地重跑更新数字,`--name-status` 才是本节的判据,三行现场核对与原文逐字相同) | §12.13 `--stat` code fence 按本 head(`git diff --stat f9cb22666`)重跑替换为新数字;`git diff --name-status f9cb22666` 三行现场核对不变 —— **第五次修正已推翻本行处置**:门审实测写进去的数字逐字是上一个提交的值,"就地重跑更新数字"这条路本身就是错的,本轮改为整块删除、不重填,见下方第五次修正 P2-1 行 |
| **第五次修正(2026-09-19,`p3-hygiene-gate4-A2-20260919.md`)— P2-1** | §12.14 对账表以"全部有现场输出支撑、无需标未测量"收尾,而表内有三个各自独立的证伪点:§12.13 那份 `--stat` 数字逐字来自另一个提交,却被标成"本节写作时现场跑"的输出;一个被当作锚点历史的行号不对应任何提交(是未提交工作树的中间状态);还有一条"先写一个数、加一行说明后重跑变成另一个数"的过程轶事,既无命令也无"未测量"标注 | CLOSED-MD | (a) §12.13 的两份 `--stat` code fence 与 §12.14 对应表行**整块删除、不重填**,只留 `--name-status`;§12.12 正文里同族的一次性 `--stat` 快照一并删除。(b) 两条过程轶事在本表第四次修正 P3-3 行、§12.12、§12.14 三处一并删除——它们描述的是未提交的工作树,没有命令能把它们重跑出来。(c) §12.14 收尾的绝对断言删除,改为"上表每行命令在本次修正树上重跑一次,输出见各行",并真的逐行重跑,记录见 §12.15 |
| **第五次修正 — P3-1** | §12.12 四个自扫 code fence 里转录的硬编码行号本轮已全部漂移;上一轮只修了被点名的那一个,同段落的兄弟一个没扫 | CLOSED-MD | 四个 fence 的输出一律改为 `… \| cut -d: -f1 \| sort \| uniq -c`(只留文件与计数,不留行号),四段判读改用符号锚点(§ 编号 + 段落标题);承重的是命中计数与逐条判读,两者本轮现场重跑后不变 |
| **第五次修正 — P3-2** | §12.14 在"不要写死行号"那一行里写死了两个行号,并以"每次都命中"这种对未来状态的全称断言收尾 | CLOSED-MD | 该行改为符号定位("第三次修正 P3-3 行"与"第四次修正 P3-2 行"),删去"每次都"与两个硬编码行号 |
| **第五次修正 — P3-3** | 生产注释引的 `git log -S … -- <this file>` 是**文件级**命令,却用作 **exec 行级**断言的证据(本例恰好同解,但该命令不具判别力:换一个"先进注释、后进 exec 行"的 token 就会给出过早的提交) | CLOSED-注释 | 注释改用可判别形式 `git show <sha>:<this file> \| grep '^exec npx vitest run' \| grep -c '<token>'`,在被点名提交与其父提交上各跑一次,把跑出的 0/1 逐字写进注释;并写明双 exec 行时期"this line"严格指的是死副本(`bc66e283e` 上 `grep -n '^exec npx vitest run'` 给出两行,token 落在后一行)。**exec 行零字节改动**:见 §12.15 的 `shasum` fence |

### 12.2 P3-1:挂载点人口 5 行表(补齐两份 MD 未点名的两份)

```
$ grep -rn "approval/TemplateCenterView" apps/web/tests/ apps/web/src/
```

| spec | 挂载行(现场 `grep -rn` 复核) | mock 形态 | 本切片是否补过 |
|---|---|---|---|
| `approvalTemplateCenterCategory.spec.ts` | `:427` | 替换式 | 是 |
| `approvalTemplateGovernance.spec.ts` | `:397` | 替换式 | 是 |
| `templateCenterI18n.spec.ts` | `:400` | 替换式 | 是 |
| `approval-e2e-permissions.spec.ts` | `:565` | `...actual` 展开 | **否**——但已现场重跑 244/244 绿(见 gate 报告 §1.2),真实挂载 5 次,走 `...actual` 的真客户端函数 |
| `approval-e2e-lifecycle.spec.ts` | `:629` | `...actual` 展开 | **否**——同上 |

**口径更正**:本文档 §8「既有 spec 接缝回归」原先只覆盖三份替换式 mock 的 spec;现补记——`...actual` 展开的两份不需要打接缝补丁(它们走真实客户端函数,不会因为面板新增无条件挂载而抛出未捕获异常),但也因此**不在**本切片新增的任何 mock 覆盖之内。gate 报告记录了一处未查清现象(两份 spec 内 `listApprovalTemplateGroups()` 在用例存续期内既未 resolve 也未 reject)——**本轮未进一步排查,理由是范围/时间预算,不是规矩禁止**(读代码定位 promise 未决原因、必要时加临时诊断断言再用 `cp` 逐字节还原,都落在"测试"这一允许类别内,§12.5/§7 的 mutation 台账本身就是这么做的先例;把它记成"不属于本轮 4 类可闭合范围"会误导读者以为规矩挡住了这件事)。排查这一现象需要单独构造诊断,与本轮"逐条核对既有处置表 + 修复卫生轮自身发现的一条缺陷"这个收尾窗口不成比例,留给下一轮;未验项,原样保留报告措辞,不升级也不擅自下结论。

### 12.3 P3-2:错误码联合类型腐烂风险(登记,不改生产代码)

`ApprovalTemplateGroupErrorCode`(`apps/web/src/approvals/api.ts:1142-1160`)全仓仅 1 处引用(自己的定义行);`ApprovalApiError.code` 字段类型是 `string | undefined`,面板按字符串字面量分支,该联合类型不提供任何编译期约束。18 码与后端的一致性目前只由 §5.2 的一次性 Python 脚本核对过一次,**不是常驻守卫**——后端未来改码不会让本仓任何测试变红。收窄 `.code` 类型需要编辑 `api.ts`(生产代码),本轮硬规矩禁止;记为已知风险,留给下一个允许生产代码改动的轮次。

### 12.4 P3-3:新 token 未进 `:477` 隔离行(说明,不挪动)

`run-required-web-tests.sh:477` 单独用 `--pool=forks --poolOptions.forks.singleFork=true` 跑四份"显式会话" spec(理由:这类 spec 会通过 `useAuth().setToken(...)` 写 localStorage、铸真实 JWT,注释原文标注为需要进程隔离)。核对结果:

- `SessionOrgSwitcher.spec.ts`(3 用例)**不**铸 token、不写 localStorage——纯 props/emit 组件测试,不属于「显式会话 spec」这一类,留在默认池符合该行原本的分类标准。
- `ApprovalTemplateGroupsPanel.spec.ts`(3 用例)**确实**在每条用例里调用 `useAuth().setToken(jwt(...))`(`apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts:69,86,140`),按 `:477` 的分类标准应当算「显式会话 spec」。

**不挪动的理由**:`apps/web/vite.config.ts:103-109` 未关闭 vitest 默认的逐文件隔离,`:477` 的单进程池是对"跨文件状态泄漏"额外加的一层保险,不是唯一防线——gate 报告已现场核实这不是活缺陷(考勤闭世界 census 24/24 绿,未被新 token 掩盖)。把 `ApprovalTemplateGroupsPanel.spec.ts` 挪进 `:477` 需要重新验证该单进程池夹具在加入第 5 个文件后仍然稳定,并重算两处闭世界 census 的匹配范围——这是行为验证,不是纯文本改动,本轮不做,留给下一个允许更广泛回归验证的轮次;PR body 应披露这条未挪动的理由(P3-7 同一批 🔒 限制,见 §12.7)。

### 12.5 P3-5:尝试修复未成功(如实记录,已还原)

**假设**:给 `/api/auth/session-orgs` 补一个非空 `orgs` 返回值,应该能让 `toBeNull()` 断言在 M6 式 mutation(`onMounted` 改成主动 `handleSessionOrgRequired(loadGroups)` 后再 `loadGroups()`)下变红。

**验证过程**(`cp` 备份 → 改 → 跑 → 结论 → `cp` 还原):在测试文件里给该用例的 mock 加了一条 `/api/auth/session-orgs` 分支返回 `{ orgs: ['org-a'] }`,再在生产文件里复现 M6 mutation。**结果:假设不成立**——`toBeNull()` 依旧绿,失败还是落在旁边的调用普查断言(`expected true to be false`),与 gate 报告原始记录逐字相同。

**根本原因**:mutation 后的 `onMounted` 依次调用 `handleSessionOrgRequired(loadGroups)`(同步把 `showSessionOrgSwitcher.value` 置 `true`)、然后又调用一次独立的 `loadGroups()`;后者的 `try` 块在其 `await listApprovalTemplateGroups()` 成功后会**无条件**把 `showSessionOrgSwitcher.value` 重新置回 `false`(`ApprovalTemplateGroupsPanel.vue:133`)——这次成功的微任务链比 `loadSessionOrgs()` 的链更短,先落地,把刚置上的 `true` 覆盖掉。只要这个夹具里的列表调用最终会成功(而"single-org member"这条用例的全部意义就在于列表调用确实成功),`toBeNull()` 在 `settle()` 结束时就结构性地不可能红——与报告原文「结构性,不只是某条 mutation 的巧合」完全吻合,不是可以用一行 mock 修补的。

生产文件与测试文件均已用 `cp` 逐字节还原,`cmp` 确认;`git status --porcelain` 对两个文件均为空。

**处置口径更正(2026-09-19 复核修正,报告 `p3-hygiene-gate-A2-20260919.md` §P3-1)**:上一版把这条的处置理由写成"这是测试设计层面的行为变动,超出本轮'闭合'定义"——不准确。本轮自定的允许四类正是"测试/注释/MD/scripts/dev",拆用例、改 mock 形状本身就是**纯测试改动**,并不落在"本轮规矩不允许"之外;可闭合 ≠ 不值得闭合。真实理由是范围/风险判断:让这条断言真正承重,需要重新设计这条用例的夹具形状(拆成至少两条更细的用例,或换一个不依赖列表调用结果的独立断言点),并对新形状重新走一遍 §7 的 mutation 台账逐条验证判别力——这部分工作量与本轮"逐条核对既有处置表 + 修复卫生轮自身发现的一条缺陷"这个收尾窗口不成比例;而且这条用例与 P3-4(`ApprovalTemplateGroupsPanel.spec.ts` 是否应挪进 `:477` 单进程隔离池)共享同一份夹具上下文,两处若在同一轮内都动,会让本轮改动面失去"每处都能独立核实"的粒度。**处置:本轮不做,理由是范围/风险判断,不是规矩禁止**;留给下一个专门做测试重构与验证的轮次。

### 12.6 P3-6:共享组件差异登记

`SessionOrgSwitcher.vue` 把原件 `AttendanceSessionOrgSwitcher.vue` 的 `id="attendance-session-org"` 换成常量 `id="session-org-switcher-select"`——今天只有一个宿主(本面板),同页出现两个实例才会撞 DOM id,不是活缺陷。面板未传 `hasUsableClaim` prop,该值在审批面恒为 `undefined`(falsy),`hintText` 的 `chooseHint` 分支因此只受 `orgs.length > 1 && !modelValue` 控制,与考勤宿主(会传 `hasUsableClaim`)的文案分支不同——功能上不算缺陷(两条路径都能提示用户选择组织),但属未记录的行为差异,登记在案。

### 12.7 P3-7:Draft PR 现状(🔒 不可操作部分)

报告撰写时 `gh pr list --head feat/approval-template-groups-phase1-fe --state all` 返回空;**现状更正**:Draft PR #5854 现已存在。目标文档 DoD 的另一半——补充清单 #5/#6 两句披露写进 PR body——本轮硬规矩明确禁止编辑 PR 状态与 body,故只登记、不操作。留给下一次允许编辑 PR body 的轮次原样粘贴的两句:

1. 补充清单 #5:J 行「未知 `section=` 令牌 ⇒ 400」与 C 行「`?category=` 与 `section` 同现 ⇒ 400」——`section=` 到分期 3(A-4)才存在,首期(含 A-2)不可满足,已请示 owner 把这两句挪到 A-4 门,未决。
2. 补充清单 #6:分期门「1 落地」的求值(门审通过 vs 已合并)——已请示 owner 定义为「Draft PR 过门审」,本设计 MD 按此口径撰写,未决。
3.(本轮新增披露,建议一并写入 PR body)§12.4 记录的 `ApprovalTemplateGroupsPanel.spec.ts` 未进 `:477` 隔离行的理由。

### 12.8 P3-8:i18n 闭世界守卫新增两条测试(已通过 mutation 验证)

`apps/web/tests/templateCenterI18n.spec.ts` 新增两条守卫(不是简单地把两个文件名塞进 `CONVERTED_FILES` 数组——该数组只按下标被两个既有测试各读一次,不是被遍历的通用清单,加进去不会产生任何新覆盖):

- `SessionOrgSwitcher.vue`:按 `DEFAULT_COPY` 具名 bilingual 表分块(与 `ApprovalCenterView.vue` 守卫同一手法),表外扫描 CJK。
- `ApprovalTemplateGroupsPanel.vue`:该文件没有具名表,四处用户可见文案都是内联 `tr('English', '中文')` 调用——允许配对出现在同一调用里的 CJK,其余出现 CJK 一律判定为走私字符串。

两条测试都带正控(表/配对调用集合非空 + 确有 CJK)。**Mutation 验证**(`cp` 备份 → 注入未翻译中文 → 跑 → 全部按预期变红 → `cp` 还原 → `cmp` 字节相同):在 `SessionOrgSwitcher.vue` 的 `<label>` 内插入一段裸中文、在 `ApprovalTemplateGroupsPanel.vue` 的 create 按钮文案后追加一段裸中文,两条新守卫连同一条既有的 `TemplateCenterView` 渲染断言（因为该面板挂载在其下）一并变红(3 个测试失败);还原后 18/18 全绿。

### 12.9 P3-9:required 覆盖曾被单条超长 exec 行的 rebase 复制悄悄吞掉(卫生轮自身发现;根因经复核修正)

**复核修正(2026-09-19,报告 `p3-hygiene-gate-A2-20260919.md` §P2-1)**:本节最初版本把这处重复行的根因、影响范围与撤回对象都判断错了——错误方向是**把一份正确的旧证据判成假的**,并把一个**会在下一次 rebase 复发**的真实机制写成了"实现者在死副本上继续追加、无人发现"这种一次性失误。以下三段(根因/逐 head 核对/真机制)按复核报告原文改写。**代码修复本身(合并两条 exec 行为一条)是对的,不回退,本节改动只涉及叙事,不涉及任何代码或脚本回退。**

**措辞更正**(此前已修,予以保留):修复提交(`fix(approval): fold A-2's dead duplicate exec line...`)的 message 里「were never actually exercised by the required web-tests job」这句比事实宽——`web-tests` 那次运行仍然会跑活行里已有的 `templateCenterI18n`/`approvalTemplateCenterCategory`/`approvalTemplateGovernance` 三个 token,而这三份 spec 本身就会挂载 `ApprovalTemplateGroupsPanel`(P3-1 的挂载点普查),所以面板代码路径并非从未被跑过。准确的表述是本节标题的措辞:**`SessionOrgSwitcher.spec.ts`/`approvalTemplateGroupsClient`/`ApprovalTemplateGroupsPanel` 这三份带验收 J 断言的 spec 文件本身从未被 required job 执行**,不是"这个前端面从未被跑过"。commit message 已推送,不可改写,更正记在此处。

**如何被发现**:核对 P3-4 的「394/395 token」措辞时,重算 `run-required-web-tests.sh` 的最终 token 数,Python 脚本按文件里**第一条**匹配 `exec npx vitest run` 的行取值,结果与预期不符(394 而非应有的 397),顺着这条线索发现文件里有 **两条** `^exec npx vitest run` 开头的行,而不是一条。

**根因(逐 commit 机械核对;不是原始提交所加,是 rebase/三方合并对单条超长 exec 行的复制)**:

```
$ git log --oneline -S"exec npx vitest run" -- apps/web/scripts/run-required-web-tests.sh
96c512876 feat(approval): shared SessionOrgSwitcher component for template groups A-2
e0defbe26 ci(attendance): publish a stable web guard check (#4585)
```

**可达性披露(2026-09-19,第三次复核修正,`p3-hygiene-gate2-A2-20260919.md` §P3-4)**:下表点名的 3 个 SHA(`2699e0a07`/`2ef7add98`/`96c512876`)在本 PR 当前谱系(`origin/feat/approval-template-groups-phase1-fe`)里全部 `git merge-base --is-ancestor … HEAD` → NOT-ANCESTOR——原对象仍在本地 object store(`git cat-file -e` 可核),但 PR 读者 clone 后未必保留。"当前谱系对应件"一列按 author date + commit subject 逐字匹配定位(而不是内容 patch-id——三条里 `2ef7add98`/`96c512876` 与 `9685c6474` patch-id 相同,可独立验证是同一次改动的 rebase 副本;但 `2699e0a07` 作为改行前的**原始**编辑,其 diff 形状本身就与后续 rebase 副本的追加形状不同,因此**没有**独立于 `9685c6474` 之外的"原始编辑形状"对应件——这恰恰是本节机制段的证据之一:同一份改动被 rebase 后从"编辑"变成"追加"):

| commit | committer date 是否 = author date | `^exec npx vitest run` 行数 | numstat(该脚本) | 当前谱系对应件 |
|---|---|---|---|---|
| `2699e0a07`(**真正的原始提交**,author/committer 均 09-18 06:57:35) | 是 | **1** | **17 insertions / 1 deletion**(改写既有行 + 加 16 行注释) | 无独立对应件(见上方披露;其"编辑既有行"这一形状在当前谱系里已被 rebase 吸收进下一行的"追加"形状) |
| `2ef7add98`(`2699e0a07` 的 rebase 复制,committer 09-18 20:56:36) | **否** | **2** | **17 insertions / 0 deletions**(纯追加,含一整条 exec 行副本) | `9685c6474`(同一 author date + subject,patch-id 逐字相同) |
| `96c512876`(`2ef7add98` 的再一次 rebase 复制,committer 09-19 01:45:13) | 否 | 2(承袭) | 与 `2ef7add98` 逐字节相同(上一版复核已核实) | `9685c6474`(同一 author date + subject,patch-id 逐字相同——`2ef7add98`/`96c512876`/`9685c6474` 三者互为 rebase 副本) |

`2699e0a07` 与 `2ef7add98` author date 逐秒相同(同一份改动)、diff 形状却不同:`2699e0a07` 编辑既有行,`2ef7add98` 是纯追加、制造出一份副本。**上一版复核已验证 `96c512876` 与 `2ef7add98` diff 逐字节相同,但那只证明两个 rebase 副本互相一致,不能证明"重复"这件事本身是原始提交所为**——真正该对照的原件是 `2699e0a07`(该提交无重复,numstat 17/1),不是 `2ef7add98`(该提交已经是重复,numstat 17/0)。head commit `f3137d0de`「verified commit equivalence」验的是"副本↔副本"这一步,不是"原件↔副本"这一步。

**这条重复不是"此前的每一个 HEAD 上都存在"——逐 head 核对(exec 行数 + 三个新 token 命中位置)**:

下表同样按 author date + subject 定位当前谱系对应件——`0144932ac`(A-1 尖端)与 `cb9cdf9f6`(后来的 A-1 尖端)一并列入,供与上表"真机制"段交叉核对;`f3137d0de`(上一份报告的被审 head)对应件已在 §0 记录为 `c41710ab0`(树逐字节相同),此处一并收录:

| head | 说明 | exec 行数 | 三个新 token | 当前谱系对应件 |
|---|---|---|---|---|
| `0144932ac` | A-1 尖端(`2699e0a07^`) | 1 | 0(该行本身尚不含 `StockPreparationDataSourceRegistry`) | `a33f55796`(同 author date + subject) |
| `cb9cdf9f6` | 后来的 A-1 尖端(`2ef7add98^`) | 1 | 0,但**含** `StockPreparationDataSourceRegistry` | `fa73b39f0`(同 author date + subject) |
| `cb6d7fa9f` | 两份 MD 的写作 head | **1** | 全部命中,在唯一那条(活)行里 | `3a30f6ba2`(同 author date + subject) |
| `d3097be00` | 第 1 轮门审的被审 head | **1** | 全部命中,在唯一那条(活)行里 | `6e24b8854`(同 author date + subject;`d3097be00`/`5d0f780f5`/`b1e5c745f` 三者本身互为 rebase 副本,patch-id 逐字相同,故共享同一当前谱系对应件) |
| `5d0f780f5` | 本轮 rebase 前的尖端 | **2** | 只命中第二条(死)行;第一条(活)行零命中 | `6e24b8854`(同上) |
| `b1e5c745f` | `5d0f780f5` 的 rebase 等价物 | **2** | 同上 | `6e24b8854`(同上) |
| `f3137d0de` | 上一份报告(第 2 轮门审)的被审 head——**这是 P3-9 代码修复之后**的 head,不是之前;§0 已证 `git diff f3137d0de c41710ab0` 为空(树逐字节相同),现场 `git show f3137d0de:apps/web/scripts/run-required-web-tests.sh \| grep -c '^exec npx vitest run'` 复核 = **1**,与 `c41710ab0`/`f9cb22666` 同为修复后状态,不与上面几行的"修复前、含重复行"归为一类 | **1** | 全部命中,在唯一那条(活)行里 | `c41710ab0`(§0 已证树逐字节相同) |
| — | **当前谱系** | 1(修复后) | 全部命中,在唯一那条(活)行里 | `f9cb22666`(本文档被审 head) |

**第四次修正(2026-09-19)读数警告**:上表「当前谱系对应件」一列是 rebase **之后**的状态,其 exec 行数 / token 集合与本行本身的测量值**可能不同**——本表 3 行即如此(现场重跑):`cb6d7fa9f` 本行 exec 行数 **1**,对应件 `3a30f6ba2` 实测 exec 行数 **2**(`git show 3a30f6ba2:apps/web/scripts/run-required-web-tests.sh | grep -c '^exec npx vitest run'` → `2`);`d3097be00` 本行 **1**,对应件 `6e24b8854` 实测 **2**(同一命令 → `2`);`0144932ac` 本行写「该行本身尚不含 `StockPreparationDataSourceRegistry`」,对应件 `a33f55796` 实测**含有**(`git show a33f55796:apps/web/scripts/run-required-web-tests.sh | grep '^exec npx vitest run' | grep -o StockPreparationDataSourceRegistry | wc -l` → `1`,该行 token 数 399,`0144932ac` 本行 398)。对应件只用于确认"这次改动在当前谱系里是哪一条"(author date + subject 精确匹配,§4 已用 `origin/main..HEAD` 唯一性四重核),**不能**用来复现本行自己的读数——三者不同是 rebase 复制导致本行状态与对应件状态本就不同,不是测量误差或矛盾。

也就是说,**在被门审的那个 head(`d3097be00`)与两份 MD 撰写时的 head(`cb6d7fa9f`)上,三份 spec 确实在 required 的 `web-tests` job 里**——gate 报告 §1.4「令牌解析验证」与两份 MD §1/§2.1/§2.3 在它们各自运行的那个 head 上**都是对的**,不是被 `tail -1` / first-match 这两个工具的窗口盲区骗过。重复行是后来(committer date)09-18 20:56:36 那次 rebase 才制造出来的,发生在 `d3097be00` 之后、`5d0f780f5` 尖端形成之时。**上一版"此前的每一个 HEAD 上都是假的"这句全称式判断是一次错误撤回**——它撤销的是一份原本正确的证据(记忆:"失效标记要求值不要作废整节")。真正需要更正的只是"当前 HEAD"之前那些**含重复行**的 head(`5d0f780f5`/`b1e5c745f`),不是此前全部历史。

**真机制(此前未被记录,且是活风险)**:`2699e0a07^`(= A-1 尖端 `0144932ac`)那条 exec 行**不含** `StockPreparationDataSourceRegistry`;而 `2ef7add98^`(= 后来的 A-1 尖端 `cb9cdf9f6`)那条**已经含有**这个 token(现场 `git diff 2699e0a07^..2ef7add98^ -- apps/web/scripts/run-required-web-tests.sh` 确认这条巨行在两个 A-1 尖端之间已经独立变化过一次)。09-18 20:56:36 那次 rebase 把 A-2 对这条巨行的编辑(`2699e0a07`)重放到一个"同一条巨行已经被独立改过"的新基线(`cb9cdf9f6`)上:两边都改了同一条超长行,rebase/三方合并没有报冲突,而是把两份都保留了下来——A-2 新加的三个 token 落在后面追加的那份(从未被执行的)副本上。仓内已有两处独立实测记录**这条巨行就是并行车道在本仓库里的已知必冲点**,解法一贯是"取并集":`docs/development/integration-ui-consolidation-program-20260910.md:157`(「只冲一个文件的一行——`run-required-web-tests.sh` 的 `exec…`」,「解法是机械的:取并集——两侧出现过的每个 token 都保留,一个不删、不重复」)、`:167`(根治建议:改成每行一个 token,当时刻意未做);以及 `docs/development/multitable-remaining-development-inventory-and-sequencing-20260712.md:112`(「冲突解错会静默丢 token 且 CI 零信号」「冲突一律解成 UNION」)。**未验证**09-18 20:56:36 那次 rebase 具体由谁在什么命令下发起,只证到重复行确实源自这次 rebase、以及它是"同一条巨行各自独立演进"的产物,不是任何一次显式冲突解决时人为选错分支。

**为什么这不是记账级问题(会复发,且现有读取者都测不出)**:
(a) #5854 是堆叠分支,合并前必然再 rebase 至少一次;这条巨行已被证实是本仓库跨车道并行开发时的已知反复冲突点,同一种"三方合并把两份都留下"的失败模式没有理由不再发生一次。
(b) **修复前**仓内没有任何守卫断言 `^exec npx vitest run` 只有一条(`git grep` 实测零命中;本轮新增的 `scripts/dev/atg-exec-line-post-rebase-check.sh` 是人工前置,不在任何 CI lane / vitest 配置内,不构成"守卫",故不推翻这句"零命中")。已知会读这条 exec 行的至少有四处,分两种语义,两种都测不出死副本:
  - **first-match / tail 语义**(只取命中的第一条或最后一条,新增第二条时会读到"某一条"、但不会把另一条的 token 算进"已覆盖"):`apps/web/tests/attendance-web-guard-workflow.spec.ts:57`、`plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs:2888`、MD 自己的 §2.3 脚本。
  - **并集语义**(遍历所有匹配 `vitest run` 的逻辑行,把每一行的 token 都并起来,不判断该行是否会被前面的无条件 `exec` 短路):见 (c)。
(c) **并集语义的读取者现场核实有两处,不是一处**:`packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts` 的 `extractVitestTokensFromBashScript`(`:119-145`)与 `packages/core-backend/tests/unit/network-unavailable-copy-ci-wiring.test.ts` 的 `requiredLaneTokens`(`:61-79`,现场读了实现——`for (const line of joined.split('\n'))` 遍历每一条含 `vitest run` 的逻辑行,逐行把 token 追加进同一个数组,同样不区分某一行是否可达)。这一类的失真方向更隐蔽:死副本上的 token 会被两处都判定"已进入 required lane",看起来像覆盖到了,实际上从未被执行到。修复前,这两处守卫对这三份 spec 的 covered 判定本身就是错的。

**机械前置(供未来 rebase,供下一轮/下一次改动这条 exec 行时核)**:任何一次改动或合并涉及 `apps/web/scripts/run-required-web-tests.sh` 的这条 `exec npx vitest run` 巨行之后,必须核两件事:①`grep -c "^exec npx vitest run" apps/web/scripts/run-required-web-tests.sh` 恒等于 1;②如果 rebase/合并呈现过该行的两个版本,合并后单行的 token 集合必须等于两个版本 token 集合的**并集**(不丢、不重复)。机械脚本见本轮新增的 `scripts/dev/atg-exec-line-post-rebase-check.sh`(只读,不改脚本本体;退出码非零时打印重复行数与——若提供两个待比较的 ref——双向 token 差集,供人工核对)。**实现口径更正(2026-09-19,第三次复核修正)**:脚本把"等于并集"拆成两个独立检查而不是一次相等性比较——Check 2 只看当前这一行内部有没有重复 token(与任何 ref 无关),Check 3 只看当前 token 集合是否为 `<ref-a>`/`<ref-b>` 并集的**超集**(不丢);二者合起来买到的是"不丢(超集)+ 当前行内不重复"这个更弱的性质,不等价于"等于并集"这个更强的相等性质——如果未来在 `<ref-a>`/`<ref-b>` 之外又混入了一个全新的、任一 ref 都没有的 token,Check 3 仍会 PASS(超集允许多出的元素),需要人工核对该新 token 是否是这次改动本身有意引入的。

**修复本身(scripts/dev,本轮允许改;不回退)**:合并两行为一行——死副本独有的三个新 token(`SessionOrgSwitcher.spec.ts`/`approvalTemplateGroupsClient`/`ApprovalTemplateGroupsPanel`,丢弃死副本里重复的 `categoryCandidateInput`,活行里已有)追加到活行的 `--reporter=dot` 之前;删除死副本整行;三段说明注释一并移到活行之前并修正措辞(P3-4)。

```
$ grep -c "^exec npx vitest run" apps/web/scripts/run-required-web-tests.sh
1
$ bash -n apps/web/scripts/run-required-web-tests.sh; echo "exit=$?"
exit=0
$ pnpm --filter @metasheet/web exec vitest run SessionOrgSwitcher.spec.ts approvalTemplateGroupsClient ApprovalTemplateGroupsPanel --reporter=dot
 Test Files  4 passed (4)
      Tests  15 passed (15)
```

Token 计数重算(合并后):`run-required-web-tests.sh` 从报告记录的 394/395/396(三次开发中途快照)变为 **397**(392 条共享前缀 + `categoryCandidateInput` + `StockPreparationDataSourceRegistry`,这两个是 rebase 带入的、A-2 之外的既有 token + 本切片 3 个新 token);双向子串碰撞扫描零命中。`approval-web-guard.yml:1026` 那一行本身没有这个重复行问题(核对 `run: pnpm --filter @metasheet/web exec vitest run` 只有 2 处匹配,与报告一致,:925 是无关 job);其 YAML 可解析、job key 唯一(`approval-web-guard`),该文件 push/pull_request 两个 `paths` 列表之间存在一处非对称缺口(6 个既有 approval 文件只在 pull_request 侧、不在 push 侧),但该缺口在 rebase 前的 A-1 尖端就已存在,与本切片改动无关,不在本轮范围内,不处理。

**影响声明更正(2026-09-19 复核修正)**:上一版在此处写"gate 报告 §1.4 与两份 MD 的 §1/§2.1/§2.3 在当前 HEAD 之前的所有历史 HEAD 上……结论都是假的"——按上文逐 head 核对,这句话不成立。准确的表述是:那几份结论**在它们各自运行的那个 head(`cb6d7fa9f`/`d3097be00`)上是真的**;只是重复行导致后来的 head(`5d0f780f5`及其 rebase 等价物 `b1e5c745f`,直到本次修复提交为止)不再具备同样的性质。DRAFT-READY 裁决本身建立在直接现场重跑三份 spec(而非依赖这条 exec 行)得到的绿证据上,裁决不受影响;但任何引用"required 覆盖已确认"这句话的后续文档,如果指向的是本次修复提交**之前、含重复行的那些 head**,都应改指向本节和本次修复的 commit,不再引用报告 §1.4 原文在那些 head 上的现场输出作为"required 覆盖"的证据——但不应把这句更正泛化成对 `cb6d7fa9f`/`d3097be00` 那两个更早、单行、结论本就正确的 head 的否定。

### 12.10 撤回类改动扫描(实测结果,非"零命中"——按"求值,不作废整节"的纪律逐条判读)

本轮涉及撤回/更正的措辞(P3-4 的「lands in a later slice with its own token」;「394/395 tokens」快照)现场全分支 `git grep` 实测**并非零命中**——命中的都是修正句自身引用旧文措辞做说明,不是旧断言仍然独立成立地站着：

```
$ git grep -n "lands in a later slice" -- '*.sh' '*.md' '*.yml'
apps/web/scripts/run-required-web-tests.sh:1202:# hygiene wave, 2026-09-19: this sentence originally said "lands in a later slice with its own
docs/development/approval-template-groups-phase1-fe-verification-20260918.md:(本节表格行 + 本段说明)
$ git grep -n "394 tokens\|395 tokens" -- apps/web/scripts/run-required-web-tests.sh
apps/web/scripts/run-required-web-tests.sh:1213:# original "394 tokens" snapshot); ...
apps/web/scripts/run-required-web-tests.sh:1233:# ... why this moved from the original "395 tokens" snapshot); ...
```

逐条判读:两处脚本内命中都在「this sentence originally said / moved from the original "N tokens" snapshot」这一修正句式之内,是**引用旧文本以说明已被修正**,不是旧断言以独立、无限定的形式重新出现;本文档内的命中就是本节自身的表格与说明。真正需要检验的判据是「文件里是否还有一处**不带修正限定**的『lands in a later slice』或『394/395 tokens』」——`grep -c`该无限定形态为 0(唯一出现处都紧跟在「originally said / moved from」这类回顾性短语之后)。按「失效标记要求值不要作废整节」的纪律:P3-4 要撤回的是"这句话仍然成立"这个论断,不是"这几个字符串不得再出现"这件事本身。

### 12.11 diffstat 证据:本轮只动测试/注释/MD/scripts

起点取本轮 rebase 后的 HEAD(`b1e5c745f8fbc6d63987223d3af1e56b9b835ef5`,rebase+force-push 完成、卫生轮编辑开始之前)——而不是 A-1 尖端,因为对 A-1 尖端取 diff 会把 rebase 带入的 159 文件 / 22k 行 main 主线改动也算进来,淹没本轮真正的改动面:

```
$ git diff --stat b1e5c745f8fbc6d63987223d3af1e56b9b835ef5
 apps/web/scripts/run-required-web-tests.sh                                  |  36 ++++--
 apps/web/tests/templateCenterI18n.spec.ts                                   |  62 ++++++++++
 docs/development/approval-template-groups-phase1-fe-design-20260918.md      |   2 +-
 docs/development/approval-template-groups-phase1-fe-verification-20260918.md| 133 ++++++++++++++++++++-
 4 files changed, 222 insertions(+), 11 deletions(-)
```

四个文件全部落在 scripts / 测试 / MD 三类,零 `src/**` 生产代码改动(`ApprovalTemplateGroupsPanel.spec.ts` 的 P3-5 尝试性 mock 改动已用 `cp` 逐字节还原,不出现在这份 diffstat 里)。

### 12.12 复核修正(2026-09-19)— diffstat 证据:只动 MD/scripts/dev

对象:独立门审 `p3-hygiene-gate-A2-20260919.md`(NEEDS-FIX,0 P1/1 P2/6 P3)。本节处置该报告的 P2-1(§12.9 根因/全称撤回/影响声明三处证伪)与报告自身 findings §P3-1(§12.5 DEFERRED 理由口径错,对应本文档 P3-5)。报告裁决原文只记 1 条 P2(`P2-1`);其余 6 条落在报告自定的"新 P3 只记不阻塞"收敛口径内,本轮不逐条处理,留给下一次允许更广改动面的轮次(报告 §5 的 P3-2..P3-6 分别涉及生产代码判据强度、mutation 证据形状、DOM id 共享等,均非本轮"只改 MD/注释/scripts/dev"能安全闭合的项)。

硬规矩:生产代码零行为改动;只许 MD/注释/scripts/dev;不动 PR 状态与 body;不改锁文;不 rebase 到 base 分支。**谱系陈述更正(2026-09-19,第三次复核修正,`p3-hygiene-gate2-A2-20260919.md` §P3-5)**:上一版这里写"本轮未再次 rebase"——字面在"改写提交之后未再 rebase"这个意义上成立,但读起来像"自上次门审以来谱系未变",而谱系已变,容易误导。如实的顺序是:本节改写提交(`f9cb22666`,当时的分支尖端)之前,曾对上一轮门审的被审 head 做过一次 `git rebase origin/main` 保活——`f3137d0de`(上一份报告的被审 head)→ `c41710ab0`(rebase 后的尖端,§0 已证 `git diff f3137d0de c41710ab0` 为空、树逐字节不变,只是 75 个祖先提交的 hash 全部改写)→ `f9cb22666`(在 `c41710ab0` 上追加本节 §12.9/§12.11/§12.12 的卫生修复,得到当时的分支尖端);`f9cb22666` 之后(本轮,第三次复核修正)只追加新提交,未再 rebase。

```
$ git diff --name-status c41710ab0
M	docs/development/approval-template-groups-phase1-fe-verification-20260918.md
A	scripts/dev/atg-exec-line-post-rebase-check.sh
```

`--name-status`(而不是 `--stat` 的行数/字节数)是本节的主要证据,因为它在这段文字自己被写入文件之后再重跑也不会变——`--stat` 的行数会随着"把这段证据本身写进文档"这个动作而回退性地对不上,是自指的。**第五次修正(`p3-hygiene-gate4-A2-20260919.md` §P2-1)**:原文此处随附的一次性 `git diff --stat c41710ab0` 快照已删除,不重填新值——任何填进来的数字在写下的同一刻就已被"把它写进文档"这个动作本身改掉,填一次就再造一条同类断言。

两个文件零 `src/**`、零 `apps/web/tests/**`、零 `packages/**`、零迁移、零 workflow、零锁文——全部落在"验证 MD"与"新增的 scripts/dev 只读检查脚本"两类。`scripts/dev/atg-exec-line-post-rebase-check.sh` 不是测试文件(不在任何 `tests/`、不带 `.spec.`/`.test.` 后缀、不被任何 CI workflow 或 vitest 配置引用),是 §12.9"机械前置"要求的独立小工具;本轮亲跑三条自测(正控:对本次真实的 bug 提交 `b1e5c745f` 复现检测出 2 条 exec 行,退出码 1;正控:对当前已修复文件 + `cb6d7fa9f`/`d3097be00` 两个真实 head 跑 union 检查,退出码 0;负控攻判据:临时把当前文件的 exec 行摘掉一个 token 后再跑,退出码 2 且报出被摘掉的具体 token),跑完用 `cp` 备份/还原、`cmp` 确认字节相同,`git status --porcelain` 对被 mutate 的文件为空。**退出码更正(第三次复核修正)**:上一句"退出码 2"是旧脚本(两检查版本)的编号;脚本改成三检查(新增独立的"不重复"判定)后,原来"缺 token"这半条判据的退出码改为 **3**(重跑上面同一个负控探针——对当前文件真实摘掉 `ApprovalTemplateGroupsPanel` 后跑 `cb6d7fa9f`/`d3097be00` union 检查——现场复现 `FAIL: … MISSING: ApprovalTemplateGroupsPanel`、`EXIT=3`,`cp` 备份/还原、`cmp` 字节相同);脚本自身头部注释与本文档处置表(第三次修正 P3-1/P3-2)已同步为新编号,此处历史记录不回改,仅在此更正指向。

**撤回类改动自扫(第三次复核修正,2026-09-19)**:比照 §12.10 的纪律,对本节改写自己扫一遍。**上一版此处的三条转录不是真实命令输出**——已被独立复核门审 `p3-hygiene-gate-A2-20260919.md` §P2-2 证伪:前两条把 `git grep -n` 的多行原始输出各压成一句括号内的概括,并把真实命中数说成 1;第三条的"零命中"与"不是引用后限定这种保留形式"两句,都被同一条命令的真实输出推翻。以下三条**去掉 `-- '*.md'`,改为全仓 `-- .`**、只取 `file:line`(不截取内容——上一版的问题正是编造内容摘要充当命令输出,这次不重犯)、逐字重跑。每条命令的搜索串本身会在下方 code fence 里出现一次,因此该命令行自身构成一条"自指"命中(展示搜索模式必然如此),不当残留计:

```
$ git grep -n "此前的每一个" -- . | cut -d: -f1 | sort | uniq -c
   5 docs/development/approval-template-groups-phase1-fe-verification-20260918.md
```

命中集中在本 MD 一个文件内(计数见上),不是上一版压成一句括号概括时暗示的单条命中。**第五次修正(`p3-hygiene-gate4-A2-20260919.md` §P3-1)**:本条及下方三条的输出一律从 `cut -d: -f1,2` 的行号清单改为 `cut -d: -f1 | sort | uniq -c` 的"文件 + 计数",判读改用符号锚点——硬编码行号在文档自身持续编辑时必然漂移,上一轮点名修了一个,同段落的兄弟一个没扫,本轮整批换掉。正文命中分别落在:复核修正段(用"本节最初的这条更正说……——这句全称式判断是错的"的回顾句式转述并撤销)、§12.1 处置表里转述报告原文指出错误的那一行、§12.9 一处小标题式的否定句("这条重复不是……——逐 head 核对……")、"……这句全称式判断是一次错误撤回";此外本条命令行自身构成一条自指命中。**逐条判读:回顾式/自指,零处以"成立"口吻残留。**

```
$ git grep -n "无人发现" -- . | cut -d: -f1 | sort | uniq -c
   3 docs/development/approval-template-groups-phase1-fe-verification-20260918.md
```

命中集中在本 MD 一个文件内(计数见上),不是上一版暗示的单条命中。正文命中落在 §12.1 处置表那一行,以及 §12.9 里转述并撤销原根因描述("实现者在死副本上继续追加"那句的后半)的段落;此外本条命令行自身构成一条自指命中。**回顾式/自指,零处以"成立"口吻残留。**

```
$ git grep -n "在.*之前的所有历史 HEAD 上.*都是假的" -- . | cut -d: -f1 | sort | uniq -c
   2 docs/development/approval-template-groups-phase1-fe-verification-20260918.md
```

命中集中在本 MD 一个文件内(计数见上),不是上一版声称的零命中。**第四次修正锚点更正**:上一版此处写死行号`:644`——独立复核门审(`p3-hygiene-gate3-A2-20260919.md` §P3-3)实测该行号在**被审 head**(`7dc349c7c37e6ed470f6db84a43ee03ea660ff86`,该次修正前的分支尖端)上是**空行**(`git show 7dc349c7c:docs/development/approval-template-groups-phase1-fe-verification-20260918.md \| sed -n '644p'` → 空),`:644` 是原样抄自上一份门审报告(`p3-hygiene-gate2-A2-20260919.md` §P2-2 表格)里的行号,那一轮的编辑早已使正文行号下移;硬编码的精确行号在文档自身持续编辑时必然漂移。**第五次修正(§P2-1/§P3-1)**:原文此处还附了一段"该命中在编辑过程中先后落到哪几个行号"的叙述——那是未提交工作树的中间状态,没有任何命令能把它重跑出来,已整段删除,不重填。改用符号锚点,**且不写死具体行号**:命中该处的段落标题是"**影响声明更正(2026-09-19 复核修正)**",现场执行 `git grep -n "影响声明更正" -- docs/development/approval-template-groups-phase1-fe-verification-20260918.md` 取值即可定位。该段正文把这句被证伪的全称断言完整放在引号内、紧跟"按上文逐 head 核对,这句话不成立"——**恰恰就是**上一版宣称不存在的那种"引用后限定"保留形式(整句原文保留,不是"originally said"式的部分改写);此外本条命令行自身构成一条自指命中。**回顾式/自指,零处以"成立"口吻残留**——但上一版"零命中"与"不是引用后限定这种保留形式"两句表述本身是假的,已在本段开头更正,不再以转录形式重复出现在别处。

三条搜索串给出的判读结论一致:被证伪的旧结论只以"上一版说过……"这类回顾性引用形式存在,没有一处以独立、无限定的当前事实口吻重新站立。按"失效标记要求值不要作废整节"的纪律,本节要撤回的是旧版 §12.9 那三处结论本身,而不是这些字符串一旦出现就必须清零——只要出现处都带着否定/回顾限定,就合乎要求。

**P2-1 本身的四句英文原句也补一遍全仓机械扫描**(不只中文三串;§12.12 上一版的自扫范围本来就是因为带 `-- '*.md'` 才漏看 `.sh` 里的英文原句,这次连带把原文一起扫,不能只信"改过了"这句自我陈述)。以下命令只取 `file:line`(不取内容——原因见 §12.12 开头的教训:取内容会把搜索串再嵌入一次,自我放大命中数)。命令自身的搜索串会在下方 code fence 里出现一次,构成 1 条自指命中:

```
$ git grep -nE 'were ever exercised|added the duplicate copy rather than editing|without anyone noticing|picked the wrong one' -- . | cut -d: -f1 | sort | uniq -c
   1 docs/development/approval-lock10-instance-readability-20260821.md
   2 docs/development/approval-template-groups-phase1-fe-verification-20260918.md
```

`docs/development/approval-lock10-instance-readability-20260821.md` 那一处与本次改动完全无关(另一份设计文档,谈的是另一套锁的 C-1/C-3 关系,巧合命中四句里的一句);本 MD 的命中分别是 §12.1 处置表里转述被撤回原句以说明处置内容的那一行,以及本条命令行自身。上面的文件清单里没有 `apps/web/scripts/run-required-web-tests.sh`——四句被证伪的英文原句在该文件里已被 P2-1 的改写完全替换,不是部分保留或仅加限定词。

### 12.13 第三次修正 diffstat 证据

对象:独立复核门审 `p3-hygiene-gate2-A2-20260919.md`(NEEDS-FIX,0 P1/2 P2/5 P3),被审 head `f9cb22666`。比照 §12.12 自己的论证——`--name-status` 而不是 `--stat` 的行数/字节数才是不自指的证据(`--stat` 的插入行数会因为"把这段证据写进文档"这个动作本身而在下一次编辑后过期):

```
$ git diff --name-status f9cb22666
M	apps/web/scripts/run-required-web-tests.sh
M	docs/development/approval-template-groups-phase1-fe-verification-20260918.md
M	scripts/dev/atg-exec-line-post-rebase-check.sh
```

三个文件,零 `src/**`、零 `apps/web/tests/**`、零 `packages/**`、零迁移、零 workflow、零锁文——全部落在"生产脚本的注释块"(`run-required-web-tests.sh`,exec 行本身未改,见 P2-1 disposition 行与 §12.15 的 `shasum` 核对)、"验证 MD"(本文档)、"scripts/dev 只读检查脚本"三类,与本轮硬规矩("只许 MD/注释/scripts/dev")一致。

**第五次修正(2026-09-19,`p3-hygiene-gate4-A2-20260919.md` §P2-1)—— 两份 `--stat` 快照整块删除,不重填**:本节原先有两个 `git diff --stat f9cb22666` code fence(第三次修正写下的一份,第四次修正"就地重跑更新数字"的一份),已全部删除。门审点名的缺陷不是"快照过期"这种良性自指,而是:第四次修正那份写进来的值**逐字是上一个提交的值,也正是门审报告自己在另一个提交上测得的值**,却被标注成"本节写作时现场跑"的输出——没有任何一次 `git diff --stat f9cb22666` 在那个 head 上会打印它。再填一个"更准的"数字只会在写下的同一刻再造一条同类断言(写入动作本身就改变插入行数),所以本轮**只删不填**。`--name-status`(上方 code fence)才是本节的判据:它不随文档自身编辑漂移,本轮已现场重跑,重跑记录见 §12.15。

### 12.14 第四次修正(2026-09-19)—— 事实断言 ⇄ 命令对账表

对象:独立复核门审 `p3-hygiene-gate3-A2-20260919.md`(NEEDS-FIX)。本节规则:本轮改写或新增的每一条关于提交/行/token 的事实断言,都在下表附一条可重跑命令与其现场输出;没有命令支撑的一律标"未测量"。**第五次修正(`p3-hygiene-gate4-A2-20260919.md` §P2-1)**:本节原先在此处的括号("本轮未发现需要如此标注的新断言……")与表末的绝对断言收尾均已删除——门审实测该收尾有三个各自独立的证伪点,其中一条正是把另一个提交的值标成本次运行的输出。

| 断言 | 命令 | 现场输出 |
|---|---|---|
| `2699e0a07` 本身 numstat 为 17 insertions / 1 deletion | `git show --numstat 2699e0a07 -- apps/web/scripts/run-required-web-tests.sh` | `17\t1\tapps/web/scripts/run-required-web-tests.sh` |
| `2699e0a07` 相对 `0144932ac` 的 exec 行 token 差异只有 `SessionOrgSwitcher.spec.ts` 一项(398→399) | `diff <(git show 0144932ac:…\|grep '^exec…'\|tr ' ' '\n'\|sort) <(git show 2699e0a07:…\|同\|sort)` | `345a346`<br>`> SessionOrgSwitcher.spec.ts`(其余 398 行逐行相同) |
| `approvalTemplateGroupsClient` 最早落在 exec 行是 `1e55c39b8`,author date 2026-09-18 07:10:50 | `git log --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M:%S' -S'approvalTemplateGroupsClient' -- apps/web/scripts/run-required-web-tests.sh` | 最早一条:`1e55c39b8 2026-09-18 07:10:50 feat(approval): typed frontend client for the seven template-group endpoints` |
| `ApprovalTemplateGroupsPanel` 最早落在 exec 行是 `bc66e283e`,author date 2026-09-18 07:33:18 | 同上,`-S'ApprovalTemplateGroupsPanel'` | 最早一条:`bc66e283e 2026-09-18 07:33:18 feat(approval): wire session-org 403 retry into the template groups panel` |
| 三轮改写脚本注释后 exec 行逐字节零改动(第三次 / 第四次 / 第五次修正) | `for r in f9cb22666 7dc349c7c ca5d50b71; do git show $r:apps/web/scripts/run-required-web-tests.sh \| grep '^exec npx vitest run' \| shasum -a 256; done`,再对改后工作树跑一次同样的 `grep \| shasum`;另 `grep -c '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh` | 四次 `shasum` 输出逐字相同(`da4a2ba1e04c1d341c2cee05d1e50360e82408d792f305f51dd5370ebe77b30d`),`grep -c` 为 `1`;逐字输出见 §12.15 |
| `bash -n` 对改后脚本仍通过 | `bash -n apps/web/scripts/run-required-web-tests.sh; echo exit=$?` | `exit=0` |
| `cb6d7fa9f` 本行 exec 行数 1,其"当前谱系对应件"`3a30f6ba2` 实测 exec 行数 2 | `git show <sha>:apps/web/scripts/run-required-web-tests.sh \| grep -c '^exec npx vitest run'`(两个 sha 各跑一次) | `cb6d7fa9f` → `1`;`3a30f6ba2` → `2` |
| `d3097be00` 本行 exec 行数 1,对应件 `6e24b8854` 实测 2 | 同上命令,换 sha | `d3097be00` → `1`;`6e24b8854` → `2` |
| `0144932ac` 的 exec 行不含 `StockPreparationDataSourceRegistry`,对应件 `a33f55796` 含有,token 数 398→399 | `git show <sha>:…\|grep -c StockPreparationDataSourceRegistry`;`…\|grep '^exec…'\|grep -o StockPreparationDataSourceRegistry\|wc -l`;`…\|grep '^exec…'\|tr ' ' '\n'\|grep -v '^$'\|wc -l` | `0144932ac` 含 `StockPreparationDataSourceRegistry` 计数 `0`,token 数 `398`;`a33f55796` 该 token 计数 `1`,token 数 `399` |
| P3-3 那句"零命中"对 `.sh` 文件为真、对整仓（含本 MD）为假 | `git grep -n "real precondition gate\|reporting-only tool" -- apps/web/scripts/run-required-web-tests.sh`(限定脚本文件) | 空输出——脚本文件内确为零命中,这是不随 MD 自身编辑漂移的判据 |
| 同一命令不限定路径时,对本 MD 的命中数不固定(本表刻意不写死数字——写下"当前命中 N 处"这句话本身就会在文档里再添一次引用,让 N 立刻变成 N+1) | `git grep -n "real precondition gate\|reporting-only tool" -- .` | 命中第三次修正 P3-3 行与第四次修正 P3-2 行(符号定位,本表不写死行号),加上本表任何转述本身;确切总数请读者现场重跑该命令,本表不记录、不承诺 |
| `:644` 在**被审 head**(`7dc349c7c`,本次修正前的分支尖端)上是空行——注意不是"当前工作树第 644 行"这个会漂移的坐标,本次修正提交后工作树的物理 `:644` 已变成另一句话,预期内 | `git show 7dc349c7c:docs/development/approval-template-groups-phase1-fe-verification-20260918.md \| sed -n '644p'` | 空输出 |
| "影响声明更正"段用符号锚点定位,不写死行号 | `git grep -n "影响声明更正" -- docs/development/approval-template-groups-phase1-fe-verification-20260918.md` | 现场取值即为准确行号;本表不转录具体数字,避免制造下一条过期断言 |
| `--name-status` 三文件不因编辑轮次而变 | `git diff --name-status f9cb22666` | 三行,与第三次修正记录逐字相同(见上方 §12.13 与本节) |

上表每一行的命令,都在本次第五次修正的树上重跑过一次(父提交 `ca5d50b71`;提交后 `git status --porcelain` 为空,故工作树与提交树一致),输出即各行"现场输出"列所载,未做转抄。§1–§11 与本节之外的 §12.0–§12.13 历史段落不在本轮点名范围内,本轮未重新逐句复核,不在此表列出。

**收尾核验(本次修正提交前,现场跑)**:

```
$ bash -n apps/web/scripts/run-required-web-tests.sh; echo exit=$?
exit=0
$ bash -e apps/web/scripts/run-required-web-tests.sh
 Test Files  470 passed (470)
      Tests  7240 passed (7240)
      Duration    47.59s
exit=0
```

470/7240 与第三次修正记录的数字逐格相同,符合预期(`apps/web/src`、`apps/web/tests`、`packages` 三向 diff 仍为空,本轮只动注释与 MD)。**如实记录一次未复现的瑕疵**:同一条命令在这两次干净通过之间,曾有一次独立尝试在测试全部通过、汇总行(`Test Files 470 passed`/`Tests 7240 passed`)打印之后,于 vitest worker 线程退出阶段撞上 Node v25.9.0 的一次原生崩溃(`FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal`,JS 栈指向 `node:internal/modules/esm/translators` 的 CJS 互操作路径),导致进程以非零码退出——发生在测试汇总已经打印"全绿"之后的 worker 收尾阶段,与本轮改动(纯注释,exec 行逐字节未变)无因果关系;换回同一条命令立即复现绿(见上方 code fence),不再复现该崩溃,判定为环境级瞬时故障(Node 运行时内部崩溃),不作为本次改动的回归证据,也不掩盖它——如实记录在此,供下一轮如再次撞见时比对。

### 12.15 第五次修正(2026-09-19)—— 删除自指数字、行号换符号锚点

对象:独立复核门审 `p3-hygiene-gate4-A2-20260919.md`(NEEDS-FIX),被审 head 即本次修正的父提交 `ca5d50b71`。本轮方法论由任务书点名:**只删不加,不手写任何数字**——凡是本轮无法当场重跑出来的数字(自指的 `--stat` 快照、未提交工作树的编辑过程叙述)一律删除而不重填;凡是"全部 / 每次都 / 无需"一类的绝对收尾一律删除;留下的每一个数字都必须是本轮某条命令的逐字输出,命令与输出写在同一格或同一 code fence 内。

**本次修正的改动面**(判据是文件清单,不是行数;故用 `--name-status`):

```
$ git diff --name-status ca5d50b71
M	apps/web/scripts/run-required-web-tests.sh
M	docs/development/approval-template-groups-phase1-fe-verification-20260918.md
```

**exec 行逐字节零改动**(三个历史提交 + 改后工作树各跑一次):

```
$ for r in f9cb22666 7dc349c7c ca5d50b71; do git show $r:apps/web/scripts/run-required-web-tests.sh | grep '^exec npx vitest run' | shasum -a 256; done
da4a2ba1e04c1d341c2cee05d1e50360e82408d792f305f51dd5370ebe77b30d  -
da4a2ba1e04c1d341c2cee05d1e50360e82408d792f305f51dd5370ebe77b30d  -
da4a2ba1e04c1d341c2cee05d1e50360e82408d792f305f51dd5370ebe77b30d  -
$ grep '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh | shasum -a 256
da4a2ba1e04c1d341c2cee05d1e50360e82408d792f305f51dd5370ebe77b30d  -
$ grep -c '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh
1
```

**§12.13 的判据 `--name-status` 现场重跑**:

```
$ git diff --name-status f9cb22666
M	apps/web/scripts/run-required-web-tests.sh
M	docs/development/approval-template-groups-phase1-fe-verification-20260918.md
M	scripts/dev/atg-exec-line-post-rebase-check.sh
```

**`bash -n` 与 required lane 逐字复现**:

```
$ bash -n apps/web/scripts/run-required-web-tests.sh; echo exit=$?
exit=0
$ bash -e apps/web/scripts/run-required-web-tests.sh
 Test Files  470 passed (470)
      Tests  7240 passed (7240)
   Start at  07:27:35
   Duration  47.73s (transform 24.93s, setup 3.07s, collect 138.15s, tests 187.99s, environment 89.80s, prepare 17.79s)
LANE_EXIT=0
```

**自查**:§12.12 的四个自扫 code fence 在本节全部写完之后又各重跑一次,输出与 fence 内所载逐字相同(这四条的输出只含文件名与计数、不含搜索串,所以把输出写进文档不会改变命中数——这正是改用 `uniq -c` 的附带好处)。本轮新增行的数字自扫跑的是 `git diff -U0 ca5d50b71 -- docs/development/approval-template-groups-phase1-fe-verification-20260918.md | grep '^+' | grep -v '^+++' | grep -nE '[0-9]'`,命中行逐条判读,其中两行因找不到能产生该数字的命令而就地删除:处置表「第四次修正 — P3-4」行里转录的两组 `--stat` 插入行数,以及 §12.14 抬头转录的门审票数。**本节不对"其余每一行都有命令"下全称结论**——那正是上一轮被证伪的收尾形状;自扫用的命令写在上面,读者可自行重跑并自行判读。

**本轮未处理、如实披露**:§12.11 的 `git diff --stat b1e5c745f…` code fence 是卫生轮首轮写下的证据,同样是对工作树取的自指 diffstat,其插入行数在此后每一次编辑后都会过期。本轮门审未点名该处,按"只改点名范围"未动它;留给下一轮判定是删除还是改成 `--name-status`。
