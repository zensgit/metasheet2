# 多维表反馈 #6859–#6868：开发与验证（2026-11-11）

## 实际 CI 第二轮反馈与测试替身补修（2026-11-12）

`e868edb405e402097f0c8233594e588738fde6f6` 的实际 CI 全部终态：74 项检查成功，Plugin 的 `unit (20.x)` 与汇总 `test (20.x)` 失败，coverage 因上游失败跳过；另有既定可选 Strict 跳过。不能判为全绿。Web、四条原生 DB 分支、SQL Server 两版本及 Integration Guard 已在该精确头通过，不再使用首头失败描述它们的当前状态。

- 剩余 unit 失败为七个文件的 34 项：旧 CORS 精确列表、新测试的 app-mode 监听方式、Web token 排序，以及四处过时的 SQL 替身。修复只涉及八个测试/替身/登记文件，不改生产源码、调度、超时、重试、权限或冻结基线。
- CORS 仍断言完整列表；网关回调测试复用既有 pinned listener；Web 仅移动一个 token 到同一调用内正确排序位置，20 个调用的 token 多重集合及其余脚本字节不变。
- 三个记录查询替身增加精确的新元数据投影匹配，保留原匹配与租户/表过滤、返回和排序行为。复制表替身只接受实际同表依赖查询，新增一例验证外表源/依赖均排除且只投影所选标识。原拒绝、回滚与字节摘要断言不变，冻结 fixture 未重建。
- 在清空继承环境、仅设置本地测试必需变量的 Node 20 环境，完整八文件组合 **227 PASS**，未启用 `MRB2_CAPTURE_BASELINE`，未减少案例；最终 `validate:all` exit 0。此前 155 与 72 是同一组的分段结果，不重复累加；新头实际全量 CI 仍须另跑。
- Sol medium 独立复核绑定八个最终 Git blob，无可操作发现；审阅者未冒称亲跑测试。原始失败、独立复核、完整组合日志与最终源码/环境收据保留在私有证据目录 `publication-20261112/ci-failure-e868edb4/`。
- 既有本地 Web 全链单项偶发失败证据仍保留，不因实际 Web CI 通过而抹掉。继续保持 Draft、不合并、不部署；真实浏览器/网关/Windows 与独立 REST 公式重算待办不变。

## 实际 CI 首轮反馈与补修（2026-11-12）

Draft PR #6875 首头 `8f258c55c92f2a9bb6de3997cbbf85af0ebbbecb` 的实际 CI 失败，原始失败日志保留；被上游失败挡住的后端任务不能计为通过，没有盲目重跑或绕过门禁。

- 修复默认 transport 包装破坏函数身份的问题：公开表单读取和提交重新走免登录跳转路径，同时保留 JSON 网关诊断。普通请求、注入 transport 及 before-send 守卫不放宽；两条真实 Response / JSON 401 测试断言不跳转、不清 token，恢复旧包装的变异使两条断言失败。完整三个相关文件 256 PASS，变异运行的 57 个未选中案例不计通过。
- 三个既有 API 测试文件的 json-only 响应替身改用真实 Response；多次请求每次生成独立响应，避免 body 被复用。原场景、状态和断言均保留，完整 78 PASS。移除评论组件已经消失的七条原始 ID 展示例外，保留扫描范围及未登记命中拒绝规则。
- CI 契约对新增 selfcheck 和两个真实数据库测试逐一校验唯一性、顺序及原有相邻命令，再只剥离这三项新增内容与历史冻结摘要比较。历史基线不改，增加 16 个负向变异；契约及浏览器依赖接线合计 14 PASS。浏览器分类器只增加新共享模块的精确路径，不删除触发项或测试。
- 按 PR 模板的被 pin 文件规则，仅续期 `multitableOnpremPackageBuild` 的实际字节摘要；provenance 清单、验证器、运行时 pin 与全部其他叶子不变，不放宽封存范围，也不涉及 P1-6。完整 provenance 与 336 套 hermetic 集成脚本链通过；实际 SQL Server / GitHub CI 仍是独立门槛。
- 完整 Web 必需脚本揭示额外的 UUID 入口、收件箱精确参数和自动化提示旧期望，以及固定 microtask 数不足。诊断 ID 改用既有安全 UUID 工具；保留原 HTML/空响应案例并断言新的诊断、请求 ID 与时间，额外保留 JSON 500 普通错误对照；注入客户端绑定语言以匹配应用启动时的 resolver。异步 UI 测试改为原生事件循环 flush，不增加超时，假计时器倒计时仍执行。六个针对性文件 209 PASS；Web 类型检查（含两个 verification 项目）和最终 `validate:all` 通过。
- 完整 Web 必需脚本的第二次运行 **625 文件通过 / 1 文件失败，14134 PASS / 1 FAIL**，不能写成全链通过。剩余失败在本轮未改动的 `meta-sheet-view-rail.spec.ts` 非活动表 chevron 冒泡断言；该测试与组件均与基线逐字相同，单文件对照 51 PASS。根因尚未定论，保留独立待办，不借此改测试断言、重试配置或产品树栏逻辑；实际 CI 仍须验证最终候选。
- Grok 4.7 本次尝试 fixture 实现未产出改动即停止，补修由主代理完成，Sol medium 对最终源码/测试逐文件哈希独立复核无待修复发现；不将委派尝试写成模型完成实现。首头实际 CI 已全部终态，其中八个 workflow 失败，详细日志保留。最终候选实际 CI 和发布收据仍待更新，继续保持 Draft、不合并、不部署。

## 发布准备状态（2026-11-12）

Owner 已批准本批次提交、推送、创建 Draft PR 与运行实际 GitHub CI；不包含合并、部署、修改真实权限/CI 变量或关闭原 issues。下文未发布/无授权的文字是各历史检查点的当时状态，不能据此扩大或否认本次具体授权。

初次提交后、推送前 main 新增 #6858，最新复核基线为 `1c02a5ec66ad8beb4b1517a467069ba4b78774b6`。本地候选已自动重放，保留抽屉草稿/焦点/撤销逻辑和本轮默认值、文案及诊断修改，没有手工冲突取舍。

补验发现既有工作台新建表测试仍要求 `seed: true`；此旧期望在更早 main 也存在，属于 #6860 契约修改遗漏的测试更新，不归因于 #6858。该例只改名称、合成响应 `seeded: false` 和精确请求 `seed: false`，工作区/记录上下文断言保留。将实现临时变回 `seed: true` 的变异由该单例杀死；234 个未选中案例仅属于变异聚焦运行，不算通过。随后完整组合 **21 文件 / 828 PASS**（包括该文件全部 235 例）；`validate:all` PASS。源码清单增加此测试为 55 个文件，工作台的源码变化仅为原候选与上游的自动组合。数据库没有重跑，旧 native 结果仍按原基线保留。

精确提交 SHA、PR 和实际 CI 结果将记入 PR 正文及私有发布收据，不把历史本地结果写成实际 CI 通过。

## 最新收尾：Blob 测试隔离与 CI 登记（2026-11-12）

本节取代下文“Blob 断言仍失败”的当前状态，但保留此前失败证据。当前 HEAD 和最后只读查询的远端 main 均为 `7e7e8d73a5eea36027cd9d1a9305c3fada602530`；仍是未提交候选，没有推送、公开 PR、合并、部署或关闭 issue。

- 根因是测试同时使用 Node 原生 `Response.blob()` 和 jsdom 的全局 `Blob`，构造器不属于同一运行环境。测试改为导入内置 `node:buffer` 的 Blob，保留真正的 `instanceof` 检查；没有替换全局 Blob、伪造 `Response.blob()`、切换测试环境或修改业务代码。
- 原四个案例和请求/错误/文件名断言全部保留；CSV 与 fallback-XLSX 额外验证精确 MIME、字节数和每个字节。以普通数字数组比较内容，避免 Node TextEncoder 与 jsdom Uint8Array 的另一处构造环境差异；`bin` 夹具只证明传输，不冒称有效 XLSX 文件。
- 该规格此前未进入必跑 lane；现只新增 `export-sheet-client.test.ts` 精确 token 并同步生成清单，删除对应过时说明。既有 20 个门控调用不变，token 640→641；解析还原证明未丢失其他 token 或改变调用，未改调度、超时或门槛。
- 主代理实际执行：四例规格 **4 PASS**；精确 CI token **4 PASS**；使用冻结旧 main 的全部 15 个实际前端源码文件对照 **4 PASS**；11 文件前端回归 **321 PASS**；token 守卫 **29 PASS**；`validate:all` exit 0。
- 四项变换式 mutation（伪 Blob、空内容、同长度错误内容、错误 MIME）均在同一四例规格中被真实断言杀死，生产文件不被变换写回。证据目录为 `artifacts/multitable-issue-repairs-20261111/blob-isolation-20261112/`，含 `before.log`、`after-green.log`、`exact-ci-token.log`、`frozen-main-control.log`、`web-regression.log`、`manifest-guard.log`、`validate-all.log` 和 `mutation-*.log`。
- Grok 4.7 先尝试测试修复并增加字节断言，CLI 实际仍继承 xhigh；多轮诊断未收敛后关闭会话，由主代理纠正字节比较并收口。初次 `after.log` 中的两个 Uint8Array 比较失败保留，不能当成业务回归。最终三个文件由 Sol medium 独立复核，无可操作发现，见 `independent-test-isolation-review.md`；审阅者未冒称亲跑测试。
- 本轮唯一额外源码路径是测试文件；另调整此前已有的两个测试登记文件，其余 **51 个修复文件 hash 完全不变**。新源码清单共 **54 文件**，`blob-isolation-20261112/candidate-source-manifest.json` 摘要为 `458cd763d52bf9a0ad5157f58d3a58ab6a474acc463ce45943af65e9ee5c6094`。
- 此次无数据库重跑：此前 85/161 native、续期 817 后端结果仍按原日志及基线归属，不改写为本轮重跑。实际 GitHub CI、真实浏览器/网关、Windows PowerShell 5.1 与独立 REST 公式重算待办仍未完成。

## 前次续期：2026-11-12

- 按用户继续要求，只续期本地候选，不扩大外部发布授权。远端 main 从原基线前进到 `7e7e8d73a5eea36027cd9d1a9305c3fada602530`，仅新增 #6871：一个自动化服务文件和两个单元测试文件。
- 三个上游路径与本轮 53 个候选源码路径无交集；在校验原清单全部 hash、空索引之后，以普通 detached checkout 携带已有未提交修改，未手工合并、提交或新建分支。当前 HEAD 为上述新 main，53 个修复文件内容与原已验候选完全相同。
- 本轮新跑后端 **37 文件 / 817 PASS**，包括新增禁用调度测试、现有调度/存活性回归、原 22 文件反馈回归及请求 ID/恢复守卫；`validate:all` exit 0。证据在 `artifacts/multitable-issue-repairs-20261111/main-renewal-20261112/` 的 `backend-regression.log`、`validate-all.log`。
- 前端重新跑相同 11 文件：**320 PASS / 同一条 Blob 断言 FAIL**，见 `web-regression.log`。未新增失败，也未跳过或修改该测试。
- Sol medium 独立增量复核 `independent-upstream-impact-review.md` 未发现范围内新阻断；#6871 只增加调度入口的启用态检查，不改变修复路径的记录写事务/读取导出或 schema。其结论不等于审阅者亲跑测试，也不是整个候选重新全量验收。
- 本次没有重新建立数据库或重跑 native：下文 85/161 项数据库结果仍绑定原基线，不伪称已在新 main 组合重跑。只按此限定影响结论保留既有证据；完整 exact-head CI、真实浏览器/网关及发布仍待后续授权与执行。
- 原清单摘要仍为 `15bb548a4db85b3eff46c6751bf54ccce6865094d746bb1e00183c9d9836ac4d`；新基线与源码组合收据另存 `main-renewal-20261112/qualification.json`。下文保留 11 月 11 日历史验收，旧 main 描述不代表当前 HEAD。

## 结论与精确基线

**本轮授权的本地修复、合成验证、独立代码复核及证据整理已完成；不代表发布或全量验收通过。** 前端回归仍有一条在冻结 main 同样失败的 Blob 断言，真实 GitHub CI、浏览器与网关验收尚未执行。

- HEAD / 最后只读核对的远端 main：`a59fa1c59fa82e3cb08cfc21ba4a428b810f07ac`。
- 候选是该基线上的**未提交工作区**，没有候选 commit SHA；不能把基线 SHA 当成修复 SHA。
- 源码清单：`artifacts/multitable-issue-repairs-20261111/candidate-source-manifest.json`，53 个源码、测试、脚本和配置文件；不含文档与私有证据。
- 清单摘要：`15bb548a4db85b3eff46c6751bf54ccce6865094d746bb1e00183c9d9836ac4d`。最终逐文件 SHA-256、字节数和变更路径集合核对一致。
- 本轮无提交、push、公开 PR、合并、部署、客户数据访问、Mac mini/P1-6 操作或真实 CI 变量/保护修改。旧管理员 PR 的发布授权不复用于本轮。

## 难度与模型分工

| 工作 | 计划与实际 |
| --- | --- |
| 日期/NUL、默认值、文案、网关与自检的有界实现 | 中等预算、分离文件所有权；实际由并行实现代理完成，不补写未核实的模型名或 effort |
| 跨表权限、公式污染传播、写入与严格恢复 | 高风险，主代理整合；Sol high 独立只读复核，发现后回到实现与测试 |
| 开发验证 MD | Grok 4.7 起草、主代理核对定稿；本次 CLI 实际显示继承的 xhigh，而非已配置的 medium |
| 最终证据与授权边界 | 主代理负责，独立审阅与实际测试结果分列 |

Grok 会话已关闭，服务状态为零活跃会话；未停止共享服务。四个本轮子代理已结束。没有为等待测试重复启动模型。

## 逐项实现

| 议题 | 修复与边界 |
| --- | --- |
| #6859 分页/大导出 500 | `query-service.ts` 仅在排序分支绑定排序值，无排序游标不再带未使用参数；真实 PostgreSQL 覆盖双向第二页及 5006 行 XLSX，不降低导出上限 |
| #6860 示例公式 | 常规新建表显式不播种演示数据；显式 demo 的“总价”使用真实数量/单价字段表达式、正确示例值并登记依赖；实际网格写入重算通过 |
| #6861 日历默认字段 | 只自动选择 date/dateTime；不存在时保持未绑定并使用已有配置指引；不改用户已显式指定的配置 |
| #6862 系统列 | 网格五条查询分支、记录详情和筛选导出补齐创建/修改时间与人员元数据，再走既有字段屏蔽；外表系统字段也参与正确计算 |
| #6863 XLSX 可读值 | 两种导出路径补齐查找/汇总、关联标签、授权人员姓名和附件名；保持字段、记录、表、视图及选择列的访问限制 |
| #6864 日期校验 | 新鲜 date 写入校验真实日历与既有合法格式，保留合法原字符串和既有空值语义；dateTime 合同不变，不扩大改类型权限集合 |
| #6865 评论/语言 | 只给已授权评论行补有效作者姓名，不额外暴露邮箱/人员目录；作者缺失用安全文案；收件箱与公开表单支持中英文，去掉内部 API 路径展示 |
| #6866 空字节 | 清洗前递归拒绝 JSON 属性名和字符串中的真实 NUL，最终序列化再次守卫；create/PATCH/batch/表单返回类型化 400，不剥字符；导入保留既有逐行失败语义 |
| #6867 网关诊断 | 安全提示含时间和请求 ID；判断实际非 JSON 失败响应，保留合法应用错误、鉴权及 DELETE 回退；成功导出仍按二进制读取；未实现请求体编码或绕过检测 |
| #6868 部署自检 | 增加网关最小放行矩阵、Node 核心及 bash/PowerShell 入口；只做无业务写入探针，输出 PASS/FAIL/SKIP、状态/时间/请求 ID；纳入现有离线包文件清单 |

主要实现位于 `packages/core-backend/src/multitable/`、`src/routes/univer-meta.ts`、`src/services/CommentService.ts`、`src/index.ts`，以及 `apps/web/src/multitable/`、评论/表单页面与 `src/utils/`。完整路径及内容摘要以源码清单为准。

### 权限与恢复的额外发现

导出补齐计算值时，独立复核发现外表公式、嵌套查找/汇总及条件字段的权限依赖可能影响读取、受限写入和严格恢复。修复使用共享 computed 依赖图：按表/字段解析依赖与实际环路，复用同一权限快照；原 formula-only 包装合同保持不变，不另造一套放宽的导出权限门。

回归包括拒绝/允许读取、拒绝写入不污染已存公式、允许写入重算、无请求严格恢复拒绝、合法跨表返回与真实循环、嵌套物化目标。结构守卫仍要求精确调用次数及相同 authority 参数；增加新核心入口检查，不删旧保护。

网关独立复核的两个 P2 同样已关闭：错误 MIME 的 HTML 401 不再误触发登出；排序/筛选失败保留工厂生成的安全诊断，伪造或被修改的错误不能把任意内容带入提示。后端仅回显有限长度、安全 ASCII 请求 ID；现有日志归属和宜搭策略不变。

## 验证结果

证据根目录为 `artifacts/multitable-issue-repairs-20261111/`。下列是**不同执行集合，存在重叠，不相加冒充唯一测试总数**。使用 Node 20.20.2 / pnpm 10.16.1；数据库为本轮专属合成 PostgreSQL 16，不是客户环境，也不宣称与所有 CI 拓扑等价。

| 执行证据 | 结果 |
| --- | --- |
| `final-feedback-native-combined.log` | 2 个完整 native 文件 / 85 PASS：读取导出 23 + 日期/NUL 62 |
| `final-native-security-recovery-v2.log` | 13 个完整 native 文件 / 161 PASS；含与前行重叠的 23 条，另覆盖权限、恢复、聚合及评论 |
| `final-backend-regression.log` | 22 文件 / 571 PASS |
| `date-nul/unit-repeat-1.log`、`unit-repeat-2.log` | 每轮 12 文件 / 462 PASS |
| `recovery-authority-wiring-green.log` | 2 文件 / 24 PASS |
| `gateway-request-id-wiring-final.log` | 6 PASS；真实回调提取后的 Express HTTP 测试，非完整生产启动 |
| `gateway-p2/after.log` | 网关及实际网格/工作台消费者 114 PASS |
| `closeout-web-regression.log` | 11 文件 / **320 PASS、1 FAIL**，不是全绿 |
| `blob-frozen-main-control.log` | 冻结 main 前端源码对照 3 PASS、同一 Blob 断言 1 FAIL |
| `closeout-validate-all.log` | 既有 validate:all PASS；保留 9 条既有插件警告，不等于全仓测试/完整构建 |
| `web-ci-manifest-guard.log` | 29 PASS，执行清单 640 tokens / 20 个门控调用 |
| `closeout-network-node.log` | Node 自检测试 4 PASS |
| `closeout-network-bash.log`、`closeout-network-pwsh.log` | 各自自测 SUMMARY 34 PASS / 0 FAIL / 0 SKIP；PowerShell 实测版本 7.6.2 |

日期/NUL native 还验证批量第二行失败无部分持久化、历史脏日期的读取/无关编辑/授权恢复、导入逐行错误、表单创建/编辑以及第 11 次真实限流拒绝；没有降低原有限流、改类型或版本冲突门槛。

### 变异与失败证据

- 六项变换式 mutation：canonical、condition、cursor、system、export、seed，均由实际断言杀死；`mutation-core-v2-*.log` 保留，生产文件未因 mutation 修改。
- `missing-db-failclosed.log`：要求 EXPECT_DB=1 却缺少数据库时，两份 native 文件收集失败。它是预期负例，不是功能 PASS 或跳过后假绿。
- `native-ci-ownership.log`：两个新 native 文件各在普通 unit 排除清单和既有真实 DB 整文件调用中出现一次。普通 unit 不采集它们，不表示删除测试。
- 保留初次权限泄露、网关 P2、旧结构守卫及测试夹具错误日志。配置加载错误、错误夹具 ID 或错误匹配器导致的红灯不当作有效缺陷/变异证据。
- Blob 失败位于未修改的 `apps/web/tests/multitable/export-sheet-client.test.ts:52`。对照运行从冻结 main 加载全部 15 个实际使用的前端源码文件（含 client），仍出现同一构造身份断言失败。本轮未修改断言、跳过测试或宣称 CI 必然通过。

## 独立复核与 CI 接线

- `independent-read-export-review-r3.md`：以末尾 R3-F1 关闭和 EXPECT_DB 增量为当前结论，Sol high 有界复核无剩余已确认范围内 finding；早期 P1/P2 与限制保留。
- `independent-date-nul-review.md`：PASS with limits，独立源码/测试检查；实际数据库执行由实现及主代理日志证明，不冒称审阅者亲跑。
- `independent-gateway-review.md`：以顶部最新增量为准，两个 P2 已关闭，请求 ID 回显检查通过但保留完整中间件顺序/CORS 实测限制。
- 新 native 整文件、自检 Node 测试以及三个前端测试已加入**现有**测试链及前端 token 清单；未改变 CI 调度、超时、保护、允许列表或既有断言门槛。
- 本轮没有提交/推送，故没有候选 exact-head GitHub CI。已有其他 PR 或旧 SHA 的绿灯不构成本轮资格。

## 未完成项与不得扩大解释

1. **单记录 REST PATCH 的既有公式重算缺口**：`RecordService.patchRecord` 没有 recalc hook；`native-seed-update.log` / `native-feedback-expanded.log` 保留证据。显式 demo 表达式及实际网格重算已修，此独立路径未扩入本轮。需另行排期，不能据本次结果说所有写入入口都会重算。
2. **真实 UI/浏览器验收**：本轮主要为 jsdom、HTTP 与原生数据库；尚无真实浏览器、实时协作或客户验收。
3. **实际网关与 Windows PowerShell 5.1**：尚未实测。自检的未知 API JSON 404 探针遇到应用基线 HTML 404 也会 FAIL，不能直接断定 WAF 拦截；缺令牌为 SKIP，不是全部通过。WebSocket、上传和业务写入不在探针资格内。
4. **诊断相关性限制**：无响应归因只使用同源近期成功消费的 JSON GET 和在线状态，提示“可能”而非证明；该短时健康缓存没有额外的 SPA 身份切换清空机制。后端回调测试不代替真实代理透传/CORS 验收。
5. **历史数据及后台写入**：不清洗客户历史数据；保留服务端内部历史恢复例外。审批/People 后台写入不是本轮“所有 JSON 写入者均已覆盖”的证明。
6. **上线与性能**：未执行真实 GitHub CI、完整工作区构建、无界依赖图压力测试、部署或迁移真实环境；没有打开绕过编码、外写或安全开关。

## 清理、回退与后续门槛

专属合成数据库完成后，核对资源 ID 和任务标签，再移除本轮容器/网络；`cleanup-receipt.txt` 确认未碰共享卷或其他环境。源码、失败日志、review 和测试证据保留。

本轮无新增数据库迁移、已部署变更或需回滚的真实数据。若放弃本地候选，仅能在核对归属后撤销本轮具体 diff；不得整体 reset/clean 影响其他工作。本地 DB 现已清理，重跑 native 须先新建同等合成环境，不能直接调用旧包装假设数据库仍在。

建议后续顺序：单列 Blob 基线失败与 REST 公式重算待办；获得本轮提交/公开授权后，重新核实 main、冻结候选 SHA 并跑实际 CI；再单独安排浏览器、Windows 和已授权网关验收。**本文件不批准上述外部动作，更不批准合并或部署。**
