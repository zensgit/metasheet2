# 修复 web 测试 jsdom localStorage baseline + 补 T2 Workbench render 断言 — 验证报告

- **日期**：2026-05-19
- **配套**：[web-test-jsdom-localstorage-baseline-fix-20260519.md](./web-test-jsdom-localstorage-baseline-fix-20260519.md)
- **分支**：`frontend/fix-jsdom-localstorage-baseline-20260519`

---

## 1. 实现摘要

| 文件 | 改动 |
|---|---|
| `apps/web/tests/setup/localstorage.ts` | **新增**：in-memory `Storage` polyfill；setup-file 加载时 `installLocalStorage()` 一次（早于 spec 顶层 import）+ `beforeEach` 重装（隔离） |
| `apps/web/vite.config.ts` | test 块加 `setupFiles: ['./tests/setup/localstorage.ts']` |
| `apps/web/tests/multitable-workbench-view.spec.ts` | import `useLocale`；afterEach 加 `setLocale('en')` 复位；末尾 +2 个真 Workbench locale render 用例（zh-CN / en，复用既有重 mock） |
| `docs/.../web-test-jsdom-localstorage-baseline-fix-20260519.md` + 本 verification | 设计 + 验证 |
| `docs/.../multitable-workbench-i18n-t2-development-20260519.md` + `-verification-` | **回填**：撤"无自动化 render"诚实声明 → "后续 PR 已补真实断言"+交叉引用 |

## 2. 安全点 #1：setupFile 确被加载（实测）

零 import 探针 spec + label spec 同跑：

```
probe: typeof localStorage.removeItem === 'function' ✓ getItem ✓ set/get/remove 往返 ✓
Test Files 2 passed (2) | Tests 9 passed (9)   ← 1 probe + 8 label
```

证明 vitest 以 `apps/web` 为 root 正确解析 `./tests/setup/localstorage.ts`，且 polyfill 在 spec 代码前生效。

## 3. 安全点 #2：JSON reporter shape 实录

`vitest run --reporter=json --outputFile` 产出的 JSON：

```
topKeys: numTotalTestSuites,numPassedTestSuites,…,numTotalTests,numPassedTests,
         numFailedTests,…,testResults
.testResults[].assertionResults[]  存在（数组），.status / .fullName 可用
```

→ MD §3 的 `jq -r '.testResults[].assertionResults[] | select(.status=="failed") | .fullName'` 路径**有效**，未触发退化分支。

## 4. 强制验收：失败用例集合 diff（非总数）

| | failed | passed | total |
|---|---|---|---|
| BEFORE（origin/main `266f47564`，无 setupFile） | 217 | 2227 | 2444 |
| AFTER（加 setupFile） | **16** | **2428** | 2444 |

```
comm -13 /tmp/web-before-fail.txt /tmp/web-after-fail.txt   → 0 行   ← 回归红线：空 ✓
comm -23 /tmp/web-before-fail.txt /tmp/web-after-fail.txt   → 201 行 ← 被本修复治好的失败
comm -12 (before∩after, 残留)                                → 16 行  ← 预存非本切片
```

**`comm -13` 为空 = AFTER 无任何新增失败用例 = 零回归**（判据是失败用例**全名集合** diff，非 `tail -3` 总数）。

残留 16 分布（均 BEFORE 即在、非 localStorage、本修复不触及）：Attendance record timeline ×4 / Attendance import batch ×4 / featureFlags ×3 / useAttendanceAdminRail ×1 / date field type ×1 / MultitableWorkbench manager-driven config ×1 / ApprovalCenterView ×1 / API Utils getApiBase ×1。属其它预存 issue，超本切片范围。

## 5. 第二步：T2 真 Workbench render 断言（已落地）

`multitable-workbench-view.spec.ts` baseline 修复后转绿，**复用其既有重 mock 装配**新增 2 用例：

- `renders the workbench toolbar in zh-CN when locale is zh-CN`：`setLocale('zh-CN')` → 挂载 → 断言含「字段 / 权限 / 视图 / 评论收件箱 / 仪表盘 / API 与 Webhook」且**不含** `Comment Inbox`
- `renders the workbench toolbar in English when locale is en`：`setLocale('en')` → 断言含 `Fields / Access / Views / Comment Inbox / Dashboard / API & Webhooks` 且**不含** 评论收件箱

实测：`Test Files 1 passed | Tests 55 passed (55)`（原 53 + 2）。Workflow/Automations 按评审 #3 排除在默认断言外（默认 `canManageAutomation=false`）。

→ T2 verification §7 的"无自动化 Workbench render 断言"残留风险**已真正消除**；两份 T2 MD 已回填交叉引用。

## 6. 其余验收

```
pnpm --filter @metasheet/web exec vue-tsc --noEmit          → clean
git diff --check (staged)                                   → clean
multitable-workbench-i18n.spec.ts (T2 label)                → 8/8（未受影响）
multitable-home-view.spec.ts                                → 原 7 fail → 绿
multitable-workbench-view.spec.ts                           → 55/55（53 + 2 render）
```

## 7. K3 PoC 阶段一锁定合规

| 检查 | 状态 |
|---|---|
| 产品代码 / `/api/*` 契约 / migration | ❌ 不碰（纯 test 基建 + test 新增 + 文档回填） |
| plugin-integration-core / k3-wise / Data Factory | ❌ 不碰 |
| 新产品面 / 平台化 | ❌ 否（测试可靠性根因修复） |

`git diff --name-only` = setupFile + vite.config + workbench-view spec + 本切片 3 份 MD（含 2 份 T2 回填）。无产品逻辑改动。

## 8. 结论

jsdom localStorage baseline 根因级修复：全套件 `217 → 16` failed、**零回归（comm -13 空）**、治好 201。安全点 #1（setup 加载）/#2（JSON shape）均实测确认。T2 Workbench 双语 render 真断言已补（55/55），T2 §7 残留风险消除，两份 T2 MD 回填。

**待执行**：本地 commit → 停 push 前 → 用户 review → push → CI → admin-merge。

---

## 9. 变更日志

- 2026-05-19 验证报告（zensgit + claude-opus-4-7 协作）
