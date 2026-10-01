# 审批旗标账扩写 + 下发键对账守卫(F2-M2)— 设计与验证(2026-09-30)

- **基线**:`main@cffd5dacbc`。分支 `chore/approval-flag-ledger-and-payload-key-guard`。
- **授权**:owner 2026-09-30 原话「按建议执行」。这句话答复的建议第 1 项原文为「启动第一波四片,做成 Draft PR」,并写明「不包含的:任何合并、#6187、锁的 ratify、开关、部署、生产普查」。F2-M2 属于第一波:见私有记录。
- **状态**:待门审。本文和各项改动都不构成开关、合并或部署授权。

## 1. 改了什么

| 提交 | 内容 |
|---|---|
| `5471403889`(docs) | `approval-parity-execution-ledger-20260817.md` §7「Flag and environment ledger」原位扩写。原六列保留,右侧追加五列:Env var / Resolver(file:line)/ Payload key / Truth rule / Owning line。原六行只复核 Code default,其余四列原样保留。新增 11 行:审批移动端占位(待 F2-M1)、请假撤销轮入口、目录失活,以及 `buildFeaturePayload` 的另外 8 个非审批键。 |
| `d25e25ec42`(test) | 新增 `packages/core-backend/tests/unit/approval-feature-payload-flag-ledger.test.ts`(无库单测):`buildFeaturePayload` 返回对象字面量的全部键 ⊆ §7 的 Payload key 列。 |
| `5fc1ac9e84`(docs) | 复核后的精度修订:全节统一路径规则(原规则漏了 Canvas 行引用的 `scripts/`);Code default 注释补上前端会话后的兜底(缺键或探针失败时,审批键、W6、学习仍解析为 `false`);PLM / 产品模式两行写明 `PRODUCT_MODE` 精确匹配及其别名,只有 `ENABLE_PLM` 做 trim + 小写化;W6 行写明租户 id 缺失或为空即 OFF。 |
| `0c53de5d2d`(docs) | W6 行真值口径格里的裸行号补全为完整路径,使它符合本节自己的路径规则。 |
| 本文(docs) | 设计与验证说明。只新增本文件。 |

§7 以外的账文内容未改:`git diff cffd5dacbc..0c53de5d2d` 在账文件里只有一个 hunk,落在 §7 内;原六行的 Staging observed / Production observed / Enable authorization / Rollback verified 四格逐字未变。

**Code default 复核结果(原六行)**

| 行 | 原值 | 现值 | 依据 @cffd5dacbc |
|---|---|---|---|
| Canvas V2 | OFF | 后端 ON(自 #5169 `5966ec8e87`(2026-08-26)起,未设或空串即开);前端会话前兜底 OFF | `services/approval-canvas-flag.ts:6-9`;`apps/web/src/stores/featureFlags.ts:87`(由 `scripts/ops/approval-canvas-owner-uat-smoke.sh:38-41` 钉住) |
| Durable delivery | explicit env gate | OFF(explicit env gate;未设即 OFF) | `multitable/automation-durable-delivery.ts:20-22` |
| Class A action ledger | explicit env gate | OFF(同上) | `multitable/automation-execution-ledger.ts:37-39` |
| Class B action ledger | explicit env gate | OFF(同上) | `multitable/automation-outbound-intent.ts:63-65` |
| FWB | OFF | OFF;前端兜底 OFF | `multitable/approval-fwb-activation.ts:145-147`;`featureFlags.ts:88` |
| Attachments | OFF | OFF;前端兜底 OFF | `routes/approval-attachments.ts:128-130`;`featureFlags.ts:86` |

真值口径逐行按实记录,各行并不统一:
- 附件、FWB、耐久投递、W6 主闸:trim 后小写化,再比 `true`。
- ClassA、ClassB、学习、workflow:只认精确的 `true`。
- Canvas:未设或空串即开;非空时须精确等于 `true`。
- 撤销轮入口、目录失活:另认 `1` / `yes`。
- PLM:另认 `on` / `enabled`,未设即开。

大写 `TRUE` 在小写化解析器上生效是否符合预期,仍是 `approval-remaining-dev-design-report-20260820.md:1268-1269` 记的未裁项,本件不裁。

## 2. 依据

- **计划切片 F2-M2**(审批对标飞书 P2–P4 切片计划 §4,状态「部分交付」)。
  - 改动面 ①:在 §7 原位扩写,补行、补列,逐行复核既有六行的 Code default;Canvas V2 记两值;环境观测列只在授权 UAT / rollout 时填。
  - 改动面 ②:一条单测守卫。人口从 `buildFeaturePayload` 源码结构取整个返回字面量,不手抄、不按前缀筛;方向 payload ⊆ 账。
  - 验收门:守卫变异(删一行登记 ⇒ 红;payload 新增一键不登记 ⇒ 红);账每行 file:line 可复核。
  - 该计划文末的末轮复验更正节没有涉及 F2-M2 的条目,正文明细即为依据。
  - 计划的行号以 `fc684dceeb` 为准。它为本片引用的文件(`routes/auth.ts`、`apps/web/src/stores/featureFlags.ts`、`services/approval-canvas-flag.ts`、`scripts/ops/approval-canvas-owner-uat-smoke.sh`、附件 / FWB / 耐久投递 / ClassA / ClassB 五个解析器文件、本账、前身账、`approval-remaining-dev-design-report-20260820.md`)在 `fc684dceeb..cffd5dacbc` 之间 `git diff --stat` 为空,行号未移位。
- **锁**:切片明细写「锁:不需要」,本件没有改动任何锁文。账的定位来自已 ratify 的 `approval-parity-master-design-lock-20260817.md` §0 文档层级表,原文:「`approval-parity-execution-ledger-20260817.md` | mutable execution truth: PRs, SHAs, checks, reviews, flags, and decisions」。同一锁的抬头写明 ratification「grants no runtime, UAT, deployment, or flag authorization」,本件据此不开任何开关。
- **账自身规则**(§7 原文,未改):「Initial values are policy assertions, not live-environment observations. Fill environment evidence only during an authorized UAT or rollout.」因此 Staging observed / Production observed 列一律不填。§0 第 6 条(不存敏感细节)同样遵守。

## 3. 守卫设计

- **人口**:用 TypeScript 编译器 API 解析 `src/routes/auth.ts`,找到唯一的顶层 `function buildFeaturePayload`,取它唯一一条 `return` 返回的对象字面量,读出全部成员名。嵌套回调里的 `return` 不计入。
- **登记集**:ledger 中唯一的 `## 7. Flag and environment ledger` 标题,到下一个 `## ` 为止,其间唯一的一张表。按表头名定位 `Payload key` 列。每格要么是一个反引号键名,要么以 `—` 开头(表示不在下发里)。
- **失败即关**:以下任一情况都直接抛错,不会因为读到空人口而通过:
  - 函数缺失或重复;
  - `return` 不止一条,或返回的不是对象字面量;
  - 成员是展开或计算键;
  - 标题、表或列缺失;
  - 某行单元格数与表头不符;
  - Payload key 单元格格式不对。
- **方向**:只断言 payload ⊆ 账,另断言同一键不重复登记。账可以多于 payload(env-only 行、占位行)。**不断言反向**:payload 删掉或改名一个键后,账里的旧行不会被发现(见 §6 残留)。
- **移动端占位**:该行的 Payload key 单元格故意不写成键名。F2-M1 往 payload 加 `approvalMobile` 时守卫会变红,直到它补上这一格(见 §4 变异 M2)。
- **不钉行号**:守卫不校验账里的 file:line,否则无关改动一挪行号就会变红。行号能否复核,由 §4 的一次性读数给出。
- **归属车道**:
  - `tests/unit/*.test.ts` 由 `packages/core-backend/package.json` 的 `"test": "vitest"` 默认 include 收集。`vitest.config.ts` 没有 `include:` 覆盖,exclude 里也没有本文件。
  - 该命令由 `.github/workflows/plugin-tests.yml` `test` 作业的「Run core-backend tests」步(`:901`)执行。矩阵 18.x / 20.x,该步无 `if:`。同一作业里另有「Start Postgres」步(`:1107`),排在该步之后;该步本身、`test` 作业、workflow 级 env 都不设 `DATABASE_URL`(workflow 级 env 只有 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`)。所以本文件在无库环境下运行。
  - `test (20.x)` 在 main 分支保护的必需检查里(`gh api …/branches/main/protection/required_status_checks`,本次只读查询)。
  - 因此无需改 workflow,`plugin-tests.yml` 未动,s6a pins 不受影响。
  - `approval-ci-coverage-enumeration.test.ts` 的 T4 档实测把本文件判为 `is wired`(见 §4 第 5 条)。
- **不涉前端**:没有新增或修改前端 spec,run-list 与 token manifest 都不涉及。

## 4. 验收门读数

**执行环境**:测试全部在另一台机器(macOS arm64)上跑:Node v20.20.2、pnpm 10.16.1、vitest 1.6.1、TypeScript 5.8.3。工作树 `~/wt/w1-m2-impl` 检出提交 `0c53de5d2d`,工作树干净;依赖是 `pnpm install --frozen-lockfile --prefer-offline` 真实安装的(非软链;本分支未改 lockfile)。本切片没有真库步骤,未建库,不涉及 PG;跑测试时环境里没有任何 `*_DATABASE_URL`(`env | grep -c DATABASE_URL` = 0)。本机只做了只读的 `git show` / `git grep` 核对。

1. **守卫本体**:`CI=true vitest run tests/unit/approval-feature-payload-flag-ledger.test.ts`,**8 passed / 8**。其中 5 条是在真实文件的内存副本上做的判别性负控:
   - 探针键被报出;
   - 逐个删掉 11 个已登记键各自的账行,每次都只报出该键;
   - 展开 / 计算成员抛错;
   - 函数改名、多一条 `return` 抛错;
   - 标题 / 列 / 单元格格式错误抛错。
2. **真实文件变异**:每次先 `cp` 备份,变异后跑守卫(不带 `CI`,即不重试),再 `cp` 还原,并用 sha256 比对。

   | # | 变异 | 结果 | 主断言报出 |
   |---|---|---|---|
   | M1 | 删掉账里登记 `approvalCanvasV2` 的那一行 | **红**(3 failed / 5 passed) | `every payload key appears in the ledger Payload key column (payload ⊆ ledger)`:`[ 'approvalCanvasV2' ]` |
   | M2 | 在返回字面量里加 `approvalMobile: false,`(模拟 F2-M1 未补账) | **红**(3 failed / 5 passed) | 同一条:`[ 'approvalMobile' ]` |
   | M3 | 在返回字面量里加无前缀键 `tasksProbe: false,` | **红**(3 failed / 5 passed) | 同一条:`[ 'tasksProbe' ]`,证明人口不按前缀筛 |

   另有两条负控在变异下也跟着红。它们基于同一份真实文件做相对比较,属预期。还原后 `ledger_sha_ok`、`auth_sha_ok`,`git status` 干净,重跑 **8 passed**。
3. **账内 file:line 可复核**:用只读脚本抽出 §7 里全部 **53 处** `path:line` / `path:a-b` 引用(含同格内的 `:NNN` 简写),逐一对照 `git show cffd5dacbc:<path>` 打印被引行,**越界 0 处**。
   - 脚本对超过 12 行的区间只打印头 12 行和末行。这类区间(`featureFlags.ts:328-427`、`routes/auth.ts:284-318`、`featureFlags.ts:79-92`)的其余行是人工对照读的。
   - 人工逐条核对,被引行的内容都与账中描述一致。
   - 代表性读数:
     - `services/approval-canvas-flag.ts:8`:`return value === '' || value === 'true'`
     - `routes/approval-attachments.ts:129`:`return String(env.APPROVAL_ATTACHMENTS_ENABLED ?? '').trim().toLowerCase() === 'true'`
     - `multitable/automation-execution-ledger.ts:38`:`return env.AUTOMATION_CLASSA_CLAIM_ENABLED === 'true'`
     - `plugins/plugin-attendance/index.cjs:16576`:`return parseBoolean(process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED, false)`
     - `directory/directory-sync.ts:1342-1343`:`['true', '1', 'yes'].includes(String(process.env.DIRECTORY_DEPROVISION_ENABLED ?? '').trim().toLowerCase())`。另核:`applied` 取自 `options.enabled`(`directory/directory-sync.ts:1508`),调用处传入该开关(`:3814`、`:4526`)。
     - `config/flags.ts:48`:`workflowEnabled: process.env.WORKFLOW_ENABLED === 'true'`(模块加载时求值)
     - `routes/auth.ts:293-317`:返回字面量共 11 键,与账内登记的 11 个键一一对应。
4. **相关既有单测**:`approval-canvas-flag`、`attendance-w6-group-effective-policy-panel-flag`、`elearning-flags`、`auth-login-routes` 共 4 个文件,**4 files / 108 tests passed**。
5. **CI 接线类守卫**:`approval-ci-coverage-enumeration`、`approval-cancel-round-ci-wiring`、`tasks-auth-ci-wiring` 共 3 个文件,**3 files / 394 tests passed**。
   - 这三者依赖 python3 + PyYAML 解析 workflow。Mac mini 的 python3(3.9.6)没有 PyYAML,所以在 `~/wt/` 下临时建了一个 venv(PyYAML 6.0.3),只对这几次 vitest 调用放进 PATH,收尾时删除。CI 的 `ubuntu-latest` 自带 PyYAML。
   - 枚举守卫对本文件的判定:`T4 — packages/core-backend/tests/unit/approval-*.{test,spec}.ts (backend unit) > is wired: packages/core-backend/tests/unit/approval-feature-payload-flag-ledger.test.ts` ✓。
6. **core-backend 无库全量**(`CI=true vitest run`,与必需 `test` 作业同一配置;PATH 含上述 PyYAML venv;无 `DATABASE_URL`):
   - `0c53de5d2d`:Test Files 4 failed / 1056 passed / 173 skipped(1233);Tests 43 failed / 17734 passed / 1665 skipped(19442)。
   - 基线 `cffd5dacbc`(同一工作树、同一命令,接着跑):Test Files 4 failed / 1055 passed / 173 skipped(1232);Tests 43 failed / 17725 passed / 1665 skipped(19433)。
   - 两边的失败集合逐条相同:都是 43 条,`comm` 两个方向的差集都为空。它们集中在 4 个文件:`multitable-recovery-archive-file-store`(22)、`multitable-recovery-archive-reader`(1)、`multitable-recovery-local-custody-store`(4)、`multitable-recovery-local-startup`(16),报错都是 `RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`。本分支没有碰这些文件和它们的被测源码,基线上同样失败,与本切片无关。它们是否只在这台机器上失败,未核。
   - 差值是 +1 个文件、+9 条:本守卫 8 条,加上枚举守卫 T4 对本文件的 1 条,全部通过。
7. **账文件与 docs 目录的其它读者**:
   - `git grep 'approval-parity-execution-ledger\|Flag and environment ledger' cffd5dacbc -- scripts apps packages .github plugins tools`,唯一命中是 `apps/web/src/approvals/memberActionDialogGrammar.ts:3` 的来源注释。**0 个按形状解析该表的消费方**,所以表从 6 列改成 11 列不会打破其它检查。
   - 枚举 docs 目录的扫描器:在 `cffd5dacbc` 上检索 `packages/*/tests`、`scripts/**/*.test.mjs`、`scripts/**/__tests__`、`apps/web/tests`、插件测试。
     - 同时出现 docs 路径与 `readdirSync` / `readdir(` / `glob` / `git ls-files` 的文件共 17 个。逐个看过,没有一个枚举 `docs/development/*.md`。其中 `approval-a3-dangling-reviews-path-sweep.test.ts` 的清单里列了 docs 文件,但它把 `.md` 排除在扫描域外。
     - 用 `git ls-files` 取文件的测试与工具共 8 个(含上面的 a3 文件)。除 a3 外,其余 7 个都按源码扩展名或 `packages/core-backend/src` 子树过滤,不含 `.md`。
     - 必需检查所在的 workflow(`phase5-validate.yml` 的 `pr-validate`、`integration-guard.yml`、`attendance-web-guard.yml` 等)也没有 docs 路径规则。
     - 所以新增本文件不会被其它检查读到。本文提交上的确认复跑(第 10 条)覆盖了 core-backend 里的这些扫描器。
8. **lint / 类型检查**:
   - `packages/core-backend/package.json` 没有 `lint` 脚本(根 `pnpm lint` = `pnpm -r lint`,不覆盖它)。
   - `tsconfig.json` 的 `include` 不含 `tests/`,`exclude` 还含 `**/*.test.ts`,所以 `type-check` 不检查测试文件。
   - 因此没有适用于新测试文件的 lint / 类型门。补充读数(不是 CI 门):`tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --esModuleInterop --types node` 只检查本文件,**rc=0**。
9. **公开文本**:四个提交的信息与 diff、以及本文,逐一对私有短语表扫描,**0 命中**。
10. **本文提交**:只新增本文件,不改被测文件。提交后在本文提交上复跑守卫与无库全量,作为确认;结果不回写本文。

## 5. 未跑项

- Node 18 矩阵腿:未跑。
- 真库 / PG:不适用,未建库。
- GitHub CI:未推送,未跑。推送与开 PR 由主会话在门审之后做。
- 前端:未改动,未跑。

## 6. 残留

1. **反向不断言**:payload 删掉或改名一个键后,账里的旧行不会变红。这是按切片写明的方向有意留下的。
2. **§7 之外的陈旧表述未改**(本切片只动 §7):§1「Canvas engineering stack | on main | default OFF」和 §0 第 5 条「Flags remain OFF unless…」,都与 Canvas V2 后端默认 ON 冲突。账状态是 LIVING,不是锁文,留给后续修订。
3. **原六行的 Enable authorization / Rollback verified 未复核**,原样保留。Canvas V2「后端 ON + Enable authorization NO」并存的原因,已在 §7 说明中解释。
4. **不是审批相关 env 开关的全量普查**:本账只收切片点名的行,加上 payload 的全部键。其它审批相邻开关(例如 DingTalk 待办镜像 `DINGTALK_TODO_MIRROR_ENABLED`)未收录。
5. **行号会漂移**:账里的 file:line 以 `cffd5dacbc` 为准,守卫有意不钉行号。
6. **大写 `TRUE`** 在小写化解析器上生效是否符合预期,仍未裁定(见 §1)。
7. **前身表** `approval-authoring-data-closure-closeout-verification-20260721.md` §5(四行)未更新,§7 说明里已注明。
8. **`approvalMobile` 占位**:F2-M1 必须在同一 PR 里把该行 Payload key 单元格改成键名,否则守卫变红(这是有意的)。
9. **续做**:本切片的实现两次被会话额度中断。四个提交(`5471403889`、`d25e25ec42`、`5fc1ac9e84`、`0c53de5d2d`)是前两段会话写的;本段会话把它们当草稿逐条复核(账内引用、守卫逻辑、账文 diff 范围、公开文本),没有发现需要再改的地方,也没有改写任何已有提交。本文由本段会话修订后提交:改正了上一稿对 `test` 作业有无 DB 的错误表述,授权一条只引 owner 原话。§4 的全部读数都是本段会话在 `0c53de5d2d` 上重取的,前两段的读数一律不沿用。
