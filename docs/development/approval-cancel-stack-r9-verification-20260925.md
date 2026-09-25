# 审批撤销栈 r9 — 验证(2026-09-25)

**状态:候选(CANDIDATE)。** 栈级验证记录;栈底写本节,上两层各在文末追加。所有读数本地实跑(零 PR ⇒ CI 从未跑过)。
一次性库 `ms2_laneA_r9_20260925`(`createdb -O ms2testbed`);每个 `*_DATABASE_URL` 指向它并以 `current_database()` 断言;
迁移 `EXIT 0 / 412 executed / 400 BASE TABLE`。全程未用 `git checkout -- <path>` / `reset --hard` / `stash`;
mutation 一律 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`。

## 1. 栈底 `feat/approval-cancel-round-phase1-r9`

详细读数在 `approval-cancel-round-phase1-verification-20260918.md` **Part O9**(同分支)。摘要:

| 项 | 读数 |
|---|---|
| 重放 | r8 74 提交零冲突,树 = `merge-tree(基线, r8)`;reading-a 13 提交,唯一冲突在验证 MD(两段并列) |
| 基线八件(改代码前,`b16ec9b72e…`) | 8 files / 105 passed |
| 交付八件 + 两邻居 | **10 files / 120 passed / 0 failed** |
| 创建件 | 64 passed(56 + 8 新腿);新腿 `-t` 选中 8 |
| 四件单元守卫(`CI=true`) | 4 files / 385 passed |
| `tsc --noEmit` | EXIT 0 / 0 行 |
| Mutation 网格 | M-x1 ⇒ 红 `P30(a)` `P32(a)`;M-x2 ⇒ 红 `N19(a)`;M-viii′ ⇒ 红 `N20(a)` `N21(a)`;M-ix ⇒ 红 `N19(a)`;M-x3 ⇒ 红 `P32(a)`;旧实现互换 ⇒ 红 `P30(a)` `P32(a)` |
| 被测文件 sha256 | `33ffbf22391a716c47e84d31a196e4bbb70b666477a1672514b21f24a83d9a43` |
| token 普查 | Part O9 §O9.5(本 head 现算) |
| NOT RUN | core-backend 全量(在栈顶跑);生产语料普查;`sign`+`skipped` 端到端夹具;C-2 / 投影逐提交重放(L-D) |

## 2. 栈中 `fix/approval-legacy-approve-seat-and-node-attribution-on-r9`

| 项 | 读数 |
|---|---|
| 重放 | RC 4 提交(`09d0275726…` 相对 `5edf4c3e17…`)`cherry-pick -x`;冲突只在 `routes/approvals.ts` 三个 hunk,按设计 MD §3.1 解(F4 (i)(b));`ApprovalProductService.ts` / `vitest.config.ts` 自动合并 |
| `tsc --noEmit` | EXIT 0 / 0 行(重放后、改测试后各一次) |
| RC 并入、改测试**前**,creation 件 + RC 自带件 | **18 failed / 57 passed (75)**:18 条红全部是栈底驱动 legacy 门的腿(6 条「无席位者被拒 403」+ 12 条「有席位者的行被服务端归属」),RC 自带 11 条全绿 —— 这是裁决 (c) 落地后的**预期**,不是缺陷;每条按本门行为重写(设计 MD §3.2) |
| 改测试**后**:八件 cancel-round + RC 自带件 + 两邻居 | **11 files / 133 passed / 0 failed**(creation 66 = 64 + `V1(a)` `V2(a)`;RC 11;邻居 7;其余 cancel-round 件与栈底同数) |
| `approval-cancel-round-outlet-guards` #7/#7′(legacy 门 × 撤销轮 × 席位持有人) | 仍 409 `CANCEL_ROUND_OUTLET_FORBIDDEN`(席位闸放行后出口守卫生效,= F4 (i)(b) 的「有席位 ⇒ 409」格) |
| Mutation 网格(`routes/approvals.ts`,sha256 `51ed120018a10e11e75043f5a52ea0e45eed320cd3ed95a6272bc68a29fdd8f2`,每格 `cp` 备份 → 改 → 跑 creation 整件 → 还原 → `cmp`) | **M-rc-gate**(两扇门的席位闸关掉 `if (!seat.allowed)` → `if (false)`)⇒ **7 红**:`N13(a)` `N20(a)` `N21(a)` `P27(a)` `P29(a)` `P33(a)` `V1(a)` —— 恰为「无席位者被拒」族 + v3b 动作 1;**M-rc-attr**(两扇门的服务端归属关掉 `nodeKey: seat.nodeKey` → `null`)⇒ **13 红**:`P12(a)` `N7(a)` `N8(a)` `P13(a)` `N9(a)` `P19(a)` `N11(a)` `P20(a)` `P21(a)` `N14(a)` `N15(a)` `N18(a)` `N19(a)` —— 恰为「行被服务端归属」族(+ 既有的 `P20(a)`);**M-rc-order**(`/approve` 门把出口守卫挪到席位闸之前,= F4 (i)(a))⇒ **1 红**:`V1(a)`(无席位者对撤销轮得 409 而非 403),`V2(a)` 不动 |
| 门审第 5 轮 P1 的形状(`P29(a)`) | **本栈关闭**:legacy 写入在席位闸处被拒(403,零行,回应与普通实例逐字节相同),诚实结尾后 `{A, E}` = HONEST6;M-rc-gate 下红 ⇒ 关闭由席位闸承重(**RC 层**读数:本层 legacy 门直接写终态,路由席位闸是唯一的闸;栈顶的层依赖见 §3「栈顶 M-rc-gate / M-rc-attr」) |
| NOT RUN | core-backend 全量(栈顶跑);RC 自带 standalone workflow 在 CI 的实跑(零 PR);生产语料普查 |

## 3. 栈顶 `fix/approval-legacy-approve-settlement-parity-on-r9`

| 项 | 读数 |
|---|---|
| 重放 | H-5 3 提交(`89f2805c4f…` 相对 RC `09d0275726…`)`cherry-pick -x`;冲突:`routes/approvals.ts` 两处(栈中的 `rejectIfCancelRound` × H-5 结算块同位 ⇒ 出口守卫先、结算后)+ `ApprovalProductService.ts` 一处(F4 (ii)(b) 版本闸先、`assertCancelRoundActionAllowed` 后);其余自动合并 |
| `tsc --noEmit` | EXIT 0 / 0 行 |
| 八件 cancel-round + RC 自带 + H-5 parity + 两邻居(`EXPECT_DB=1`) | **12 files / 151 passed / 0 failed**(creation 66 / RC 11 / parity 18 / revoke-terminal-guard 5 / delegation-seam 2 / outlet-guards 7);栈中重写的 18 条 C-1 腿读数不变 |
| H-5 单元件 `approvals-routes.test.ts` + 三件 cancel-round 单元守卫(`CI=true`) | **4 files / 395 passed** |
| v3b 动作 3 守卫 `tests/unit/approval-legacy-decision-version-precondition-sites.test.ts`(改写前的文本普查版) | **4 / 4**(改写后的读数见下方「守卫改写」行) |
| core-backend 全量(`CI=true npx vitest run`,无 DB,required lane 形状) | **985 files passed / 175 skipped (1160);16040 tests passed / 1615 skipped (17655);0 failed;EXIT 0** |
| Mutation —— 守卫(改写前;`cp` 备份 → 改 → 跑守卫 → 还原 → `cmp`;被测 sha256 routes `62a9940fa957f48c4355a132b8eead2120ab65e85d63c3c0b1555688a552df09` / service `be984a1d7f961d3efaabe57b2ccdf769b0ec20395fe8ef00c859427ed45c18ad`) | **g1** `/actions` handler 内加第三个 `expectedVersion: requestedVersion` 写入点 ⇒ 守卫 **1 red**(WRITE POINTS);**g2** 删 `/reject` 门的 `rejectIfCancelRound` ⇒ **1 red**(EACH legacy door 次序);**g3** 对调 `dispatchAction` 内版本闸与动作闸 ⇒ **1 red**(dispatchAction 次序)。改写前的普查只数 `expectedVersion:` 这一拼写,对属性简写的第三写入点视而不见(门审第 1 轮 P3-1);改写后的网格见下 |
| Mutation —— g3 保持对调、跑真库四件(creation / outlet-guards / RC 自带 / parity) | **102 passed / 0 failed** —— F4 (ii) 两序在今天的语料上**不可分辨**(v3b §5.2.1 实证),所以裁决由静态守卫承重 |
| Mutation —— v1 版本前置条件关掉(`if (false && …)`) | creation + parity:**2 red**,恰为 parity 的 **(S7)** **(S9)**(H-5 r3 门审的 M11 同读数);creation 66 条不动 |
| NOT RUN | RC / H-5 standalone workflow 在 CI 的实跑(零 PR);带 DB 的全量;生产语料普查 |

### 3.1 栈顶 M-rc-gate / M-rc-attr(门审第 1 轮 P3-2 收口;一次性库 `ms2_lanea2_p3close_20260925`,`createdb -O ms2testbed`,五个 `*_DATABASE_URL` / `*_DB_URL` 全指向它并以 `current_database()` 断言;迁移退出码、executed 数与 BASE TABLE 数与文首所记相同;每格 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`,被测 sha256 与上表相同)

§2 的 M-rc-gate(7 红)/ M-rc-attr(13 红)是 **RC 层**读数。栈顶 H-5 让 seat-gated 实例经 `settleLegacyDecisionThroughSharedPath → dispatchAction` 结算,
而 `dispatchAction` 自带 403 `APPROVAL_ASSIGNMENT_REQUIRED` 且自写 `nodeKey` / `nodeEntryEpoch`,所以同样的两格在栈顶读数不同(机理在设计 MD §4.4):

| 格 | 跑 | 读数 |
|---|---|---|
| 基线(未变异) | creation + RC 自带 + parity 三件(`EXPECT_DB=1`) | **95 passed / 0 failed**(= 上表 creation / RC / parity 三数之和) |
| 基线(未变异) | 单元 `approvals-routes.test.ts`(`CI=true`,无 DB) | **16 passed** |
| **M-rc-gate**(两扇门 `if (!seat.allowed)` → `if (false)`) | 同上三件 | **1 red = `V1(a)`,其余 94 绿**:六条「无席位者被拒」腿(`N13(a)` `N20(a)` `N21(a)` `P27(a)` `P29(a)` `P33(a)`)在栈顶由 `dispatchAction` 自带的席位闸过定而保持绿;`V1(a)` 红是因为路由闸关掉后无席位者先撞上 `rejectIfCancelRound` 得 409,与普通实例的 403 不再逐字节相同 —— 路由席位闸在栈顶是**纵深**,F4 (i) 序的 values-free 性质是它唯一可观察的效果,由 `V1(a)` 单独钉住 |
| **M-rc-gate** | 单元 `approvals-routes.test.ts` | 全绿,与基线同数(该件不驱动撤销轮) |
| **M-rc-attr**(两扇门 `nodeKey: seat.nodeKey` → `null`) | creation + RC 自带 + parity 三件 | **全绿,与基线同数**:该行在栈顶只到非 seat-gated 直写路径,那里 `seat.nodeKey` 恒为 `null`(`resolveLegacyDecisionSeat` 对非 seat-gated 行不返回节点),所以是**语义空变异**;seat-gated 行的归属由 `dispatchAction` 写,路由层的这一行已不承重 |
| 门审第 1 轮同格读数 | — | 门审 §5 记 M-rc-gate ⇒ creation `V1(a)` 1 红 + RC / parity / 单元全绿、M-rc-attr ⇒ creation + RC 77/77 绿;与本节逐格相同(本节的 M-rc-attr 多跑了 parity 一件,仍全绿) |
| 可选加固「非 seat-gated 直写路径:路由席位闸关掉 ⇒ 红」 | NOT RUN | 不可构造:非 seat-gated 行的 `resolveLegacyDecisionSeat` 不查席位,`allowed` 只取决于 `status === 'pending'`,而两扇门在它之前已有 400 `APPROVAL_STATUS_INVALID`,所以 `if (false)` 在该路径上不改任何可观察行为;RC 自带 leg (8) 钉的是该路径的放行 + 丢键现状,已是它能钉的全部 |

### 3.2 v3b 动作 3 守卫改写(门审第 1 轮 P3-1 收口;守卫口径见该文件头)

| 跑 | 读数 |
|---|---|
| 守卫本件(`CI=true`;AST 普查 + 负控 + 6 条写法正控 + 4 条 fail-closed 正控 + 两条次序钉) | **14 / 14** |
| 守卫本件单独 `tsc --noEmit`(临时 tsconfig `extends ./tsconfig.json` 只含该文件;项目 tsconfig 本身排除 `*.test.ts`) | EXIT 0 / 0 行 |
| `tsc --noEmit -p tsconfig.json`(core-backend,改写后) | EXIT 0 / 0 行 |
| core-backend 全量(`CI=true npx vitest run --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`,无 DB,改写后) | **985 files passed / 175 skipped (1160);16050 tests passed / 1615 skipped (17665);0 failed;EXIT 0**(相对上表多出的条数 = 守卫改写前后用例数之差) |
| Mutation —— 守卫改写后(磁盘上改 `routes/approvals.ts` / `ApprovalProductService.ts`,`cp` 备份 → 改 → 跑守卫 → 还原 → `cmp`) | **MG-a2**(`/actions` 内 `const expectedVersion = … as number \| undefined` + 属性简写 `expectedVersion,`,= 门审 P3-1 的盲区形状)/ **g1**(冒号写法)/ **MG-a3**(`const rider = { expectedVersion: … }` + `...rider,`)/ **MG-a4**(计算属性 `['expectedVersion']`)四格各 ⇒ **10 red**(负控 + 9 条正控:正控在已有第三写入点的源上再拼一个,数到 2 而非 1);**MG-a5**(`...buildRider(req),` 不可静态解析的展开)⇒ **8 red**(负控报「未判定写入点」+ 7 条正控);**MG-a6**(只加 `const expectedVersion = …`,不写属性)⇒ **5 red**(负控经 mention 闭包报出声明 + 4 条断言零游离 mention 的正控);**MG-a7**(只加注释行 `// expectedVersion: 1`)⇒ **0 red**(注释不是节点,负控如常绿);**MG-b**(对调 `dispatchAction` 两闸)⇒ 1 red(dispatchAction 次序);**MG-c**(删 `/reject` 出口守卫)⇒ 1 red(EACH legacy door);**MG-d**(`/approve` 出口守卫挪到席位闸前)⇒ 1 red(EACH legacy door) |
| 今天的展开普查(改写前置核) | 被守卫文件里传给 `dispatchAction` / `settleLegacyDecisionThroughSharedPath` 的请求对象共 5 处调用(helper 内 1、`/actions` 内 2、两扇门各 1);含展开的 2 处(helper 内 `...(comment !== null ? { comment } : {})` / `...(precondition.reason !== null ? { reason: … } : {})`;`/actions` 内 `...(hasFieldWrites ? { fieldWrites: … } : {})` / `...(hasAttachmentIds ? { attachmentIds: … } : {})`),四个展开源都是**内联的对象字面量条件式**,守卫静态展开其键;`ACCEPTED_UNRESOLVED_SPREADS` 具名清单今天为**空** |
