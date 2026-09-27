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

## 2. 栈中 `fix/approval-legacy-approve-seat-and-node-attribution-on-r9` —— 由该分支追加

## 3. 栈顶 `fix/approval-legacy-approve-settlement-parity-on-r9` —— 由该分支追加
