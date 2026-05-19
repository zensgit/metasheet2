# 修复 web 测试 jsdom localStorage baseline + 补 T2 Workbench render 断言 — 开发计划

- **日期**：2026-05-19
- **范围**：`apps/web/vite.config.ts`（test 配置）+ 新增 `apps/web/tests/setup/localstorage.ts`（vitest setupFile）+ `apps/web/tests/multitable-workbench-view.spec.ts`（补 T2 locale render 断言，baseline 修复后才可行）
- **K3 PoC 阶段一锁定**：合规（纯测试基建 + 测试新增；无产品代码 / 契约 / migration）
- **关联**：T2 i18n（#1664 已合并）verification §7 锚定的"baseline 修复后应补真实 Workbench render 断言"

---

## 1. 根因（探针实证，非推测）

零 import、单文件隔离运行的探针 spec：

```
PROBE typeof=object | ctor=undefined | hasRemoveItem=undefined
      | hasGetItem=undefined | keys=[] | proto=Object
```

`globalThis.localStorage` 在 env baseline 即是一个**无方法的纯 `{}`**（非 jsdom `Storage`）。原因：**vitest 1.6.1 + jsdom 默认 `about:blank`（opaque origin）**，jsdom 不提供可用 `Storage`，落为占位 `{}`。

- 非跨文件泄漏：探针单文件隔离仍复现（vitest 默认 `isolate:true`）。
- 非某 spec 写坏：无 `define` / 无 setup 文件造 `{}`。
- **Option A 已实测否决**：在 `vite.config.ts` test 块加 `environmentOptions.jsdom.url:'http://localhost/'` —— workbench-view+home-view 仍 **60 failed (60)**，localStorage 仍 `{}`。vitest 1.6.1 此路径不生效，已 `git checkout` 回退该 no-op 改动。

现有能用 localStorage 的 spec（`useAuth.spec.ts`、`multitable-phase5.spec.ts` 等）都**各自手搓 in-memory storage**塞 `globalThis.localStorage` —— 即根因的 per-file workaround 散落多处。

## 2. 选定修法：全局 setupFile in-memory Storage polyfill

新增 `apps/web/tests/setup/localstorage.ts`，在 `vite.config.ts` test 配 `setupFiles`：

```ts
// apps/web/tests/setup/localstorage.ts
import { beforeEach } from 'vitest'

function makeStorage(): Storage {
  let store: Record<string, string> = {}
  return {
    get length() { return Object.keys(store).length },
    clear() { store = {} },
    getItem(k: string) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null },
    key(i: number) { return Object.keys(store)[i] ?? null },
    removeItem(k: string) { delete store[k] },
    setItem(k: string, v: string) { store[k] = String(v) },
  } as Storage
}

function installLocalStorage(): void {
  const ls = makeStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true })
  }
}

// ① INSTALL AT SETUP-FILE LOAD (module top-level), BEFORE any spec's
//    top-level imports run. Modules that read localStorage at module-init
//    time (e.g. useLocale.ts resolveInitialLocale()) would otherwise still
//    observe the broken `{}` because spec `import` precedes `beforeEach`.
installLocalStorage()

// ② Re-install a fresh store before every test for isolation (cleared state
//    + heals any spec that replaced localStorage without restoring).
beforeEach(() => {
  installLocalStorage()
})
```

> **关键（评审 #1）**：必须 setup 文件加载时**先 `installLocalStorage()` 一次**，再 `beforeEach` 重装。否则 spec 顶层 `import`（早于 `beforeEach`）触发的模块初始化（如 `useLocale.ts` 的 `resolveInitialLocale()` / `setDocumentLang()`）仍读到坏的 `{}`。

```ts
// vite.config.ts
test: {
  environment: 'jsdom',
  setupFiles: ['./tests/setup/localstorage.ts'],
}
```

**为何 setupFile 而非逐 spec**：根因是 env 级，逐 spec 手搓是债务扩散；全局 setupFile 一次性确定性修复全部 spec，并让 useAuth/phase5 等的手搓 workaround 变为冗余（本 PR 不删它们——它们 `vi.stubGlobal` / 手动赋值 + 还原仍兼容 polyfill，删除是独立清理，超本 PR 范围）。

**`configurable:true`**：使 `vi.stubGlobal('localStorage', …)` 与手动赋值仍能覆盖 + 还原（还原目标变为 polyfill，行为等价或更好）。

## 3. 兼容性风险（全套件 blast radius）

setupFiles 影响 **每个 web spec**。风险与缓解：

| 风险 | 缓解 |
|---|---|
| 某 spec 依赖 `typeof localStorage === 'undefined'` 分支（生产 `api.ts` 有此 guard） | polyfill 让 localStorage **始终 defined**。需全套件 before/after 对比，定位是否有 spec 专测 undefined 分支；若有，单列豁免（该 spec 自行 `vi.stubGlobal('localStorage', undefined)`） |
| `vi.stubGlobal('localStorage', x)` 的 spec | 兼容：stubGlobal 记录当前(polyfill)→设 x→`unstubAllGlobals` 还原 polyfill。✅ |
| 手动 `globalThis.localStorage = original` 模式（useAuth.spec） | `original` 现 = polyfill（可用），还原 OK。✅ |
| setupFile beforeEach 与 spec 自身 beforeEach 顺序 | vitest setupFile 的 beforeEach 先于 spec 内 beforeEach，spec 内若再 setLocale/塞数据均在干净 polyfill 上，符合预期 |

**强制验收（评审 #2：失败清单 diff，不靠总数）**：总数下降无法证明无回归（A 失败消失 + B 新失败出现，总数仍可下降）。必须产出 before/after 的**失败用例全集**并做集合 diff：

```bash
# before（origin/main 原状，未加 setupFile）
pnpm --filter @metasheet/web exec vitest run --watch=false --reporter=json --outputFile=/tmp/web-before.json 2>/dev/null || true
# after（加 setupFile 后）
pnpm --filter @metasheet/web exec vitest run --watch=false --reporter=json --outputFile=/tmp/web-after.json 2>/dev/null || true
# 提取失败用例全名集合，做 diff
jq -r '.testResults[].assertionResults[] | select(.status=="failed") | .fullName' /tmp/web-before.json | sort -u > /tmp/web-before-fail.txt
jq -r '.testResults[].assertionResults[] | select(.status=="failed") | .fullName' /tmp/web-after.json  | sort -u > /tmp/web-after-fail.txt
comm -13 /tmp/web-before-fail.txt /tmp/web-after-fail.txt   # ← 必须为空：after 新增失败 = 回归
comm -23 /tmp/web-before-fail.txt /tmp/web-after-fail.txt   # ← 期望非空：被本修复治好的失败
```

`comm -13`（after 独有失败）**必须为空**。非空即回归，须逐条定位 + 豁免或修正后方可推进。verification MD **必须附** before-fail/after-fail 两个集合 + 两个 comm 输出。json reporter 不可用时退化为 `--reporter=verbose` 抓 `× ` 行排序去重。

## 4. 第二步：补 T2 真 Workbench locale render 断言（baseline 修复后）

baseline 修复后 `multitable-workbench-view.spec.ts` 应恢复绿（其 afterEach 的 `localStorage.removeItem` 现可用）。在该 spec **复用其既有重 mock 装配**（不新挂载）增量加。

**断言目标必须只用默认 mock 下确定渲染的按钮（评审 #3 实证）**。workbench-view 默认 mock：`canManageFields/canManageSheetAccess/canManageViews = true`，但 **`canManageAutomation = false`** → 工具栏的 **Workflow / Automations 按钮默认不渲染**（二者 `v-if="caps.canManageAutomation.value"`）。无 capability 门控、始终渲染的 = **Comment Inbox / Dashboard / API & Webhooks**；默认 caps=true 下额外可见 = **Fields / Access / Views**。冲突横幅（`v-if="grid.conflict"`）、模板库 modal（`v-if="showTemplateLibrary"`）、快捷键 modal（`v-if="showShortcuts"`）默认态均不渲染，**不**作默认断言目标。

确定的断言集（6 串，默认 mock 即可见，无需改 caps/state）：

- `zh-CN` 用例：`useLocale().setLocale('zh-CN')` → 挂载 → 断言工具栏含「**字段 / 权限 / 视图 / 评论收件箱 / 仪表盘 / API 与 Webhook**」
- `en` 用例：`setLocale('en')` → 断言含 `**Fields / Access / Views / Comment Inbox / Dashboard / API & Webhooks**`
- afterEach 复位 locale 'en'（与 home/template-center spec 同范式）
- **Workflow / Automations 排除在默认断言外**（capability-gated）。若要覆盖：单列一个用例显式 `workbenchMock.capabilities.value.canManageAutomation = true` 再断言「工作流 / 自动化」zh / en —— 作为可选增强，非默认必需。

这把 T2 verification §7 的"无自动化 render 断言"残留风险**真正消除**，并回填 dev/verification MD 为"已加真实 Workbench render 断言"。

## 5. 改动文件清单

| 文件 | 改动 |
|---|---|
| `apps/web/tests/setup/localstorage.ts` | **新增**：in-memory Storage polyfill + `beforeEach` 安装 |
| `apps/web/vite.config.ts` | test 块加 `setupFiles: ['./tests/setup/localstorage.ts']` |
| `apps/web/tests/multitable-workbench-view.spec.ts` | baseline 修复后增量 2 个 locale render 用例（复用既有 mock） |
| `docs/.../web-test-jsdom-localstorage-baseline-fix-20260519.md` | 本 MD + 配套 verification |
| T2 dev/verification MD（#1664 已合并的两份） | **回填**：Workbench render 已有真实断言，撤销"无自动化"诚实声明（改为"已补，见本 PR"） |

不动：产品代码 / 后端 / 契约 / migration / 现有 spec 的手搓 storage workaround（独立清理）。

## 6. Test Plan

```bash
# baseline 修复验证（核心）
pnpm --filter @metasheet/web test 2>&1 | tail -3      # 全量 before/after 对比，新失败必须=0
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-view.spec.ts --watch=false   # 应转绿
pnpm --filter @metasheet/web exec vitest run tests/multitable-home-view.spec.ts --watch=false        # 7 fail 应清零
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-i18n.spec.ts --watch=false   # T2 label spec 仍 8/8
pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check origin/main..HEAD
```

Acceptance：

- 全量套件：**`comm -13 before-fail after-fail` 为空**（after 无新增失败用例 = 0 回归）；`comm -23` 非空（≥60 localStorage 失败被治好）。**判据是失败用例集合 diff，非总数**
- workbench-view spec：原 53 fail → 绿（含新增 2 个 locale render 用例：zh-CN 断言「字段/权限/视图/评论收件箱/仪表盘/API 与 Webhook」、en 断言对应英文；Workflow/Automations 不在默认断言）
- home-view spec：原 7 fail → 绿
- T2 label spec / template-center / platform-shell-nav 维持绿
- 若发现专测 `localStorage===undefined` 的 spec 转 fail：定位 + 该 spec 内显式 `vi.stubGlobal('localStorage', undefined)` 豁免，记入 verification

## 7. K3 PoC 阶段一锁定合规

| 检查 | 状态 |
|---|---|
| 产品代码 / `/api/*` 契约 / migration | ❌ 不碰（纯测试基建 + 测试新增） |
| plugin-integration-core / k3-wise / Data Factory | ❌ 不碰 |
| 新产品面 / 平台化 | ❌ 否（测试可靠性打磨） |

---

## 8. 推荐执行顺序

1. **审本 MD**（你现在做的）—— 重点确认 setupFile 方案 + 全套件 before/after 强制验收口径
2. 建 setupFile + 配 vite.config → 跑全量 before/after，确认新失败=0
3. workbench-view spec 补 2 个真 render 断言 → 跑该 spec 转绿
4. 回填 T2 dev/verification MD（撤"无自动化 render"声明）
5. 写本计划的 verification MD（附全套件 before/after 数字 + 任何豁免）
6. 本地 commit + 停 push 前 → 你 review → push → CI → admin-merge

---

## 9. 变更日志

- **2026-05-19 (1)** 初稿（zensgit + claude-opus-4-7 协作）
- **2026-05-19 (2)** 评审 3 点改进：
  - **#1** setupFile 改为「模块顶层 `installLocalStorage()` 一次 + beforeEach 重装」——否则 spec 顶层 import 触发的模块初始化（useLocale resolveInitialLocale）早于 beforeEach 仍读坏 `{}`
  - **#2** 验收改为 before/after **失败用例集合 diff**（json reporter → `comm -13` 必空），不靠 `tail -3` 总数；verification 必附两集合 + comm 输出
  - **#3** Workbench render 断言目标据实修正：默认 mock `canManageAutomation=false` → Workflow/Automations 默认不渲染；改用确定可见 6 串（字段/权限/视图/评论收件箱/仪表盘/API 与 Webhook），Workflow/Automations 转可选增强用例（需显式开 cap）
