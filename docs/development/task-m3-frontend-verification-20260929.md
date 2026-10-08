# 任务功能 M3 前端验证记录（2026-09-29）

- 分支：`claude/tasks-m3-frontend`，Draft PR #6159。设计文档：`docs/development/task-m3-frontend-design-20260928.md`。
- 后端契约：`docs/development/task-m3-backend-design-20260928.md`（#6126，head `c117ab06ca`）。**M3 后端尚未实现**，本片的所有调用只用 mock 验证过。
- 结论：本地单测与类型检查全部通过；审阅确认的 P1、P2 全部关闭，未能判定的意见已补做核验；关键守卫逐个做过变异。**真实浏览器联调、staging、生产均未运行。**

## 1. 过程与模型

审阅统一先试 Fable 5.1，额度用尽时回退到 Opus 5.5。实现原计划交给 Sonnet；Sonnet 在本轮持续返回 403（authentication_failed），按既定规则由编排者（Opus 5.5）亲自修复。

| 步骤 | 执行者 | 结果 |
|---|---|---|
| 实现：API 调用、详情页五个 section、两个 spec 文件 | Sonnet | 382/382 通过（未提交） |
| 审阅第 1 轮：五个角度（契约一致、M2 回归、守卫与假绿、安全、CI 卫生），每条意见三人尝试推翻，两票成立才算 | Fable → Opus | 52 条意见：21 条成立，15 条被推翻，16 条因验证代理额度失败未能判定 |
| 修复成立的 21 条 | 编排者（Opus） | 提交 `931db0537b` |
| 与 main 合并，登记 token 清单 | 编排者 | `a9f00f385c`、`ce0512fe17` |
| 未判定的 16 条：9 条与已修项重复；另 7 条在当前 head 上重新三人核验 | Fable → Opus | 6 条成立（均为 P3/NIT），1 条被推翻 |
| 修复这 6 条 | 编排者（Opus） | 见 §2 |

## 2. 成立的意见与关闭方式

| 级别 | 问题 | 关闭方式 |
|---|---|---|
| P1 | 放进请求路径的 id 缺少与后端一致的校验(空串、`.`、`..`) | `isPathSafeSegment`：这类 id 不发请求；所有 M3 写函数在拼路径前检查；配测试 |
| P2 | 详情解析拒绝今天 M2 后端的详情形状，现有详情页会全部变成错误态 | 树字段按组解析：三者都缺时按根任务处理；`tasks-api.spec.ts` 恢复 M2 形状 fixture 并断言默认值 |
| P2 | M3 详情字段的校验没有测试，注释却说有 | `tasks-api-m3.spec.ts` 新增 15 个 malformed 用例与正例 |
| P2 | 评论长度预检量的是原始输入，会误拒服务端接受的正文 | 与服务端同一归一化：NFC、去两端 White_Space 与零宽字符、再 NFC |
| P2 | 纯关注人看不到「退出关注」 | 详情可选 `canLeave`/`followers`；有 `canLeave` 时只看它（已在 #6126 请后端补上） |
| P2 | 晚到结果守卫只测了 setParent | addAssignee、deleteComment（含离开又回来）、deleteTask、addFollower 各补一例；另测「晚到结果不得解除另一任务上进行中的动作」 |
| P2 | 切换任务时关注人、删除确认、评论列表的复位没有测试 | 各补一例 |
| P2 | 大多数动作的「一次一个」没有测试 | setCompletionMode、addAssignee、addFollower、createComment、deleteComment、保存编辑各补一例 |
| P2 | 编辑评论的客户端预检、通用横幅回退、`useAuth` 抛错回退没有测试 | 各补测试 |
| P3 | 关注人与编辑评论的错误文案、评论加载态没有测试 | 各补一例 |
| P3 | 12 个 M3 动作开始时清除旧横幅、成功后通知红点，大多没有测试 | 一张 12 行的表：先让另一个动作留下横幅，动作进行中横幅必须已清除，成功后通知恰好一次 |
| P3 | 草稿输入、行内错误、打开中的评论编辑器会带到下一个任务 | 三例（含「离开又回到同一任务」） |
| P3 | 评论列表还在加载或加载失败时发表的评论不显示 | **代码修复**：此时重新读取评论列表；两例（加载失败后发表；首次读取仍在途时发表，旧结果被丢弃） |
| NIT | 16 处 `encodeURIComponent` 只测了 4 处 | 16 行表格测试 |
| NIT | 一条测试标题与断言不符；一处注释引用了不存在的符号；M2 spec 里「只有三处清除横幅」的注释已不成立 | 改正 |

被推翻的一条：「无法解析当前用户 id 时对所有评论开放编辑/删除，并在组件生命周期内保持」——这是设计文档 §3.4 写明的回退，后端仍按作者判定，三名核验者一致认为不构成缺陷。

## 3. 变异证据

每个变异都按「备份 → 改 → 跑相关 spec → 还原 → 逐字节比对」执行，由脚本驱动（`g1-mut.py`、`g1-mut2.py`，编排者本机临时目录）。

| 批次 | 变异数 | 结果 |
|---|---|---|
| 第 1 批（第 1 轮成立项） | 39 | 37 个第一次就变红。deleteTask 晚到守卫一例存活：测试断言前没等导航完成，补上等待后变红。另 1 个是等价变异（树字段「缺一个」的显式检查与各字段类型检查重复），已删掉冗余那行 |
| 第 2 批（补核验成立项） | 21 | 21 个全部变红：评论重新读取分支、5 个动作的开始时清横幅、3 个成功通知、9 个导航复位、3 处 URI 编码 |

第 1 批覆盖：路径段检查（4）、树字段与子任务校验（6）、`followers`/`canLeave` 校验（2）、评论长度归一化（2）、Leave 与关注人来源（2）、晚到守卫与晚到通知（7）、`finally` 条件复位（1）、导航复位（3）、「一次一个」（6）、编辑预检（1）、横幅回退（2）、`useAuth` 抛错回退（1）、错误文案（2）。

## 4. 测试结果（Node 20.20.2）

| spec 文件 | 用例 |
|---|---|
| `tasks-api.spec.ts` | 65 |
| `tasks-api-m3.spec.ts` | 124 |
| `tasks-badge.spec.ts` | 25 |
| `tasks-context.spec.ts` | 17 |
| `tasks-detail-view.spec.ts` | 44 |
| `tasks-detail-m3.spec.ts` | 89 |
| `tasks-list-view.spec.ts` | 31 |
| `tasks-nav-badge.spec.ts` | 6 |
| `tasks-routes.spec.ts` | 8 |
| `tasks-view-transitions.spec.ts` | 14 |
| `tasks-view.spec.ts` | 7 |
| `App.spec.ts` | 11 |
| `approvalNavTodoBadge.spec.ts` | 23 |
| `run-required-web-tests-shape.spec.ts` | 5 |
| **合计** | **469，全部通过** |

- `vue-tsc --noEmit -p tsconfig.app.json`：退出码 0。
- `node scripts/ops/required-web-lane-token-manifest.mjs`：MANIFEST MATCHES（537 个 token）；`packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts`：29/29。
- 两个新 spec 已登记进 `apps/web/scripts/run-required-web-tests.sh` 的 exec 块、`.github/workflows/tasks-web-guard.yml` 与 `apps/web/scripts/run-required-web-tests.tokens`。

## 5. 未验证与残留

- **M3 后端未实现。** 若接口与契约不同，需同步 `tasksApi.ts` 与相应 spec。
- **真实浏览器联调、staging、生产：NOT RUN。**
- 纯关注人在后端详情带上 `canLeave` 或 `followers` 之前看不到「退出关注」。
- 合并须等 M3 后端合并并过闸，并按 owner 授权②的顺序（先后端、后前端）。

## 6. 与后端实现对齐(2026-09-30,后端闸第 1 轮转来的三项)

后端 M3 实现(`claude/tasks-m3-backend`)的独立闸审在契约视角下提出三项前端差异,均已修:

| 项 | 差异 | 处理 |
|---|---|---|
| 评论分页 | 后端按契约 §3.6 分页(最早的在前,每页 100),前端只读第一页且丢弃 `total`,第 101 条起刷新后消失 | `listComments` 逐页读取(`limit=100`,`offset` 递增)直到取满 `total`;任一页失败整次读取失败;上限 20 页(2000 条),超出时返回 `items.length < total`,页面显示「仅显示最早的 N 条」 |
| 完成模式错误码 | 前端映射的是 `INVALID_COMPLETION_MODE`,契约与后端是 `INVALID_MODE` | 改名(代码、测试、设计文档) |
| 行级能力 | 后端详情返回 `canEdit`/`canDelete`/`canComment`,前端未使用,只读查看者能看到会失败的写控件 | 解析三个可选标志;`false` 时隐藏对应控件(成员增删、完成模式、父任务 / 删除 / 评论发表与本人评论的编辑删除);缺省(旧响应体)时控件照常显示,服务端校验仍是唯一的闸 |

- 任务相关 11 个 spec 文件:455/455(复审后)。
- `vue-tsc --noEmit -p tsconfig.app.json`:0 错误。本地 `vue-tsc -b` 只在 `vite.config.ts` 报一条插件类型错误,与本次改动无关(本地依赖环境),以 CI 的 type-check 为准。
- 变异抽查 21 处(10 个控件的隐藏条件、缺省标志的取向、截断提示的两个方向、错误码键名、分页循环的四种改坏方式、`total` 校验、能力标志的类型校验与透传)全部变红,还原后工作区只剩本次改动。
- 独立复审(提交 `74265e59ee`):APPROVE,0 P1/P2。三条 P3 与一条 NIT 已处理:翻页中途有新评论落在已读行之前时,同一条评论可能出现在两页——按 id 去重;截断提示不再写条数(发表后本地追加会让条数失真),改为说明较新的评论可能不在列表中;被更新的读取取代后不再继续请求后续页;设计文档的契约表补上分页与 `total`。详情返回的 `canEdit`/`canDelete`/`canComment` 在设计文档 §2 之外生效,见本节表格。
- 未运行:对真实后端的端到端走查(后端 PR 尚未合并)。
- 后端第 2 轮闸的契约视角另提一条前端 P3:后端详情总是带 `canLeave`,而关注人增删与退出关注成功后前端只更新关注人列表、不重读详情,「退出关注」按钮会按旧的 `canLeave` 显示。已改为三种关注人写入成功后都重读详情;退出关注后若重读得到 404(查看者只是关注人,退出即失去访问),返回任务列表。新增 4 个用例;5 处变异(三处不重读、从不返回、任何 404 都返回、退出即返回)全部变红。任务相关 spec 459/459,`vue-tsc` 0 错误。
- 后端第 2 轮修复新增两个错误码,前端已对应:`COMMENT_INVALID_CHAR`(422,评论含 U+0000)——`checkCommentBody` 按服务端顺序(先空白、再长度、再此项)在客户端预检,并映射为「评论包含无法保存的字符」;`TASK_BUSY`(409,删除时任务正被其它写入占用)——映射为「任务正在被修改，请稍后重试」,走删除的冲突提示。新增 4 个用例,4 处变异全部变红;任务相关 spec 463/463,`vue-tsc` 0 错误。两个新码仍属后端待审契约,若 owner 或闸方改名,这里同步改。
- 后端第 3 轮修复后,`POST /api/tasks` 新增 422 `LIMIT`(去重后负责人超过 50),`INVALID_TITLE` 新增两种触发(标题含 U+0000 或孤立代理字符)。建任务表单只发送标题,不会触发 `LIMIT`;标题的两种新情形属于极端输入,仍显示通用失败提示,本分支不改(建任务表单属于 M2 代码)。评论正文含孤立代理字符时后端返回 `COMMENT_INVALID_CHAR`,前端提示表已覆盖该码;客户端预检只查 U+0000。
- 后端第 4 轮闸的前端三项已处理:① 路径 id 规则的注释与文档改为只写规则本身;② `checkCommentBody` 同时预检孤立代理字符(与后端一致),注释同步;③ 建任务收到 422 `INVALID_TITLE` 时提示「标题为空或包含无法保存的字符」,不再显示「请稍后重试」。任务相关 spec 465/465,`vue-tsc` 0 错误;变异 4 处中 3 处变红,1 处(出错前清除标题标志)为等价变异——下一次出错时该标志总会被重新赋值。
