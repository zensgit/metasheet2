# 过程附件上传口对角色席位审批人可见 — 设计与验证说明(2026-09-30)

切片:F2-A2(审批对标飞书 P2-1(b) 的前端门控缺口)。基线 main `cffd5dacbc`;实现提交
`5afc60f6c7`(后端 DTO 字段)、`ff3f4c7cb4`(前端门)、`e28381db95`(浏览器用例),本文随后单独提交。

## 1. 改了什么

| 面 | 改动 |
|---|---|
| 后端 DTO | `UnifiedApprovalDTO` 新增 viewer 作用域布尔 `canAttachProcessEvidence`(`approval-bridge-types.ts`)。 |
| 取值 | `decisionDoorIsSeatGated(instance) && resolveCanDecideCurrentNode(...)`:`approval-seat-authorization.ts` 两个既有导出的合取,不新建谓词。第二个合取项与兄弟字段 `canDecideCurrentNode` 共用同一次计算结果。 |
| 两条构造路径 | `ApprovalBridgeService.getApproval`(`GET /api/approvals/:id` 详情读取)与 `ApprovalProductService.getApproval`(发起与动作的响应;前端 store 会把动作响应写进详情读取所用的同一个槽位)写的是同一个表达式。 |
| 与主闸的关系 | 字段不读附件主闸:它表达的是谁坐在席位上,主闸由前端再合取一次。 |
| 前端门 | `ApprovalDetailView.vue` 评论对话框的上传口:`attachmentPipelineEnabled && isMyTurn` → `attachmentPipelineEnabled && canAttachProcessEvidence`;字段按 `=== true` 读取,缺省(老后端)即不显示。`isMyTurn` 只保留给「等待你处理」提示,不再作为任何入口的门。 |
| 前端类型 | `apps/web/src/types/approval.ts` 增加同名可选字段。 |
| 测试 | 真库用例 5 条追加在 `approval-lock9-process-attachments-realdb.db.test.ts`(独立车道 `approval-realdb-lock9-process-attachments.yml`,其 `paths` 增加该用例依赖的三个源文件);前端 spec 改在两个已在必需 web 车道上的文件里(`approval-process-attachment-dialog`、`approval-detail-instance-consistency`);浏览器用例 1 条追加在 `verification/approval-member-action-dialog.spec.ts`(必需车道「Approval browser verify (chromium)」按 `approval-*.spec.ts` 自动收集),harness 增加 `?scenario=role-seat-evidence` 开关,不带参数时夹具与原先相同。 |
| 未改 | 开关默认值、DDL、`plugin-tests.yml`、必需 web 车道 run-list 与 token manifest(无新 spec 文件)、任何锁文正文。 |

服务端权威不变:上传路由自身的席位检查和绑定时的 403 仍是唯一判据,这个字段只决定界面上是否显示上传口。

## 2. 依据

- **计划切片**:`approval-feishu-p2-p4-slice-plan-20260930.md` §4「F2-A2」——改动面、取值、「为什么不直接用 `canDecideCurrentNode`」、五条验收门、风险(两路构造各一条测试钉;角色集取门自己的口径)照做;§1 P2-1(b) 行记的缺口是前端门仍为 `attachmentPipelineEnabled && isMyTurn`,而 `isMyTurn` 只认 `type === 'user'`。Q3 的建议选项为 (a)「`decisionDoorIsSeatGated ∧ resolveCanDecideCurrentNode`,后端组合下发」,本片按 (a) 实现。
- **第 5 轮复验更正 R5-1**(优先于正文):详情 GET 走 Bridge 裸读,动作响应走 APS 构造器 ⇒ 两路都填,并各有测试钉(见 §3 门 ① 与门 ④ 的 M1–M4)。
- **锁**:Lock-9(RATIFIED 2026-08-21)L9-B 原文:「Only the principal who could commit the action may stage its attachment. The seat authorization is the **action's own authorization** — the seat predicate `actorCanAct` — evaluated server-side, never the request body. It is enforced at two distinct points that must not be conflated」——两点分别是绑定时(承重)与上传时(fail-fast)。锁只规定这两道服务端检查,未规定前端门的形状,因此本片不构成锁勘误;计划 §6 亦列为「不需要新锁」。
- **排期授权**:owner 2026-09-30 原话「按建议执行」(第一波四片做成 Draft PR,本片在列)。合并不在授权内。

## 3. 验收门读数

环境(全部读数同一环境,续做 r3 重取):另一台机器(macOS arm64);PostgreSQL 16.15(Homebrew);Node v20.20.2;pnpm 10.16.1;一次性库 `ms2_w1_a2_impl_r3_20260930`(必需真库步骤重放另用 `ms2_w1_a2_impl_r4_20260930`;`createdb -O ms2testbed`,迁移用 `plugin-tests.yml` 的 `MIGRATION_EXCLUDE`,每条 `*_DATABASE_URL` 指向它并以 `select current_database()` 断言,用毕 drop);被测提交 `e28381db95`,工作树 `dirty=0`。

| 门 | 读数(r3 重取;必需真库步骤重放为 r4) |
|---|---|
| **① 真库**(接入 `approval-realdb-lock9-process-attachments.yml` 所跑的同一整文件,`EXPECT_DB=1`,`--reporter=verbose`) | `approval-lock9-process-attachments-realdb.db.test.ts` 整文件 **39/39 通过**,其中本片 5 条:详情读取中角色席位审批人为 `true`(且上传路由对其返回 201),本节点席位已失效的成员、发起人、抄送人为 `false`(其中席位已失效的成员与抄送人另断言上传路由返回 403,发起人只断言详情字段);请求期间删除主闸环境变量后,同一角色席位审批人仍为 `true`(详情构造路径本身不读主闸——源码核对 `ApprovalBridgeService` 无该变量读取——所以这条钉的是「字段按构造不依赖主闸」,而不是对一条会读主闸的路径做的 OFF 实测);无席位门(无已发布定义的平台行)两条构造路径均为 `false`,而同一 viewer 的 `canDecideCurrentNode` 为 `true`;并行区域游标停在 fork 时两条分支的席位持有人均为 `true`、发起人为 `false`;发起响应对发起人为 `false`,角色席位审批人评论后的动作响应为 `true`,通过后动作响应与随后的详情读取均为 `false`。兄弟字段回归:`approval-can-decide-current-node.db.test.ts` 整文件 **10/10**。 |
| **② 前端 spec** | `approval-process-attachment-dialog` + `approval-detail-instance-consistency` + `approval-detail-can-decide-current-node` 三文件 **79/79**。上传口随字段渲染:角色席位(字段 `true`、`isMyTurn` 假、`canAct` 假)显示;用户席位且字段 `false` 或缺省时隐藏,同时断言「等待你处理」提示照常显示。必需 web 车道整脚本 `bash apps/web/scripts/run-required-web-tests.sh`:**19 次调用、619 个文件、10550 条用例全过,EXIT=0**;`node scripts/ops/required-web-lane-token-manifest.mjs --check`:`MANIFEST MATCHES`(545 token)。 |
| **③ 浏览器**(`CI=1`:自起 Vite 于 5175、端口占用即失败、重试 1 次;Playwright 1.57.0 chromium) | 必需车道配置 `playwright.approval-verification.config.ts` 全量 **39 passed,0 flaky,EXIT=0**;新用例「a role-seated approver sees the process-evidence uploader…」通过(首轮即过)。截图 `verification-output/p5c-role-seat-evidence-uploader-1440.png` 已人工目视:评论对话框内有「附件」上传控件,页面无「等待你处理」提示。同车道前置步骤:`node --test scripts/ops/approval-browser-ci-wiring.test.mjs` 3/3;`vue-tsc --noEmit -p tsconfig.verification-approval.json` EXIT=0。 |
| **④ 两向变异**(`git apply` 施加、跑、`git apply -R` 还原;施加时 `dirty=1`,还原后 `dirty=0`) | M1 Bridge 字段恒 `false` ⇒ 3 红(详情读取角色席位正控、主闸 OFF、并行分支);M2 APS 字段恒 `false` ⇒ 1 红(评论后的动作响应);M3 Bridge 去掉 `decisionDoorIsSeatGated` 臂 ⇒ 1 红(无席位门用例的详情读取断言);M4 APS 去掉该臂 ⇒ 1 红(同一用例对 APS 构造器的断言);M5 前端门回退为 `isMyTurn` ⇒ spec 4 红(角色席位正控、字段 `false` / 缺省两条负控、主闸 ON 正控),浏览器新用例首轮与重试均红。四个后端变异各自只打红自己那条构造路径的钉子,说明两路各有独立的测试钉。 |
| **⑤ 主闸 OFF 渲染不变** | spec 内:主闸 OFF 时用户席位与角色席位两种夹具下,字段 `true` / `false` / 缺省三种渲染逐字节相同,另有主闸 ON 的正控证明比较不空转。跨提交:同一份临时探针 spec(未提交)在 `cffd5dacbc` 与 `e28381db95` 上各跑一次,主闸 OFF × 三类 viewer(用户席位 / 角色席位 / 发起人)× 字段三态 × 对话框关 / 开共 18 份渲染:**剥掉 HTML 注释(`<!--[\s\S]*?-->`)后 18/18 逐字节相同**;未剥时 18/18 不同,差异只在模板注释文字(每份 232 字节),这同时说明探针确实跑在两份不同的代码上。 |
| 必需真库步骤重放 | `plugin-tests.yml` 的 `approval-real-db-integration` 步骤:文件清单与 `env`(`EXPECT_DB=1`)用 PyYAML 从 workflow 解析,不手抄,共 96 个文件,lock9 文件在其中,与其余文件同库同进程运行。另建一次性库 `ms2_w1_a2_impl_r4_20260930` 并重新迁移,不复用 r3 那个已跑过多轮的库。被测提交 `e28381db95`(后端源码与 `5afc60f6c7` 相同),**96 文件、1212 条全过,EXIT=0**(用时 295 s)。 |
| 其他 | `tsc --noEmit`(core-backend)与 `tsc -p scripts/tsconfig.recovery-archive-acceptance.json` EXIT=0;`vue-tsc -b`(web)EXIT=0;core-backend `tests/unit/approval*` **97 文件、1799 条全过**。 |
| 既有红(非本片) | `approval-ui-workspace.spec.ts` 2 条、`approvalMobileDetailActions.spec.ts` 3 条:在基线 `cffd5dacbc` 与本片 head 上失败标题集逐条相同;两者都不在必需 web 车道内(`run-required-web-tests.sh` 头注释列为既有红)。core-backend 的两个 CI 接线单测(`approval-cancel-round-ci-wiring`、`approval-ci-coverage-enumeration`)依赖 PyYAML,Mac mini 系统 python3 没有它;在本 lane 自建的一次性 venv 里,基线与 head 都是 391/391 通过。 |

## 4. 未跑项与残留

- **续做**:本片实现由上一会话完成三个提交后中断;本文全部读数在续做 r3 于同一台机器上重取,早先会话的部分读数不再引用。
- **OpenAPI 未改**:兄弟字段 `canDecideCurrentNode` 已写入 `packages/openapi/src/base.yml`(#5532),新字段没有写入。它不在切片列出的改动面内,而且改 `base.yml` 必须同时重生成 `packages/openapi/dist` 与 `dist-sdk`(`plugin-tests.yml` 会 diff 这两处)。建议作为后续小片处理,或由门审决定是否并入。
- **APS 构造器的无席位门用例是服务层直调**:目前没有 HTTP 路径会把这类实例交给 APS 构造器(它的调用方都是模板运行时的发起 / 派发路径),所以这条钉住的是表达式本身,不代表存在一个可达的响应。
- **撤销轮(cancel round)发起响应(静态读,未实测)**:APS 在该响应里以空角色列表构造 DTO,兄弟字段 `canDecideCurrentNode` 本来就是这样,本字段沿用同一行为。如果发起人本人在入口节点上是角色席位,201 里的值为 `false`,之后的详情读取会给出正确值。本片不改这一点。
- **角色来源**:本片真库用例里的角色由 harness 的 token claim 与 `users.role` 列提供,上传路由对同一人返回 201,说明门与字段的判断一致。「角色来自 `user_roles` 行而非 token claim」这一情形,由兄弟套件 `approval-can-decide-current-node.db.test.ts` 在共用谓词上钉住。
- **未在 GitHub CI 上跑**(本片不 push)。本地已重放 `plugin-tests.yml` 必需步骤 `approval-real-db-integration`,读数见 §3「必需真库步骤重放」一行。
- 浏览器用例标题写的是「without the server field」,而夹具实际给的是 `canAttachProcessEvidence: false`,并非缺省;缺省态由 spec 覆盖。只是措辞问题。
- 读数期间 Mac mini 上还有其他 lane 在跑,负载很高(load average > 100);浏览器全量中没有出现重试或 flaky。
