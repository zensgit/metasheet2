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
| 门审第 5 轮 P1 的形状(`P29(a)`) | **本栈关闭**:legacy 写入在席位闸处被拒(403,零行,回应与普通实例逐字节相同),诚实结尾后 `{A, E}` = HONEST6;M-rc-gate 下红 ⇒ 关闭由席位闸承重 |
| NOT RUN | core-backend 全量(栈顶跑);RC 自带 standalone workflow 在 CI 的实跑(零 PR);生产语料普查 |

## 3. 栈顶 `fix/approval-legacy-approve-settlement-parity-on-r9` —— 由该分支追加
