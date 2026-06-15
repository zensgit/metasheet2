# 多维表 余下功能开发 — 开发 & 验证总账(goal）— 2026-06-15

> Status: **GOAL LEDGER**。把"余下多维表功能开发"作为一个 goal 来跟踪:已建+已验证 / 设计就绪 / 门控待人。
> 方法:本会话逐 slice contracts-first 实现 + 真实验证(real DB / CI / tsc / 单测 / render 测);余下阶梯经 dynamic workflow(wf_cf6a862d)Map 阶段对 `origin/main@34f53a4cc` 逐项 code-grounded 核验并按**终端门(terminal gate)**分类。Workflow 的 Design/Verify/Synthesize 阶段遭遇服务端瞬时限流失败,相应工作在主循环以同等严谨补完(见 §4)。

## 0. Goal 边界(诚实)

"余下多维表功能开发"不是一个能整体自动跑完的 goal——它分三类终端门:

- **autonomous(可自动建+验到位)**:纯后端、单测+tsc 可闭环。→ B1-a1、A5-2/A5-3 后端契约、A2 服务端导出残余。
- **browser-gated(后端可自动,终端 slice 需真浏览器)**:渲染/配置 UI 的 configure→render→click 真路径,jsdom 只能证 style/emit,证不了对齐/对比度/交互。→ B1-b、B1-c、A5-2/3 渲染、A3、A4、B4、B5、B6。
- **owner/ops-gated(需特权人动作,无自动代码路径)**:→ A1(你的 S5b staging 基线)、C1(SMTP ops 凭据)、C2(PM/SME 行业内容)、B7(安全敏感、对抗式评审 lane)、B2 auto-trigger / B3 原生同步表(owner 章程解锁)、C4 移动端(无具名需求)。

所以这个 goal 能自动推进到 done 的,是 autonomous 那一档;其余只能**设计锁定 + 诚实标门**,不能自动标"已验证"。

## 1. 本会话开发总账(已合并到 main,10 PR)

| PR | 内容 | 验证 |
|---|---|---|
| #2623 | AI 配额 overshoot 修复(estimate-aware admission) | real-DB 集成 438/438;接管时**抓到原 PR 漏的 CI-red**(集成 fixture 未随语义更新)并修复 |
| #2523 | rank-10 层级父字段降级守卫(rebase 98-behind 热文件) | tsc + 守卫单测 19/19 + view-config 集成 28/28 无回归;**clean rebase 后查语义漂移**非仅文本冲突 |
| #2636 | C3 — context.api 集成测试接入 CI(关闭隐形债) | real Postgres 22/22 隔离 + 40/40 CI 序;诊断出"两 vitest config 行为差 = setup 不同" |
| #2629 | 基准阶梯刷新审计(post-cross-base 重排) | docs;code-grounded 烧穿核验 |
| #2635 | A2 导出列/行选择器(MetaExportDialog) | 8 组件测 + 既有导出测改造;client-side over 已脱敏 grid.rows |
| #2637 | A5 范围型条件格式设计锁 | docs |
| #2639 | A5-1a data-bar 后端契约(buildFieldScaleMap) | 52/52 单测 + tsc |
| #2640 | A5-1b/c data-bar FE 镜像 + 网格渲染 | 13 FE 测(9 镜像 parity + 4 jsdom render) |
| #2645 | B1-S0 按钮字段设计锁 | docs(本 PR 顺手勘误 :1346→:1581) |
| #2648 | B1-a0 按钮字段后端契约 + 排除 | 146 单测(3 文件)+ tsc;两处并行 `UniverMetaField` union 经 tsc 捕获补齐 |

## 2. B1 按钮/动作字段弧

- **B1-S0 设计锁(#2645,merged)** — §2 排除矩阵、§3 executor 名下 inert `record_click` 首 action、§5 run-API 契约(镜像 #2623)、§8 切片表。**勘误**:§3 的 `automation-executor.ts:1346` 是 stale,真实单-action `switch(action.type)` 在 **:1581**(`executeSingleAction`,:1573 起);`execute()` 入口 :776 正确。本 goal-PR 已修正设计锁原文。
- **B1-a0 后端契约(#2648,merged,autonomous,DONE+VERIFIED)** — `field-codecs` `MultitableFieldType += 'button'` + `mapFieldType('button')`(否则 fallthrough 到 string)+ `sanitizeFieldProperty` button 块(白名单 §6 config + 恒 readOnly);`record-write-service` button 入 formula/lookup/rollup **非数据写拒绝**(后端兜底);两处 `UniverMetaField` union 补 'button'(tsc 捕获)。
- **B1-a1 执行(autonomous,设计就绪,NEXT — 见 §3 实现规格)** — run 端点 + executor 名下 `record_click` inert action + dispatch 授权。未建。
- **B1-b 渲染 / B1-c 配置 UI(browser-gated)** — FE types union 仍缺 'button'(随 b 落);b 渲染按钮态、c FieldManager 配置;configure→render→click 真路径需浏览器。

## 3. B1-a1 实现规格(就绪,供下一 pass 直接落)

**决策(执行器调用 fork 已定)**:用 **executor 名下单-action 派发**,不开旁路、不为每次点击造 `AutomationExecution` 全量执行行。
- `automation-actions.ts`:`AutomationActionType` + `ALL_ACTION_TYPES` 加 `record_click`(命名待定,行为名 `audit_only` 亦可——executor 触发无关,行为名更贴)。
- `automation-executor.ts:1581`(`executeSingleAction` 的 `switch`)加 `case 'record_click'`:返回 succeeded、**零业务副作用**(不写记录、不外发、不起 job)。
- 新 run 路由 `POST /api/multitable/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run`,**镜像 `routes/multitable-ai.ts` 的 AI-shortcut-run**(`POST …/ai/shortcut/run`,#2623):preflight(字段存在 + 类型 button + actor 可读记录/字段 + 配置可用)→ 审计 best-effort(`automation-log-service` + redact;**绝不为写一条 log 而 500 已提交写**)→ dispatch(经 executor)→ settle `{ status, message?, executionId? }`;**错误不吞**;403/409/429 语义透出;optional `requestId` 去重。
- **不变量(安全):可见 ≠ 可执行**。inert `record_click` 闸 = **record-readable**(零副作用,可读即可点)。当后续接真 action(update_record/webhook),CLICK 必须在 dispatch 时**按底层 action 自身闸、以 actor 身份在服务端重评**——executor 的 action handler 默认以 rule/系统权威运行,故 actor 权限须在 run 路由 preflight 显式校验,不能信"按钮可见"。
- **未决实现细节(下一 pass 先解)**:`ExecutionContext` 在 `execute()` 内由 trigger event 构造;button/run 需在 `execute()` 之外构造一个最小 `ExecutionContext`({sheetId,recordId,recordData,actorId}),并确认 `executeSingleAction` 的 handler 对该 context 的依赖面。这是 B1-a1 唯一的真实未知,需读 `ExecutionContext` 定义后定。
- **测试(纯单测,doc §9)**:非读者 403 · field hidden 403/404-like · 非 button 字段 400 · disabled/malformed config 400 · inert 成功写审计零副作用 · 失败不吞 · requestId 去重 · 低权限点高权限 action 被服务端闸挡。

## 4. 验证框架 & 发现

- **B1-a0 排除矩阵复审(自做,workflow Verify 限流失败的那项)**:button **无值**,故 formula-ref / sort / filter / search / export 对 button 读到的都是空——**不是 pseudo-value 泄漏,是"无害空"**。真正承重的排除是**写拒绝**(防造出 pseudo-value),已在 B1-a0 落且测覆盖;聚合走数值白名单(`isNumericFieldType('button')===false`)已排除并测。结论:**B1-a0 安全充分**;其余排除是 UX-polish(让 button 不出现在 sort/filter/公式选择器里),非安全/正确性洞,列为可选 follow-up,非 B1-a1 阻塞。
- **doc-anchor 漂移(workflow Map 抓到)**:executor switch :1346→:1581,已修正(§2)。这是 grounded-against-main 的价值:设计锁初稿的行号过期会让 `case` 落错块。
- **A2 导出 masking 旗标(workflow Map 提出,待核)**:Map 称 FE 导出绕过服务端字段掩码(`MultitableWorkbench.vue:~2581-2640`)。**需独立核验**:A2 设计论证 `grid.rows` 在读路径已脱敏 → client-side 过滤已授权列安全;Map agent 可能未追到"grid.rows 已脱敏"。列为 **A2 follow-up 待验**(非 B1 goal 阻塞;若属实则是已合并 A2 的安全 follow-up)。
- **A5 data-bar 残余**:渲染为 `cellStyle` 的 `linear-gradient`(已 13 测);已知 **jsdom-only 缺口 = 真实浏览器对齐/对比度/frozen 滚动观感**(部署目检;最可能 polish = bar 透明度/对比)。

## 5. 余下阶梯 map(workflow Map,按终端门)

> grounded @ origin/main@6823263f9(领先 06-15 审计 #2629 的 baseline 190 commits;审计本身已 stale,本 map 取代其状态)。

- **autonomous(可自动建+验)**:**B1-a1**(本 §3)· **A5-2 color-scale 后端契约** / **A5-3 icon-set 后端契约**(各在 `conditional-formatting-service.ts:438` + FE `:397` 现 `kind!=='dataBar' return null` 处放开;渲染仍 browser-gated)· **A2 服务端全量导出残余**(经 #2591 掩码 route,关掉 FE 绕过)。
- **browser-gated(后端自动 / 终端需浏览器)**:B1-b、B1-c · A5-2/3 渲染 · A3 内联链接记录展开 · A4 表单逻辑深度(required-if/多页/prefill/redirect)· B4 仪表盘非图表组件 · B5 longText in-cell @mention · B6 评论 emoji 反应(注:反应存储/API 半边其实可自动,仅 emoji picker 需浏览器)。
- **owner/ops-gated**:A1 网格虚拟化(**唯一真阻塞 = 你的 S5b staging 基线**;窗口化 FE 本身 autonomous)· B7 行级规则权限(安全敏感,owner 对抗式评审 lane)· B2 AI auto-trigger / B3 原生同步表(owner 章程解锁)· C1 SMTP(ops 凭据,代码+smoke 已就绪)· C2 模板行业内容(PM/SME)· C4 移动/PWA(无具名需求,勿自动排期)。
- **已闭(map 勘误审计 stale 处)**:C3 person-field mock 债 = **已由 #2636 关闭**(审计仍列为 remaining,实际已 done)。

## 6. 推荐执行序

1. **B1-a1**(§3,autonomous)— 解 `ExecutionContext` 构造后即可落,纯单测+tsc。
2. **A5-2 / A5-3 后端契约**(autonomous)— 自然延续 #2639,放开 `kind` 守卫 + sanitizer/builder + 单测;渲染挂浏览器。
3. **A2 服务端导出残余 / masking 旗标核验**(autonomous)。
4. 其后皆 browser / owner-gated:**A1 需你跑 S5b**;B1-b/c 等浏览器访问做 configure→render→click 真路径 + 视觉目检(同一次浏览器会话一起做)。

## 7. 落地

本 PR = 本总账 + B1-S0 anchor 勘误(docs-only)。autonomous 档下一步 = B1-a1 实现(§3 规格就绪)。本会话:多维表 10 PR 上 main、data-bar 弧全栈建到 render、按钮弧 S0+a0 done;余下按 §5 门控推进。
