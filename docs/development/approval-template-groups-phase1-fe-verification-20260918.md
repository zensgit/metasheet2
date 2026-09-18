# 审批表单分组 Phase 1(切片 A-2 前端)— 验证 MD

- 锁文:`approval-form-group-entity-design-lock-draft-20260916.md`(**v2.13 RATIFIED 2026-09-18**)
- 设计 MD(同批交付):`approval-template-groups-phase1-fe-design-20260918.md`
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片「A 分组 / A-2 前端脱困」)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md`(三线共用 #1–#4、lane A #5–#7)
- worktree HEAD(本文档写作起点):`cb6d7fa9f97b02438f0d0f36c8fb955870f9e2e8`;分支 `feat/approval-template-groups-phase1-fe`,堆叠在 `feat/approval-template-groups-phase1`(A-1,尖端 `0144932ac67e80a81f204dd6c6e502d000112276`,与本分支的 merge-base 相同——零漂移)
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
